const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pool, tryClaimJob, releaseJob, startJobRun, finishJobRun } = require('../db');
const { notifyJobFailure } = require('../services/jobAlertMailer');
const { getProviderRuntime, notifyTushareFailover } = require('../services/externalApiConfig');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(PROJECT_ROOT, 'ipo-report', 'ipo_daily_report.py');
const JOB = 'ipo_calendar_refresh';
let running = false;

function shanghaiParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short'
  }).formatToParts(date);
  return Object.fromEntries(parts.map(part => [part.type, part.value]));
}

function nextIpoRefreshDelay(now = new Date()) {
  const p = shanghaiParts(now);
  const current = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  for (let offset = 0; offset < 8; offset++) {
    const day = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day) + offset));
    const weekday = day.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const target = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 18, 5, 0);
    if (target > current) return target - current;
  }
  return 24 * 60 * 60 * 1000;
}

function pythonCandidates() {
  const configured = process.env.IPO_PYTHON_PATH;
  const bundled = path.join(process.env.USERPROFILE || '', '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe');
  const rootVenv = process.platform === 'win32'
    ? path.join(PROJECT_ROOT, 'venv', 'Scripts', 'python.exe')
    : path.join(PROJECT_ROOT, 'venv', 'bin', 'python');
  const projectVenv = process.platform === 'win32'
    ? path.join(PROJECT_ROOT, 'ipo-report', 'venv', 'Scripts', 'python.exe')
    : path.join(PROJECT_ROOT, 'ipo-report', 'venv', 'bin', 'python');
  return [...new Set([configured, fs.existsSync(rootVenv) ? rootVenv : null, fs.existsSync(projectVenv) ? projectVenv : null, fs.existsSync(bundled) ? bundled : null,
    process.platform === 'win32' ? 'py' : 'python3', 'python'].filter(Boolean))];
}

function summarizeIpoPythonError(value) {
  const text = String(value || '').replace(/\r/g, '').trim();
  if (/Permission denied/i.test(text) && /ipo_xgb_model\.json/i.test(text)) {
    return 'XGBoost 模型文件写入失败：ipo-report/data/ipo_xgb_model.json 权限不足，请重新部署以修复目录归属。';
  }
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  const useful = lines.filter(line => !/^Traceback \(most recent call last\):$/.test(line)
    && !/^File "/.test(line) && !/^\[bt\]/.test(line) && !/^Stack trace:/.test(line));
  const finalLine = useful.findLast(line => /(?:Error|Exception|Permission denied|exit \d+)/i.test(line))
    || useful.at(-1) || 'Python 任务执行失败';
  return finalLine.replace(/\s+/g, ' ').slice(0, 500);
}

function parseTushareFailovers(value) {
  return String(value || '').split(/\r?\n/).map(line => {
    const match = line.match(/^\[tushare-failover\]\s*(\{.*\})$/);
    if (!match) return null;
    try { return JSON.parse(match[1]); } catch (_) { return null; }
  }).filter(item => item && item.api_name);
}

async function notifyTushareFailovers(failovers = []) {
  for (const item of failovers) {
    await notifyTushareFailover(
      item.api_name, item.from_role || 'primary', item.to_role || 'backup', item.reason, item.recover_at
    ).catch(() => {});
  }
}

function runWith(executable, runtime, targetDate) {
  return new Promise((resolve, reject) => {
    const scriptArgs = targetDate ? [SCRIPT, targetDate] : [SCRIPT];
    const args = path.basename(executable).toLowerCase() === 'py' ? ['-3', ...scriptArgs] : scriptArgs;
    const child = spawn(executable, args, {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        TUSHARE_TOKEN: runtime.primary || '',
        TUSHARE_BACKUP_TOKEN: runtime.backup || '',
        TUSHARE_TOKEN_MODE: runtime.mode || 'auto',
        EXTERNAL_CALL_GUARD: '1', IPO_REPORT_DATABASE_ONLY: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8'
      },
      windowsHide: true,
    });
    let output = '', error = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { error += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      const statsMatch = error.match(/\[external-call-stats\]\s*(\{.*\})/);
      let stats = {};
      try { stats = statsMatch ? JSON.parse(statsMatch[1]) : {}; } catch (_) {}
      const failovers = parseTushareFailovers(error);
      if (code === 0) return resolve({ output, failovers, externalCalls: Number(stats.total || 0), externalSources: stats.sources || {} });
      const message = summarizeIpoPythonError(error || output || `exit ${code}`);
      const failure = new Error(message);
      if (/\[(RATE_LIMIT|QUOTA_EXHAUSTED|CIRCUIT_OPEN)\]/.test(message)) {
        failure.code = message.match(/\[(RATE_LIMIT|QUOTA_EXHAUSTED|CIRCUIT_OPEN)\]/)[1];
        failure.errorType = 'rate_limit';
      } else if (/\[DATASET_LOCKED\]/.test(message)) {
        failure.code = 'DATASET_LOCKED'; failure.errorType = 'in_progress';
      } else if (/\[UPSTREAM_5XX\]/.test(message)) {
        failure.code = 'UPSTREAM_5XX'; failure.errorType = 'network';
      } else if (/\[(AUTH_ERROR|PERMISSION_DENIED)\]/.test(message)) {
        failure.code = message.match(/\[(AUTH_ERROR|PERMISSION_DENIED)\]/)[1]; failure.errorType = 'permission';
      }
      const sourceMatch = message.match(/\[(?:RATE_LIMIT|QUOTA_EXHAUSTED|CIRCUIT_OPEN|DATASET_LOCKED|UPSTREAM_5XX|AUTH_ERROR|PERMISSION_DENIED)\]\[([^\]]+)\]/);
      if (sourceMatch) failure.source = sourceMatch[1];
      const apiMatch = message.match(/\[(?:RATE_LIMIT|QUOTA_EXHAUSTED|CIRCUIT_OPEN|DATASET_LOCKED|UPSTREAM_5XX|AUTH_ERROR|PERMISSION_DENIED)\]\[[^\]]+\]\[([^\]]+)\]/);
      if (apiMatch) failure.apiName = apiMatch[1];
      reject(failure);
    });
  });
}

async function runIpoCalendarRefreshRaw(reason = 'scheduled', targetDate) {
  if (running) return { skipped: true };
  running = true;
  const errors = [];
  try {
    const runtime = await getProviderRuntime('tushare');
    for (const executable of pythonCandidates()) {
      try {
        const output = await runWith(executable, runtime, targetDate);
        await notifyTushareFailovers(output.failovers);
        console.log(`[ipo-calendar] ${reason} 更新完成 (${executable})`);
        return { ok: true, executable, output: output.output, failovers: output.failovers, externalCalls: output.externalCalls, externalSources: output.externalSources };
      } catch (error) { errors.push(`${executable}: ${summarizeIpoPythonError(error.message)}`); }
    }
    const failure = new Error(errors.length ? errors.join(' | ') : '未找到可用的 Python 解释器');
    const typed = errors.map(item => item.match(/\[(RATE_LIMIT|QUOTA_EXHAUSTED|CIRCUIT_OPEN|DATASET_LOCKED|UPSTREAM_5XX|AUTH_ERROR|PERMISSION_DENIED)\]\[([^\]]+)\]/)).find(Boolean);
    if (typed) {
      failure.code = typed[1]; failure.source = typed[2];
      failure.errorType = typed[1] === 'DATASET_LOCKED' ? 'in_progress' : typed[1] === 'UPSTREAM_5XX' ? 'network' : ['AUTH_ERROR', 'PERMISSION_DENIED'].includes(typed[1]) ? 'permission' : 'rate_limit';
      const apiMatch = errors.join(' ').match(/\[(?:RATE_LIMIT|QUOTA_EXHAUSTED|CIRCUIT_OPEN|DATASET_LOCKED|UPSTREAM_5XX|AUTH_ERROR|PERMISSION_DENIED)\]\[[^\]]+\]\[([^\]]+)\]/);
      if (apiMatch) failure.apiName = apiMatch[1];
    }
    throw failure;
  } finally { running = false; }
}

async function runIpoCalendarRefresh(reason = 'scheduled', context = {}) {
  if (running) return { skipped: true, reason: 'in_process' };
  if (!(await tryClaimJob(JOB))) return { skipped: true, reason: 'locked' };
  let runId = null;
  const managedSlotId = Number(context.slotId) || null;
  try {
    runId = await startJobRun(JOB);
    const result = await runIpoCalendarRefreshRaw(reason, context.targetDate);
    await finishJobRun(runId, true, JSON.stringify({ reason, executable: result.executable, externalCalls: result.externalCalls, externalSources: result.externalSources, output: String(result.output || '').slice(-2000) }));
    return result;
  } catch (error) {
    await finishJobRun(runId, false, JSON.stringify({ reason, error: String(error.message || error).slice(0, 3000) }));
    if (!managedSlotId) await notifyJobFailure({
      jobCode: JOB,
      alertKey: `${JOB}:run-failure`,
      subject: '打新日报任务失败',
      summary: `任务 ${reason} 执行失败：${String(error.message || error).slice(0, 3000)}`,
    }).catch(mailError => console.warn('[job-alert] 打新日报告警发送失败:', mailError.message));
    throw error;
  } finally {
    await releaseJob(JOB);
  }
}

async function runIpoCalendarStartupCatchup(now = new Date()) {
  const p = shanghaiParts(now);
  const today = `${p.year}-${p.month}-${p.day}`;
  const { isCnHoliday } = require('../config/holidays');
  const tradingDay = value => {
    const weekday = new Date(`${value}T00:00:00Z`).getUTCDay();
    return weekday >= 1 && weekday <= 5 && !isCnHoliday(value);
  };
  const nextTradingDay = value => {
    const cursor = new Date(`${value}T00:00:00Z`);
    do {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    } while (!tradingDay(cursor.toISOString().slice(0, 10)));
    return cursor.toISOString().slice(0, 10);
  };
  let expectedDate = today;
  if (Number(p.hour) >= 18 && tradingDay(today)) {
    expectedDate = nextTradingDay(today);
  } else if (Number(p.hour) < 18 || !tradingDay(today)) {
    const cursor = new Date(`${today}T00:00:00Z`);
    for (let i = 0; i < 10; i++) {
      cursor.setUTCDate(cursor.getUTCDate() - 1);
      const candidate = cursor.toISOString().slice(0, 10);
      if (tradingDay(candidate)) { expectedDate = candidate; break; }
    }
  }
  if (Number(p.hour) < 8) return { skipped: true, reason: 'not_due', today };
  const { rows } = await pool.query('SELECT report_date FROM ipo_reports ORDER BY report_date DESC LIMIT 1');
  const last = rows[0] && rows[0].report_date ? String(rows[0].report_date).replace(/-/g, '').slice(0, 8) : '';
  const expected = expectedDate.replace(/-/g, '');
  if (last >= expected) return { skipped: true, reason: 'fresh', last, expected };
  return runIpoCalendarRefresh('startup-catchup');
}

function scheduleIpoCalendarRefresh() {
  runIpoCalendarStartupCatchup().catch(error => console.error('[ipo-calendar] startup catchup failed:', error.message));
  function scheduleNext() {
    const delay = nextIpoRefreshDelay();
    const timer = setTimeout(async () => {
      try { await runIpoCalendarRefresh('weekday-18:05'); }
      catch (error) { console.error('[ipo-calendar] 更新失败:', error.message); }
      scheduleNext();
    }, delay);
    if (timer.unref) timer.unref();
  }
  scheduleNext();
  console.log('[ipo-calendar] 已调度：工作日 18:05（上海时间）');
}

module.exports = { SCRIPT, nextIpoRefreshDelay, runIpoCalendarRefresh, runIpoCalendarStartupCatchup, scheduleIpoCalendarRefresh, pythonCandidates, summarizeIpoPythonError };

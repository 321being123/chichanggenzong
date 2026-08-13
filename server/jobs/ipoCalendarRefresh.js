const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pool, tryClaimJob, releaseJob, startJobRun, finishJobRun } = require('../db');
const { notifyJobFailure } = require('../services/jobAlertMailer');

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
    const target = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 18, 0, 0);
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
  return [configured, fs.existsSync(rootVenv) ? rootVenv : null, fs.existsSync(projectVenv) ? projectVenv : null, fs.existsSync(bundled) ? bundled : null,
    process.platform === 'win32' ? 'py' : 'python3', 'python'].filter(Boolean);
}

function runWith(executable) {
  return new Promise((resolve, reject) => {
    const args = path.basename(executable).toLowerCase() === 'py' ? ['-3', SCRIPT] : [SCRIPT];
    const child = spawn(executable, args, { cwd: PROJECT_ROOT, env: process.env, windowsHide: true });
    let output = '', error = '';
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { error += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output) : reject(new Error(error || output || `exit ${code}`)));
  });
}

async function runIpoCalendarRefreshRaw(reason = 'scheduled') {
  if (running) return { skipped: true };
  running = true;
  const errors = [];
  try {
    for (const executable of pythonCandidates()) {
      try {
        const output = await runWith(executable);
        console.log(`[ipo-calendar] ${reason} 更新完成 (${executable})`);
        return { ok: true, executable, output };
      } catch (error) { errors.push(`${executable}: ${error.message}`); }
    }
    throw new Error(errors.length ? errors.join(' | ') : '未找到可用的 Python 解释器');
  } finally { running = false; }
}

async function runIpoCalendarRefresh(reason = 'scheduled', context = {}) {
  if (running) return { skipped: true, reason: 'in_process' };
  if (!(await tryClaimJob(JOB))) return { skipped: true, reason: 'locked' };
  let runId = null;
  const managedSlotId = Number(context.slotId) || null;
  try {
    runId = await startJobRun(JOB);
    const result = await runIpoCalendarRefreshRaw(reason);
    await finishJobRun(runId, true, JSON.stringify({ reason, executable: result.executable, output: String(result.output || '').slice(-2000) }));
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
  let expectedDate = today;
  if (Number(p.hour) < 18 || !tradingDay(today)) {
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
      try { await runIpoCalendarRefresh('weekday-18:00'); }
      catch (error) { console.error('[ipo-calendar] 更新失败:', error.message); }
      scheduleNext();
    }, delay);
    if (timer.unref) timer.unref();
  }
  scheduleNext();
  console.log('[ipo-calendar] 已调度：工作日 18:00（上海时间）');
}

module.exports = { SCRIPT, nextIpoRefreshDelay, runIpoCalendarRefresh, runIpoCalendarStartupCatchup, scheduleIpoCalendarRefresh, pythonCandidates };

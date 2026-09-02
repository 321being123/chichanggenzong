const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pool, tryClaimJob, releaseJob, startJobRun, finishJobRun } = require('../db');
const { getProviderRuntime, notifyTushareFailover } = require('../services/externalApiConfig');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(PROJECT_ROOT, 'ipo-report', 'ipo_history_sync.py');
const JOB = 'ipo_history_sync';

function shanghaiParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short'
  }).formatToParts(date);
  return Object.fromEntries(parts.map(part => [part.type, part.value]));
}

function nextIpoHistorySyncDelay(now = new Date()) {
  const p = shanghaiParts(now);
  const current = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  let next = null;
  for (let offset = 0; offset < 8; offset++) {
    const day = new Date(Date.UTC(+p.year, +p.month - 1, +p.day + offset));
    if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue;
    for (const schedule of [{ hour: 18, minute: 0, mode: 'core' }, { hour: 19, minute: 30, mode: 'enrichment' }]) {
      const target = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), schedule.hour, schedule.minute, 0);
      if (target > current && (!next || target < next.target)) next = { target, ...schedule };
    }
    if (next) break;
  }
  return next ? next.target - current : 24 * 60 * 60 * 1000;
}

function nextIpoHistorySchedule(now = new Date()) {
  const delay = nextIpoHistorySyncDelay(now);
  const target = new Date(now.getTime() + delay);
  const p = shanghaiParts(target);
  return { delay, mode: Number(p.hour) === 19 ? 'enrichment' : 'core' };
}

function pythonCandidates() {
  const configured = process.env.IPO_PYTHON_PATH;
  const projectVenv = process.platform === 'win32'
    ? path.join(PROJECT_ROOT, 'venv', 'Scripts', 'python.exe')
    : path.join(PROJECT_ROOT, 'venv', 'bin', 'python');
  const legacyVenv = process.platform === 'win32'
    ? path.join(PROJECT_ROOT, 'ipo-report', 'venv', 'Scripts', 'python.exe')
    : path.join(PROJECT_ROOT, 'ipo-report', 'venv', 'bin', 'python');
  const bundled = path.join(process.env.USERPROFILE || '', '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe');
  return [configured, fs.existsSync(projectVenv) ? projectVenv : null,
    fs.existsSync(legacyVenv) ? legacyVenv : null, fs.existsSync(bundled) ? bundled : null,
    process.platform === 'win32' ? 'py' : 'python3', 'python'].filter(Boolean);
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

function runWith(executable, runtime, businessDate, mode, externalCallCount = 0) {
  return new Promise((resolve, reject) => {
    const scriptArgs = [SCRIPT, '--mode', mode || 'core'];
    if (businessDate) scriptArgs.push('--today', String(businessDate).slice(0, 10));
    const args = path.basename(executable).toLowerCase() === 'py' ? ['-3', ...scriptArgs] : scriptArgs;
    const child = spawn(executable, args, {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        TUSHARE_TOKEN: runtime.primary || '',
        TUSHARE_BACKUP_TOKEN: runtime.backup || '',
        TUSHARE_TOKEN_MODE: runtime.mode || 'auto',
        EXTERNAL_CALL_GUARD: '1',
        JOB_EXTERNAL_CALL_USED: String(Math.max(Number(externalCallCount) || 0, 0)),
      },
      windowsHide: true
    });
    let output = '', error = '';
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { error += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) {
        const message = (error || output || `exit ${code}`).trim();
        const failure = new Error(message);
        const jsonLine = error.split(/\r?\n/).map(line => line.trim()).filter(Boolean).reverse().find(line => line.startsWith('{'));
        let structured = null;
        try { structured = jsonLine ? JSON.parse(jsonLine) : null; } catch (_) {}
        if (structured && structured.error) {
          failure.message = structured.error;
          failure.code = structured.errorCode || undefined;
          failure.errorType = structured.errorType || undefined;
          failure.source = structured.source || undefined;
          failure.dataset = structured.dataset || undefined;
          failure.apiName = structured.apiName || undefined;
          failure.recoverAt = structured.recoverAt || undefined;
          failure.externalCallCount = structured.externalCalls;
          failure.externalSources = structured.externalSources;
        }
        const typed = message.match(/\[(BUDGET_WAIT|JOB_BUDGET_EXCEEDED|RATE_LIMIT|QUOTA_EXHAUSTED|CIRCUIT_OPEN|DATASET_LOCKED|UPSTREAM_5XX|AUTH_ERROR|PERMISSION_DENIED)\]\[([^\]]+)\]/);
        if (typed) {
          failure.code = typed[1]; failure.source = typed[2];
          failure.errorType = typed[1] === 'DATASET_LOCKED' ? 'in_progress' : typed[1] === 'UPSTREAM_5XX' ? 'network' : ['AUTH_ERROR', 'PERMISSION_DENIED'].includes(typed[1]) ? 'permission' : typed[1] === 'JOB_BUDGET_EXCEEDED' ? 'non_retryable' : 'rate_limit';
          const apiMatch = message.match(/\[(?:BUDGET_WAIT|JOB_BUDGET_EXCEEDED|RATE_LIMIT|QUOTA_EXHAUSTED|CIRCUIT_OPEN|DATASET_LOCKED|UPSTREAM_5XX|AUTH_ERROR|PERMISSION_DENIED)\]\[[^\]]+\]\[([^\]]+)\]/);
          if (apiMatch) failure.apiName = apiMatch[1];
        }
        return reject(failure);
      }
      const line = output.trim().split(/\r?\n/).filter(Boolean).pop() || '{}';
      try { resolve({ ...JSON.parse(line), failovers: parseTushareFailovers(error) }); }
      catch (_) { reject(new Error(`同步脚本返回了无法识别的结果: ${line.slice(0, 300)}`)); }
    });
  });
}

async function runIpoHistorySync(reason = 'scheduled', businessDate, context = {}) {
  const mode = context.mode === 'enrichment' ? 'enrichment' : 'core';
  const claimed = await tryClaimJob(JOB);
  if (!claimed) return { skipped: true, reason: 'locked' };
  let runId = null;
  let retryOf = null;
  const errors = [];
  try {
    const runtime = await getProviderRuntime('tushare');
    const prior = await pool.query(
      `SELECT id,status,detail FROM job_runs WHERE job=$1
        AND (started_at AT TIME ZONE 'Asia/Shanghai')::date =
            (now() AT TIME ZONE 'Asia/Shanghai')::date
        ORDER BY id DESC LIMIT 1`,
      [JOB]
    );
    if (mode === 'core' && prior.rowCount && prior.rows[0].status === 'done') {
      return { skipped: true, reason: 'already-ran-today' };
    }
    if (mode === 'core' && prior.rowCount && prior.rows[0].status === 'failed') {
      runId = prior.rows[0].id;
      retryOf = String(prior.rows[0].detail || '').slice(0, 1000);
      await pool.query(
        `UPDATE job_runs SET status='running', started_at=now(), finished_at=NULL,
          locked_until=now() + interval '1 hour', detail=$2 WHERE id=$1`,
        [runId, JSON.stringify({ reason: 'retry-after-failure', previous: retryOf })]
      );
    } else {
      runId = await startJobRun(JOB);
    }
    for (const executable of pythonCandidates()) {
      try {
        const result = await runWith(executable, runtime, businessDate, mode, context.externalCallCount);
        await notifyTushareFailovers(result.failovers);
        const detail = JSON.stringify({ reason, executable, retryOf, ...result });
        await finishJobRun(runId, true, detail);
        console.log(`[ipo-history] ${reason}/${mode} 完成：拉取${result.fetched || 0}，新增${result.inserted || 0}，刷新${result.refreshed || 0}`);
        return result;
      } catch (error) {
        errors.push(`${executable}: ${error.message}`);
        // 只有解释器不存在才尝试下一个候选；业务/API错误不能换解释器重跑，
        // 否则同一失败会重复消耗额度并制造重复告警。
        if (error && error.code !== 'ENOENT') throw error;
      }
    }
    const failure = new Error(errors.length ? errors.join(' | ') : '未找到可用的 Python 解释器');
    const typed = errors.map(item => item.match(/\[(BUDGET_WAIT|JOB_BUDGET_EXCEEDED|RATE_LIMIT|QUOTA_EXHAUSTED|CIRCUIT_OPEN|DATASET_LOCKED|UPSTREAM_5XX|AUTH_ERROR|PERMISSION_DENIED)\]\[([^\]]+)\]/)).find(Boolean);
    if (typed) {
      failure.code = typed[1]; failure.source = typed[2];
      failure.errorType = typed[1] === 'DATASET_LOCKED' ? 'in_progress' : typed[1] === 'UPSTREAM_5XX' ? 'network' : ['AUTH_ERROR', 'PERMISSION_DENIED'].includes(typed[1]) ? 'permission' : typed[1] === 'JOB_BUDGET_EXCEEDED' ? 'non_retryable' : 'rate_limit';
      const apiMatch = errors.join(' ').match(/\[(?:BUDGET_WAIT|JOB_BUDGET_EXCEEDED|RATE_LIMIT|QUOTA_EXHAUSTED|CIRCUIT_OPEN|DATASET_LOCKED|UPSTREAM_5XX|AUTH_ERROR|PERMISSION_DENIED)\]\[[^\]]+\]\[([^\]]+)\]/);
      if (apiMatch) failure.apiName = apiMatch[1];
    }
    throw failure;
  } catch (error) {
    await finishJobRun(runId, false, JSON.stringify({ reason, error: error.message.slice(0, 1000) }));
    throw error;
  } finally {
    await releaseJob(JOB);
  }
}

function previousWeekday(ymd) {
  const day = new Date(`${ymd}T00:00:00Z`);
  do { day.setUTCDate(day.getUTCDate() - 1); } while (day.getUTCDay() === 0 || day.getUTCDay() === 6);
  return day.toISOString().slice(0, 10);
}

async function runIpoHistoryStartupCatchup(now = new Date()) {
  const p = shanghaiParts(now);
  const today = `${p.year}-${p.month}-${p.day}`;
  const expected = +p.hour >= 18 ? today : previousWeekday(today);
  const { rows } = await pool.query(
    'SELECT last_success_date::text AS d FROM ops.sync_cursors WHERE scope_key=$1 AND dataset_code=$2',
    ['global:ipo_history', 'new_share']
  );
  const last = rows[0] && rows[0].d ? String(rows[0].d).slice(0, 10) : '';
  if (last >= expected) return { skipped: true, reason: 'fresh', last, expected };
  return runIpoHistorySync('startup-catchup', today, { mode: 'core' });
}

function scheduleIpoHistorySync() {
  function scheduleNext() {
    const next = nextIpoHistorySchedule();
    const timer = setTimeout(async () => {
      try { await runIpoHistorySync(`weekday-${next.mode === 'core' ? '18:00' : '19:30'}`, undefined, { mode: next.mode }); }
      catch (error) { console.error('[ipo-history] 同步失败:', error.message); }
      scheduleNext();
    }, next.delay);
    if (timer.unref) timer.unref();
  }
  scheduleNext();
  console.log('[ipo-history] 已调度：工作日 18:00 核心事实；19:30 非紧急补全（上海时间）');
}

module.exports = {
  SCRIPT, nextIpoHistorySyncDelay, runIpoHistorySync,
  runIpoHistoryStartupCatchup, scheduleIpoHistorySync, pythonCandidates, nextIpoHistorySchedule,
};

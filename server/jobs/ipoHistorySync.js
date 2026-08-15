const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pool, tryClaimJob, releaseJob, startJobRun, finishJobRun } = require('../db');

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
  for (let offset = 0; offset < 8; offset++) {
    const day = new Date(Date.UTC(+p.year, +p.month - 1, +p.day + offset));
    if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue;
    const target = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 19, 30, 0);
    if (target > current) return target - current;
  }
  return 24 * 60 * 60 * 1000;
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

function runWith(executable) {
  return new Promise((resolve, reject) => {
    const args = path.basename(executable).toLowerCase() === 'py' ? ['-3', SCRIPT] : [SCRIPT];
    const child = spawn(executable, args, { cwd: PROJECT_ROOT, env: { ...process.env, EXTERNAL_CALL_GUARD: '1' }, windowsHide: true });
    let output = '', error = '';
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { error += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) {
        const message = (error || output || `exit ${code}`).trim();
        const failure = new Error(message);
        const typed = message.match(/\[(RATE_LIMIT|QUOTA_EXHAUSTED|CIRCUIT_OPEN|DATASET_LOCKED|UPSTREAM_5XX)\]\[([^\]]+)\]/);
        if (typed) { failure.code = typed[1]; failure.source = typed[2]; failure.errorType = typed[1] === 'DATASET_LOCKED' ? 'in_progress' : typed[1] === 'UPSTREAM_5XX' ? 'network' : 'rate_limit'; }
        return reject(failure);
      }
      const line = output.trim().split(/\r?\n/).filter(Boolean).pop() || '{}';
      try { resolve(JSON.parse(line)); }
      catch (_) { reject(new Error(`同步脚本返回了无法识别的结果: ${line.slice(0, 300)}`)); }
    });
  });
}

async function runIpoHistorySync(reason = 'scheduled') {
  const claimed = await tryClaimJob(JOB);
  if (!claimed) return { skipped: true, reason: 'locked' };
  let runId = null;
  let retryOf = null;
  const errors = [];
  try {
    const prior = await pool.query(
      `SELECT id,status,detail FROM job_runs WHERE job=$1
        AND (started_at AT TIME ZONE 'Asia/Shanghai')::date =
            (now() AT TIME ZONE 'Asia/Shanghai')::date
        ORDER BY id DESC LIMIT 1`,
      [JOB]
    );
    if (prior.rowCount && prior.rows[0].status === 'done') {
      return { skipped: true, reason: 'already-ran-today' };
    }
    if (prior.rowCount && prior.rows[0].status === 'failed') {
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
        const result = await runWith(executable);
        const detail = JSON.stringify({ reason, executable, retryOf, ...result });
        await finishJobRun(runId, true, detail);
        console.log(`[ipo-history] ${reason} 完成：拉取${result.fetched || 0}，新增${result.inserted || 0}，刷新${result.refreshed || 0}`);
        return result;
      } catch (error) {
        errors.push(`${executable}: ${error.message}`);
      }
    }
    const failure = new Error(errors.length ? errors.join(' | ') : '未找到可用的 Python 解释器');
    const typed = errors.map(item => item.match(/\[(RATE_LIMIT|QUOTA_EXHAUSTED|CIRCUIT_OPEN|DATASET_LOCKED|UPSTREAM_5XX)\]\[([^\]]+)\]/)).find(Boolean);
    if (typed) { failure.code = typed[1]; failure.source = typed[2]; failure.errorType = typed[1] === 'DATASET_LOCKED' ? 'in_progress' : typed[1] === 'UPSTREAM_5XX' ? 'network' : 'rate_limit'; }
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
  const expected = +p.hour >= 20 ? today : previousWeekday(today);
  const { rows } = await pool.query(
    'SELECT last_success_date::text AS d FROM ops.sync_cursors WHERE scope_key=$1 AND dataset_code=$2',
    ['global:ipo_history', 'new_share']
  );
  const last = rows[0] && rows[0].d ? String(rows[0].d).slice(0, 10) : '';
  if (last >= expected) return { skipped: true, reason: 'fresh', last, expected };
  return runIpoHistorySync('startup-catchup');
}

function scheduleIpoHistorySync() {
  function scheduleNext() {
    const timer = setTimeout(async () => {
      try { await runIpoHistorySync('weekday-19:30'); }
      catch (error) { console.error('[ipo-history] 同步失败:', error.message); }
      scheduleNext();
    }, nextIpoHistorySyncDelay());
    if (timer.unref) timer.unref();
  }
  scheduleNext();
  console.log('[ipo-history] 已调度：工作日 19:30（上海时间）');
}

module.exports = {
  SCRIPT, nextIpoHistorySyncDelay, runIpoHistorySync,
  runIpoHistoryStartupCatchup, scheduleIpoHistorySync, pythonCandidates,
};

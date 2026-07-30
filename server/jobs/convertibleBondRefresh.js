const path = require('path');
const { execFile } = require('child_process');
const { pool, tryClaimJob, releaseJob, startJobRun, finishJobRun } = require('../db');
const { syncConvertibleBondUniverse, syncConvertibleBondUniverseWithBackfill } = require('../services/convertibleBondAnalysis');
const { expectedTradeDate } = require('../routes/bondCycle');

const VALUATION_JOB = 'convertible_bond_valuation_refresh';
const DAILY_REFRESH_HOUR = 18;
const DAILY_REFRESH_MINUTE = 0;
const RETRY_HOUR = 8;
const RETRY_MINUTE = 0;

// 每日估值+预警：在行情/周期同步完成后串行执行（方案 §顺序：行情→周期→估值→预警）
async function runDailyValuation(reason = 'scheduled') {
  if (!(await tryClaimJob(VALUATION_JOB))) return { skipped: true, reason: 'locked' };
  let runId = null;
  try {
    runId = await startJobRun(VALUATION_JOB);
    const root = path.join(__dirname, '..', '..');
    const script = path.join(root, 'server', 'scripts', 'convertibleBondValuation.py');
    const py = process.env.VALUATION_PYTHON || path.join(root, 'venv', 'Scripts', 'python.exe');
    const output = await new Promise((resolve, reject) => {
      execFile(py, [script, 'refresh'], {
        cwd: root,
        timeout: 15 * 60 * 1000,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, VALUATION_EXPECTED_TRADE_DATE: expectedTradeDate() },
      }, (err, stdout, stderr) => {
        if (err) {
          err.detail = String(stderr || err.message).trim().split('\n').slice(-5).join(' | ');
          reject(err);
          return;
        }
        resolve(String(stdout || '').trim());
      });
    });
    const detail = output.split('\n').slice(-3).join(' | ') || `${reason}: ok`;
    await finishJobRun(runId, true, detail);
    return { ok: true, detail };
  } catch (error) {
    const { rows } = await pool.query(
      'SELECT model_version FROM analytics.convertible_bond_valuation_models WHERE is_active LIMIT 1'
    );
    const modelVersion = rows[0] ? rows[0].model_version : 'none';
    const detail = (`model=${modelVersion}; reason=${String(error.detail || error.message || 'unknown')}`).slice(0, 2000);
    await pool.query(
      `UPDATE ops.sync_cursors
          SET last_attempt_at=now(), last_error=$1, retry_count=retry_count+1, updated_at=now()
        WHERE scope_key='convertible_bond_valuation' AND dataset_code='daily_valuation'`,
      [detail]
    );
    await finishJobRun(runId, false, detail);
    throw error;
  } finally {
    await releaseJob(VALUATION_JOB);
  }
}

function nextShanghaiDelay(hour = DAILY_REFRESH_HOUR, minute = DAILY_REFRESH_MINUTE, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const p = Object.fromEntries(parts.map(item => [item.type, item.value]));
  const current = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  let target = Date.UTC(+p.year, +p.month - 1, +p.day, hour, minute, 0);
  if (target <= current) target += 24 * 3600 * 1000;
  return target - current;
}

async function bootstrapConvertibleBonds() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM fundamental.convertible_bond_profiles');
  if (rows[0].count > 0) return { skipped: true, reason: 'already_initialized' };
  return syncConvertibleBondUniverse('first_full_sync');
}

async function refreshCompleteness() {
  const expected = expectedTradeDate();
  const { rows } = await pool.query(
    `SELECT
       COALESCE((SELECT MAX(trade_date) >= $1::date FROM market.convertible_bond_daily_metrics), false) AS cycle_complete,
       COALESCE((SELECT MAX(trade_date) >= $1::date FROM analytics.convertible_bond_valuation_daily), false) AS valuation_complete`,
    [expected]
  );
  return { expected, ...rows[0] };
}

async function runRefreshChain(reason) {
  try {
    await syncConvertibleBondUniverseWithBackfill(reason);
  } catch (error) {
    console.error('[bond-analysis] 可转债增量同步失败:', error.message);
    return { ok: false, error: error.message };
  }

  const completeness = await refreshCompleteness();
  if (!completeness.cycle_complete) {
    console.warn(`[bond-analysis] ${completeness.expected} 数据不完整，跳过估值，次日 08:00 自动重试`);
    return { ok: false, incomplete: true, expected: completeness.expected };
  }

  try {
    const result = await runDailyValuation(reason);
    if (result.skipped) console.log('[bond-valuation] 已有刷新任务运行，本次跳过');
    else console.log('[bond-valuation] 每日估值完成:', result.detail);
    return { ok: true, result };
  } catch (error) {
    console.error('[bond-valuation] 每日估值失败:', String(error.detail || error.message));
    return { ok: false, error: String(error.detail || error.message) };
  }
}

function scheduleConvertibleBondRefresh() {
  bootstrapConvertibleBonds().catch(error => console.error('[bond-analysis] 首次全量同步失败:', error.message));

  function scheduleDaily(hour, minute, task) {
    const timer = setTimeout(async () => {
      try { await task(); }
      catch (error) { console.error('[bond-analysis] 定时任务执行失败:', error.message); }
      finally { scheduleDaily(hour, minute, task); }
    }, nextShanghaiDelay(hour, minute));
    if (timer.unref) timer.unref();
  }

  scheduleDaily(DAILY_REFRESH_HOUR, DAILY_REFRESH_MINUTE, () => runRefreshChain('daily_incremental'));
  scheduleDaily(RETRY_HOUR, RETRY_MINUTE, async () => {
    const completeness = await refreshCompleteness();
    if (completeness.cycle_complete && completeness.valuation_complete) return;
    console.warn(`[bond-analysis] 检测到 ${completeness.expected} 数据不完整，开始 08:00 补跑`);
    await runRefreshChain('morning_incomplete_retry');
  });
  console.log('[bond-analysis] 已调度：每日 18:00 刷新；数据不完整时次日 08:00 重试（上海时间）');
}

module.exports = {
  nextShanghaiDelay,
  bootstrapConvertibleBonds,
  refreshCompleteness,
  runRefreshChain,
  runDailyValuation,
  scheduleConvertibleBondRefresh,
};

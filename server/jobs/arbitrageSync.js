// ========== 套利公告同步调度任务 ==========
// 每天 21:30（上海时间）增量同步，启动时执行断点补偿检查
const { tryClaimJob, releaseJob, startJobRun, finishJobRun } = require('../db');
const sync = require('../services/arbitrageAnnouncementSync');
const { pool } = require('../db');

const SYNC_JOB = 'arbitrage_sync';

function nextShanghaiDelay(hour = 21, minute = 30, now = new Date()) {
  const shanghai = new Date(now.getTime() + 8 * 3600 * 1000);
  let target = Date.UTC(
    shanghai.getUTCFullYear(), shanghai.getUTCMonth(), shanghai.getUTCDate(),
    hour - 8, minute, 0, 0
  );
  if (target <= now.getTime()) target += 24 * 3600 * 1000;
  return target - now.getTime();
}

async function runArbitrageSync(reason = 'scheduled') {
  if (!(await tryClaimJob(SYNC_JOB))) return { skipped: true, reason: 'already_running' };
  const runId = await startJobRun(SYNC_JOB);
  try {
    const result = await sync.runIncrementalSync();
    const detail = `hkex:${result.hkex.total} cninfo:${result.cninfo.total}`;
    await finishJobRun(runId, true, detail);
    return { ok: true, detail, result };
  } catch (error) {
    await finishJobRun(runId, false, error.message);
    console.error('[arbitrage-sync] 同步失败:', error.message);
    return { ok: false, error: error.message };
  } finally {
    await releaseJob(SYNC_JOB);
  }
}

// 启动时检查是否需要断点补偿
async function checkStartupBackfill() {
  try {
    const { rows } = await pool.query(`
      SELECT scope_key, last_success_date, last_error
      FROM ops.sync_cursors
      WHERE scope_key LIKE 'arbitrage_%'
    `);
    if (!rows.length) {
      // 从未同步过 → 不自动启动首次同步（需管理员手动触发）
      console.log('[arbitrage-sync] 首次同步尚未执行，等待管理员手动触发');
      return;
    }
    // 检查是否有失败的游标
    const hasError = rows.some(r => r.last_error);
    if (hasError) {
      console.log('[arbitrage-sync] 检测到上次同步有错误，执行断点补偿...');
      await runArbitrageSync('startup_backfill');
    }
  } catch (err) {
    console.warn('[arbitrage-sync] 启动检查失败:', err.message);
  }
}

function scheduleArbitrageSync() {
  async function runAndReschedule() {
    await runArbitrageSync('scheduled');
    const timer = setTimeout(runAndReschedule, nextShanghaiDelay());
    if (timer.unref) timer.unref();
  }
  const initial = setTimeout(runAndReschedule, nextShanghaiDelay());
  if (initial.unref) initial.unref();

  // 启动时断点补偿检查
  checkStartupBackfill().catch(err =>
    console.warn('[arbitrage-sync] 启动补偿失败:', err.message)
  );
}

module.exports = {
  scheduleArbitrageSync,
  runArbitrageSync,
  checkStartupBackfill,
};

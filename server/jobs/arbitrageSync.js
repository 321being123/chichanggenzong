// ========== 套利公告同步调度任务 ==========
// 每天 08:30（上海时间）增量同步，启动时执行断点补偿检查
const { tryClaimJob, releaseJob, startJobRun, finishJobRun } = require('../db');
const sync = require('../services/arbitrageAnnouncementSync');
const { pool } = require('../db');
const { sanitizeJobError } = require('../services/jobErrorSanitizer');
const { cleanupArbitragePdfCache } = require('../services/arbitragePdfCache');

const SYNC_JOB = 'arbitrage_sync';

function nextShanghaiDelay(hour = 8, minute = 30, now = new Date()) {
  const shanghai = new Date(now.getTime() + 8 * 3600 * 1000);
  let target = Date.UTC(
    shanghai.getUTCFullYear(), shanghai.getUTCMonth(), shanghai.getUTCDate(),
    hour - 8, minute, 0, 0
  );
  if (target <= now.getTime()) target += 24 * 3600 * 1000;
  return target - now.getTime();
}

async function runArbitrageSync(reason = 'scheduled', context = {}) {
  if (!(await tryClaimJob(SYNC_JOB))) return { skipped: true, reason: 'already_running' };
  let runId = null;
  try {
    const pdfCache = cleanupArbitragePdfCache();
    runId = await startJobRun(SYNC_JOB);
    const result = await sync.runIncrementalSync();
    const sourceResults = Object.keys(sync.SCOPES).map(scope => result[scope] || { total: 0, errors: [], failureDetails: [] });
    const errors = sourceResults.flatMap(source => source.errors || []);
    const failure = sourceResults.flatMap(source => source.failureDetails || [])[0] || null;
    const parsePending = Number(result.recovery && result.recovery.pending || 0);
    const parsePendingNotDue = Number(result.recovery && result.recovery.pendingNotDue || 0);
    const parseExhausted = Number(result.recovery && result.recovery.exhausted || 0);
    const sourceDetail = Object.keys(sync.SCOPES).map(scope => `${scope}:${(result[scope] && result[scope].total) || 0}`).join(' ');
    const cninfoProbe = result.recovery && result.recovery.cninfoProbe;
    const probeDetail = cninfoProbe
      ? ` cninfo_probe:${cninfoProbe.status}/${Number(cninfoProbe.attempted || 0)}/${Number(cninfoProbe.recovered || 0)}`
      : '';
    const detail = `${sourceDetail} errors:${errors.length} parse_pending:${parsePending} parse_not_due:${parsePendingNotDue} parse_exhausted:${parseExhausted}${probeDetail}`;
    if (errors.length) {
      const sourceError = errors.length ? `；数据源错误：${errors.slice(0, 5).join(' | ')}` : '';
      const error = `套利公告同步未完整成功：PDF待重试 ${parsePending}，已达上限 ${parseExhausted}${sourceError}`;
      await finishJobRun(runId, false, error);
      return {
        ok: false,
        error,
        detail,
        pdfCache,
        result,
        ...(failure ? {
          errorCode: failure.code,
          errorType: failure.errorType,
          source: failure.source,
          recoverAt: failure.recoverAt,
        } : {}),
      };
    }
    if (parseExhausted) {
      const error = `套利公告解析达到最大尝试次数：${parseExhausted} 条，已转人工处理`;
      await finishJobRun(runId, true, error);
      return { ok: true, status: 'partial', continuationRequired: true, continuationBlocked: true,
        continuationStopReason: error, pendingStages: ['pdfParse'], detail, pdfCache, result };
    }
    if (parsePending || parsePendingNotDue) {
      await finishJobRun(runId, true, detail);
      return { ok: true, status: 'partial', continuationRequired: true, continuationCount: Number(context.continuationCount || 0) + 1,
        pendingStages: ['pdfParse'], nextAttemptAt: result.recovery && result.recovery.recoverAt || null,
        nextAttemptInMinutes: parsePendingNotDue && !parsePending ? 30 : 1, detail, pdfCache, result };
    }
    await finishJobRun(runId, true, detail);
    return { ok: true, detail, pdfCache, result };
  } catch (error) {
    const safeError = sanitizeJobError(error.message || error, 1000);
    await finishJobRun(runId, false, safeError);
    console.error('[arbitrage-sync] 同步失败:', safeError);
    return { ok: false, error: safeError, errorCode: error.code, errorType: error.errorType, source: error.source };
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
      WHERE scope_key = ANY($1::text[])
    `, [Object.keys(sync.SCOPES).map(scope => 'arbitrage_' + scope)]);
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
    console.warn('[arbitrage-sync] 启动检查失败:', sanitizeJobError(err.message || err, 500));
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
    console.warn('[arbitrage-sync] 启动补偿失败:', sanitizeJobError(err.message || err, 500))
  );
}

module.exports = {
  scheduleArbitrageSync,
  runArbitrageSync,
  checkStartupBackfill,
};

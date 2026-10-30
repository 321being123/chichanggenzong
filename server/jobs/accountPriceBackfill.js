// 导入/建仓后补齐账户的「持仓基准快照」与「缺失行情」——做成受管任务，走统一 Runner 续批。
//
// 为什么不再用 fire-and-forget：
// 2026-10-30 复查用真实库建 81 只持仓复现——单次调用最多处理 80 只，
// 第 81 只既没被处理，返回值里也没有 remaining / nextAttemptAt，重启后同样捡不回来，
// 等于静默丢任务。现在每批只处理一批上限，剩余、失败阶段和下次时间交给
// ops.job_schedule_slots 的续批机制持久化；缺口清空之前不宣告完成。
const repository = require('../repositories/accountPriceBackfillRepository');
const { ensurePositionBasis } = require('../services/accountPositionBasis');
const { backfillMissingTodayPrices, todayShanghai } = require('../services/accountPriceBackfill');

const DEFAULT_BATCH_LIMIT = 80;
const MAX_NO_PROGRESS = 2;

function clampLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_BATCH_LIMIT;
  return Math.min(Math.floor(parsed), DEFAULT_BATCH_LIMIT);
}

// 一次执行 = 基准补齐（幂等，只补该日仍缺的证券）+ 一批行情补齐。
// 返回 continuationRequired 时由 Runner 写入 result_summary 与 next_attempt_at，下次接着跑。
async function runAccountPriceBackfill(reason, context = {}) {
  const username = String(context.username || '').trim();
  const accountName = String(context.accountName || '').trim();
  if (!username || !accountName) {
    return { ok: false, error: '缺少账户标识（username/accountName），补价任务无法定位账户' };
  }
  const targetDate = String(context.basisDate || context.targetDate || context.businessDate || todayShanghai()).slice(0, 10);
  const limit = clampLimit(context.limit);

  // 阶段一：该业务日的持仓基准缺口（不覆盖已有快照，只补缺的证券）。
  const basis = await ensurePositionBasis(username, accountName, { date: targetDate });

  // 阶段二：补一批行情（每只按各自最早缺口日补到目标日）。
  // context.backfill 仅供测试与受控回放注入采集器，生产走默认回放路径。
  const batch = await backfillMissingTodayPrices(username, accountName, {
    today: targetDate,
    limit,
    ...(typeof context.backfill === 'function' ? { backfill: context.backfill } : {}),
  });

  // 待续阶段：基准仍缺（多为缺汇率/缺价，补回后可再写）或行情仍有剩余。
  const pendingStages = [];
  if (basis.covered !== true) pendingStages.push('positionBasis');
  if (batch.remaining > 0) pendingStages.push('priceBackfill');

  const summary = {
    username,
    accountName,
    targetDate,
    basis,
    batch,
    remaining: batch.remaining,
    basisUncovered: basis.skipped || [],
  };

  if (!pendingStages.length) {
    return { ok: true, status: 'complete', ...summary, remaining: 0, pendingStages: [] };
  }

  // 无进展保护：本批既没补下行情也没补下基准，连续达到上限就停下等人工，
  // 不让一个取不到价的证券把续跑拖到最长续跑时间。
  const progressed = Number(batch.filled || 0) > 0 || Number(basis.created || 0) > 0;
  const noProgressCount = progressed ? 0 : Number(context.noProgressCount || 0) + 1;
  const previousInitial = Number(context.initialRemaining);
  const initialRemaining = Number.isFinite(previousInitial) && previousInitial > 0
    ? previousInitial
    : batch.remaining + Number(batch.checked || 0);

  if (noProgressCount >= MAX_NO_PROGRESS) {
    return {
      ok: true,
      status: 'partial',
      ...summary,
      continuationRequired: true,
      continuationBlocked: true,
      continuationStopReason: `连续 ${noProgressCount} 批没有补下任何行情或基准（剩余 ${batch.remaining} 只），已暂停等待人工处理`,
      pendingStages,
      initialRemaining,
      lastRemaining: batch.remaining,
      noProgressCount,
    };
  }

  return {
    ok: true,
    status: 'partial',
    ...summary,
    continuationRequired: true,
    continuationCount: Number(context.continuationCount || 0) + 1,
    pendingStages,
    // 剩余写在 result_summary，Runner 同时按此值写 next_attempt_at，重启后照旧续跑。
    nextAttemptInMinutes: 1,
    initialRemaining,
    lastRemaining: batch.remaining,
    noProgressCount,
    continuationReason: `还有 ${batch.remaining} 只证券缺行情、${(basis.skipped || []).length} 只缺基准，下一批继续`,
  };
}

module.exports = { runAccountPriceBackfill };

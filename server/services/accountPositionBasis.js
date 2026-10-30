// 导入/建仓后补「持仓基准快照」：净值续链需要有「某日持有哪些证券、各多少股」这一事实，
// 缺了它 navSnapshot 只能报「持仓基准快照」缺失、那几天净值算不出来。
// 仅在该账户完全没有快照时按当前持仓补一条（不覆盖已有快照，避免把用户导入的原始事实冲掉）。
const repository = require('../repositories/accountPriceBackfillRepository');
const { todayShanghai } = require('./accountPriceBackfill');

async function ensurePositionBasis(username, accountName, options = {}) {
  if (!username || !accountName) return { created: 0, reason: 'missing_scope' };
  const date = options.date || todayShanghai(options.now);
  const existing = await repository.countPositionSnapshots([username, accountName]);
  if (existing > 0) return { created: 0, reason: 'already_has_snapshots', existing };
  const result = await repository.insertBasisSnapshotsFromPositions([username, accountName, date]);
  const created = result.rowCount || 0;
  // 无有效价格或港股缺汇率的持仓会被写入条件过滤掉；如实报出剩余缺口，
  // 避免"写了 0 条"或"写了一部分"都显示成同一件事（2026-10-30 复现）。
  const skipped = await repository.selectUncoveredPositionCodes([username, accountName, date]);
  if (skipped.length) {
    return { created, date, skipped, reason: created ? 'partial_coverage' : 'no_writable_positions' };
  }
  return { created, date };
}

module.exports = { ensurePositionBasis };

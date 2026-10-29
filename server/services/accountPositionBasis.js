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
  return { created: result.rowCount || 0, date };
}

module.exports = { ensurePositionBasis };

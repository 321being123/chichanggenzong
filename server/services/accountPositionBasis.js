// 导入/建仓后补「持仓基准快照」：净值续链需要有「某日持有哪些证券、各多少股」这一事实，
// 缺了它 navSnapshot 只能报「持仓基准快照」缺失、那几天净值算不出来。
//
// 2026-10-30 复查修复：旧实现只在「账户完全没有快照」时才写一次，首次因缺行情/缺汇率被过滤掉的
// 证券此后永远补不上（再次调用直接返回 already_has_snapshots）。现在改成每次按业务日核缺口：
//   已有快照的证券保持原事实不动（不覆盖、不改写、不删），只补该日仍缺的那些。
// 因此行情或汇率补回后再调用即可续办，重复调用幂等（第二次 created=0）。
//
// 并发（2026-10-30 二次复查 P1）：两个请求同时为同一账户补基准，各自看不到对方未提交的行，
// 同一证券被写两条。现在「读已有量 → 写缺口 → 补后重读」整段包在账户级写锁的同一个事务里，
// 锁在独立语句中先取（详见 repository.withAccountBasisLock 的注释）。
const repository = require('../repositories/accountPriceBackfillRepository');
const { todayShanghai } = require('./accountPriceBackfill');

async function ensurePositionBasis(username, accountName, options = {}) {
  if (!username || !accountName) return { created: 0, reason: 'missing_scope' };
  const date = options.date || todayShanghai(options.now);
  return repository.withAccountBasisLock([username, accountName], async client => {
    // 只用于报告「调用前已有多少行」，不参与跳过判断。
    const existing = await repository.countPositionSnapshots([username, accountName], client);
    const result = await repository.insertBasisSnapshotsFromPositions([username, accountName, date], client);
    const created = result.rowCount || 0;
    // 补后重读：以数据库里的实际状态为准，不用写入条数代替覆盖结论。
    const uncovered = await repository.selectUncoveredPositionDetails([username, accountName, date], client);
    const skipped = uncovered.map(row => row.code);
    const reasons = {};
    uncovered.forEach(row => { reasons[row.reason] = (reasons[row.reason] || 0) + 1; });
    return {
      created,
      date,
      existing,
      covered: skipped.length === 0,
      skipped,
      reasons,
      // partial_coverage：本日仍缺部分证券；complete：本日已无缺口（无论本次是否写入）。
      reason: skipped.length ? 'partial_coverage' : 'complete',
    };
  });
}

module.exports = { ensurePositionBasis };

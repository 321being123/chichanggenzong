// 导入后补持仓基准快照：只在完全没快照时按当前持仓补一条，已有快照不动。
const assert = require('assert');
const repo = require('../repositories/accountPriceBackfillRepository');
const svc = require('../services/accountPositionBasis');

(async () => {
  const originCount = repo.countPositionSnapshots;
  const originInsert = repo.insertBasisSnapshotsFromPositions;
  try {
    // 1) 已有快照 → 不写入
    let inserted = 0;
    repo.countPositionSnapshots = async () => 86;
    repo.insertBasisSnapshotsFromPositions = async () => { inserted += 1; return { rowCount: 1 }; };
    let r = await svc.ensurePositionBasis('u1', 'A', { date: '2026-10-29' });
    assert.strictEqual(r.created, 0);
    assert.strictEqual(r.reason, 'already_has_snapshots');
    assert.strictEqual(inserted, 0, '已有快照时不得再写');

    // 2) 没有快照 → 按当前持仓写一条，日期默认今天（可注入）
    let args = null;
    repo.countPositionSnapshots = async () => 0;
    repo.insertBasisSnapshotsFromPositions = async params => { args = params; return { rowCount: 28 }; };
    r = await svc.ensurePositionBasis('u1', 'A', { date: '2026-10-26' });
    assert.deepStrictEqual(args, ['u1', 'A', '2026-10-26'], '快照日期要用调用方给的业务日');
    assert.strictEqual(r.created, 28);
    assert.strictEqual(r.date, '2026-10-26');

    // 3) 缺少账户范围直接返回，不查库
    let queried = false;
    repo.countPositionSnapshots = async () => { queried = true; return 0; };
    r = await svc.ensurePositionBasis('', 'A');
    assert.strictEqual(r.reason, 'missing_scope');
    assert.strictEqual(queried, false);
  } finally {
    repo.countPositionSnapshots = originCount;
    repo.insertBasisSnapshotsFromPositions = originInsert;
  }
  console.log('导入后补持仓基准快照回归通过');
})().catch(e => { console.error(e); process.exitCode = 1; });

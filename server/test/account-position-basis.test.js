// 导入后补持仓基准快照：按业务日核缺口、只补缺的、补后重读（2026-10-30 复查后语义）。
// 旧语义「只要库里有一行就整批跳过」正是复查指出的 P1：首次被过滤掉的证券永远补不上。
const assert = require('assert');
const repo = require('../repositories/accountPriceBackfillRepository');
const svc = require('../services/accountPositionBasis');

(async () => {
  const originCount = repo.countPositionSnapshots;
  const originInsert = repo.insertBasisSnapshotsFromPositions;
  const originUncovered = repo.selectUncoveredPositionDetails;
  const originUncoveredCodes = repo.selectUncoveredPositionCodes;
  try {
    // 1) 已有快照但仍要按缺口补：不再因为 existing>0 就整批跳过
    let inserted = 0;
    repo.countPositionSnapshots = async () => 86;
    repo.insertBasisSnapshotsFromPositions = async () => { inserted += 1; return { rowCount: 1 }; };
    repo.selectUncoveredPositionDetails = async () => [];
    let r = await svc.ensurePositionBasis('u1', 'A', { date: '2026-10-29' });
    assert.strictEqual(inserted, 1, '已有快照时仍要执行缺口补齐（幂等由 NOT EXISTS 保证）');
    assert.strictEqual(r.created, 1);
    assert.strictEqual(r.existing, 86, '调用前的行数仍要报告，便于核对历史事实没被动过');
    assert.strictEqual(r.covered, true);
    assert.strictEqual(r.reason, 'complete');

    // 2) 首次只写一部分：要报出谁没写成、为什么
    repo.selectUncoveredPositionDetails = async () => [
      { code: '110001', reason: 'no_price' },
      { code: '00700', reason: 'missing_fx' }
    ];
    r = await svc.ensurePositionBasis('u1', 'A', { date: '2026-10-30' });
    assert.strictEqual(r.covered, false);
    assert.strictEqual(r.reason, 'partial_coverage');
    assert.deepStrictEqual(r.skipped, ['110001', '00700']);
    assert.deepStrictEqual(r.reasons, { no_price: 1, missing_fx: 1 }, '原因要能区分缺价与缺汇率');

    // 3) 补后重读：结论以数据库实际状态为准，不用写入条数代替
    let readBackCalls = 0;
    repo.insertBasisSnapshotsFromPositions = async () => ({ rowCount: 0 });
    repo.selectUncoveredPositionDetails = async () => { readBackCalls += 1; return []; };
    r = await svc.ensurePositionBasis('u1', 'A', { date: '2026-10-30' });
    assert.strictEqual(readBackCalls, 1, '每次都要补后重读，不能只看写入条数');
    assert.strictEqual(r.created, 0);
    assert.strictEqual(r.covered, true, '写 0 条但库里已无缺口时，仍应判为已覆盖');

    // 4) 快照日期用调用方给的业务日
    let args = null;
    repo.insertBasisSnapshotsFromPositions = async params => { args = params; return { rowCount: 28 }; };
    r = await svc.ensurePositionBasis('u1', 'A', { date: '2026-10-26' });
    assert.deepStrictEqual(args, ['u1', 'A', '2026-10-26']);
    assert.strictEqual(r.date, '2026-10-26');

    // 5) 缺少账户范围直接返回，不查库
    let queried = false;
    repo.countPositionSnapshots = async () => { queried = true; return 0; };
    r = await svc.ensurePositionBasis('', 'A');
    assert.strictEqual(r.reason, 'missing_scope');
    assert.strictEqual(queried, false);
  } finally {
    repo.countPositionSnapshots = originCount;
    repo.insertBasisSnapshotsFromPositions = originInsert;
    repo.selectUncoveredPositionDetails = originUncovered;
    repo.selectUncoveredPositionCodes = originUncoveredCodes;
  }
  console.log('导入后补持仓基准快照回归通过');
})().catch(e => { console.error(e); process.exitCode = 1; });

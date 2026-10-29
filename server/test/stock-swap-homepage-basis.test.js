// 换股结算后首页资产基准同步：被合并方移除、合并方数量并入，基准缺失时不做改写。
// 覆盖 2026-10-29 生产问题：换股只改 positions、基准仍是旧清单，导致净值任务判 missing_nav_basis。
const assert = require('assert');
const repo = require('../repositories/stockSwapSettlementRepository');
const svc = require('../services/stockSwapSettlement');

const PLAN = {
  case_id: 208, username: 'u1', account_name: 'A',
  source_code: '601198', target_code: '601995',
  source_quantity: 3100, target_quantity: 1356, existing_target_quantity: 200,
};

(async () => {
  const originBasis = repo.selectLatestHomepageBasis;
  const originPrice = repo.selectPositionPrice;
  const originUpdate = repo.updateHomepageBasis;
  const fakeClient = {};
  try {
    let written = null;
    repo.updateHomepageBasis = async (username, accountName, date, basis, client) => { written = { username, accountName, date, basis, client }; };
    repo.selectPositionPrice = async () => ({ price: '31.88' });

    // 1) 基准里有被合并方，没有合并方 → 移除来源、新增合并方（数量=换得+原有，价格取持仓表）
    repo.selectLatestHomepageBasis = async () => ({
      date: '2026-10-29',
      basis: { version: 'homepage-v1', initial: false, cash: 1000, hkRate: 0.849,
        positions: [{ code: '601198', quantity: 3100, price: 13.06, subtype: '沪市' },
          { code: '600741', quantity: 1200, price: 16.29, subtype: '沪市' }] },
    });
    let r = await svc.syncHomepageBasisAfterSwap(PLAN, fakeClient);
    assert.strictEqual(r.updated, true, '基准应被改写');
    assert.strictEqual(r.source_removed, 1, '被合并方条目应移除一条');
    const positions = written.basis.positions;
    assert.ok(!positions.some(p => p.code === '601198'), '基准里不得再出现被合并方');
    const target = positions.find(p => p.code === '601995');
    assert.ok(target, '基准里必须补上合并方');
    assert.strictEqual(target.quantity, 1556, '合并方数量应等于换得股数加原有持仓');
    assert.strictEqual(target.price, 31.88, '合并方价格取持仓表当前价');
    assert.ok(positions.some(p => p.code === '600741'), '其它持仓必须保留');
    assert.strictEqual(written.basis.cash, 1000, '现金不得被改动');
    assert.strictEqual(written.basis.hkRate, 0.849, '汇率不得被改动');
    assert.strictEqual(written.date, '2026-10-29', '改写的是最新一条净值');
    assert.strictEqual(written.client, fakeClient, '必须复用结算事务的连接');

    // 2) 基准里已经有合并方 → 数量并入，不再是新增
    written = null;
    repo.selectLatestHomepageBasis = async () => ({
      date: '2026-10-29',
      basis: { version: 'homepage-v1', cash: 0, hkRate: 0.849,
        positions: [{ code: '601198', quantity: 3100, price: 13.06, subtype: '沪市' },
          { code: '601995', quantity: 200, price: 30.5, subtype: '沪市' }] },
    });
    r = await svc.syncHomepageBasisAfterSwap(PLAN, fakeClient);
    assert.strictEqual(r.updated, true);
    const merged = written.basis.positions.find(p => p.code === '601995');
    assert.strictEqual(merged.quantity, 1556, '已有合并方应累加而非覆盖成 1356');
    assert.strictEqual(merged.price, 30.5, '已有合并方保留原价');
    assert.strictEqual(written.basis.positions.length, 1, '只剩合并方一条');

    // 3) 基准缺失 → 不改写，返回原因
    written = null;
    repo.selectLatestHomepageBasis = async () => null;
    r = await svc.syncHomepageBasisAfterSwap(PLAN, fakeClient);
    assert.strictEqual(r.updated, false);
    assert.strictEqual(r.reason, 'basis_missing');
    assert.strictEqual(written, null, '基准缺失时不得写库');

    // 4) 版本不符（旧结构）→ 同样不改写
    repo.selectLatestHomepageBasis = async () => ({ date: '2026-10-29', basis: { version: 'legacy', positions: [] } });
    r = await svc.syncHomepageBasisAfterSwap(PLAN, fakeClient);
    assert.strictEqual(r.updated, false);
    assert.strictEqual(r.reason, 'basis_missing');

    // 5) 基准里既没有被合并方也没有合并方 → 不产生无意义写入
    written = null;
    repo.selectLatestHomepageBasis = async () => ({
      date: '2026-10-29',
      basis: { version: 'homepage-v1', cash: 0, hkRate: 0.849, positions: [{ code: '600741', quantity: 1200, price: 16.29, subtype: '沪市' }] },
    });
    r = await svc.syncHomepageBasisAfterSwap({ ...PLAN, target_quantity: 0, existing_target_quantity: 0 }, fakeClient);
    assert.strictEqual(r.updated, false, '无可并入数量且没有待移除条目时不应改写');
    assert.strictEqual(written, null);
  } finally {
    repo.selectLatestHomepageBasis = originBasis;
    repo.selectPositionPrice = originPrice;
    repo.updateHomepageBasis = originUpdate;
  }
  console.log('换股后首页资产基准同步回归通过');
})().catch(e => { console.error(e); process.exitCode = 1; });

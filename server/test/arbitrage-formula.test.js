// ========== 套利公式计算测试 ==========
// 测试 3 类公式及边界值，结果精确到 0.01 个百分点
const assert = require('assert');
const svc = require('../services/arbitrageService');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' —— ' + e.message); }
}

console.log('--- 套利公式计算测试 ---');

// ===== 8.1 现金选择权/现金要约/私有化 =====
test('现金套利：对价10元，现价8元 → 套利价值2元，空间25%', () => {
  const r = svc.calcCashArbitrage(10, 8);
  assert.strictEqual(r.arbitrageValue, 2);
  assert.strictEqual(r.arbitrageSpace, 25);
});

test('现金套利：对价5元，现价5元 → 空间0%', () => {
  const r = svc.calcCashArbitrage(5, 5);
  assert.strictEqual(r.arbitrageValue, 0);
  assert.strictEqual(r.arbitrageSpace, 0);
});

test('现金套利：对价低于现价 → 空间为负', () => {
  const r = svc.calcCashArbitrage(8, 10);
  assert.strictEqual(r.arbitrageValue, -2);
  assert.strictEqual(r.arbitrageSpace, -20);
});

test('现金套利：现价为0或null → 不计算', () => {
  assert.strictEqual(svc.calcCashArbitrage(10, 0).arbitrageValue, null);
  assert.strictEqual(svc.calcCashArbitrage(10, null).arbitrageSpace, null);
  assert.strictEqual(svc.calcCashArbitrage(null, 10).arbitrageValue, null);
});

test('现金套利：小数精度验证（0.01pp）', () => {
  // 对价 10.5，现价 9.3 → 空间 = (10.5/9.3 - 1) * 100 = 12.9032...% → 12.90%
  const r = svc.calcCashArbitrage(10.5, 9.3);
  assert.ok(Math.abs(r.arbitrageSpace - 12.90) < 0.01, 'expected ~12.90, got ' + r.arbitrageSpace);
});

// ===== 8.2 换股吸收合并 =====
test('换股套利：参考价10元，比例1.5，现金补偿2元，目标价12元', () => {
  // 每股理论对价 = 10 * 1.5 + 2 = 17
  // 套利价值 = 17 - 12 = 5
  // 套利空间 = (17/12 - 1) * 100 = 41.6667% → 41.67%
  const r = svc.calcSwapArbitgage(10, 1.5, 2, 12);
  assert.strictEqual(r.theoreticalPrice, 17);
  assert.strictEqual(r.arbitrageValue, 5);
  assert.ok(Math.abs(r.arbitrageSpace - 41.67) < 0.01, 'expected ~41.67, got ' + r.arbitrageSpace);
});

test('换股套利：无现金补偿', () => {
  // 每股理论对价 = 10 * 1.2 + 0 = 12
  // 套利价值 = 12 - 10 = 2
  // 套利空间 = (12/10 - 1) * 100 = 20%
  const r = svc.calcSwapArbitgage(10, 1.2, 0, 10);
  assert.strictEqual(r.theoreticalPrice, 12);
  assert.strictEqual(r.arbitrageValue, 2);
  assert.strictEqual(r.arbitrageSpace, 20);
});

test('换股套利：缺参考价 → 不计算', () => {
  const r = svc.calcSwapArbitgage(null, 1.5, 2, 12);
  assert.strictEqual(r.arbitrageValue, null);
});

test('换股套利：比例0 → 不计算', () => {
  const r = svc.calcSwapArbitgage(10, 0, 2, 12);
  assert.strictEqual(r.arbitrageValue, null);
});

// ===== 8.3 港股供股权 =====
test('供股权套利：正股价10，供股权价0.5，供股价6，每新股需2个供股权', () => {
  // 每股新股总成本 = 6 + 0.5 * 2 = 7
  // 套利价值 = 10 - 7 = 3
  // 套利空间 = 3 / 7 * 100 = 42.8571% → 42.86%
  const caseRow = {
    strategy_type: 'hk_rights',
    subscription_price: 6,
    rights_units_per_new_share: 2,
  };
  const r = svc.calcArbitrage(caseRow, 10, null, 0.5);
  assert.strictEqual(r.totalCost, 7);
  assert.strictEqual(r.arbitrageValue, 3);
  assert.ok(Math.abs(r.arbitrageSpace - 42.86) < 0.01, 'expected ~42.86, got ' + r.arbitrageSpace);
});

test('供股权套利：供股权价高于正股 → 负空间', () => {
  // 总成本 = 6 + 3 * 1 = 9, 正股 = 8
  // 套利价值 = 8 - 9 = -1
  // 套利空间 = -1 / 9 * 100 = -11.11%
  const caseRow = {
    strategy_type: 'hk_rights',
    subscription_price: 6,
    rights_units_per_new_share: 1,
  };
  const r = svc.calcArbitrage(caseRow, 8, null, 3);
  assert.strictEqual(r.totalCost, 9);
  assert.strictEqual(r.arbitrageValue, -1);
  assert.ok(Math.abs(r.arbitrageSpace - (-11.11)) < 0.01, 'expected ~-11.11, got ' + r.arbitrageSpace);
});

test('供股权套利：缺供股价 → 不计算', () => {
  const caseRow = {
    strategy_type: 'hk_rights',
    subscription_price: null,
    rights_units_per_new_share: 2,
  };
  const r = svc.calcArbitrage(caseRow, 10, null, 0.5);
  assert.strictEqual(r.arbitrageValue, null);
});

test('供股权套利：缺units_per_new_share → 不计算', () => {
  const caseRow = {
    strategy_type: 'hk_rights',
    subscription_price: 6,
    rights_units_per_new_share: null,
  };
  const r = svc.calcArbitrage(caseRow, 10, null, 0.5);
  assert.strictEqual(r.arbitrageValue, null);
});

// ===== 统一入口 calcArbitrage =====
test('统一入口：a_cash_offer 走现金公式', () => {
  const r = svc.calcArbitrage({ strategy_type: 'a_cash_offer', offer_price: 10 }, 8, null, null);
  assert.strictEqual(r.arbitrageValue, 2);
  assert.strictEqual(r.arbitrageSpace, 25);
});

test('统一入口：hk_privatisation 走现金公式', () => {
  const r = svc.calcArbitrage({ strategy_type: 'hk_privatisation', offer_price: 5 }, 4, null, null);
  assert.strictEqual(r.arbitrageValue, 1);
  assert.strictEqual(r.arbitrageSpace, 25);
});

test('统一入口：a_share_swap 走换股公式', () => {
  const r = svc.calcArbitrage({ strategy_type: 'a_share_swap', swap_ratio: 1.5, cash_component: 2 }, 12, 10, null);
  assert.strictEqual(r.theoreticalPrice, 17);
  assert.strictEqual(r.arbitrageValue, 5);
});

test('统一入口：缺现价 → 不计算', () => {
  const r = svc.calcArbitrage({ strategy_type: 'a_cash_offer', offer_price: 10 }, null, null, null);
  assert.strictEqual(r.arbitrageValue, null);
});

test('统一入口：offer_price 和 cash_choice_price 都有时优先 offer_price', () => {
  const r = svc.calcArbitrage({ strategy_type: 'a_cash_offer', offer_price: 10, cash_choice_price: 8 }, 5, null, null);
  assert.strictEqual(r.arbitrageValue, 5); // 10 - 5 = 5
});

console.log('\nPASS=' + pass + ' FAIL=' + fail);
process.exit(fail > 0 ? 1 : 0);

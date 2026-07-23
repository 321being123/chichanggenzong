const assert = require('assert');
const { cleanValue, rateCompany, evaluateBondSafety } = require('../services/bondSafety');
const { pickArray, authHeaders, isConfigured } = require('../services/bondSafetyFetcher');
const { nextShanghaiDelay } = require('../jobs/bondSafetyRefresh');
const { finite, derivePb, isActiveBond } = require('../services/bondSafetyTushare');

const results = [];
function check(name, fn) {
  try { fn(); results.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (error) { results.push(['FAIL', name]); console.log('  [FAIL] ' + name + ' :: ' + error.message); }
}

function company(overrides) {
  return Object.assign({
    company: '示例公司', industry: '制造业', has_cb: 1,
    interest_expense: 100, ebit: 800, cash: 500, trading_fin_assets: 200,
    interest_bearing_debt: 600, total_liability: 1000,
    current_liability: 650, market_cap: 1000,
  }, overrides || {});
}

console.log('A. 旧脚本清洗与三指标评级口径');
check('清除 = 前缀并转换数字', () => assert.strictEqual(cleanValue('=53.11'), 53.11));
check('三个指标均达标 => 安全', () => assert.deepStrictEqual(rateCompany(company()).rating, '安全'));
check('优先使用Tushare直接利息保障倍数', () => {
  const result = rateCompany(company({ interest_coverage: 0.2458, interest_expense: null }));
  assert.strictEqual(result.metrics.interest, 0.2458);
  assert(!result.missing_fields.includes('interest_expense'));
});
check('2/1/0 分映射正确', () => {
  assert.strictEqual(rateCompany(company({ ebit: 600 })).rating, '低风险');
  assert.strictEqual(rateCompany(company({ ebit: 600, cash: 0, trading_fin_assets: 0 })).rating, '中风险');
  assert.strictEqual(rateCompany(company({ ebit: 600, cash: 0, trading_fin_assets: 0, total_liability: 2000 })).rating, '高风险');
});
check('银行与非银金融强制安全', () => {
  assert.strictEqual(rateCompany(company({ industry: '银行', ebit: null })).rating, '安全');
  assert.strictEqual(rateCompany(company({ industry: '非银金融', ebit: null })).rating, '安全');
});
check('缺失字段被诊断，缺少两类负债时现金覆盖率不得分', () => {
  const result = rateCompany(company({ cash: null, trading_fin_assets: null, current_liability: null, interest_bearing_debt: null }));
  assert(result.missing_fields.includes('cash'));
  assert.strictEqual(result.score, 2);
  assert.strictEqual(result.metrics.liquidity, null);
});
check('现金覆盖流动负债或有息负债任一达到1即可得分', () => {
  const currentPassed = rateCompany(company({ cash: 600, trading_fin_assets: 0, current_liability: 500, interest_bearing_debt: 800 }));
  const interestPassed = rateCompany(company({ cash: 600, trading_fin_assets: 0, current_liability: 800, interest_bearing_debt: 500 }));
  const neitherPassed = rateCompany(company({ cash: 400, trading_fin_assets: 0, current_liability: 500, interest_bearing_debt: 800 }));
  assert.strictEqual(currentPassed.checks.liquidity, true);
  assert.strictEqual(interestPassed.checks.liquidity, true);
  assert.strictEqual(neitherPassed.checks.liquidity, false);
  assert.strictEqual(currentPassed.metrics.liquidity, 1.2);
  assert.strictEqual(interestPassed.metrics.liquidity, 1.2);
});

console.log('B. 合并、未评级、过滤与排序');
check('只处理 has_cb=1 公司，并按价格升序、空值最后', () => {
  const result = evaluateBondSafety(
    [company(), company({ company: '无转债公司', has_cb: 0 })],
    [
      { bond_code: '2', bond_name: 'B', stock_name: '未知公司', bond_price: null },
      { bond_code: '1', bond_name: 'A', stock_name: '示例公司', bond_price: '=101.5' },
      { bond_code: '说明', bond_name: '', stock_name: '', bond_price: 1 },
      { bond_code: '数据来源于某网站', bond_name: '', stock_name: '', bond_price: 1 },
    ]
  );
  assert.deepStrictEqual(result.data.map(row => row.bond_code), ['说明', '1', '2']);
  assert.strictEqual(result.data[1].safety, '安全');
  assert.strictEqual(result.data[1].indicator_interest, 8);
  assert(Math.abs(result.data[1].indicator_liquidity - (700 / 600)) < 1e-9);
  assert.strictEqual(result.data[1].indicator_leverage, 1);
  assert.strictEqual(result.data[2].safety, '未评级');
  assert.strictEqual(result.diagnostics.unmatched_stock_count, 1);
});
check('同名公司评级冲突时拒绝刷新', () => {
  assert.throws(() => evaluateBondSafety([
    company(), company({ ebit: 0, cash: 0, trading_fin_assets: 0, total_liability: 5000 })
  ], []), /冲突的重复名称/);
});

console.log('C. API 适配与调度边界');
check('支持聚合接口常见 data 包装', () => {
  assert.deepStrictEqual(pickArray({ data: { companies: [{ id: 1 }] } }, ['companies'], '公司财务'), [{ id: 1 }]);
});
check('鉴权头默认使用 Bearer，亦可配置裸 Token', () => {
  assert.strictEqual(authHeaders({ BOND_SAFETY_API_TOKEN: 'x' }).Authorization, 'Bearer x');
  assert.strictEqual(authHeaders({ BOND_SAFETY_API_TOKEN: 'x', BOND_SAFETY_API_AUTH_HEADER: 'X-Key', BOND_SAFETY_API_AUTH_SCHEME: '' })['X-Key'], 'x');
});
check('单接口或双接口配置均可识别', () => {
  assert.strictEqual(isConfigured({ BOND_SAFETY_API_URL: 'https://example.test' }), true);
  assert.strictEqual(isConfigured({ BOND_SAFETY_COMPANY_API_URL: 'a', BOND_SAFETY_QUOTE_API_URL: 'b' }), true);
  assert.strictEqual(isConfigured({ BOND_SAFETY_COMPANY_API_URL: 'a' }), false);
});
check('上海时间下一次 06:30 计算正确', () => {
  assert.strictEqual(nextShanghaiDelay(6, 30, new Date('2026-07-17T22:29:00.000Z')), 60 * 1000);
  assert.strictEqual(nextShanghaiDelay(6, 30, new Date('2026-07-17T22:31:00.000Z')), (23 * 60 + 59) * 60 * 1000);
});
check('Tushare 空值不会被误转成 0', () => {
  assert.strictEqual(finite(null), null);
  assert.strictEqual(finite(''), null);
  assert.strictEqual(finite('12.3'), 12.3);
});
check('已到期或已停止转股的转债被过滤', () => {
  const base = { ts_code: '127033.SZ', stk_code: '002822.SZ', list_date: '20210524' };
  const listed = new Set(['002822.SZ']);
  assert.strictEqual(isActiveBond(Object.assign({}, base, { conv_stop_date: '20250919' }), '20260717', listed), false);
  assert.strictEqual(isActiveBond(Object.assign({}, base, { maturity_date: '20240814' }), '20260717', listed), false);
  assert.strictEqual(isActiveBond(Object.assign({}, base, { maturity_date: '20270416', conv_stop_date: null }), '20260717', listed), true);
});
check('PB缺失时可按总市值和归母净资产补算正负市净率', () => {
  assert.strictEqual(derivePb(10000, 50000000), 2);
  assert.strictEqual(derivePb(10000, -50000000), -2);
  assert.strictEqual(derivePb(null, -50000000), null);
});

const pass = results.filter(r => r[0] === 'PASS').length;
const fail = results.filter(r => r[0] === 'FAIL').length;
console.log(`\n===== bond-safety 回归汇总 =====\nPASS=${pass}  FAIL=${fail}`);
if (fail) { console.log('HAS_ISSUES'); process.exit(1); }
console.log('ALL PASS');

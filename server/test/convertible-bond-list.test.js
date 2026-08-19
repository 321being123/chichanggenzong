// 上市可转债列表：派生指标和页面接入回归测试。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const svc = require('../services/convertibleBondListService');
const { annualizedVolatility, cashflowsToDate, yieldToMaturity, blackScholesConvertible, remainingYears } = require('../services/convertibleBondAnalysis');

const tests = [];
function check(name, fn) {
  try { fn(); tests.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (error) { tests.push(['FAIL', name + ' :: ' + error.message]); console.log('  [FAIL] ' + name + ' :: ' + error.message); }
}

check('每日列表指标使用固定公式版本并返回 Excel 核心字段', () => {
  const row = {
    instrument_id: 1, trade_date: '2026-08-14', stock_instrument_id: 2,
    close: 110, conversion_value: 100, conversion_premium_pct: 10, bond_value: 95,
    raw_payload: { amount: '10000', pct_chg: '1.20' }, current_conv_price: 10,
    stock_close: 20, stock_prev_close: 19.5, stock_market_cap: 1000000000,
    stock_dividend_yield: 0.02, maturity_date: '2030-08-14', value_date: '2024-08-14',
    remain_size: 100000000, rate_clause: '第一年0.20%，第二年0.40%',
    profile_payload: { put_clause: '最后两个计息年度内，连续30个交易日低于转股价的70%' },
    financial_data: { total_assets: 1000, total_liability: 500 },
    fund_ratio: 0.03, newest_rating: 'AA', stock_pb: 1.2,
  };
  const metrics = svc.calculateRow(row, new Map([['2', Array.from({ length: 40 }, (_, i) => ({ trade_date: '2026-07-' + String(i + 1).padStart(2, '0'), close: 20 + i * 0.01 }))]]), []);
  assert.strictEqual(metrics.formula_version, svc.FORMULA_VERSION);
  assert.ok(metrics.theoretical_option_value == null || metrics.theoretical_option_value >= 0);
  assert.ok(Math.abs(metrics.double_low - 120) < 0.0001, '双低应按价格+溢价率×100');
  assert.ok(Math.abs(metrics.asset_liability_ratio - 0.5) < 0.0001);
  assert.ok(Math.abs(metrics.bond_market_cap_ratio - 0.1) < 0.0001);
});

check('换手率按 Excel 的万元、百元面值和百分比口径计算', () => {
  const row = {
    trade_date: '2026-08-14', close: 110, conversion_value: 100, bond_value: 95,
    raw_payload: { amount: '10000' }, current_conv_price: 10, stock_close: 20,
    stock_market_cap: 1000000000, maturity_date: '2030-08-14', value_date: '2024-08-14',
    remain_size: 100000000, financial_data: { total_assets: 1000, total_liability: 500 },
    fund_ratio: 0.03, profile_payload: {}, maturity_call_price: '110',
  };
  const metrics = svc.calculateRow(row, new Map([['undefined', []]]), []);
  assert.ok(Math.abs(metrics.turnover_rate - (10000 * 10000 * 100 / 110 / 100000000)) < 1e-12);
});

check('波动率按真实交易日排序，历史日期计算可复现', () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({
    trade_date: new Date(Date.UTC(2026, 0, i + 1)), close: 100 + i * 0.25,
  })).reverse();
  const expectedRows = rows.slice().sort((a, b) => a.trade_date - b.trade_date);
  const returns = expectedRows.slice(1).map((row, i) => Math.log(row.close / expectedRows[i].close));
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / (returns.length - 1);
  const expected = Math.sqrt(variance) * Math.sqrt(250);
  assert.ok(Math.abs(annualizedVolatility(rows) - expected) < 1e-12);
});

check('理论偏离度和到期收益率使用附件口径及实际赎回价', () => {
  const row = {
    trade_date: '2026-08-14', close: 110, conversion_value: 100, bond_value: 95,
    raw_payload: { amount: '10000' }, current_conv_price: 10, stock_close: 20, stock_dividend_yield: 2,
    stock_market_cap: 1000000000, maturity_date: '2027-08-14', value_date: '2024-08-14',
    remain_size: 100000000, rate_clause: '第一年0.20%，第二年0.40%', coupon_rate: 0.2,
    profile_payload: {}, maturity_call_price: '110', financial_data: { total_assets: 1000, total_liability: 500 },
    fund_ratio: 0.03,
  };
  const history = Array.from({ length: 40 }, (_, i) => ({ trade_date: `2026-07-${String(i + 1).padStart(2, '0')}`, close: 20 + i * 0.01 }));
  const metrics = svc.calculateRow(row, new Map([['undefined', history]]), []);
  assert.ok(metrics.theoretical_value > 0);
  assert.ok(Math.abs(metrics.theoretical_option_value - blackScholesConvertible(20, 10, remainingYears(row.maturity_date, new Date('2026-08-14T00:00:00+08:00')), metrics.stock_volatility, 0.015, 0.02)) < 1e-9);
  assert.ok(Math.abs(metrics.theoretical_deviation_pct - (row.close - metrics.theoretical_value) / row.close) < 1e-12);
  const profile = { value_date: row.value_date, maturity_date: row.maturity_date, rate_clause: row.rate_clause, coupon_rate: row.coupon_rate };
  const expected = yieldToMaturity(row.close, cashflowsToDate(profile, [], row.maturity_date, false, 110, row.trade_date));
  assert.ok(Math.abs(metrics.maturity_yield_pre_tax - expected) < 1e-12);
});

check('历史计算使用交易日作为估值时点，并保留基金报告日期', () => {
  const profile = { value_date: '2024-08-14', maturity_date: '2027-08-14', rate_clause: '' };
  const flows = cashflowsToDate(profile, [], '2027-08-14', false, 100, '2026-08-14');
  assert.ok(Math.abs(flows[flows.length - 1].years - 365 / 365.25) < 1e-10);
  const row = {
    trade_date: '2026-08-14', close: 100, conversion_value: 100, bond_value: 95,
    raw_payload: { amount: '10000' }, current_conv_price: 10, stock_close: 20,
    stock_market_cap: 1000000000, maturity_date: '2030-08-14', value_date: '2024-08-14',
    remain_size: 100000000, profile_payload: {}, financial_data: { total_assets: 1000, total_liability: 500 },
    fund_ratio: 0.03, fund_report_date: new Date('2026-06-30T00:00:00.000Z'),
  };
  const metrics = svc.calculateRow(row, new Map([['undefined', []]]), []);
  assert.strictEqual(metrics.fund_report_date, '2026-06-30');
});

check('前端含上市转债子页、脚本和只读接口', () => {
  const root = path.join(__dirname, '..', '..');
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(root, 'public', 'js', 'bond-list.js'), 'utf8');
  assert.ok(html.includes('data-sub="list"') && html.includes('id="sub-bond-list"'));
  assert.ok(html.indexOf('data-sub="list"') < html.indexOf('data-sub="safety"'), '上市可转债未放在二级导航第一项');
  assert.ok(html.includes('js/bond-list.js'));
  assert.ok(html.includes('id="bond-list-refresh"'), '列表缺少手动刷新按钮');
  assert.ok(js.includes('/api/bond-analysis/bonds'));
  assert.ok(js.includes('BOND_LIST_COLUMNS'));
  assert.ok(js.includes("['safety','安全性']") && js.includes('bondListSafety'), '列表缺少债券安全性列');
  ['最快回售触发日', '最快回售剩余年限', '预期回售到账日', '回售到账税前收益', '回售到账税后收益'].forEach(function(title) {
    assert.ok(!js.includes("'" + title + "'"), '列表仍展示已取消列：' + title);
  });
  assert.ok(js.includes('BOND_LIST_REFRESH_MS') && js.includes('refresh=1') && js.includes('setInterval'), '列表缺少15分钟自动刷新');
  assert.ok(js.includes('bondListRefresh'), '列表缺少手动刷新函数');
  assert.ok(js.includes('bond-list-up') && js.includes('bond-list-down'), '涨跌幅缺少红涨绿跌样式');
  assert.ok(js.includes('biz-sort-indicator') && js.includes('aria-sort="'), '列表表头缺少正逆序标识或排序状态');
  assert.ok(js.includes("var cls = 'sortable'") && js.includes('is-sorted'), '列表选中排序列缺少表头区分');
  const sharedCss = fs.readFileSync(path.join(root, 'public', 'shared', 'style.css'), 'utf8');
  const sharedTable = fs.readFileSync(path.join(root, 'public', 'shared', 'business-table.js'), 'utf8');
  assert.ok(sharedCss.includes('.biz-table th.sortable') && sharedCss.includes('cursor: pointer') && sharedCss.includes('.biz-table th.is-sorted'), '共享表格缺少手势光标和选中列样式');
  assert.ok(sharedCss.includes('.biz-table-head-label { display: inline-block;') && !sharedCss.includes('min-width: 60px; max-width: 88px'), '共享表格表头不得主动预留固定列宽');
  assert.ok(sharedTable.includes('biz-table-head-label') && sharedTable.includes('normalizeHeaders') && sharedTable.includes('splitLongHeaderLabel'), '共享表格必须统一处理长标题换行');
  assert.ok(sharedCss.includes('.biz-sort-indicator { position: absolute;') && sharedCss.includes('left: 50%'), '排序图标未固定在标题上方，可能导致列宽变化');
  assert.ok(js.includes('bond-list-stale') && js.includes('data.stale'));
  const css = fs.readFileSync(path.join(root, 'public', 'css', 'bond-safety.css'), 'utf8');
  assert.ok(js.includes('bondListFloatingHead') && js.includes('bondListSyncFloatingHead'), '列表缺少滚动吸顶表头逻辑');
  assert.ok(css.includes('#sub-bond-list .table-wrap { overflow:visible; }') && css.includes('.bond-list-floating-head { position:fixed;') && css.includes('min-height:40px;'), '列表标题未固定到二级导航下方');
  assert.ok(js.includes("document.querySelector('#main-bond-safety > .bond-header')"), '固定表头取错二级导航');
  assert.ok(js.includes('bondListFloatingScroll') && js.includes('bondListSyncFloatingScroll'), '列表左右滚动条未固定在窗口底部');
  assert.ok(js.includes("event.target.id === 'bond-list-floating-scroll'"), '底部滚动条事件被全局滚动监听覆盖');
  assert.ok(css.includes('.bond-list-floating-scroll { position:fixed; bottom:0;'), '底部横向滚动条缺少固定样式');
  assert.ok(css.includes('.bond-list-up { color:#d93025;') && css.includes('.bond-list-down { color:#137333;'), '涨跌幅颜色未按红涨绿跌设置');
});

check('接口路由在单债动态参数之前注册', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'bondAnalysis.js'), 'utf8');
  assert.ok(source.indexOf("router.get('/bonds'") < source.indexOf("router.get('/:code'"));
});

check('列表发布失败时使用事务回滚并保留上一份快照', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'convertibleBondListService.js'), 'utf8');
  assert.ok(source.includes("await client.query('BEGIN')"));
  assert.ok(source.includes("await client.query('ROLLBACK')"));
  assert.ok(source.includes('ON CONFLICT(trade_date,instrument_id,formula_version) DO UPDATE'));
  assert.ok(source.includes('latestPublishedTradeDate'));
  assert.ok(source.includes('fetchTencentQuotes') && source.includes('refreshQuotes'));
  assert.ok(source.includes('stale'));
});

check('上市列表复用安全性快照并保留四档评级', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'convertibleBondListService.js'), 'utf8');
  assert.ok(source.includes('latestSafetyRatings') && source.includes('bond_safety_snapshots'), '列表未读取安全性快照');
  assert.ok(source.includes("safety: safetyRatings.get(bondCode)"), '列表未返回安全性字段');
  assert.ok(!source.includes("addMissing('expected_put_payment_date'") && !source.includes("addMissing('put_yield_pre_tax'") && !source.includes("addMissing('put_yield_after_tax'"), '已取消回售列仍影响完整性判定');
  assert.ok(source.includes('LIST_IGNORED_MISSING_FIELDS') && source.includes('const missing = Array.isArray(rawDiagnostics.missing)'), '历史指标未按当前展示列重新判定完整性');
});

check('资产负债率缓存缺资产时会进入补拉队列，临期高溢价债券收益率可计算', () => {
  const tushare = fs.readFileSync(path.join(__dirname, '..', 'services', 'bondSafetyTushare.js'), 'utf8');
  assert.ok(tushare.includes('finite(cached.data.total_assets) == null'), '财务缓存缺资产时不会补拉');
  const highPremiumYield = yieldToMaturity(149.25, [{ years: 0.02737850787132101, amount: 108 }]);
  assert.ok(highPremiumYield != null && highPremiumYield < -0.99, '临期高溢价收益率仍返回空值');
});

const pass = tests.filter(item => item[0] === 'PASS').length;
const fail = tests.filter(item => item[0] === 'FAIL').length;
console.log('\n===== convertible-bond-list 测试汇总 =====');
console.log('PASS=' + pass + '  FAIL=' + fail);
if (fail) process.exit(1);

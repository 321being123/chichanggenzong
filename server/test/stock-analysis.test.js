const assert = require('assert');
const {
  finite, normalizeStockCode, isOrdinaryAStock, growthMetric, percentile, selectDividendPlans, selectLatestByPeriod,
} = require('../services/stockAnalysis');

function close(actual, expected, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) < epsilon, `${actual} != ${expected}`);
}

assert.strictEqual(finite(null), null);
assert.strictEqual(finite(''), null);
assert.strictEqual(finite('-12.5'), -12.5);

assert.strictEqual(normalizeStockCode('600519'), '600519.SH');
assert.strictEqual(normalizeStockCode('000001.sz'), '000001.SZ');
assert.strictEqual(isOrdinaryAStock('600519.SH'), true);
assert.strictEqual(isOrdinaryAStock('113575.SH'), false);
assert.strictEqual(isOrdinaryAStock('00700.HK'), false);

const cagr = growthMetric(100, 121, 2);
close(cagr.value, 0.1);
assert.strictEqual(cagr.method, 'CAGR');

const signed = growthMetric(100, -20, 3);
close(signed.value, -1.2);
assert.strictEqual(signed.method, '带符号变化率，非CAGR');
assert.strictEqual(growthMetric(0, -20, 3).value, null);

const positive = percentile(3, [-1, 1, 2, 3, 4, null]);
close(positive.value, 0.75);
assert.strictEqual(positive.samples, 4);
const negative = percentile(-2, [-3, 1, 2]);
assert.strictEqual(negative.value, null);
assert.strictEqual(negative.samples, 2);

const dividendPlans=selectDividendPlans([
  {end_date:'20251231',ann_date:'20260301',div_proc:'预案',cash_div_tax:1},
  {end_date:'20251231',ann_date:'20260630',div_proc:'股东大会通过',cash_div_tax:1},
  {end_date:'20241231',ann_date:'20250301',div_proc:'实施',cash_div_tax:.8},
  {end_date:'20250630',ann_date:'20250801',div_proc:'预案',cash_div_tax:0}
]);
assert.strictEqual(dividendPlans.length,2);
assert.strictEqual(dividendPlans.find(row=>row.end_date==='20251231').div_proc,'股东大会通过');

const selected = selectLatestByPeriod([
  { end_date:'20251231', ann_date:'20260301', report_type:'2', value:'parent' },
  { end_date:'20251231', ann_date:'20260220', report_type:'1', value:'consolidated' },
  { end_date:'20251231', ann_date:'20270101', report_type:'1', value:'future' },
], '20260719');
assert.strictEqual(selected.get('20251231').value, 'consolidated');

console.log('stock-analysis tests passed');

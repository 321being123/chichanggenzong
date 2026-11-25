// 归母合计与普通股专属指标口径不同，不能互相回退。
process.env.NODE_ENV = 'test';
const assert = require('assert');
const { REPORT_METRICS, HK_REPORT_METRICS, pickFirstMetric } = require('../dataAccess/adapters/lixingerDatasetAdapter');

for (const mapping of [REPORT_METRICS, HK_REPORT_METRICS]) {
  assert.strictEqual(mapping.income.n_income_attr_p, 'ps.npatshaoehopc');
  assert.strictEqual(mapping.balance.total_hldr_eqy_exc_min_int, 'bs.tetshaoehopc');
  assert.strictEqual(pickFirstMetric({ 'ps.npatoshopc.t': 999 }, mapping.income.n_income_attr_p), null);
  assert.strictEqual(pickFirstMetric({ 'bs.tetoshopc.t': 999 }, mapping.balance.total_hldr_eqy_exc_min_int), null);
  assert.strictEqual(pickFirstMetric({ 'ps.npatshaoehopc.t': 111, 'ps.npatoshopc.t': 999 }, mapping.income.n_income_attr_p), 111);
  assert.strictEqual(pickFirstMetric({ 'bs.tetshaoehopc.t': 551, 'bs.tetoshopc.t': 451 }, mapping.balance.total_hldr_eqy_exc_min_int), 551);
}
assert.strictEqual(pickFirstMetric({ 'ps.oi.t': 0 }, REPORT_METRICS.income.revenue), 0);
assert.strictEqual(pickFirstMetric({}, REPORT_METRICS.income.revenue), null);
const dict = require('../dataAccess/lixingerReportMetrics');
const cmpBatches = dict.requestComparisonBatchesOf('CN', 128, 'non_financial', 't', ['income']);
assert.ok(cmpBatches.length > 0 && cmpBatches.every(b => b.length <= 128), '比较指标分批不得超过 128');
assert.ok(cmpBatches.flat().some(c => c.endsWith('.t_y2y')), '应包含 .t_y2y 原生同比请求');
assert.ok(cmpBatches.flat().some(c => c.endsWith('.t_c2c')), '应包含 .t_c2c 原生环比请求');
assert.ok(cmpBatches.flat().some(c => c.endsWith('.c')), '利润表应包含 .c 单季请求');
console.log('lixinger-report-metrics.test.js 通过');

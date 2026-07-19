const assert = require('assert');
const { asDate, finite, analysisMetricValues } = require('../services/financialDataArchitecture');

assert.strictEqual(asDate('20260719'), '2026-07-19');
assert.strictEqual(asDate(''), null);
assert.strictEqual(finite('12.5'), 12.5);
assert.strictEqual(finite('无'), null);

const values = analysisMetricValues({
  valuation: { pe_ttm: 10 }, safety: { net_cash: 20 },
  cashflow: { latest_year: { operating: 30, free: 25 }, average_3y: { operating: 28, free: 22 }, average_5y: { operating: 24, free: 18 } },
  growth: { periods: { 3: { parent: { value: 0.1 }, deducted: { value: 0.08 } } }, latest_interim_yoy: { parent: 0.2, deducted: 0.15 } }
});
assert.strictEqual(values.pe_ttm, 10);
assert.strictEqual(values.net_cash, 20);
assert.strictEqual(values.free_cashflow_3y, 22);
assert.strictEqual(values.profit_growth_3y_parent, 0.1);
assert.strictEqual(values.profit_growth_latest_deducted, 0.15);
console.log('financial data architecture tests passed');

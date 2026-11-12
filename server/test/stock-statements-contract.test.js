'use strict';

const assert = require('assert');
const { buildStatementPayload } = require('../services/stockStatementService');
const { presentationOf, sectionOf } = require('../domain/statementPresentation');
const { listStatementRows } = require('../repositories/stockStatementsRepository');

function coverage(codes, complete = true) {
  return { requested_metric_codes: codes, returned_metric_codes: codes, complete };
}

function row(overrides) {
  return Object.assign({
    report_id: 1, company_id: 9, period_end: '2025-06-30', period_type: 'semiannual',
    currency_code: 'HKD', accounting_standard: 'HKFRS', source_version: 'v1',
    statement_scope: 'consolidated', announced_at: '2025-08-20',
    bs_ta: null, bs_tl: null, statement_coverage: coverage(['bs.ta', 'bs.tl']),
  }, overrides);
}

function field(payload, code) { return payload.fields.find(item => item.code === code); }

const rows = [
  row({ report_id: 2, period_end: '2025-06-30', bs_ta: 0, bs_tl: 0 }),
  row({ report_id: 1, period_end: '2024-06-30', bs_ta: 100000000, bs_tl: 200000000 }),
];
const payload = buildStatementPayload({ market: 'HK', type: 'balance', rows, options: { compare: 'yoy' }, canonicalCode: '00001.HK', formulaVersion: 'contract-test' });
assert.strictEqual(payload.periods[0].fiscal_year, null, '港股非 12 月期末不能按日期猜财政年度');
assert.strictEqual(field(payload, 'bs.ta').values[0].value, 0, '0 必须是有效事实，不得被当作缺失');
assert.strictEqual(field(payload, 'bs.ta').values[0].status, 'available');
assert.strictEqual(field(payload, 'bs.ta').values[0].yoy, -1, '同比分母应使用绝对值，且允许从正数变为 0');
assert.strictEqual(field(payload, 'bs.ta').values[0].comparison_status, 'available');

const zeroDenominator = buildStatementPayload({
  market: 'HK', type: 'balance',
  rows: [row({ report_id: 4, period_end: '2025-06-30', bs_tl: 10 }), row({ report_id: 3, period_end: '2024-06-30', bs_tl: 0 })],
  options: { compare: 'yoy' }, canonicalCode: '00001.HK', formulaVersion: 'contract-test',
});
assert.strictEqual(field(zeroDenominator, 'bs.tl').values[0].change, null);
assert.strictEqual(field(zeroDenominator, 'bs.tl').values[0].comparison_reason, 'zero_denominator');

const incomplete = buildStatementPayload({
  market: 'HK', type: 'balance',
  rows: [row({ bs_ta: null, statement_coverage: coverage(['bs.ta'], false) })],
  options: { compare: 'none' }, canonicalCode: '00001.HK', formulaVersion: 'contract-test',
});
assert.strictEqual(field(incomplete, 'bs.ta').values[0].status, 'collection_incomplete');
assert.strictEqual(field(incomplete, 'bs.ta').values[0].value, null, '未披露事实不能被 Number(null) 转成 0');

const undisclosed = buildStatementPayload({
  market: 'HK', type: 'balance',
  rows: [row({ bs_ta: null, statement_coverage: coverage(['bs.ta'], true) })],
  options: { compare: 'none' }, canonicalCode: '00001.HK', formulaVersion: 'contract-test',
});
assert.strictEqual(field(undisclosed, 'bs.ta').values[0].status, 'source_not_disclosed');
assert.strictEqual(field(undisclosed, 'bs.ta').values[0].value, null, '来源未披露必须保留 null');

const presentation = presentationOf([
  { code: 'ps.toi', name: '营业总收入' },
  { code: 'ps.toc', name: '营业总成本' },
  { code: 'ps.oc', name: '营业成本' },
  { code: 'cfs.stciffoa', name: '经营活动现金流入小计' },
  { code: 'cfs.crfscapls', name: '销售商品提供劳务收到的现金' },
], 'income', 'CNY');
assert.strictEqual(presentation.find(item => item.code === 'ps.toc').parent, null, '营业总成本不能挂到营业总收入');
assert.strictEqual(presentation.find(item => item.code === 'ps.oc').parent, 'ps.toc', '营业成本应挂到营业总成本');
assert.strictEqual(sectionOf({ code: 'cfs.crfscapls', name: '销售商品提供劳务收到的现金' }, 'cashflow'), '经营活动现金流', '经营现金流明细不能落到补充资料');
assert.strictEqual(presentation.find(item => item.code === 'cfs.crfscapls').parent, 'cfs.stciffoa', '经营现金流入明细应挂到流入小计');

const flow = buildStatementPayload({
  market: 'CN', type: 'income',
  rows: [
    { report_id: 2, period_end: '2025-06-30', period_type: 'semiannual', currency_code: 'CNY', accounting_standard: 'CAS', source_version: 'v1', statement_scope: 'consolidated', ps_tp: 3, statement_coverage: coverage(['ps.tp']) },
    { report_id: 1, period_end: '2025-03-31', period_type: 'q1', currency_code: 'CNY', accounting_standard: 'CAS', source_version: 'v1', statement_scope: 'consolidated', ps_tp: 2, statement_coverage: coverage(['ps.tp']) },
  ],
  options: { compare: 'qoq' }, canonicalCode: '600000.SH', formulaVersion: 'contract-test',
});
assert.strictEqual(field(flow, 'ps.tp').values[0].change, null, '累计流量表不能未经单季证据直接算环比');
assert.strictEqual(field(flow, 'ps.tp').values[0].comparison_reason, 'cumulative_flow_qoq_not_supported');

(async () => {
  let legacySql = '';
  await listStatementRows({
    tsCode: '000719.SZ', market: 'CN', type: 'balance', limit: 3,
    tx: { query: async (sql) => { legacySql = sql; return { rows: [] }; } },
  });
  assert.match(legacySql, /FROM fundamental\.financial_reports r/);
  assert.match(legacySql, /LEFT JOIN fundamental\.statement_balance_cas w/);
  assert.match(legacySql, /raw_payload->>'total_assets'/, '旧 A 股资产字段必须有受控回退');
  console.log('stock statements contract tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

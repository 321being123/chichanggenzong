'use strict';

const assert = require('assert');
const { buildStatementPayload, statementAnalysisVersionOf } = require('../services/stockStatementService');
const { presentationOf, sectionOf, normalizeMetricValue } = require('../domain/statementPresentation');
const dict = require('../dataAccess/lixingerReportMetrics');
const repository = require('../repositories/stockStatementsRepository');
const { listStatementRows } = repository;

function coverage(codes, complete = true) {
  return { requested_metric_codes: codes, returned_metric_codes: codes, complete };
}

function row(overrides) {
  return Object.assign({
    report_id: 1, company_id: 9, period_end: '2025-06-30', period_type: 'semiannual',
    currency_code: 'HKD', accounting_standard: 'HKFRS', source_id: 1, source_version: 'v1', update_flag: '0', comp_type: '1',
    statement_scope: 'consolidated', announced_at: '2025-08-20',
    bs_ta: null, bs_tl: null, statement_coverage: coverage(['bs.ta', 'bs.tl']),
  }, overrides);
}

function field(payload, code) { return payload.fields.find(item => item.code === code); }

const versionRow = row({ statement_revision: '2026-11-12T12:00:00.000001' });
const version = revision => statementAnalysisVersionOf({ canonicalCode: '00001.HK', market: 'HK', type: 'balance',
  rows: [{ ...versionRow, statement_revision: revision }] });
assert.notStrictEqual(version(versionRow.statement_revision), version('2026-11-12T12:00:00.000002'), '同一报告宽表数值更新必须改变版本');

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

for (const [market, statement, code, raw, expected, unit] of [
  ['CN', 'balance', 'bs.tl_ta_r', 0.5, 50, '%'],
  ['CN', 'balance', 'bs.tetoshopc_ps', 0.5, 0.5, 'CNY/股'],
  ['CN', 'balance', 'bs.tca_tcl_r', 1.5, 1.5, '倍'],
  ['CN', 'cashflow', 'cfs.iocacedtfier', 100000000, 1, 'CNY·亿元'],
  ['HK', 'cashflow', 'cfs.iocacedtfier', 100000000, 1, 'CNY·亿元'],
]) {
  const metric = dict.metricsByStatement(market, statement).find(item => item.code === code);
  const info = presentationOf([metric], statement, 'CNY')[0];
  assert.strictEqual(info.unit, unit, `${code} 单位`);
  assert.strictEqual(normalizeMetricValue(raw, info, 'CNY'), expected, `${code} 换算`);
}

function balanceComparison(current, prior, compare = 'yoy') {
  return field(buildStatementPayload({ market: 'HK', type: 'balance',
    rows: [row({ report_id: 2, bs_ta: 200, ...current }), row({ report_id: 1, bs_ta: 100, ...prior })],
    options: { compare }, canonicalCode: '00001.HK', formulaVersion: 'contract-test' }), 'bs.ta').values[0];
}
for (const [label, current, prior] of [
  ['不同来源', { source_id: 1 }, { source_id: 2 }],
  ['来源未知', { source_id: null }, { source_id: null }],
  ['重述标志', { update_flag: '1' }, { update_flag: '0' }],
  ['修订标志未知', { update_flag: null }, { update_flag: null }],
  ['公司不同', { company_id: 9 }, { company_id: 10 }],
  ['不同币种', { currency_code: 'USD' }, { currency_code: 'HKD' }],
  ['不同范围', { statement_scope: 'consolidated' }, { statement_scope: 'parent' }],
  ['报告类型未知', { period_type: 'unknown' }, { period_type: 'unknown' }],
]) {
  const value = balanceComparison({ period_end: '2025-06-30', ...current }, { period_end: '2024-06-30', ...prior });
  assert.strictEqual(value.change, null, `${label}不可计算同比`);
}
assert.strictEqual(balanceComparison({ period_end: '2025-09-30', period_type: 'q3' },
  { period_end: '2025-03-31', period_type: 'q1' }, 'qoq').change, null, '缺中报不得把一季与三季作为环比');
assert.strictEqual(balanceComparison({ period_end: '2025-09-30', period_type: 'q3' },
  { period_end: '2025-06-30', period_type: 'semiannual' }, 'qoq').change, 1, '相邻季度时点可比较');
assert.strictEqual(balanceComparison({ period_end: '2025-09-30', period_type: 'q3' },
  { period_end: '2025-06-15', period_type: 'semiannual' }, 'qoq').change, null, '日期不对齐不得算环比');
assert.strictEqual(balanceComparison({ period_end: '2025-06-30', bs_ta: -10 },
  { period_end: '2024-06-30', bs_ta: 100 }).comparison_reason, 'negative_comparison_unverified', '跨零口径未核实');
const ratioPayload = buildStatementPayload({ market: 'CN', type: 'balance', canonicalCode: '600000.SH',
  rows: [row({ period_end: '2025-06-30', bs_tl_ta_r: 0.5 }), row({ period_end: '2024-06-30', bs_tl_ta_r: 0.4 })] });
assert.strictEqual(field(ratioPayload, 'bs.tl_ta_r').values[0].change, null, '未经证实的比率比较公式不能冒充同比');

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
const flowYoy = buildStatementPayload({ market: 'CN', type: 'income', canonicalCode: '600000.SH', options: { compare: 'yoy' },
  rows: [row({ period_end: '2025-06-30', ps_tp: 3 }), row({ period_end: '2024-06-30', ps_tp: 2 })] });
assert.strictEqual(field(flowYoy, 'ps.tp').values[0].comparison_reason, 'flow_period_basis_unverified', '无起始日及重述口径不能断言累计值同比可比');

(async () => {
  let legacySql = '';
  await listStatementRows({
    tsCode: '000719.SZ', market: 'CN', type: 'balance', limit: 3,
    tx: { query: async (sql) => { legacySql = sql; return { rows: [] }; } },
  });
  assert.match(legacySql, /FROM fundamental\.financial_reports r/);
  assert.match(legacySql, /LEFT JOIN fundamental\.statement_balance_cas w/);
  assert.match(legacySql, /raw_payload->>'total_assets'/, '旧 A 股资产字段必须有受控回退');
  assert.match(legacySql, /COALESCE\(w\.ingested_at,r\.ingested_at\)/, '宽表修订时间必须参与版本摘要');
  const original = repository.listStatementRows;
  try {
    repository.listStatementRows = async () => [{ ...versionRow, statement_revision: '2026-11-12T12:00:00.000002' }];
    await assert.rejects(
      require('../services/stockStatementService').getStockStatements({ tsCode: '00001.HK', market: 'HK', type: 'balance', requestedVersion: version(versionRow.statement_revision) }),
      error => error.status === 409,
      '宽表修订后旧版本必须冲突'
    );
  } finally {
    repository.listStatementRows = original;
  }
  console.log('stock statements contract tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

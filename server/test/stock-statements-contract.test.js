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
    currency_code: 'HKD', source_currency: 'HKD', accounting_standard: 'HKFRS', source_id: 1, source_version: 'v1', update_flag: '0', comp_type: '1',
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

// 实源反例：HK 财报 currency=USD/CNY 时金额并非年报原币，不能贴原币标签展示。
for (const currency of ['USD', 'CNY', null]) {
  const unverified = buildStatementPayload({ market: 'HK', type: 'balance', canonicalCode: '00005.HK',
    rows: [row({ source_code: 'lixinger_official', currency_code: currency, bs_ta: 164219984400, bs_tl_ta_r: 0.5 })] });
  assert.strictEqual(field(unverified, 'bs.ta').values[0].value, null);
  assert.strictEqual(field(unverified, 'bs.ta').values[0].reason, 'source_currency_unverified');
  assert.strictEqual(field(unverified, 'bs.tl_ta_r').values[0].value, 50, '与币种无关的比例仍可显示');
}
const hkdStatement = buildStatementPayload({ market: 'HK', type: 'balance', canonicalCode: '00001.HK',
  rows: [row({ source_code: 'lixinger_official', currency_code: 'HKD', bs_ta: 100000000 })] });
assert.strictEqual(field(hkdStatement, 'bs.ta').values[0].value, 1, '港币报表不套用非港币保护');
const originalStatement = buildStatementPayload({ market: 'HK', type: 'balance', canonicalCode: '00005.HK',
  rows: [row({ source_code: 'lixinger_official', currency_code: 'USD', source_currency: 'USD', bs_ta: 3233034000000,
    statement_coverage: { value_basis: 'source_original_t_o' } })] });
assert.strictEqual(field(originalStatement, 'bs.ta').values[0].value, 32330.34);
assert.strictEqual(field(originalStatement, 'bs.ta').unit, 'USD·亿元');
const mismatchCurrency = buildStatementPayload({ market: 'HK', type: 'balance', canonicalCode: '00005.HK',
  rows: [row({ source_code: 'lixinger_official', currency_code: 'HKD', source_currency: 'USD', bs_ta: 100000000,
    statement_coverage: { value_basis: 'source_original_t_o' } })] });
assert.strictEqual(field(mismatchCurrency, 'bs.ta').values[0].value, null, '宽表币种与来源币种不一致时不能展示金额');
const missingSourceCurrency = buildStatementPayload({ market: 'HK', type: 'balance', canonicalCode: '00005.HK',
  rows: [row({ source_code: 'lixinger_official', currency_code: 'HKD', source_currency: null, bs_ta: 100000000 })] });
assert.strictEqual(field(missingSourceCurrency, 'bs.ta').values[0].value, null, '缺来源币种不能把主档默认币种当报告币种');
const noCurrency = buildStatementPayload({ market: 'HK', type: 'balance', canonicalCode: '00005.HK',
  rows: [row({ source_code: 'lixinger_official', currency_code: null, bs_ta: 100000000,
    statement_coverage: { value_basis: 'source_original_t_o' } })] });
assert.strictEqual(field(noCurrency, 'bs.ta').values[0].value, null, '原始值缺少币种仍不可展示金额');

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
  ['重述标志不一致', { update_flag: '1' }, { update_flag: '0' }],
  ['一期重述一期未知', { update_flag: '1' }, { update_flag: null }],
  ['两期均重述', { update_flag: '1' }, { update_flag: '1' }],
  ['非理杏仁来源两期均未知', { source_code: 'tushare', update_flag: null }, { source_code: 'tushare', update_flag: null }],
  ['理杏仁一期明确重述', { source_code: 'lixinger_official', update_flag: '1' }, { source_code: 'lixinger_official', update_flag: null }],
  ['公司不同', { company_id: 9 }, { company_id: 10 }],
  ['不同币种', { currency_code: 'USD' }, { currency_code: 'HKD' }],
  ['不同范围', { statement_scope: 'consolidated' }, { statement_scope: 'parent' }],
  ['报告类型未知', { period_type: 'unknown' }, { period_type: 'unknown' }],
]) {
  const value = balanceComparison({ period_end: '2025-06-30', ...current }, { period_end: '2024-06-30', ...prior });
  assert.strictEqual(value.change, null, `${label}不可计算同比`);
}
assert.strictEqual(balanceComparison(
  { period_end: '2025-06-30', source_code: 'lixinger_official', update_flag: null },
  { period_end: '2024-06-30', source_code: 'lixinger_official', update_flag: null }
).change, 1, '理杏仁官方同口径同报告期可计算同比');
assert.strictEqual(balanceComparison(
  { period_end: '2025-09-30', period_type: 'q3', source_code: 'lixinger_official', update_flag: null },
  { period_end: '2025-06-30', period_type: 'semiannual', source_code: 'lixinger_official', update_flag: null },
  'qoq'
).change, 1, '理杏仁官方相邻季度时点可计算环比');
// A-03: 港股基期币种与来源币种不一致时，不得把未核实基期当作同比分母
const unverifiedBaseYoy = buildStatementPayload({
  market: 'HK', type: 'balance', canonicalCode: '00005.HK', options: { compare: 'yoy' },
  rows: [
    row({ report_id: 2, period_end: '2025-06-30', source_code: 'lixinger_official', update_flag: null, currency_code: 'HKD', source_currency: 'HKD', bs_ta: 200 }),
  ],
  comparisonRows: [
    row({ report_id: 2, period_end: '2025-06-30', source_code: 'lixinger_official', update_flag: null, currency_code: 'HKD', source_currency: 'HKD', bs_ta: 200 }),
    row({ report_id: 1, period_end: '2024-06-30', source_code: 'lixinger_official', update_flag: null, currency_code: 'HKD', source_currency: 'USD', bs_ta: 100 }),
  ],
});
assert.strictEqual(field(unverifiedBaseYoy, 'bs.ta').values[0].change, null, '基期币种未核实时不得计算同比');
assert.strictEqual(field(unverifiedBaseYoy, 'bs.ta').values[0].comparison_reason, 'comparable_value_missing');
// A-05: 季报 + 环比筛选场景下，仍能通过 comparisonRows 找到所需的半年报/年报基期
const filteredQuarterQoq = buildStatementPayload({
  market: 'CN', type: 'balance', canonicalCode: '600000.SH', options: { periodType: 'quarter', compare: 'qoq' },
  rows: [
    row({ report_id: 3, period_end: '2025-09-30', period_type: 'q3', currency_code: 'CNY', source_currency: 'CNY', accounting_standard: 'CAS', source_code: 'lixinger_official', update_flag: null, bs_ta: 300 }),
    row({ report_id: 1, period_end: '2025-03-31', period_type: 'q1', currency_code: 'CNY', source_currency: 'CNY', accounting_standard: 'CAS', source_code: 'lixinger_official', update_flag: null, bs_ta: 150 }),
  ],
  comparisonRows: [
    row({ report_id: 3, period_end: '2025-09-30', period_type: 'q3', currency_code: 'CNY', source_currency: 'CNY', accounting_standard: 'CAS', source_code: 'lixinger_official', update_flag: null, bs_ta: 300 }),
    row({ report_id: 2, period_end: '2025-06-30', period_type: 'semiannual', currency_code: 'CNY', source_currency: 'CNY', accounting_standard: 'CAS', source_code: 'lixinger_official', update_flag: null, bs_ta: 200 }),
    row({ report_id: 1, period_end: '2025-03-31', period_type: 'q1', currency_code: 'CNY', source_currency: 'CNY', accounting_standard: 'CAS', source_code: 'lixinger_official', update_flag: null, bs_ta: 150 }),
    row({ report_id: 0, period_end: '2024-12-31', period_type: 'annual', currency_code: 'CNY', source_currency: 'CNY', accounting_standard: 'CAS', source_code: 'lixinger_official', update_flag: null, bs_ta: 100 }),
  ],
});
assert.strictEqual(field(filteredQuarterQoq, 'bs.ta').values[0].change, 0.5, '季报筛选下三季报环比应命中半年报基期');
assert.strictEqual(field(filteredQuarterQoq, 'bs.ta').values[1].change, 0.5, '季报筛选下一季报环比应命中上年年报基期');
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
const unavailableEquity = buildStatementPayload({ market: 'CN', type: 'balance', canonicalCode: '000001.SZ',
  rows: [row({ source_code: 'tushare', bs_tetshaoehopc: 551, bs_tetoshopc: null })], options: { compare: 'none' } });
assert.strictEqual(field(unavailableEquity, 'bs.tetoshopc').values[0].value, null, '不能隐藏普通股权益缺口');
assert.strictEqual(field(unavailableEquity, 'bs.tetoshopc').values[0].reason, 'source_mapping_unverified');
const unavailableDisposal = buildStatementPayload({ market: 'CN', type: 'income', canonicalCode: '000858.SZ',
  rows: [row({ source_code: 'tushare', ps_ncadarl: null })], options: { compare: 'none' } });
assert.strictEqual(field(unavailableDisposal, 'ps.ncadarl').values[0].reason, 'source_mapping_unverified');
const missingRedemption = buildStatementPayload({ market: 'CN', type: 'cashflow', canonicalCode: '000001.SZ',
  rows: [row({ source_code: 'tushare', cfs_crfii: 20, cfs_crfrci: null })], options: { compare: 'none' } });
assert.strictEqual(field(missingRedemption, 'cfs.crfrci').values[0].value, null, '未采集的收回投资要作为缺口保留');

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
assert.strictEqual(presentation.find(item => item.code === 'ps.oc').parent, null, '缺少类型证据时营业成本不能套用通用父项');
assert.strictEqual(sectionOf({ code: 'cfs.crfscapls', name: '销售商品提供劳务收到的现金' }, 'cashflow'), '经营活动现金流', '经营现金流明细不能落到补充资料');
assert.strictEqual(presentation.find(item => item.code === 'cfs.crfscapls').parent, null, '缺少类型证据时现金流明细不能套用通用父项');

const verifiedIncome = presentationOf([
  { code: 'ps.fe', name: '财务费用' },
  { code: 'ps.ieife', name: '利息费用', relation_contexts: ['CN|non_financial'] },
  { code: 'ps.crade', name: '资本化研发支出' },
  { code: 'ps.toc', name: '营业总成本' },
], 'income', 'CNY');
assert.strictEqual(verifiedIncome.find(item => item.code === 'ps.ieife').parent, 'ps.fe', '有来源上下文的财务费用明细应挂到财务费用');
assert.strictEqual(verifiedIncome.find(item => item.code === 'ps.crade').parent, null, '备注项目不能被猜成营业总成本子项');
assert.strictEqual(verifiedIncome.find(item => item.code === 'ps.crade').level, 0);

const unverifiedIncome = presentationOf([
  { code: 'ps.ivi', name: '投资收益' },
  { code: 'ps.iifaajv', name: '对联营企业及合营企业的投资收益', relation_contexts: ['CN|bank'] },
], 'income', 'CNY');
assert.strictEqual(unverifiedIncome.find(item => item.code === 'ps.iifaajv').parent, null, '未核验类型不能复用其他类型的投资收益父项');
const profitHierarchy = presentationOf([
  { code: 'ps.tp', name: '利润总额' },
  { code: 'ps.np', name: '净利润' },
  { code: 'ps.npatshaoehopc', name: '归属于母公司股东及其他权益持有者的净利润', relation_contexts: ['CN|non_financial'] },
  { code: 'ps.tci', name: '综合收益总额' },
], 'income', 'CNY');
assert.strictEqual(profitHierarchy.find(item => item.code === 'ps.npatshaoehopc').parent, null, '仅有发行人样本而缺来源类型合同的归母净利润应保持平级');
assert.strictEqual(profitHierarchy.find(item => item.code === 'ps.tci').parent, null, '综合收益总额不能挂到利润总额');

const unknownHints = presentationOf([
  { code: 'ps.toc', name: '营业总成本' },
  { code: 'ps.ie', name: '利息支出', relation_contexts: ['CN|unknown'] },
  { code: 'ps.oc', name: '营业成本', relation_contexts: ['CN|non_financial', 'CN|bank'] },
  { code: 'ps.example', name: '其中：其他费用', relation_contexts: ['CN|unknown'] },
], 'income', 'CNY');
for (const code of ['ps.ie', 'ps.oc', 'ps.example']) {
  assert.strictEqual(unknownHints.find(item => item.code === code).parent, null, `${code} 未获逐类型证据不得推断父项`);
}

const verifiedCashflow = presentationOf([
  { code: 'cfs.stcifia', name: '投资活动现金流入小计' },
  { code: 'cfs.ncrfdossajvaou', name: '处置子公司、合营联营企业等收到的现金净额', relation_contexts: ['CN|non_financial'] },
  { code: 'cfs.ncrfdossaou', name: '处置子公司或其他营业单位收到的现金净额', relation_contexts: ['CN|non_financial'] },
], 'cashflow', 'CNY');
assert.strictEqual(verifiedCashflow.find(item => item.code === 'cfs.ncrfdossajvaou').parent, 'cfs.stcifia');
assert.strictEqual(verifiedCashflow.find(item => item.code === 'cfs.ncrfdossaou').parent, 'cfs.ncrfdossajvaou');
assert.strictEqual(verifiedCashflow.find(item => item.code === 'cfs.ncrfdossaou').level, 2, '中间父项下的现金流明细必须展示二级层级');

const unverifiedCashflow = presentationOf([
  { code: 'cfs.stcifia', name: '投资活动现金流入小计' },
  { code: 'cfs.ncrfdossaou', name: '处置子公司或其他营业单位收到的现金净额', relation_contexts: ['CN|bank'] },
], 'cashflow', 'CNY');
assert.strictEqual(unverifiedCashflow.find(item => item.code === 'cfs.ncrfdossaou').parent, null, '银行类型未核验时不能直接挂投资流入小计');

const integratedCashflow = buildStatementPayload({
  market: 'CN', type: 'cashflow', options: { compare: 'none' }, canonicalCode: '600000.SH',
  rows: [row({ accounting_standard: 'CAS', currency_code: 'CNY', source_currency: 'CNY', source_code: 'lixinger_official',
    cfs_stcifia: 10, cfs_ncrfdossajvaou: 2, cfs_ncrfdossaou: 1,
    statement_coverage: { fs_table_type: 'non_financial', requested_metric_codes: ['cfs.stcifia', 'cfs.ncrfdossajvaou', 'cfs.ncrfdossaou'], returned_metric_codes: ['cfs.stcifia', 'cfs.ncrfdossajvaou', 'cfs.ncrfdossaou'], complete: true } })],
});
assert.strictEqual(field(integratedCashflow, 'cfs.ncrfdossajvaou').parent, 'cfs.stcifia', '服务层必须把报表类型上下文传给关系展示层');
assert.strictEqual(field(integratedCashflow, 'cfs.ncrfdossaou').parent, 'cfs.ncrfdossajvaou');
assert.strictEqual(field(integratedCashflow, 'cfs.ncrfdossaou').level, 2);
const filteredCashflow = buildStatementPayload({
  market: 'CN', type: 'cashflow', options: { compare: 'none' }, canonicalCode: '600000.SH',
  rows: [row({ source_code: 'lixinger_official', cfs_ncrfdossajvaou: 2, cfs_ncrfdossaou: 1,
    statement_coverage: { fs_table_type: 'non_financial', requested_metric_codes: ['cfs.ncrfdossajvaou', 'cfs.ncrfdossaou'], returned_metric_codes: ['cfs.ncrfdossajvaou', 'cfs.ncrfdossaou'], complete: true } })],
});
assert.strictEqual(field(filteredCashflow, 'cfs.ncrfdossajvaou').parent, null, '父项被过滤时保留字段且安全提升');
assert.strictEqual(field(filteredCashflow, 'cfs.ncrfdossajvaou').level, 0);
assert.strictEqual(field(filteredCashflow, 'cfs.ncrfdossaou').parent, 'cfs.ncrfdossajvaou');
assert.strictEqual(field(filteredCashflow, 'cfs.ncrfdossaou').level, 1, '提升父项后重新计算子项深度');
const mixedTypeCashflow = buildStatementPayload({
  market: 'CN', type: 'cashflow', options: { compare: 'none' }, canonicalCode: '600000.SH',
  rows: [
    row({ accounting_standard: 'CAS', currency_code: 'CNY', source_currency: 'CNY', source_code: 'lixinger_official',
      cfs_stcifia: 10, cfs_ncrfdossajvaou: 2, cfs_ncrfdossaou: 1,
      statement_coverage: { fs_table_type: 'non_financial', requested_metric_codes: ['cfs.stcifia', 'cfs.ncrfdossajvaou', 'cfs.ncrfdossaou'], returned_metric_codes: ['cfs.stcifia', 'cfs.ncrfdossajvaou', 'cfs.ncrfdossaou'], complete: true } }),
    row({ cfs_stcifia: 8, cfs_ncrfdossajvaou: 1, cfs_ncrfdossaou: 1 }),
  ],
});
assert.strictEqual(field(mixedTypeCashflow, 'cfs.ncrfdossaou').parent, null, '混有未知报表类型时必须关闭已核验关系');

const mixedKnownIncome = buildStatementPayload({
  market: 'CN', type: 'income', options: { compare: 'none' }, canonicalCode: '600000.SH',
  rows: [
    row({ source_code: 'lixinger_official', ps_fe: 10, ps_ieife: 1, statement_coverage: { fs_table_type: 'non_financial', requested_metric_codes: ['ps.fe', 'ps.ieife'], returned_metric_codes: ['ps.fe', 'ps.ieife'], complete: true } }),
    row({ source_code: 'lixinger_official', ps_fe: 5, statement_coverage: { fs_table_type: 'bank', requested_metric_codes: ['ps.fe'], returned_metric_codes: ['ps.fe'], complete: true } }),
  ],
});
assert.strictEqual(field(mixedKnownIncome, 'ps.ieife').parent, null, '另一报告期类型未列此字段时也必须参与关系门禁');
const otherSourceIncome = buildStatementPayload({
  market: 'CN', type: 'income', options: { compare: 'none' }, canonicalCode: '600000.SH',
  rows: [row({ source_code: 'other', ps_fe: 10, ps_ieife: 1,
    statement_coverage: { fs_table_type: 'non_financial', requested_metric_codes: ['ps.fe', 'ps.ieife'], returned_metric_codes: ['ps.fe', 'ps.ieife'], complete: true } })],
});
assert.strictEqual(field(otherSourceIncome, 'ps.ieife').parent, null, '其他来源不能继承理杏仁的已核验层级');

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
  rows: [
    row({ report_id: 2, period_end: '2025-06-30', currency_code: 'CNY', accounting_standard: 'CAS', source_code: 'lixinger_official', update_flag: null, ps_tp: 3 }),
    row({ report_id: 1, period_end: '2024-06-30', currency_code: 'CNY', accounting_standard: 'CAS', source_code: 'lixinger_official', update_flag: null, ps_tp: 2 }),
  ] });
assert.strictEqual(field(flowYoy, 'ps.tp').values[0].yoy, 0.5, '同口径同报告期的累计流量表应可计算同比');
assert.strictEqual(field(flowYoy, 'ps.tp').values[0].comparison_status, 'available');
const flowUnverifiedSource = buildStatementPayload({ market: 'CN', type: 'income', canonicalCode: '600000.SH', options: { compare: 'yoy' },
  rows: [
    row({ report_id: 2, period_end: '2025-06-30', source_code: 'other', update_flag: '0', ps_tp: 3 }),
    row({ report_id: 1, period_end: '2024-06-30', source_code: 'other', update_flag: '0', ps_tp: 2 }),
  ] });
assert.strictEqual(field(flowUnverifiedSource, 'ps.tp').values[0].yoy, null, '缺少可信来源/期间证据时流量表不得计算同比');
assert.strictEqual(field(flowUnverifiedSource, 'ps.tp').values[0].comparison_reason, 'flow_period_basis_unverified');
const flowHkNoFy = buildStatementPayload({ market: 'HK', type: 'income', canonicalCode: '00001.HK', options: { compare: 'yoy' },
  rows: [
    row({ report_id: 2, period_end: '2025-06-30', fiscal_year: null, source_code: 'lixinger_official', update_flag: null, ps_tp: 3 }),
    row({ report_id: 1, period_end: '2024-06-30', fiscal_year: null, source_code: 'lixinger_official', update_flag: null, ps_tp: 2 }),
  ] });
assert.strictEqual(field(flowHkNoFy, 'ps.tp').values[0].comparison_reason, 'flow_period_basis_unverified', '港股两期均无财年证据时流量表不得计算同比');
const flowDiffStart = buildStatementPayload({ market: 'CN', type: 'cashflow', canonicalCode: '600000.SH', options: { compare: 'yoy' },
  rows: [
    row({ report_id: 2, period_end: '2025-06-30', period_start: '2025-04-01', currency_code: 'CNY', accounting_standard: 'CAS', source_code: 'lixinger_official', update_flag: null, cfs_ncffoa: 3 }),
    row({ report_id: 1, period_end: '2024-06-30', period_start: '2024-01-01', currency_code: 'CNY', accounting_standard: 'CAS', source_code: 'lixinger_official', update_flag: null, cfs_ncffoa: 2 }),
  ] });
assert.strictEqual(field(flowDiffStart, 'cfs.ncffoa').values[0].comparison_reason, 'flow_period_basis_unverified', '累计起始日不同时流量表不得计算同比');
const flowCnCasYoy = buildStatementPayload({ market: 'CN', type: 'income', canonicalCode: '600000.SH', options: { compare: 'yoy' },
  rows: [
    row({ report_id: 2, period_end: '2025-06-30', currency_code: 'CNY', accounting_standard: 'CAS', fiscal_year: null, source_code: 'lixinger_official', update_flag: null, ps_tp: 3 }),
    row({ report_id: 1, period_end: '2024-06-30', currency_code: 'CNY', accounting_standard: 'CAS', fiscal_year: null, source_code: 'lixinger_official', update_flag: null, ps_tp: 2 }),
  ] });
assert.strictEqual(field(flowCnCasYoy, 'ps.tp').values[0].yoy, 0.5, 'A股法定自然年CAS官方流量表应可计算同比');
const flowMismatchFy = buildStatementPayload({ market: 'HK', type: 'cashflow', canonicalCode: '00001.HK', options: { compare: 'yoy' },
  rows: [
    row({ report_id: 2, period_end: '2025-06-30', fiscal_year: '2025', source_code: 'lixinger_official', update_flag: null, cfs_ncffoa: 3 }),
    row({ report_id: 1, period_end: '2024-06-30', fiscal_year: null, source_code: 'lixinger_official', update_flag: null, cfs_ncffoa: 2 }),
  ] });
assert.strictEqual(field(flowMismatchFy, 'cfs.ncffoa').values[0].comparison_reason, 'flow_period_basis_unverified', '财年证据缺失时流量表不得计算同比');
// A-02: 港股仅有连续财年编号但缺少 period_start 期间证据时，不得计算同比；补齐一致 period_start 后正常可比
const hkFlowOnlyFy = buildStatementPayload({ market: 'HK', type: 'income', canonicalCode: '00001.HK', options: { compare: 'yoy' },
  rows: [
    row({ report_id: 2, period_end: '2025-06-30', fiscal_year: '2025', period_start: null, source_code: 'lixinger_official', update_flag: null, ps_tp: 3 }),
    row({ report_id: 1, period_end: '2024-06-30', fiscal_year: '2024', period_start: null, source_code: 'lixinger_official', update_flag: null, ps_tp: 2 }),
  ] });
assert.strictEqual(field(hkFlowOnlyFy, 'ps.tp').values[0].comparison_reason, 'flow_period_basis_unverified', '港股缺少 period_start 时仅凭连续财年不得算同比');
const hkFlowValid = buildStatementPayload({ market: 'HK', type: 'cashflow', canonicalCode: '00001.HK', options: { compare: 'yoy' },
  rows: [
    row({ report_id: 2, period_end: '2025-06-30', period_start: '2025-01-01', fiscal_year: '2025', source_code: 'lixinger_official', update_flag: null, cfs_ncffoa: 3 }),
    row({ report_id: 1, period_end: '2024-06-30', period_start: '2024-01-01', fiscal_year: '2024', source_code: 'lixinger_official', update_flag: null, cfs_ncffoa: 2 }),
  ] });
assert.strictEqual(field(hkFlowValid, 'cfs.ncffoa').values[0].yoy, 0.5, '港股具备连续财年与一致 period_start 时可算同比');
// A-02: 非法日历日期（2月30日）或起始日在期末之后时不得计算同比
const invalidCalendarStart = buildStatementPayload({ market: 'HK', type: 'income', canonicalCode: '00001.HK', options: { compare: 'yoy' },
  rows: [
    row({ report_id: 2, period_end: '2025-06-30', period_start: '2025-02-30', fiscal_year: '2025', source_code: 'lixinger_official', update_flag: null, ps_tp: 3 }),
    row({ report_id: 1, period_end: '2024-06-30', period_start: '2024-02-30', fiscal_year: '2024', source_code: 'lixinger_official', update_flag: null, ps_tp: 2 }),
  ] });
assert.strictEqual(field(invalidCalendarStart, 'ps.tp').values[0].comparison_reason, 'flow_period_basis_unverified', '非法日历起始日不得算同比');
const startAfterEnd = buildStatementPayload({ market: 'HK', type: 'cashflow', canonicalCode: '00001.HK', options: { compare: 'yoy' },
  rows: [
    row({ report_id: 2, period_end: '2025-06-30', period_start: '2025-07-01', fiscal_year: '2025', source_code: 'lixinger_official', update_flag: null, cfs_ncffoa: 3 }),
    row({ report_id: 1, period_end: '2024-06-30', period_start: '2024-07-01', fiscal_year: '2024', source_code: 'lixinger_official', update_flag: null, cfs_ncffoa: 2 }),
  ] });
assert.strictEqual(field(startAfterEnd, 'cfs.ncffoa').values[0].comparison_reason, 'flow_period_basis_unverified', '起始日在期末之后不得算同比');
// A-06: 当前累计报告有效但缺少上年同期时，应返回 insufficient_history / comparable_period_missing（而非期间口径待核实）
const singleValidFlow = buildStatementPayload({ market: 'CN', type: 'income', canonicalCode: '600000.SH', options: { compare: 'yoy' },
  rows: [
    row({ report_id: 2, period_end: '2025-06-30', period_start: '2025-01-01', fiscal_year: '2025', currency_code: 'CNY', accounting_standard: 'CAS', source_code: 'lixinger_official', update_flag: null, ps_tp: 3 }),
  ] });
assert.strictEqual(field(singleValidFlow, 'ps.tp').values[0].comparison_status, 'insufficient_history');
assert.strictEqual(field(singleValidFlow, 'ps.tp').values[0].comparison_reason, 'comparable_period_missing');

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
  const { statementApiFields } = require('../services/stockStatements');
  const cashFields = statementApiFields('cashflow').split(',');
  assert.ok(cashFields.includes('c_disp_withdrwl_invest') && cashFields.includes('c_recp_return_invest'), '两类投资现金流都必须请求');
  const { pool } = require('../db/connection');
  try {
    const database = await pool.query('SELECT current_database() AS name');
    assert.match(database.rows[0].name, /(^|_)(test|migtest)(_|$)/i, '只允许在隔离测试库核对 SQL');
    const expressions = ['cfs.crfrci', 'cfs.crfii', 'bs.tetoshopc', 'bs.tetshaoehopc', 'ps.npatoshopc', 'ps.npatshaoehopc', 'ps.tciatoshopc', 'ps.tciatshaoehopc', 'ps.toc', 'ps.ncadarl', 'cfs.ioa']
      .map(code => repository.legacyMetricExpression({ code })).join(',');
    const sql = `WITH w AS (SELECT 999::numeric AS cfs_crfrci, 999::numeric AS cfs_crfii,
      999::numeric AS bs_tetoshopc, 999::numeric AS bs_tetshaoehopc, 999::numeric AS ps_npatoshopc,
      999::numeric AS ps_npatshaoehopc, 999::numeric AS ps_tciatoshopc, 999::numeric AS ps_tciatshaoehopc,
      999::numeric AS ps_toc, 999::numeric AS ps_ncadarl, 999::numeric AS cfs_ioa),
      r AS (SELECT $1::jsonb AS raw_payload), i AS (SELECT 'CN'::text AS market), ds AS (SELECT $2::text AS source_code)
      SELECT ${expressions} FROM w,r,i,ds`;
    const raw = { c_disp_withdrwl_invest: 100, c_recp_return_invest: 20, total_hldr_eqy_exc_min_int: 551,
      n_income_attr_p: 42, compr_inc_attr_p: 40, nca_disploss: 1658018.71 };
    const original = (await pool.query(sql, [JSON.stringify(raw), 'tushare'])).rows[0];
    assert.strictEqual(Number(original.cfs_crfrci), 100, '收回投资不得错用投资收益');
    assert.strictEqual(Number(original.cfs_crfii), 20, '投资收益应读原始对应字段');
    assert.strictEqual(original.bs_tetoshopc, null, '含其他权益的归母权益不能当普通股权益');
    assert.strictEqual(Number(original.bs_tetshaoehopc), 551);
    assert.strictEqual(original.ps_npatoshopc, null, '归母净利润不能无依据冒充归母普通股净利润');
    assert.strictEqual(Number(original.ps_npatshaoehopc), 42);
    assert.strictEqual(original.ps_tciatoshopc, null, '归母综合收益不能无依据冒充普通股综合收益');
    assert.strictEqual(Number(original.ps_tciatshaoehopc), 40);
    assert.strictEqual(original.ps_toc, null, '不同来源口径未核实时不能沿用旧宽表');
    assert.strictEqual(original.ps_ncadarl, null, '处置净损失不能冒充毁损报废损失');
    assert.strictEqual(original.cfs_ioa, null, '减值准备口径未核实时不能沿用旧宽表');
    const missing = (await pool.query(sql, [JSON.stringify({ c_recp_return_invest: 20 }), 'tushare'])).rows[0];
    assert.strictEqual(missing.cfs_crfrci, null, '正确字段缺失时不能回用错写宽表');
    const official = (await pool.query(sql, [JSON.stringify(raw), 'lixinger_official'])).rows[0];
    assert.strictEqual(Number(official.cfs_crfrci), 999, '官方宽表不能被旧来源原始字段覆盖');
    assert.strictEqual(Number(official.bs_tetoshopc), 999);
    assert.strictEqual(Number(official.ps_ncadarl), 999, '正确来源的毁损报废损失仍可读取');

    const selection = require('../repositories/stockSelectionRepository');
    const factSql = `WITH r AS (SELECT jsonb_build_object('ts_code',$1::text,'currency',$2::text,
      '__statement_coverage',jsonb_build_object('value_basis',$4::text)) AS raw_payload,
      (SELECT source_id FROM ops.data_sources WHERE source_code=$3) AS source_id, NULL::bigint AS company_id),
      f AS (SELECT 123::numeric AS numeric_value, $2::text AS currency_code)
      SELECT ${selection.SAFE_FINANCIAL_FACT_SQL} AS value FROM r,f`;
    for (const [code, currency, source, expected, basis] of [
      ['00005.HK', 'USD', 'lixinger_official', null, null],
      ['00386.HK', 'CNY', 'lixinger_official', null, null],
      ['00005.HK', null, 'lixinger_official', null, null],
      ['00001.HK', 'HKD', 'lixinger_official', 123, null],
      ['000001.SZ', 'CNY', 'lixinger_official', 123, null],
      ['00005.HK', 'USD', 'tushare', 123, null],
      ['00005.HK', 'USD', 'lixinger_official', 123, 'source_original_t_o'],
      ['00386.HK', 'CNY', 'lixinger_official', 123, 'source_original_t_o'],
      ['00005.HK', null, 'lixinger_official', null, 'source_original_t_o'],
    ]) {
      const value = (await pool.query(factSql, [code, currency, source, basis])).rows[0].value;
      assert.strictEqual(value === null ? null : Number(value), expected, `${code}/${currency}/${source} 选股币种保护`);
    }
    const selectionSql = [];
    const tx = { query: async text => { selectionSql.push(text); return { rows: [] }; } };
    await selection.loadUniverse({ market: 'HK', asOfDate: '2026-11-01' }, tx);
    await selection.loadEquityFacts({ companyIds: [1], asOfDate: '2026-11-01' }, tx);
    await selection.loadAnnualProfits({ companyIds: [1], asOfDate: '2026-11-01' }, tx);
    await selection.loadTtmInputs({ companyIds: [1], asOfDate: '2026-11-01' }, tx);
    assert.strictEqual(selectionSql.length, 4);
    for (const statement of selectionSql) assert.ok(statement.includes(selection.SAFE_FINANCIAL_FACT_SQL), '所有选股事实读取均需币种保护');
    assert.strictEqual(selectionSql[0].split(selection.SAFE_FINANCIAL_FACT_SQL).length - 1, 2, 'PB 与静态 PE 两个分母都需保护');
    const rules = require('../domain/stockSelectionRules');
    const equity = rules.evaluateEquity({ equity: { amount: null, currency: 'USD', currencyUnverified: true },
      annual: { years: [] } }, rules.DEFAULT_PARAMS);
    assert.strictEqual(equity.rule.status, 'PENDING', '来源币种未核实不能当成无财报或正常值');
    assert.strictEqual(equity.rule.reason, 'source_currency_unverified');
    const ttm = require('../services/stockSelectionService').computeTtmFromReports([
      { periodEnd: '2025-12-31', netProfit: null, currencyUnverified: true },
      { periodEnd: '2024-12-31', netProfit: 100, currency: 'HKD', periodType: 'annual' },
    ]);
    assert.strictEqual(ttm.value, null, 'TTM 不得跳过来源币种未知的最新报告而回退旧值');
    assert.strictEqual(ttm.reason, 'source_currency_unverified');
    const stockSelectionService = require('../services/stockSelectionService');
    const unknownTtm = stockSelectionService.computeTtmFromReports([
      { periodEnd: '2026-06-30', periodType: 'semiannual', netProfit: 60, currency: 'CNY' },
      { periodEnd: '2025-12-31', periodType: 'annual', netProfit: 100, currency: null },
      { periodEnd: '2025-06-30', periodType: 'semiannual', netProfit: 40, currency: 'CNY' },
    ]);
    assert.strictEqual(unknownTtm.reason, 'ttm_currency_unknown');
    const profits = Array.from({ length: 11 }, (_, index) => ({ year: 2015 + index, profit: 100,
      currency: index === 0 ? 'HKD' : 'USD' }));
    const annual = stockSelectionService.annualFactsOf(profits, [], '00386.HK', null, '2000-01-01');
    const anomaly = rules.evaluateAnnualAnomaly({ ...annual, market: 'HK' });
    assert.strictEqual(anomaly.status, rules.STATUS.NOT_APPLICABLE);
    assert.strictEqual(anomaly.reason, 'annual_profit_currency_mismatch', '跨币种年度利润不能直接求和');
    assert.strictEqual(anomaly.profitY, 100);
    assert.strictEqual(anomaly.profitSum, null);
    assert.strictEqual(anomaly.currency, 'USD', '最新年报金额保留美元标识，不沿用最早一期币种');
    assert.deepStrictEqual(annual.years.map(({ profitCurrency }) => profitCurrency),
      ['HKD', ...Array(10).fill('USD')], '逐年保留年报原币');
    assert.strictEqual(rules.evaluateAnnualAnomaly({ ...annual, market: 'CN' }).status, rules.STATUS.PENDING);
    const unknownAnnual = stockSelectionService.annualFactsOf(profits.map(item => ({ ...item, currency: null })), [], '00386.HK', null, '2000-01-01');
    assert.strictEqual(rules.evaluateAnnualAnomaly({ ...unknownAnnual, market: 'HK' }).reason, 'annual_profit_currency_unknown');
    const usdProfits = profits.map(item => ({ ...item, currency: 'USD', profit: item.year === 2025 ? 1100 : 100 }));
    const usd = rules.evaluateAnnualAnomaly({
      ...stockSelectionService.annualFactsOf(usdProfits, [], '00386.HK', null, '2000-01-01'), market: 'HK',
    });
    assert.strictEqual(usd.reason, 'profit_exceed_decade', '同为美元的十一期利润可直接比较');
    assert.strictEqual(usd.profitSum, 1000);
    assert.strictEqual(usd.currency, 'USD');
    const sameProfits = profits.map(item => ({ ...item, currency: 'CNY' }));
    const dividends = sameProfits.map((item, index) => ({ year: item.year, dividend: 1, dividendKnown: true,
      dividendCurrencies: [index === 0 ? 'HKD' : 'CNY'], dividendCurrencyUnknown: false }));
    const mixedDividends = stockSelectionService.annualFactsOf(sameProfits, dividends, '00386.HK', null, '2000-01-01');
    const dividendAnomaly = rules.evaluateAnnualAnomaly({ ...mixedDividends, market: 'HK' });
    assert.strictEqual(dividendAnomaly.reason, 'annual_dividend_currency_mismatch');
    assert.strictEqual(dividendAnomaly.status, rules.STATUS.NOT_APPLICABLE);
    assert.strictEqual(dividendAnomaly.dividendSum, null);
    assert.strictEqual(rules.evaluateAnnualAnomaly({ ...mixedDividends, market: 'CN' }).status, rules.STATUS.PENDING);
    dividends[0].dividendCurrencies = [];
    const unknownDividends = stockSelectionService.annualFactsOf(sameProfits, dividends, '00386.HK', null, '2000-01-01');
    assert.strictEqual(rules.evaluateAnnualAnomaly({ ...unknownDividends, market: 'HK' }).reason, 'annual_dividend_currency_unknown');
    dividends[0].dividend = 0;
    const zeroDividend = stockSelectionService.annualFactsOf(sameProfits, dividends, '00386.HK', null, '2000-01-01');
    assert.strictEqual(rules.evaluateAnnualAnomaly({ ...zeroDividend, market: 'HK' }).status, rules.STATUS.PASS, '零分红不需要币种换算');
  } finally {
    await pool.end();
  }
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
  // A 股历史报告没有 __statement_coverage：按公司行业分类保守推断报表类型（2026-11-16）
  const { inferTableTypeFromIndustry } = require('../domain/statementPresentation');
  assert.strictEqual(inferTableTypeFromIndustry('CN', ['白酒']), 'non_financial', '非金融行业推断为非金融');
  assert.strictEqual(inferTableTypeFromIndustry('CN', ['白酒Ⅲ']), 'non_financial', '带分类后缀的非金融行业仍推断为非金融');
  assert.strictEqual(inferTableTypeFromIndustry('CN', ['银行']), 'bank', '银行行业推断为银行口径');
  assert.strictEqual(inferTableTypeFromIndustry('CN', ['国有大型银行Ⅲ']), 'bank', '带后缀的银行写法也必须识别为银行，不得落到非金融');
  assert.strictEqual(inferTableTypeFromIndustry('CN', ['保险']), 'insurance');
  assert.strictEqual(inferTableTypeFromIndustry('CN', ['证券']), 'security');
  assert.strictEqual(inferTableTypeFromIndustry('CN', ['多元金融']), 'other_financial');
  assert.strictEqual(inferTableTypeFromIndustry('CN', []), null, '缺行业不得推断');
  assert.strictEqual(inferTableTypeFromIndustry('CN', ['白酒', '银行']), null, '报告期行业不一致不得推断');
  assert.strictEqual(inferTableTypeFromIndustry('HK', ['白酒']), null, '推断只用于 A 股');

  function cnRow(overrides) {
    return Object.assign({
      report_id: 30, company_id: 31, period_end: '2025-12-31', period_type: 'annual',
      currency_code: 'CNY', source_currency: 'CNY', accounting_standard: 'CAS', source_id: 3,
      source_version: 'v1', update_flag: null, comp_type: '1', statement_scope: 'consolidated',
      announced_at: '2026-03-20', source_code: 'lixinger_official',
      statement_coverage: null, industry: null,
      bs_nraar: null, bs_nr: null, bs_ar: null,
    }, overrides);
  }
  const cnPayloadOf = rows => buildStatementPayload({ market: 'CN', type: 'balance', rows, canonicalCode: '600519.SH' });

  const nonFinancial = cnPayloadOf([
    cnRow({ report_id: 32, period_end: '2024-12-31', industry: '白酒', bs_nraar: 150, bs_nr: 90, bs_ar: 60 }),
    cnRow({ report_id: 31, period_end: '2025-12-31', industry: '白酒', bs_nraar: 180, bs_nr: 110, bs_ar: 70 }),
  ]);
  assert.strictEqual(field(nonFinancial, 'bs.nr').level, 1, 'A 股非金融按行业推断后应收票据应缩进一级');
  assert.strictEqual(field(nonFinancial, 'bs.nr').parent, 'bs.nraar', '父项必须指向应收票据及应收账款');

  const bank = cnPayloadOf([
    cnRow({ report_id: 34, period_end: '2025-12-31', industry: '银行', bs_nraar: 180, bs_nr: 110, bs_ar: 70 }),
  ]);
  assert.strictEqual(field(bank, 'bs.nr').level, 0, '银行不得套用非金融父子关系');

  const noIndustry = cnPayloadOf([
    cnRow({ report_id: 35, period_end: '2025-12-31', industry: null, bs_nraar: 180, bs_nr: 110, bs_ar: 70 }),
  ]);
  assert.strictEqual(field(noIndustry, 'bs.nr').level, 0, '行业缺失时必须保持平级');

  const mixedType = cnPayloadOf([
    cnRow({ report_id: 36, period_end: '2025-12-31', industry: '白酒', statement_coverage: { fs_table_type: 'non_financial' }, bs_nraar: 180, bs_nr: 110, bs_ar: 70 }),
    cnRow({ report_id: 37, period_end: '2024-12-31', industry: '白酒', bs_nraar: 150, bs_nr: 90, bs_ar: 60 }),
  ]);
  assert.strictEqual(field(mixedType, 'bs.nr').level, 0, '已有类型却混有未知期时不得用行业补齐');

  // 混来源：报告期分别来自理杏仁与 Tushare 时，展示结构仍适用（金额可信度另由来源白名单处理）
  const mixedSource = cnPayloadOf([
    cnRow({ report_id: 38, period_end: '2025-12-31', industry: '白酒', bs_nraar: 180, bs_nr: 110, bs_ar: 70 }),
    cnRow({ report_id: 39, period_end: '2024-12-31', industry: '白酒', source_code: 'tushare', bs_nraar: 150, bs_nr: 90, bs_ar: 60 }),
  ]);
  assert.strictEqual(field(mixedSource, 'bs.nr').level, 1, '混来源不应否定字典级展示结构');

  // 来源只决定金额口径（Tushare 历史金额由 UNVERIFIED_TUSHARE_WIDE 单独屏蔽），不参与展示结构
  const onlyTushare = cnPayloadOf([
    cnRow({ report_id: 40, period_end: '2025-12-31', industry: '白酒', source_code: 'tushare', bs_nraar: 180, bs_nr: 110, bs_ar: 70 }),
  ]);
  assert.strictEqual(field(onlyTushare, 'bs.nr').level, 1, '纯 Tushare 历史表格仍按字典展示层级，金额另由来源白名单屏蔽');

  // 新版 presentation 结构、33 组目录覆盖、代表行合并、冲突降级与候选不升格（2026-11-23）
  const cnTypes = ['non_financial', 'bank', 'insurance', 'security', 'other_financial'];
  const hkTypes = [...cnTypes, 'reit'];
  let totalRuleCount = 0;
  for (const [m, tList] of [['CN', cnTypes], ['HK', hkTypes]]) {
    for (const t of tList) {
      const list = dict.metricsOfType(m, t);
      totalRuleCount += list.length;
      for (const item of list) {
        assert.ok(item.hierarchy_rule && item.hierarchy_rule.group_path && item.hierarchy_rule.rule_version,
          `${m}|${t}|${item.code} 必须存在版本化层级规则`);
      }
    }
  }
  assert.strictEqual(totalRuleCount, 2243, '11 类 × 3 表共 2,243 条目录记录必须全覆盖');

  const zeroRepPayload = buildStatementPayload({
    market: 'CN', type: 'balance', options: { compare: 'none' }, canonicalCode: '600519.SH',
    rows: [cnRow({
      report_id: 50, period_end: '2025-12-31', industry: '白酒',
      bs_ta: 0, bs_tca: 100, bs_nraar: 50, bs_nr: 20, bs_ar: 30,
    })],
  });
  assert.ok(zeroRepPayload.presentation && Array.isArray(zeroRepPayload.presentation.rows), '响应必须包含 presentation.rows');
  const pRow = code => zeroRepPayload.presentation.rows.find(r => r.kind === 'field' && r.code === code);
  assert.strictEqual(pRow('bs.ta').depth, 0);
  assert.strictEqual(pRow('bs.ta').row_role, 'total');
  assert.strictEqual(pRow('bs.ta').is_group_rep, true, '0 值代表行应合并为分组首行');
  assert.strictEqual(pRow('bs.tca').depth, 1);
  assert.strictEqual(pRow('bs.tca').row_role, 'subtotal');
  assert.strictEqual(pRow('bs.tca').is_group_rep, true);
  assert.strictEqual(pRow('bs.nraar').depth, 2);
  assert.strictEqual(pRow('bs.nraar').row_role, 'subtotal', '有经核子项的组合项应升为 subtotal');
  assert.strictEqual(pRow('bs.nr').depth, 3);
  assert.strictEqual(pRow('bs.nr').row_role, 'detail');
  assert.strictEqual(pRow('bs.nr').parent_code, 'bs.nraar');

  // 代表行无可用金额时保留独立 section 标题与原字段状态
  const missingRepPayload = buildStatementPayload({
    market: 'CN', type: 'balance', options: { compare: 'none' }, canonicalCode: '600519.SH',
    rows: [cnRow({
      report_id: 51, period_end: '2025-12-31', industry: '白酒',
      bs_ta: null, bs_tca: 100,
      statement_coverage: { fs_table_type: 'non_financial', requested_metric_codes: ['bs.ta', 'bs.tca'], returned_metric_codes: ['bs.tca'], complete: true },
    })],
  });
  assert.ok(missingRepPayload.presentation.rows.some(r => r.kind === 'section' && r.label === '资产' && r.depth === 0),
    '代表行无可用金额时必须保留独立分组标题');
  assert.strictEqual(field(missingRepPayload, 'bs.ta').values[0].status, 'source_not_disclosed');

  // 港股证券核验关系（2026-11-23）
  const hkSecIncome = buildStatementPayload({
    market: 'HK', type: 'income', options: { compare: 'none' }, canonicalCode: '02611.HK',
    rows: [row({
      report_id: 60, source_code: 'lixinger_official', currency_code: 'HKD', source_currency: 'HKD',
      ps_nii: 100, ps_ii: 150, ps_ie: -50, ps_iifaajv: 20, ps_iifa: 12, ps_iifjv: 8,
      statement_coverage: { fs_table_type: 'security', requested_metric_codes: ['ps.nii', 'ps.ii', 'ps.ie', 'ps.iifaajv', 'ps.iifa', 'ps.iifjv'], returned_metric_codes: ['ps.nii', 'ps.ii', 'ps.ie', 'ps.iifaajv', 'ps.iifa', 'ps.iifjv'], complete: true },
    })],
  });
  const hkSecRow = code => hkSecIncome.presentation.rows.find(r => r.kind === 'field' && r.code === code);
  assert.strictEqual(hkSecRow('ps.ii').parent_code, 'ps.nii');
  assert.strictEqual(hkSecRow('ps.ii').row_role, 'detail');
  assert.strictEqual(hkSecRow('ps.iifa').parent_code, 'ps.iifaajv');

  // 候选与仅样本不得误升格
  const bankCandidate = buildStatementPayload({
    market: 'CN', type: 'balance', options: { compare: 'none' }, canonicalCode: '000001.SZ',
    rows: [cnRow({
      report_id: 70, industry: '银行', bs_dfbaofi: 10, bs_p_pf: 100, bs_tlaatc: 120,
      statement_coverage: { fs_table_type: 'bank', requested_metric_codes: ['bs.dfbaofi', 'bs.p_pf', 'bs.tlaatc'], returned_metric_codes: ['bs.dfbaofi', 'bs.p_pf', 'bs.tlaatc'], complete: true },
    })],
  });
  const bankCandidateRow = code => bankCandidate.presentation.rows.find(r => r.kind === 'field' && r.code === code);
  assert.strictEqual(bankCandidateRow('bs.dfbaofi').parent_code, null, '候选关系不得误升格为已核父项');
  assert.strictEqual(bankCandidateRow('bs.dfbaofi').relation_status, 'candidate');
  assert.strictEqual(bankCandidateRow('bs.p_pf').parent_code, null, '发行人样本未命中特定报告时不自动启用父项');
  assert.strictEqual(bankCandidateRow('bs.p_pf').relation_status, 'issuer_sample_unmatched');

  // 混类型分组冲突降级到「其他已披露科目」
  const groupConflict = buildStatementPayload({
    market: 'CN', type: 'balance', options: { compare: 'none' }, canonicalCode: '600000.SH',
    rows: [
      cnRow({ report_id: 80, bs_cabb: 10, statement_coverage: { fs_table_type: 'non_financial', requested_metric_codes: ['bs.cabb'], returned_metric_codes: ['bs.cabb'], complete: true } }),
      cnRow({ report_id: 81, bs_cabb: 8, statement_coverage: { fs_table_type: 'security', requested_metric_codes: ['bs.cabb'], returned_metric_codes: ['bs.cabb'], complete: true } }),
    ],
  });
  const conflictRow = groupConflict.presentation.rows.find(r => r.kind === 'field' && r.code === 'bs.cabb');
  assert.strictEqual(conflictRow.group_id, 'group:其他已披露科目', '跨类型分组不一致时必须降级到其他已披露科目');
  assert.strictEqual(conflictRow.relation_status, 'group_conflict');

  // 旧 fields 保持原 section/parent 兼容，同时混合准则或混合口径时 presentation 降级为平列
  assert.strictEqual(field(zeroRepPayload, 'bs.ta').section, '资产总计', '旧 fields 必须保留原来源分组');
  const mixedScope = buildStatementPayload({
    market: 'CN', type: 'income', options: { compare: 'none', scope: 'all' }, canonicalCode: '600000.SH',
    rows: [
      cnRow({ report_id: 90, statement_scope: 'consolidated', ps_fe: 10, ps_ieife: 3, statement_coverage: { fs_table_type: 'non_financial', requested_metric_codes: ['ps.fe', 'ps.ieife'], returned_metric_codes: ['ps.fe', 'ps.ieife'], complete: true } }),
      cnRow({ report_id: 91, statement_scope: 'parent', ps_fe: 8, ps_ieife: 2, statement_coverage: { fs_table_type: 'non_financial', requested_metric_codes: ['ps.fe', 'ps.ieife'], returned_metric_codes: ['ps.fe', 'ps.ieife'], complete: true } }),
    ],
  });
  const mixedScopeRow = mixedScope.presentation.rows.find(r => r.kind === 'field' && r.code === 'ps.ieife');
  assert.strictEqual(mixedScopeRow.parent_code, null, '混用合并/母公司口径时必须降级为平列');
  assert.strictEqual(mixedScopeRow.relation_status, 'basis_conflict');

  const mixedStandard = buildStatementPayload({
    market: 'CN', type: 'income', options: { compare: 'none' }, canonicalCode: '600000.SH',
    rows: [
      cnRow({ report_id: 92, accounting_standard: 'CAS', ps_fe: 10, ps_ieife: 3, statement_coverage: { fs_table_type: 'non_financial', requested_metric_codes: ['ps.fe', 'ps.ieife'], returned_metric_codes: ['ps.fe', 'ps.ieife'], complete: true } }),
      cnRow({ report_id: 93, accounting_standard: 'HKFRS', ps_fe: 8, ps_ieife: 2, statement_coverage: { fs_table_type: 'non_financial', requested_metric_codes: ['ps.fe', 'ps.ieife'], returned_metric_codes: ['ps.fe', 'ps.ieife'], complete: true } }),
    ],
  });
  const mixedStandardRow = mixedStandard.presentation.rows.find(r => r.kind === 'field' && r.code === 'ps.ieife');
  assert.strictEqual(mixedStandardRow.parent_code, null, '混用准则版本时必须降级为平列');
  assert.strictEqual(mixedStandardRow.relation_status, 'basis_conflict');

  // 单期 A 股传入不适用准则（HKFRS/UNKNOWN）、未知范围（unknown）或新列报版本（CAS_2026）时保留分组并降级直接关系
  for (const [label, overrides] of [
    ['CN+HKFRS', { accounting_standard: 'HKFRS' }],
    ['CN+UNKNOWN准则', { accounting_standard: 'UNKNOWN' }],
    ['CN+unknown范围', { statement_scope: 'unknown' }],
    ['CN+CAS_2026列报版本', { statement_coverage: { fs_table_type: 'non_financial', presentation_version: 'CAS_2026', requested_metric_codes: ['ps.fe', 'ps.ieife'], returned_metric_codes: ['ps.fe', 'ps.ieife'], complete: true } }],
  ]) {
    const singleInvalid = buildStatementPayload({
      market: 'CN', type: 'income', options: { compare: 'none' }, canonicalCode: '600000.SH',
      rows: [cnRow({
        report_id: 94, ps_fe: 10, ps_ieife: 3,
        statement_coverage: { fs_table_type: 'non_financial', requested_metric_codes: ['ps.fe', 'ps.ieife'], returned_metric_codes: ['ps.fe', 'ps.ieife'], complete: true },
        ...overrides,
      })],
    });
    const invalidRow = singleInvalid.presentation.rows.find(r => r.kind === 'field' && r.code === 'ps.ieife');
    assert.strictEqual(invalidRow.group_id, 'group:营业成本及费用', `${label} 应保留安全展示分组`);
    assert.strictEqual(invalidRow.parent_code, null, `${label} 不得启用已核父项`);
    assert.strictEqual(invalidRow.relation_status, 'basis_conflict', `${label} 应标记口径不适用降级`);
  }

  // 明确旧版与列报版本缺失混用，或 2027 年起新准则实施期缺少列报版本时，保留分组并降级直接父项
  const mixedMissingFormat = buildStatementPayload({
    market: 'CN', type: 'income', options: { compare: 'none' }, canonicalCode: '600000.SH',
    rows: [
      cnRow({ report_id: 96, period_end: '2025-12-31', ps_fe: 10, ps_ieife: 3, statement_coverage: { fs_table_type: 'non_financial', presentation_version: 'CAS_2019', requested_metric_codes: ['ps.fe', 'ps.ieife'], returned_metric_codes: ['ps.fe', 'ps.ieife'], complete: true } }),
      cnRow({ report_id: 97, period_end: '2024-12-31', ps_fe: 8, ps_ieife: 2, statement_coverage: { fs_table_type: 'non_financial', requested_metric_codes: ['ps.fe', 'ps.ieife'], returned_metric_codes: ['ps.fe', 'ps.ieife'], complete: true } }),
    ],
  });
  const mixedFormatRow = mixedMissingFormat.presentation.rows.find(r => r.kind === 'field' && r.code === 'ps.ieife');
  assert.strictEqual(mixedFormatRow.group_id, 'group:营业成本及费用');
  assert.strictEqual(mixedFormatRow.parent_code, null, '明确旧版与版本缺失混用不得启用直接父项');
  assert.strictEqual(mixedFormatRow.relation_status, 'basis_conflict');

  // 2026 年港股提前采用 HKFRS 18、列报版本缺失以及明确 HKAS_1 时，对列报版本敏感的利润表父项必须按实际列报版本受控启用
  const hk2026EarlyAdopt = buildStatementPayload({
    market: 'HK', type: 'income', options: { compare: 'none' }, canonicalCode: '00001.HK',
    rows: [row({
      report_id: 98, period_end: '2026-12-31', source_code: 'lixinger_official', currency_code: 'HKD', source_currency: 'HKD',
      ps_fe: 10, ps_iiife: 3,
      statement_coverage: { fs_table_type: 'non_financial', presentation_version: 'HKFRS_18', requested_metric_codes: ['ps.fe', 'ps.iiife'], returned_metric_codes: ['ps.fe', 'ps.iiife'], complete: true },
    })],
  });
  assert.strictEqual(hk2026EarlyAdopt.presentation.rows.find(r => r.kind === 'field' && r.code === 'ps.iiife').parent_code, null, '2026 年港股明确提前采用 HKFRS 18 时不得沿用旧版财务费用父项');
  assert.strictEqual(hk2026EarlyAdopt.presentation.rows.find(r => r.kind === 'field' && r.code === 'ps.iiife').relation_status, 'basis_conflict');

  const hk2026MissingFormat = buildStatementPayload({
    market: 'HK', type: 'income', options: { compare: 'none' }, canonicalCode: '00001.HK',
    rows: [row({
      report_id: 99, period_end: '2026-12-31', source_code: 'lixinger_official', currency_code: 'HKD', source_currency: 'HKD',
      ps_fe: 10, ps_iiife: 3,
      statement_coverage: { fs_table_type: 'non_financial', requested_metric_codes: ['ps.fe', 'ps.iiife'], returned_metric_codes: ['ps.fe', 'ps.iiife'], complete: true },
    })],
  });
  const missingFmtRow = hk2026MissingFormat.presentation.rows.find(r => r.kind === 'field' && r.code === 'ps.iiife');
  assert.strictEqual(missingFmtRow.group_id, 'group:营业成本及费用');
  assert.strictEqual(missingFmtRow.parent_code, null, '缺少列报版本时不得对受新准则影响的利润表关系默认启用旧版父项');
  assert.strictEqual(missingFmtRow.relation_status, 'format_version_unverified');

  const hk2026LegacyExplicit = buildStatementPayload({
    market: 'HK', type: 'income', options: { compare: 'none' }, canonicalCode: '00001.HK',
    rows: [row({
      report_id: 100, period_end: '2026-12-31', source_code: 'lixinger_official', currency_code: 'HKD', source_currency: 'HKD',
      ps_fe: 10, ps_iiife: 3,
      statement_coverage: { fs_table_type: 'non_financial', presentation_version: 'HKAS_1', requested_metric_codes: ['ps.fe', 'ps.iiife'], returned_metric_codes: ['ps.fe', 'ps.iiife'], complete: true },
    })],
  });
  assert.strictEqual(hk2026LegacyExplicit.presentation.rows.find(r => r.kind === 'field' && r.code === 'ps.iiife').parent_code, 'ps.fe', '明确采用 HKAS_1 时应启用财务费用下的利息收入父子关系');

  // 层级字典版本或展示结构版本变化必须改变 analysis_version 以触发 409 重读
  const v23 = statementAnalysisVersionOf({ canonicalCode: '600519.SH', market: 'CN', type: 'balance', ruleVersion: '2026-11-23', rows: [cnRow({ report_id: 95 })] });
  const v24 = statementAnalysisVersionOf({ canonicalCode: '600519.SH', market: 'CN', type: 'balance', ruleVersion: '2026-11-24', rows: [cnRow({ report_id: 95 })] });
  assert.notStrictEqual(v23, v24, '层级字典版本变更必须使 analysis_version 失效');
  const vPres = statementAnalysisVersionOf({ canonicalCode: '600519.SH', market: 'CN', type: 'balance', presentationVersion: '2026-11-24.1', ruleVersion: '2026-11-23', rows: [cnRow({ report_id: 95 })] });
  assert.notStrictEqual(v23, vPres, '展示结构版本变更必须使 analysis_version 失效');

  console.log('stock statements contract tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

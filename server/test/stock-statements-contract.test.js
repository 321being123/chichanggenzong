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
  ['重述标志', { update_flag: '1' }, { update_flag: '0' }],
  ['修订标志未知', { update_flag: null }, { update_flag: null }],
  ['理杏仁历史伪造的未重述标志', { source_code: 'lixinger_official', update_flag: '0' }, { source_code: 'lixinger_official', update_flag: '0' }],
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
      currency: index === 0 ? 'HKD' : 'CNY' }));
    const annual = stockSelectionService.annualFactsOf(profits, [], '00386.HK', null, '2000-01-01');
    const anomaly = rules.evaluateAnnualAnomaly({ ...annual, market: 'HK' });
    assert.strictEqual(anomaly.status, rules.STATUS.PENDING);
    assert.strictEqual(anomaly.reason, 'annual_profit_currency_mismatch', '跨币种年度利润不能直接求和');
    const unknownAnnual = stockSelectionService.annualFactsOf(profits.map(item => ({ ...item, currency: null })), [], '00386.HK', null, '2000-01-01');
    assert.strictEqual(rules.evaluateAnnualAnomaly({ ...unknownAnnual, market: 'HK' }).reason, 'annual_profit_currency_unknown');
    const sameProfits = profits.map(item => ({ ...item, currency: 'CNY' }));
    const dividends = sameProfits.map((item, index) => ({ year: item.year, dividend: 1, dividendKnown: true,
      dividendCurrencies: [index === 0 ? 'HKD' : 'CNY'], dividendCurrencyUnknown: false }));
    const mixedDividends = stockSelectionService.annualFactsOf(sameProfits, dividends, '00386.HK', null, '2000-01-01');
    assert.strictEqual(rules.evaluateAnnualAnomaly({ ...mixedDividends, market: 'HK' }).reason, 'annual_dividend_currency_mismatch');
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
  console.log('stock statements contract tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

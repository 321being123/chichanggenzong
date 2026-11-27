'use strict';

// 线上反馈 #115–#118：个股分析的分红口径、报告期中文、十年图表与财务安全性/现金流。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const hk = require('../services/hkSecurityAnalysis');
const stockValuation = require('../domain/stockValuation');
const { financialPeriodLabel } = require('../domain/financialReportPeriod');
const marketDatasets = require('../dataAccess/marketDatasets');

function read(relative) {
  return fs.readFileSync(path.join(__dirname, '..', '..', relative), 'utf8');
}

function group(overrides) {
  return {
    statement_scope: 'consolidated',
    currency: 'HKD',
    currency_unverified: false,
    source_version: 'v1',
    announced_at: '2026-03-01',
    report_ids: [],
    ...overrides,
  };
}

// #116：报告期英文类型统一中文展示。
assert.strictEqual(financialPeriodLabel('semiannual'), '半年报');
assert.strictEqual(financialPeriodLabel('annual'), '年报');
assert.strictEqual(financialPeriodLabel('q1'), '一季报');
assert.strictEqual(financialPeriodLabel('q3'), '三季报');
assert.strictEqual(financialPeriodLabel('semi_annual_report'), '半年报');
assert.strictEqual(financialPeriodLabel('unknown'), '');

const labelBuild = hk.buildHkAnalysis({
  meta: { name: '报告期中文', list_date: '20150101', currency: 'HKD' },
  valuations: [{ trade_date: '20251101', close: 10, adj_factor: 1, pe_ttm: 10, pb: 1, total_mv: 10000, dv_ttm: 0, total_share: 1000 }],
  dividends: [], events: [],
  reportFacts: [group({
    period_end: '2026-06-30', period_type: 'semiannual',
    report_ids: [{ kind: 'income', report_id: 1 }], profit: 50,
  })],
}, { tsCode: '01111.HK', today: '20251101' });
assert.strictEqual(labelBuild.latest_report.type, '半年报', '#116: 最新报告不得显示 semiannual');

// #115：来源年报已有分红金额/分红率时，不依赖本地分红事件覆盖；亏损年度无分红按 0%。
const sourceDividendBuild = hk.buildHkAnalysis({
  meta: { name: '来源分红口径', list_date: '20150101', currency: 'HKD' },
  valuations: [{ trade_date: '20251231', close: 10, adj_factor: 1, pe_ttm: -10, pb: 1, total_mv: 10000, dv_ttm: 0, total_share: 1000 }],
  dividends: [], events: [],
  reportFacts: [
    group({ period_end: '2025-12-31', period_type: 'annual', report_ids: [{ kind: 'income', report_id: 3 }],
      profit: -10000000, dividendAmount: 0, payoutRatioSource: 0 }),
    group({ period_end: '2024-12-31', period_type: 'annual', report_ids: [{ kind: 'income', report_id: 2 }],
      profit: 20000000, dividendAmount: 2000000, payoutRatioSource: 10 }),
    group({ period_end: '2023-12-31', period_type: 'annual', report_ids: [{ kind: 'income', report_id: 1 }],
      profit: 30000000, dividendAmount: 3000000, payoutRatioSource: 10 }),
  ],
}, { tsCode: '01112.HK', today: '20251231' });
assert.strictEqual(sourceDividendBuild.valuation.payout_ratio, 0, '#115: 年报亏损且无分红，分红率按 0%');
assert.strictEqual(sourceDividendBuild.display.field_status.payout_ratio.reason, 'latest_annual_loss_zero_dividend');
assert.ok(Math.abs(sourceDividendBuild.valuation.cumulative_payout_ratio - 0.125) < 1e-12,
  '#115: 累计分红率应直接用来源年报分红金额 500万/累计利润 4000万');
assert.strictEqual(sourceDividendBuild.display.field_status.cumulative_payout_ratio.reason, 'source_reported');
assert.strictEqual(sourceDividendBuild.valuation.average_dividend_yield, 0, '#115: TTM 利润为负，平均股息率按 0%');

const sourcePayoutBuild = hk.buildHkAnalysis({
  meta: { name: '来源分红率小数', list_date: '20150101', currency: 'HKD' },
  valuations: [{ trade_date: '20251231', close: 10, adj_factor: 1, pe_ttm: 10, pb: 1, total_mv: 10000, dv_ttm: 0, total_share: 1000 }],
  dividends: [], events: [],
  reportFacts: [group({ period_end: '2025-12-31', period_type: 'annual',
    report_ids: [{ kind: 'income', report_id: 1 }], profit: 20000000, dividendAmount: 7000000, payoutRatioSource: 0.35 })],
}, { tsCode: '01116.HK', today: '20251231' });
assert.ok(Math.abs(sourcePayoutBuild.valuation.payout_ratio - 0.35) < 1e-12,
  '#115: 宽表分红率 0.35 就是 35%，不得再除以 100');

const allLossBuild = hk.buildHkAnalysis({
  meta: { name: '累计亏损零分红', list_date: '20150101', currency: 'HKD' },
  valuations: [{ trade_date: '20251231', close: 10, adj_factor: 1, pe_ttm: -10, pb: 1, total_mv: 10000, dv_ttm: 0, total_share: 1000 }],
  dividends: [], events: [],
  reportFacts: [
    group({ period_end: '2025-12-31', period_type: 'annual', report_ids: [{ kind: 'income', report_id: 2 }],
      profit: -10000000, dividendAmount: 0, payoutRatioSource: 0 }),
    group({ period_end: '2024-12-31', period_type: 'annual', report_ids: [{ kind: 'income', report_id: 1 }],
      profit: -20000000, dividendAmount: 0, payoutRatioSource: 0 }),
  ],
}, { tsCode: '01113.HK', today: '20251231' });
assert.strictEqual(allLossBuild.valuation.cumulative_payout_ratio, 0, '#115: 历史累计亏损且零分红，累计分红率按 0%');
assert.strictEqual(allLossBuild.display.field_status.cumulative_payout_ratio.reason, 'cumulative_loss_zero_dividend');
assert.strictEqual(allLossBuild.valuation.average_dividend_yield, 0, '#115: 历史累计亏损且零分红，平均股息率按 0%');

// #115：有复权因子时，上市至今年化收益率必须可计算（数据采集由单股刷新补齐）。
const annualizedBuild = hk.buildHkAnalysis({
  meta: { name: '复权收益率', list_date: '20200102', currency: 'HKD' },
  valuations: [
    { trade_date: '20200102', close: 10, adj_factor: 1, pe_ttm: 10, pb: 1, total_mv: 10000, dv_ttm: 0, total_share: 1000 },
    { trade_date: '20251231', close: 20, adj_factor: 2, pe_ttm: 10, pb: 1, total_mv: 20000, dv_ttm: 0, total_share: 1000 },
  ],
  dividends: [], events: [], reportFacts: [],
}, { tsCode: '01114.HK', today: '20251231' });
assert.ok(annualizedBuild.valuation.annualized_return_since_listing > 0, '#115: 有复权因子时应计算年化收益率');
assert.strictEqual(annualizedBuild.display.field_status.annualized_return_since_listing.reason, null);

// #118：净现金安全额、利息保障倍数、经营现金流三年/五年均值。
const safetyCashflowBuild = hk.buildHkAnalysis({
  meta: { name: '安全性现金流', list_date: '20150101', currency: 'HKD' },
  valuations: [{ trade_date: '20251231', close: 10, adj_factor: 1, pe_ttm: 10, pb: 1, total_mv: 10000, dv_ttm: 0, total_share: 1000 }],
  dividends: [], events: [],
  reportFacts: [
    group({ period_end: '2025-12-31', period_type: 'annual', source_version: 'income',
      report_ids: [{ kind: 'income', report_id: 5 }],
      profit: 100000000, totalProfit: 150000000, interestExpense: 50000000 }),
    group({ period_end: '2025-12-31', period_type: 'annual', source_version: 'balance',
      report_ids: [{ kind: 'balance', report_id: 4 }],
      equity: 1000000000, assets: 2000000000, liabilities: 1000000000,
      cash: 500000000, shortTermInvestments: 100000000,
      shortTermBorrowings: 200000000, longTermBorrowings: 100000000, bondsPayable: 50000000, leaseLiabilities: 0,
      balance_coverage: { complete: true, requested_metric_codes: ['bs.cabb', 'bs.stl', 'bs.ltl'] } }),
    group({ period_end: '2025-12-31', period_type: 'annual', source_version: 'cash-2025',
      report_ids: [{ kind: 'cashflow', report_id: 3 }], operating: 300000000 }),
    group({ period_end: '2024-12-31', period_type: 'annual', source_version: 'cash-2024',
      report_ids: [{ kind: 'cashflow', report_id: 2 }], operating: 200000000 }),
    group({ period_end: '2023-12-31', period_type: 'annual', source_version: 'cash-2023',
      report_ids: [{ kind: 'cashflow', report_id: 1 }], operating: 100000000 }),
    group({ period_end: '2022-12-31', period_type: 'annual', source_version: 'cash-2022',
      report_ids: [{ kind: 'cashflow', report_id: 0 }], operating: 50000000 }),
    group({ period_end: '2021-12-31', period_type: 'annual', source_version: 'cash-2021',
      report_ids: [{ kind: 'cashflow', report_id: -1 }], operating: 40000000 }),
  ],
}, { tsCode: '01115.HK', today: '20251231' });
assert.strictEqual(safetyCashflowBuild.safety.net_cash, 250000000, '#118: 净现金=现金+短期投资-有息负债');
assert.strictEqual(safetyCashflowBuild.safety.interest_coverage, 4, '#118: 利息保障倍数=(利润总额+利息支出)/利息支出');
assert.strictEqual(safetyCashflowBuild.cashflow.average_3y.operating, 200000000, '#118: 三年平均经营现金流');
assert.strictEqual(safetyCashflowBuild.cashflow.average_5y.operating, 138000000, '#118: 五年平均经营现金流');
assert.strictEqual(safetyCashflowBuild.cashflow.latest_year.free, null);
assert.strictEqual(safetyCashflowBuild.cashflow.latest_year.free_reason, 'capex_not_disclosed');

// #118（A 股口径）：亏损且零分红时，分红率/累计分红率/平均股息率均为 0，不返回 --。
const cnLoss = stockValuation.buildAnalysis({
  meta: { ts_code: '600000.SH', name: 'A股亏损', industry: '银行', list_date: '20200101', data: {} },
  income: [{ end_date: '20251231', ann_date: '20260301', f_ann_date: '20260301', report_type: '1', n_income_attr_p: -100 }],
  balance: [{ end_date: '20251231', ann_date: '20260301', total_hldr_eqy_exc_min_int: 1000, total_assets: 2000, total_liab: 1000 }],
  cashflow: [{ end_date: '20251231', ann_date: '20260301', n_cashflow_act: 50, c_pay_acq_const_fiolta: 20 }],
  indicators: [], dividends: [], forecasts: [], events: [],
  valuations: [{ trade_date: '20251231', close: 10, total_share: 100, adj_factor: 1, pe_ttm: -10, pb: 1, total_mv: 1000 }],
}, { today: '20260401', rawQuote: null });
assert.strictEqual(cnLoss.valuation.payout_ratio, 0, '#115: A 股亏损且零分红，分红率 0%');
assert.strictEqual(cnLoss.valuation.cumulative_payout_ratio, 0, '#115: A 股累计亏损且零分红，累计分红率 0%');
assert.strictEqual(cnLoss.valuation.average_dividend_yield, 0, '#115: A 股累计亏损且零分红，平均股息率 0%');

// #117：图表日期格式与十年窗口的数据采集入口。
const chartSrc = read('public/js/stock-analysis-valuation-chart.js');
assert.ok(chartSrc.includes('function chartDate'), '#117: 图表必须有统一日期格式化函数');
assert.ok(chartSrc.includes('chartDate(rows[idx].date)'), '#117: X 轴刻度必须用 chartDate');
assert.ok(chartSrc.includes('chartDate(r.date)'), '#117: tooltip 必须用 chartDate');
assert.ok(!chartSrc.includes('rows[idx].date.slice(0,7)'), '#117: 禁止再截断成 2025093');
const syncSrc = read('server/services/stockSelectionInputsSync.js');
assert.ok(syncSrc.includes('HK_ANALYSIS_PRICE_YEARS = 11'), '#117: 单股分析需要十年价格窗口');
assert.ok(syncSrc.includes('historyYears'), '#117: 单股刷新应可单独扩大价格历史');
assert.ok(syncSrc.includes('readStockForwardAdjustedSeries'), '#115: 港股复权因子应由官方前复权序列派生');
const hkRefreshSrc = read('server/services/hkSingleStockRefresh.js');
assert.ok(hkRefreshSrc.includes('historyYears: 11'), '#117: 单股刷新必须请求十年价格');
const adapterSrc = read('server/dataAccess/adapters/lixingerDatasetAdapter.js');
assert.ok(adapterSrc.includes("type: adjustment === 'forward' ? 'forward'"), '#115: 官方 candlestick 必须支持前复权类型');
assert.ok(adapterSrc.includes('adjustForwardDate'), '#115: 前复权必须指定复权基准日');
assert.strictEqual(typeof marketDatasets.readStockForwardAdjustedSeries, 'function', '#115: 数据层必须暴露前复权序列读取');

console.log('反馈 #115–#118 个股分析回归通过');

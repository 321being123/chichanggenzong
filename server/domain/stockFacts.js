// 股票财务/估值事实的纯计算与口径定义（批次1，从 financialDataArchitecture 原样搬移）。
// 约束：本文件不得出现 SQL、连接池、HTTP、req/res、DOM 或调度器依赖；
// 上游 SQL 在 server/repositories/stockProjectionRepository.js，编排在 services。
const crypto = require('crypto');

function asDate(value) {
  const text = String(value || '').replace(/-/g, '').slice(0, 8);
  return /^\d{8}$/.test(text) ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}` : null;
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function marketMultiple(value) {
  const n = finite(value);
  return n === 0 ? null : n;
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function stablePayload(value) {
  if (Array.isArray(value)) return value.map(stablePayload);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => {
      out[key] = stablePayload(value[key]);
      return out;
    }, {});
  }
  return value;
}

function periodType(endDate) {
  const suffix = String(endDate || '').slice(4);
  return suffix === '1231' ? 'annual' : suffix === '0630' ? 'semiannual' : suffix === '0331' ? 'q1' : suffix === '0930' ? 'q3' : 'other';
}

// 上游字段 → 标准指标口径；只在适配边界转换一次。
const FACT_MAP = {
  income: { n_income_attr_p: 'net_profit_parent', total_revenue: 'total_revenue', revenue: 'revenue', operate_profit: 'operating_profit', total_profit: 'total_profit', ebit: 'ebit', fin_exp_int_exp: 'interest_expense' },
  balance: { total_assets: 'total_assets', total_liab: 'total_liabilities', total_hldr_eqy_exc_min_int: 'equity_parent', goodwill: 'goodwill', money_cap: 'cash_and_equivalents', trad_asset: 'trading_financial_assets' },
  cashflow: { n_cashflow_act: 'operating_cashflow', c_pay_acq_const_fiolta: 'capital_expenditure' },
  indicator: { profit_dedt: 'net_profit_deducted', roe: 'roe', roa: 'roa', interestdebt: 'interest_bearing_debt', ebit_to_interest: 'interest_coverage' },
};

const METRICS = {
  pe_ttm: ['滚动市盈率', 'valuation', 'multiple'], pe_static: ['静态市盈率', 'valuation', 'multiple'], pe_forecast: ['动态市盈率', 'valuation', 'multiple'], pe_three_year_avg: ['三年平均市盈率', 'valuation', 'multiple'], pb: ['市净率', 'valuation', 'multiple'], pb_ex_goodwill: ['扣除商誉市净率', 'valuation', 'multiple'], dividend_yield: ['股息率', 'dividend', 'ratio'], payout_ratio: ['分红率', 'dividend', 'ratio'], cumulative_payout_ratio: ['累计分红率', 'dividend', 'ratio'], average_dividend_yield: ['平均股息率', 'dividend', 'ratio'], roe: ['净资产收益率', 'profitability', 'percent'], roa: ['总资产收益率', 'profitability', 'percent'], annualized_return_since_listing: ['上市至今年化收益率', 'return', 'ratio'],
  net_cash: ['净现金安全额', 'safety', 'currency'], interest_coverage: ['利息保障倍数', 'safety', 'multiple'], market_cap_to_liability: ['市值负债比', 'safety', 'ratio'], operating_cashflow_latest: ['最近一年经营现金流', 'cashflow', 'currency'], free_cashflow_latest: ['最近一年自由现金流', 'cashflow', 'currency'], operating_cashflow_3y: ['三年平均经营现金流', 'cashflow', 'currency'], free_cashflow_3y: ['三年平均自由现金流', 'cashflow', 'currency'], operating_cashflow_5y: ['五年平均经营现金流', 'cashflow', 'currency'], free_cashflow_5y: ['五年平均自由现金流', 'cashflow', 'currency'], profit_growth_3y_parent: ['归母净利润三年增长率', 'growth', 'ratio'], profit_growth_3y_deducted: ['扣非净利润三年增长率', 'growth', 'ratio'], profit_growth_5y_parent: ['归母净利润五年增长率', 'growth', 'ratio'], profit_growth_5y_deducted: ['扣非净利润五年增长率', 'growth', 'ratio'], profit_growth_10y_parent: ['归母净利润十年增长率', 'growth', 'ratio'], profit_growth_10y_deducted: ['扣非净利润十年增长率', 'growth', 'ratio'], profit_growth_latest_parent: ['最近报告期归母净利润同比', 'growth', 'ratio'], profit_growth_latest_deducted: ['最近报告期扣非净利润同比', 'growth', 'ratio'],
};

function rowVersion(row) {
  const metadata = [row.end_date, row.ann_date, row.f_ann_date, row.report_type, row.comp_type, row.update_flag, row.div_proc, row.ex_date, row.pay_date, row.type].join('|');
  return hash(`${metadata}|payload:${hash(JSON.stringify(stablePayload(row || {})))}`);
}

function analysisMetricValues(analysis) {
  const valuation = analysis.valuation || {}, safety = analysis.safety || {}, cashflow = analysis.cashflow || {}, growth = analysis.growth || {}, periods = growth.periods || {}, latest = growth.latest_interim_yoy || {};
  return Object.assign({}, valuation, {
    net_cash: safety.net_cash, interest_coverage: safety.interest_coverage, market_cap_to_liability: safety.market_cap_to_liability,
    operating_cashflow_latest: cashflow.latest_year?.operating, free_cashflow_latest: cashflow.latest_year?.free,
    operating_cashflow_3y: cashflow.average_3y?.operating, free_cashflow_3y: cashflow.average_3y?.free,
    operating_cashflow_5y: cashflow.average_5y?.operating, free_cashflow_5y: cashflow.average_5y?.free,
    profit_growth_3y_parent: periods[3]?.parent?.value, profit_growth_3y_deducted: periods[3]?.deducted?.value,
    profit_growth_5y_parent: periods[5]?.parent?.value, profit_growth_5y_deducted: periods[5]?.deducted?.value,
    profit_growth_10y_parent: periods[10]?.parent?.value, profit_growth_10y_deducted: periods[10]?.deducted?.value,
    profit_growth_latest_parent: latest.parent, profit_growth_latest_deducted: latest.deducted,
  });
}

module.exports = {
  FACT_MAP,
  METRICS,
  analysisMetricValues,
  asDate,
  finite,
  hash,
  marketMultiple,
  periodType,
  rowVersion,
  stablePayload,
};

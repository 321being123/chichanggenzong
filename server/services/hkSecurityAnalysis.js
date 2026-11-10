// 港股证券分析：市场中立的标准输入 → 领域计算 → 已发布快照只读。
// 复用现役标准事实表与同一快照事务入口，不新建平行事实表、不新增数据源、不在 GET 外采。
'use strict';

const stockAnalysisRepository = require('../repositories/stockAnalysisRepository');
const hkRepository = require('../repositories/hkSecurityAnalysisRepository');
const { saveAnalysisResults } = require('./financialDataArchitecture');
const contract = require('../domain/securityAnalysisContract');

const FORMULA_VERSION = 'hk-1';

// 港股 HKFRS 宽表字段对照（唯一登记位置）。现金流官方只有 7 个汇总项，没有资本开支，
// 因此自由现金流恒为「不可计算」，绝不用 null→0 或退化成经营现金流。
const HK_FACT_COLUMNS = Object.freeze({
  income: Object.freeze({
    profit: ['ps_npatoshopc', 'ps_np'], revenue: ['ps_toi', 'ps_oi'], eps: ['ps_beps'],
  }),
  balance: Object.freeze({
    equity: ['bs_tetoshopc', 'bs_tetshaoehopc'], assets: ['bs_ta'], liabilities: ['bs_tl'],
  }),
  cashflow: Object.freeze({
    operating: ['cfs_ncffoa'], capex: [],
  }),
});

function pick(row, names) {
  for (const name of names) {
    const value = contract.finite(row[name]);
    if (value !== null) return value;
  }
  return null;
}

function reportGroupKey(row) {
  return [row.period_end, row.currency_code || '', row.source_version || ''].join('|');
}

async function readHkReportFacts(tsCode, limit = 12) {
  const results = await hkRepository.readHkReportFacts(tsCode, limit);
  const groups = new Map();
  results.forEach(({ kind, rows }) => {
    for (const row of rows) {
      const key = reportGroupKey(row);
      const group = groups.get(key) || {
        period_end: row.period_end, period_type: row.period_type, announced_at: row.announced_at,
        currency: String(row.currency_code || '').trim().toUpperCase() || null,
        source_version: row.source_version || null, company_id: row.company_id,
        report_ids: [], profit: null, revenue: null, eps: null, equity: null,
        assets: null, liabilities: null, operating: null, capex: null,
      };
      group.report_ids.push({ kind, report_id: row.report_id });
      for (const [field, names] of Object.entries(HK_FACT_COLUMNS[kind])) {
        if (names.length) group[field] = pick(row, names);
      }
      groups.set(key, group);
    }
  });
  return [...groups.values()].sort((a, b) => String(b.period_end).localeCompare(String(a.period_end)));
}

function isAnnual(group) {
  return /annual|年报|年度|^fy/i.test(String(group.period_type || ''));
}

function statusOf(entry) {
  return entry ? { value: entry.value, status: entry.status, reason: entry.reason } : { value: null, status: contract.FIELD_STATUS.MISSING };
}

/**
 * 港股分析结果（纯计算）。输出保持与现有股票分析 View 兼容的壳，附加 market/display 元数据与逐指标状态。
 * 未知一律 null + 状态，不把 null 当 0，不把缺证判成失败。
 */
function buildHkAnalysis(data, options = {}) {
  const meta = data.meta || {};
  const valuations = data.valuations || [];
  const facts = data.reportFacts || [];
  const dividends = data.dividends || [];
  const events = data.events || [];
  const latest = valuations[valuations.length - 1] || {};
  const price = contract.finite(latest.close);
  const currency = String(options.currency || meta.currency || 'HKD').toUpperCase();
  const today = String(options.today || '').replace(/-/g, '');

  // 来源已验证的同范围同币种估值：港股不使用「H 股价 × 公司全体股本」自算市值。
  const sourceCap = contract.finite(latest.total_mv) === null ? null : contract.finite(latest.total_mv) * 10000;
  const cap = contract.marketCapOf({
    price, shares: null, shareScope: contract.SHARE_SCOPE.UNKNOWN, priceCurrency: currency,
    verifiedMarketCap: sourceCap, verifiedScope: 'source_verified_total_mv',
  });
  const peTtm = contract.finite(latest.pe_ttm);
  const pb = contract.finite(latest.pb);

  const annual = facts.filter(isAnnual);
  const latestFact = facts[0] || null;
  const latestAnnual = annual[0] || null;
  const interimFacts = facts.filter(group => !isAnnual(group));
  const latestInterim = interimFacts[0] || null;
  const sameCurrency = (a, b) => a && b && a.currency && a.currency === b.currency;
  const priorComparable = latestInterim ? facts.find(group => group !== latestInterim
    && String(group.period_end).slice(4) === String(latestInterim.period_end).slice(4)
    && group.period_type === latestInterim.period_type
    && Number(String(group.period_end).slice(0, 4)) === Number(String(latestInterim.period_end).slice(0, 4)) - 1) : null;
  const ttm = latestInterim
    ? contract.ttmForFiscalYear({
      annual: latestAnnual && latestAnnual.profit,
      currentCumulative: latestInterim.profit,
      priorComparableCumulative: priorComparable && priorComparable.profit,
      comparable: sameCurrency(latestAnnual, latestInterim) && sameCurrency(priorComparable, latestInterim),
      fiscalYearChanged: Boolean(latestAnnual && latestAnnual.currency && latestInterim.currency
        && latestAnnual.currency !== latestInterim.currency),
    })
    : contract.metric(latestAnnual ? latestAnnual.profit : null,
      latestAnnual ? contract.FIELD_STATUS.AVAILABLE : contract.FIELD_STATUS.INSUFFICIENT_HISTORY, 'no_annual_report');

  // 股息率：只按已实施事件的每股税前现金，同事件按来源原生键去重；无股本范围不推公司分红总额。
  const dividendEvents = dividends.map(row => ({
    source_event_key: row.source_event_key || row.event_key || row.dividend_id || row.id || null,
    ex_date: row.ex_date || row.pay_date || row.ann_date || null,
    cash_per_share: contract.finite(row.cash_per_share != null ? row.cash_per_share : row.cash_div_tax),
    currency: String(row.currency || row.currency_code || currency).toUpperCase(),
    fiscal_year: row.fiscal_year || row.end_date || null,
    revision: Number(row.revision || row.update_flag || 0),
  })).filter(event => event.ex_date);
  const oneYearAgo = today ? String(Number(today.slice(0, 4)) - 1) + today.slice(4) : null;
  const dividend12m = contract.dividendYieldOf({
    events: dividendEvents, price, priceCurrency: currency, eventCurrency: currency,
    within12m: event => !oneYearAgo || String(event.ex_date).replace(/-/g, '') >= oneYearAgo,
  });
  const sourceDividendYield = contract.finite(latest.dv_ttm) === null ? null : contract.finite(latest.dv_ttm) / 100;

  // 十年稳定性：逐财年必须有实际报告证据；不足十年或缺年份均为资料不足，不判失败。
  const stability = contract.tenYearStability(annual.slice(0, 10).map(group => ({
    year: String(group.period_end).slice(0, 4),
    profit: group.profit,
    dividend: null,
    evidence: group.profit !== null && Boolean(group.period_end) && isAnnual(group),
  })));

  // 正估值分位：只用可比有效正样本，当前 PE/PB 非正不输出。
  const peSamples = valuations.map(row => contract.finite(row.pe_ttm));
  const pbSamples = valuations.map(row => contract.finite(row.pb));
  const pePercentile = contract.positiveValuationPercentile(peSamples, peTtm);
  const pbPercentile = contract.positiveValuationPercentile(pbSamples, pb);
  const priceStatus = contract.priceSeriesStatus({
    prices: valuations.map(row => ({ close: row.close })),
    valuations: valuations.map(row => ({ pe_ttm: row.pe_ttm, pb: row.pb })),
    adjustmentFactors: valuations.map(row => ({ adj_factor: row.adj_factor })),
  });

  const capexMissing = !HK_FACT_COLUMNS.cashflow.capex.length;
  const operatingLatest = latestAnnual ? contract.finite(latestAnnual.operating) : null;
  const freeCash = contract.freeCashFlowOf({ operating: operatingLatest, capex: capexMissing ? null : latestAnnual && latestAnnual.capex });
  const fieldStatus = {
    market_cap: statusOf(cap), pe_ttm: statusOf(contract.metric(peTtm)), pb: statusOf(contract.metric(pb)),
    ttm_profit: statusOf(ttm), dividend_yield: statusOf(dividend12m.yield),
    free_cashflow: statusOf(freeCash), pe_percentile: { value: pePercentile.value, status: pePercentile.status },
    ten_year_stability: { value: stability.value, status: stability.status },
  };
  const version = contract.analysisVersionOf({
    canonicalCode: options.tsCode, formulaVersion: FORMULA_VERSION,
    inputs: {
      trade_date: latest.trade_date || '', reports: facts.slice(0, 3).map(f => f.report_ids.map(r => r.report_id).join(':')).join(','),
      dividends: dividends.length,
    },
  });

  return {
    ts_code: options.tsCode, name: meta.name || options.tsCode, market: 'HK',
    industry: meta.industry || '', list_date: meta.list_date || '',
    industry_info: { name: meta.industry || '', system: '恒生行业分类', level: '', path: [] },
    actual_controller: null,
    latest_report: latestFact ? {
      end_date: latestFact.period_end,
      ann_date: latestFact.announced_at || '',
      type: isAnnual(latestFact) ? '年报' : (latestFact.period_type || '报告期类型未标注'),
      currency: latestFact.currency, accounting_standard: 'HKFRS',
      version: latestFact.source_version, report_ids: latestFact.report_ids,
    } : { end_date: '', ann_date: '', type: '资料未就绪' },
    performance_forecast: null,
    as_of: options.isoToday || null,
    latest_market_trade_date: latest.trade_date || null,
    quote: { price, currency, currency_name: currency === 'HKD' ? '港元' : currency, unit: currency, quote_time: null, source: 'local_daily_bars' },
    display: {
      market: 'HK', currency, market_cap_label: '总市值（来源已验证范围）',
      circulating_market_cap_label: '流通市值', share_scope: cap.scope || null,
      field_status: fieldStatus, analysis_version: version, formula_version: FORMULA_VERSION,
      data_dates: { trade_date: latest.trade_date || null, report_end: latestFact ? latestFact.period_end : null },
    },
    valuation: {
      market_cap: cap.value, a_share_market_cap: null,
      circulating_market_cap: null, free_float_market_cap: null,
      annualized_return_since_listing: null, return_start_date: '',
      pe_ttm: peTtm, pe_static: null, pe_forecast: null, pe_three_year_avg: null,
      pb, pb_ex_goodwill: null,
      dividend_yield: dividend12m.yield.value == null ? sourceDividendYield : dividend12m.yield.value,
      dividend_yield_source: dividend12m.yield.value == null ? 'source_reported' : 'implemented_events',
      payout_ratio: null, cumulative_payout_ratio: null, average_dividend_yield: null,
      cumulative_dividend: dividend12m.totalAmount, cumulative_profit: null,
      roe: null, roa: null,
    },
    stability: {
      status: stability.status, covered_years: stability.coveredYears,
      profitable_each_year: stability.status === contract.FIELD_STATUS.AVAILABLE ? stability.value.profitable : null,
      dividend_each_year: stability.status === contract.FIELD_STATUS.AVAILABLE ? stability.value.dividends : null,
      no_profit_years: [], no_dividend_years: [], years: [], dividend_history: [], reason: '', reason_url: '',
    },
    percentiles: {
      price: null, pe: pePercentile.value, pb: pbPercentile.value,
      pe_status: pePercentile.status, pb_status: pbPercentile.status,
      history: [], bands: {}, current: { price, pe: peTtm, pb },
      note: '港股正估值分位只用可比的有效正样本；当前值为非正时不输出。价格与估值独立读取，缺复权因子时标注未复权且不计算依赖复权的分位。',
    },
    growth: { ten_year_average: {}, periods: {}, latest_interim_yoy: null, status: contract.FIELD_STATUS.INSUFFICIENT_HISTORY },
    safety: {
      net_cash: null, interest_coverage: null, market_cap_to_liability: null,
      report_end_date: latestFact ? latestFact.period_end : null,
      industry_note: options.financial ? '金融公司按已验证适用指标展示，不套普通企业结论' : '',
    },
    cashflow: {
      status: freeCash.status,
      latest_year: { end_date: latestAnnual ? latestAnnual.period_end : null, operating: operatingLatest, free: freeCash.value },
      average_3y: { operating: null, free: null }, average_5y: { operating: null, free: null },
      note: capexMissing ? '港股官方现金流科目未提供资本开支，自由现金流不可计算' : '',
    },
    events: events.map(row => Object.assign({}, row, { event_date: row.event_date })),
    data_quality: {
      income_rows: facts.length, balance_rows: facts.length, cashflow_rows: facts.length,
      valuation_rows: valuations.length,
      prices_available: priceStatus.prices.available, valuations_available: priceStatus.valuations.available,
      prices_adjusted: priceStatus.prices.adjusted,
      research_notice: '金融数据仅供研究，交易决策前请独立核验。',
    },
  };
}

async function loadHkAnalysisInputs(tsCode) {
  const [base, facts] = await Promise.all([
    stockAnalysisRepository.loadAnalysisInputs({ tsCode }),
    readHkReportFacts(tsCode),
  ]);
  return { meta: base.meta, valuations: base.valuations, dividends: base.dividends, events: base.events, reportFacts: facts };
}

async function refreshHkAnalysis(tsCode, options = {}) {
  const data = await loadHkAnalysisInputs(tsCode);
  const today = options.isoToday || new Date().toISOString().slice(0, 10);
  const analysis = buildHkAnalysis(data, {
    tsCode, today: today.replace(/-/g, ''), isoToday: today,
    currency: options.currency, financial: options.financial,
  });
  const row = await stockAnalysisRepository.readLatestSnapshot({ tsCode });
  if (row && !hasCoreData(analysis) && hasCoreData(row.payload || {})) {
    // 失败保留上次可用快照：不用不完整新结果替换完整旧结果。
    return row.payload;
  }
  await saveAnalysisResults(tsCode, Object.assign({}, analysis, {
    diagnostics: { reason: options.reason || 'manual', read_only: true, market: 'HK' },
  }));
  return analysis;
}

function hasCoreData(analysis) {
  return Boolean(analysis && analysis.valuation && (analysis.valuation.market_cap != null || analysis.valuation.pe_ttm != null));
}

// GET 只读已发布快照；主档存在但无快照由路由返回明确的资料未就绪，游客不能通过读取排队。
async function getHkSnapshot(tsCode) {
  const row = await stockAnalysisRepository.readLatestSnapshot({ tsCode });
  if (!row) return null;
  return Object.assign({}, row.payload, { refreshed_at: row.created_at, source_updated_at: row.created_at });
}

// 公开字段白名单：运维字段、诊断、内部 freshness 不进 HTML 与公开接口。
const PUBLIC_FIELDS = [
  'ts_code', 'name', 'market', 'industry', 'list_date', 'industry_info', 'latest_report',
  'as_of', 'latest_market_trade_date', 'quote', 'display', 'valuation', 'stability',
  'percentiles', 'growth', 'safety', 'cashflow', 'events', 'data_quality', 'refreshed_at',
];

function publicSnapshotOf(analysis) {
  const out = {};
  for (const key of PUBLIC_FIELDS) {
    if (analysis[key] !== undefined) out[key] = analysis[key];
  }
  out.data_status = {
    trade_date: analysis.latest_market_trade_date || null,
    report_end: analysis.latest_report && analysis.latest_report.end_date || null,
    state: analysis.latest_market_trade_date ? 'available' : 'not_ready',
    reason: analysis.latest_market_trade_date ? null : '分析资料尚未就绪',
  };
  return out;
}

module.exports = {
  FORMULA_VERSION,
  HK_FACT_COLUMNS,
  buildHkAnalysis,
  loadHkAnalysisInputs,
  readHkReportFacts,
  refreshHkAnalysis,
  getHkSnapshot,
  publicSnapshotOf,
};

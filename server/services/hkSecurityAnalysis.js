// 港股证券分析：市场中立的标准输入 → 领域计算 → 已发布快照只读。
// 复用现役标准事实表与同一快照事务入口，不新建平行事实表、不新增数据源、不在 GET 外采。
'use strict';

const stockAnalysisRepository = require('../repositories/stockAnalysisRepository');
const hkRepository = require('../repositories/hkSecurityAnalysisRepository');
const { saveAnalysisResults } = require('./financialDataArchitecture');
const statementService = require('./stockStatementService');
const contract = require('../domain/securityAnalysisContract');

const FORMULA_VERSION = 'hk-5';
const { FORMULA_VERSION: STATEMENT_FORMULA_VERSION } = require('./hkStockStatements');

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
  return [row.period_end, row.statement_scope || 'consolidated', row.currency_code || '', row.source_version || ''].join('|');
}

function statementVersionRowsOf(facts, type) {
  return facts.flatMap(group => (group.report_ids || [])
    .filter(item => item.kind === type)
    .map(item => ({
      report_id: item.report_id, source_version: group.source_version,
      period_end: group.period_end, period_type: group.period_type,
      announced_at: group.announced_at, statement_revision: item.statement_revision,
    })))
    .sort((a, b) => String(b.period_end).localeCompare(String(a.period_end))
      || String(b.announced_at || '').localeCompare(String(a.announced_at || ''))
      || Number(b.report_id) - Number(a.report_id));
}

async function readHkReportFacts(tsCode, limit = 20, tx) {
  const results = await hkRepository.readHkReportFacts(tsCode, limit, tx);
  const groups = new Map();
  results.forEach(({ kind, rows }) => {
    for (const row of rows) {
      const key = reportGroupKey(row);
      const group = groups.get(key) || {
        period_end: row.period_end, period_type: row.period_type, announced_at: row.announced_at,
        statement_scope: row.statement_scope || 'consolidated',
        currency: String(row.currency_code || '').trim().toUpperCase() || null,
        source_version: row.source_version || null, company_id: row.company_id,
        report_ids: [], profit: null, revenue: null, eps: null, equity: null,
        assets: null, liabilities: null, operating: null, capex: null, currency_unverified: false,
      };
      group.report_ids.push({ kind, report_id: row.report_id, statement_revision: row.statement_revision || null });
      const currency = String(row.currency_code || '').trim().toUpperCase();
      const sourceCurrency = String(row.source_currency || '').trim().toUpperCase();
      let coverage = row.statement_coverage;
      if (typeof coverage === 'string') { try { coverage = JSON.parse(coverage); } catch (_) { coverage = null; } }
      const currencyUnverified = row.source_code === 'lixinger_official'
        && (!/^[A-Z]{3}$/.test(currency) || currency !== sourceCurrency || (currency !== 'HKD'
          && !(coverage && coverage.value_basis === 'source_original_t_o')));
      group.currency_unverified ||= currencyUnverified;
      for (const [field, names] of Object.entries(HK_FACT_COLUMNS[kind])) {
        if (names.length) group[field] = currencyUnverified ? null : pick(row, names);
      }
      groups.set(key, group);
    }
  });
  return [...groups.values()].sort((a, b) => String(b.period_end).localeCompare(String(a.period_end)));
}

function isAnnual(group) {
  return /^(annual|annual_report|year|year_report|yearly|fy|a|q4|fourth_quarterly_report|年报|年度)$/i
    .test(String(group.period_type || '').trim());
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
  const consolidatedFacts = facts.filter(group => !group.statement_scope || group.statement_scope === 'consolidated');
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

  // 不同报表的 source_version 通常不同，必须按报表类型选取，不能假定同年报都在同一组。
  const ofKind = (group, kind) => (group.report_ids || []).some(item => item.kind === kind);
  const incomeFacts = consolidatedFacts.filter(group => ofKind(group, 'income'));
  const annual = incomeFacts.filter(isAnnual);
  const latestFact = consolidatedFacts[0] || null;
  const latestAnnual = annual[0] || null;
  const interimFacts = incomeFacts.filter(group => !isAnnual(group));
  // 年报已覆盖的旧中报不能再叠加到该年报；只有晚于最近年报的累计期才能参与 TTM。
  const latestInterim = interimFacts.find(group => !latestAnnual || group.period_end > latestAnnual.period_end) || null;
  const sameCurrency = (a, b) => a && b && a.currency && a.currency === b.currency;
  const priorComparable = latestInterim ? incomeFacts.find(group => group !== latestInterim
    && String(group.period_end).slice(4) === String(latestInterim.period_end).slice(4)
    && group.period_type === latestInterim.period_type
    && Number(String(group.period_end).slice(0, 4)) === Number(String(latestInterim.period_end).slice(0, 4)) - 1) : null;
  const ttmCurrencyUnverified = [latestAnnual, latestInterim, priorComparable].some(group => group && group.currency_unverified);
  const ttm = ttmCurrencyUnverified
    ? contract.metric(null, contract.FIELD_STATUS.SOURCE_UNAVAILABLE, 'source_currency_unverified')
    : latestInterim
    ? contract.ttmForFiscalYear({
      annual: latestAnnual && latestAnnual.profit,
      currentCumulative: latestInterim.profit,
      priorComparableCumulative: priorComparable && priorComparable.profit,
      comparable: sameCurrency(latestAnnual, latestInterim) && sameCurrency(priorComparable, latestInterim)
        && priorComparable.period_end < latestAnnual.period_end,
      fiscalYearChanged: Boolean((latestAnnual && latestAnnual.currency && latestInterim.currency
        && latestAnnual.currency !== latestInterim.currency)
        || (priorComparable && latestAnnual && priorComparable.period_end >= latestAnnual.period_end)),
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
  const latestAnnualCashflow = consolidatedFacts.find(group => isAnnual(group) && ofKind(group, 'cashflow')) || null;
  const operatingLatest = latestAnnualCashflow ? contract.finite(latestAnnualCashflow.operating) : null;
  const freeCash = contract.freeCashFlowOf({ operating: operatingLatest, capex: capexMissing ? null : latestAnnualCashflow && latestAnnualCashflow.capex });

  // 港股补充指标：同币种或仅使用已落库汇率折算（无可靠汇率时保持 null，不臆造）。
  const fxToCny = options.fxToCny || {};
  function convertToMarketCurrency(amount, fromCurrency) {
    if (amount === null || amount === undefined || !Number.isFinite(amount)) return null;
    const src = String(fromCurrency || '').toUpperCase();
    if (!src) return null;
    if (src === currency) return amount;
    if (currency === 'HKD') {
      const hkdCny = contract.finite(fxToCny.HKD);
      if (!hkdCny || hkdCny <= 0) return null;
      if (src === 'CNY') return amount / hkdCny;
      const srcCny = contract.finite(fxToCny[src]);
      if (srcCny && srcCny > 0) return (amount * srcCny) / hkdCny;
    }
    return null;
  }

  const latestAnnualBalance = latestAnnual
    ? consolidatedFacts.find(group => isAnnual(group) && ofKind(group, 'balance') && !group.currency_unverified && group.period_end === latestAnnual.period_end)
    : null;
  const prevAnnualBalance = latestAnnualBalance
    ? consolidatedFacts.find(group => isAnnual(group) && ofKind(group, 'balance') && !group.currency_unverified
      && sameCurrency(group, latestAnnualBalance)
      && Number(String(group.period_end).slice(0, 4)) === Number(String(latestAnnualBalance.period_end).slice(0, 4)) - 1)
    : null;
  let roe = null, roa = null;
  if (latestAnnual && !latestAnnual.currency_unverified && latestAnnual.profit !== null
    && latestAnnualBalance && sameCurrency(latestAnnual, latestAnnualBalance)) {
    const avgEquity = prevAnnualBalance && prevAnnualBalance.equity !== null && latestAnnualBalance.equity !== null
      ? (latestAnnualBalance.equity + prevAnnualBalance.equity) / 2
      : latestAnnualBalance.equity;
    if (avgEquity !== null && avgEquity > 0) roe = latestAnnual.profit / avgEquity;
    const avgAssets = prevAnnualBalance && prevAnnualBalance.assets !== null && latestAnnualBalance.assets !== null
      ? (latestAnnualBalance.assets + prevAnnualBalance.assets) / 2
      : latestAnnualBalance.assets;
    if (avgAssets !== null && avgAssets > 0) roa = latestAnnual.profit / avgAssets;
  }

  let peStatic = null;
  if (cap.value > 0 && latestAnnual && !latestAnnual.currency_unverified && latestAnnual.profit > 0) {
    const profitInMarket = convertToMarketCurrency(latestAnnual.profit, latestAnnual.currency);
    if (profitInMarket && profitInMarket > 0) peStatic = cap.value / profitInMarket;
  }
  let peThreeYearAvg = null;
  if (cap.value > 0 && annual.length >= 3) {
    const top3 = annual.slice(0, 3);
    const y0 = Number(String(top3[0].period_end).slice(0, 4));
    const consecutive = top3.every((g, idx) => !g.currency_unverified && g.profit !== null
      && Number(String(g.period_end).slice(0, 4)) === y0 - idx);
    if (consecutive) {
      const converted = top3.map(g => convertToMarketCurrency(g.profit, g.currency));
      if (converted.every(v => v !== null)) {
        const avgProfit = (converted[0] + converted[1] + converted[2]) / 3;
        if (avgProfit > 0) peThreeYearAvg = cap.value / avgProfit;
      }
    }
  }

  const latestBalanceForSafety = consolidatedFacts.find(group => ofKind(group, 'balance') && !group.currency_unverified) || null;
  const liabilitiesInMarket = latestBalanceForSafety && latestBalanceForSafety.liabilities !== null
    ? convertToMarketCurrency(latestBalanceForSafety.liabilities, latestBalanceForSafety.currency)
    : null;
  const marketCapToLiability = cap.value > 0 && liabilitiesInMarket !== null && liabilitiesInMarket > 0
    ? cap.value / liabilitiesInMarket
    : null;

  const historySeries = valuations.map(row => ({
    date: row.trade_date,
    price: contract.finite(row.close),
    pe: contract.finite(row.pe_ttm),
    pb: contract.finite(row.pb),
  }));
  const stabilityYears = annual.slice(0, 20).map(group => ({
    year: String(group.period_end).slice(0, 4),
    report_ann_date: group.announced_at || '',
    profit: group.currency_unverified ? null : group.profit,
    dividend: null,
    payout_ratio: null,
    annual_payout_ratio: null,
    dividend_details: [],
  }));
  const fieldStatus = {
    market_cap: statusOf(cap), pe_ttm: statusOf(contract.metric(peTtm)), pb: statusOf(contract.metric(pb)),
    ttm_profit: { ...statusOf(ttm), currency: ttm.value === null ? null : (latestInterim || latestAnnual).currency }, dividend_yield: statusOf(dividend12m.yield),
    free_cashflow: statusOf(freeCash), pe_percentile: { value: pePercentile.value, status: pePercentile.status },
    ten_year_stability: { value: stability.value, status: stability.status },
  };
  const version = contract.analysisVersionOf({
    canonicalCode: options.tsCode, formulaVersion: FORMULA_VERSION,
    inputs: {
      trade_date: latest.trade_date || '', reports: JSON.stringify(facts.map(f => ({
        period_end: f.period_end, period_type: f.period_type, statement_scope: f.statement_scope, currency: f.currency,
        source_version: f.source_version, currency_unverified: f.currency_unverified,
        report_ids: f.report_ids,
      }))),
      dividends: dividends.length,
    },
  });
  const statementAnalysisVersions = Object.fromEntries(['balance', 'income', 'cashflow'].map(type => [
    type,
    statementService.statementAnalysisVersionOf({
      canonicalCode: options.tsCode, market: 'HK', type,
      formulaVersion: STATEMENT_FORMULA_VERSION, rows: statementVersionRowsOf(facts, type),
    }),
  ]));

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
      statement_analysis_versions: statementAnalysisVersions,
      data_dates: { trade_date: latest.trade_date || null, report_end: latestFact ? latestFact.period_end : null },
    },
    valuation: {
      market_cap: cap.value, a_share_market_cap: null,
      circulating_market_cap: null, free_float_market_cap: null,
      annualized_return_since_listing: null, return_start_date: '',
      pe_ttm: peTtm, pe_static: peStatic, pe_forecast: null, pe_three_year_avg: peThreeYearAvg,
      pb, pb_ex_goodwill: null,
      dividend_yield: dividend12m.yield.value == null ? sourceDividendYield : dividend12m.yield.value,
      dividend_yield_source: dividend12m.yield.value == null ? 'source_reported' : 'implemented_events',
      payout_ratio: null, cumulative_payout_ratio: null, average_dividend_yield: null,
      cumulative_dividend: dividend12m.totalAmount, cumulative_profit: null,
      roe, roa,
    },
    stability: {
      status: stability.status, covered_years: stability.coveredYears,
      profitable_each_year: stability.status === contract.FIELD_STATUS.AVAILABLE ? stability.value.profitable : null,
      dividend_each_year: stability.status === contract.FIELD_STATUS.AVAILABLE ? stability.value.dividends : null,
      no_profit_years: [], no_dividend_years: [], years: stabilityYears, dividend_history: [], reason: '', reason_url: '',
    },
    percentiles: {
      price: null, pe: pePercentile.value, pb: pbPercentile.value,
      pe_status: pePercentile.status, pb_status: pbPercentile.status,
      history: historySeries, bands: {}, current: { price, pe: peTtm, pb },
      note: '港股正估值分位只用可比的有效正样本；当前值为非正时不输出。价格与估值独立读取，缺复权因子时标注未复权且不计算依赖复权的分位。',
    },
    growth: { ten_year_average: {}, periods: {}, latest_interim_yoy: null, status: contract.FIELD_STATUS.INSUFFICIENT_HISTORY },
    safety: {
      net_cash: null, interest_coverage: null, market_cap_to_liability: marketCapToLiability,
      report_end_date: latestFact ? latestFact.period_end : null,
      industry_note: options.financial ? '金融公司按已验证适用指标展示，不套普通企业结论' : '',
    },
    cashflow: {
      status: freeCash.status,
      latest_year: { end_date: latestAnnualCashflow ? latestAnnualCashflow.period_end : null,
        currency: latestAnnualCashflow ? latestAnnualCashflow.currency : null, operating: operatingLatest, free: freeCash.value },
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
  const fxRateRepository = require('../repositories/fxRateRepository');
  const [base, facts, hkdRate, usdRate] = await Promise.all([
    stockAnalysisRepository.loadAnalysisInputs({ tsCode }),
    readHkReportFacts(tsCode),
    fxRateRepository.readLatestRatePairUpTo('HKD', 'CNY', '9999-12-31').catch(() => null),
    fxRateRepository.readLatestRatePairUpTo('USD', 'CNY', '9999-12-31').catch(() => null),
  ]);
  const fxToCny = {};
  if (hkdRate && Number(hkdRate.rate) > 0) fxToCny.HKD = Number(hkdRate.rate);
  if (usdRate && Number(usdRate.rate) > 0) fxToCny.USD = Number(usdRate.rate);
  return { meta: base.meta, valuations: base.valuations, dividends: base.dividends, events: base.events, reportFacts: facts, fxToCny };
}

async function refreshHkAnalysis(tsCode, options = {}) {
  const data = await loadHkAnalysisInputs(tsCode);
  const today = options.isoToday || new Date().toISOString().slice(0, 10);
  const analysis = buildHkAnalysis(data, {
    tsCode, today: today.replace(/-/g, ''), isoToday: today,
    currency: options.currency, financial: options.financial, fxToCny: data.fxToCny,
  });
  const row = await stockAnalysisRepository.readLatestSnapshot({ tsCode });
  if (row && !hasCoreData(analysis) && hasCoreData(row.payload || {})) {
    // 失败保留上次可用快照：不用不完整新结果替换完整旧结果。
    return safeSnapshotOf(row.payload);
  }
  await saveAnalysisResults(tsCode, Object.assign({}, analysis, {
    diagnostics: { reason: options.reason || 'manual', read_only: true, market: 'HK' },
  }));
  return analysis;
}

function hasCoreData(analysis) {
  return Boolean(analysis && analysis.valuation && (analysis.valuation.market_cap != null || analysis.valuation.pe_ttm != null));
}

// 旧快照没有逐财报的来源和币种证据，无法事后识别受影响的单个指标。
// 保留行情等无关内容，暂时屏蔽财报派生结果，直至受保护的公式重新生成快照。
function safeSnapshotOf(analysis) {
  if (!analysis || (analysis.display && analysis.display.formula_version === FORMULA_VERSION)) return analysis;
  const unavailable = { value: null, status: contract.FIELD_STATUS.SOURCE_UNAVAILABLE, reason: 'source_currency_unverified' };
  const display = { ...(analysis.display || {}), field_status: {
    ...((analysis.display && analysis.display.field_status) || {}),
    ttm_profit: unavailable, ten_year_stability: unavailable,
  } };
  const stability = { ...(analysis.stability || {}), status: contract.FIELD_STATUS.SOURCE_UNAVAILABLE,
    covered_years: 0, profitable_each_year: null, dividend_each_year: null,
    no_profit_years: [], no_dividend_years: [], years: [], dividend_history: [], reason: 'source_currency_unverified' };
  const cashflow = { ...(analysis.cashflow || {}), status: contract.FIELD_STATUS.SOURCE_UNAVAILABLE,
    latest_year: { ...((analysis.cashflow && analysis.cashflow.latest_year) || {}), operating: null, free: null },
    average_3y: { operating: null, free: null }, average_5y: { operating: null, free: null } };
  return { ...analysis, display, stability, cashflow };
}

// GET 只读已发布快照；主档存在但无快照由路由返回明确的资料未就绪，游客不能通过读取排队。
async function getHkSnapshot(tsCode) {
  const row = await stockAnalysisRepository.readLatestSnapshot({ tsCode });
  if (!row) return null;
  return Object.assign({}, safeSnapshotOf(row.payload), { refreshed_at: row.created_at, source_updated_at: row.created_at });
}

// 公开字段白名单：运维字段、诊断、内部 freshness 不进 HTML 与公开接口。
const PUBLIC_FIELDS = [
  'ts_code', 'name', 'market', 'industry', 'list_date', 'industry_info', 'latest_report',
  'as_of', 'latest_market_trade_date', 'quote', 'display', 'valuation', 'stability',
  'percentiles', 'growth', 'safety', 'cashflow', 'events', 'data_quality', 'refreshed_at',
];

function publicSnapshotOf(analysis) {
  analysis = safeSnapshotOf(analysis);
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

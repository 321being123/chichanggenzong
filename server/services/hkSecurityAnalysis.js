// 港股证券分析：市场中立的标准输入 → 领域计算 → 已发布快照只读。
// 复用现役标准事实表与同一快照事务入口，不新建平行事实表、不新增数据源、不在 GET 外采。
'use strict';

const stockAnalysisRepository = require('../repositories/stockAnalysisRepository');
const hkRepository = require('../repositories/hkSecurityAnalysisRepository');
const { saveAnalysisResults } = require('./financialDataArchitecture');
const statementService = require('./stockStatementService');
const contract = require('../domain/securityAnalysisContract');
const { financialPeriodLabel } = require('../domain/financialReportPeriod');

const FORMULA_VERSION = 'hk-8';
const { FORMULA_VERSION: STATEMENT_FORMULA_VERSION } = require('./hkStockStatements');

// 港股 HKFRS 宽表字段对照（唯一登记位置）。现金流官方只有 7 个汇总项，没有资本开支，
// 因此自由现金流仍不可计算；但经营现金流均值、净现金安全额与利息保障倍数可用三表计算。
// 分红率/分红金额优先取官方年报指标（ps.d_np_r / ps.da），不再依赖本地分红事件是否完整。
const HK_FACT_COLUMNS = Object.freeze({
  income: Object.freeze({
    profit: ['ps_npatoshopc', 'ps_np'], revenue: ['ps_toi', 'ps_oi'], eps: ['ps_beps'],
    dividendAmount: ['ps_da'], payoutRatioSource: ['ps_d_np_r'],
    totalProfit: ['ps_tp'], interestExpense: ['ps_ie', 'ps_fc', 'ps_fe'],
  }),
  balance: Object.freeze({
    equity: ['bs_tetoshopc', 'bs_tetshaoehopc'], assets: ['bs_ta'], liabilities: ['bs_tl'], goodwill: ['bs_gw'],
    cash: ['bs_cabb'], shortTermInvestments: ['bs_sti', 'bs_cfiafvtpol'],
    shortTermBorrowings: ['bs_stl', 'bs_stpl'], longTermBorrowings: ['bs_ltl', 'bs_ltpl'],
    bondsPayable: ['bs_bp', 'bs_stbp'], convertibleBonds: ['bs_stlcofcb', 'bs_ltlcofcb'],
    leaseLiabilities: ['bs_stll', 'bs_ltll'],
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
      statement_comparisons: item.statement_comparisons || null,
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
        assets: null, liabilities: null, goodwill: null, operating: null, capex: null,
        dividendAmount: null, payoutRatioSource: null, totalProfit: null, interestExpense: null,
        cash: null, shortTermInvestments: null, shortTermBorrowings: null, longTermBorrowings: null,
        bondsPayable: null, convertibleBonds: null, leaseLiabilities: null,
        balance_coverage: null, currency_unverified: false,
      };
      group.report_ids.push({
        kind,
        report_id: row.report_id,
        statement_revision: row.statement_revision || null,
        statement_comparisons: row.statement_comparisons || null,
      });
      const currency = String(row.currency_code || '').trim().toUpperCase();
      const sourceCurrency = String(row.source_currency || '').trim().toUpperCase();
      let coverage = row.statement_coverage;
      if (typeof coverage === 'string') { try { coverage = JSON.parse(coverage); } catch (_) { coverage = null; } }
      if (kind === 'balance') group.balance_coverage = coverage || null;
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

function parseYmdMs(raw) {
  const s = String(raw || '').replace(/-/g, '').trim();
  if (!/^\d{8}$/.test(s)) return null;
  const ms = Date.parse(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

function fiscalYearStartOf(periodEnd) {
  const s = String(periodEnd || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  const [y, m, day] = s.split('-').map(Number);
  if (m === 2 && (day === 28 || day === 29)) return `${y - 1}-03-01`;
  const d = new Date(Date.UTC(y - 1, m - 1, day + 1));
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : '';
}

function interimAnnualizeFactor(periodType) {
  const t = String(periodType || '').trim().toLowerCase();
  if (t === 'q1' || t === 'first_quarterly_report') return 4;
  if (t === 'semiannual' || t === 'semi_annual_report' || t === 'interim_report' || t === 'q2' || t === 'second_quarterly_report') return 2;
  if (t === 'q3' || t === 'third_quarterly_report') return 4 / 3;
  return null;
}

function goodwillRequestedInCoverage(cov) {
  if (!cov || cov.complete !== true) return false;
  const codes = Array.isArray(cov.requested_metric_codes) ? cov.requested_metric_codes : [];
  return codes.some(code => {
    const s = String(code || '').trim().toLowerCase();
    return s === 'bs.gw' || s === 'bs_gw' || s === 'bs.gw.t';
  });
}

function resolveEventFiscalYear(row) {
  const fy = String(row.fiscal_year || '').trim();
  if (/^\d{4}/.test(fy)) return { year: fy.slice(0, 4), inferred: false };
  const endDate = String(row.end_date || '').trim();
  if (/^\d{4}/.test(endDate)) return { year: endDate.slice(0, 4), inferred: false };
  const ex = String(row.ex_date || row.pay_date || row.ann_date || '').replace(/-/g, '').trim();
  if (/^\d{4}/.test(ex)) return { year: ex.slice(0, 4), inferred: true };
  return { year: null, inferred: false };
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

  // 港股补充指标：同币种直接展示；跨币种只用已落库汇率折算（无可靠汇率时保持 null，不臆造）。
  // 交易币种是市值/股价的币种（港股为 HKD），财报币种可能为 CNY/USD。比值必须同币种，
  // 因此利润/净资产按「财报币种 → 交易币种」折算，而不是无条件折算成人民币。
  const fxToCny = options.fxToCny || data.fxToCny || {};
  function convertToMarketCurrency(amount, fromCurrency) {
    if (amount === null || amount === undefined || !Number.isFinite(amount)) return null;
    const src = String(fromCurrency || '').toUpperCase();
    if (!src) return null;
    if (src === currency) return amount;
    const srcCny = contract.finite(fxToCny[src]);
    const marketCny = contract.finite(fxToCny[currency]);
    // 人民币目标：外币 ×（外币→CNY）。
    if (currency === 'CNY') return srcCny && srcCny > 0 ? amount * srcCny : null;
    // 其他目标（港股 HKD）：外币 → CNY → 目标币种；人民币源用反向汇率。
    if (marketCny && marketCny > 0) {
      if (src === 'CNY') return amount / marketCny;
      if (srcCny && srcCny > 0) return (amount * srcCny) / marketCny;
    }
    return null;
  }
  const CURRENCY_NAMES = { HKD: '港元', CNY: '人民币', USD: '美元', AUD: '澳元', SGD: '新加坡元' };
  function currencyNameOf(code) {
    const key = String(code || '').toUpperCase();
    return CURRENCY_NAMES[key] || key || '';
  }
  function currencyLabelOf(code) {
    const key = String(code || '').toUpperCase();
    return key ? `${currencyNameOf(key)} (${key})` : '';
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
    if (avgEquity !== null && avgEquity > 0) roe = (latestAnnual.profit / avgEquity) * 100;
    const avgAssets = prevAnnualBalance && prevAnnualBalance.assets !== null && latestAnnualBalance.assets !== null
      ? (latestAnnualBalance.assets + prevAnnualBalance.assets) / 2
      : latestAnnualBalance.assets;
    if (avgAssets !== null && avgAssets > 0) roa = (latestAnnual.profit / avgAssets) * 100;
  }

  let peStatic = null;
  let peStaticStatus = contract.metric(null, contract.FIELD_STATUS.MISSING, 'missing_annual_report');
  if (cap.value > 0 && latestAnnual && !latestAnnual.currency_unverified && latestAnnual.profit !== null) {
    const profitInMarket = convertToMarketCurrency(latestAnnual.profit, latestAnnual.currency);
    if (profitInMarket === null) {
      peStaticStatus = contract.metric(null, contract.FIELD_STATUS.SOURCE_UNAVAILABLE, 'fx_rate_missing');
    } else if (profitInMarket === 0) {
      peStaticStatus = contract.metric(null, contract.FIELD_STATUS.NOT_APPLICABLE, 'profit_is_zero');
    } else {
      peStatic = cap.value / profitInMarket;
      peStaticStatus = contract.metric(peStatic, contract.FIELD_STATUS.AVAILABLE);
    }
  } else if (latestAnnual && latestAnnual.currency_unverified) {
    peStaticStatus = contract.metric(null, contract.FIELD_STATUS.SOURCE_UNAVAILABLE, 'source_currency_unverified');
  }
  let peThreeYearAvg = null;
  let peThreeYearAvgStatus = contract.metric(null, contract.FIELD_STATUS.INSUFFICIENT_HISTORY, 'insufficient_3y_annual_reports');
  if (cap.value > 0 && annual.length >= 3) {
    const top3 = annual.slice(0, 3);
    const y0 = Number(String(top3[0].period_end).slice(0, 4));
    const consecutive = top3.every((g, idx) => !g.currency_unverified && g.profit !== null
      && Number(String(g.period_end).slice(0, 4)) === y0 - idx);
    if (consecutive) {
      const converted = top3.map(g => convertToMarketCurrency(g.profit, g.currency));
      if (converted.every(v => v !== null)) {
        const avgProfit = (converted[0] + converted[1] + converted[2]) / 3;
        if (avgProfit === 0) {
          peThreeYearAvgStatus = contract.metric(null, contract.FIELD_STATUS.NOT_APPLICABLE, 'avg_profit_is_zero');
        } else {
          peThreeYearAvg = cap.value / avgProfit;
          peThreeYearAvgStatus = contract.metric(peThreeYearAvg, contract.FIELD_STATUS.AVAILABLE);
        }
      } else {
        peThreeYearAvgStatus = contract.metric(null, contract.FIELD_STATUS.SOURCE_UNAVAILABLE, 'fx_rate_missing');
      }
    }
  }

  // 动态市盈率：保留港股中报/季报年化口径；无新一期中报/季报时写明原因。
  let peForecast = null, peForecastBasis = null;
  let peForecastStatus = contract.metric(
    null,
    contract.FIELD_STATUS.NOT_APPLICABLE,
    latestAnnual ? '最新报告已为年报，暂无新一期中报/季报年化' : '暂无中报或季报利润数据'
  );
  if (cap.value > 0 && latestInterim && !latestInterim.currency_unverified && latestInterim.profit !== null) {
    const factor = interimAnnualizeFactor(latestInterim.period_type);
    const profitInMarket = convertToMarketCurrency(latestInterim.profit, latestInterim.currency);
    if (!factor) {
      peForecastStatus = contract.metric(null, contract.FIELD_STATUS.NOT_APPLICABLE, 'unsupported_interim_period_type');
    } else if (profitInMarket === null) {
      peForecastStatus = contract.metric(null, contract.FIELD_STATUS.SOURCE_UNAVAILABLE, 'fx_rate_missing');
    } else if (profitInMarket === 0) {
      peForecastStatus = contract.metric(null, contract.FIELD_STATUS.NOT_APPLICABLE, 'interim_profit_is_zero');
    } else {
      peForecast = cap.value / (profitInMarket * factor);
      peForecastBasis = 'annualized_report';
      peForecastStatus = contract.metric(peForecast, contract.FIELD_STATUS.AVAILABLE);
    }
  } else if (latestInterim && latestInterim.currency_unverified) {
    peForecastStatus = contract.metric(null, contract.FIELD_STATUS.SOURCE_UNAVAILABLE, 'source_currency_unverified');
  }

  // 扣除商誉市净率：严格区分“真无商誉（已请求且完整但来源未披露）”与“未采到/批不完整”。
  const latestBalanceForPb = consolidatedFacts.find(group => ofKind(group, 'balance') && !group.currency_unverified && group.equity !== null) || null;
  let pbExGoodwill = null;
  let pbExGoodwillStatus = contract.metric(null, contract.FIELD_STATUS.MISSING, 'missing_balance_sheet');
  if (cap.value > 0 && latestBalanceForPb) {
    const equityInMarket = convertToMarketCurrency(latestBalanceForPb.equity, latestBalanceForPb.currency);
    if (equityInMarket === null) {
      pbExGoodwillStatus = contract.metric(null, contract.FIELD_STATUS.SOURCE_UNAVAILABLE, 'fx_rate_missing');
    } else if (latestBalanceForPb.goodwill !== null && Number.isFinite(latestBalanceForPb.goodwill)) {
      const goodwillInMarket = convertToMarketCurrency(latestBalanceForPb.goodwill, latestBalanceForPb.currency);
      if (goodwillInMarket === null) {
        pbExGoodwillStatus = contract.metric(null, contract.FIELD_STATUS.SOURCE_UNAVAILABLE, 'fx_rate_missing');
      } else {
        const netEquity = equityInMarket - goodwillInMarket;
        if (netEquity !== 0) {
          pbExGoodwill = cap.value / netEquity;
          pbExGoodwillStatus = contract.metric(pbExGoodwill, contract.FIELD_STATUS.AVAILABLE);
        } else {
          pbExGoodwillStatus = contract.metric(null, contract.FIELD_STATUS.NOT_APPLICABLE, 'net_equity_ex_goodwill_is_zero');
        }
      }
    } else if (goodwillRequestedInCoverage(latestBalanceForPb.balance_coverage)) {
      if (equityInMarket !== 0) {
        pbExGoodwill = cap.value / equityInMarket;
        pbExGoodwillStatus = { value: pbExGoodwill, status: contract.FIELD_STATUS.AVAILABLE, reason: 'goodwill_not_disclosed_treated_as_zero' };
      } else {
        pbExGoodwillStatus = contract.metric(null, contract.FIELD_STATUS.NOT_APPLICABLE, 'equity_is_zero');
      }
    } else {
      const cov = latestBalanceForPb.balance_coverage;
      const reason = cov && cov.complete === false ? 'source_batch_incomplete' : 'goodwill_not_collected';
      pbExGoodwillStatus = contract.metric(null, contract.FIELD_STATUS.SOURCE_UNAVAILABLE, reason);
    }
  }

  // 上市至今年化收益率：校验首尾有效收盘价与复权因子，并比对实际起算日与 list_date。
  const DAY_MS = 86400000;
  const adjustedPriceRows = valuations.filter(row => {
    const c = contract.finite(row.close);
    const af = contract.finite(row.adj_factor);
    return c !== null && c > 0 && af !== null && af > 0 && parseYmdMs(row.trade_date) !== null;
  });
  let annualizedReturnSinceListing = null;
  let returnStartDate = '';
  let returnStartMode = null;
  let annualizedReturnStatus = contract.metric(null, contract.FIELD_STATUS.INSUFFICIENT_HISTORY, 'insufficient_price_history');
  if (adjustedPriceRows.length >= 2) {
    const earliest = adjustedPriceRows[0];
    const latestAdj = adjustedPriceRows[adjustedPriceRows.length - 1];
    const startMs = parseYmdMs(earliest.trade_date);
    const endMs = parseYmdMs(latestAdj.trade_date);
    const days = (endMs - startMs) / DAY_MS;
    if (days >= 30) {
      const totalFactor = (Number(latestAdj.close) * Number(latestAdj.adj_factor))
        / (Number(earliest.close) * Number(earliest.adj_factor));
      if (Number.isFinite(totalFactor) && totalFactor > 0) {
        annualizedReturnSinceListing = Math.pow(totalFactor, 365.25 / days) - 1;
        returnStartDate = String(earliest.trade_date);
        const listMs = parseYmdMs(meta.list_date);
        returnStartMode = (listMs !== null && (startMs - listMs) / DAY_MS > 30) ? 'range' : 'listing';
        annualizedReturnStatus = {
          value: annualizedReturnSinceListing,
          status: contract.FIELD_STATUS.AVAILABLE,
          reason: returnStartMode === 'range' ? 'history_shorter_than_listing' : null,
        };
      }
    }
  } else if (valuations.some(row => contract.finite(row.close) > 0 && !(contract.finite(row.adj_factor) > 0))) {
    annualizedReturnStatus = contract.metric(null, contract.FIELD_STATUS.SOURCE_UNAVAILABLE, 'missing_adj_factor');
  }

  // 分红率 / 累计分红率 / 平均股息率：严格核验分红覆盖证据，股本推算显式标注 is_estimated。
  function sharesAtDate(ymd) {
    const target = String(ymd || '').replace(/-/g, '');
    for (let i = valuations.length - 1; i >= 0; i--) {
      const v = valuations[i];
      if (target && String(v.trade_date || '') > target) continue;
      const ts = contract.finite(v.total_share);
      if (ts !== null && ts > 0) return ts * 10000;
      const mv = contract.finite(v.total_mv);
      const cl = contract.finite(v.close);
      if (mv !== null && mv > 0 && cl !== null && cl > 0) return (mv * 10000) / cl;
    }
    return null;
  }

  const dividendByYear = new Map();
  const unconvertibleDividendYears = new Set();
  let dividendEstimatedAny = false;
  let dividendEstimationBasis = null;
  for (const row of dividends) {
    const exRaw = row.ex_date || row.pay_date || row.ann_date || null;
    if (!exRaw) continue;
    const { year, inferred } = resolveEventFiscalYear(row);
    if (!year) continue;
    const eventCurrency = String(row.currency || row.currency_code || currency).toUpperCase();
    const explicitTotal = contract.finite(
      row.total_dividend != null ? row.total_dividend : (row.total_amount != null ? row.total_amount : row.total_cash_amount)
    );
    const cashPerShare = contract.finite(row.cash_per_share != null ? row.cash_per_share : row.cash_div_tax);
    let totalInMarket = null;
    let isEstimated = false;
    if (explicitTotal !== null && explicitTotal >= 0) {
      totalInMarket = convertToMarketCurrency(explicitTotal, eventCurrency);
    } else {
      const shares = sharesAtDate(exRaw);
      if (cashPerShare !== null && cashPerShare >= 0 && shares !== null && shares > 0) {
        totalInMarket = convertToMarketCurrency(cashPerShare * shares, eventCurrency);
        isEstimated = true;
        dividendEstimatedAny = true;
        dividendEstimationBasis = 'estimated_from_shares';
      }
    }
    if (totalInMarket === null) {
      if ((explicitTotal !== null && explicitTotal > 0) || (cashPerShare !== null && cashPerShare > 0)) {
        unconvertibleDividendYears.add(year);
      }
      continue;
    }
    const prev = dividendByYear.get(year) || { total: 0, is_estimated: false, fiscal_year_inferred: false, details: [] };
    prev.total += totalInMarket;
    prev.is_estimated = prev.is_estimated || isEstimated;
    prev.fiscal_year_inferred = prev.fiscal_year_inferred || inferred;
    prev.details.push({
      ex_date: String(exRaw),
      cash_per_share: contract.finite(row.cash_per_share != null ? row.cash_per_share : row.cash_div_tax),
      amount: totalInMarket,
      is_estimated: isEstimated,
      basis: isEstimated ? 'estimated_from_shares' : 'official_total',
      fiscal_year_inferred: inferred,
    });
    dividendByYear.set(year, prev);
  }

  const validAnnualProfits = annual
    .filter(g => !g.currency_unverified && g.profit !== null)
    .map(g => ({ year: String(g.period_end).slice(0, 4), profit: convertToMarketCurrency(g.profit, g.currency) }))
    .filter(item => item.profit !== null);

  const divCov = data.dividendCoverage && typeof data.dividendCoverage === 'object' ? data.dividendCoverage : null;
  const dividendSyncDate = divCov && divCov.endDate
    ? String(divCov.endDate).slice(0, 10)
    : (data.dividendSyncDate ? String(data.dividendSyncDate).slice(0, 10) : null);
  const dividendCovStart = divCov && divCov.startDate ? String(divCov.startDate).slice(0, 10) : null;
  const coverageExplicitlyIncomplete = Boolean(divCov && divCov.complete !== true);
  // 仅有单点水位而无覆盖起止区间时，不能证明整个目标财年或历史区间已完成分红采集。
  const dividendRangeVerified = Boolean(!coverageExplicitlyIncomplete && divCov && divCov.complete === true && dividendCovStart && dividendSyncDate);
  const latestAnnualEnd = latestAnnual ? String(latestAnnual.period_end).slice(0, 10) : '';
  const latestAnnualStart = fiscalYearStartOf(latestAnnualEnd);
  const earliestAnnualEnd = annual.length ? String(annual[annual.length - 1].period_end).slice(0, 10) : '';
  const earliestAnnualStart = fiscalYearStartOf(earliestAnnualEnd);
  const latestYearCoverageVerified = Boolean(
    dividendRangeVerified
    && (!latestAnnualEnd || dividendSyncDate >= latestAnnualEnd)
    && (!latestAnnualStart || dividendCovStart <= latestAnnualStart)
  );
  const fullRangeCoverageVerified = Boolean(
    dividendRangeVerified
    && (!latestAnnualEnd || dividendSyncDate >= latestAnnualEnd)
    && (!earliestAnnualStart || dividendCovStart <= earliestAnnualStart)
  );
  const latestAnnualYear = latestAnnual ? String(latestAnnual.period_end).slice(0, 4) : '';
  const latestAnnualProfitInMarket = latestAnnual && !latestAnnual.currency_unverified && latestAnnual.profit !== null
    ? convertToMarketCurrency(latestAnnual.profit, latestAnnual.currency)
    : null;

  let payoutRatio = null;
  let payoutRatioStatus = contract.metric(null, contract.FIELD_STATUS.SOURCE_UNAVAILABLE, 'dividend_coverage_unverified');
  let cumulativePayoutRatio = null;
  let cumulativePayoutStatus = contract.metric(null, contract.FIELD_STATUS.SOURCE_UNAVAILABLE, 'dividend_coverage_unverified');
  let averageDividendYield = null;
  let averageDividendYieldStatus = contract.metric(null, contract.FIELD_STATUS.SOURCE_UNAVAILABLE, 'dividend_coverage_unverified');
  let cumulativeDividendTotal = dividend12m.totalAmount;
  let cumulativeProfitTotal = null;

  if (validAnnualProfits.length > 0) {
    cumulativeProfitTotal = validAnnualProfits.reduce((sum, item) => sum + item.profit, 0);
  }

  // 官方年报已直接给出分红金额（ps.da）与分红率（ps.d_np_r）。它们是来源事实，
  // 优先于本地分红事件采集；后者覆盖未核验时仍可算出累计分红率（反馈 #115）。
  const sourceAnnualDividends = annual
    .filter(group => !group.currency_unverified && contract.finite(group.profit) !== null
      && contract.finite(group.dividendAmount) !== null)
    .map(group => ({
      year: String(group.period_end).slice(0, 4),
      profit: convertToMarketCurrency(group.profit, group.currency),
      dividend: convertToMarketCurrency(group.dividendAmount, group.currency),
    }))
    .filter(item => item.profit !== null && item.dividend !== null && item.dividend >= 0);
  const sourceDividendYears = new Set(sourceAnnualDividends.map(item => item.year));
  const sourceCumulativeProfit = sourceAnnualDividends.reduce((sum, item) => sum + item.profit, 0);
  const sourceCumulativeDividend = sourceAnnualDividends.reduce((sum, item) => sum + item.dividend, 0);
  const latestSourceDividend = sourceAnnualDividends.find(item => item.year === latestAnnualYear);
  // 宽表 `_r` 科目按官方小数比例存库（0.35 表示 35%），与三表页面 value*100 的口径一致。
  const sourcePayoutRaw = latestAnnual && !latestAnnual.currency_unverified ? contract.finite(latestAnnual.payoutRatioSource) : null;
  const sourcePayout = sourcePayoutRaw !== null ? Math.max(0, sourcePayoutRaw) : null;

  let payoutFromSource = false;
  if (sourcePayout !== null || (latestSourceDividend && latestSourceDividend.dividend >= 0)) {
    payoutFromSource = true;
    if (latestAnnualProfitInMarket !== null && latestAnnualProfitInMarket <= 0) {
      const latestDividendKnown = latestSourceDividend ? latestSourceDividend.dividend : 0;
      if (latestDividendKnown > 0) {
        payoutRatioStatus = contract.metric(null, contract.FIELD_STATUS.NOT_APPLICABLE, '最近年报亏损但存在分红，分红率不适用');
      } else {
        // 反馈 #115：年报亏损且官方年报明确无分红时，分红率按 0% 展示，不再写「不适用」。
        payoutRatio = 0;
        payoutRatioStatus = { value: 0, status: contract.FIELD_STATUS.AVAILABLE, reason: 'latest_annual_loss_zero_dividend' };
      }
    } else if (sourcePayout !== null) {
      payoutRatio = sourcePayout;
      payoutRatioStatus = { value: payoutRatio, status: contract.FIELD_STATUS.AVAILABLE, reason: 'source_reported' };
    } else if (latestSourceDividend && latestAnnualProfitInMarket !== null && latestAnnualProfitInMarket > 0) {
      payoutRatio = latestSourceDividend.dividend / latestAnnualProfitInMarket;
      payoutRatioStatus = { value: payoutRatio, status: contract.FIELD_STATUS.AVAILABLE, reason: 'source_reported' };
    }
  }

  let cumulativeFromSource = false;
  if (sourceAnnualDividends.length > 0) {
    cumulativeFromSource = true;
    cumulativeDividendTotal = sourceCumulativeDividend;
    if (sourceCumulativeProfit > 0) {
      cumulativePayoutRatio = sourceCumulativeDividend / sourceCumulativeProfit;
      cumulativePayoutStatus = {
        value: cumulativePayoutRatio, status: contract.FIELD_STATUS.AVAILABLE,
        reason: sourceDividendYears.size === validAnnualProfits.length ? 'source_reported' : 'source_reported_partial_years',
        covered_years: sourceDividendYears.size,
      };
    } else if (sourceCumulativeProfit <= 0) {
      if (sourceCumulativeDividend === 0) {
        cumulativePayoutRatio = 0;
        cumulativePayoutStatus = { value: 0, status: contract.FIELD_STATUS.AVAILABLE, reason: 'cumulative_loss_zero_dividend' };
        averageDividendYield = 0;
        averageDividendYieldStatus = { value: 0, status: contract.FIELD_STATUS.AVAILABLE, reason: 'cumulative_loss_zero_dividend' };
      } else {
        cumulativePayoutStatus = contract.metric(null, contract.FIELD_STATUS.NOT_APPLICABLE, '历史累计亏损，不适用');
        averageDividendYieldStatus = contract.metric(null, contract.FIELD_STATUS.NOT_APPLICABLE, '历史累计亏损，不适用');
      }
    }
  }

  if (dividends.length === 0) {
    if (latestYearCoverageVerified && contract.finite(latest.dv_ttm) === 0) {
      if (!payoutFromSource) {
        if (latestAnnualProfitInMarket !== null && latestAnnualProfitInMarket > 0) {
          payoutRatio = 0;
          payoutRatioStatus = { value: 0, status: contract.FIELD_STATUS.AVAILABLE, reason: 'verified_zero_dividend' };
        } else if (latestAnnualProfitInMarket !== null && latestAnnualProfitInMarket <= 0) {
          // 反馈 #115：已核验零分红时，亏损年度也按 0% 展示。
          payoutRatio = 0;
          payoutRatioStatus = { value: 0, status: contract.FIELD_STATUS.AVAILABLE, reason: 'verified_zero_dividend_on_loss' };
        } else {
          payoutRatioStatus = contract.metric(null, contract.FIELD_STATUS.NOT_APPLICABLE, 'latest_annual_loss_or_missing');
        }
      }
      if (!cumulativeFromSource && fullRangeCoverageVerified && cumulativeProfitTotal !== null) {
        if (cumulativeProfitTotal > 0) {
          cumulativePayoutRatio = 0;
          cumulativeDividendTotal = 0;
          cumulativePayoutStatus = { value: 0, status: contract.FIELD_STATUS.AVAILABLE, reason: 'verified_zero_dividend' };
          averageDividendYield = 0;
          averageDividendYieldStatus = { value: 0, status: contract.FIELD_STATUS.AVAILABLE, reason: 'verified_zero_dividend' };
        } else if (cumulativeProfitTotal <= 0) {
          cumulativePayoutRatio = 0;
          cumulativeDividendTotal = 0;
          cumulativePayoutStatus = { value: 0, status: contract.FIELD_STATUS.AVAILABLE, reason: 'cumulative_loss_zero_dividend' };
          averageDividendYield = 0;
          averageDividendYieldStatus = { value: 0, status: contract.FIELD_STATUS.AVAILABLE, reason: 'cumulative_loss_zero_dividend' };
        }
      }
    }
  } else {
    const hasLatestYearEvents = Boolean(latestAnnualYear && dividendByYear.has(latestAnnualYear));
    const latestYearUnconvertible = Boolean(latestAnnualYear && unconvertibleDividendYears.has(latestAnnualYear));
    if (!payoutFromSource) {
      if (latestYearUnconvertible) {
        payoutRatioStatus = contract.metric(null, contract.FIELD_STATUS.SOURCE_UNAVAILABLE, 'fx_rate_missing');
      } else if (hasLatestYearEvents || latestYearCoverageVerified) {
        const latestYearDiv = hasLatestYearEvents ? dividendByYear.get(latestAnnualYear).total : 0;
        if (latestAnnualProfitInMarket !== null && latestAnnualProfitInMarket > 0) {
          payoutRatio = latestYearDiv / latestAnnualProfitInMarket;
          payoutRatioStatus = {
            ...contract.metric(payoutRatio, contract.FIELD_STATUS.AVAILABLE, dividendEstimatedAny ? '按股本估算' : null),
            is_estimated: dividendEstimatedAny,
            basis: dividendEstimationBasis,
          };
        } else if (latestAnnualProfitInMarket !== null && latestAnnualProfitInMarket <= 0) {
          if (latestYearDiv === 0) {
            // 反馈 #115：亏损年度且当期无分红，按 0% 展示。
            payoutRatio = 0;
            payoutRatioStatus = { value: 0, status: contract.FIELD_STATUS.AVAILABLE, reason: 'latest_annual_loss_zero_dividend' };
          } else {
            payoutRatioStatus = contract.metric(null, contract.FIELD_STATUS.NOT_APPLICABLE, '最近年报亏损但存在分红，分红率不适用');
          }
        }
      }
    }

    const anyYearUnconvertible = unconvertibleDividendYears.size > 0;
    const allYearsHaveEvents = validAnnualProfits.length > 0 && validAnnualProfits.every(item => dividendByYear.has(item.year));
    if (!cumulativeFromSource) {
      if (anyYearUnconvertible) {
        cumulativePayoutStatus = contract.metric(null, contract.FIELD_STATUS.SOURCE_UNAVAILABLE, 'fx_rate_missing');
        averageDividendYieldStatus = contract.metric(null, contract.FIELD_STATUS.SOURCE_UNAVAILABLE, 'fx_rate_missing');
      } else if (validAnnualProfits.length > 0 && (fullRangeCoverageVerified || allYearsHaveEvents)) {
        let sumDiv = 0;
        for (const item of validAnnualProfits) {
          const entry = dividendByYear.get(item.year);
          if (entry) sumDiv += entry.total;
        }
        cumulativeDividendTotal = sumDiv;
        if (cumulativeProfitTotal > 0) {
          cumulativePayoutRatio = sumDiv / cumulativeProfitTotal;
          cumulativePayoutStatus = {
            ...contract.metric(cumulativePayoutRatio, contract.FIELD_STATUS.AVAILABLE, dividendEstimatedAny ? '按股本估算' : null),
            is_estimated: dividendEstimatedAny,
            basis: dividendEstimationBasis,
          };
          const ttmProfitInMarket = ttm.value !== null
            ? convertToMarketCurrency(ttm.value, (latestInterim || latestAnnual).currency)
            : null;
          if (cap.value > 0 && ttmProfitInMarket !== null) {
            averageDividendYield = cumulativePayoutRatio * (ttmProfitInMarket / cap.value);
            averageDividendYieldStatus = {
              ...contract.metric(averageDividendYield, contract.FIELD_STATUS.AVAILABLE, dividendEstimatedAny ? '按股本估算' : null),
              is_estimated: dividendEstimatedAny,
              basis: dividendEstimationBasis,
            };
          } else {
            averageDividendYieldStatus = contract.metric(null, contract.FIELD_STATUS.MISSING, 'missing_ttm_profit_or_cap');
          }
        } else if (cumulativeProfitTotal !== null && cumulativeProfitTotal <= 0 && sumDiv === 0) {
          cumulativePayoutRatio = 0;
          cumulativePayoutStatus = { value: 0, status: contract.FIELD_STATUS.AVAILABLE, reason: 'cumulative_loss_zero_dividend' };
          averageDividendYield = 0;
          averageDividendYieldStatus = { value: 0, status: contract.FIELD_STATUS.AVAILABLE, reason: 'cumulative_loss_zero_dividend' };
        } else {
          cumulativePayoutStatus = contract.metric(null, contract.FIELD_STATUS.NOT_APPLICABLE, '历史累计亏损，不适用');
          averageDividendYieldStatus = contract.metric(null, contract.FIELD_STATUS.NOT_APPLICABLE, '历史累计亏损，不适用');
        }
      }
    }
  }

  // 平均股息率＝累计分红率 × TTM 盈利收益率；累计分红率为 0 时结果必为 0，
  // 不因利润为负或缺少 TTM 再变回「--」（反馈 #115）。
  if (cumulativePayoutRatio === 0) {
    averageDividendYield = 0;
    averageDividendYieldStatus = { value: 0, status: contract.FIELD_STATUS.AVAILABLE, reason: 'zero_cumulative_payout' };
  } else if (cumulativePayoutRatio !== null && averageDividendYieldStatus.value === null) {
    const ttmProfitInMarket = ttm.value !== null
      ? convertToMarketCurrency(ttm.value, (latestInterim || latestAnnual).currency)
      : null;
    if (cap.value > 0 && ttmProfitInMarket !== null && ttmProfitInMarket <= 0) {
      // 反馈 #115：TTM 利润为负时平均股息率没有可解释的经济含义，按 0% 展示。
      averageDividendYield = 0;
      averageDividendYieldStatus = { value: 0, status: contract.FIELD_STATUS.AVAILABLE, reason: 'non_positive_ttm_profit_zero_yield' };
    } else if (cap.value > 0 && ttmProfitInMarket !== null) {
      averageDividendYield = cumulativePayoutRatio * (ttmProfitInMarket / cap.value);
      averageDividendYieldStatus = { value: averageDividendYield, status: contract.FIELD_STATUS.AVAILABLE, reason: null };
    } else {
      averageDividendYieldStatus = contract.metric(null, contract.FIELD_STATUS.MISSING, 'missing_ttm_profit_or_cap');
    }
  }

  const latestBalanceForSafety = consolidatedFacts.find(group => ofKind(group, 'balance') && !group.currency_unverified) || null;
  const effectiveDividendYield = dividend12m.yield.value == null ? sourceDividendYield : dividend12m.yield.value;
  const liabilitiesInMarket = latestBalanceForSafety && latestBalanceForSafety.liabilities !== null
    ? convertToMarketCurrency(latestBalanceForSafety.liabilities, latestBalanceForSafety.currency)
    : null;
  const marketCapToLiability = cap.value > 0 && liabilitiesInMarket !== null && liabilitiesInMarket > 0
    ? cap.value / liabilitiesInMarket
    : null;

  // 财务安全性（反馈 #118）：港股三表已有货币资金、短期投资、借款/债券/租赁负债与利润总额、利息支出，
  // 过去这些字段没有映射，导致净现金安全额与利息保障倍数被硬编码为 null。
  const safetyBalance = latestBalanceForSafety || latestAnnualBalance || null;
  const safetyBalanceComplete = Boolean(safetyBalance && safetyBalance.balance_coverage && safetyBalance.balance_coverage.complete === true);
  const safetyInMarket = value => (safetyBalance && value !== null && value !== undefined
    ? convertToMarketCurrency(value, safetyBalance.currency) : null);
  const cash = safetyBalance ? safetyInMarket(safetyBalance.cash) : null;
  const shortInvestments = safetyBalance ? safetyInMarket(safetyBalance.shortTermInvestments) : null;
  const debtParts = safetyBalance ? [
    safetyBalance.shortTermBorrowings, safetyBalance.longTermBorrowings,
    safetyBalance.bondsPayable, safetyBalance.convertibleBonds, safetyBalance.leaseLiabilities,
  ].map(safetyInMarket).filter(value => value !== null) : [];
  let netCash = null;
  let netCashStatus = contract.metric(null, contract.FIELD_STATUS.MISSING, 'missing_balance_sheet');
  if (safetyBalance && cash !== null) {
    if (debtParts.length) {
      netCash = cash + (shortInvestments || 0) - debtParts.reduce((sum, value) => sum + value, 0);
      netCashStatus = contract.metric(netCash, contract.FIELD_STATUS.AVAILABLE);
    } else if (safetyBalanceComplete) {
      // 已请求且完整但来源未披露借款科目：按无有息负债处理，仍保留“已核验未披露”的依据。
      netCash = cash + (shortInvestments || 0);
      netCashStatus = { value: netCash, status: contract.FIELD_STATUS.AVAILABLE, reason: 'interest_debt_not_disclosed_treated_as_zero' };
    } else {
      netCashStatus = contract.metric(null, contract.FIELD_STATUS.SOURCE_UNAVAILABLE, 'interest_debt_not_collected');
    }
  }

  const safetyIncome = latestAnnual && !latestAnnual.currency_unverified ? latestAnnual : null;
  const totalProfitInMarket = safetyIncome && safetyIncome.totalProfit !== null
    ? convertToMarketCurrency(safetyIncome.totalProfit, safetyIncome.currency) : null;
  const interestExpenseInMarket = safetyIncome && safetyIncome.interestExpense !== null
    ? convertToMarketCurrency(safetyIncome.interestExpense, safetyIncome.currency) : null;
  let interestCoverage = null;
  let interestCoverageStatus = contract.metric(null, contract.FIELD_STATUS.MISSING, 'missing_annual_report');
  if (safetyIncome && totalProfitInMarket !== null && interestExpenseInMarket !== null) {
    if (interestExpenseInMarket <= 0) {
      interestCoverageStatus = contract.metric(null, contract.FIELD_STATUS.NOT_APPLICABLE, 'no_interest_expense');
    } else {
      interestCoverage = (totalProfitInMarket + interestExpenseInMarket) / interestExpenseInMarket;
      interestCoverageStatus = contract.metric(interestCoverage, contract.FIELD_STATUS.AVAILABLE);
    }
  } else if (safetyIncome && (safetyIncome.totalProfit === null || safetyIncome.interestExpense === null)) {
    interestCoverageStatus = contract.metric(null, contract.FIELD_STATUS.SOURCE_UNAVAILABLE, 'interest_or_profit_not_disclosed');
  }

  // 经营现金流均值（反馈 #118）：只使用同币种、已核验的年度现金流报告；自由现金流因港股
  // 官方现金流只有 7 个汇总项、不含资本开支，继续保持不可计算并给出逐项原因。
  const annualCashflowFacts = consolidatedFacts
    .filter(group => isAnnual(group) && ofKind(group, 'cashflow') && !group.currency_unverified && group.operating !== null)
    .sort((a, b) => String(b.period_end).localeCompare(String(a.period_end)));
  // 均值保持财报原币：同一公司的年度现金流通常同币种；币种变化时只取与最新年度同币种的行，
  // 不把 CNY/USD 金额直接相加。
  const cashflowCurrency = latestAnnualCashflow ? latestAnnualCashflow.currency : null;
  const operatingValues = annualCashflowFacts
    .filter(group => group.currency === cashflowCurrency && group.operating !== null)
    .map(group => contract.finite(group.operating))
    .filter(value => value !== null);
  const averageOf = (values, count) => {
    const slice = values.slice(0, count);
    return slice.length ? slice.reduce((sum, value) => sum + value, 0) / slice.length : null;
  };
  const average3Operating = averageOf(operatingValues, 3);
  const average5Operating = averageOf(operatingValues, 5);
  const freeCashReason = capexMissing ? 'capex_not_disclosed' : 'capex_or_operating_missing';

  // 图表标为「前复权股价」：有官方复权因子时用 close×factor；没有因子时保留原始收盘价，
  // 由 priceSeriesStatus 标注未复权，不能把缺失因子伪装成已复权。
  const historySeries = valuations.map(row => {
    const close = contract.finite(row.close);
    const factor = contract.finite(row.adj_factor);
    return {
      date: row.trade_date,
      price: close !== null && factor !== null && factor > 0 ? close * factor : close,
      pe: contract.finite(row.pe_ttm),
      pb: contract.finite(row.pb),
    };
  });
  const stabilityYears = annual.slice(0, 20).map(group => {
    const yr = String(group.period_end).slice(0, 4);
    const divEntry = dividendByYear.get(yr);
    // 图表把利润与分红画在同一柱状图，两者必须同币种；统一折算到交易币种（港股为 HKD）。
    // 原实现只折算分红、利润保留财报原币，CNY 财报 + HKD 市值会把两种量纲画在一起。
    const profitInMarket = !group.currency_unverified && group.profit !== null
      ? convertToMarketCurrency(group.profit, group.currency)
      : null;
    const divAmt = divEntry ? divEntry.total : (dividendRangeVerified && contract.finite(latest.dv_ttm) === 0 ? 0 : null);
    const yrPayout = divAmt !== null && profitInMarket !== null && profitInMarket > 0 ? divAmt / profitInMarket : null;
    return {
      year: yr,
      report_ann_date: group.announced_at || '',
      profit: profitInMarket,
      profit_currency: currency,
      dividend: divAmt,
      dividend_currency: currency,
      payout_ratio: yrPayout,
      annual_payout_ratio: yrPayout,
      is_estimated: divEntry ? divEntry.is_estimated : false,
      dividend_details: divEntry ? divEntry.details : [],
    };
  });
  const fieldStatus = {
    market_cap: statusOf(cap), pe_ttm: statusOf(contract.metric(peTtm)),
    pe_static: statusOf(peStaticStatus), pe_forecast: statusOf(peForecastStatus), pe_three_year_avg: statusOf(peThreeYearAvgStatus),
    pb: statusOf(contract.metric(pb)), pb_ex_goodwill: statusOf(pbExGoodwillStatus),
    annualized_return_since_listing: { ...statusOf(annualizedReturnStatus), return_start_mode: returnStartMode, return_start_date: returnStartDate },
    ttm_profit: { ...statusOf(ttm), currency: ttm.value === null ? null : (latestInterim || latestAnnual).currency }, dividend_yield: statusOf(dividend12m.yield),
    payout_ratio: payoutRatioStatus, cumulative_payout_ratio: cumulativePayoutStatus, average_dividend_yield: averageDividendYieldStatus,
    free_cashflow: statusOf(freeCash), net_cash: netCashStatus, interest_coverage: interestCoverageStatus,
    pe_percentile: { value: pePercentile.value, status: pePercentile.status },
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
  const reportCurrency = latestFact && latestFact.currency ? String(latestFact.currency).toUpperCase() : null;
  const currencyLabel = currencyLabelOf(currency);
  const reportCurrencyLabel = reportCurrency ? currencyLabelOf(reportCurrency) : null;
  // 页面上金额与图表统一使用交易币种（港股为 HKD）；财报原币只作为口径说明，
  // 不再强制折算成人民币导致缺汇率时整块指标变「--」。
  const currencyNote = reportCurrency && reportCurrency !== currency
    ? `交易币种：${currencyLabel}；财报币种：${reportCurrencyLabel}（跨币种比值按已落库汇率折算）`
    : `交易与财报币种：${currencyLabel}`;

  return {
    ts_code: options.tsCode, name: meta.name || options.tsCode, market: 'HK',
    industry: meta.industry || '', list_date: meta.list_date || '',
    industry_info: { name: meta.industry || '', system: '恒生行业分类', level: '', path: [] },
    actual_controller: null,
    latest_report: latestFact ? {
      end_date: latestFact.period_end,
      ann_date: latestFact.announced_at || '',
      // 反馈 #116：semiannual/annual/q1/q3 统一显示中文，不再把英文报告期直接放到页面。
      type: financialPeriodLabel(latestFact.period_type) || (isAnnual(latestFact) ? '年报' : '报告期类型未标注'),
      currency: latestFact.currency, accounting_standard: 'HKFRS',
      version: latestFact.source_version, report_ids: latestFact.report_ids,
    } : { end_date: '', ann_date: '', type: '资料未就绪' },
    performance_forecast: null,
    as_of: options.isoToday || null,
    latest_market_trade_date: latest.trade_date || null,
    quote: { price, currency, currency_name: currencyNameOf(currency), unit: currency, quote_time: null, source: 'local_daily_bars' },
    display: {
      market: 'HK', currency, currency_name: currencyNameOf(currency), currency_label: currencyLabel,
      report_currency: reportCurrency, report_currency_name: reportCurrency ? currencyNameOf(reportCurrency) : null,
      report_currency_label: reportCurrencyLabel, currency_note: currencyNote,
      market_cap_label: '总市值（来源已验证范围）',
      circulating_market_cap_label: '流通市值', share_scope: cap.scope || null,
      field_status: fieldStatus, analysis_version: version, formula_version: FORMULA_VERSION,
      statement_analysis_versions: statementAnalysisVersions,
      data_dates: { trade_date: latest.trade_date || null, report_end: latestFact ? latestFact.period_end : null },
    },
    valuation: {
      market_cap: cap.value, a_share_market_cap: null,
      circulating_market_cap: null, free_float_market_cap: null,
      annualized_return_since_listing: annualizedReturnSinceListing, return_start_date: returnStartDate,
      return_start_mode: returnStartMode,
      pe_ttm: peTtm, pe_static: peStatic, pe_forecast: peForecast, pe_forecast_basis: peForecastBasis, pe_three_year_avg: peThreeYearAvg,
      pb, pb_ex_goodwill: pbExGoodwill,
      dividend_yield: effectiveDividendYield,
      dividend_yield_source: dividend12m.yield.value == null ? 'source_reported' : 'implemented_events',
      payout_ratio: payoutRatio, cumulative_payout_ratio: cumulativePayoutRatio, average_dividend_yield: averageDividendYield,
      cumulative_dividend: cumulativeDividendTotal, cumulative_profit: cumulativeProfitTotal,
      dividend_is_estimated: dividendEstimatedAny, dividend_basis: dividendEstimationBasis,
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
      history: historySeries, bands: {}, current: {
        price: historySeries.length && historySeries[historySeries.length - 1].price !== null
          ? historySeries[historySeries.length - 1].price : price,
        pe: peTtm, pb,
      },
      note: '港股正估值分位只用可比的有效正样本；当前值为非正时不输出。价格与估值独立读取，缺复权因子时标注未复权且不计算依赖复权的分位。',
    },
    growth: { ten_year_average: {}, periods: {}, latest_interim_yoy: null, status: contract.FIELD_STATUS.INSUFFICIENT_HISTORY },
    safety: {
      net_cash: netCash, interest_coverage: interestCoverage, market_cap_to_liability: marketCapToLiability,
      net_cash_reason: netCashStatus.status === contract.FIELD_STATUS.AVAILABLE ? netCashStatus.reason : (netCashStatus.reason || 'net_cash_unavailable'),
      interest_coverage_reason: interestCoverageStatus.status === contract.FIELD_STATUS.AVAILABLE ? null : interestCoverageStatus.reason,
      report_end_date: safetyIncome ? safetyIncome.period_end : (latestFact ? latestFact.period_end : null),
      industry_note: options.financial ? '金融公司按已验证适用指标展示，不套普通企业结论' : '',
    },
    cashflow: {
      status: freeCash.status,
      latest_year: {
        end_date: latestAnnualCashflow ? latestAnnualCashflow.period_end : null,
        currency: latestAnnualCashflow ? latestAnnualCashflow.currency : null,
        operating: operatingLatest, free: freeCash.value,
        free_reason: freeCash.status === contract.FIELD_STATUS.AVAILABLE ? null : freeCashReason,
      },
      average_3y: { operating: average3Operating, free: null, free_reason: 'capex_not_disclosed', currency: cashflowCurrency },
      average_5y: { operating: average5Operating, free: null, free_reason: 'capex_not_disclosed', currency: cashflowCurrency },
      note: capexMissing ? '港股官方现金流科目仅提供7个汇总项，未披露资本开支；经营现金流与均值可算，自由现金流不可计算。' : '',
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
  const { datasetScope, getDatasetCursors } = require('./datasetCursors');
  const [base, facts, hkdRate, usdRate, cursors, refreshCursors] = await Promise.all([
    stockAnalysisRepository.loadAnalysisInputs({ tsCode }),
    readHkReportFacts(tsCode),
    // 仓储签名是对象参数；2026-11-25 反馈 #100 原实现误传三位置参数，查询恒为空，
    // 导致所有「财报币种 ≠ HKD」的港股静默落入 fx_rate_missing。
    fxRateRepository.readLatestRatePairUpTo({ baseCurrency: 'HKD', quoteCurrency: 'CNY', date: '9999-12-31' }).catch(() => null),
    fxRateRepository.readLatestRatePairUpTo({ baseCurrency: 'USD', quoteCurrency: 'CNY', date: '9999-12-31' }).catch(() => null),
    getDatasetCursors(datasetScope('hk', tsCode), ['dividends']).catch(() => new Map()),
    getDatasetCursors(datasetScope('hk_stock_analysis', tsCode), ['dividends']).catch(() => new Map()),
  ]);
  const primaryCursor = cursors && typeof cursors.get === 'function' ? cursors.get('dividends') : null;
  const fallbackCursor = refreshCursors && typeof refreshCursors.get === 'function' ? refreshCursors.get('dividends') : null;
  const hasCompletePayload = row => Boolean(row && !row.last_error && row.cursor_payload && row.cursor_payload.complete === true);
  const divCursor = hasCompletePayload(primaryCursor) ? primaryCursor : (hasCompletePayload(fallbackCursor) ? fallbackCursor : (primaryCursor || fallbackCursor));
  const dividendSyncDate = divCursor && !divCursor.last_error && divCursor.last_success_date
    ? String(divCursor.last_success_date).slice(0, 10)
    : null;
  const dividendSyncVerified = Boolean(dividendSyncDate);
  const cursorPayload = divCursor && divCursor.cursor_payload && typeof divCursor.cursor_payload === 'object'
    ? divCursor.cursor_payload : {};
  const rawStart = divCursor && (
    divCursor.coverage_start_date || divCursor.start_date || divCursor.startDate
    || cursorPayload.coverage_start_date || cursorPayload.start_date || cursorPayload.startDate || cursorPayload.fromDate
  );
  const rawEnd = divCursor && (
    divCursor.coverage_end_date || divCursor.end_date || divCursor.endDate
    || cursorPayload.coverage_end_date || cursorPayload.end_date || cursorPayload.endDate || cursorPayload.targetDate
  );
  const cursorStart = rawStart ? String(rawStart).slice(0, 10) : null;
  const cursorEnd = rawEnd ? String(rawEnd).slice(0, 10) : dividendSyncDate;
  const cursorComplete = cursorPayload.complete === true;
  const dividendCoverage = base.dividendCoverage
    || (dividendSyncVerified && cursorStart && cursorEnd
      ? { complete: cursorComplete, startDate: cursorStart, endDate: cursorEnd }
      : null);
  const fxToCny = {};
  if (hkdRate && Number(hkdRate.rate) > 0) fxToCny.HKD = Number(hkdRate.rate);
  if (usdRate && Number(usdRate.rate) > 0) fxToCny.USD = Number(usdRate.rate);
  return { meta: base.meta, valuations: base.valuations, dividends: base.dividends, events: base.events, reportFacts: facts, fxToCny, dividendSyncVerified, dividendSyncDate, dividendCoverage };
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

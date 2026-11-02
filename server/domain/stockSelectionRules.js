// 投资策略选股中心：纯规则计算（方案第 4、5.1、5.2 节）。
// 本文件只接收事实对象做判断，不含 SQL、不联网、不读环境变量；仓储、服务与任务不得把取数逻辑写进这里。
// 规则集 investment_essentials_adapted_v1：个股硬过滤为 R01/R02/R04/R05 四项，R03（审计机构）已从方案删除。
'use strict';

const STATUS = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  PENDING: 'PENDING',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
});

const STRATEGY_CODE = 'investment_essentials_adapted_v1';

// 默认口径写进参数并随策略版本落库；页面展示的阈值全部从这里取，禁止前端另写一份。
const DEFAULT_PARAMS = Object.freeze({
  maxPb: 1.5,
  marketMaxPb: 2,
  pbLookbackYears: 10,
  pbAboveOne: 1,
  minEquityCny: 10000000000,
  dividendWindowMonths: 12,
  slotsPerMarket: 30,
  industryLimitRatio: 0.2,
  anomalyLookbackYears: 10,
  requiredFiscalYears: 11,
  formulaVersion: 'selection-formula-v1',
  adapterVersion: 'selection-adapter-v1',
  riskVersion: 'selection-risk-v1',
  industryVersion: 'selection-industry-v1',
});

const RULE_CODES = Object.freeze(['R01', 'R02', 'R04', 'R05']);

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function rule(code, status, fields) {
  return Object.assign({ code, status }, fields || {});
}

// R01 当前 PB：0 < PB ≤ maxPb；PB 为空、非正或非有限值属于数据异常，不能当作"便宜"。
function evaluateCurrentPb(facts, params) {
  const pb = num(facts.pb);
  if (pb === null || pb <= 0) {
    return {
      rule: rule('R01', STATUS.PENDING, {
        value: pb, threshold: params.maxPb,
        reason: pb === null ? 'pb_unavailable' : 'pb_non_positive',
      }),
      pb,
    };
  }
  const passed = pb <= params.maxPb;
  return {
    rule: rule('R01', passed ? STATUS.PASS : STATUS.FAIL, {
      value: pb, threshold: params.maxPb,
      reason: passed ? null : 'pb_above_threshold',
    }),
    pb,
  };
}

// R02 十年 PB：窗口内至少一条有效 PB 严格大于 1 即成立（"存在一次"正证）。
// 找不到正证时，只有"应有历史完整"才能判不通过，否则待补。
function evaluateHistoricalPb(facts) {
  const window = facts.pbWindow || {};
  const maxPb = num(window.maxPb);
  const coveredDays = num(window.coveredDays) || 0;
  const marketDays = num(window.marketDays) || 0;
  const calendarDays = num(window.calendarDays) || 0;
  const evidence = { maxPb, coveredDays, marketDays, calendarDays, threshold: 1 };
  if (maxPb !== null && maxPb > 1) {
    return { rule: rule('R02', STATUS.PASS, Object.assign({ value: maxPb, reason: null }, evidence)), maxPb };
  }
  // 市场层历史本身不完整时，个股"没找到正证"不能证明不存在。
  const marketCoverage = marketDays > 0 && calendarDays > 0 ? marketDays / calendarDays : 0;
  const instrumentCoverage = marketDays > 0 ? coveredDays / marketDays : 0;
  const historyComplete = marketCoverage >= 0.9 && instrumentCoverage >= 0.9;
  const status = historyComplete ? STATUS.FAIL : STATUS.PENDING;
  const reason = historyComplete
    ? 'no_pb_above_one_evidence'
    : (marketCoverage < 0.9 ? 'market_history_incomplete' : 'instrument_history_incomplete');
  return { rule: rule('R02', status, Object.assign({ value: maxPb, reason }, evidence)), maxPb };
}

// R04 股息率：T 前 12 个月已实施、已除息的现金股息 ÷ T 收盘价，严格大于 0。
function evaluateDividendYield(facts, params) {
  const dividend = facts.dividend || {};
  const price = num(facts.price);
  const perShare = num(dividend.ttmPerShare);
  const base = { windowStart: dividend.windowStart || null, windowEnd: dividend.windowEnd || null, count: dividend.count || 0, currency: dividend.currency || null };
  if (dividend.shareUnitUnverified) {
    return { rule: rule('R04', STATUS.PENDING, Object.assign({ value: null, reason: 'share_unit_adjustment_unverified' }, base)), yield: null };
  }
  if (price === null || price <= 0) {
    return { rule: rule('R04', STATUS.PENDING, Object.assign({ value: null, reason: 'price_unavailable' }, base)), yield: null };
  }
  if (perShare === null) {
    // 明确核验过的零分红才判不通过；没有核验证据就是缺数据。
    const status = dividend.verifiedZero ? STATUS.FAIL : STATUS.PENDING;
    return {
      rule: rule('R04', status, Object.assign({ value: null, reason: dividend.verifiedZero ? 'verified_no_cash_dividend' : 'dividend_unavailable' }, base)),
      yield: null,
    };
  }
  const value = perShare / price;
  const status = value > 0 ? STATUS.PASS : (dividend.verifiedZero ? STATUS.FAIL : STATUS.PENDING);
  return {
    rule: rule('R04', status, Object.assign({ value, reason: status === STATUS.PASS ? null : (dividend.verifiedZero ? 'verified_zero_dividend' : 'dividend_zero_unverified') }, base)),
    yield: value,
  };
}

// R05 净资产：归母权益折人民币 ≥ minEquityCny；币种未知或历史汇率缺口待补，不用现汇倒算。
function evaluateEquity(facts, params) {
  const equity = facts.equity || {};
  const amount = num(equity.amount);
  const currency = equity.currency ? String(equity.currency).toUpperCase() : null;
  const fx = facts.fx || {};
  const base = { currency, periodEnd: equity.periodEnd || null, announcedAt: equity.announcedAt || null, reportId: equity.reportId || null, threshold: params.minEquityCny };
  if (amount === null) {
    return { rule: rule('R05', STATUS.PENDING, Object.assign({ value: null, reason: 'equity_unavailable' }, base)), equityCny: null, fxRate: null, fxDate: null };
  }
  let rate = null, fxDate = null;
  if (!currency) {
    return { rule: rule('R05', STATUS.PENDING, Object.assign({ value: amount, reason: 'equity_currency_unknown' }, base)), equityCny: null, fxRate: null, fxDate: null };
  }
  if (currency === 'CNY') {
    rate = 1; fxDate = equity.periodEnd || null;
  } else {
    rate = num(fx.rate);
    fxDate = fx.date || null;
    if (rate === null || rate <= 0) {
      return { rule: rule('R05', STATUS.PENDING, Object.assign({ value: amount, reason: 'fx_unavailable' }, base)), equityCny: null, fxRate: null, fxDate: null };
    }
  }
  const equityCny = amount * rate;
  const passed = equityCny >= params.minEquityCny;
  return {
    rule: rule('R05', passed ? STATUS.PASS : STATUS.FAIL, Object.assign({ value: amount, equityCny, fxRate: rate, fxDate, reason: passed ? null : 'equity_below_threshold' }, base)),
    equityCny, fxRate: rate, fxDate,
  };
}

function worstStatus(statuses) {
  if (statuses.includes(STATUS.PENDING)) return STATUS.PENDING;
  if (statuses.includes(STATUS.FAIL)) return STATUS.FAIL;
  return STATUS.PASS;
}

/**
 * 单只股票四项规则判定。
 * @returns 规则结果 + 参与排名所需的标准值；filterStatus 为四项汇总（有 PENDING 即待补，不能进正式排名池）。
 */
function evaluateInstrument(facts, params = DEFAULT_PARAMS) {
  const p = Object.assign({}, DEFAULT_PARAMS, params || {});
  const r01 = evaluateCurrentPb(facts, p);
  const r02 = evaluateHistoricalPb(facts);
  const r04 = evaluateDividendYield(facts, p);
  const r05 = evaluateEquity(facts, p);
  const rules = { R01: r01.rule, R02: r02.rule, R04: r04.rule, R05: r05.rule };
  const filterStatus = worstStatus(RULE_CODES.map(code => rules[code].status));

  const annual = facts.annual || {};
  const latest = annual.latestYear ? findYear(annual.years, annual.latestYear) : null;
  const profit = latest ? num(latest.profit) : null;
  const profitStatus = profit === null ? 'unknown' : profit > 0 ? 'profit' : profit < 0 ? 'loss' : 'zero';
  const pe = num(facts.peStatic);
  // 亏损与零利润保留事实，禁止把负 PE 当成低估值优先；PE 缺失属于待补，不混入亏损组。
  const peResolved = profitStatus === 'unknown' ? false : (profitStatus === 'profit' ? (pe !== null && pe > 0) : true);

  const exclusionReasons = [];
  if (facts.suspended) exclusionReasons.push({ code: 'suspended_at_target_date', detail: facts.suspensionReason || null });
  if (facts.delistedAtTargetDate) exclusionReasons.push({ code: 'delisted_at_target_date' });
  if (facts.riskWarning) exclusionReasons.push({ code: 'risk_warning_name', detail: facts.riskWarning });
  RULE_CODES.forEach(code => {
    const r = rules[code];
    if (r.status === STATUS.FAIL || r.status === STATUS.PENDING) {
      exclusionReasons.push({ code: `${code}:${r.reason || r.status}`, rule: code, status: r.status });
    }
  });

  return {
    instrumentId: facts.instrumentId,
    companyId: facts.companyId || null,
    code: facts.code,
    name: facts.name || null,
    market: facts.market,
    industry: facts.industry || null,
    currentPb: r01.pb,
    historicalPbMax: r02.maxPb,
    currentPe: pe,
    profitStatus,
    dividendYield: r04.yield,
    equityAmount: num((facts.equity || {}).amount),
    equityCurrency: (facts.equity || {}).currency || null,
    equityCny: r05.equityCny,
    fxRate: r05.fxRate,
    fxDate: r05.fxDate,
    rules,
    filterStatus,
    // 名次计算前置：四项通过但 PE/利润口径未定也算"待补"，不能静默混进排名。
    rankReady: filterStatus === STATUS.PASS && peResolved,
    dataQualityStatus: filterStatus === STATUS.PASS && peResolved ? 'complete' : 'partial',
    exclusionReasons,
    detail: {
      price: num(facts.price) === null ? null : num(facts.price),
      priceDate: facts.priceDate || null,
      peTtm: num(facts.peTtm),
      dividend: facts.dividend || null,
      annual: facts.annual || null,
      equity: facts.equity || null,
      pbWindow: facts.pbWindow || null,
    },
  };
}

function findYear(years, year) {
  if (!Array.isArray(years)) return null;
  return years.find(item => Number(item.year) === Number(year)) || null;
}

/**
 * 年度异常识别（方案 5.2）：Y 为截止 T 已完整披露的最新实际财年，
 * 与 Y 之前十个完整财年比较；利润或现金分红任一严格大于十年合计即排除。
 */
function evaluateAnnualAnomaly(annual, params = DEFAULT_PARAMS) {
  const p = Object.assign({}, DEFAULT_PARAMS, params || {});
  const years = Array.isArray((annual || {}).years) ? annual.years : [];
  const latestYear = annual && annual.latestYear ? Number(annual.latestYear) : null;
  if (!latestYear) {
    return { status: STATUS.PENDING, reason: 'latest_fiscal_year_unknown', profitY: null, profitSum: null, dividendY: null, dividendSum: null, comparedYears: [] };
  }
  const needed = [];
  for (let i = 1; i <= p.anomalyLookbackYears; i++) needed.push(latestYear - i);
  const missing = needed.filter(y => {
    const row = findYear(years, y);
    return !row || row.complete !== true;
  });
  const current = findYear(years, latestYear);
  const result = {
    latestYear,
    comparedYears: needed.slice().reverse(),
    profitY: current ? num(current.profit) : null,
    dividendY: current ? num(current.dividend) : null,
    currency: annual.currency || null,
  };
  if (missing.length) {
    return Object.assign(result, { status: STATUS.PENDING, reason: 'insufficient_fiscal_history', missingYears: missing.sort((a, b) => a - b), profitSum: null, dividendSum: null });
  }
  const profitSum = needed.reduce((sum, y) => sum + (num(findYear(years, y).profit) || 0), 0);
  const dividendSum = needed.reduce((sum, y) => sum + (num(findYear(years, y).dividend) || 0), 0);
  if (result.profitY === null && result.dividendY === null) {
    return Object.assign(result, { status: STATUS.PENDING, reason: 'annual_facts_unavailable', profitSum, dividendSum });
  }
  // 有符号归母利润：不取绝对值、不清零历史亏损。严格大于才排除（恰等不排除）。
  const profitExceeded = result.profitY !== null && result.profitY > profitSum;
  const dividendExceeded = result.dividendY !== null && result.dividendY > dividendSum;
  const excluded = profitExceeded || dividendExceeded;
  return Object.assign(result, {
    status: excluded ? STATUS.FAIL : STATUS.PASS,
    reason: excluded ? (profitExceeded && dividendExceeded ? 'profit_and_dividend_exceed_decade' : profitExceeded ? 'profit_exceed_decade' : 'dividend_exceed_decade') : null,
    profitSum, dividendSum,
    profitExceeded, dividendExceeded,
  });
}

// 竞赛排名 1,2,2,4：并列占位，下一名次跳号。
function competitionRank(items, valueOf, direction) {
  const ranked = items.map(item => ({ item, value: valueOf(item) }))
    .filter(row => row.value !== null && Number.isFinite(row.value));
  ranked.sort((a, b) => direction === 'desc' ? b.value - a.value : a.value - b.value);
  const map = new Map();
  let lastValue = null;
  let lastRank = 0;
  ranked.forEach((row, index) => {
    const same = lastValue !== null && Math.abs(row.value - lastValue) < 1e-12;
    const rank = same ? lastRank : index + 1;
    map.set(row.item.instrumentId, rank);
    lastValue = row.value;
    lastRank = rank;
  });
  return { map, count: ranked.length };
}

/**
 * 排名（方案 5.1）：PB 升序、静态 PE 升序、股息率降序，各自竞赛排名后求和。
 * 亏损/零利润的 PE 分统一为盈利股数量 P；P=0 时统一为排名池数量 N。
 * 排序全部用原始精度，不按页面四舍五入值判并列。
 */
function rankCandidates(candidates) {
  const pool = candidates.filter(item => item.rankReady !== false && item.filterStatus === STATUS.PASS);
  const n = pool.length;
  const pbRank = competitionRank(pool, item => num(item.currentPb), 'asc');
  const dyRank = competitionRank(pool, item => num(item.dividendYield), 'desc');
  const profitPool = pool.filter(item => item.profitStatus === 'profit' && num(item.currentPe) !== null && num(item.currentPe) > 0);
  const peRank = competitionRank(profitPool, item => num(item.currentPe), 'asc');
  const profitCount = profitPool.length;

  const ranked = pool.map(item => {
    const pe = item.profitStatus === 'profit' ? peRank.map.get(item.instrumentId) : undefined;
    const peRankValue = pe !== undefined ? pe : (profitCount > 0 ? profitCount : n);
    const pbRankValue = pbRank.map.get(item.instrumentId);
    const dyRankValue = dyRank.map.get(item.instrumentId);
    return Object.assign({}, item, {
      pbRank: pbRankValue === undefined ? null : pbRankValue,
      peRank: peRankValue,
      dividendRank: dyRankValue === undefined ? null : dyRankValue,
      totalScore: (pbRankValue || 0) + peRankValue + (dyRankValue || 0),
    });
  });

  // 总分并列按 PB 升序、股息率降序、标准证券代码字典序稳定决胜，最终写 selection_order。
  ranked.sort((a, b) => {
    if (a.totalScore !== b.totalScore) return a.totalScore - b.totalScore;
    const pbA = num(a.currentPb), pbB = num(b.currentPb);
    if (pbA !== pbB) return (pbA === null ? Infinity : pbA) - (pbB === null ? Infinity : pbB);
    const dyA = num(a.dividendYield), dyB = num(b.dividendYield);
    if (dyA !== dyB) return (dyB === null ? -Infinity : dyB) - (dyA === null ? -Infinity : dyA);
    return String(a.code).localeCompare(String(b.code));
  });
  ranked.forEach((item, index) => { item.selectionOrder = index + 1; });
  return { ranked, profitCount, poolSize: n, peRankFallback: profitCount === 0 ? n : null };
}

// PB 情景参考（方案 6.3）：只展示原方案给出的四档，不做线性插值。
function referencePositionForPb(pb) {
  const value = num(pb);
  if (value === null || value <= 0) return null;
  if (value <= 0.7) return 0.7;
  if (value <= 1.0) return 0.5;
  if (value <= 1.5) return 0.3;
  return null;
}

// 市场准入：只判断有效 PB，0 < PB < 2；PB=2 不准入，PB 缺失/异常是数据故障而不是"市场便宜"。
function evaluateMarketGate(valuation, params = DEFAULT_PARAMS) {
  const p = Object.assign({}, DEFAULT_PARAMS, params || {});
  const pb = num((valuation || {}).pb);
  const pe = num((valuation || {}).pe);
  const base = {
    tradeDate: (valuation || {}).tradeDate || null,
    valuationMethod: (valuation || {}).valuationMethod || null,
    benchmarkCode: (valuation || {}).benchmarkCode || null,
    pb, pe,
  };
  if (pb === null || pb <= 0) {
    return Object.assign(base, { status: 'data_missing', eligible: false, reason: pb === null ? 'market_pb_missing' : 'market_pb_non_positive' });
  }
  if (!(pb < p.marketMaxPb)) {
    return Object.assign(base, { status: 'market_closed', eligible: false, reason: 'market_pb_not_below_threshold' });
  }
  return Object.assign(base, { status: 'eligible', eligible: true, reason: null });
}

module.exports = {
  STATUS,
  STRATEGY_CODE,
  RULE_CODES,
  DEFAULT_PARAMS,
  evaluateInstrument,
  evaluateCurrentPb,
  evaluateHistoricalPb,
  evaluateDividendYield,
  evaluateEquity,
  evaluateAnnualAnomaly,
  rankCandidates,
  competitionRank,
  referencePositionForPb,
  evaluateMarketGate,
  num,
};

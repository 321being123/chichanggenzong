// 投资策略选股中心：用例编排（方案第 7、9 节）。
// 职责：把标准事实读成时点快照 → 调纯规则/组合算法 → 裁决数据质量 → 在事务里落库与发布。
// 本文件只读库内已落库事实，页面与接口不得在这里触发外部采集。
'use strict';

const crypto = require('crypto');
const RULES = require('../domain/stockSelectionRules');
const PORTFOLIO = require('../domain/stockSelectionPortfolio');
const repo = require('../repositories/stockSelectionRepository');
const { withTransaction } = require('../db/transaction');

const STRATEGY_VERSION = 'v1';
const MARKET_LABEL = Object.freeze({ CN: 'A股', HK: '港股' });
// 收盘可见时点：A股 15:00、港股 16:00（当地）。只有日期没有时刻的公告保守地从下一交易日视为可用。
const CLOSE_CUTOFF = Object.freeze({ CN: 'T15:00:00+08:00', HK: 'T16:00:00+08:00' });

function pad2(value) { return String(value).padStart(2, '0'); }

function quarterOf(date) {
  const month = Number(String(date).slice(5, 7));
  return `${String(date).slice(0, 4)}Q${Math.ceil(month / 3)}`;
}

function quarterEndDate(quarter) {
  const match = /^(\d{4})Q([1-4])$/.exec(String(quarter || ''));
  if (!match) return null;
  const year = Number(match[1]);
  const q = Number(match[2]);
  const month = q * 3;
  const days = [31, (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return `${year}-${pad2(month)}-${pad2(days[month - 1])}`;
}

function shiftYears(date, years) {
  const year = Number(String(date).slice(0, 4)) - years;
  const month = Number(String(date).slice(5, 7));
  const day = Number(String(date).slice(8, 10));
  const days = [31, (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return `${year}-${pad2(month)}-${pad2(Math.min(day, days[month - 1]))}`;
}

function shiftMonths(date, months) {
  const total = Number(String(date).slice(0, 4)) * 12 + (Number(String(date).slice(5, 7)) - 1) - months;
  const year = Math.floor(total / 12);
  const month = total % 12 + 1;
  const days = [31, (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const day = Math.min(Number(String(date).slice(8, 10)), days[month - 1]);
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function knowledgeCutoffFor(market, asOfDate) {
  return `${asOfDate}${CLOSE_CUTOFF[market] || 'T15:00:00+08:00'}`;
}

function hashOf(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * 批量取数执行器：事务连接上不允许并发发送查询（pg 会告警并可能错序），
 * 因此在事务内按顺序执行；无事务（只读预览）时并行，减少往返。
 */
async function runBatched(tasks, tx) {
  if (tx) {
    const results = [];
    for (const task of tasks) results.push(await task());
    return results;
  }
  return Promise.all(tasks.map(task => task()));
}

/** 季度末目标日：取该市场本地交易日历中季度最后一个有效交易日。 */
async function resolveQuarterTarget({ market, quarter }, tx) {
  const end = quarterEndDate(quarter);
  if (!end) {
    const error = new Error('季度参数不合法');
    error.status = 400;
    throw error;
  }
  const start = shiftMonths(end, 1);
  const calendar = await repo.loadCalendar({ market, fromDate: start, toDate: end }, tx);
  if (!calendar.length) return { asOfDate: null, reason: 'calendar_unavailable', quarterEnd: end };
  const asOfDate = calendar[calendar.length - 1];
  if (asOfDate !== end) {
    // 季度末恰逢休市时用当月最后一个交易日；跨月则说明日历缺档。
    const sameMonth = calendar.filter(day => day.slice(0, 7) === end.slice(0, 7));
    if (!sameMonth.length) return { asOfDate: null, reason: 'calendar_incomplete', quarterEnd: end };
    return { asOfDate: sameMonth[sameMonth.length - 1], quarterEnd: end };
  }
  return { asOfDate, quarterEnd: end };
}

function normalizeMarket(market) {
  const value = String(market || '').toUpperCase();
  if (!MARKET_LABEL[value]) {
    const error = new Error('市场参数不合法');
    error.status = 400;
    throw error;
  }
  return value;
}

/** 把库内事实拼成规则输入（不查库）。 */
function buildRuleFacts(row, ctx) {
  const companyKey = row.company_id === null || row.company_id === undefined ? null : String(row.company_id);
  const equity = companyKey ? ctx.equity.get(companyKey) || null : null;
  const profits = companyKey ? ctx.profits.get(companyKey) || [] : [];
  const annualDividends = companyKey ? ctx.annualDividends.get(companyKey) || [] : [];
  const dividend = ctx.dividends.get(String(row.instrument_id)) || null;
  const industry = companyKey ? ctx.industries.get(companyKey) || null : null;
  const pbEvidence = ctx.pbWindow.byInstrument.get(String(row.instrument_id)) || { maxPb: null, coveredDays: 0 };

  const years = profits.map(item => {
    const dividendRow = annualDividends.find(d => d.year === item.year);
    return {
      year: item.year,
      profit: item.profit,
      // 年报存在即视为该财年现金分红已完整披露；没有分红事件按零记录并留证据口径。
      dividend: dividendRow ? dividendRow.dividend : 0,
      complete: item.profit !== null,
      dividend_basis: dividendRow ? 'implemented_events' : 'no_dividend_event',
    };
  }).sort((a, b) => a.year - b.year);
  const latestYear = years.length ? years[years.length - 1].year : null;

  let fx = null;
  if (equity && equity.currency && equity.currency !== 'CNY' && equity.periodEnd) {
    fx = ctx.fx.get(`${String(equity.currency).toUpperCase()}|${equity.periodEnd}`) || null;
  }

  return {
    instrumentId: Number(row.instrument_id),
    companyId: row.company_id === null || row.company_id === undefined ? null : Number(row.company_id),
    code: row.code,
    name: row.name,
    market: row.market,
    pb: row.pb,
    peStatic: row.pe_static,
    peTtm: row.pe_ttm,
    price: row.price,
    priceDate: row.price_date,
    pbWindow: {
      maxPb: pbEvidence.maxPb,
      coveredDays: pbEvidence.coveredDays,
      marketDays: ctx.pbWindow.marketDays,
      calendarDays: ctx.pbWindow.calendarDays,
    },
    equity: equity ? {
      amount: equity.amount, currency: equity.currency, periodEnd: equity.periodEnd,
      announcedAt: equity.announcedAt, reportId: equity.reportId,
      availabilityBasis: equity.availabilityBasis || 'announced_at',
    } : {},
    fx: fx || {},
    dividend: dividend ? Object.assign({}, dividend, {
      windowStart: ctx.dividendWindowStart,
      windowEnd: ctx.asOfDate,
      verifiedZero: dividend.count === 0,
    }) : { verifiedZero: false },
    annual: { latestYear, years, currency: profits.length ? profits[0].currency : null },
    industry,
    suspended: !!row.suspend_type,
    suspensionReason: row.suspend_type || null,
    riskWarning: row.risk_warning ? 'risk_warning_name' : null,
    delistedAtTargetDate: false,
  };
}

/**
 * 计算一次选股（不写库）。返回候选、排名、组合、覆盖与质量裁决。
 */
async function computeSelection(input, tx) {
  const market = normalizeMarket(input.market);
  const asOfDate = String(input.asOfDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
    const error = new Error('目标日参数不合法');
    error.status = 400;
    throw error;
  }
  const params = Object.assign({}, RULES.DEFAULT_PARAMS, input.params || {});
  const positionRatio = PORTFOLIO.clampRatio(input.positionRatio, 1);
  const valuation = await repo.loadMarketValuation({ market, asOfDate }, tx);
  const gate = RULES.evaluateMarketGate(valuation, params);

  const universe = await repo.loadUniverse({ market, asOfDate }, tx);
  if (!universe.length) {
    return {
      market, asOfDate, gate, valuation, params, positionRatio,
      universe, candidates: [], ranked: [], portfolio: PORTFOLIO.buildPortfolio({ ranked: [], positionRatio, params }),
      quality: { publishable: false, reason: 'universe_empty', universeCount: 0, pendingCount: 0, poolSize: 0 },
      coverage: { universeCount: 0 },
    };
  }

  const companyIds = Array.from(new Set(universe.map(row => row.company_id).filter(id => id !== null && id !== undefined)));
  const instrumentIds = universe.map(row => row.instrument_id);
  const windowStart = shiftYears(asOfDate, params.pbLookbackYears);
  const dividendWindowStart = shiftMonths(asOfDate, params.dividendWindowMonths);
  const [pbWindow, equity, profits, dividends, annualDividends, industries] = await runBatched([
    () => repo.loadPbWindow({ market, windowStart, asOfDate }, tx),
    () => repo.loadEquityFacts({ companyIds, asOfDate }, tx),
    () => repo.loadAnnualProfits({ companyIds, asOfDate }, tx),
    () => repo.loadDividendWindow({ instrumentIds, windowStart: dividendWindowStart, asOfDate }, tx),
    () => repo.loadAnnualDividends({ companyIds }, tx),
    () => repo.loadIndustries({ companyIds, market, asOfDate }, tx),
  ], tx);
  const fxPairs = Array.from(equity.values())
    .filter(item => item.currency && item.currency !== 'CNY' && item.periodEnd)
    .map(item => ({ currency: String(item.currency).toUpperCase(), date: item.periodEnd }));
  const fx = await repo.loadFxRatesForPairs({ pairs: fxPairs }, tx);

  const ctx = { equity, profits, annualDividends, dividends, industries, pbWindow, fx, asOfDate, dividendWindowStart };
  const evaluated = universe.map(row => buildRuleFacts(row, ctx)).map(facts => RULES.evaluateInstrument(facts, params));

  // 年度异常独立判定，不参与三项名次。
  const anomalyById = {};
  evaluated.forEach(item => {
    const companyKey = item.companyId === null || item.companyId === undefined ? null : String(item.companyId);
    const profitRows = companyKey ? profits.get(companyKey) || [] : [];
    const dividendRows = companyKey ? annualDividends.get(companyKey) || [] : [];
    const years = profitRows.map(row => {
      const dividendRow = dividendRows.find(d => d.year === row.year);
      return { year: row.year, profit: row.profit, dividend: dividendRow ? dividendRow.dividend : 0, complete: row.profit !== null };
    });
    const latestYear = years.length ? years[years.length - 1].year : null;
    anomalyById[item.instrumentId] = RULES.evaluateAnnualAnomaly({ latestYear, years }, params);
  });

  const { ranked, profitCount, poolSize, peRankFallback } = RULES.rankCandidates(evaluated);
  const portfolio = PORTFOLIO.buildPortfolio({
    ranked,
    anomalyById,
    positionRatio,
    slots: params.slotsPerMarket,
    industryLimitRatio: params.industryLimitRatio,
    params,
  });

  // 质量裁决：PENDING 表示"未知"，FAIL 是"明确不符合"。只有明确排除过或全部核验过才允许正式发布。
  const pending = evaluated.filter(item => item.filterStatus === RULES.STATUS.PENDING);
  const anomalyPending = ranked.filter(item => (anomalyById[item.instrumentId] || {}).status === RULES.STATUS.PENDING);
  const pendingCount = pending.length + anomalyPending.length;
  const industryMissing = ranked.filter(item => !item.industry).length;
  const stalePrice = evaluated.filter(item => item.rules.R01.status === RULES.STATUS.PASS && !item.detail.priceDate).length;

  const reasons = [];
  if (!gate.eligible) reasons.push(gate.reason || 'market_not_eligible');
  if (!universe.length) reasons.push('universe_empty');
  if (pendingCount > 0) reasons.push('pending_objects_in_ranking_pool');
  if (industryMissing > 0) reasons.push('industry_unverified_in_ranking_pool');
  if (portfolio.members.length === 0) reasons.push('no_eligible_member');

  const quality = {
    publishable: reasons.length === 0,
    reason: reasons[0] || null,
    reasons,
    universeCount: universe.length,
    poolSize,
    pendingCount,
    anomalyPendingCount: anomalyPending.length,
    industryMissing,
    stalePrice,
    profitCount,
    peRankFallback,
    failures: evaluated.filter(item => item.filterStatus === RULES.STATUS.FAIL).length,
    passed: evaluated.filter(item => item.filterStatus === RULES.STATUS.PASS).length,
  };

  const coverage = {
    universeCount: universe.length,
    withValuation: universe.filter(row => row.pb !== null && row.pb !== undefined).length,
    withPrice: universe.filter(row => row.price !== null && row.price !== undefined).length,
    withEquity: evaluated.filter(item => item.equityCny !== null).length,
    withIndustry: evaluated.filter(item => !!item.industry).length,
    withAnnualHistory: Array.from(profits.values()).filter(list => list.length >= params.requiredFiscalYears).length,
    companies: companyIds.length,
    pbWindow: { marketDays: pbWindow.marketDays, calendarDays: pbWindow.calendarDays, windowStart },
  };

  return { market, asOfDate, gate, valuation, params, positionRatio, universe, evaluated, ranked, anomalyById, portfolio, quality, coverage };
}

function manifestOf(computed, extra) {
  return Object.assign({
    market: computed.market,
    asOfDate: computed.asOfDate,
    benchmarkCode: computed.valuation.benchmarkCode,
    valuationMethod: computed.valuation.valuationMethod,
    marketPb: computed.valuation.pb,
    marketPe: computed.valuation.pe,
    universeCount: computed.coverage.universeCount,
    withValuation: computed.coverage.withValuation,
    withPrice: computed.coverage.withPrice,
    withEquity: computed.coverage.withEquity,
    withIndustry: computed.coverage.withIndustry,
    pbWindow: computed.coverage.pbWindow,
    params: computed.params,
  }, extra || {});
}

function businessStatusOf(computed, quality) {
  if (!computed.gate.eligible) {
    return computed.gate.status === 'market_closed' ? 'market_closed' : 'market_data_missing';
  }
  if (quality.publishable) return quality.poolSize > 0 ? 'eligible' : 'insufficient_candidates';
  return 'insufficient_data';
}

function statusOf(computed, quality) {
  return {
    executionStatus: 'succeeded',
    qualityStatus: quality.publishable ? 'passed' : 'partial',
    businessStatus: businessStatusOf(computed, quality),
  };
}

/**
 * 计算并落库（正式季度 / 预览 / 个人测算共用一条路径）。
 * runKind=quarterly 且质量通过时才移动正式发布指针；否则只保存部分数据预览。
 */
async function computeAndPersist(input) {
  const runKind = input.runKind || 'preview';
  if (!['quarterly', 'preview', 'personal'].includes(runKind)) {
    const error = new Error('运行类型不合法');
    error.status = 400;
    throw error;
  }
  if (runKind === 'personal' && !input.ownerUsername) {
    const error = new Error('个人测算必须绑定登录用户');
    error.status = 400;
    throw error;
  }
  return withTransaction(async tx => {
    const computed = await computeSelection(input, tx);
    const strategyId = await repo.upsertStrategy(tx, {
      strategyCode: RULES.STRATEGY_CODE,
      market: computed.market,
      version: input.strategyVersion || STRATEGY_VERSION,
      formulaVersion: computed.params.formulaVersion,
      adapterVersion: computed.params.adapterVersion,
      riskVersion: computed.params.riskVersion,
      industryVersion: computed.params.industryVersion,
      effectiveFrom: computed.asOfDate,
      parameters: computed.params,
      contentHash: hashOf({ strategy: RULES.STRATEGY_CODE, params: computed.params, version: input.strategyVersion || STRATEGY_VERSION }),
    });
    const manifest = manifestOf(computed, {
      positionRatio: computed.positionRatio,
      industryLimitRatio: computed.params.industryLimitRatio,
      owner: input.ownerUsername || null,
      sourceRunId: input.sourceRunId || null,
    });
    const inputHash = hashOf(manifest);
    const quarter = input.quarter || quarterOf(computed.asOfDate);
    const existing = await repo.findRunByIdempotencyKey(tx, {
      strategyId, market: computed.market, asOfDate: computed.asOfDate,
      runKind, inputHash, ownerUsername: input.ownerUsername || null,
    });
    if (existing) {
      const run = await repo.findRun(existing, tx);
      return { runId: existing, reused: true, run, computed };
    }
    const revision = runKind === 'quarterly' ? await repo.nextRevision(tx, { market: computed.market, quarter, strategyId }) : 1;
    const status = statusOf(computed, computed.quality);
    const publishable = runKind === 'quarterly' && computed.quality.publishable;
    const runId = await repo.insertRun(tx, {
      strategyId, market: computed.market, runKind, ownerUsername: input.ownerUsername || null,
      quarter, asOfDate: computed.asOfDate, knowledgeCutoff: knowledgeCutoffFor(computed.market, computed.asOfDate),
      executionStatus: status.executionStatus,
      qualityStatus: status.qualityStatus,
      businessStatus: status.businessStatus,
      inputHash, inputManifest: Object.assign(manifest, { quality: computed.quality, coverage: computed.coverage }),
      universeCount: computed.coverage.universeCount,
      pendingCount: computed.quality.pendingCount,
      selectedCount: computed.portfolio.members.length,
      marketPb: computed.valuation.pb, marketPe: computed.valuation.pe,
      benchmarkCode: computed.valuation.benchmarkCode,
      valuationMethod: computed.valuation.valuationMethod,
      positionRatio: computed.positionRatio,
      budgetRatio: input.budgetRatio === undefined ? null : PORTFOLIO.clampRatio(input.budgetRatio, null),
      revision,
      publishedAt: null,
      supersedesRunId: input.supersedesRunId || null,
      requestId: input.requestId || null,
    });
    // 候选要保存全市场逐项决策，不能只留最有希望的 30 只。
    const rankedById = new Map(computed.ranked.map(item => [item.instrumentId, item]));
    const rows = computed.evaluated.map(item => {
      const rankedRow = rankedById.get(item.instrumentId) || {};
      return Object.assign({}, item, {
        anomaly: computed.anomalyById[item.instrumentId] || null,
        totalScore: rankedRow.totalScore,
        pbRank: rankedRow.pbRank,
        peRank: rankedRow.peRank,
        dividendRank: rankedRow.dividendRank,
        selectionOrder: rankedRow.selectionOrder,
      });
    });
    await repo.insertCandidates(tx, runId, rows);
    await repo.insertMembers(tx, runId, computed.portfolio.members);
    let publish = null;
    if (publishable) {
      publish = await repo.publishRun(tx, runId, { market: computed.market, quarter });
    }
    const run = await repo.findRun(runId, tx);
    return { runId, reused: false, run, computed, publish };
  });
}

/** 季度自动执行：目标日与季度都由交易日历推导，不用执行当天替代。 */
async function runQuarterly({ market, quarter, requestId, strategyVersion }) {
  const normalized = normalizeMarket(market);
  const target = await resolveQuarterTarget({ market: normalized, quarter }, null);
  if (!target.asOfDate) {
    return { ok: false, status: 'blocked', reason: target.reason, market: normalized, quarter };
  }
  const result = await computeAndPersist({
    market: normalized, asOfDate: target.asOfDate, quarter, runKind: 'quarterly',
    requestId, strategyVersion, positionRatio: 1,
  });
  return {
    ok: true,
    market: normalized,
    quarter,
    quarterDate: target.asOfDate,
    runId: result.runId,
    reused: result.reused,
    qualityStatus: result.run.quality_status,
    businessStatus: result.run.business_status,
    published: !!result.run.published_at,
    selectedCount: Number(result.run.selected_count || 0),
  };
}

/** 该市场待生成的最近一个完整季度（用于自动排队）。 */
async function pendingQuarter({ market, now }) {
  const normalized = normalizeMarket(market);
  const today = now || new Date().toISOString().slice(0, 10);
  const currentQuarter = quarterOf(today);
  const currentEnd = quarterEndDate(currentQuarter);
  const previousQuarter = today <= currentEnd ? previousQuarterOf(currentQuarter) : currentQuarter;
  return { quarter: previousQuarter, quarterEnd: quarterEndDate(previousQuarter) };
}

function previousQuarterOf(quarter) {
  const match = /^(\d{4})Q([1-4])$/.exec(quarter);
  const year = Number(match[1]);
  const q = Number(match[2]);
  if (q === 1) return `${year - 1}Q4`;
  return `${year}Q${q - 1}`;
}

/** 市场概览：两市场指数 PB/PE、实际日期、准入结论与当前季度就绪情况。 */
async function getMarkets() {
  const markets = [];
  for (const market of ['CN', 'HK']) {
    const config = repo.MARKET_CONFIG[market];
    // 页面只读库：取该指数最近一条可用估值日期，不触发任何外部采集。
    const latest = await repo.loadLatestMarketValuation({ market });
    const gate = RULES.evaluateMarketGate(latest, RULES.DEFAULT_PARAMS);
    const published = await repo.latestPublishedRun({ market });
    markets.push({
      market,
      label: MARKET_LABEL[market],
      benchmarkCode: config.benchmarkCode,
      benchmarkLabel: market === 'CN' ? '中证全指' : '恒生指数',
      valuationMethod: 'market_cap_weighted',
      valuationMethodLabel: '总市值加权',
      asOfDate: latest.tradeDate,
      pb: latest.pb,
      pe: latest.pe,
      sourceCode: latest.sourceCode,
      gate,
      referencePosition: RULES.referencePositionForPb(latest.pb),
      latestRun: published,
      ready: gate.eligible && !!published,
    });
  }
  return { markets, params: RULES.DEFAULT_PARAMS };
}

async function getRun(runId) {
  const run = await repo.findRun(runId);
  if (!run) return null;
  return run;
}

async function getCandidates(query) {
  return repo.listCandidates(query);
}

async function getPortfolio(runId) {
  const run = await repo.findRun(runId);
  if (!run) return null;
  const members = await repo.listMembers(runId);
  const previous = await repo.previousPublishedMembers({
    market: run.market, asOfDate: run.as_of_date_text, excludeRunId: Number(runId),
  });
  const currentIds = new Set(members.map(member => Number(member.instrument_id)));
  const previousIds = new Set(previous.map(row => Number(row.instrument_id)));
  const changes = {
    // 调入/调出只在有上一份正式季度组合时才有意义；否则明确标注没有可比对象。
    comparable: previous.length > 0,
    previousQuarter: previous.length ? previous[0].quarter : null,
    previousAsOfDate: previous.length ? previous[0].as_of_date : null,
    added: members.filter(member => !previousIds.has(Number(member.instrument_id)))
      .map(member => ({ code: member.code, name: member.name, slotNo: member.slot_no })),
    removed: previous.filter(row => !currentIds.has(Number(row.instrument_id)))
      .map(row => ({ code: row.code, name: row.name })),
    kept: members.filter(member => previousIds.has(Number(member.instrument_id))).length,
  };
  const positionRatio = run.position_ratio === null ? 1 : Number(run.position_ratio);
  const slots = RULES.DEFAULT_PARAMS.slotsPerMarket;
  const industryBreakdown = [];
  const industryCount = new Map();
  members.forEach(member => {
    const key = member.industry_code || 'unverified';
    const entry = industryCount.get(key) || { industryCode: key, industryName: member.industry_name || null, count: 0 };
    entry.count += 1;
    industryCount.set(key, entry);
  });
  industryCount.forEach(entry => {
    industryBreakdown.push(Object.assign(entry, {
      weightInMarketBudget: entry.count * positionRatio / slots,
      limitRatio: RULES.DEFAULT_PARAMS.industryLimitRatio,
    }));
  });
  const equityWeight = members.length * positionRatio / slots;
  return {
    runId: Number(runId),
    market: run.market,
    asOfDate: run.as_of_date_text,
    positionRatio,
    budgetRatio: run.budget_ratio === null ? null : Number(run.budget_ratio),
    slots,
    selectedCount: members.length,
    unfilledSlots: slots - members.length,
    equityWeightInMarketBudget: equityWeight,
    cashWeightInMarketBudget: 1 - equityWeight,
    changes,
    members: members.map(member => ({
      slotNo: member.slot_no,
      code: member.code,
      name: member.name,
      companyId: member.company_id,
      industryCode: member.industry_code,
      industryName: member.industry_name,
      industrySystem: member.industry_system,
      weightInMarketBudget: Number(member.weight_in_market_budget),
      weightInEquityTarget: Number(member.weight_in_equity_target),
      issuerDuplicate: member.issuer_duplicate,
      currentPb: member.current_pb === null ? null : Number(member.current_pb),
      currentPe: member.current_pe === null ? null : Number(member.current_pe),
      dividendYield: member.dividend_yield === null ? null : Number(member.dividend_yield),
      totalScore: member.total_score === null ? null : Number(member.total_score),
    })),
    industryBreakdown,
  };
}

async function getStockDetail({ runId, code }) {
  const run = await repo.findRun(runId);
  if (!run) return null;
  const candidate = await repo.findCandidate({ runId, code });
  if (!candidate) return null;
  return {
    runId: Number(runId),
    market: run.market,
    asOfDate: run.as_of_date_text,
    strategyVersion: run.strategy_version,
    knowledgeCutoff: run.knowledge_cutoff_text,
    candidate: {
      code: candidate.code,
      name: candidate.name,
      instrumentId: Number(candidate.instrument_id),
      companyId: candidate.company_id === null ? null : Number(candidate.company_id),
      industry: candidate.industry_code ? {
        code: candidate.industry_code, name: candidate.industry_name,
        system: candidate.industry_system, version: candidate.industry_version,
      } : null,
      currentPb: candidate.current_pb === null ? null : Number(candidate.current_pb),
      historicalPbMax: candidate.historical_pb_max === null ? null : Number(candidate.historical_pb_max),
      currentPe: candidate.current_pe === null ? null : Number(candidate.current_pe),
      profitStatus: candidate.profit_status,
      dividendYield: candidate.dividend_yield === null ? null : Number(candidate.dividend_yield),
      equityAmount: candidate.equity_amount === null ? null : Number(candidate.equity_amount),
      equityCurrency: candidate.equity_currency,
      equityCny: candidate.equity_cny === null ? null : Number(candidate.equity_cny),
      fxRate: candidate.fx_rate === null ? null : Number(candidate.fx_rate),
      fxDate: candidate.fx_date,
      pbRank: candidate.pb_rank,
      peRank: candidate.pe_rank,
      dividendRank: candidate.dividend_rank,
      totalScore: candidate.total_score,
      selectionOrder: candidate.selection_order,
      filterStatus: candidate.filter_status,
      dataQualityStatus: candidate.data_quality_status,
      exclusionReasons: candidate.exclusion_reasons,
      detail: candidate.detail,
    },
  };
}

function validateSettingsPayload(body) {
  const errors = [];
  const pickRatio = (value, field) => {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 1) errors.push(`${field} 必须是 0—1 之间的小数`);
    return Number.isFinite(n) ? n : null;
  };
  const settings = {
    budgetRatioA: pickRatio(body.budgetRatioA, 'A股市场资金占比'),
    budgetRatioHk: pickRatio(body.budgetRatioHk, '港股市场资金占比'),
    positionRatioA: pickRatio(body.positionRatioA, 'A股目标股票仓位'),
    positionRatioHk: pickRatio(body.positionRatioHk, '港股目标股票仓位'),
    totalCapital: body.totalCapital === undefined || body.totalCapital === null || body.totalCapital === ''
      ? null : Number(body.totalCapital),
  };
  if (settings.totalCapital !== null && (!Number.isFinite(settings.totalCapital) || settings.totalCapital < 0)) {
    errors.push('总资金必须是非负数字');
  }
  const budgetSum = (settings.budgetRatioA || 0) + (settings.budgetRatioHk || 0);
  if (budgetSum > 1 + 1e-9) errors.push('两个市场资金占比之和不能超过 100%');
  if (errors.length) {
    const error = new Error(errors.join('；'));
    error.status = 400;
    throw error;
  }
  return settings;
}

async function getSettings(username) {
  const stored = await repo.readUserSettings(username);
  if (!stored) {
    const error = new Error('账号不存在');
    error.status = 404;
    throw error;
  }
  return { settings: stored.settings, revision: stored.revision };
}

async function saveSettings({ username, body }) {
  const settings = validateSettingsPayload(body || {});
  const stored = await repo.readUserSettings(username);
  const expected = Number((body || {}).revision === undefined ? (stored ? stored.revision : 0) : (body || {}).revision);
  return repo.saveUserSettings({ username, settings, expectedRevision: expected });
}

/**
 * 个人资金测算（方案 6.3、11）：复用已发布排名做资金测算，不重新取数、不改正式季度结果。
 * 排名沿用源批次快照，只按用户仓位与预算重算席位和权重。
 */
async function createSimulation({ username, sourceRunId, positionRatio, budgetRatio }) {
  const source = await repo.findRun(sourceRunId);
  if (!source) {
    const error = new Error('源批次不存在');
    error.status = 404;
    throw error;
  }
  if (!source.published_at && source.run_kind !== 'preview') {
    const error = new Error('该批次尚未发布，不能用它做个人测算');
    error.status = 409;
    throw error;
  }
  const ratio = PORTFOLIO.clampRatio(positionRatio, 1);
  const budget = budgetRatio === undefined ? null : PORTFOLIO.clampRatio(budgetRatio, null);
  const rows = await repo.listCandidates({ runId: sourceRunId, limit: 5000, offset: 0 });
  const anomalyById = {};
  const ranked = rows.rows
    .filter(row => row.filter_status === RULES.STATUS.PASS)
    .map(row => {
      const detail = row.detail || {};
      if (detail.anomaly) anomalyById[Number(row.instrument_id)] = detail.anomaly;
      return {
        instrumentId: Number(row.instrument_id),
        code: row.code,
        name: row.name,
        companyId: row.company_id === null ? null : Number(row.company_id),
        currentPb: row.current_pb === null ? null : Number(row.current_pb),
        currentPe: row.current_pe === null ? null : Number(row.current_pe),
        dividendYield: row.dividend_yield === null ? null : Number(row.dividend_yield),
        profitStatus: row.profit_status,
        filterStatus: row.filter_status,
        rankReady: true,
        selectionOrder: row.selection_order,
        industry: row.industry_code
          ? { code: row.industry_code, name: row.industry_name, system: row.industry_system, version: row.industry_version }
          : null,
      };
    })
    .sort((a, b) => (a.selectionOrder || 0) - (b.selectionOrder || 0));
  const portfolio = PORTFOLIO.buildPortfolio({ ranked, anomalyById, positionRatio: ratio, params: RULES.DEFAULT_PARAMS });

  return withTransaction(async tx => {
    const inputHash = hashOf({ source: Number(sourceRunId), positionRatio: ratio, budgetRatio: budget, owner: username });
    const existing = await repo.findRunByIdempotencyKey(tx, {
      strategyId: Number(source.strategy_id), market: source.market, asOfDate: source.as_of_date_text,
      runKind: 'personal', inputHash, ownerUsername: username,
    });
    if (existing) return { runId: existing, reused: true, run: await repo.findRun(existing, tx), portfolio };
    const runId = await repo.insertRun(tx, {
      strategyId: Number(source.strategy_id),
      market: source.market,
      runKind: 'personal',
      ownerUsername: username,
      quarter: source.quarter,
      asOfDate: source.as_of_date_text,
      knowledgeCutoff: source.knowledge_cutoff_text,
      executionStatus: 'succeeded',
      qualityStatus: source.quality_status,
      businessStatus: 'personal_simulation',
      inputHash,
      inputManifest: { sourceRunId: Number(sourceRunId), positionRatio: ratio, budgetRatio: budget, owner: username },
      universeCount: Number(source.universe_count || 0),
      pendingCount: Number(source.pending_count || 0),
      selectedCount: portfolio.members.length,
      marketPb: source.market_pb === null ? null : Number(source.market_pb),
      marketPe: source.market_pe === null ? null : Number(source.market_pe),
      benchmarkCode: source.benchmark_code,
      valuationMethod: source.valuation_method,
      positionRatio: ratio,
      budgetRatio: budget,
      revision: 1,
      publishedAt: null,
      supersedesRunId: Number(sourceRunId),
      requestId: null,
    });
    await repo.copyCandidates({ sourceRunId: Number(sourceRunId), targetRunId: runId }, tx);
    await repo.insertMembers(tx, runId, portfolio.members);
    return { runId, reused: false, run: await repo.findRun(runId, tx), portfolio };
  });
}

/** 回测入口（实现在 stockSelectionBacktest，这里只做权限与参数校验后的转发）。 */
async function runBacktest(input) {
  const backtest = require('./stockSelectionBacktest');
  return backtest.runBacktest(input);
}

async function listRuns(query) {
  return repo.listRuns(query);
}

async function getBacktest(backtestId) {
  const row = await repo.findBacktest(backtestId);
  if (!row) return null;
  return backtestEnvelope(row);
}

async function getBacktestPeriods(query) {
  return repo.listBacktestPeriods(query);
}

function backtestEnvelope(row) {
  return {
    backtestId: Number(row.backtest_id),
    market: row.market,
    startDate: row.start_date ? String(row.start_date).slice(0, 10) : null,
    endDate: row.end_date ? String(row.end_date).slice(0, 10) : null,
    currency: row.currency,
    status: row.status,
    executionModelVersion: row.execution_model_version,
    costVersion: row.cost_version,
    benchmarkCode: row.benchmark_code,
    benchmarkReturnType: row.benchmark_return_type,
    metrics: row.metrics,
    diagnostics: row.diagnostics,
    createdAt: row.created_at,
  };
}

/** 回测历史列表：只读库，页面用来展示已有回测状态与"不可还原"原因。 */
async function listBacktests({ market, limit, offset }) {
  const result = await repo.listBacktests({ market, limit, offset });
  return { total: result.total, rows: result.rows.map(backtestEnvelope) };
}

/**
 * 选股输入缺口审计（对应选股任务 selection_inputs 模式）：
 * 只读库内标准事实，冻结"应补未补"的对象清单并持久化可续跑队列；
 * 不在这里新增第二条外部采集链路（方案 7.1 要求复用原采集入口）。
 */
async function auditInputs({ market, asOfDate }) {
  const computed = await computeSelection({ market, asOfDate, positionRatio: 1 });
  const gaps = computed.evaluated
    .filter(item => item.filterStatus === RULES.STATUS.PENDING || !item.rankReady)
    .map(item => ({
      code: item.code,
      name: item.name,
      companyId: item.companyId,
      reasons: Array.from(new Set(item.exclusionReasons.map(reason => reason.code))),
    }));
  const payload = {
    market: computed.market,
    asOfDate: computed.asOfDate,
    generatedAt: new Date().toISOString(),
    universeCount: computed.coverage.universeCount,
    gapCount: gaps.length,
    coverage: computed.coverage,
    quality: computed.quality,
    // 队列按证券代码排序后截断明细，总量仍完整保存在 gapCount；不因页面或日志截断而少算。
    gaps: gaps.slice(0, 5000),
    truncated: gaps.length > 5000,
  };
  const queueId = await repo.saveInputGapQueue({ market: computed.market, payload });
  return { queueId, gapCount: gaps.length, coverage: computed.coverage, quality: computed.quality, gaps };
}

module.exports = {
  STRATEGY_VERSION,
  MARKET_LABEL,
  RULES,
  PORTFOLIO,
  quarterOf,
  quarterEndDate,
  previousQuarterOf,
  resolveQuarterTarget,
  knowledgeCutoffFor,
  computeSelection,
  computeAndPersist,
  runQuarterly,
  pendingQuarter,
  getMarkets,
  listRuns,
  getRun,
  getCandidates,
  getPortfolio,
  getStockDetail,
  getBacktest,
  getBacktestPeriods,
  listBacktests,
  backtestEnvelope,
  auditInputs,
  getSettings,
  saveSettings,
  createSimulation,
  validateSettingsPayload,
  runBacktest,
};

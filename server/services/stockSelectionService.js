// 投资策略选股中心：用例编排（方案第 7、9 节）。
// 职责：把标准事实读成时点快照 → 调纯规则/组合算法 → 裁决数据质量 → 在事务里落库与发布。
// 本文件只读库内已落库事实，页面与接口不得在这里触发外部采集。
'use strict';

const crypto = require('crypto');
const RULES = require('../domain/stockSelectionRules');
const PORTFOLIO = require('../domain/stockSelectionPortfolio');
const repo = require('../repositories/stockSelectionRepository');
const { withTransaction } = require('../db/transaction');
const CoreDate = require('../../public/shared/core-date.js');

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

/**
 * 年度事实构造（SSV-04）：利润与分红的完整性分别标注。
 * 没有任何分红记录的一年是"未知"，不是"零分红"——记 null 并标 dividendKnown=false，
 * 让年度异常比较整段跳过，而不是拿 0 参与求和把公司误判成异常或正常。
 * R3-03：完整性只认仓储层给出的"该财年分红已完整取证且金额已知"；
 * 预案、只有中期单条、已实施但总额缺失都属未知，一律保持 null，不能因 eventCount>0 就折成 0。
 */
function buildAnnualYears(profits, annualDividends) {
  return (profits || []).map(item => {
    const dividendRow = (annualDividends || []).find(d => d.year === item.year);
    const known = !!dividendRow && dividendRow.dividendKnown === true
      && dividendRow.dividend !== null && dividendRow.dividend !== undefined;
    return {
      year: item.year,
      profit: item.profit === undefined ? null : item.profit,
      dividend: known ? Number(dividendRow.dividend) : null,
      dividendKnown: known,
      complete: item.profit !== null && item.profit !== undefined,
      // 事实版本随年度一起保留：它是"这一年的利润有没有被更正过"的证据（R2-02）。
      sourceVersion: item.sourceVersion || null,
      dividendBasis: known
        ? (dividendRow.dividendBasis || 'dividend_events_visible')
        : ((dividendRow && dividendRow.dividendBasis) || 'dividend_unknown'),
    };
  }).sort((a, b) => a.year - b.year);
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

  const years = buildAnnualYears(profits, annualDividends);
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
      expectedDays: pbEvidence.expectedDays,
      gapDays: pbEvidence.gapDays,
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
  // 信息可见截止：目标日当地收盘时刻。财报 available_at 晚于截止的修订版不得进入旧季度。
  const knowledgeCutoff = knowledgeCutoffFor(market, asOfDate);
  const [pbWindow, equity, profits, dividends, annualDividends, industries] = await runBatched([
    () => repo.loadPbWindow({ market, windowStart, asOfDate }, tx),
    () => repo.loadEquityFacts({ companyIds, asOfDate, availableBefore: knowledgeCutoff }, tx),
    () => repo.loadAnnualProfits({ companyIds, asOfDate, availableBefore: knowledgeCutoff }, tx),
    () => repo.loadDividendWindow({ instrumentIds, windowStart: dividendWindowStart, asOfDate }, tx),
    () => repo.loadAnnualDividends({ companyIds, asOfDate }, tx),
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
    const years = buildAnnualYears(profitRows, dividendRows);
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

  // 质量裁决：PENDING 表示"未知"，FAIL 是"明确不符合"，RISK 是"当期风险暂缓"。
  // SSV-03：四项通过但排名输入未知（如静态 PE/利润口径未定）也必须算待补，
  // 否则它会从排名池静默消失、还能让别人把 publishable 撑成 true。
  const pending = evaluated.filter(item => item.filterStatus === RULES.STATUS.PENDING);
  const rankBlocked = evaluated.filter(item => item.filterStatus === RULES.STATUS.PASS && item.rankReady === false);
  const anomalyPending = ranked.filter(item => (anomalyById[item.instrumentId] || {}).status === RULES.STATUS.PENDING);
  const pendingCount = pending.length + rankBlocked.length + anomalyPending.length;
  const riskHeld = evaluated.filter(item => item.filterStatus === RULES.STATUS.RISK);
  const anomalyDividendSkipped = ranked.filter(item => {
    const anomaly = anomalyById[item.instrumentId];
    return anomaly && anomaly.dividendComparable === false;
  }).length;
  const industryMissing = ranked.filter(item => !item.industry).length;
  const stalePrice = evaluated.filter(item => item.rules.R01.status === RULES.STATUS.PASS && !item.detail.priceDate).length;

  const reasons = [];
  if (!gate.eligible) reasons.push(gate.reason || 'market_not_eligible');
  if (!universe.length) reasons.push('universe_empty');
  if (pendingCount > 0) reasons.push('pending_objects_in_ranking_pool');
  if (industryMissing > 0) reasons.push('industry_unverified_in_ranking_pool');
  // R3-04：输入完整时"没有合格股票"是有效业务结果（本季空仓），不是数据缺口。
  // 只有存在输入缺口或市场不可入时才把"无合格成员"记为附加阻断，
  // 否则零合格会永远被当成待补数据、季度反复续跑却永远补不齐。
  const inputBlocked = !gate.eligible || pendingCount > 0 || industryMissing > 0;
  if (portfolio.members.length === 0 && inputBlocked) reasons.push('no_eligible_member');

  const quality = {
    publishable: reasons.length === 0,
    reason: reasons[0] || null,
    reasons,
    universeCount: universe.length,
    poolSize,
    pendingCount,
    anomalyPendingCount: anomalyPending.length,
    rankBlockedCount: rankBlocked.length,
    riskHeldCount: riskHeld.length,
    anomalyDividendSkipped,
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

/**
 * 逐股输入摘要（SSV-05 / R2-02）：哈希必须覆盖实际参与判断的**全部值与证据**。
 * 反例一：同一集合里把某只 PB 从 1.2 改成 0.81，行数、指数、参数都不变，旧实现复用旧快照。
 * 反例二：把 2015 年利润从 10 亿改成 -200 亿，最新一年与其他指标不变——只哈希最新一年时
 * 年度异常已从 PASS 变 FAIL，哈希却不变，于是继续返回旧已发布批次。
 * 因此这里把每一年的利润/分红/完整性、事实版本、权益版本与年度异常结论一起排序后哈希。
 */
function inputsDigestOf(computed) {
  const anomalyById = computed.anomalyById || {};
  const rows = computed.evaluated.map(item => {
    const detail = item.detail || {};
    const equity = detail.equity || {};
    const dividend = detail.dividend || {};
    const annual = detail.annual || {};
    const pbWindow = detail.pbWindow || {};
    // 全部年度事实都要进指纹，不能只取最新一年。
    const years = (annual.years || []).map(row => [
      Number(row.year), row.profit === undefined ? null : row.profit,
      row.dividend === undefined ? null : row.dividend,
      row.dividendKnown === true, row.complete === true, row.sourceVersion || null,
    ]);
    const anomaly = anomalyById[item.instrumentId] || null;
    const anomalyEvidence = anomaly ? [
      anomaly.status, anomaly.reason || null, anomaly.latestYear,
      anomaly.profitY === undefined ? null : anomaly.profitY,
      anomaly.profitSum === undefined ? null : anomaly.profitSum,
      anomaly.dividendY === undefined ? null : anomaly.dividendY,
      anomaly.dividendSum === undefined ? null : anomaly.dividendSum,
      anomaly.dividendComparable === undefined ? null : anomaly.dividendComparable,
      anomaly.dividendComparison || null,
      (anomaly.dividendUnknownYears || []).join(','),
      (anomaly.missingYears || []).join(','),
    ] : null;
    return [
      item.instrumentId, item.code,
      item.currentPb, item.currentPe, detail.price, item.dividendYield,
      item.historicalPbMax, pbWindow.expectedDays, pbWindow.gapDays, pbWindow.coveredDays,
      item.equityCny, item.equityCurrency, equity.reportId, equity.periodEnd, equity.announcedAt,
      equity.sourceVersion || null,
      dividend.ttmPerShare, dividend.count, dividend.currency || null, dividend.shareUnitUnverified === true,
      annual.latestYear, annual.currency || null, years,
      anomalyEvidence,
      item.industry ? `${item.industry.system}:${item.industry.code}:${item.industry.version}` : null,
      item.rules.R01.status, item.rules.R02.status, item.rules.R04.status, item.rules.R05.status,
      item.filterStatus, item.profitStatus,
    ];
  }).sort((a, b) => Number(a[0]) - Number(b[0]));
  return hashOf(rows);
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
    // 证券集合与逐股关键值摘要：变值不变行数、变证券不变总数都会改变哈希。
    universeDigest: hashOf(computed.evaluated.map(item => item.code).sort()),
    inputsDigest: inputsDigestOf(computed),
  }, extra || {});
}

function businessStatusOf(computed, quality) {
  if (!computed.gate.eligible) {
    return computed.gate.status === 'market_closed' ? 'market_closed' : 'market_data_missing';
  }
  if (quality.publishable) {
    // R3-04：可发布但没有成员 = 明确空仓。零候选池与"有候选池但全不合格"要分开，
    // 两者都不是"数据不足"，季度应当推进而不是续跑。
    if (!computed.portfolio.members.length) {
      return quality.poolSize > 0 ? 'no_eligible_member' : 'insufficient_candidates';
    }
    return 'eligible';
  }
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
  // 缺省季度由最近一个已结束季度解析（管理员不带季度直接点计算也必须有确定目标日）。
  const resolvedQuarter = quarter || (await pendingQuarter({ market: normalized })).quarter;
  if (!resolvedQuarter) {
    return { ok: false, status: 'blocked', reason: 'selection_quarter_unresolved', market: normalized, quarter: null };
  }
  const target = await resolveQuarterTarget({ market: normalized, quarter: resolvedQuarter }, null);
  if (!target.asOfDate) {
    return { ok: false, status: 'blocked', reason: target.reason, market: normalized, quarter };
  }
  const result = await computeAndPersist({
    market: normalized, asOfDate: target.asOfDate, quarter: resolvedQuarter, runKind: 'quarterly',
    requestId, strategyVersion, positionRatio: 1,
  });
  return {
    ok: true,
    market: normalized,
    quarter: resolvedQuarter,
    quarterDate: target.asOfDate,
    runId: result.runId,
    reused: result.reused,
    qualityStatus: result.run.quality_status,
    businessStatus: result.run.business_status,
    published: !!result.run.published_at,
    selectedCount: Number(result.run.selected_count || 0),
    // 阶段完成裁决需要区分"正式发布 / 市场正常关闭 / 只是预览"，这些证据必须一起返回。
    pendingCount: Number(result.run.pending_count || 0),
    qualityReasons: computedQualityReasons(result),
  };
}

// 质量裁决的阻断原因随批次落库在 input_manifest.quality，这里只做安全读取。
function computedQualityReasons(result) {
  const manifest = result && result.run && result.run.input_manifest;
  const quality = manifest && manifest.quality;
  return (quality && Array.isArray(quality.reasons)) ? quality.reasons : [];
}

/** 该市场待生成的最近一个完整季度（用于自动排队）。 */
async function pendingQuarter({ market, now }) {
  const normalized = normalizeMarket(market);
  // 业务日按上海时区取，不用 UTC 截日（INC-0032 口径）。
  const today = typeof now === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(now)
    ? now
    : CoreDate.todayInZone('Asia/Shanghai', now instanceof Date ? now : new Date());
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
 * 缺口的数据集归属（R2-04）：每个原因必须能落到"补什么"，
 * 补不了的（估值由共享行情任务负责）也要显式分类，不能变成"没有原因"。
 */
function gapDomainsOf(item, anomaly) {
  const domains = new Set();
  const reasons = [];
  const add = (domain, reason) => { domains.add(domain); reasons.push(reason); };

  if (item.filterStatus === RULES.STATUS.PENDING) {
    RULES.RULE_CODES.forEach(code => {
      const rule = (item.rules || {})[code];
      if (!rule || rule.status !== RULES.STATUS.PENDING) return;
      const reason = `${code}:${rule.reason || rule.status}`;
      // R04 走分红事实、R05 走财报、R01/R02 走行情估值。
      if (code === 'R04') add('dividends', reason);
      else if (code === 'R05') add('financial_reports', reason);
      else add('valuation', reason);
    });
  }
  // 排名受阻：利润口径未知要补财报，静态 PE 缺失要补估值。
  (item.rankBlockReasons || []).forEach(reason => {
    if (reason === 'profit_status_unknown') add('financial_reports', `RANK:${reason}`);
    else add('valuation', `RANK:${reason}`);
  });
  if (anomaly && anomaly.status === RULES.STATUS.PENDING) {
    const code = `annual_anomaly:${anomaly.reason || 'pending'}`;
    const unknownYears = anomaly.dividendUnknownYears || [];
    // 分红未知 → 补分红；利润历史不全 → 补财报；两者都可能时都入队。
    if (unknownYears.length) add('dividends', code);
    if (!unknownYears.length || (anomaly.missingYears || []).length) add('financial_reports', code);
  }
  if (!item.industry) add('industry', 'industry_unverified');
  // 未识别原因也保留：不允许"有缺口但 reasons 为空"。
  if (!reasons.length) {
    const fallback = Array.from(new Set((item.exclusionReasons || []).map(row => row.code))).filter(Boolean);
    if (fallback.length) fallback.forEach(code => add('unclassified', code));
    else add('unclassified', 'gap_reason_unresolved');
  }
  return { domains: Array.from(domains), reasons: Array.from(new Set(reasons)) };
}

/**
 * 选股输入缺口审计（对应选股任务 selection_inputs 模式）：
 * 只读库内标准事实，冻结"应补未补"的对象清单并持久化可续跑队列；
 * 不在这里新增第二条外部采集链路（方案 7.1 要求复用原采集入口）。
 *
 * R2-04：缺口必须带明确的字段/数据集分类（domains），并且：
 * - 只有"待补/排名输入未知/年度异常待补/行业未核验"才进队列，明确不符合(FAIL)与风险暂缓(RISK)不是缺口；
 * - 因此不会出现"gapCount=1 但 reasons=[]"导致补齐任务处理 0 个还报成功；
 * - 明细全量持久化（不再按 5000 条截断），续跑队列因此完整。
 */
async function auditInputs({ market, asOfDate }) {
  const computed = await computeSelection({ market, asOfDate, positionRatio: 1 });
  const gaps = [];
  computed.evaluated.forEach(item => {
    const anomaly = computed.anomalyById ? computed.anomalyById[item.instrumentId] : null;
    const pending = item.filterStatus === RULES.STATUS.PENDING;
    const rankBlocked = item.filterStatus === RULES.STATUS.PASS && item.rankReady === false;
    const anomalyPending = item.filterStatus === RULES.STATUS.PASS && anomaly && anomaly.status === RULES.STATUS.PENDING;
    // 明确不符合(FAIL)与当期风险(RISK)是结论，不是缺口；它们不该被反复"补齐"。
    if (!pending && !rankBlocked && !anomalyPending && item.industry) return;
    const classified = gapDomainsOf(item, anomaly);
    gaps.push({
      code: item.code,
      name: item.name,
      companyId: item.companyId,
      filterStatus: item.filterStatus,
      domains: classified.domains,
      reasons: classified.reasons,
    });
  });
  const domainCounts = gaps.reduce((acc, gap) => {
    gap.domains.forEach(domain => { acc[domain] = (acc[domain] || 0) + 1; });
    return acc;
  }, {});
  const payload = {
    market: computed.market,
    asOfDate: computed.asOfDate,
    generatedAt: new Date().toISOString(),
    universeCount: computed.coverage.universeCount,
    gapCount: gaps.length,
    domainCounts,
    coverage: computed.coverage,
    quality: computed.quality,
    // 全量保存：补齐任务与续跑判定都依赖完整队列，截断会让"剩余数量"失真。
    gaps,
    truncated: false,
  };
  const queueId = await repo.saveInputGapQueue({ market: computed.market, payload });
  return { queueId, gapCount: gaps.length, domainCounts, coverage: computed.coverage, quality: computed.quality, gaps };
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
  buildAnnualYears,
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

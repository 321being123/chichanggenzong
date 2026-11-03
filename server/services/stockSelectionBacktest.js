// 投资策略选股中心：季度回测（方案第 8 节）。
// 复用同一四项过滤、排名、异常与组合函数，按季度滚动；不虚构成交、不默认退市零损失。
// 数据不足以还原时返回 not_evaluable 并披露支持区间，不包装成"历史验证完成"。
'use strict';

const RULES = require('../domain/stockSelectionRules');
const PORTFOLIO = require('../domain/stockSelectionPortfolio');
const repo = require('../repositories/stockSelectionRepository');
const service = require('./stockSelectionService');
const { withTransaction } = require('../db/transaction');

const EXECUTION_MODEL_VERSION = 'next-open-v1';
const COST_VERSION = 'cost-v1';
const DEFAULT_COSTS = Object.freeze({ buyBps: 3, sellBps: 3 });
const BENCHMARK_BY_MARKET = Object.freeze({ CN: 'CSI300', HK: 'HSI' });

function shiftQuarter(quarter, delta) {
  const match = /^(\d{4})Q([1-4])$/.exec(quarter);
  let total = Number(match[1]) * 4 + (Number(match[2]) - 1) + delta;
  const year = Math.floor(total / 4);
  const q = total % 4 + 1;
  return `${year}Q${q}`;
}

function maxDrawdown(series) {
  let peak = -Infinity;
  let worst = 0;
  series.forEach(value => {
    if (!Number.isFinite(value)) return;
    peak = Math.max(peak, value);
    if (peak > 0) worst = Math.min(worst, value / peak - 1);
  });
  return worst;
}

function annualized(series, dayCount) {
  if (!series.length || !dayCount) return null;
  const first = series[0], last = series[series.length - 1];
  if (!(first > 0) || !(last > 0)) return null;
  return Math.pow(last / first, 365 / dayCount) - 1;
}

/**
 * 波动率按**实际观察频率**年化（SSV-08）。
 * 季度净值序列乘 sqrt(252) 会把年化波动放大近 4 倍，是不可比的伪精确值。
 * periodsPerYear 由实际相邻观察间隔天数推算，日频才会接近 252。
 */
function volatility(series, periodsPerYear) {
  const returns = [];
  for (let i = 1; i < series.length; i++) {
    if (series[i - 1] > 0) returns.push(series[i] / series[i - 1] - 1);
  }
  if (returns.length < 2) return null;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  const factor = Number(periodsPerYear);
  if (!Number.isFinite(factor) || factor <= 0) return null;
  return Math.sqrt(variance) * Math.sqrt(factor);
}

/** 由相邻观察日期的实际间隔推算每年观察次数。 */
function periodsPerYearOf(tradeDates) {
  const gaps = [];
  for (let i = 1; i < tradeDates.length; i++) {
    const days = Math.round((new Date(tradeDates[i]) - new Date(tradeDates[i - 1])) / 86400000);
    if (days > 0) gaps.push(days);
  }
  if (!gaps.length) return null;
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  return median > 0 ? 365 / median : null;
}

function toDateText(value) {
  return String(value).slice(0, 10);
}

/**
 * 执行一次回测。区间由实际覆盖推导，不接受写死的起始年份。
 * 执行模型：信号日（季度末）→ 下一交易日未复权开盘价成交；缺执行价保留现金/旧仓。
 */
async function runBacktest(input) {
  const market = String(input.market || '').toUpperCase();
  if (!['CN', 'HK'].includes(market)) {
    const error = new Error('市场参数不合法');
    error.status = 400;
    throw error;
  }
  const startDate = String(input.startDate || '');
  const endDate = String(input.endDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) || startDate >= endDate) {
    const error = new Error('回测区间不合法');
    error.status = 400;
    throw error;
  }
  const costs = Object.assign({}, DEFAULT_COSTS, input.costs || {});
  const strategyVersion = input.strategyVersion || service.STRATEGY_VERSION;
  const calendar = await repo.loadCalendar({ market, fromDate: startDate, toDate: endDate });
  const benchmarkCode = input.benchmarkCode || BENCHMARK_BY_MARKET[market];
  const diagnostics = { quarters: [], missing: {}, supportedFrom: null };
  if (calendar.length < 2) {
    return persistBacktest({
      market, strategyId: null, startDate, endDate, status: 'not_evaluable',
      metrics: {}, diagnostics: Object.assign(diagnostics, { reason: 'calendar_unavailable' }),
      costs, strategyVersion, benchmarkCode,
    });
  }

  // 季度末落在区间内的季度序列。
  const quarterEnds = [];
  const firstQuarter = service.quarterOf(startDate);
  const lastQuarter = service.quarterOf(endDate);
  for (let quarter = firstQuarter; quarter <= lastQuarter; quarter = shiftQuarter(quarter, 1)) {
    const end = service.quarterEndDate(quarter);
    const tradingDay = [...calendar].reverse().find(day => day <= end);
    if (tradingDay && tradingDay >= startDate) quarterEnds.push({ quarter, signalDate: tradingDay });
  }
  if (quarterEnds.length < 2) {
    return persistBacktest({
      market, strategyId: null, startDate, endDate, status: 'not_evaluable',
      metrics: {}, diagnostics: Object.assign(diagnostics, { reason: 'insufficient_quarters', quarterCount: quarterEnds.length }),
      costs, strategyVersion, benchmarkCode,
    });
  }

  // 每个信号日的选股结果（纯计算，不落正式批次）。
  const selections = [];
  for (const item of quarterEnds) {
    const computed = await service.computeSelection({ market, asOfDate: item.signalDate, positionRatio: 1, strategyVersion });
    const executionDate = calendar.find(day => day > item.signalDate) || null;
    selections.push({ ...item, computed, executionDate });
    diagnostics.quarters.push({
      quarter: item.quarter, signalDate: item.signalDate, executionDate,
      marketEligible: computed.gate.eligible,
      publishable: computed.quality.publishable,
      qualityReasons: computed.quality.reasons || [],
      pendingCount: computed.quality.pendingCount,
      industryMissing: computed.quality.industryMissing || 0,
      universeCount: (computed.coverage && computed.coverage.universeCount) || 0,
      selectedCount: computed.portfolio.members.length,
    });
  }

  // 只有"输入未知"才不可还原；指数 PB≥2 属于正常业务关闭（SSV-08）：
  // 那一段就该持有现金，是可还原的历史，不能和缺数据混为一谈。
  // R2-06：可还原性必须按**全部必需质量依赖**裁决，不能只看 data_missing 与 pendingCount。
  // 行业/身份/股份/币种/财年等未知同样让"这个季度选出来的东西"不可信，
  // 把它当成"策略主动空仓"会凭空生成一段全现金零收益的"有效"历史。
  // 唯一可恢复的"零候选"是质量裁决只给出 no_eligible_member（确实没有合格股票）。
  const recoverableOnlyReasons = new Set(['no_eligible_member']);
  const notRecoverable = selections.filter(item => {
    const computed = item.computed;
    const gate = computed.gate || {};
    if (gate.status === 'market_closed') return false;   // 正常关闭：可还原为持有现金
    if (gate.status !== 'eligible') return true;          // 指数数据缺失/异常
    const reasons = (computed.quality && computed.quality.reasons) || [];
    const blocking = reasons.filter(reason => !recoverableOnlyReasons.has(reason));
    return blocking.length > 0;
  });
  if (notRecoverable.length) {
    diagnostics.missing = {
      reason: 'point_in_time_inputs_incomplete',
      quarters: notRecoverable.map(item => item.quarter),
      details: notRecoverable.map(item => ({
        quarter: item.quarter,
        reasons: (item.computed.quality && item.computed.quality.reasons) || [],
        pendingCount: (item.computed.quality && item.computed.quality.pendingCount) || 0,
        industryMissing: (item.computed.quality && item.computed.quality.industryMissing) || 0,
        universeCount: (item.computed.coverage && item.computed.coverage.universeCount) || 0,
      })),
    };
    return persistBacktest({
      market, strategyId: null, startDate, endDate, status: 'not_evaluable',
      metrics: {}, diagnostics, costs, strategyVersion, benchmarkCode,
    });
  }

  const allInstrumentIds = new Set();
  selections.forEach(item => item.computed.portfolio.members.forEach(member => allInstrumentIds.add(member.instrumentId)));
  const executionDates = selections.map(item => item.executionDate).filter(Boolean);
  const openPrices = await repo.loadOpenPrices({ instrumentIds: [...allInstrumentIds], dates: executionDates });
  const benchmarkCloses = await repo.loadBenchmarkCloses({ indexCode: benchmarkCode, fromDate: startDate, toDate: endDate });

  let cash = 1;
  let holdings = new Map();
  const periods = [];
  let totalFees = 0;
  let totalDividends = 0;
  let previousNav = 1;
  let turnoverSum = 0;
  let benchmarkBase = null;
  let benchmarkLast = null;
  let periodStart = null;

  for (const item of selections) {
    if (!item.executionDate) continue;
    const benchmarkAt = day => benchmarkCloses.get(day);
    let unpriced = 0;
    let feesThisPeriod = 0;
    let tradedAmount = 0;
    let dividendsThisPeriod = 0;

    // 持有期现金分红：未复权价格 + 真实分红现金，不重复加股息。
    if (periodStart && holdings.size) {
      const heldIds = [...holdings.keys()];
      const dividends = await repo.loadDividendCash({ instrumentIds: heldIds, fromDate: periodStart, toDate: item.executionDate });
      for (const [instrumentId, position] of holdings) {
        const perShare = dividends.get(String(instrumentId)) || 0;
        if (perShare > 0) {
          const amount = perShare * position.shares;
          dividendsThisPeriod += amount;
          cash += amount;
        }
      }
    }

    // 先按当期开盘价给旧仓估值（缺价用最近一次成交价并计入 unpriced），得到调仓前总资产。
    let holdingsValue = 0;
    for (const [instrumentId, position] of holdings) {
      const price = openPrices.get(`${instrumentId}|${item.executionDate}`);
      if (price === null || price === undefined || !(price > 0)) {
        unpriced++;
        holdingsValue += position.lastPrice * position.shares;
        continue;
      }
      position.lastPrice = price;
      holdingsValue += price * position.shares;
    }
    const navBeforeTrades = cash + holdingsValue;

    // 卖出：按开盘价，缺价保留旧仓（不虚构成交）。
    let proceeds = 0;
    for (const [instrumentId, position] of holdings) {
      const price = openPrices.get(`${instrumentId}|${item.executionDate}`);
      if (price === null || price === undefined || !(price > 0)) { unpriced++; continue; }
      const amount = price * position.shares;
      const fee = amount * Number(costs.sellBps) / 10000;
      proceeds += amount - fee;
      feesThisPeriod += fee;
      tradedAmount += amount;
      holdings.delete(instrumentId);
    }
    cash += proceeds;

    // 买入：按方案 6.1 的固定 30 席权重（SSV-08）。
    // 每席预算 = 调仓前总资产 × 仓位 / 30，而不是"把可用现金平均分给入选股票"——
    // 后者会在只选出 4 只时变成满仓，把行业与风险敞口一起放大。
    const slots = Number(item.computed.params.slotsPerMarket || 30);
    const positionRatio = Number(item.computed.positionRatio === undefined ? 1 : item.computed.positionRatio);
    const targetPerMember = navBeforeTrades * positionRatio / slots;
    const members = item.computed.gate.eligible ? item.computed.portfolio.members : [];
    if (!item.computed.gate.eligible) diagnostics.cashOnlyQuarters = (diagnostics.cashOnlyQuarters || []).concat(item.quarter);
    for (const member of members) {
      const price = openPrices.get(`${member.instrumentId}|${item.executionDate}`);
      if (price === null || price === undefined || !(price > 0)) { unpriced++; continue; }
      if (targetPerMember <= 0) continue;
      const fee = targetPerMember * Number(costs.buyBps) / 10000;
      if (targetPerMember > cash) continue; // 预算不足（含费用）就留现金，不挪用其他席位
      const shares = (targetPerMember - fee) / price;
      holdings.set(member.instrumentId, { shares, entryPrice: price, lastPrice: price, entryDate: item.executionDate });
      cash -= targetPerMember;
      feesThisPeriod += fee;
      tradedAmount += targetPerMember;
    }

    const marketValue = [...holdings].reduce((sum, [instrumentId, position]) => {
      const price = openPrices.get(`${instrumentId}|${item.executionDate}`) || position.lastPrice || position.entryPrice;
      return sum + price * position.shares;
    }, 0);
    const nav = cash + marketValue;
    totalFees += feesThisPeriod;
    totalDividends += dividendsThisPeriod;
    turnoverSum += tradedAmount / Math.max(previousNav, 1e-9);
    const benchmarkClose = benchmarkAt(item.executionDate) || benchmarkLast;
    if (benchmarkBase === null && benchmarkClose) benchmarkBase = benchmarkClose;
    if (benchmarkClose) benchmarkLast = benchmarkClose;
    periods.push({
      tradeDate: item.executionDate,
      nav: Number(nav.toFixed(8)),
      cashWeight: nav > 0 ? Number((cash / nav).toFixed(8)) : 1,
      turnover: Number((tradedAmount / Math.max(previousNav, 1e-9)).toFixed(8)),
      fees: Number(feesThisPeriod.toFixed(8)),
      dividendIncome: Number(dividendsThisPeriod.toFixed(8)),
      benchmarkNav: benchmarkBase && benchmarkClose ? Number((benchmarkClose / benchmarkBase).toFixed(8)) : null,
      unpricedCount: unpriced,
    });
    previousNav = nav;
    periodStart = item.executionDate;
    diagnostics.supportedFrom = diagnostics.supportedFrom || item.signalDate;
  }

  if (periods.length < 2) {
    diagnostics.missing = { reason: 'insufficient_executable_periods', periods: periods.length };
    return persistBacktest({
      market, strategyId: null, startDate, endDate, status: 'not_evaluable',
      metrics: {}, diagnostics, costs, strategyVersion, benchmarkCode,
    });
  }

  const navSeries = periods.map(item => item.nav);
  const dayCount = Math.round((new Date(periods[periods.length - 1].tradeDate) - new Date(periods[0].tradeDate)) / 86400000);
  const metrics = {
    totalReturn: navSeries[navSeries.length - 1] / navSeries[0] - 1,
    annualizedReturn: annualized(navSeries, dayCount),
    maxDrawdown: maxDrawdown(navSeries),
    // 季度序列不足时不输出伪精确的波动与夏普。
    volatility: periods.length >= 5 ? volatility(navSeries, periodsPerYearOf(periods.map(item => item.tradeDate))) : null,
    periodsPerYear: periodsPerYearOf(periods.map(item => item.tradeDate)),
    sharpe: null,
    turnover: turnoverSum,
    fees: totalFees,
    dividendIncome: totalDividends,
    cashWeightLast: periods[periods.length - 1].cashWeight,
    benchmarkReturn: periods[periods.length - 1].benchmarkNav === null ? null : periods[periods.length - 1].benchmarkNav - 1,
    benchmarkReturnType: 'price',
    periodCount: periods.length,
    currency: input.currency || 'LOCAL',
    note: periods.length < 5 ? '季度样本不足 5 期，波动率与夏普不输出' : null,
  };

  return persistBacktest({
    market, strategyId: null, startDate, endDate, status: 'partial',
    metrics, diagnostics, costs, strategyVersion, benchmarkCode, periods,
  });
}

async function persistBacktest(input) {
  const inputHash = require('crypto').createHash('sha256')
    .update(JSON.stringify({ market: input.market, start: input.startDate, end: input.endDate, costs: input.costs, strategyVersion: input.strategyVersion, benchmarkCode: input.benchmarkCode }))
    .digest('hex');
  const backtestId = await withTransaction(async tx => {
    const strategyId = input.strategyId || await resolveStrategyId(tx, input);
    const id = await repo.insertBacktest(tx, {
      market: input.market,
      strategyId,
      startDate: input.startDate,
      endDate: input.endDate,
      currency: input.currency || 'LOCAL',
      status: input.status,
      inputHash,
      executionModelVersion: EXECUTION_MODEL_VERSION,
      costVersion: COST_VERSION,
      benchmarkCode: input.benchmarkCode,
      benchmarkReturnType: 'price',
      parameters: { costs: input.costs, strategyVersion: input.strategyVersion },
      metrics: input.metrics || {},
      diagnostics: input.diagnostics || {},
    });
    if (input.periods && input.periods.length) await repo.insertBacktestPeriods(tx, id, input.periods);
    return id;
  });
  return { backtestId, status: input.status, metrics: input.metrics || {}, diagnostics: input.diagnostics || {} };
}

async function resolveStrategyId(tx, input) {
  return repo.upsertStrategy(tx, {
    strategyCode: RULES.STRATEGY_CODE,
    market: input.market,
    version: input.strategyVersion || service.STRATEGY_VERSION,
    formulaVersion: RULES.DEFAULT_PARAMS.formulaVersion,
    adapterVersion: RULES.DEFAULT_PARAMS.adapterVersion,
    riskVersion: RULES.DEFAULT_PARAMS.riskVersion,
    industryVersion: RULES.DEFAULT_PARAMS.industryVersion,
    effectiveFrom: input.startDate,
    parameters: RULES.DEFAULT_PARAMS,
    contentHash: require('crypto').createHash('sha256')
      .update(JSON.stringify({ strategy: RULES.STRATEGY_CODE, params: RULES.DEFAULT_PARAMS, version: input.strategyVersion || service.STRATEGY_VERSION }))
      .digest('hex'),
  });
}

module.exports = {
  runBacktest,
  EXECUTION_MODEL_VERSION,
  COST_VERSION,
  DEFAULT_COSTS,
  BENCHMARK_BY_MARKET,
  shiftQuarter,
  maxDrawdown,
  annualized,
  volatility,
  periodsPerYearOf,
};

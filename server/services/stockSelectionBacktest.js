// 投资策略选股中心：季度回测（方案第 8 节）。
// 复用同一四项过滤、排名、异常与组合函数，按季度滚动；不虚构成交、不默认退市零损失。
// 数据不足以还原时返回 not_evaluable 并披露支持区间，不包装成"历史验证完成"。
'use strict';

const RULES = require('../domain/stockSelectionRules');
const RULES_V2 = require('../domain/stockSelectionRulesV2');
const PORTFOLIO = require('../domain/stockSelectionPortfolio');
const PERIODS = require('./stockSelectionPeriods');
const repo = require('../repositories/stockSelectionRepository');
const service = require('./stockSelectionService');
const { withTransaction } = require('../db/transaction');
const CoreDate = require('../../public/shared/core-date.js');

// 执行模型版本（方案 27.11.2）：
// v1 曾是"每期先卖光所有旧仓再按目标金额买入"，周频会人为制造重复买卖和费用；
// v2 改为净订单：deltaQty = 目标数量 − 当前数量，正买负卖、零不下单，只减仓只生成卖单。
const EXECUTION_MODEL_VERSION = 'next-open-net-order-v1';
const LEGACY_EXECUTION_MODEL = 'legacy-sell-all-v1';
/** 估值模型版本：逐日收盘估值 + 停牌/涨跌停/容量约束（与执行模型分开标注，便于对账）。 */
const VALUATION_MODEL_VERSION = 'daily-close-valuation-v1';
const CAPACITY_VERSION = 'capacity-v1';
const COST_VERSION = 'cost-v1';
const DEFAULT_COSTS = Object.freeze({ buyBps: 3, sellBps: 3 });
const DEFAULT_PARTICIPATION_RATE = 0.05;
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

/* ------------------------------------------------------------------ *
 * V2 回测执行模型（方案 27.11.2 / 27.11.3）
 * ------------------------------------------------------------------ */

/** 信号日序列：季度末最后开市日，或每周最后开市日（周键用周一起始日）。 */
function buildSignalSchedule({ calendar, startDate, endDate, frequency }) {
  if (frequency === 'week') {
    const byWeek = new Map();
    calendar.forEach(day => {
      if (day < startDate || day > endDate) return;
      const monday = PERIODS.weekMondayOf(day);
      if (monday) byWeek.set(monday, day); // 升序遍历，最后写入即该周最后一个开市日
    });
    return [...byWeek.entries()]
      .sort((a, b) => (a[1] < b[1] ? -1 : 1))
      .map(([monday, signalDate]) => ({ periodKey: `W:${monday}`, signalDate }));
  }
  const schedule = [];
  const firstQuarter = service.quarterOf(startDate);
  const lastQuarter = service.quarterOf(endDate);
  for (let quarter = firstQuarter; quarter <= lastQuarter; quarter = shiftQuarter(quarter, 1)) {
    const end = service.quarterEndDate(quarter);
    const tradingDay = [...calendar].reverse().find(day => day <= end);
    if (tradingDay && tradingDay >= startDate && tradingDay <= endDate) {
      schedule.push({ periodKey: `Q:${quarter}`, quarter, signalDate: tradingDay });
    }
  }
  return schedule;
}

/**
 * 涨跌停比例：A 股按代码板块近似（主板 10%、创业板/科创板 20%、北交所 30%），港股无涨跌停。
 * ST 的 5% 无法从现有主档可靠识别，诊断里显式标注 limit_model='board_approximation'，
 * 不把近似当已核验的真实限价规则。
 */
function priceLimitRatio({ market, code }) {
  if (market !== 'CN') return null;
  const text = String(code || '');
  if (text.startsWith('300') || text.startsWith('301') || text.startsWith('688')) return 0.2;
  if (text.startsWith('8') || text.startsWith('4')) return 0.3;
  return 0.1;
}

function barsIndexOf(barWindow) {
  const index = new Map();
  for (const [instrumentId, list] of barWindow) {
    const byDate = new Map();
    list.forEach(bar => byDate.set(bar.tradeDate, bar));
    index.set(String(instrumentId), { byDate, dates: list.map(bar => bar.tradeDate) });
  }
  return index;
}

function barOf(index, instrumentId, date) {
  const entry = index.get(String(instrumentId));
  return entry ? entry.byDate.get(date) || null : null;
}

/** 前收盘价：同一证券在目标日之前最近一个交易日的收盘（缺前收则不做涨跌停判断并留证）。 */
function prevCloseOf(index, instrumentId, date) {
  const entry = index.get(String(instrumentId));
  if (!entry) return null;
  let lo = 0;
  let hi = entry.dates.length - 1;
  let best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (entry.dates[mid] < date) { best = entry.dates[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  if (!best) return null;
  const bar = entry.byDate.get(best);
  return bar && bar.close > 0 ? bar.close : null;
}

/**
 * 保守撮合：只有日线时，停牌/开盘即涨跌停一律不成交（等待下一期），
 * 容量按当日成交额 × participationRate 缩量，缺成交额视为容量未核验（允许成交但留证）。
 */
function matchOrder({ side, wantQty, price, bar, prevClose, limitRatio, participationRate }) {
  if (!bar) return { filledQty: 0, filledAmount: 0, reason: 'suspended_or_no_bar', capacityVerified: false };
  if (!(price > 0)) return { filledQty: 0, filledAmount: 0, reason: 'missing_open', capacityVerified: false };
  if (prevClose > 0 && limitRatio !== null && limitRatio !== undefined) {
    if (side === 'buy' && price >= prevClose * (1 + limitRatio) - 1e-6) {
      return { filledQty: 0, filledAmount: 0, reason: 'limit_up_at_open', capacityVerified: false };
    }
    if (side === 'sell' && price <= prevClose * (1 - limitRatio) + 1e-6) {
      return { filledQty: 0, filledAmount: 0, reason: 'limit_down_at_open', capacityVerified: false };
    }
  }
  const turnover = bar.amount === null || bar.amount === undefined ? null : Number(bar.amount);
  let qty = wantQty;
  let amount = qty * price;
  let capacityLimited = false;
  if (turnover !== null && turnover > 0 && participationRate > 0) {
    const cap = turnover * participationRate;
    if (amount > cap) {
      amount = cap;
      qty = amount / price;
      capacityLimited = true;
    }
  }
  if (!(qty > 1e-12)) {
    return { filledQty: 0, filledAmount: 0, reason: 'capacity_zero', capacityVerified: turnover !== null && turnover > 0 };
  }
  return {
    filledQty: qty,
    filledAmount: amount,
    reason: capacityLimited ? 'capacity_capped' : null,
    capacityLimited,
    capacityVerified: turnover !== null && turnover > 0,
  };
}

/**
 * 执行一次回测。区间由实际覆盖推导，不接受写死的起始年份。
 * 执行模型：信号日（季度末）→ 下一交易日未复权开盘价成交；缺执行价保留现金/旧仓。
 */
async function runQuarterlyLegacy(input) {
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
  // 回测必须与被测策略同源：V2 回测不能默默用 V1 规则算成员（方案 27.11.3 的 A0/A1 分步）。
  const strategyCode = input.strategyCode || undefined;
  const calendar = await repo.loadCalendar({ market, fromDate: startDate, toDate: endDate });
  const benchmarkCode = input.benchmarkCode || BENCHMARK_BY_MARKET[market];
  const diagnostics = { quarters: [], missing: {}, supportedFrom: null };
  if (calendar.length < 2) {
    return persistBacktest({
      market, strategyId: null, startDate, endDate, status: 'not_evaluable',
      metrics: {}, diagnostics: Object.assign(diagnostics, { reason: 'calendar_unavailable' }),
      costs, strategyVersion, strategyCode, benchmarkCode,
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
      costs, strategyVersion, strategyCode, benchmarkCode,
    });
  }

  // 每个信号日的选股结果（纯计算，不落正式批次）。
  const selections = [];
  for (const item of quarterEnds) {
    const computed = await service.computeSelection({ market, asOfDate: item.signalDate, positionRatio: 1, strategyVersion, strategyCode });
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
    // 质量结构不完整（缺 reasons 数组）时不能当成"没有阻断"：那是未知，不是通过。
    // 修复前空池只填 quality.reason 不填 reasons，于是缺数据被算成 0% 收益的策略空仓。
    if (!Array.isArray(reasons) || reasons.length === 0) {
      const hasVerdict = computed.quality && (computed.quality.publishable === true
        || (Array.isArray(computed.portfolio?.members) && computed.portfolio.members.length > 0));
      // 有合格成员却没有任何质量原因 = 正常可还原；其余一律按不可还原处理。
      if (!hasVerdict) return true;
    }
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
      metrics: {}, diagnostics, costs, strategyVersion, strategyCode, benchmarkCode,
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

    // 净订单调仓（方案 27.11.2）：
    //   目标数量 = 每席目标金额 ÷ 当期开盘价；deltaQty = 目标 − 当前；正买负卖、零不下单。
    // 不再"先卖光再买回"——那会在价格漂移时凭空多出一轮买卖和费用；
    // "名单没变"也不保证零交易：权重漂移、分红、股数变化都可能产生真实净再平衡。
    const slots = Number(item.computed.params.slotsPerMarket || 30);
    const positionRatio = Number(item.computed.positionRatio === undefined ? 1 : item.computed.positionRatio);
    const targetPerMember = navBeforeTrades * positionRatio / slots;
    // V2 取消指数门槛后 gate.eligible 恒为 true；V1 仍按原合同在指数不合格时只留现金。
    const members = item.computed.gate.eligible ? item.computed.portfolio.members : [];
    if (!item.computed.gate.eligible) diagnostics.cashOnlyQuarters = (diagnostics.cashOnlyQuarters || []).concat(item.quarter);

    const desiredQty = new Map();
    const priceOf = instrumentId => openPrices.get(`${instrumentId}|${item.executionDate}`);
    for (const member of members) {
      const price = priceOf(member.instrumentId);
      if (price === null || price === undefined || !(price > 0)) { unpriced++; continue; }
      if (targetPerMember <= 0) continue;
      desiredQty.set(member.instrumentId, targetPerMember / price);
    }
    // 不在目标里的持仓 → 目标数量 0（退出），按 delta 卖出而不是无条件清仓。
    for (const instrumentId of holdings.keys()) {
      if (!desiredQty.has(instrumentId)) desiredQty.set(instrumentId, 0);
    }

    const periodOrders = [];
    // 先卖：回收现金再买，避免"先买后卖"用不存在的钱。
    for (const [instrumentId, position] of [...holdings]) {
      const price = priceOf(instrumentId);
      if (price === null || price === undefined || !(price > 0)) { unpriced++; continue; }
      const targetQty = desiredQty.get(instrumentId) || 0;
      const delta = targetQty - position.shares;
      if (delta >= -1e-9) continue;
      const sellQty = Math.min(-delta, position.shares);
      if (sellQty <= 1e-12) continue;
      const amount = price * sellQty;
      const fee = amount * Number(costs.sellBps) / 10000;
      cash += amount - fee;
      feesThisPeriod += fee;
      tradedAmount += amount;
      position.shares -= sellQty;
      if (position.shares <= 1e-9) holdings.delete(instrumentId);
      periodOrders.push({
        instrumentId, side: 'sell', qty: Number(sellQty.toFixed(8)),
        price: Number(price.toFixed(6)), amount: Number(amount.toFixed(2)), fee: Number(fee.toFixed(2)),
        reason: targetQty === 0 ? 'exit' : 'rebalance',
      });
    }

    // 再买：只补足差额；现金不足按可用现金压缩该笔，不挪用其他席位预算、不透支现金。
    for (const member of members) {
      const price = priceOf(member.instrumentId);
      if (price === null || price === undefined || !(price > 0)) { unpriced++; continue; }
      const targetQty = desiredQty.get(member.instrumentId);
      if (!(targetQty > 0)) continue;
      const currentQty = holdings.get(member.instrumentId) ? holdings.get(member.instrumentId).shares : 0;
      const delta = targetQty - currentQty;
      if (delta <= 1e-12) continue;
      const unitFeeRate = Number(costs.buyBps) / 10000;
      let amount = price * delta;
      let fee = amount * unitFeeRate;
      if (amount + fee > cash) {
        const affordable = Math.max(cash, 0) / (1 + unitFeeRate);
        if (affordable <= 1e-9) continue;
        amount = affordable;
        fee = amount * unitFeeRate;
      }
      const buyQty = amount / price;
      if (buyQty <= 1e-12) continue;
      const existing = holdings.get(member.instrumentId);
      if (existing) {
        // 加仓按加权成本更新入场价，持仓日期保持首次建仓日。
        const totalQty = existing.shares + buyQty;
        existing.entryPrice = (existing.entryPrice * existing.shares + price * buyQty) / totalQty;
        existing.shares = totalQty;
        existing.lastPrice = price;
      } else {
        holdings.set(member.instrumentId, { shares: buyQty, entryPrice: price, lastPrice: price, entryDate: item.executionDate });
      }
      cash -= amount + fee;
      feesThisPeriod += fee;
      tradedAmount += amount;
      periodOrders.push({
        instrumentId: member.instrumentId, side: 'buy', qty: Number(buyQty.toFixed(8)),
        price: Number(price.toFixed(6)), amount: Number(amount.toFixed(2)), fee: Number(fee.toFixed(2)),
        reason: currentQty > 0 ? 'rebalance' : 'entry',
      });
    }
    // 账本留证：按设计只保留有界摘要（每期笔数 + 最近 200 笔明细），
    // 完整成交明细属于可重算派生物，不在回测主表堆无界 JSON。
    diagnostics.orderLedger = diagnostics.orderLedger || { periods: 0, orders: 0, fees: 0, sample: [] };
    diagnostics.orderLedger.periods += 1;
    diagnostics.orderLedger.orders += periodOrders.length;
    diagnostics.orderLedger.fees = Number((diagnostics.orderLedger.fees + feesThisPeriod).toFixed(2));
    if (periodOrders.length && diagnostics.orderLedger.sample.length < 200) {
      periodOrders.slice(0, 200 - diagnostics.orderLedger.sample.length).forEach(order => {
        diagnostics.orderLedger.sample.push(Object.assign({ tradeDate: item.executionDate, quarter: item.quarter }, order));
      });
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

  // 区间末终值（F10）：净值此前只在调仓执行日估值，请求到 2026-09-30 的回测最后净值会停在
  // 2026-07-01。这里补一次按收盘价的期末估值，并把终段分红与基准一起算进去。
  const finalDate = calendar[calendar.length - 1];
  if (periods.length && finalDate && finalDate > periods[periods.length - 1].tradeDate) {
    let dividendsThisPeriod = 0;
    if (periodStart && holdings.size) {
      const dividends = await repo.loadDividendCash({ instrumentIds: [...holdings.keys()], fromDate: periodStart, toDate: finalDate });
      for (const [instrumentId, position] of holdings) {
        const perShare = dividends.get(String(instrumentId)) || 0;
        if (perShare > 0) {
          const amount = perShare * position.shares;
          dividendsThisPeriod += amount;
          cash += amount;
        }
      }
    }
    let unpriced = 0;
    let marketValue = 0;
    if (holdings.size) {
      const closes = await repo.loadClosePrices({ instrumentIds: [...holdings.keys()], dates: [finalDate] });
      for (const [instrumentId, position] of holdings) {
        const price = closes.get(`${instrumentId}|${finalDate}`);
        if (price === null || price === undefined || !(price > 0)) {
          unpriced++;
          marketValue += position.lastPrice * position.shares;
          continue;
        }
        position.lastPrice = price;
        marketValue += price * position.shares;
      }
    }
    const nav = cash + marketValue;
    totalDividends += dividendsThisPeriod;
    const benchmarkClose = benchmarkCloses.get(finalDate) || benchmarkLast;
    if (benchmarkBase === null && benchmarkClose) benchmarkBase = benchmarkClose;
    if (benchmarkClose) benchmarkLast = benchmarkClose;
    periods.push({
      tradeDate: finalDate,
      nav: Number(nav.toFixed(8)),
      cashWeight: nav > 0 ? Number((cash / nav).toFixed(8)) : 1,
      turnover: 0,
      fees: 0,
      dividendIncome: Number(dividendsThisPeriod.toFixed(8)),
      benchmarkNav: benchmarkBase && benchmarkClose ? Number((benchmarkClose / benchmarkBase).toFixed(8)) : null,
      unpricedCount: unpriced,
      valuationOnly: true,
    });
    previousNav = nav;
    diagnostics.finalValuationDate = finalDate;
  }

  if (periods.length < 2) {
    diagnostics.missing = { reason: 'insufficient_executable_periods', periods: periods.length };
    return persistBacktest({
      market, strategyId: null, startDate, endDate, status: 'not_evaluable',
      metrics: {}, diagnostics, costs, strategyVersion, strategyCode, benchmarkCode,
    });
  }

  const navSeries = periods.map(item => item.nav);
  const dayCount = Math.round((new Date(periods[periods.length - 1].tradeDate) - new Date(periods[0].tradeDate)) / 86400000);
  const metrics = {
    effectiveStart: periods[0].tradeDate,
    effectiveEnd: periods[periods.length - 1].tradeDate,
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
    metrics, diagnostics, costs, strategyVersion, strategyCode, benchmarkCode, periods,
  });
}

/**
 * 逐日估值 + 保守撮合的新执行引擎（方案 27.11.2）。
 * 与旧引擎共用同一批 computeSelection 结果，差异在于：
 * - 信号频率可配 quarter / week；
 * - 调仓按日级撮合（停牌、开盘即涨跌停不成交，容量按成交额参与率缩量），未成交保留原持仓；
 * - 净值按每个交易日收盘估值，日曲线覆盖起始资本到区间末（不从首次扣费后重新置 1）；
 * - 分红记在真实除息日；
 * - legacy 分支复现"先全卖再全买"，只用于 A0/A1 桥接对照，不改写历史标签。
 */
async function runDailyBacktest(input) {
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
  const frequency = input.signalFrequency === 'week' ? 'week' : 'quarter';
  const executionModel = input.executionModel === 'legacy' ? LEGACY_EXECUTION_MODEL : EXECUTION_MODEL_VERSION;
  const replayType = input.replayMode === 'real' ? 'real_publication_replay' : 'pit_research_replay';
  const participationRate = Number.isFinite(Number(input.participationRate))
    ? Math.min(Math.max(Number(input.participationRate), 0), 1)
    : DEFAULT_PARTICIPATION_RATE;
  const costs = Object.assign({}, DEFAULT_COSTS, input.costs || {});
  const strategyVersion = input.strategyVersion || service.STRATEGY_VERSION;
  const strategyCode = input.strategyCode || undefined;
  const benchmarkCode = input.benchmarkCode || BENCHMARK_BY_MARKET[market];
  const diagnostics = {
    signalFrequency: frequency,
    executionModel,
    valuationModel: VALUATION_MODEL_VERSION,
    capacityModel: CAPACITY_VERSION,
    participationRate,
    replayType,
    limitModel: market === 'CN' ? 'board_approximation' : 'none',
    blocked: {},
    periods: [],
    missing: {},
    supportedFrom: null,
  };

  const calendar = await repo.loadCalendar({ market, fromDate: startDate, toDate: endDate });
  if (calendar.length < 2) {
    diagnostics.reason = 'calendar_unavailable';
    return persistBacktest({
      market, strategyId: null, startDate, endDate, status: 'not_evaluable',
      metrics: {}, diagnostics, costs, strategyVersion, strategyCode, benchmarkCode,
      executionModel, replayType,
    });
  }

  const schedule = buildSignalSchedule({ calendar, startDate, endDate, frequency });
  if (schedule.length < 2) {
    diagnostics.reason = 'insufficient_signals';
    diagnostics.signalCount = schedule.length;
    return persistBacktest({
      market, strategyId: null, startDate, endDate, status: 'not_evaluable',
      metrics: {}, diagnostics, costs, strategyVersion, strategyCode, benchmarkCode,
      executionModel, replayType,
    });
  }

  const selections = [];
  for (const item of schedule) {
    const computed = await service.computeSelection({
      market,
      asOfDate: item.signalDate,
      positionRatio: 1,
      strategyVersion,
      strategyCode,
      internalParams: input.internalParams || null,
    });
    const executionDate = calendar.find(day => day > item.signalDate) || null;
    selections.push(Object.assign({}, item, { computed, executionDate }));
    diagnostics.periods.push({
      periodKey: item.periodKey,
      signalDate: item.signalDate,
      executionDate,
      strategyCode: computed.strategyCode,
      universeCount: (computed.coverage && computed.coverage.universeCount) || 0,
      selectedCount: computed.portfolio.members.length,
      publishable: computed.quality.publishable,
      qualityReasons: computed.quality.reasons || [],
      pendingCount: computed.quality.pendingCount,
      universeArtifact: computed.universeEvidence || null,
    });
  }

  // 真实发布回放（方案 27.11.1 / B04）：消费已提交且已确认可见的发布事件，
  // 冻结当时实际 run 的成员，在可见时刻之后的首个可交易开盘执行；
  // 缺事件/缺成员/可见时刻缺失一律不可评估——不拿"今天重算的名单"冒充真实发布输入。
  if (replayType === 'real_publication_replay') {
    const periodType = frequency === 'week' ? 'week' : 'quarter';
    const eventsByPeriod = await repo.loadPublicationReplayEvidence({
      market,
      periodType,
      periodKeys: selections.map(item => item.periodKey),
      strategyCode: strategyCode || null,
    });
    // 冻结每个被引用 run 的成员：首次发布与后续修订各自的 run 都要取，不能只取最后一个。
    const membersByRun = new Map();
    const referencedRunIds = new Set();
    for (const list of eventsByPeriod.values()) {
      list.forEach(event => {
        [event.to_run_id, event.from_run_id].forEach(value => {
          if (value) referencedRunIds.add(Number(value));
        });
      });
    }
    for (const runId of referencedRunIds) {
      membersByRun.set(runId, await repo.listMembers(runId));
    }
    const plan = resolveRealReplayPlan({ selections, eventsByPeriod, calendar, membersByRun, market });
    diagnostics.replayCoverage = {
      signals: selections.length,
      executed: plan.resolved.length,
      pending: plan.pending.length,
      missing: plan.missing.length,
    };
    // 待执行（区间外）单列披露：它不影响已实现历史，但必须能复核"哪一期没成交、为什么"。
    if (plan.pending.length) diagnostics.replayPending = plan.pending;
    if (plan.missing.length) {
      diagnostics.missing = {
        reason: 'real_publication_events_missing',
        periods: plan.missing.map(item => item.periodKey),
        details: plan.missing,
      };
      return persistBacktest({
        market, strategyId: null, startDate, endDate, status: 'not_evaluable',
        metrics: {}, diagnostics, costs, strategyVersion, strategyCode, benchmarkCode,
        executionModel, replayType,
      });
    }
    // 真回放至少要有两笔可执行发布才形成区间收益；只有一笔时如实说"可执行发布不足"，
    // 不把"尾部还没成交"混进"缺数据"。
    if (plan.resolved.length < 2) {
      diagnostics.reason = 'insufficient_executable_publications';
      return persistBacktest({
        market, strategyId: null, startDate, endDate, status: 'not_evaluable',
        metrics: {}, diagnostics, costs, strategyVersion, strategyCode, benchmarkCode,
        executionModel, replayType,
      });
    }
    selections.length = 0;
    selections.push(...plan.resolved);
    diagnostics.replayEvidence = plan.resolved.map(item => Object.assign(
      { periodKey: item.periodKey }, item.replayEvidence,
      {
        effectiveTarget: item.effectiveTarget,
        ...(item.effectiveTarget === false ? { supersededByEventId: item.supersededByEventId } : {}),
      },
    ));
    // 同窗被后续事件取代的版本：只留审计，不产生订单（E01）。
    const superseded = plan.resolved.filter(item => item.effectiveTarget === false);
    if (superseded.length) {
      diagnostics.replaySuperseded = superseded.map(item => ({
        periodKey: item.periodKey,
        eventId: item.eventId,
        runId: item.replayEvidence.runId,
        executionDate: item.executionDate,
        supersededByEventId: item.supersededByEventId,
        supersededByRunId: item.supersededByRunId,
        reason: 'superseded_before_first_tradable_open',
      }));
    }
    diagnostics.periods.forEach(period => {
      const hits = plan.resolved.filter(item => item.periodKey === period.periodKey);
      if (!hits.length) {
        // 尾部待执行的周期：保留期次与信号日，明确标注未成交原因，不当成"没有这期"。
        const pend = plan.pending.filter(item => item.periodKey === period.periodKey);
        if (pend.length) {
          period.executionDate = null;
          period.pendingExecution = pend;
        }
        return;
      }
      // 同一周期可能有多段（首次发布 + 修订）：保留完整事件序列，别只记最后一条。
      period.executionDate = hits[hits.length - 1].executionDate;
      period.replayEvents = hits.map(item => item.replayEvidence);
      period.replayEvidence = hits[hits.length - 1].replayEvidence;
    });
  }

  // 可还原性：只有"输入未知"才不可还原；指数 PB 正常关闭属于可还原的现金区间（SSV-08 / R2-06）。
  const recoverableOnlyReasons = new Set(['no_eligible_member']);
  const notRecoverable = selections.filter(item => {
    const computed = item.computed;
    const gate = computed.gate || {};
    if (gate.status === 'market_closed') return false;
    if (gate.status !== 'eligible') return true;
    const reasons = (computed.quality && computed.quality.reasons) || [];
    if (!Array.isArray(reasons) || reasons.length === 0) {
      const hasVerdict = computed.quality && (computed.quality.publishable === true
        || (Array.isArray(computed.portfolio && computed.portfolio.members) && computed.portfolio.members.length > 0));
      if (!hasVerdict) return true;
    }
    return reasons.filter(reason => !recoverableOnlyReasons.has(reason)).length > 0;
  });
  if (notRecoverable.length) {
    diagnostics.missing = {
      reason: 'point_in_time_inputs_incomplete',
      periods: notRecoverable.map(item => item.periodKey),
      // 季度频率同时给旧字段名（quarters），既有诊断契约与告警按键名不改。
      quarters: notRecoverable.filter(item => item.periodKey.startsWith('Q:'))
        .map(item => item.periodKey.slice(2)),
      details: notRecoverable.map(item => ({
        periodKey: item.periodKey,
        quarter: item.periodKey.startsWith('Q:') ? item.periodKey.slice(2) : null,
        reasons: (item.computed.quality && item.computed.quality.reasons) || [],
        pendingCount: (item.computed.quality && item.computed.quality.pendingCount) || 0,
        industryMissing: (item.computed.quality && item.computed.quality.industryMissing) || 0,
        universeCount: (item.computed.coverage && item.computed.coverage.universeCount) || 0,
        universeArtifact: item.computed.universeEvidence || null,
      })),
    };
    return persistBacktest({
      market, strategyId: null, startDate, endDate, status: 'not_evaluable',
      metrics: {}, diagnostics, costs, strategyVersion, strategyCode, benchmarkCode,
      executionModel, replayType,
    });
  }

  const allInstrumentIds = new Set();
  selections.forEach(item => item.computed.portfolio.members.forEach(member => allInstrumentIds.add(member.instrumentId)));
  const barWindow = await repo.loadBarWindow({
    instrumentIds: [...allInstrumentIds],
    fromDate: PERIODS.shiftDays(startDate, -15),
    toDate: endDate,
  });
  const bars = barsIndexOf(barWindow);
  const dividendByDate = await repo.loadDividendEvents({
    instrumentIds: [...allInstrumentIds], fromDate: startDate, toDate: endDate,
  });
  const benchmarkCloses = await repo.loadBenchmarkCloses({ indexCode: benchmarkCode, fromDate: startDate, toDate: endDate });
  const limitByInstrument = new Map();
  selections.forEach(item => {
    item.computed.portfolio.members.forEach(member => {
      if (!limitByInstrument.has(member.instrumentId)) {
        limitByInstrument.set(member.instrumentId, priceLimitRatio({ market, code: member.code }));
      }
    });
  });

  // 同一执行日可能有多期（真实回放里首次发布与当天修订都落在同一个可交易日）：
  // 用数组保存，按事件顺序依次调仓，不能互相覆盖（C04）。
  const signalsByExecution = new Map();
  selections.forEach(item => {
    if (!item.executionDate) return;
    if (!signalsByExecution.has(item.executionDate)) signalsByExecution.set(item.executionDate, []);
    signalsByExecution.get(item.executionDate).push(item);
  });

  let cash = 1;
  const holdings = new Map();
  const dailySeries = [];
  const periods = [];
  let totalFees = 0;
  let totalDividends = 0;
  let turnoverSum = 0;
  let previousNav = 1;
  let benchmarkBase = null;
  let benchmarkLast = null;
  let capacityUnverifiedTrades = 0;

  const bump = reason => { diagnostics.blocked[reason] = (diagnostics.blocked[reason] || 0) + 1; };
  const openOf = (instrumentId, date) => {
    const bar = barOf(bars, instrumentId, date);
    return bar && bar.open > 0 ? bar.open : null;
  };
  const closeOf = (instrumentId, date) => {
    const bar = barOf(bars, instrumentId, date);
    return bar && bar.close > 0 ? bar.close : null;
  };

  for (const day of calendar) {
    if (day < startDate || day > endDate) continue;

    // 1) 除息日现金入账（按当时实际持股数，未成交的卖出不影响已派现）
    let dividendsToday = 0;
    (dividendByDate.get(day) || []).forEach(event => {
      const position = holdings.get(event.instrumentId);
      if (!position || !(position.shares > 0)) return;
      const amount = event.perShare * position.shares;
      cash += amount;
      dividendsToday += amount;
      totalDividends += amount;
    });

    // 2) 调仓（信号执行日）
    let feesToday = 0;
    let tradedToday = 0;
    const daySignals = signalsByExecution.get(day) || [];
    // 只按"开盘时最终生效的目标"下单（E01）：同日被后续事件取代的版本不产生任何成交，
    // 但仍记在诊断里。真实旧仓与现金只受最终目标影响，费用与换手因此不会因中间版本翻倍。
    const effectiveSignals = daySignals.filter(item => item.effectiveTarget !== false);
    for (const signal of effectiveSignals) {
      const computed = signal.computed;
      const members = computed.gate.eligible ? computed.portfolio.members : [];
      const slots = Number(computed.params.slotsPerMarket || 30);
      const ratio = Number(computed.positionRatio === undefined ? 1 : computed.positionRatio);
      // 调仓前总资产按当日开盘价（缺价用最后已知价，并计入 unpriced）
      let navBeforeTrades = cash;
      for (const [instrumentId, position] of holdings) {
        const price = openOf(instrumentId, day);
        navBeforeTrades += (price === null ? position.lastPrice : price) * position.shares;
      }
      const targetPerMember = navBeforeTrades * ratio / slots;

      const desiredQty = new Map();
      const isLegacy = executionModel === LEGACY_EXECUTION_MODEL;
      if (!isLegacy) {
        for (const member of members) {
          const price = openOf(member.instrumentId, day);
          if (price === null) { bump('missing_open'); continue; }
          if (targetPerMember > 0) desiredQty.set(member.instrumentId, targetPerMember / price);
        }
        for (const instrumentId of holdings.keys()) {
          if (!desiredQty.has(instrumentId)) desiredQty.set(instrumentId, 0);
        }
      } else {
        // A0 对照：所有旧仓目标为 0，members 全量按目标金额买入（复现旧行为，不用于正式结论）
        for (const instrumentId of holdings.keys()) desiredQty.set(instrumentId, 0);
      }

      // 先卖：回收现金再买
      for (const [instrumentId, position] of [...holdings]) {
        const targetQty = desiredQty.get(instrumentId) || 0;
        const delta = targetQty - position.shares;
        if (delta >= -1e-9) continue;
        const price = openOf(instrumentId, day);
        const match = matchOrder({
          side: 'sell',
          wantQty: Math.min(-delta, position.shares),
          price,
          bar: barOf(bars, instrumentId, day),
          prevClose: prevCloseOf(bars, instrumentId, day),
          limitRatio: limitByInstrument.has(instrumentId) ? limitByInstrument.get(instrumentId) : null,
          participationRate,
        });
        if (!(match.filledQty > 0)) { bump(match.reason || 'unfilled'); continue; }
        const fee = match.filledAmount * Number(costs.sellBps) / 10000;
        cash += match.filledAmount - fee;
        feesToday += fee;
        tradedToday += match.filledAmount;
        position.shares -= match.filledQty;
        if (position.shares <= 1e-9) holdings.delete(instrumentId);
        if (!match.capacityVerified) capacityUnverifiedTrades++;
        if (match.capacityLimited) bump('capacity_capped');
      }

      // 再买：净订单只补差额；legacy 按目标金额全量买入
      for (const member of members) {
        const price = openOf(member.instrumentId, day);
        if (price === null) { bump('missing_open'); continue; }
        const currentQty = holdings.get(member.instrumentId) ? holdings.get(member.instrumentId).shares : 0;
        const targetQty = isLegacy ? (targetPerMember > 0 ? targetPerMember / price : 0) : (desiredQty.get(member.instrumentId) || 0);
        const delta = targetQty - currentQty;
        if (delta <= 1e-12) continue;
        const unitFeeRate = Number(costs.buyBps) / 10000;
        // 现金不足按可用现金压缩，不透支
        const affordableQty = Math.max(cash, 0) / (price * (1 + unitFeeRate));
        const wantQty = Math.min(delta, affordableQty);
        if (!(wantQty > 1e-12)) { bump('cash_insufficient'); continue; }
        const match = matchOrder({
          side: 'buy',
          wantQty,
          price,
          bar: barOf(bars, member.instrumentId, day),
          prevClose: prevCloseOf(bars, member.instrumentId, day),
          limitRatio: limitByInstrument.has(member.instrumentId) ? limitByInstrument.get(member.instrumentId) : null,
          participationRate,
        });
        if (!(match.filledQty > 0)) { bump(match.reason || 'unfilled'); continue; }
        const buyQty = match.filledAmount / price;
        const fee = match.filledAmount * unitFeeRate;
        const existing = holdings.get(member.instrumentId);
        if (existing) {
          const totalQty = existing.shares + buyQty;
          existing.entryPrice = (existing.entryPrice * existing.shares + price * buyQty) / totalQty;
          existing.shares = totalQty;
          existing.lastPrice = price;
        } else {
          holdings.set(member.instrumentId, { shares: buyQty, entryPrice: price, lastPrice: price, entryDate: day });
        }
        cash -= match.filledAmount + fee;
        feesToday += fee;
        tradedToday += match.filledAmount;
        if (!match.capacityVerified) capacityUnverifiedTrades++;
        if (match.capacityLimited) bump('capacity_capped');
      }
    }

    // 3) 收盘估值（每个交易日都记，日曲线不断档）
    let marketValue = 0;
    let unpriced = 0;
    for (const [instrumentId, position] of holdings) {
      const close = closeOf(instrumentId, day);
      if (close === null) { unpriced++; } else { position.lastPrice = close; }
      marketValue += position.lastPrice * position.shares;
    }
    const nav = cash + marketValue;
    totalFees += feesToday;
    if (tradedToday > 0) turnoverSum += tradedToday / Math.max(previousNav, 1e-9);
    const benchmarkClose = benchmarkCloses.get(day) || benchmarkLast;
    if (benchmarkBase === null && benchmarkClose) benchmarkBase = benchmarkClose;
    if (benchmarkClose) benchmarkLast = benchmarkClose;
    dailySeries.push({
      tradeDate: day,
      nav: Number(nav.toFixed(8)),
      cashWeight: nav > 0 ? Number((cash / nav).toFixed(8)) : 1,
      holdingsCount: holdings.size,
      unpricedCount: unpriced,
      rebalanced: daySignals.length > 0,
      fees: Number(feesToday.toFixed(8)),
      dividendIncome: Number(dividendsToday.toFixed(8)),
      benchmarkNav: benchmarkBase && benchmarkClose ? Number((benchmarkClose / benchmarkBase).toFixed(8)) : null,
    });
    if (daySignals.length) {
      periods.push({
        tradeDate: day,
        nav: Number(nav.toFixed(8)),
        cashWeight: nav > 0 ? Number((cash / nav).toFixed(8)) : 1,
        turnover: Number((tradedToday / Math.max(previousNav, 1e-9)).toFixed(8)),
        fees: Number(feesToday.toFixed(8)),
        dividendIncome: Number(dividendsToday.toFixed(8)),
        benchmarkNav: benchmarkBase && benchmarkClose ? Number((benchmarkClose / benchmarkBase).toFixed(8)) : null,
        unpricedCount: unpriced,
      });
      diagnostics.supportedFrom = diagnostics.supportedFrom || daySignals[0].signalDate;
    }
    previousNav = nav;
  }

  // 硬门槛只要求"有日曲线且至少两期可执行"；日点稀疏只影响波动率输出，不把可还原区间误判成不可评估。
  if (!dailySeries.length || periods.length < 2) {
    diagnostics.missing = { reason: 'insufficient_daily_series', points: dailySeries.length, periods: periods.length };
    return persistBacktest({
      market, strategyId: null, startDate, endDate, status: 'not_evaluable',
      metrics: {}, diagnostics, costs, strategyVersion, strategyCode, benchmarkCode,
      executionModel, replayType,
    });
  }

  const navSeries = dailySeries.map(item => item.nav);
  const dayCount = Math.max(1, Math.round(
    (new Date(dailySeries[dailySeries.length - 1].tradeDate) - new Date(dailySeries[0].tradeDate)) / 86400000,
  ));
  // 日曲线可能很长：持久化只留摘要与前 200 点 + 极值点（完整序列可按输入重算，不冒充不可变账本）。
  const extremes = navSeries.reduce((acc, value, idx) => {
    if (value > acc.max.value) acc.max = { value, index: idx };
    if (value < acc.min.value) acc.min = { value, index: idx };
    return acc;
  }, { max: { value: -Infinity, index: -1 }, min: { value: Infinity, index: -1 } });
  const sampleIndexes = new Set([0, 1, dailySeries.length - 1, extremes.max.index, extremes.min.index]);
  dailySeries.slice(0, 200).forEach((item, idx) => sampleIndexes.add(idx));
  diagnostics.dailyNav = {
    points: dailySeries.length,
    sampleOnly: true,
    first: dailySeries[0].tradeDate,
    last: dailySeries[dailySeries.length - 1].tradeDate,
    maxDrawdownDate: dailySeries[extremes.min.index] ? dailySeries[extremes.min.index].tradeDate : null,
    capacityUnverifiedTrades,
    sample: [...sampleIndexes].filter(idx => idx >= 0 && idx < dailySeries.length)
      .sort((a, b) => a - b).map(idx => dailySeries[idx]),
  };

  const metrics = {
    effectiveStart: dailySeries[0].tradeDate,
    effectiveEnd: dailySeries[dailySeries.length - 1].tradeDate,
    totalReturn: navSeries[navSeries.length - 1] / navSeries[0] - 1,
    annualizedReturn: annualized(navSeries, dayCount),
    maxDrawdown: maxDrawdown(navSeries),
    volatility: dailySeries.length >= 60 ? volatility(navSeries, 252) : null,
    periodsPerYear: 252,
    sharpe: null,
    turnover: turnoverSum,
    fees: totalFees,
    dividendIncome: totalDividends,
    cashWeightLast: dailySeries[dailySeries.length - 1].cashWeight,
    benchmarkReturn: periods[periods.length - 1].benchmarkNav === null ? null : periods[periods.length - 1].benchmarkNav - 1,
    benchmarkReturnType: 'price',
    periodCount: periods.length,
    dailyPoints: dailySeries.length,
    currency: input.currency || 'LOCAL',
    note: dailySeries.length < 60 ? '日样本不足 60 个交易日，波动率不输出' : null,
  };

  return persistBacktest({
    market, strategyId: null, startDate, endDate, status: 'partial',
    metrics, diagnostics, costs, strategyVersion, strategyCode, benchmarkCode, periods,
    executionModel, replayType,
  });
}

/**
 * 阶梯对照（方案 27.11.3）：同一输入/成本/基准/区间，每步只改一个变量。
 * A0 用旧引擎复现现役行为；A1 换逐日执行（桥接共同修复）；B 只启用 V2 的 PB×PE 通道（R02 仍按 V1 判据）；
 * C 只把 R02 换成 V2 正极值比；D 只取消 V1 指数门槛；E 只把频率换成周频。
 * 每步的开关都写进结果，便于核对"仅改目标变量"，不用放宽阈值冒充规则切换。
 */
const V2_STRATEGY_CODE = RULES_V2.STRATEGY_CODE_V2;
const V1_STRATEGY_CODE = RULES.STRATEGY_CODE;
const LADDER_STEPS = Object.freeze([
  {
    code: 'A0', label: '现役旧行为：V1规则＋按期估值、先全卖再买', engine: 'legacy', frequency: 'quarter',
    // 基线必须真正跑 V1：不能继承调用方传入的 strategyCode（C02）。
    strategyCode: V1_STRATEGY_CODE, internalParams: null,
  },
  {
    code: 'A1', label: '桥接：V1规则＋逐日执行', engine: 'daily', frequency: 'quarter',
    strategyCode: V1_STRATEGY_CODE, internalParams: null,
  },
  {
    code: 'B', label: '仅改R01：启用 PB×PE 通道（R02 仍按 V1 判据）', engine: 'daily', frequency: 'quarter',
    strategyCode: V2_STRATEGY_CODE,
    internalParams: { r01Channel: 'pb_or_product', r02Rule: 'v1_any_above_one', marketGate: 'v1' },
  },
  {
    code: 'C', label: '再改R02：切换到十年正极值比', engine: 'daily', frequency: 'quarter',
    strategyCode: V2_STRATEGY_CODE,
    internalParams: { r01Channel: 'pb_or_product', r02Rule: 'v2_positive_ratio', marketGate: 'v1' },
  },
  {
    code: 'D', label: '再取消指数PB门槛', engine: 'daily', frequency: 'quarter',
    strategyCode: V2_STRATEGY_CODE,
    internalParams: { r01Channel: 'pb_or_product', r02Rule: 'v2_positive_ratio', marketGate: 'off' },
  },
  {
    code: 'E', label: '再改周频', engine: 'daily', frequency: 'week',
    strategyCode: V2_STRATEGY_CODE,
    internalParams: { r01Channel: 'pb_or_product', r02Rule: 'v2_positive_ratio', marketGate: 'off' },
  },
]);

async function runLadder(input) {
  const results = [];
  for (const step of LADDER_STEPS) {
    const payload = Object.assign({}, input, {
      ladder: false,
      signalFrequency: step.frequency,
      // 每步用本步固定策略：显式覆盖调用方传入值，避免"传 V2 时 A0/A1 实际跑 V2、报告写 V1"（C02）。
      strategyCode: step.strategyCode,
      internalParams: step.internalParams || null,
    });
    delete payload.ladder;
    const run = step.engine === 'legacy'
      ? await runQuarterlyLegacy(Object.assign({}, payload, { executionModel: 'legacy' }))
      : await runDailyBacktest(payload);
    results.push({
      step: step.code,
      label: step.label,
      status: run.status,
      backtestId: run.backtestId,
      metrics: run.metrics,
      // 每步实际生效的开关（只改一个变量，其余保持上一步）：归因前先能核对这一点。
      switches: {
        engine: step.engine,
        signalFrequency: step.frequency,
        r01Channel: step.internalParams ? step.internalParams.r01Channel : 'pb_threshold',
        r02Rule: step.internalParams ? step.internalParams.r02Rule : 'v1_any_above_one',
        marketGate: step.internalParams ? step.internalParams.marketGate : 'v1',
        // 报告值必须来自实际传入载荷，不能写死"V1"。
        strategyCode: payload.strategyCode,
      },
    });
  }
  return { ladder: results };
}

/**
 * 回测入口（方案 27.11.3）：默认走逐日引擎；ladder=true 时按阶梯各跑一次并汇总。
 * 只有显式 executionModel='legacy' 才走旧引擎（A0 对照与历史复现）。
 */
async function runBacktest(input) {
  if (input && input.ladder === true) return runLadder(input);
  if (input && input.executionModel === 'legacy') return runQuarterlyLegacy(input);
  return runDailyBacktest(input);
}

/**
 * 各市场开盘时刻（本地时间）：日线模型只有开盘价，可见时刻晚于它就不得再倒填当日开盘。
 * 数据源未提供盘中时段，这里按连续竞价开盘 09:30 处理；变更需要版本化并重跑对照。
 */
const MARKET_OPEN_TIME = Object.freeze({ CN: '09:30:00', HK: '09:30:00' });

/**
 * 已验证的零合格空仓（E02）：批次跑完、质量通过、明确零入选且没有待补对象。
 * 只有这些证据同时成立，"冻结成员为空"才是**有效现金组合**；
 * 其余空成员（selected_count>0 却取不到成员、质量不完整、状态未知）仍然算证据缺失。
 */
const ZERO_SELECTION_BUSINESS_STATUS = new Set(['no_eligible_member', 'insufficient_candidates']);
function isVerifiedZeroSelection(event) {
  const selected = event && event.selected_count !== null && event.selected_count !== undefined
    ? Number(event.selected_count) : null;
  const pending = event && event.pending_count !== null && event.pending_count !== undefined
    ? Number(event.pending_count) : null;
  if (selected !== 0 || pending !== 0) return false;
  if (String((event && event.execution_status) || '') !== 'succeeded') return false;
  if (String((event && event.quality_status) || '') !== 'passed') return false;
  return ZERO_SELECTION_BUSINESS_STATUS.has(String((event && event.business_status) || ''));
}

/**
 * 真实回放计划（方案 27.7 生效历史 / 27.11.2，C01 + C04；27.22 D01 + D02；27.23 E01 + E02）：
 * - 逐事件重建：publish 先建仓、correct/rollback 在事件生效后把持仓换成**事件目标版本**、
 *   deactivate 变空仓；不能"取最新修订"重写整个周期的历史；
 * - 事件方向统一按 from→to：目标持仓一律取 `to_run_id`，`from_run_id` 只留审计。
 *   rollback 的 from 是"被回滚的版本"、to 才是"回到的版本"，反向取 from 会停在错误版本（D01）；
 * - 成交时点：把可见时间截到秒，与市场开盘时刻比较；可见晚于开盘（盘中/收盘后）时当日开盘已过，
 *   顺延到之后的首个交易日；假期由交易日历自然跳过；
 * - 区间尾部：信号日之后本区间已无交易日（或事件可见时刻落在末尾之后无可交易日）时，
 *   该笔交易只可能发生在区间外，记 `pending`（待执行/区间外），不进 `missing`——
 *   尾部未执行不是"既有历史输入缺失"，不能因此把前面完整区间一并判为不可评估（D02）。
 *   早期周期缺事件仍然进 `missing`：不借尾部豁免放行未知数据；
 * - 同一成交窗口：事件仍全部留档，但只有"开盘时最终生效"的那一个算目标（`effectiveTarget`），
 *   更早的同窗版本不曾可成交，不虚拟建仓、不产生费用与换手（E01）；
 * - 零合格：已验证的零入选批次解冻为**有效现金目标**，不判成员缺失（E02）。
 */
function resolveRealReplayPlan({ selections, eventsByPeriod, calendar, membersByRun, market = 'CN', marketOpenTime }) {
  const openTime = marketOpenTime || MARKET_OPEN_TIME[String(market).toUpperCase()] || '09:30:00';
  const missing = [];
  const pending = [];
  const resolved = [];
  for (const item of selections) {
    const events = eventsByPeriod.get(item.periodKey) || [];
    const sessionAfterSignal = calendar.find(day => day > item.signalDate) || null;
    if (!sessionAfterSignal) {
      // 结构上无法在本区间执行：无论已发布还是尚未发布，都只记待执行，不影响已实现历史。
      pending.push({
        periodKey: item.periodKey,
        signalDate: item.signalDate,
        reason: events.length ? 'execution_after_window' : 'publication_after_window',
        eventCount: events.length,
        eventIds: events.map(event => Number(event.event_id)),
      });
      continue;
    }
    if (!events.length) {
      missing.push({ periodKey: item.periodKey, reason: 'publication_event_missing' });
      continue;
    }
    for (const event of events) {
      const action = String(event.action || '');
      // from→to 是事件方向，目标版本一律是 to_run_id；deactivate 是明确空仓。
      const targetRunId = action === 'deactivate' ? null : (event.to_run_id ? Number(event.to_run_id) : null);
      const members = targetRunId ? (membersByRun.get(targetRunId) || []) : [];
      // 空成员分两种：已验证零合格（有效现金）与成员丢失（证据缺失）。只有前者可以放行。
      const zeroSelection = action !== 'deactivate' && targetRunId !== null
        && !members.length && isVerifiedZeroSelection(event);
      if (action !== 'deactivate' && targetRunId && !members.length && !zeroSelection) {
        missing.push({ periodKey: item.periodKey, eventId: Number(event.event_id), reason: 'published_run_members_missing', runId: targetRunId });
        continue;
      }
      const stamp = event.visible_at ? CoreDate.dateTimeInZone(event.visible_at, 'Asia/Shanghai') : null;
      if (!stamp) {
        missing.push({ periodKey: item.periodKey, eventId: Number(event.event_id), reason: 'visible_at_missing', runId: targetRunId });
        continue;
      }
      const visibleDate = stamp.slice(0, 10);
      const visibleTime = stamp.slice(11, 19);
      const sameDayTradable = visibleTime <= openTime;
      const executionDate = calendar.find(day => day > item.signalDate
        && (day > visibleDate || (day === visibleDate && sameDayTradable))) || null;
      if (!executionDate) {
        // 信号后确有交易日，但事件可见太晚（区间末尾收盘后）：成交落在区间外，同样只记待执行。
        pending.push({
          periodKey: item.periodKey, eventId: Number(event.event_id), action,
          reason: 'execution_after_window', visibleDate, visibleTime, runId: targetRunId,
        });
        continue;
      }
      resolved.push(Object.assign({}, item, {
        executionDate,
        eventId: Number(event.event_id),
        replayAction: action,
        replayEvidence: {
          eventId: Number(event.event_id),
          action,
          pointerRevision: event.pointer_revision === null || event.pointer_revision === undefined ? null : Number(event.pointer_revision),
          visibleAt: event.visible_at,
          visibleDate,
          visibleTime,
          marketOpenTime: openTime,
          executionDate,
          runId: targetRunId,
          // from 只作审计：它记录"从哪一版离开"，不是恢复目标（D01）。
          fromRunId: event.from_run_id === null || event.from_run_id === undefined ? null : Number(event.from_run_id),
          occurredAt: event.occurred_at || null,
          // 批次证据随事件留档：零合格与成员丢失靠它区分（E02）。
          runStatus: {
            executionStatus: event.execution_status || null,
            qualityStatus: event.quality_status || null,
            businessStatus: event.business_status || null,
            selectedCount: event.selected_count === undefined ? null : event.selected_count,
            pendingCount: event.pending_count === undefined ? null : event.pending_count,
          },
          zeroSelection,
        },
        // 冻结该事件生效时的组合；deactivate 与已验证零合格都是明确空仓，不是"缺数据"。
        computed: {
          gate: { eligible: true, status: 'eligible' },
          quality: { publishable: true, pendingCount: 0, reasons: [], zeroSelection },
          portfolio: {
            members: members.map(row => ({
              instrumentId: Number(row.instrument_id),
              code: row.code,
              slotNo: row.slot_no === undefined ? null : Number(row.slot_no),
            })),
          },
          params: { slotsPerMarket: 30 },
          positionRatio: 1,
          universeEvidence: null,
        },
      }));
    }
  }
  // E01：同一成交窗口只认"开盘时最终生效的目标"。周五发布 A、周六修订 B 都落在周一开盘，
  // 只用 B 生成净订单；A 从未可成交，虚拟买入再卖出会把费用与换手放大成三倍。
  // 更早交易日已经执行的版本不受影响（它们各有自己的窗口），A 仍留在事件序列里供审计。
  // 最终目标按"真实生效顺序"选，不依赖数组顺序：跨期修订可能与下一期首次发布
  // 落在同一开盘，而 selections 按期次、事件按各自周期分组，拼接顺序未必等于时间顺序。
  // 时间取 occurred_at，缺失时退到 visible_at，同一时刻再按自增 event_id 决胜。
  const eventOrderKey = item => {
    const evidence = item.replayEvidence || {};
    const stamp = evidence.occurredAt || evidence.visibleAt;
    const time = stamp ? new Date(stamp).getTime() : NaN;
    return [Number.isFinite(time) ? time : -1, Number(item.eventId) || 0];
  };
  const isLaterEvent = (a, b) => {
    const ka = eventOrderKey(a), kb = eventOrderKey(b);
    return ka[0] > kb[0] || (ka[0] === kb[0] && ka[1] > kb[1]);
  };
  const finalTargetByExecutionDate = new Map();
  resolved.forEach(item => {
    const current = finalTargetByExecutionDate.get(item.executionDate);
    if (!current || isLaterEvent(item, current)) finalTargetByExecutionDate.set(item.executionDate, item);
  });
  resolved.forEach(item => {
    const finalTarget = finalTargetByExecutionDate.get(item.executionDate);
    if (finalTarget === item) {
      item.effectiveTarget = true;
      return;
    }
    item.effectiveTarget = false;
    item.supersededByEventId = finalTarget.eventId;
    item.supersededByRunId = finalTarget.replayEvidence.runId;
  });
  return { missing, pending, resolved };
}

async function persistBacktest(input) {
  const executionModelVersion = input.executionModel || EXECUTION_MODEL_VERSION;
  const inputHash = require('crypto').createHash('sha256')
    .update(JSON.stringify({
      market: input.market, start: input.startDate, end: input.endDate, costs: input.costs,
      strategyVersion: input.strategyVersion, strategyCode: input.strategyCode || null,
      benchmarkCode: input.benchmarkCode, executionModelVersion,
      // 不同回放类型/信号频率/参与率不是同一次实验：哈希必须覆盖，避免命中别的模型结果。
      replayType: input.replayType || 'pit_research_replay',
      signalFrequency: (input.diagnostics && input.diagnostics.signalFrequency) || 'quarter',
      participationRate: (input.diagnostics && input.diagnostics.participationRate) || null,
    }))
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
      executionModelVersion: executionModelVersion,
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
  // 回测登记的策略必须与实际使用的规则一致：V2 回测不能挂在 V1 策略版本下。
  const V2 = require('../domain/stockSelectionRulesV2');
  const isV2 = String(input.strategyCode || '').toLowerCase() === V2.STRATEGY_CODE_V2;
  const strategyCode = isV2 ? V2.STRATEGY_CODE_V2 : RULES.STRATEGY_CODE;
  const params = isV2 ? V2.V2_PARAMS : RULES.DEFAULT_PARAMS;
  const version = input.strategyVersion || (isV2 ? 'v2' : service.STRATEGY_VERSION);
  return repo.upsertStrategy(tx, {
    strategyCode,
    market: input.market,
    version,
    formulaVersion: params.formulaVersion,
    adapterVersion: params.adapterVersion,
    riskVersion: params.riskVersion,
    industryVersion: params.industryVersion,
    effectiveFrom: input.startDate,
    parameters: params,
    contentHash: require('crypto').createHash('sha256')
      .update(JSON.stringify({ strategy: strategyCode, params, version }))
      .digest('hex'),
  });
}

module.exports = {
  runBacktest,
  runDailyBacktest,
  runQuarterlyLegacy,
  runLadder,
  resolveRealReplayPlan,
  LADDER_STEPS,
  buildSignalSchedule,
  priceLimitRatio,
  matchOrder,
  barsIndexOf,
  prevCloseOf,
  EXECUTION_MODEL_VERSION,
  LEGACY_EXECUTION_MODEL,
  VALUATION_MODEL_VERSION,
  CAPACITY_VERSION,
  COST_VERSION,
  DEFAULT_COSTS,
  DEFAULT_PARTICIPATION_RATE,
  BENCHMARK_BY_MARKET,
  shiftQuarter,
  maxDrawdown,
  annualized,
  volatility,
  periodsPerYearOf,
};

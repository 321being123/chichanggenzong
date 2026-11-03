// 投资策略选股中心：组合与资金约束（方案第 6 节）。
// 纯计算：不读库、不联网；席位、行业上限、权重、留现金与 A/H 重复暴露都在这里算。
'use strict';

const RULES = require('./stockSelectionRules');

const EPSILON = 1e-12;

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clampRatio(value, fallback) {
  const n = num(value);
  if (n === null) return fallback;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * 生成目标组合（方案 6.1、6.2）。
 * - 每市场固定 slots 个等权目标席位，每只目标金额 = 市场预算 × 仓位 / slots；
 * - 实际入选 n < slots 时股票总额只占 仓位 × n/slots，剩余留现金，不放大单只权重；
 * - 行业上限按"市场独立预算"的 20% 计：行业只数 × 仓位 / slots ≤ 20%（不写死最多 6 只）。
 */
function buildPortfolio(input) {
  const ranked = Array.isArray(input.ranked) ? input.ranked : [];
  const params = Object.assign({}, RULES.DEFAULT_PARAMS, input.params || {});
  const slots = Number(input.slots || params.slotsPerMarket);
  const industryLimitRatio = clampRatio(input.industryLimitRatio === undefined ? params.industryLimitRatio : input.industryLimitRatio, params.industryLimitRatio);
  const positionRatio = clampRatio(input.positionRatio, 1);
  const anomalyById = input.anomalyById || {};
  const order = ranked.slice().sort((a, b) => (a.selectionOrder || 0) - (b.selectionOrder || 0));

  const members = [];
  const watchlist = [];
  const skipped = [];
  const industryCount = new Map();
  const weightPerSlotInBudget = positionRatio / slots;   // 占市场预算的比例
  const weightPerSlotInEquity = 1 / slots;               // 占股票目标金额的比例

  for (const item of order) {
    const anomaly = anomalyById[item.instrumentId] || null;
    if (anomaly && anomaly.status === RULES.STATUS.FAIL) {
      skipped.push({ code: item.code, instrumentId: item.instrumentId, reason: 'annual_anomaly', detail: anomaly.reason });
      continue;
    }
    if (anomaly && anomaly.status === RULES.STATUS.PENDING) {
      skipped.push({ code: item.code, instrumentId: item.instrumentId, reason: 'annual_anomaly_pending', detail: anomaly.reason });
      continue;
    }
    if (item.filterStatus === RULES.STATUS.RISK || item.riskHeld === true) {
      // 风险暂缓（停牌/ST/退市风险）不得进入席位：原因与"数据待补""策略不符合"分开记。
      skipped.push({ code: item.code, instrumentId: item.instrumentId, reason: 'risk_held', detail: item.riskReasons || null });
      continue;
    }
    if (item.filterStatus !== RULES.STATUS.PASS || item.rankReady === false) {
      skipped.push({ code: item.code, instrumentId: item.instrumentId, reason: 'rule_or_data_pending' });
      continue;
    }
    const industryKey = item.industry && item.industry.code ? item.industry.code : null;
    if (!industryKey) {
      // 缺分类待核验：不能把大量未知对象塞进"其他"绕过上限，也不能直接当合格入选。
      skipped.push({ code: item.code, instrumentId: item.instrumentId, reason: 'industry_unverified' });
      continue;
    }
    const used = industryCount.get(industryKey) || 0;
    // 用精确数值比较，避免页面舍入把 20% 边界算错。
    if ((used + 1) * weightPerSlotInBudget > industryLimitRatio + EPSILON) {
      skipped.push({
        code: item.code, instrumentId: item.instrumentId, reason: 'industry_limit',
        detail: { industryCode: industryKey, industryName: item.industry.name || null, used, limitRatio: industryLimitRatio },
      });
      continue;
    }
    if (positionRatio <= 0) {
      watchlist.push({ code: item.code, instrumentId: item.instrumentId, name: item.name || null, selectionOrder: item.selectionOrder, industry: item.industry || null });
      continue;
    }
    if (members.length >= slots) {
      skipped.push({ code: item.code, instrumentId: item.instrumentId, reason: 'slots_full' });
      continue;
    }
    industryCount.set(industryKey, used + 1);
    members.push({
      instrumentId: item.instrumentId,
      code: item.code,
      name: item.name || null,
      companyId: item.companyId || null,
      slotNo: members.length + 1,
      selectionOrder: item.selectionOrder,
      industry: item.industry,
      weightInMarketBudget: weightPerSlotInBudget,
      weightInEquityTarget: weightPerSlotInEquity,
      issuerDuplicate: false,
    });
  }

  // 同业同发行人（A/H 双重上市）提示：保留各自名次与权重，只标记重复暴露。
  const byCompany = new Map();
  members.forEach(member => {
    if (!member.companyId) return;
    const list = byCompany.get(member.companyId) || [];
    list.push(member);
    byCompany.set(member.companyId, list);
  });
  for (const list of byCompany.values()) {
    if (list.length > 1) list.forEach(member => { member.issuerDuplicate = true; });
  }

  const industryBreakdown = Array.from(industryCount, ([code, count]) => ({
    industryCode: code,
    industryName: (members.find(m => m.industry && m.industry.code === code) || {}).industry?.name || null,
    count,
    weightInMarketBudget: count * weightPerSlotInBudget,
    limitRatio: industryLimitRatio,
  })).sort((a, b) => b.count - a.count || String(a.industryCode).localeCompare(String(b.industryCode)));

  // 股票总额占市场预算的真实比例；未填席位与未用仓位都留现金。
  const equityWeightInBudget = members.length * weightPerSlotInBudget;
  return {
    slots,
    positionRatio,
    industryLimitRatio,
    members,
    watchlist,
    skipped,
    industryBreakdown,
    selectedCount: members.length,
    equityWeightInMarketBudget: equityWeightInBudget,
    cashWeightInMarketBudget: 1 - equityWeightInBudget,
    unfilledSlots: slots - members.length,
    // 方案 6.1：不合格股少是有效结果；未核验股可能改名次是数据不完整，两者分开上报。
    watchlistCount: watchlist.length,
  };
}

/** 行业上限对应的最多只数（页面展示用，计算仍走精确比较）。 */
function industrySlotCap(positionRatio, industryLimitRatio, slots) {
  const p = clampRatio(positionRatio, 1);
  const limit = clampRatio(industryLimitRatio, 0.2);
  if (p <= 0) return 0;
  return Math.floor(limit * slots / p + EPSILON);
}

/** A/H 重复暴露：按公司合并两只股票的权重，没有完整预算时只提示不显示金额。 */
function combineIssuerExposure(markets) {
  const groups = new Map();
  (markets || []).forEach(entry => {
    const market = entry.market;
    const budgetRatio = num(entry.budgetRatio);
    const positionRatio = num(entry.positionRatio);
    (entry.members || []).forEach(member => {
      if (!member.companyId) return;
      const key = String(member.companyId);
      const group = groups.get(key) || { companyId: member.companyId, holdings: [], weightOfTotal: null };
      const weightOfTotal = (budgetRatio !== null && positionRatio !== null)
        ? budgetRatio * member.weightInMarketBudget
        : null;
      group.holdings.push({
        market,
        code: member.code,
        name: member.name || null,
        slotNo: member.slotNo,
        weightInMarketBudget: member.weightInMarketBudget,
        weightOfTotal,
      });
      if (weightOfTotal !== null) group.weightOfTotal = (group.weightOfTotal || 0) + weightOfTotal;
      groups.set(key, group);
    });
  });
  const duplicates = Array.from(groups.values()).filter(group => group.holdings.length > 1);
  return {
    duplicates,
    // 无法核实发行人关联时不强行合并，标记待核验。
    pendingIssuerLinks: (markets || []).some(entry => (entry.members || []).some(member => !member.companyId)),
  };
}

/** 两市场合计敞口：只有明确总资金与两市场预算时才输出金额口径。 */
function combinedExposure(entries) {
  const list = (entries || []).filter(entry => entry && num(entry.budgetRatio) !== null && num(entry.positionRatio) !== null);
  if (!list.length) return null;
  return list.reduce((sum, entry) => sum + Number(entry.budgetRatio) * Number(entry.positionRatio) * Number(entry.selectedCount || 0) / Number(entry.slots || 30), 0);
}

module.exports = { buildPortfolio, industrySlotCap, combineIssuerExposure, combinedExposure, clampRatio };

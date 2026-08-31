const assert = require('assert');
const {
  dateText, normalizeBondCode, normalizeHolderName, holderType, saveHolderRow, diffHolderSnapshots, buildRevisionCycles, buildMotiveScore, scorePressure, scoreMarket, calculateExecutability, buildFinancial,
} = require('../services/convertibleBondRevisionMotiveService');

assert.strictEqual(normalizeBondCode('113001.SH'), '113001.SH');
assert.strictEqual(dateText(new Date('2026-08-27T16:00:00.000Z')), '2026-08-28', 'PostgreSQL DATE 应按上海日历日读取');
assert.strictEqual(normalizeBondCode('113001'), null, '详情接口不接受无交易所后缀代码');
assert.strictEqual(normalizeHolderName('某某股份有限公司'), '某某');
assert.strictEqual(holderType('某某基金管理有限公司'), 'fund');
assert.strictEqual(saveHolderRow({ end_date: '2026-06-30', holder_rank: 1, holder_name: '某某基金', hold_amount: 12, hold_ratio: 3 }, 1, 1).amount, 120000, 'Tushare万张应统一换算为张');

const holderChanges = diffHolderSnapshots(
  [{ report_date: '2026-06-30', holder_name: '新增持有人', holder_name_normalized: '新增持有人', hold_amount: 20, hold_ratio: 2 },
    { report_date: '2026-06-30', holder_name: '存量持有人', holder_name_normalized: '存量持有人', hold_amount: 12, hold_ratio: 1.2 }],
  [{ report_date: '2026-03-31', holder_name: '清仓持有人', holder_name_normalized: '清仓持有人', hold_amount: 8, hold_ratio: 1 },
    { report_date: '2026-03-31', holder_name: '存量持有人', holder_name_normalized: '存量持有人', hold_amount: 10, hold_ratio: 1 }],
  '2026-06-30'
);
assert.deepStrictEqual(holderChanges.map(row => row.changeType).sort(), ['cleared', 'increase', 'new']);
assert.strictEqual(holderChanges.find(row => row.changeType === 'cleared').isCleared, true);

const financial = buildFinancial([
  { period_end: '2025-12-31', announced_at: '2026-03-30', raw_payload: { total_assets: 100, total_liab: 50 } },
  { period_end: '2025-12-31', announced_at: '2026-03-30', raw_payload: { total_revenue: 80, fin_exp_int_exp: 3 } },
  { period_end: '2026-03-31', announced_at: '2026-05-01', raw_payload: { total_assets: 110 } },
], null);
assert.strictEqual(financial.report_period, '2026-03-31', '财务指标应按同一最新报告期取值');
assert.strictEqual(financial.total_assets, 110);
const cachedFinancial = buildFinancial([], { report_end_date: '20260630', announced_at: '20260818', data: { total_assets: 200, total_liab: 80 } });
assert.strictEqual(cachedFinancial.report_period, '2026-06-30', '无标准关联财报时应使用已按公告日筛选的财务缓存报告期');
assert.strictEqual(cachedFinancial.total_assets, 200);

const cycles = buildRevisionCycles([
  { event_type: 'proposal', announced_at: '2023-01-01', title: '提议下修' },
  { event_type: 'implemented', announced_at: '2023-02-01', effective_date: '2023-02-02', title: '实施下修' },
  { event_type: 'proposal', announced_at: '2024-01-01', title: '提议下修' },
]);
assert.strictEqual(cycles.length, 2);
assert.strictEqual(cycles[0].outcome, 'implemented');
assert.strictEqual(cycles[1].proposal_date, '2024-01-01');
const triggerCycle = buildRevisionCycles([], [], [
  { trade_date: '2026-01-05', status: 'tracking', matched_days: 1, required_days: 15 },
  { trade_date: '2026-08-28', status: 'met', matched_days: 15, required_days: 15 },
]);
assert.strictEqual(triggerCycle.length, 1, '连续触发观察不应按240天机械拆成多个周期');
assert.strictEqual(triggerCycle[0].first_match_date, '2026-01-05');
assert.strictEqual(triggerCycle[0].trigger_date, '2026-08-28');

const high = buildMotiveScore({
  qualityStatus: 'complete', modelCalibrated: true, tradeDate: '2026-08-28', bondClose: 98, stockClose: 5, stockVwap: 5, stockPb: 1,
  marketCap: 1000000000, profile: { issueSize: 1000000000, remainSize: 950000000, maturityDate: '2027-06-01', currentConvPrice: 10, parValue: 100 },
  revisionStatus: 'met', matchedDays: 15, remainingDays: 0, netAssetFloorApplicable: true, locked: false,
  financial: { cash: 100000000, trading_assets: 100000000, total_liabilities: 1000000000, total_assets: 1200000000, revenue: 100000000, interest_expense: 20000000, ebitda: 20000000 },
  cycles: [{ outcome: 'implemented' }, { outcome: 'implemented' }, { proposal_date: '2026-08-01' }],
  holders: [{ related: true, hold_ratio: 30, reportKind: 'latest' }, { hold_ratio: 40, reportKind: 'initial' }],
  pledgeRatio: 45, controller: { type: '民营', ratio: 30, name: '自然人' }, bondPriceHistory: [98, 105, 110], proposalHistory: [0, 1, 1], proposalCount: 2,
});
assert.ok(high.motiveScore >= 45 && high.motiveScore <= 100);
assert.strictEqual(high.executability.status, 'pass');
assert.strictEqual(high.motiveLevel, 'research_high');

const vwapOnly = calculateExecutability({ profile: { currentConvPrice: 10 }, stockClose: 5, stockVwap: 5, netAssetFloorApplicable: false, locked: false });
assert.strictEqual(vwapOnly.status, 'pass', '没有净资产条款时也应使用近期均价估算底价');

const incomplete = buildMotiveScore({ qualityStatus: 'incomplete', profile: {}, cycles: [] });
assert.strictEqual(incomplete.motiveLevel, 'unavailable');
assert.ok(incomplete.blockers.includes('关键输入不完整'));

const partial = buildMotiveScore({ qualityStatus: 'partial', bondClose: 105, profile: {}, cycles: [] });
assert.strictEqual(partial.motiveLevel, 'unavailable', '部分数据不能拿残缺分数与完整阈值比较');
assert.ok(partial.blockers.includes('核心输入未完整，暂不输出预测等级'), '部分数据必须明确提示暂不输出预测等级');
const uncalibrated = buildMotiveScore({ qualityStatus: 'complete', bondClose: 98, profile: { issueSize: 100, remainSize: 90 }, cycles: [] });
assert.strictEqual(uncalibrated.motiveLevel, 'unavailable', '样本外回测未通过前不得输出预测等级');
assert.ok(uncalibrated.blockers.includes('历史样本外回测未通过，暂不输出预测等级'), '未校准模型必须明确阻断原因');

const invalidScale = scorePressure({
  tradeDate: '2026-08-28',
  profile: { issueSize: 1000000000, remainSize: 950000000, maturityDate: '2030-01-01' },
  financial: {},
});
assert.ok(!invalidScale.items.includes('剩余规模已低于发行规模'), '剩余规模低于发行规模不得作为动机加分');

const marketContext = scoreMarket({
  bondClose: 105,
  bondPriceHistory: [100, 105, 110],
  proposalHistory: [0, 1, 2],
  proposalMonthlyCount: 2,
  industryProposalPressure: true,
});
assert.strictEqual(marketContext.score, 2, '其他转债下修和同行下修不得计入本债动机分');
assert.ok(marketContext.contextItems.length === 2 && marketContext.contextItems.every(item => item.includes('不计入本债动机分')), '市场热度只能作为背景参考');

console.log('convertible bond motive tests passed');

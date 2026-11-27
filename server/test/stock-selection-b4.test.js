'use strict';
// B4-1 纯函数/哈希合同回归（不连接数据库）。
//
// 覆盖：
// 1) computation_input_hash 只含纯计算语义与冻结事实，排除 run_kind/周期/渠道封装；
// 2) PB、年度利润、分红、行业版本任一变化都会改变 computation_input_hash（拒绝复用的前提）；
// 3) computation_output_hash 随排名/成员/质量变化；
// 4) loadUniverse 去 LATERAL 后 PB 空值内存回退的等价口径（同币种闭合、负净资产、异币种留空）。
const assert = require('assert');

const service = require('../services/stockSelectionService');

let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks += 1; };
const eq = (actual, expected, message) => { assert.strictEqual(actual, expected, message); checks += 1; };
const ne = (actual, expected, message) => { assert.notStrictEqual(actual, expected, message); checks += 1; };

function baseEvaluated(overrides = {}) {
  return Object.assign({
    instrumentId: 101,
    code: 'B4TEST01.SH',
    currentPb: 1.1,
    currentPe: 8.5,
    dividendYield: 0.03,
    historicalPbMax: 2.2,
    equityCny: 5e10,
    equityCurrency: 'CNY',
    filterStatus: 'PASS',
    profitStatus: 'profit',
    rankReady: true,
    industry: { system: 'SW2021', code: '801010', version: '2021', name: '农林牧渔' },
    rules: {
      R01: { status: 'PASS' },
      R02: { status: 'PASS' },
      R04: { status: 'PASS' },
      R05: { status: 'PASS' },
    },
    detail: {
      price: 10,
      equity: { reportId: 501, periodEnd: '2025-12-31', announcedAt: '2026-03-31', sourceVersion: 'eq-v1' },
      dividend: { ttmPerShare: 0.5, count: 11, currency: 'CNY' },
      annual: {
        latestYear: 2025,
        currency: 'CNY',
        years: [
          { year: 2025, profit: 1e9, dividend: 5e7, dividendKnown: true, complete: true, sourceVersion: 'p2025', profitCurrency: 'CNY', dividendCurrencies: ['CNY'] },
          { year: 2015, profit: 8e8, dividend: 4e7, dividendKnown: true, complete: true, sourceVersion: 'p2015', profitCurrency: 'CNY', dividendCurrencies: ['CNY'] },
        ],
      },
      pbWindow: { expectedDays: 2400, gapDays: 10, coveredDays: 2390 },
    },
  }, overrides);
}

function makeComputed(overrides = {}) {
  const evaluated = overrides.evaluated || [baseEvaluated()];
  const ranked = overrides.ranked || [{
    instrumentId: evaluated[0].instrumentId, totalScore: 90, pbRank: 1, peRank: 1, dividendRank: 1, selectionOrder: 1,
  }];
  const members = overrides.members || [{
    instrumentId: evaluated[0].instrumentId, slotNo: 1,
    weightInMarketBudget: 1 / 30, weightInEquityTarget: 1 / 30, weightInInvestedEquity: 1,
  }];
  return Object.assign({
    market: 'CN',
    asOfDate: '2026-11-20',
    strategyCode: 'investment_essentials_adapted',
    params: { formulaVersion: 'f1', adapterVersion: 'a1', riskVersion: 'r1', industryVersion: 'i1', maxPb: 1.5 },
    positionRatio: 1,
    valuation: { benchmarkCode: '000985', valuationMethod: 'market_cap_weighted', pb: 1.5, pe: 15 },
    universeEvidence: { contentHash: 'roster-hash-1', memberCount: 1, replayType: 'pit_research_replay' },
    evaluated,
    ranked,
    portfolio: { members },
    quality: { publishable: true, reasons: [], universeCount: 1, poolSize: 1, pendingCount: 0, passed: 1, failures: 0, notEvaluableCount: 0, riskHeldCount: 0 },
    anomalyById: { 101: { status: 'PASS', latestYear: 2025, profitY: 1e9, profitSum: 1.8e9 } },
  }, overrides);
}

function inputHash(computed) {
  return service.computationInputHashOf(computed, 'v1');
}

(async () => {
  // ---------- 1) computation_input_hash 排除 run_kind/周期/渠道封装 ----------
  const daily = makeComputed();
  const weeklyWrapped = makeComputed(Object.assign({}, daily, {
    // 这些是渠道/用途封装，绝不能进入纯计算哈希
    runKind: 'weekly',
    periodType: 'week',
    periodKey: 'W:2026-11-16',
    isShadow: false,
    owner: 'someone',
    sourceRunId: 9,
    settingsHash: 'settings-hash',
  }));
  eq(inputHash(daily), inputHash(weeklyWrapped),
    '同一冻结事实下 daily 与 weekly 的 computation_input_hash 必须相同（排除渠道/周期封装）');
  eq(service.computationOutputHashOf(daily), service.computationOutputHashOf(weeklyWrapped),
    '同一冻结事实下 daily 与 weekly 的 computation_output_hash 必须相同');

  // ---------- 2) 任一冻结事实变化必须改变 computation_input_hash ----------
  const baseHash = inputHash(daily);

  const pbChanged = makeComputed({ evaluated: [baseEvaluated({ currentPb: 1.25 })] });
  ne(inputHash(pbChanged), baseHash, 'PB 变化必须改变 computation_input_hash');

  const profitChangedYears = [
    { year: 2025, profit: 1e9, dividend: 5e7, dividendKnown: true, complete: true, sourceVersion: 'p2025', profitCurrency: 'CNY', dividendCurrencies: ['CNY'] },
    { year: 2015, profit: 2e9, dividend: 4e7, dividendKnown: true, complete: true, sourceVersion: 'p2015', profitCurrency: 'CNY', dividendCurrencies: ['CNY'] },
  ];
  const profitChanged = makeComputed({ evaluated: [baseEvaluated({ detail: Object.assign({}, baseEvaluated().detail, { annual: Object.assign({}, baseEvaluated().detail.annual, { years: profitChangedYears }) }) })] });
  ne(inputHash(profitChanged), baseHash, '年度利润变化必须改变 computation_input_hash');

  const dividendChangedYears = [
    { year: 2025, profit: 1e9, dividend: 6e7, dividendKnown: true, complete: true, sourceVersion: 'p2025', profitCurrency: 'CNY', dividendCurrencies: ['CNY'] },
    { year: 2015, profit: 8e8, dividend: 4e7, dividendKnown: true, complete: true, sourceVersion: 'p2015', profitCurrency: 'CNY', dividendCurrencies: ['CNY'] },
  ];
  const dividendChanged = makeComputed({ evaluated: [baseEvaluated({ detail: Object.assign({}, baseEvaluated().detail, { annual: Object.assign({}, baseEvaluated().detail.annual, { years: dividendChangedYears }) }) })] });
  ne(inputHash(dividendChanged), baseHash, '分红变化必须改变 computation_input_hash');

  const industryChanged = makeComputed({ evaluated: [baseEvaluated({ industry: { system: 'SW2021', code: '801010', version: '2024', name: '农林牧渔' } })] });
  ne(inputHash(industryChanged), baseHash, '行业版本变化必须改变 computation_input_hash');

  const fxChanged = makeComputed({ evaluated: [baseEvaluated({ equityCny: 4.9e10 })] });
  ne(inputHash(fxChanged), baseHash, 'FX 换算后的权益变化必须改变 computation_input_hash');

  // ---------- 3) computation_output_hash 随排名/成员/质量变化 ----------
  const outputBase = service.computationOutputHashOf(daily);
  const reordered = makeComputed({
    ranked: [{ instrumentId: 101, totalScore: 90, pbRank: 2, peRank: 1, dividendRank: 1, selectionOrder: 2 }],
  });
  ne(service.computationOutputHashOf(reordered), outputBase, '排名变化必须改变 computation_output_hash');
  const memberChanged = makeComputed({
    members: [{ instrumentId: 101, slotNo: 2, weightInMarketBudget: 0.02, weightInEquityTarget: 0.02, weightInInvestedEquity: 1 }],
  });
  ne(service.computationOutputHashOf(memberChanged), outputBase, '成员席位/权重变化必须改变 computation_output_hash');

  // ---------- 4) PB 空值内存回退等价口径 ----------
  eq(service.decimalRatio('1000000000', '-200000000'), '-5', '十进制除法：10 亿 ÷ -2 亿 = -5');
  eq(service.decimalRatio('1000000000', '50000000000'), '0.02', '十进制除法：10 亿 ÷ 500 亿 = 0.02');
  eq(service.decimalRatio('1', '0'), null, '除数为 0 必须留空，不猜');
  eq(service.decimalRatio('abc', '1'), null, '非十进制文本必须留空');

  const sameCurrency = [{ company_id: 1, pb: null, total_market_cap: '1000000000', valuation_currency: 'CNY' }];
  service.applyEquityPbFallback(sameCurrency, new Map([['1', { amount: -2e8, currency: 'CNY' }]]));
  eq(Number(sameCurrency[0].pb), -5, '同币种非零净资产：PB 空值回退得到负 PB');
  eq(sameCurrency[0].equity_currency, 'CNY', '回退同时补齐 equity_currency 证据');

  const foreignCurrency = [{ company_id: 2, pb: null, total_market_cap: '1000000000', valuation_currency: 'CNY' }];
  service.applyEquityPbFallback(foreignCurrency, new Map([['2', { amount: 5e8, currency: 'HKD' }]]));
  eq(foreignCurrency[0].pb, null, '异币种不闭合必须留空，不能生成错误量纲的 PB');
  eq(foreignCurrency[0].equity_currency, 'HKD', '异币种时仍保留净资产币种证据');

  const zeroEquity = [{ company_id: 3, pb: null, total_market_cap: '1000000000', valuation_currency: 'CNY' }];
  service.applyEquityPbFallback(zeroEquity, new Map([['3', { amount: 0, currency: 'CNY' }]]));
  eq(zeroEquity[0].pb, null, '净资产为 0 不得相除');

  const sourcePb = [{ company_id: 4, pb: '1.20', total_market_cap: '1000000000', valuation_currency: 'CNY' }];
  service.applyEquityPbFallback(sourcePb, new Map([['4', { amount: 1e9, currency: 'CNY' }]]));
  eq(sourcePb[0].pb, '1.20', '源站已有 PB 一律不动，内存回退只补空值');

  const noEquity = [{ company_id: 5, pb: null, total_market_cap: '1000000000', valuation_currency: 'CNY' }];
  service.applyEquityPbFallback(noEquity, new Map());
  eq(noEquity[0].pb, null, '没有净资产事实时保持缺失');

  // 非 balance 报表的净资产事实：回退只认 loadEquityFacts 结果，不按 report_kind 过滤。
  const nonBalance = [{ company_id: 6, pb: null, total_market_cap: '600', valuation_currency: 'CNY' }];
  service.applyEquityPbFallback(nonBalance, new Map([['6', { amount: 300, currency: 'CNY', reportId: 999 }]]));
  eq(Number(nonBalance[0].pb), 2, '非 balance 报表携带的归母净资产同样参与回退（完整语义）');

  console.log(`OK stock-selection-b4: ${checks} 项哈希合同与 PB 回退口径通过`);
})().catch(error => {
  console.error(error && (error.stack || error.message));
  process.exit(1);
});

// 投资策略选股中心 V2：规则边界、十进制、周期键、个人覆盖层、发布指针专项。
// 覆盖方案 27.4 / 27.5 / 27.6 / 27.9 / 27.13 的确定性反例。
// 上半部分是纯函数（无库），下半部分用隔离库验证指针/事件与影子隔离（迁移 189 之后）。
'use strict';
const assert = require('assert');
const V2 = require('../domain/stockSelectionRulesV2');
const V1 = require('../domain/stockSelectionRules');
const PORTFOLIO = require('../domain/stockSelectionPortfolio');
const PERIODS = require('../services/stockSelectionPeriods');
const SERVICE = require('../services/stockSelectionService');
const BACKTEST = require('../services/stockSelectionBacktest');

const tests = [];
async function check(name, fn) {
  try { await fn(); tests.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (error) { tests.push(['FAIL', name + ' :: ' + error.message]); console.log('  [FAIL] ' + name + ' :: ' + error.message); }
}

const P = V2.V2_PARAMS;

function facts(overrides) {
  return Object.assign({
    instrumentId: 1,
    companyId: 100,
    code: '600000.SH',
    name: '测试股',
    market: 'CN',
    pb: 1.2,
    pbRaw: '1.2',
    peTtm: 9.5,
    peTtmRaw: '9.5',
    peStatic: 10,
    price: 10,
    priceDate: '2026-09-30',
    priceCurrency: 'CNY',
    pbWindow: {
      minPb: 0.5, maxPb: 2.4, minPbRaw: '0.5', maxPbRaw: '2.4',
      coveredDays: 900, positiveDays: 900, positiveGapDays: 0,
      observedDays: 900, expectedDays: 900, gapDays: 0, nonPositiveDays: 0, invalidDays: 0,
      missingDays: 0, exemptDays: 0, calendarComplete: true, historyYears: 10,
      windowStart: '2016-09-30', windowEnd: '2026-09-30', effectiveStart: '2016-10-10',
      minPbDate: '2019-01-04', maxPbDate: '2021-02-18',
    },
    equity: { amount: 5e10, currency: 'CNY', periodEnd: '2025-12-31', announcedAt: '2026-03-20', reportId: 1 },
    fx: {},
    dividend: { ttmPerShare: 0.5, count: 1, currency: 'CNY', verifiedZero: false },
    annual: {
      latestYear: 2025,
      years: Array.from({ length: 11 }, (_, index) => ({ year: 2015 + index, profit: 1e9, dividend: 1e8, dividendKnown: true, complete: true })),
      currency: 'CNY',
    },
    industry: { code: '801010', name: '农林牧渔', system: 'SW2021', version: '2021' },
    suspended: false, delistedAtTargetDate: false, riskWarning: null,
  }, overrides || {});
}

function withPb(min, max, gap) {
  return facts({
    pbWindow: Object.assign({}, facts().pbWindow, {
      minPb: Number(min), maxPb: Number(max), minPbRaw: String(min), maxPbRaw: String(max),
      positiveDays: 900 - (gap || 0), positiveGapDays: gap || 0, gapDays: gap || 0,
      expectedDays: 900,
    }),
  });
}

async function main() {
  /* ---------------- R01：PB 与 PE(TTM) 联合估值 ---------------- */
  await check('R01 第一条通道：PB=1.5 闭边界通过，PE 缺失也不影响估值通过', () => {
    const result = V2.evaluateInstrumentV2(facts({ pb: 1.5, pbRaw: '1.5', peTtm: null, peTtmRaw: null }), P);
    assert.strictEqual(result.rules.R01.status, V2.STATUS.PASS);
    assert.strictEqual(result.valuationPassReason, 'PB_THRESHOLD');
    assert.strictEqual(result.valuationPass, true);
    // PE 缺失 → 排名未就绪，但 R01 确实通过；页面必须能分别说明，而不是"已通过却没入选"。
    assert.strictEqual(result.rankReady, false);
    assert.ok(result.rankBlockReasons.includes('pe_ttm_unavailable'));
  });

  await check('R01 第二条通道：乘积 22.4998 通过、22.5 与 22.52 不通过（严格小于）', () => {
    const pass = V2.evaluateInstrumentV2(facts({ pb: 2, pbRaw: '2', peTtm: 11.2499, peTtmRaw: '11.2499' }), P);
    assert.strictEqual(pass.valuationPassReason, 'PB_PE_PRODUCT');
    assert.strictEqual(pass.pbPeProduct, 22.4998);
    const equal = V2.evaluateInstrumentV2(facts({ pb: 2, pbRaw: '2', peTtm: 11.25, peTtmRaw: '11.25' }), P);
    assert.strictEqual(equal.rules.R01.status, V2.STATUS.FAIL);
    assert.strictEqual(equal.valuationPassReason, 'VALUATION_FAILED');
    const over = V2.evaluateInstrumentV2(facts({ pb: 2, pbRaw: '2', peTtm: 11.26, peTtmRaw: '11.26' }), P);
    assert.strictEqual(over.rules.R01.status, V2.STATUS.FAIL);
  });

  await check('R01 边界：0.8×30 与 1.5×30 都由 PB 通道通过；1.8×12.4999 由乘积通道通过', () => {
    assert.strictEqual(V2.evaluateInstrumentV2(facts({ pb: 0.8, pbRaw: '0.8', peTtm: 30, peTtmRaw: '30' }), P).rules.R01.status, V2.STATUS.PASS);
    assert.strictEqual(V2.evaluateInstrumentV2(facts({ pb: 1.5, pbRaw: '1.5', peTtm: 30, peTtmRaw: '30' }), P).rules.R01.status, V2.STATUS.PASS);
    const product = V2.evaluateInstrumentV2(facts({ pb: 1.8, pbRaw: '1.8', peTtm: 12.4999, peTtmRaw: '12.4999' }), P);
    assert.strictEqual(product.rules.R01.status, V2.STATUS.PASS);
    assert.strictEqual(product.valuationPassReason, 'PB_PE_PRODUCT');
  });

  await check('R01 边界：PB=1.5001 且 PE=15（乘积 22.5015）不通过，不加 epsilon 放宽', () => {
    const result = V2.evaluateInstrumentV2(facts({ pb: 1.5001, pbRaw: '1.5001', peTtm: 15, peTtmRaw: '15' }), P);
    assert.strictEqual(result.rules.R01.status, V2.STATUS.FAIL);
    assert.strictEqual(result.valuationPassReason, 'VALUATION_FAILED');
  });

  await check('R01 负 PB 判不通过、PB=0 判待补，都不当"便宜"', () => {
    const negative = V2.evaluateInstrumentV2(facts({ pb: -1, pbRaw: '-1' }), P);
    assert.strictEqual(negative.rules.R01.status, V2.STATUS.FAIL);
    assert.strictEqual(negative.valuationPassReason, 'pb_negative_equity');
    const zero = V2.evaluateInstrumentV2(facts({ pb: 0, pbRaw: '0' }), P);
    assert.strictEqual(zero.rules.R01.status, V2.STATUS.PENDING);
  });

  await check('R01 负 PE 且已核实 TTM 亏损 → 不通过；PE 缺失 → 待补（不回退静态 PE）', () => {
    const loss = V2.evaluateInstrumentV2(facts({ pb: 1.8, pbRaw: '1.8', peTtm: -134.16, peTtmRaw: '-134.16' }), P);
    assert.strictEqual(loss.rules.R01.status, V2.STATUS.FAIL);
    assert.strictEqual(loss.valuationPassReason, 'PE_NON_POSITIVE');
    const missing = V2.evaluateInstrumentV2(facts({ pb: 1.8, pbRaw: '1.8', peTtm: null, peTtmRaw: null }), P);
    assert.strictEqual(missing.rules.R01.status, V2.STATUS.PENDING);
    assert.strictEqual(missing.valuationPassReason, 'PE_PENDING');
  });

  await check('R01 一条财报都没有（新股）→ 不可评估，不是待补', () => {
    const result = V2.evaluateInstrumentV2(facts({ pb: null, pbRaw: null, annual: { latestYear: null, years: [] } }), P);
    assert.strictEqual(result.rules.R01.status, V2.STATUS.NOT_APPLICABLE);
    assert.strictEqual(result.valuationPassReason, 'pb_not_evaluable_no_report');
  });

  /* ---------------- TTM 状态与血缘 ---------------- */
  await check('TTM：年报盈利但 PE(TTM) 为负 → 状态按 TTM 亏损，不用年报洗白', () => {
    const result = V2.evaluateInstrumentV2(facts({ pb: 0.9, pbRaw: '0.9', peTtm: -12.3, peTtmRaw: '-12.3' }), P);
    assert.strictEqual(result.ttmProfitStatus, 'loss');
    assert.strictEqual(result.ttmStatusBasis, 'provider_reported_pe_ttm');
    // R01 的 PB 通道仍通过，但排名按亏损组记 P 分（不把负 PE 当低估）。
    assert.strictEqual(result.rules.R01.status, V2.STATUS.PASS);
    assert.strictEqual(result.rankReady, true);
    assert.strictEqual(result.peNegative, true);
  });

  await check('TTM：供应商 PE 与自算 TTM 符号相反 → 待核验，排名未就绪', () => {
    const result = V2.evaluateInstrumentV2(facts({ peTtm: 12, peTtmRaw: '12', ttmProfit: -1e8 }), P);
    assert.strictEqual(result.ttmProfitStatus, 'unknown');
    assert.strictEqual(result.ttmStatusBasis, 'provider_vs_computed_conflict');
    assert.ok(result.rankBlockReasons.includes('ttm_status_unknown'));
  });

  await check('排名：亏损/零利润 PE 分统一为盈利股数量 P，负 PE 不参与升序', () => {
    const rows = [
      V2.evaluateInstrumentV2(facts({ instrumentId: 1, code: 'A', pb: 0.8, pbRaw: '0.8', peTtm: 8, peTtmRaw: '8' }), P),
      V2.evaluateInstrumentV2(facts({ instrumentId: 2, code: 'B', pb: 0.9, pbRaw: '0.9', peTtm: 9, peTtmRaw: '9' }), P),
      V2.evaluateInstrumentV2(facts({ instrumentId: 3, code: 'C', pb: 1.0, pbRaw: '1.0', peTtm: -50, peTtmRaw: '-50' }), P),
    ];
    const ranked = V2.rankCandidatesV2(rows);
    assert.strictEqual(ranked.profitCount, 2);
    const loss = ranked.ranked.find(item => item.code === 'C');
    assert.strictEqual(loss.peRank, 2, '亏损股 PE 分等于盈利股数量');
    assert.strictEqual(loss.rankReady, true);
  });

  /* ---------------- R02：十年 PB 正极值比 ---------------- */
  await check('R02 正极值比：0.2→0.6 与 0.3→0.9 都由十进制交叉比较通过', () => {
    assert.strictEqual(V2.evaluateInstrumentV2(withPb('0.2', '0.6'), P).rules.R02.status, V2.STATUS.PASS);
    // 0.9/0.3 在二进制浮点里是 2.9999999999999996；十进制比较必须判通过。
    assert.strictEqual(V2.evaluateInstrumentV2(withPb('0.3', '0.9'), P).rules.R02.status, V2.STATUS.PASS);
  });

  await check('R02 正极值比：0.2→0.599 完整覆盖判不通过，有缺口只能待补', () => {
    const complete = V2.evaluateInstrumentV2(withPb('0.2', '0.599', 0), P);
    assert.strictEqual(complete.rules.R02.status, V2.STATUS.FAIL);
    assert.strictEqual(complete.rules.R02.reason, 'pb_extrema_below_multiple');
    const gap = V2.evaluateInstrumentV2(withPb('0.2', '0.599', 5), P);
    assert.strictEqual(gap.rules.R02.status, V2.STATUS.PENDING);
    assert.strictEqual(gap.rules.R02.reason, 'pb_extrema_gap_pending');
  });

  await check('R02 正证优先：缺口存在但已观测 3 倍比值 → 通过（数学下界，不要求零缺口）', () => {
    const result = V2.evaluateInstrumentV2(withPb('0.2', '0.7', 30), P);
    assert.strictEqual(result.rules.R02.status, V2.STATUS.PASS);
    // 完整性字段如实返回 false，不能因为判 PASS 就伪造完整。
    assert.strictEqual(result.pbCoverage.historyComplete, false);
  });

  await check('R02 严格完整性政策（27.5 零缺口基线）：有缺口时即使达标也不得判通过', () => {
    const strict = Object.assign({}, P, { pbExtremaPolicy: 'strict_complete' });
    // 0.2→0.5 只有 2.5 倍且缺口存在：零缺口基线不允许判 FAIL，只能不可评估。
    const below = V2.evaluateInstrumentV2(withPb('0.2', '0.5', 30), strict);
    assert.strictEqual(below.rules.R02.status, V2.STATUS.NOT_APPLICABLE);
    assert.strictEqual(below.rules.R02.reason, 'history_gap_not_evaluable');
    // 独立验收 A01：0.3→0.9 已达标，但 gap=1 时严格政策必须不可评估，不能沿用正证通过。
    const positiveWithGap = V2.evaluateInstrumentV2(withPb('0.3', '0.9', 1), strict);
    assert.strictEqual(positiveWithGap.rules.R02.status, V2.STATUS.NOT_APPLICABLE);
    assert.strictEqual(positiveWithGap.rules.R02.reason, 'history_gap_not_evaluable');
    assert.strictEqual(positiveWithGap.pbCoverage.historyComplete, false);
    // 零缺口且达标才是严格政策下唯一的 PASS 路径。
    const zeroGap = V2.evaluateInstrumentV2(withPb('0.3', '0.9', 0), strict);
    assert.strictEqual(zeroGap.rules.R02.status, V2.STATUS.PASS);
  });

  await check('R02 日历未核验：不得声称历史完整，两种政策都不能给正式结论（A02）', () => {
    const unverified = facts({
      pbWindow: Object.assign({}, facts().pbWindow, { calendarComplete: false }),
    });
    // 本用例守的是极值比口径下的两种证据政策：日历未核验时缺口里是否藏极值不可知。
    const v2Only = Object.assign({}, P, { r02Rule: 'v2_positive_ratio' });
    const positive = V2.evaluateInstrumentV2(unverified, v2Only);
    assert.strictEqual(positive.pbCoverage.historyComplete, false);
    assert.strictEqual(positive.rules.R02.status, V2.STATUS.NOT_APPLICABLE);
    assert.strictEqual(positive.rules.R02.reason, 'history_calendar_unverified');
    const strict = Object.assign({}, v2Only, { pbExtremaPolicy: 'strict_complete' });
    assert.strictEqual(V2.evaluateInstrumentV2(unverified, strict).rules.R02.status, V2.STATUS.NOT_APPLICABLE);
    // 正式口径是「或」：maxPb>1 是已经证明的事实（正证），日历缺口不推翻它。
    assert.strictEqual(V2.evaluateInstrumentV2(unverified, P).rules.R02.status, V2.STATUS.PASS,
      '老口径那一支：PB 曾破 1 已可证明，不因日历未核验改判');
  });

  await check('R02 混合已核实非正事实：正极值三倍也不得通过（A10）', () => {
    const result = V2.evaluateInstrumentV2(facts({
      pbWindow: Object.assign({}, facts().pbWindow, {
        minPb: 0.3, maxPb: 0.9, minPbRaw: '0.3', maxPbRaw: '0.9',
        nonPositiveDays: 1, expectedDays: 900, positiveDays: 899, positiveGapDays: 0, gapDays: 0,
      }),
    }), P);
    assert.strictEqual(result.rules.R02.status, V2.STATUS.NOT_APPLICABLE);
    assert.strictEqual(result.rules.R02.reason, 'pb_non_positive_not_evaluable');
  });

  await check('R02 非正 PB 不参加极值：已核实非正事实判不可评估', () => {
    const result = V2.evaluateInstrumentV2(facts({
      pbWindow: Object.assign({}, facts().pbWindow, {
        minPb: null, maxPb: null, minPbRaw: null, maxPbRaw: null,
        positiveDays: 0, positiveGapDays: 900, nonPositiveDays: 900, expectedDays: 900,
      }),
    }), P);
    assert.strictEqual(result.rules.R02.status, V2.STATUS.NOT_APPLICABLE);
    assert.strictEqual(result.rules.R02.reason, 'pb_non_positive_not_evaluable');
    assert.strictEqual(result.pbPositiveExtremaRatio, null);
  });

  await check('R02 单点有效序列（min=max）：极值比口径不通过，正式口径按老口径通过', () => {
    const v2Only = Object.assign({}, P, { r02Rule: 'v2_positive_ratio' });
    const result = V2.evaluateInstrumentV2(withPb('1.2', '1.2', 0), v2Only);
    assert.strictEqual(result.pbPositiveExtremaRatio, 1);
    assert.strictEqual(result.rules.R02.status, V2.STATUS.FAIL, '极值比口径：比值 1 不满足三倍');
    // 正式口径是「或」：十年稳定在 1.2 已满足「曾破 1」，走老口径那一支通过。
    assert.strictEqual(V2.evaluateInstrumentV2(withPb('1.2', '1.2', 0), P).rules.R02.status, V2.STATUS.PASS);
    // 十年都在 1 以下且没有落差时，两支都不满足，才是明确不合格。
    assert.strictEqual(V2.evaluateInstrumentV2(withPb('0.9', '0.9', 0), P).rules.R02.status, V2.STATUS.FAIL,
      '十年在 1 以下且无落差 → 不合格');
  });

  await check('R02 展示年限于真实观察起止日，不用交易日数÷365 冒充', () => {
    const result = V2.evaluateInstrumentV2(facts({
      pbWindow: Object.assign({}, facts().pbWindow, { effectiveStart: '2021-06-30', historyYears: 5.3 }),
    }), P);
    assert.strictEqual(result.pbCoverage.effectiveStart, '2021-06-30');
    assert.strictEqual(result.pbCoverage.historyYears, 5.3);
  });

  /* ---------------- 十进制合同 ---------------- */
  await check('十进制：规范化去尾零、负零归一，哈希因此稳定', () => {
    assert.strictEqual(V2.normalizeDecimalText('1.50'), '1.5');
    assert.strictEqual(V2.normalizeDecimalText('1.5'), '1.5');
    assert.strictEqual(V2.normalizeDecimalText('-0.0'), '0');
    assert.strictEqual(V2.normalizeDecimalText('1e3'), '1000');
    assert.strictEqual(V2.compareDecimal('1.50', '1.5'), 0);
  });

  await check('十进制：乘积与比较不走 Number（2×11.2499 精确等于 22.4998）', () => {
    assert.strictEqual(V2.multiplyDecimal('2', '11.2499'), '22.4998');
    assert.strictEqual(V2.multiplyDecimal('0.3', '3'), '0.9');
    assert.strictEqual(V2.compareDecimal('22.5', '22.5'), 0);
    assert.strictEqual(V2.compareDecimal('22.4998', '22.5'), -1);
    // 0.1+0.2 类浮点噪声在十进制比较里不存在
    assert.strictEqual(V2.compareDecimal(V2.multiplyDecimal('0.2', '1.1'), '0.22'), 0);
  });

  await check('十进制：空值/NaN/Infinity 不是"0"，比较返回 null', () => {
    assert.strictEqual(V2.parseDecimal(null), null);
    assert.strictEqual(V2.parseDecimal(''), null);
    assert.strictEqual(V2.parseDecimal('NaN'), null);
    assert.strictEqual(V2.parseDecimal('Infinity'), null);
    assert.strictEqual(V2.compareDecimal(null, '1'), null);
  });

  /* ---------------- V2 取消市场指数门槛 ---------------- */
  await check('V2 市场门槛：指数 PB=1.9/2/2.1/缺失一律不阻断，只标"不适用"', () => {
    ['1.9', '2', '2.1', null].forEach(pb => {
      const gate = V2.evaluateMarketGateV2({ pb, pe: 20, tradeDate: '2026-09-30' });
      assert.strictEqual(gate.eligible, true, `PB=${pb} 不得阻断 V2`);
      assert.strictEqual(gate.applied, false);
      assert.strictEqual(gate.displayOnly, true);
    });
  });

  await check('V1 市场门槛保持原样：PB=2 关闭、缺失是数据故障', () => {
    assert.strictEqual(V1.evaluateMarketGate({ pb: 2 }).eligible, false);
    assert.strictEqual(V1.evaluateMarketGate({ pb: null }).reason, 'market_pb_missing');
  });

  /* ---------------- 组合与个人覆盖层 ---------------- */
  function rankedRows(count, industryCode) {
    return Array.from({ length: count }, (_, index) => ({
      instrumentId: index + 1,
      code: `60${String(index).padStart(4, '0')}.SH`,
      name: `测试${index}`,
      companyId: 1000 + index,
      currentPb: 0.8 + index * 0.01,
      currentPe: 8 + index,
      dividendYield: 0.05,
      ttmProfitStatus: 'profit',
      filterStatus: 'PASS',
      rankReady: true,
      selectionOrder: index + 1,
      industry: { code: industryCode, name: '同行业', system: 'SW2021', version: '2021' },
    }));
  }

  await check('组合：p=100% 同行业 6 席、p=70% 8 席（不写死最多 6 只）', () => {
    const full = PORTFOLIO.buildPortfolio({ ranked: rankedRows(12, '801010'), positionRatio: 1 });
    assert.strictEqual(full.members.length, 6);
    const partial = PORTFOLIO.buildPortfolio({ ranked: rankedRows(12, '801010'), positionRatio: 0.7 });
    assert.strictEqual(partial.members.length, 8);
  });

  await check('组合：个人排除按原 selection_order 递补，不重算基础名次', () => {
    const rows = rankedRows(10, '801010');
    rows[0].industry = { code: '801020', name: '另一行业', system: 'SW2021', version: '2021' };
    const portfolio = PORTFOLIO.buildPortfolio({
      ranked: rows,
      positionRatio: 1,
      excludedInstrumentIds: [1],
    });
    assert.strictEqual(portfolio.members.some(item => item.instrumentId === 1), false);
    assert.strictEqual(portfolio.members[0].instrumentId, 2, '第 1 名被排除后由第 2 名补位');
    assert.strictEqual(portfolio.members[0].selectionOrder, 2, '保留源批次名次，不重新排名');
    assert.ok(portfolio.skipped.some(item => item.reason === 'user_excluded_instrument'));
  });

  await check('组合：个人排除行业同样作用于共享排名，行业上限仍按预算 20% 计', () => {
    const rows = rankedRows(10, '801010');
    const portfolio = PORTFOLIO.buildPortfolio({
      ranked: rows,
      positionRatio: 1,
      excludedIndustryCodes: ['801010'],
    });
    assert.strictEqual(portfolio.members.length, 0);
    assert.strictEqual(portfolio.excludedCount, 10);
  });

  await check('组合：三种权重分母分开，全现金时实际子组合权重为 null 而不是 0/100%', () => {
    const five = PORTFOLIO.buildPortfolio({ ranked: rankedRows(5, '801010'), positionRatio: 1 });
    assert.strictEqual(five.weightBasis.investedDenominator, 5);
    assert.strictEqual(five.members[0].weightInInvestedEquity, 0.2);
    assert.strictEqual(five.members[0].weightInEquityTarget, 1 / 30);
    assert.strictEqual(five.members[0].weightInMarketBudget, 1 / 30);
    const cash = PORTFOLIO.buildPortfolio({ ranked: [], positionRatio: 0 });
    assert.strictEqual(cash.weightBasis.weightInInvestedEquity, null);
    assert.strictEqual(cash.cashWeightInMarketBudget, 1);
  });

  await check('组合：同一行业只数占预算 13.33% 但占实际股票子组合 100%（两个口径不能混说）', () => {
    const portfolio = PORTFOLIO.buildPortfolio({ ranked: rankedRows(4, '801010'), positionRatio: 1 });
    const industry = portfolio.industryBreakdown[0];
    assert.strictEqual(industry.weightInMarketBudget, 4 / 30);
    assert.strictEqual(industry.weightInInvestedEquity, 1);
  });

  /* ---------------- 周期键与目标日 ---------------- */
  await check('周期键：day/week/quarter 前缀固定，周键用周一起始日', () => {
    assert.strictEqual(PERIODS.periodKeyOf('day', '2026-11-06'), 'D:2026-11-06');
    assert.strictEqual(PERIODS.periodKeyOf('week', '2026-11-06'), 'W:2026-11-02');
    assert.strictEqual(PERIODS.periodKeyOf('week', '2026-11-02'), 'W:2026-11-02');
    assert.strictEqual(PERIODS.periodKeyOf('quarter', '2026-08-14'), 'Q:2026Q3');
    assert.strictEqual(PERIODS.periodKeyOf('year', '2026-08-14'), null);
  });

  await check('周期键：跨年周不按"自然年第几周"算，周三与次周一仍属同一周', () => {
    // 2026-12-31 是周四，本周一 2026-12-28；2027-01-01 属于同一周。
    assert.strictEqual(PERIODS.periodKeyOf('week', '2026-12-31'), 'W:2026-12-28');
    assert.strictEqual(PERIODS.periodKeyOf('week', '2027-01-01'), 'W:2026-12-28');
  });

  await check('周期区间：week = 周一至周日，quarter = 季度首日至季末日', () => {
    assert.deepStrictEqual(PERIODS.periodRangeOf('week', 'W:2026-11-02'), { periodStart: '2026-11-02', periodEnd: '2026-11-08' });
    assert.deepStrictEqual(PERIODS.periodRangeOf('quarter', 'Q:2026Q1'), { periodStart: '2026-01-01', periodEnd: '2026-03-31' });
    assert.deepStrictEqual(PERIODS.periodRangeOf('day', 'D:2026-02-28'), { periodStart: '2026-02-28', periodEnd: '2026-02-28' });
    assert.strictEqual(PERIODS.periodRangeOf('week', 'W:bad'), null);
  });

  await check('周期键真实性：不存在的日期与非周一周键必须拒绝（A03 / AC-10）', () => {
    // 正则挡不住 2026-02-31；Date 会把它归一成 3 月，不能拿归一结果当业务日。
    assert.strictEqual(PERIODS.periodKeyOf('day', '2026-02-31'), null);
    assert.strictEqual(PERIODS.periodKeyOf('week', '2026-02-31'), null);
    assert.strictEqual(PERIODS.periodRangeOf('day', 'D:2026-02-31'), null);
    // 周键必须是周一起点；周二当起点会让渠道周期与真实周边界错位。
    assert.strictEqual(PERIODS.periodRangeOf('week', 'W:2026-11-03'), null);
    assert.deepStrictEqual(PERIODS.periodRangeOf('week', 'W:2026-11-02'), { periodStart: '2026-11-02', periodEnd: '2026-11-08' });
  });

  await check('日历证据：整周休市与日历缺档必须分开（A08 / A09）', () => {
    const closedWeek = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07']
      .map(date => ({ trade_date: date, is_open: false }));
    const closed = PERIODS.calendarEvidenceOf(closedWeek, '2026-10-01', '2026-10-07');
    assert.strictEqual(closed.calendarComplete, true);
    assert.deepStrictEqual(closed.openDays, []);
    assert.strictEqual(closed.missingDates.length, 0);

    // 整周只有一条开市行不是"完整周"：不能把这一天直接定成周度 T，必须暴露 6 天缺档。
    const partial = PERIODS.calendarEvidenceOf([{ trade_date: '2026-11-04', is_open: true }], '2026-11-02', '2026-11-08');
    assert.strictEqual(partial.calendarComplete, false);
    assert.strictEqual(partial.missingDates.length, 6);
    assert.deepStrictEqual(partial.openDays, ['2026-11-04']);
  });

  /* ---------------- 27.20 五项阻断的回归（B01—B05） ---------------- */
  await check('B01 日周分区合同：runPeriodic 必须透传并回传 datasetPublication', () => {
    const source = SERVICE.runPeriodic.toString();
    assert.ok(/datasetPublication: input\.datasetPublication/.test(source), 'runPeriodic 必须把分区回调下沉到 computeAndPersist');
    assert.ok(/datasetPublication: result\.datasetPublication/.test(source), 'runPeriodic 必须回传分区发布结果');
  });

  await check('B02 非12月财年 TTM：6月年报直接取完整年度，不当中期组合', () => {
    const result = SERVICE.computeTtmFromReports([
      { reportId: 3, periodEnd: '2026-06-30', periodType: 'annual', announcedAt: '2026-09-20', netProfit: 100, currency: 'HKD' },
      { reportId: 2, periodEnd: '2025-12-31', periodType: 'semiannual', announcedAt: '2026-02-20', netProfit: 40, currency: 'HKD' },
      { reportId: 1, periodEnd: '2025-06-30', periodType: 'annual', announcedAt: '2025-09-20', netProfit: 80, currency: 'HKD' },
    ]);
    assert.strictEqual(result.value, 100);
    assert.strictEqual(result.evidence.method, 'annual_direct');
    assert.strictEqual(result.evidence.fiscalYearEnd, '2026-06-30');
  });

  await check('B03 阶梯开关：R01 通道与 R02 规则可独立切换，倍数 0 不被还原成 3', () => {
    const pbOnly = Object.assign({}, P, { r01Channel: 'pb_only' });
    const pbOnlyResult = V2.evaluateInstrumentV2(facts({ pb: 1.8, pbRaw: '1.8', peTtm: 9, peTtmRaw: '9' }), pbOnly);
    assert.strictEqual(pbOnlyResult.rules.R01.status, V2.STATUS.FAIL, 'pb_only 下 PB>1.5 不通过，即使乘积达标');

    const window21 = facts({
      pbWindow: Object.assign({}, facts().pbWindow, {
        minPb: 1, maxPb: 2, minPbRaw: '1', maxPbRaw: '2',
        positiveDays: 900, positiveGapDays: 0, gapDays: 0,
      }),
    });
    const v1R02 = Object.assign({}, P, { r02Rule: 'v1_any_above_one' });
    assert.strictEqual(V2.evaluateInstrumentV2(window21, v1R02).rules.R02.status, V2.STATUS.PASS,
      'V1 判据：窗口内存在 PB>1 即通过');
    assert.strictEqual(
      V2.evaluateInstrumentV2(window21, Object.assign({}, P, { r02Rule: 'v2_positive_ratio' })).rules.R02.status,
      V2.STATUS.FAIL, '极值比口径单独使用：2/1 < 3 不通过');
    assert.strictEqual(V2.evaluateInstrumentV2(window21, P).rules.R02.status, V2.STATUS.PASS,
      '正式口径是「或」：PB 曾破 1 即通过，不因落差不足被挡');
    assert.strictEqual(V2.evaluateInstrumentV2(window21, Object.assign({}, P, { pbPositiveExtremaMultiple: 0 })).rules.R02.status,
      V2.STATUS.PASS, '倍数 0 必须保留为 0（恒过），不能被 || 3 还原');

    const ladderCodes = BACKTEST.LADDER_STEPS.map(step => step.code);
    assert.deepStrictEqual(ladderCodes, ['A0', 'A1', 'B', 'C', 'D', 'E']);
    const b = BACKTEST.LADDER_STEPS.find(step => step.code === 'B');
    const c = BACKTEST.LADDER_STEPS.find(step => step.code === 'C');
    const d = BACKTEST.LADDER_STEPS.find(step => step.code === 'D');
    const e = BACKTEST.LADDER_STEPS.find(step => step.code === 'E');
    assert.strictEqual(b.internalParams.r02Rule, 'v1_any_above_one');
    assert.strictEqual(c.internalParams.r02Rule, 'v2_positive_ratio');
    assert.strictEqual(b.internalParams.marketGate, 'v1');
    assert.strictEqual(c.internalParams.marketGate, 'v1');
    assert.strictEqual(d.internalParams.marketGate, 'off');
    // 每步只改一个变量：B→C 只改 r02Rule，C→D 只改 marketGate，D→E 只改频率。
    assert.strictEqual(b.internalParams.r01Channel, c.internalParams.r01Channel);
    assert.deepStrictEqual(
      [d.internalParams.r01Channel, d.internalParams.r02Rule],
      [c.internalParams.r01Channel, c.internalParams.r02Rule],
    );
    assert.strictEqual(e.frequency, 'week');
    assert.strictEqual(d.frequency, 'quarter');
  });

  await check('B03b R02 正式口径是「或」：PB 曾破 1 与极值比达标，任一满足即通过', () => {
    // 引入极值比的原因：港股大量标的十年 PB 从未破 1，老口径永远判不合格，
    // 但它们的估值落差可以超过三倍。所以新口径必须能把这些标的捞回来。
    const neverAboveOne = facts({
      pbWindow: Object.assign({}, facts().pbWindow, {
        minPb: 0.25, maxPb: 0.9, minPbRaw: '0.25', maxPbRaw: '0.9',
        positiveDays: 900, positiveGapDays: 0, gapDays: 0, nonPositiveDays: 0,
      }),
    });
    assert.strictEqual(V2.evaluateInstrumentV2(neverAboveOne, P).rules.R02.status, V2.STATUS.PASS,
      '正式口径：十年不破 1 但落差 3.6 倍必须通过（港股场景）');
    assert.strictEqual(
      V2.evaluateInstrumentV2(neverAboveOne, Object.assign({}, P, { r02Rule: 'v1_any_above_one' })).rules.R02.status,
      V2.STATUS.FAIL, '老口径单独使用：十年不破 1 判不合格');
    assert.strictEqual(
      V2.evaluateInstrumentV2(neverAboveOne, Object.assign({}, P, { r02Rule: 'v2_positive_ratio' })).rules.R02.status,
      V2.STATUS.PASS, '极值比口径单独使用：落差达标即通过');

    // 另一个方向：PB 曾破 1 但落差不足，老口径该过的不能被新口径挡住。
    const aboveOneSmallSwing = facts({
      pbWindow: Object.assign({}, facts().pbWindow, {
        minPb: 1, maxPb: 2, minPbRaw: '1', maxPbRaw: '2',
        positiveDays: 900, positiveGapDays: 0, gapDays: 0, nonPositiveDays: 0,
      }),
    });
    assert.strictEqual(V2.evaluateInstrumentV2(aboveOneSmallSwing, P).rules.R02.status, V2.STATUS.PASS,
      '正式口径：PB 曾破 1 即通过，不额外要求落差');
    assert.strictEqual(
      V2.evaluateInstrumentV2(aboveOneSmallSwing, Object.assign({}, P, { r02Rule: 'v2_positive_ratio' })).rules.R02.status,
      V2.STATUS.FAIL, '极值比口径单独使用：2/1 < 3 不合格');

    // 两条都不满足才判不合格。
    const bothFail = facts({
      pbWindow: Object.assign({}, facts().pbWindow, {
        minPb: 0.8, maxPb: 0.95, minPbRaw: '0.8', maxPbRaw: '0.95',
        positiveDays: 900, positiveGapDays: 0, gapDays: 0, nonPositiveDays: 0,
      }),
    });
    assert.strictEqual(V2.evaluateInstrumentV2(bothFail, P).rules.R02.status, V2.STATUS.FAIL,
      '十年不破 1 且落差不足 → 明确不合格');
    assert.strictEqual(V2.evaluateInstrumentV2(aboveOneSmallSwing, P).rules.R02.evidence, 'v1_or_v2_pb_above_one',
      '走老口径那一支时证据字段要标明，便于审计追溯');
    assert.strictEqual(V2.evaluateInstrumentV2(neverAboveOne, P).rules.R02.evidence, 'positive_extrema',
      '走极值比那一支时证据字段是 positive_extrema');
  });

  await check('C01 真实回放成交时点：可见晚于开盘顺延次日，开盘前才可当日', () => {
    const calendar = ['2026-10-22', '2026-10-23', '2026-10-26', '2026-10-27'];
    const selections = [{ periodKey: 'Q:2026Q3', signalDate: '2026-10-23' }];
    const membersByRun = new Map([[7, [{ instrument_id: 1, code: '600000', slot_no: 1 }]]]);
    const planAt = visibleAt => {
      const eventsByPeriod = new Map([['Q:2026Q3', [{
        event_id: 1, action: 'publish', to_run_id: 7, from_run_id: null,
        visible_at: visibleAt, occurred_at: visibleAt, pointer_revision: 1,
      }]]]);
      return BACKTEST.resolveRealReplayPlan({ selections, eventsByPeriod, calendar, membersByRun, market: 'CN' });
    };
    // 北京 18:00（收盘后）与 10:00（开盘后）：当天开盘已过去，不能倒填，只能顺延到 10-27。
    assert.strictEqual(planAt('2026-10-26T10:00:00Z').resolved[0].executionDate, '2026-10-27');
    assert.strictEqual(planAt('2026-10-26T02:00:00Z').resolved[0].executionDate, '2026-10-27');
    // 北京 08:00（开盘前）：可以使用当天开盘。
    assert.strictEqual(planAt('2026-10-26T00:00:00Z').resolved[0].executionDate, '2026-10-26');

    // 缺事件 / 缺可见时刻 / 缺冻结成员一律不可评估。
    const none = BACKTEST.resolveRealReplayPlan({
      selections, eventsByPeriod: new Map(), calendar, membersByRun: new Map(), market: 'CN',
    });
    assert.strictEqual(none.resolved.length, 0);
    assert.strictEqual(none.missing[0].reason, 'publication_event_missing');
    const invisible = BACKTEST.resolveRealReplayPlan({
      selections,
      eventsByPeriod: new Map([['Q:2026Q3', [{ event_id: 1, action: 'publish', to_run_id: 7, visible_at: null }]]]),
      calendar, membersByRun, market: 'CN',
    });
    assert.strictEqual(invisible.missing[0].reason, 'visible_at_missing');
    const noMembers = BACKTEST.resolveRealReplayPlan({
      selections,
      eventsByPeriod: new Map([['Q:2026Q3', [{
        event_id: 1, action: 'publish', to_run_id: 7, visible_at: '2026-10-26T00:00:00Z',
      }]]]),
      calendar, membersByRun: new Map(), market: 'CN',
    });
    assert.strictEqual(noMembers.missing[0].reason, 'published_run_members_missing');

    // 假期：可见日在 10-26，但日历当天不开市 → 顺延到下一开市日。
    const holidayCalendar = ['2026-10-22', '2026-10-23', '2026-10-27'];
    const holiday = BACKTEST.resolveRealReplayPlan({
      selections,
      eventsByPeriod: new Map([['Q:2026Q3', [{
        event_id: 1, action: 'publish', to_run_id: 7, visible_at: '2026-10-26T00:00:00Z',
      }]]]),
      calendar: holidayCalendar, membersByRun, market: 'CN',
    });
    assert.strictEqual(holiday.resolved[0].executionDate, '2026-10-27');
  });

  await check('C04 发布历史回放：首次发布先建仓，修订只在其生效后替换', () => {
    const calendar = ['2026-10-23', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29'];
    const selections = [{ periodKey: 'W:2026-10-19', signalDate: '2026-10-23' }];
    const eventsByPeriod = new Map([['W:2026-10-19', [
      {
        event_id: 1, action: 'publish', to_run_id: 91, from_run_id: null,
        visible_at: '2026-10-23T10:00:00Z', occurred_at: '2026-10-23T10:00:00Z', pointer_revision: 1,
      },
      {
        event_id: 2, action: 'correct', to_run_id: 92, from_run_id: 91,
        visible_at: '2026-10-28T10:00:00Z', occurred_at: '2026-10-28T10:00:00Z', pointer_revision: 2,
      },
    ]]]);
    const membersByRun = new Map([
      [91, [{ instrument_id: 1, code: '600000', slot_no: 1 }]],
      [92, [{ instrument_id: 2, code: '600001', slot_no: 1 }]],
    ]);
    const plan = BACKTEST.resolveRealReplayPlan({ selections, eventsByPeriod, calendar, membersByRun, market: 'CN' });
    assert.strictEqual(plan.missing.length, 0);
    assert.strictEqual(plan.resolved.length, 2, '首次发布与修订各自产生持仓区间，不能压成最后一条');
    assert.strictEqual(plan.resolved[0].executionDate, '2026-10-26');
    assert.strictEqual(plan.resolved[0].computed.portfolio.members[0].instrumentId, 1);
    assert.strictEqual(plan.resolved[0].replayEvidence.action, 'publish');
    assert.strictEqual(plan.resolved[1].executionDate, '2026-10-29');
    assert.strictEqual(plan.resolved[1].computed.portfolio.members[0].instrumentId, 2);
    assert.strictEqual(plan.resolved[1].replayEvidence.action, 'correct');
  });

  await check('C02 阶梯基线：A0/A1 固定 V1，报告值来自实际载荷', () => {
    const steps = BACKTEST.LADDER_STEPS;
    assert.strictEqual(steps[0].strategyCode, V1.STRATEGY_CODE, 'A0 必须固定 V1');
    assert.strictEqual(steps[1].strategyCode, V1.STRATEGY_CODE, 'A1 必须固定 V1');
    steps.forEach(step => assert.ok(step.strategyCode, `${step.code} 必须显式声明策略，不能继承调用方输入`));
    const source = BACKTEST.runLadder.toString();
    assert.ok(/strategyCode: step\.strategyCode/.test(source), '每步必须使用本步固定策略');
    assert.ok(/strategyCode: payload\.strategyCode/.test(source), '报告值必须取自实际载荷');
  });

  /* ---------------- TTM 自算血缘（AC-01b） ---------------- */
  await check('TTM 自算：年报直接取值，中期按"上年年报＋本期累计−上年同期"闭合', () => {
    const annual = SERVICE.computeTtmFromReports([
      { reportId: 1, periodEnd: '2025-12-31', announcedAt: '2026-03-20', netProfit: 100, currency: 'CNY' },
    ]);
    assert.strictEqual(annual.value, 100);
    assert.strictEqual(annual.evidence.method, 'annual_direct');

    const half = SERVICE.computeTtmFromReports([
      { reportId: 3, periodEnd: '2026-06-30', announcedAt: '2026-08-20', netProfit: 60, currency: 'CNY' },
      { reportId: 2, periodEnd: '2025-12-31', announcedAt: '2026-03-20', netProfit: 100, currency: 'CNY' },
      { reportId: 1, periodEnd: '2025-06-30', announcedAt: '2025-08-20', netProfit: 40, currency: 'CNY' },
    ]);
    assert.strictEqual(half.value, 120);
    assert.strictEqual(half.evidence.method, 'annual_plus_ytd_minus_prior_ytd');
    assert.strictEqual(half.evidence.latest.reportId, 3);
    assert.strictEqual(half.evidence.priorAnnual.reportId, 2);
  });

  await check('TTM 自算：缺上年同期或币种不一致都返回未知，不用最新投影凑', () => {
    const missing = SERVICE.computeTtmFromReports([
      { reportId: 3, periodEnd: '2026-06-30', announcedAt: '2026-08-20', netProfit: 60, currency: 'CNY' },
      { reportId: 2, periodEnd: '2025-12-31', announcedAt: '2026-03-20', netProfit: 100, currency: 'CNY' },
    ]);
    assert.strictEqual(missing.value, null);
    assert.strictEqual(missing.reason, 'ttm_components_missing');
    const mismatch = SERVICE.computeTtmFromReports([
      { reportId: 3, periodEnd: '2026-06-30', announcedAt: '2026-08-20', netProfit: 60, currency: 'USD' },
      { reportId: 2, periodEnd: '2025-12-31', announcedAt: '2026-03-20', netProfit: 100, currency: 'CNY' },
      { reportId: 1, periodEnd: '2025-06-30', announcedAt: '2025-08-20', netProfit: 40, currency: 'CNY' },
    ]);
    assert.strictEqual(mismatch.value, null);
    assert.strictEqual(mismatch.reason, 'ttm_currency_mismatch');
  });

  await check('选股槽位业务键：影子/普通、同日不同周期互不吃槽（AC-08）', () => {
    const slots = require('../services/jobScheduleSlots');
    const base = { mode: 'selection_daily', market: 'CN', targetDate: '2026-11-06', periodKey: 'D:2026-11-06' };
    const formal = slots.selectionBusinessKeyOf(base);
    const shadow = slots.selectionBusinessKeyOf(Object.assign({}, base, { shadow: true }));
    const weekly = slots.selectionBusinessKeyOf(Object.assign({}, base, { mode: 'selection_weekly', periodKey: 'W:2026-11-02' }));
    assert.ok(formal && shadow && weekly);
    assert.notStrictEqual(formal, shadow, '影子与普通必须是不同的槽');
    assert.notStrictEqual(formal, weekly, '同日不同周期必须是不同的槽');
    assert.strictEqual(formal, slots.selectionBusinessKeyOf(Object.assign({}, base)), '同身份必须稳定');
    assert.strictEqual(slots.selectionBusinessKeyOf({ mode: 'core' }), null, '其他任务不生成选股业务键');
  });

  /* ---------------- 回测执行与撮合（AC-01c / AC-01d） ---------------- */
  await check('回测信号：周频取每周最后开市日，季度沿用季末最后开市日', () => {
    const calendar = ['2026-11-02', '2026-11-03', '2026-11-06', '2026-11-09', '2026-11-10', '2026-11-13'];
    const weekly = BACKTEST.buildSignalSchedule({ calendar, startDate: '2026-11-01', endDate: '2026-11-30', frequency: 'week' });
    assert.deepStrictEqual(weekly.map(item => item.periodKey), ['W:2026-11-02', 'W:2026-11-09']);
    assert.deepStrictEqual(weekly.map(item => item.signalDate), ['2026-11-06', '2026-11-13']);
    const quarterly = BACKTEST.buildSignalSchedule({ calendar, startDate: '2026-10-01', endDate: '2026-12-31', frequency: 'quarter' });
    assert.strictEqual(quarterly.length, 1);
    assert.strictEqual(quarterly[0].periodKey, 'Q:2026Q4');
  });

  await check('撮合约束：停牌不成交、开盘涨停不买、开盘跌停不卖、容量按成交额缩量', () => {
    const suspended = BACKTEST.matchOrder({
      side: 'buy', wantQty: 100, price: 10, bar: null, prevClose: 9.8, limitRatio: 0.1, participationRate: 0.05,
    });
    assert.strictEqual(suspended.filledQty, 0);
    assert.strictEqual(suspended.reason, 'suspended_or_no_bar');

    const limitUp = BACKTEST.matchOrder({
      side: 'buy', wantQty: 100, price: 11, bar: { open: 11, amount: 1e9 }, prevClose: 10, limitRatio: 0.1, participationRate: 0.05,
    });
    assert.strictEqual(limitUp.filledQty, 0);
    assert.strictEqual(limitUp.reason, 'limit_up_at_open');

    const limitDown = BACKTEST.matchOrder({
      side: 'sell', wantQty: 100, price: 9, bar: { open: 9, amount: 1e9 }, prevClose: 10, limitRatio: 0.1, participationRate: 0.05,
    });
    assert.strictEqual(limitDown.filledQty, 0);
    assert.strictEqual(limitDown.reason, 'limit_down_at_open');

    // 成交额 1000 × 参与率 5% = 50 元上限，价格 10 → 最多 5 股
    const capped = BACKTEST.matchOrder({
      side: 'buy', wantQty: 100, price: 10, bar: { open: 10, amount: 1000 }, prevClose: 9.9, limitRatio: 0.1, participationRate: 0.05,
    });
    assert.ok(Math.abs(capped.filledQty - 5) < 1e-9);
    assert.strictEqual(capped.reason, 'capacity_capped');
  });

  await check('涨跌停比例：主板10%、创业板/科创板20%、北交所30%、港股无限制', () => {
    assert.strictEqual(BACKTEST.priceLimitRatio({ market: 'CN', code: '600000' }), 0.1);
    assert.strictEqual(BACKTEST.priceLimitRatio({ market: 'CN', code: '300750' }), 0.2);
    assert.strictEqual(BACKTEST.priceLimitRatio({ market: 'CN', code: '688111' }), 0.2);
    assert.strictEqual(BACKTEST.priceLimitRatio({ market: 'CN', code: '830799' }), 0.3);
    assert.strictEqual(BACKTEST.priceLimitRatio({ market: 'HK', code: '00700' }), null);
  });

  /* ---------------- 回测：净订单模型（静态不变量） ---------------- */
  await check('回测净订单：按 deltaQty 调仓，不存在"先清仓再买回"的旧实现', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'stockSelectionBacktest.js'), 'utf8');
    // 净订单必须出现"目标 − 当前"的差量，且只对未命中持仓卖 0 目标；
    assert.ok(/const delta = targetQty - position\.shares/.test(source), '必须按目标数量与持仓库差调仓');
    assert.ok(/const delta = targetQty - currentQty/.test(source), '买入侧同样按差量补足');
    assert.ok(!/holdings\.delete\(instrumentId\);\s*\n\s*\}\s*\n\s*cash \+= proceeds/.test(source), '不得保留"无条件清仓后统一买入"的旧路径');
    assert.ok(/next-open-net-order-v1/.test(source), '执行模型版本必须标明净订单代次');
  });

  /* ---------------- 真库：发布指针、影子隔离、事件链 ---------------- */
  let pool = null;
  try { pool = require('../db/connection').pool; } catch (error) { pool = null; }
  let dbReady = false;
  if (pool) {
    try {
      await pool.query('SELECT 1 FROM analytics.stock_selection_publications LIMIT 1');
      await pool.query('SELECT is_shadow FROM analytics.stock_selection_runs LIMIT 1');
      dbReady = true;
    } catch (error) { dbReady = false; }
  }

  if (!dbReady) {
    console.log('  [SKIP] 真库段：迁移 189 未应用到当前测试库');
  } else {
    const repo = require('../repositories/stockSelectionRepository');
    const service = require('../services/stockSelectionService');
    const suffix = `v2test-${Date.now()}`;
    // 季度修订反例用独立策略，避免与日/周渠道的 revision 互相干扰；清理段一并删除。
    let quarterStrategyId = null;
    const strategyId = await repo.upsertStrategy(pool, {
      strategyCode: V2.STRATEGY_CODE_V2, market: 'CN', version: `t-${suffix}`,
      formulaVersion: P.formulaVersion, adapterVersion: P.adapterVersion,
      riskVersion: P.riskVersion, industryVersion: P.industryVersion,
      effectiveFrom: '2026-01-01', parameters: P,
      contentHash: `hash-${suffix}`,
    });
    const baseRun = {
      strategyId, market: 'CN', ownerUsername: null, quarter: null,
      asOfDate: '2026-11-06', knowledgeCutoff: '2026-11-06T15:00:00+08:00',
      executionStatus: 'succeeded', qualityStatus: 'passed', businessStatus: 'eligible',
      inputManifest: { suffix }, universeCount: 3, pendingCount: 0, selectedCount: 1,
      marketPb: 1.4, marketPe: 18, benchmarkCode: '000985', valuationMethod: 'market_cap_weighted',
      positionRatio: 1, budgetRatio: null, revision: 1, publishedAt: null,
      periodType: 'week', periodKey: 'W:2026-11-02', periodStart: '2026-11-02', periodEnd: '2026-11-08',
      computedAt: new Date(), isShadow: false,
    };

    const weeklyId = await repo.insertRun(pool, Object.assign({}, baseRun, { runKind: 'weekly', inputHash: `w-${suffix}` }));
    const dailyId = await repo.insertRun(pool, Object.assign({}, baseRun, {
      runKind: 'daily', inputHash: `d-${suffix}`, periodType: 'day', periodKey: 'D:2026-11-06',
      periodStart: '2026-11-06', periodEnd: '2026-11-06',
    }));
    const shadowId = await repo.insertRun(pool, Object.assign({}, baseRun, {
      runKind: 'weekly', inputHash: `s-${suffix}`, isShadow: true,
    }));

    await check('真库：周度发布写入 week 渠道指针与不可变事件，日结果不写 week 指针', async () => {
      const published = await repo.publishRun(pool, weeklyId, { reason: 'test' });
      assert.strictEqual(published.published, true);
      assert.strictEqual(published.periodType, 'week');
      const pointer = await repo.findPublication({ market: 'CN', strategyId, periodType: 'week', periodKey: 'W:2026-11-02' }, pool);
      assert.ok(pointer, '周度指针必须存在');
      assert.strictEqual(Number(pointer.run_id), weeklyId);
      const dailyPointer = await repo.findPublication({ market: 'CN', strategyId, periodType: 'day', periodKey: 'D:2026-11-06' }, pool);
      assert.strictEqual(dailyPointer, null, '日结果不能移动周度指针，也不该自己出现 week 指针');
      const events = await repo.listPublicationEvents({ market: 'CN', periodType: 'week', periodKey: 'W:2026-11-02' }, pool);
      assert.ok(events.some(event => event.action === 'publish' && Number(event.to_run_id) === weeklyId));
    });

    await check('真库：影子批次拒绝写正式指针，私人批次同样拒绝', async () => {
      await assert.rejects(
        () => repo.publishRun(pool, shadowId, {}),
        error => error.status === 409 && /影子/.test(error.message),
      );
      const personalId = await repo.insertRun(pool, Object.assign({}, baseRun, {
        runKind: 'personal', inputHash: `p-${suffix}`, ownerUsername: null,
      }));
      await assert.rejects(
        () => repo.publishRun(pool, personalId, {}),
        error => error.status === 409 && /个人/.test(error.message),
      );
    });

    await check('真库：同渠道旧 revision 不能覆盖新结论；CAS 期望值不符时拒绝', async () => {
      const newer = await repo.insertRun(pool, Object.assign({}, baseRun, { runKind: 'weekly', inputHash: `w2-${suffix}`, revision: 2 }));
      const published = await repo.publishRun(pool, newer, {});
      assert.strictEqual(published.action, 'correct');
      await assert.rejects(
        () => repo.publishRun(pool, weeklyId, {}),
        error => error.status === 409,
      );
      const third = await repo.insertRun(pool, Object.assign({}, baseRun, { runKind: 'weekly', inputHash: `w3-${suffix}`, revision: 3 }));
      await assert.rejects(
        () => repo.publishRun(pool, third, { expectedRunId: 1 }),
        error => error.status === 409 && /指针/.test(error.message),
      );
    });

    await check('真库：日/周批次同输入幂等，影子与非影子不互相复用', async () => {
      const findWeekly = await repo.findRunByIdempotencyKey(pool, {
        strategyId, market: 'CN', asOfDate: '2026-11-06', runKind: 'weekly',
        inputHash: `w-${suffix}`, ownerUsername: null, periodType: 'week', isShadow: false,
      });
      assert.strictEqual(findWeekly, weeklyId);
      const findShadow = await repo.findRunByIdempotencyKey(pool, {
        strategyId, market: 'CN', asOfDate: '2026-11-06', runKind: 'weekly',
        inputHash: `w-${suffix}`, ownerUsername: null, periodType: 'week', isShadow: true,
      });
      assert.strictEqual(findShadow, null, '同输入的影子不能命中正式批次');
    });

    await check('真库：周期目标日由本地交易日历取该周期最后开市日，整周休市记 no_session', async () => {
      const target = await service.resolvePeriodTarget({ market: 'CN', periodType: 'week', date: '2026-11-06' });
      assert.strictEqual(target.periodKey, 'W:2026-11-02');
      if (target.asOfDate) {
        assert.ok(target.asOfDate >= '2026-11-02' && target.asOfDate <= '2026-11-08');
      } else {
        assert.ok(['calendar_unavailable', 'no_session'].includes(target.reason));
      }
      const far = await service.resolvePeriodTarget({ market: 'CN', periodType: 'quarter', periodKey: 'Q:1990Q1' });
      assert.strictEqual(far.asOfDate, null, '没有日历覆盖的季度必须拒绝，不能按工作日猜');
    });

    await check('真库：季度修订域独立，已有 revision=1 时下一版必须是 2（A11 / AC-02）', async () => {
      quarterStrategyId = await repo.upsertStrategy(pool, {
        strategyCode: V2.STRATEGY_CODE_V2, market: 'CN', version: `q-${suffix}`,
        formulaVersion: P.formulaVersion, adapterVersion: P.adapterVersion,
        riskVersion: P.riskVersion, industryVersion: P.industryVersion,
        effectiveFrom: '2026-01-01', parameters: P, contentHash: `hash-q-${suffix}`,
      });
      const firstQuarter = await repo.insertRun(pool, Object.assign({}, baseRun, {
        strategyId: quarterStrategyId, runKind: 'quarterly', quarter: '2026Q4',
        periodType: 'quarter', periodKey: 'Q:2026Q4', periodStart: '2026-10-01', periodEnd: '2026-12-31',
        inputHash: `q1-${suffix}`, revision: 1,
      }));
      // 服务实际传参：quarterly 同时带 periodType/periodKey/quarter（旧实现因 run_kind 过滤恒返回 1）。
      const next = await repo.nextRevision(pool, {
        market: 'CN', quarter: '2026Q4', strategyId: quarterStrategyId,
        periodType: 'quarter', periodKey: 'Q:2026Q4', runKind: 'quarterly',
      });
      assert.strictEqual(next, 2, '季度修订必须在自己的域递增');
      const secondQuarter = await repo.insertRun(pool, Object.assign({}, baseRun, {
        strategyId: quarterStrategyId, runKind: 'quarterly', quarter: '2026Q4',
        periodType: 'quarter', periodKey: 'Q:2026Q4', periodStart: '2026-10-01', periodEnd: '2026-12-31',
        inputHash: `q2-${suffix}`, revision: next,
      }));
      assert.ok(secondQuarter > firstQuarter);
      const afterSecond = await repo.nextRevision(pool, {
        market: 'CN', quarter: '2026Q4', strategyId: quarterStrategyId,
        periodType: 'quarter', periodKey: 'Q:2026Q4', runKind: 'quarterly',
      });
      assert.strictEqual(afterSecond, 3, '第二版之后必须继续递增');
    });

    await check('真库：旧幂等索引已删除，身份索引含主体维度（A07 / A12）', async () => {
      const legacy = await pool.query(`SELECT schemaname FROM pg_indexes WHERE indexname = 'ux_selection_runs_idempotent'`);
      assert.strictEqual(legacy.rows.length, 0, '旧 ux_selection_runs_idempotent 必须真的被删除');
      const identity = await pool.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'ux_selection_runs_identity_v2'`);
      assert.ok(identity.rows.length, '新身份索引必须存在');
      assert.ok(/owner_subject_id/.test(identity.rows[0].indexdef), '新身份索引必须含主体维度');
      // 同输入、同渠道：正式与影子必须能并存（旧索引会把它们判成重复）。
      const sameInput = `dup-${suffix}`;
      const formalDup = await repo.insertRun(pool, Object.assign({}, baseRun, {
        runKind: 'weekly', inputHash: sameInput, revision: 9,
      }));
      const shadowDup = await repo.insertRun(pool, Object.assign({}, baseRun, {
        runKind: 'weekly', inputHash: sameInput, revision: 9, isShadow: true,
      }));
      assert.ok(formalDup && shadowDup, '同输入正式与影子必须都能落库');
      // 同用户名不同主体：账号删除重建后不能撞同一唯一键（owner_username 有外键，必须用真实用户）。
      const anyUser = await pool.query('SELECT username FROM users ORDER BY username LIMIT 1');
      const ownerName = anyUser.rows[0] ? anyUser.rows[0].username : null;
      const subjectA = await repo.insertRun(pool, Object.assign({}, baseRun, {
        runKind: 'personal', inputHash: `sub-${suffix}`, ownerUsername: ownerName,
        ownerSubjectId: '11111111-1111-1111-1111-111111111111', periodType: 'day', periodKey: 'D:2026-11-06',
      }));
      const subjectB = await repo.insertRun(pool, Object.assign({}, baseRun, {
        runKind: 'personal', inputHash: `sub-${suffix}`, ownerUsername: ownerName,
        ownerSubjectId: '22222222-2222-2222-2222-222222222222', periodType: 'day', periodKey: 'D:2026-11-06',
      }));
      assert.ok(subjectA && subjectB, '同名不同主体必须各自成行');
    });

    await check('真库：股票池 artifact 幂等固化，同一目标日复用同一内容哈希（AC-01a）', async () => {
      const targetDate = '2020-01-02';
      const hash = `u-${suffix}`;
      const first = await repo.insertUniverseArtifact({
        market: 'CN', targetDate, contentHash: hash,
        instrumentIds: [1, 2, 3], members: [{ instrumentId: 1, code: '000001' }],
        basis: { test: true }, replayType: 'pit_research_replay',
      }, pool);
      const again = await repo.insertUniverseArtifact({
        market: 'CN', targetDate, contentHash: hash,
        instrumentIds: [1, 2, 3], members: [], basis: {}, replayType: 'pit_research_replay',
      }, pool);
      assert.strictEqual(again, first, '同内容哈希必须幂等，不能重复固化');
      const found = await repo.findUniverseArtifact({ market: 'CN', targetDate }, pool);
      assert.strictEqual(found.content_hash, hash);
      assert.deepStrictEqual(found.instrument_ids.map(Number).sort((a, b) => a - b), [1, 2, 3]);
      assert.strictEqual(found.replay_type, 'pit_research_replay');
      await pool.query('DELETE FROM analytics.stock_selection_universe_artifacts WHERE market = $1 AND target_date = $2::date', ['CN', targetDate]);
    });

    await check('真库：旧191库前向补列（excluded/knowledge_cutoff/source_versions，C03）', async () => {
      const columns = await pool.query(`
        SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'analytics' AND table_name = 'stock_selection_universe_artifacts'
           AND column_name IN ('excluded','knowledge_cutoff','source_versions')`);
      assert.deepStrictEqual(columns.rows.map(row => row.column_name).sort(),
        ['excluded', 'knowledge_cutoff', 'source_versions'], '三列必须存在（旧库靠 192 前向补列）');
      const applied = await pool.query(
        "SELECT version FROM schema_migrations WHERE version = '192_stock_selection_universe_artifact_columns'");
      assert.strictEqual(applied.rows.length, 1, '补列迁移必须已记录执行');
    });

    await check('真库：预览批次带合法周期键也不得发布（A05 / AC-09）', async () => {
      const previewId = await repo.insertRun(pool, Object.assign({}, baseRun, {
        runKind: 'preview', inputHash: `pv-${suffix}`, revision: 1,
      }));
      await assert.rejects(
        () => repo.publishRun(pool, previewId, {}),
        error => error.status === 409 && /不得发布/.test(error.message),
      );
    });

    await check('真库：无效槽位/缺失令牌不得移动正式指针（A04 / AC-04）', async () => {
      const candidate = await repo.insertRun(pool, Object.assign({}, baseRun, {
        runKind: 'weekly', inputHash: `lease-${suffix}`, revision: 5,
      }));
      await assert.rejects(
        () => repo.publishRun(pool, candidate, { slotId: 99999999, executionToken: 'expired-token' }),
        error => error.status === 409 && /槽位不存在/.test(error.message),
      );
      await assert.rejects(
        () => repo.publishRun(pool, candidate, { executionToken: 'only-token' }),
        error => error.status === 409 && /槽位与执行令牌/.test(error.message),
      );
    });

    await check('真库：修订发布不沿用旧 visible_at，确认后才是新时刻（A06 / AC-05）', async () => {
      // 先把当前周度指针的可见时刻改成 2001，模拟旧确认被带进新版本。
      await pool.query(`
        UPDATE analytics.stock_selection_publications SET visible_at = '2001-01-01T00:00:00Z'
         WHERE market = 'CN' AND strategy_id = $1 AND period_type = 'week' AND period_key = 'W:2026-11-02'`, [strategyId]);
      const revision4 = await repo.insertRun(pool, Object.assign({}, baseRun, {
        runKind: 'weekly', inputHash: `w4-${suffix}`, revision: 4,
      }));
      const published = await repo.publishRun(pool, revision4, {});
      const pending = await pool.query(
        `SELECT visible_at FROM analytics.stock_selection_publications WHERE run_id = $1`, [revision4]);
      assert.strictEqual(pending.rows[0].visible_at, null, '修订后必须等本次确认，不能沿用旧 visible_at');
      const confirmed = await repo.markPublicationVisible({ runId: revision4, eventId: published.eventId }, pool);
      assert.strictEqual(confirmed.ok, true);
      const afterConfirm = await pool.query(
        `SELECT visible_at FROM analytics.stock_selection_publications WHERE run_id = $1`, [revision4]);
      assert.ok(afterConfirm.rows[0].visible_at, '确认后必须写入真实可见时刻');
      assert.ok(new Date(afterConfirm.rows[0].visible_at).getUTCFullYear() >= 2026, '不能回推到 2001 年');
    });

    await check('真库：发布→修订→回滚的事件链按 SQL 还原，回滚目标取 to_run_id（D01）', async () => {
      const periodKey = 'W:2026-10-19';
      const runA = await repo.insertRun(pool, Object.assign({}, baseRun, {
        runKind: 'weekly', inputHash: `rb1-${suffix}`, revision: 1,
        periodType: 'week', periodKey, periodStart: '2026-10-19', periodEnd: '2026-10-25',
      }));
      const runB = await repo.insertRun(pool, Object.assign({}, baseRun, {
        runKind: 'weekly', inputHash: `rb2-${suffix}`, revision: 2,
        periodType: 'week', periodKey, periodStart: '2026-10-19', periodEnd: '2026-10-25',
      }));
      const first = await repo.publishRun(pool, runA, { reason: 'replay-a' });
      assert.strictEqual(first.action, 'publish');
      const second = await repo.publishRun(pool, runB, { reason: 'replay-b' });
      assert.strictEqual(second.action, 'correct', '第二次发布必须是修订事件');
      assert.strictEqual(Number(second.previousRunId), runA, '修订事件的 from 是前一版本');
      // 回滚事件沿用同一张事件表（本仓暂无回滚接口）：from=被回滚版本、to=回到的版本。
      const rollback = await pool.query(`
        INSERT INTO analytics.stock_selection_publication_events
          (market, strategy_id, period_type, period_key, action, from_run_id, to_run_id,
           from_strategy_id, to_strategy_id, pointer_revision, reason)
        VALUES ('CN',$1,'week',$2,'rollback',$3,$4,$1,$1,3,'replay-rollback')
        RETURNING event_id`, [strategyId, periodKey, runB, runA]);
      // 固定可见时刻：让用例不依赖"今天"，同时保留真实事件的字段方向。
      const stamps = [
        [first.eventId, '2026-10-23T10:00:00Z'],
        [second.eventId, '2026-10-27T10:00:00Z'],
        [Number(rollback.rows[0].event_id), '2026-10-29T10:00:00Z'],
      ];
      for (const [eventId, stamp] of stamps) {
        await pool.query(`
          UPDATE analytics.stock_selection_publication_events
             SET occurred_at = $2::timestamptz, visible_at = $2::timestamptz
           WHERE event_id = $1`, [eventId, stamp]);
      }
      const events = await repo.loadPublicationReplayEvidence({
        market: 'CN', periodType: 'week', periodKeys: [periodKey], strategyCode: V2.STRATEGY_CODE_V2,
      });
      const list = events.get(periodKey) || [];
      assert.deepStrictEqual(list.map(item => item.action), ['publish', 'correct', 'rollback'], '事件序列必须完整保留');
      assert.deepStrictEqual(list.map(item => Number(item.to_run_id)), [runA, runB, runA], 'to_run_id 才是目标版本');
      assert.deepStrictEqual(
        list.map(item => (item.from_run_id === null ? null : Number(item.from_run_id))),
        [null, runA, runB], 'from_run_id 记录离开的版本，只作审计',
      );
      const plan = BACKTEST.resolveRealReplayPlan({
        selections: [{ periodKey, signalDate: '2026-10-23' }],
        eventsByPeriod: events,
        calendar: ['2026-10-23', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30'],
        membersByRun: new Map([
          [runA, [{ instrument_id: 1, code: '600000', slot_no: 1 }]],
          [runB, [{ instrument_id: 2, code: '600001', slot_no: 1 }]],
        ]),
        market: 'CN',
      });
      assert.strictEqual(plan.missing.length, 0, JSON.stringify(plan.missing));
      assert.deepStrictEqual(plan.resolved.map(item => item.replayEvidence.runId), [runA, runB, runA],
        '回滚必须回到 to_run_id 指定的版本，不能停在被回滚的那一版');
      assert.deepStrictEqual(plan.resolved.map(item => item.executionDate), ['2026-10-26', '2026-10-28', '2026-10-30']);
      assert.deepStrictEqual(plan.resolved.map(item => item.computed.portfolio.members[0].instrumentId), [1, 2, 1],
        '持仓必须随事件切换，并在回滚后恢复');
    });

    await check('真库：晨间执行补上一已结束交易日，晚间执行排当日（B05）', async () => {
      // 上海 08:20 = UTC 00:20；旧实现 readyHour=18 时这个时刻恒返回空。
      const morning = await service.duePeriodicTargets({ market: 'CN', now: new Date('2026-11-06T00:20:00Z'), readyHour: 18 });
      assert.ok(morning.length > 0, '08:20 不得恒返回空');
      const dayTarget = morning.find(item => item.periodType === 'day');
      assert.ok(dayTarget, '必须给出上一已结束交易日');
      assert.strictEqual(dayTarget.targetDate < '2026-11-06', true);
      assert.strictEqual(dayTarget.catchup, true);
      // 18:40 已过就绪窗口：排当日。
      const evening = await service.duePeriodicTargets({ market: 'CN', now: new Date('2026-11-06T10:40:00Z'), readyHour: 18 });
      assert.ok(evening.some(item => item.periodKey === 'D:2026-11-06'), '18:40 必须排出当日');
    });

    await check('真库：设置保存的乐观锁与非法代码拒绝', async () => {
      const payload = service.validateSettingsPayload({ budgetRatioA: 0.6, excludedInstruments: [{ market: 'CN', code: '999999.SH' }] }, {});
      assert.strictEqual(payload.excludedInstruments.length, 1);
      assert.strictEqual(payload.schemaVersion, 2);
      // 省略新字段时保留旧排除，不把"没提到"当"清空"
      const merged = service.validateSettingsPayload({ budgetRatioA: 0.5 }, { excludedInstruments: [{ market: 'CN', code: '600000.SH', instrumentId: 1 }], industryFilters: { CN: [{ code: '801010' }] } });
      assert.strictEqual(merged.excludedInstruments.length, 1);
      assert.strictEqual(merged.industryFilters.CN.length, 1);
      // 显式空数组才是恢复全部
      const cleared = service.validateSettingsPayload({ excludedInstruments: [], industryFilters: { CN: [] } }, { excludedInstruments: [{ market: 'CN', code: '600000.SH' }] });
      assert.strictEqual(cleared.excludedInstruments.length, 0);
      assert.strictEqual(cleared.industryFilters.CN.length, 0);
      // 非法市场直接拒绝
      assert.throws(() => service.validateSettingsPayload({ excludedInstruments: [{ market: 'US', code: 'AAPL' }] }, {}), /CN 或 HK/);
    });

    // 清理本用例自建数据：测试库会被复用，残留策略会干扰 getMarkets 的"最新策略"解析。
    await (async () => {
      try {
        const strategyIds = [strategyId, quarterStrategyId].filter(Boolean);
        await pool.query('DELETE FROM analytics.stock_selection_publication_events WHERE strategy_id = ANY($1::bigint[])', [strategyIds]);
        await pool.query('DELETE FROM analytics.stock_selection_publications WHERE strategy_id = ANY($1::bigint[])', [strategyIds]);
        await pool.query('DELETE FROM analytics.stock_selection_runs WHERE strategy_id = ANY($1::bigint[])', [strategyIds]);
        await pool.query('DELETE FROM analytics.stock_selection_strategies WHERE strategy_id = ANY($1::bigint[])', [strategyIds]);
      } catch (error) {
        console.log('  [WARN] V2 测试数据清理失败：' + error.message);
      }
    })();
  }

  const failed = tests.filter(item => item[0] === 'FAIL').length;
  console.log('\n选股 V2 专项：' + (tests.length - failed) + '/' + tests.length + ' 通过');
  if (failed) process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

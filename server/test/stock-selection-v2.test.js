// 投资策略选股中心 V2：规则边界、十进制、周期键、个人覆盖层、发布指针专项。
// 覆盖方案 27.4 / 27.5 / 27.6 / 27.9 / 27.13 的确定性反例。
// 上半部分是纯函数（无库），下半部分用隔离库验证指针/事件与影子隔离（迁移 189 之后）。
'use strict';
const assert = require('assert');
const V2 = require('../domain/stockSelectionRulesV2');
const V1 = require('../domain/stockSelectionRules');
const PORTFOLIO = require('../domain/stockSelectionPortfolio');
const PERIODS = require('../services/stockSelectionPeriods');

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

  await check('R02 严格完整性政策（审计对照）：比值不足且有缺口判不可评估，达标仍按正证通过', () => {
    const strict = Object.assign({}, P, { pbExtremaPolicy: 'strict_complete' });
    // 0.2→0.5 只有 2.5 倍且缺口存在：零缺口基线不允许判 FAIL，只能不可评估。
    const below = V2.evaluateInstrumentV2(withPb('0.2', '0.5', 30), strict);
    assert.strictEqual(below.rules.R02.status, V2.STATUS.NOT_APPLICABLE);
    assert.strictEqual(below.rules.R02.reason, 'history_gap_not_evaluable');
    // 已观测 3.5 倍属于数学下界正证，与完整性政策无关，两种政策都应通过。
    const positive = V2.evaluateInstrumentV2(withPb('0.2', '0.7', 30), strict);
    assert.strictEqual(positive.rules.R02.status, V2.STATUS.PASS);
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

  await check('R02 单点有效序列（min=max）完整覆盖 → 比值 1，不满足三倍，不通过', () => {
    const result = V2.evaluateInstrumentV2(withPb('1.2', '1.2', 0), P);
    assert.strictEqual(result.pbPositiveExtremaRatio, 1);
    assert.strictEqual(result.rules.R02.status, V2.STATUS.FAIL);
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
        await pool.query('DELETE FROM analytics.stock_selection_publication_events WHERE strategy_id = $1', [strategyId]);
        await pool.query('DELETE FROM analytics.stock_selection_publications WHERE strategy_id = $1', [strategyId]);
        await pool.query('DELETE FROM analytics.stock_selection_runs WHERE strategy_id = $1', [strategyId]);
        await pool.query('DELETE FROM analytics.stock_selection_strategies WHERE strategy_id = $1', [strategyId]);
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

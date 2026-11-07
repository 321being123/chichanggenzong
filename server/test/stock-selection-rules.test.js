// 投资策略选股中心：纯规则 / 排名 / 组合专项测试（不连数据库）。
// 覆盖方案 13 节的规则边界、排名并列、年度异常、市场准入与 30 席位行业约束。
'use strict';
const assert = require('assert');
const RULES = require('../domain/stockSelectionRules');
const PORTFOLIO = require('../domain/stockSelectionPortfolio');

const tests = [];
async function check(name, fn) {
  try { await fn(); tests.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (error) { tests.push(['FAIL', name + ' :: ' + error.message]); console.log('  [FAIL] ' + name + ' :: ' + error.message); }
}

function facts(overrides) {
  return Object.assign({
    instrumentId: 1, code: '600000.SH', name: '测试股', market: 'CN', companyId: 100,
    pb: 1.2, peStatic: 10, peTtm: 9.5, price: 10, priceDate: '2026-09-30',
    pbWindow: { maxPb: 2.4, coveredDays: 900, marketDays: 1000, calendarDays: 1050 },
    equity: { amount: 5e10, currency: 'CNY', periodEnd: '2025-12-31', announcedAt: '2026-03-20', reportId: 1 },
    fx: {},
    dividend: { ttmPerShare: 0.5, count: 1, currency: 'CNY', verifiedZero: false },
    annual: {
      latestYear: 2025,
      years: Array.from({ length: 11 }, (_, index) => ({ year: 2015 + index, profit: 1e9, dividend: 1e8, complete: true })),
      currency: 'CNY',
    },
    industry: { code: '801010', name: '农林牧渔', system: 'SW2021', version: '2021' },
    suspended: false, delistedAtTargetDate: false, riskWarning: null,
  }, overrides || {});
}

function annualWith(overrides) {
  // dividendKnown 必须显式为 true：没有这条证据就属"分红未知"，按 R2-01 只能待补。
  // 本组用例测的是利润维度比较，所以夹具要给出"分红事实已采集"的完整前提。
  return Array.from({ length: 11 }, (_, index) => Object.assign(
    { year: 2015 + index, profit: 1e9, dividend: 1e8, dividendKnown: true, complete: true }, overrides || {}));
}

async function main() {
  await check('R01 边界：PB 为空或恰为 0 待补；PB 为负是净资产为负的事实，判不通过', () => {
    [0, null, undefined].forEach(pb => {
      const result = RULES.evaluateInstrument(facts({ pb }));
      assert.strictEqual(result.rules.R01.status, RULES.STATUS.PENDING, `PB=${pb} 必须待补`);
      assert.strictEqual(result.filterStatus, RULES.STATUS.PENDING);
    });
    // 2026-11-04 口径：负 PB 不是数据缺失（净资产为负是真实事实），这类公司永远不满足低 PB 条件，
    // 判不通过而不是挂在待补上反复重试、阻断整批发布。
    const negative = RULES.evaluateInstrument(facts({ pb: -1 }));
    assert.strictEqual(negative.rules.R01.status, RULES.STATUS.FAIL, 'PB=-1 必须判不通过');
    assert.strictEqual(negative.rules.R01.reason, 'pb_negative_equity');
  });

  await check('R01 边界：PB=1.5 通过、1.5001 不通过', () => {
    assert.strictEqual(RULES.evaluateInstrument(facts({ pb: 1.5 })).rules.R01.status, RULES.STATUS.PASS);
    assert.strictEqual(RULES.evaluateInstrument(facts({ pb: 1.5001 })).rules.R01.status, RULES.STATUS.FAIL);
  });

  await check('R02 有 PB>1 正证即通过，其余历史缺口不反向推翻', () => {
    const result = RULES.evaluateInstrument(facts({ pbWindow: { maxPb: 1.01, coveredDays: 5, marketDays: 1000, calendarDays: 1050 } }));
    assert.strictEqual(result.rules.R02.status, RULES.STATUS.PASS);
  });

  // 2026-11-03 整改（SSV-09）：历史完整性改为"上市后应有交易日一天不缺"，
  // 不看覆盖率阈值；gapDays>0 只能待补，gapDays=0 才是不符合。
  await check('R02 覆盖不全时判不可评估：不入选、不进缺口，也不判不通过', () => {
    const result = RULES.evaluateInstrument(facts({ pbWindow: { maxPb: 0.9, coveredDays: 900, expectedDays: 1000, gapDays: 100 } }));
    // 2026-11-04 口径：覆盖不全无法证明"十年内没有 PB>1"，属于客观不可评估。
    // 判 PENDING 会让补不动的估值缺口永远阻断整批发布，判 FAIL 又会凭缺失区间错杀。
    assert.strictEqual(result.rules.R02.status, RULES.STATUS.NOT_APPLICABLE);
    assert.strictEqual(result.rules.R02.reason, 'history_gap_not_evaluable');
    assert.strictEqual(result.filterStatus, RULES.STATUS.NOT_APPLICABLE, '整只股票也不能进候选');
  });

  await check('R04 采过分红但近 12 个月无已实施现金分红 → 明确不通过，不再当数据缺失', () => {
    const result = RULES.evaluateInstrument(facts({
      dividend: { ttmPerShare: null, count: 0, verifiedZero: true, hasDividendHistory: true },
    }));
    assert.strictEqual(result.rules.R04.status, RULES.STATUS.FAIL);
    assert.strictEqual(result.rules.R04.reason, 'verified_no_cash_dividend');
  });

  await check('年度异常：历史连续但起点偏晚（新股）判不可评估，不阻断发布', () => {
    const years = [2021, 2022, 2023, 2024, 2025].map(year => ({
      year, profit: 1e8, dividend: 1e7, dividendKnown: true, complete: true,
    }));
    const anomaly = RULES.evaluateAnnualAnomaly({ latestYear: 2025, years }, RULES.DEFAULT_PARAMS);
    assert.strictEqual(anomaly.status, RULES.STATUS.NOT_APPLICABLE);
    assert.strictEqual(anomaly.reason, 'fiscal_history_insufficient_not_evaluable');
  });

  await check('年度异常：中间断档仍算待补，不能当新股放过去', () => {
    const years = [2015, 2016, 2021, 2022, 2023, 2024, 2025].map(year => ({
      year, profit: 1e8, dividend: 1e7, dividendKnown: true, complete: true,
    }));
    const anomaly = RULES.evaluateAnnualAnomaly({ latestYear: 2025, years }, RULES.DEFAULT_PARAMS);
    assert.strictEqual(anomaly.status, RULES.STATUS.PENDING);
  });

  await check('R02 无正证但应有日全部覆盖才判不通过', () => {
    const result = RULES.evaluateInstrument(facts({ pbWindow: { maxPb: 0.98, coveredDays: 1000, expectedDays: 1000, gapDays: 0 } }));
    assert.strictEqual(result.rules.R02.status, RULES.STATUS.FAIL);
  });

  await check('R04 股息率 0 且无核验证据为待补，有核验证据才判不通过', () => {
    const pending = RULES.evaluateInstrument(facts({ dividend: { ttmPerShare: null, count: 0, verifiedZero: false } }));
    assert.strictEqual(pending.rules.R04.status, RULES.STATUS.PENDING);
    const failed = RULES.evaluateInstrument(facts({ dividend: { ttmPerShare: null, count: 0, verifiedZero: true } }));
    assert.strictEqual(failed.rules.R04.status, RULES.STATUS.FAIL);
  });

  await check('R04 送转导致股份单位未统一时待补', () => {
    const result = RULES.evaluateInstrument(facts({ dividend: { ttmPerShare: 0.5, count: 1, shareUnitUnverified: true } }));
    assert.strictEqual(result.rules.R04.status, RULES.STATUS.PENDING);
    assert.strictEqual(result.rules.R04.reason, 'share_unit_adjustment_unverified');
  });

  await check('R04 一份年报都没有的新股判不可评估，不把整批发布卡住', () => {
    // 本月上市的新股客观上还没有年报与分红，属"不可评估"而非"待补"；
    // 否则每个新股都会让整批判 partial 发不出去（2026-11-07 生产实测 7 只）。
    const result = RULES.evaluateInstrument(facts({
      dividend: { ttmPerShare: null, count: 0, verifiedZero: false },
      annual: { latestYear: null, years: [], currency: null },
    }));
    assert.strictEqual(result.rules.R04.status, RULES.STATUS.NOT_APPLICABLE);
    assert.strictEqual(result.rules.R04.reason, 'no_annual_report_not_evaluable');
    // 有年报、只是没分红证据的，仍然待补（不能把缺口一起放过）。
    const withReport = RULES.evaluateInstrument(facts({
      dividend: { ttmPerShare: null, count: 0, verifiedZero: false },
    }));
    assert.strictEqual(withReport.rules.R04.status, RULES.STATUS.PENDING);
  });

  await check('R05 100 亿边界：等于通过、少一分不通过', () => {
    assert.strictEqual(RULES.evaluateInstrument(facts({ equity: { amount: 1e10, currency: 'CNY', periodEnd: '2025-12-31' } })).rules.R05.status, RULES.STATUS.PASS);
    assert.strictEqual(RULES.evaluateInstrument(facts({ equity: { amount: 1e10 - 1, currency: 'CNY', periodEnd: '2025-12-31' } })).rules.R05.status, RULES.STATUS.FAIL);
  });

  await check('R05 外币报表用报告期末历史汇率折算，并记录实际汇率日', () => {
    const result = RULES.evaluateInstrument(facts({
      equity: { amount: 2e10, currency: 'HKD', periodEnd: '2025-12-31' },
      fx: { rate: 0.9, date: '2025-12-30' },
    }));
    assert.strictEqual(result.rules.R05.status, RULES.STATUS.PASS);
    assert.strictEqual(result.fxDate, '2025-12-30');
    assert.strictEqual(Math.round(result.equityCny), 1.8e10);
  });

  await check('R05 币种未知仍待补；非 CNY 无历史汇率按客观不可评估（不猜汇率）', () => {
    assert.strictEqual(RULES.evaluateInstrument(facts({ equity: { amount: 2e10, currency: null } })).rules.R05.status, RULES.STATUS.PENDING);
    const fxMissing = RULES.evaluateInstrument(facts({ equity: { amount: 2e10, currency: 'USD', periodEnd: '2025-12-31' }, fx: {} }));
    assert.strictEqual(fxMissing.rules.R05.status, RULES.STATUS.NOT_APPLICABLE);
    assert.strictEqual(fxMissing.rules.R05.reason, 'fx_unavailable_not_evaluable');
  });

  await check('R03 审计机构条件不存在，缺审计数据也能正常判定', () => {
    assert.deepStrictEqual(RULES.RULE_CODES, ['R01', 'R02', 'R04', 'R05']);
    const result = RULES.evaluateInstrument(facts({}));
    assert.strictEqual(result.filterStatus, RULES.STATUS.PASS, '没有审计机构数据不应影响四项判定');
    assert.ok(!('R03' in result.rules));
  });

  // 2026-11-05：PE 口径统一为 TTM（滚动十二个月），静态 PE 不再参与展示与排名。
  await check('PE 口径：只有 PE(TTM) 能参与排名，只有静态 PE 视为待补', () => {
    const staticOnly = RULES.evaluateInstrument(facts({ instrumentId: 901, code: 'P1', peStatic: 10, peTtm: null }));
    assert.strictEqual(staticOnly.currentPe, null, '只有静态 PE 时不得拿它当排名值');
    assert.strictEqual(staticOnly.rankReady, false, '缺 PE(TTM) 不允许进入排名');
    assert.ok(staticOnly.rankBlockReasons.includes('pe_ttm_unavailable'), '缺口原因必须写明缺 PE(TTM)');

    const ttmOnly = RULES.evaluateInstrument(facts({ instrumentId: 902, code: 'P2', peStatic: null, peTtm: 9.5 }));
    assert.strictEqual(ttmOnly.currentPe, 9.5, '排名与展示都取 PE(TTM)');
    assert.strictEqual(ttmOnly.rankReady, true, '有 PE(TTM) 即可排名，不再依赖静态 PE');
  });

  await check('排名：亏损/零利润的 PE 分统一为 P，不追加为 P+1', () => {
    const pool = [
      poolRow(1, 'A', { currentPb: 1.2, currentPe: 8, profitStatus: 'profit' }),
      poolRow(2, 'B', { currentPb: 1.3, currentPe: 12, profitStatus: 'profit' }),
      poolRow(3, 'C', { currentPb: 1.1, currentPe: null, profitStatus: 'loss' }),
      poolRow(4, 'D', { currentPb: 1.4, currentPe: null, profitStatus: 'zero' }),
    ];
    const { ranked, profitCount } = RULES.rankCandidates(pool);
    assert.strictEqual(profitCount, 2);
    assert.strictEqual(ranked.find(row => row.code === 'C').peRank, 2, '亏损股 PE 分必须等于盈利股数量');
    assert.strictEqual(ranked.find(row => row.code === 'D').peRank, 2, '零利润股同样按 P 记分');
  });

  await check('排名：竞赛排名 1,2,2,4 与总分稳定决胜', () => {
    // PB 升序：1.1 → 第1，1.1 → 第1，1.3 → 第3，1.4 → 第4（并列占位，下一名跳号）
    const items = [1.4, 1.1, 1.1, 1.3].map((pb, index) => Object.assign(
      RULES.evaluateInstrument(facts({ instrumentId: index + 1, code: 'C' + index, pb, peStatic: 10, dividend: { ttmPerShare: 0.5, count: 1 } }))));
    const { ranked } = RULES.rankCandidates(items);
    const byCode = new Map(ranked.map(row => [row.code, row]));
    assert.strictEqual(byCode.get('C1').pbRank, 1);
    assert.strictEqual(byCode.get('C2').pbRank, 1);
    assert.strictEqual(byCode.get('C3').pbRank, 3);
    assert.strictEqual(byCode.get('C0').pbRank, 4);
    ranked.forEach((row, index) => assert.strictEqual(row.selectionOrder, index + 1, 'selection_order 必须 1..N 连续'));
  });

  await check('排名：页面四舍五入不改变名次（用原始精度比较）', () => {
    const a = RULES.evaluateInstrument(facts({ instrumentId: 1, code: 'A', pb: 1.0000001 }));
    const b = RULES.evaluateInstrument(facts({ instrumentId: 2, code: 'B', pb: 1.0000002 }));
    const { ranked } = RULES.rankCandidates([b, a]);
    assert.strictEqual(ranked[0].code, 'A');
    assert.strictEqual(ranked[1].pbRank, 2);
  });

  await check('年度异常：最新财年不包含在比较和中，恰等不剔除', () => {
    const years = annualWith({ profit: 1e9, dividend: 1e8 });
    // 十年合计 1e10；最新年 1e9 < 1e10 → 通过
    const passResult = RULES.evaluateAnnualAnomaly({ latestYear: 2025, years });
    assert.strictEqual(passResult.status, RULES.STATUS.PASS);
    assert.strictEqual(passResult.profitSum, 1e10);
    // 恰等于十年合计 → 不剔除
    const equalYears = years.map(row => row.year === 2025 ? Object.assign({}, row, { profit: 1e10 }) : row);
    assert.strictEqual(RULES.evaluateAnnualAnomaly({ latestYear: 2025, years: equalYears }).status, RULES.STATUS.PASS);
    // 严格大于 → 排除
    const exceedYears = years.map(row => row.year === 2025 ? Object.assign({}, row, { profit: 1e10 + 1 }) : row);
    assert.strictEqual(RULES.evaluateAnnualAnomaly({ latestYear: 2025, years: exceedYears }).status, RULES.STATUS.FAIL);
  });

  await check('年度异常：少一年即待补，不当作通过', () => {
    const years = annualWith({}).filter(row => row.year !== 2018);
    const result = RULES.evaluateAnnualAnomaly({ latestYear: 2025, years });
    assert.strictEqual(result.status, RULES.STATUS.PENDING);
    assert.deepStrictEqual(result.missingYears, [2018]);
  });

  await check('年度异常：负的历史利润不清零，负合计可能触发排除', () => {
    const years = annualWith({ profit: -1e9, dividend: 0 });
    const result = RULES.evaluateAnnualAnomaly({ latestYear: 2025, years });
    // 十年合计 -1e10，最新年 -1e9 > -1e10 → 排除（规则本身的结果）
    assert.strictEqual(result.status, RULES.STATUS.FAIL);
    assert.ok(result.profitSum < 0);
  });

  await check('年度异常：分红十年合计比较用公司口径总额', () => {
    // 前十年每年 2e9（合计 2e10），最新年 3e10 → 严格大于，排除
    // 2026-11-03 整改（SSV-04）：只有各年分红事实都可核验时才做分红比较，夹具要显式标 dividendKnown。
    const years = annualWith({ profit: 1e8, dividend: 2e9, dividendKnown: true })
      .map(row => row.year === 2025 ? Object.assign({}, row, { dividend: 3e10 }) : row);
    const result = RULES.evaluateAnnualAnomaly({ latestYear: 2025, years });
    assert.strictEqual(result.status, RULES.STATUS.FAIL);
    assert.strictEqual(result.dividendExceeded, true);
  });

  await check('市场准入：PB<2 才能配置，PB=2 关闭，PB 缺失是数据故障', () => {
    assert.strictEqual(RULES.evaluateMarketGate({ pb: 1.99 }).status, 'eligible');
    assert.strictEqual(RULES.evaluateMarketGate({ pb: 2 }).status, 'market_closed');
    assert.strictEqual(RULES.evaluateMarketGate({ pb: null }).status, 'data_missing');
    assert.strictEqual(RULES.evaluateMarketGate({ pb: 0 }).status, 'data_missing');
  });

  await check('PB 情景参考只有四档，不做线性插值', () => {
    assert.strictEqual(RULES.referencePositionForPb(0.6), 0.7);
    assert.strictEqual(RULES.referencePositionForPb(1.0), 0.5);
    assert.strictEqual(RULES.referencePositionForPb(1.5), 0.3);
    assert.strictEqual(RULES.referencePositionForPb(2.0), null);
  });

  await check('组合：100% 仓位同一行业最多 6 只', () => {
    const ranked = Array.from({ length: 10 }, (_, index) => careerRow(index + 1, 'BANK'));
    const portfolio = PORTFOLIO.buildPortfolio({ ranked, positionRatio: 1 });
    assert.strictEqual(portfolio.members.length, 6);
    assert.strictEqual(portfolio.skipped.filter(item => item.reason === 'industry_limit').length, 4);
  });

  await check('组合：70% 仓位同一行业 8 只通过、9 只拒绝', () => {
    const eight = PORTFOLIO.buildPortfolio({ ranked: Array.from({ length: 8 }, (_, i) => careerRow(i + 1, 'BANK')), positionRatio: 0.7 });
    assert.strictEqual(eight.members.length, 8, '8 只占 18.67%，应通过');
    const nine = PORTFOLIO.buildPortfolio({ ranked: Array.from({ length: 9 }, (_, i) => careerRow(i + 1, 'BANK')), positionRatio: 0.7 });
    assert.strictEqual(nine.members.length, 8, '第 9 只占 21%，必须拒绝');
  });

  await check('组合：不足 30 只时留现金，不放大单只权重', () => {
    const portfolio = PORTFOLIO.buildPortfolio({ ranked: Array.from({ length: 3 }, (_, i) => careerRow(i + 1, 'I' + i)), positionRatio: 1 });
    assert.strictEqual(portfolio.selectedCount, 3);
    assert.strictEqual(portfolio.unfilledSlots, 27);
    portfolio.members.forEach(member => {
      assert.ok(Math.abs(member.weightInMarketBudget - 1 / 30) < 1e-12, '单只权重必须固定为 1/30');
      assert.ok(Math.abs(member.weightInEquityTarget - 1 / 30) < 1e-12);
    });
    assert.ok(Math.abs(portfolio.cashWeightInMarketBudget - 0.9) < 1e-12);
  });

  await check('组合：行业缺失不得塞进"其他"绕过上限', () => {
    const portfolio = PORTFOLIO.buildPortfolio({
      ranked: [careerRow(1, null), careerRow(2, 'BANK')], positionRatio: 1,
    });
    assert.strictEqual(portfolio.members.length, 1);
    assert.ok(portfolio.skipped.some(item => item.reason === 'industry_unverified'));
  });

  await check('组合：年度异常剔除后按顺序补位且不重排名次', () => {
    const ranked = [careerRow(1, 'A'), careerRow(2, 'B'), careerRow(3, 'C')];
    const portfolio = PORTFOLIO.buildPortfolio({
      ranked, positionRatio: 1,
      anomalyById: { [ranked[0].instrumentId]: { status: RULES.STATUS.FAIL, reason: 'profit_exceed_decade' } },
    });
    assert.deepStrictEqual(portfolio.members.map(item => item.code), ['B-2', 'C-3']);
    assert.deepStrictEqual(portfolio.members.map(item => item.slotNo), [1, 2]);
    assert.deepStrictEqual(portfolio.members.map(item => item.selectionOrder), [2, 3]);
  });

  await check('组合：A/H 同发行人标记重复暴露但保留各自席位', () => {
    const a = careerRow(1, 'A'); a.companyId = 777; a.code = '600000.SH';
    const h = careerRow(2, 'B'); h.companyId = 777; h.code = '09988.HK';
    const portfolio = PORTFOLIO.buildPortfolio({ ranked: [a, h], positionRatio: 1 });
    assert.strictEqual(portfolio.members.length, 2);
    assert.ok(portfolio.members.every(member => member.issuerDuplicate === true));
  });

  await check('组合：仓位 0 时只生成观察名单，不称为可买入组合', () => {
    const portfolio = PORTFOLIO.buildPortfolio({ ranked: [careerRow(1, 'A')], positionRatio: 0 });
    assert.strictEqual(portfolio.members.length, 0);
    assert.strictEqual(portfolio.watchlist.length, 1);
  });

  await check('组合：两市场合计敞口只有完整预算时才输出', () => {
    assert.strictEqual(PORTFOLIO.combinedExposure([{ budgetRatio: null, positionRatio: 1, selectedCount: 10, slots: 30 }]), null);
    const value = PORTFOLIO.combinedExposure([
      { budgetRatio: 0.5, positionRatio: 0.7, selectedCount: 30, slots: 30 },
      { budgetRatio: 0.3, positionRatio: 1, selectedCount: 15, slots: 30 },
    ]);
    assert.ok(Math.abs(value - (0.5 * 0.7 + 0.3 * 0.5)) < 1e-12);
  });

  const pass = tests.filter(item => item[0] === 'PASS').length;
  const fail = tests.length - pass;
  console.log(`PASS=${pass} FAIL=${fail}`);
  process.exit(fail ? 1 : 0);
}

function poolRow(order, code, overrides) {
  return Object.assign({
    instrumentId: 2000 + order,
    code,
    name: '样本' + code,
    companyId: null,
    currentPb: 1.2,
    currentPe: 10,
    dividendYield: 0.05,
    profitStatus: 'profit',
    filterStatus: RULES.STATUS.PASS,
    rankReady: true,
    industry: null,
  }, overrides || {});
}

function careerRow(order, industryCode) {
  return {
    instrumentId: 1000 + order,
    code: industryCode ? `${industryCode}-${order}` : `NOIND-${order}`,
    name: '样本' + order,
    companyId: null,
    currentPb: 1 + order * 0.01,
    currentPe: 10 + order,
    dividendYield: 0.05,
    profitStatus: 'profit',
    filterStatus: RULES.STATUS.PASS,
    rankReady: true,
    selectionOrder: order,
    industry: industryCode ? { code: industryCode, name: industryCode, system: 'SW2021', version: '2021' } : null,
  };
}

main().catch(error => { console.error(error); process.exit(1); });

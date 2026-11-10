// 方案 27.38 P0（2026-11-10）：选股输入日常按需补 + 科创板 PE 缺失口径。
//
// 生产只读实证：① 港股股票估值自 2026-11-07 起全市场断档，因为 `selection_inputs`
// 只有人工入口、没有任何日常触发；② 11-10 的 CN 待补 27 只里 26 只是科创板，
// 它们的 pe_ttm 长期为空、ttm_profit_status 全为 loss，却因 R01 只认「PE 缺失=PENDING」
// 每天阻断整市场发布。本文件锁住三件事：排程真的有日常触发且带市场与目标交易日、
// 目标日按本地交易日历取上一交易日、PE 缺失但已核实亏损时不再判待补。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const definitions = require('../services/jobDefinitions');

let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks += 1; };
const eq = (actual, expected, message) => { assert.strictEqual(actual, expected, message); checks += 1; };

// ---------- 1. 任务定义：日常按需补的排程必须存在且带市场/目标日策略 ----------
const finance = definitions.getJobDefinition('company_financial_incremental_sync');
const schedules = Array.isArray(finance.additionalSchedules) ? finance.additionalSchedules : [];
const inputSchedules = schedules.filter(item => item.mode === 'selection_inputs');
eq(inputSchedules.length, 2, '选股输入必须有 CN/HK 两个日常触发');
eq(inputSchedules.map(item => item.market).sort().join(','), 'CN,HK', '两个排程必须分别声明市场');
ok(inputSchedules.every(item => item.targetTradeDate === 'previous_trading_day'),
  '目标交易日必须按上一交易日解析，不能用当天');
ok(inputSchedules.every(item => item.weekdays === true), '日常补数只在工作日生成槽位');
ok(inputSchedules.every(item => item.freshnessGate === false), '补数槽不参与新鲜度门禁');
const hkSchedule = inputSchedules.find(item => item.market === 'HK');
eq(hkSchedule.marketCalendarPolicy, 'hk-open', '港股补数只在港交所开市日生成');
// 不新增外部数据源：外部来源清单必须仍是原来那组（理杏仁官方/ Tushare / 腾讯 / 三地交易所）。
eq(finance.externalSources.length, 6, '补数排程不得混入新数据源');
ok(finance.externalSources.includes('lixinger_official'), '港股估值仍走既有理杏仁入口');
// 不新增任务、不设业务上限：同一 Runner、同一模式，续批与止损仍按原合同。
eq(finance.hour, 6, '原 06:30 core 排程不得被改动');
eq(finance.minute, 30, '原 06:30 core 排程不得被改动');
ok(finance.maxExternalCallsPerRun == null, '补数排程不得编造调用额度');

// ---------- 2. 调度器：目标交易日解析与请求透传 ----------
const slotsSource = read('server/services/jobScheduleSlots.js');
ok(/async function previousTradingDateOf\(market, businessDate\)/.test(slotsSource),
  '必须有按本地交易日历取上一交易日的解析函数');
ok(/String\(state\.status \|\| ''\) === 'open'/.test(slotsSource),
  '只认交易日历明确的 open，不按周一到周五猜开市');
ok(/attempt < 20/.test(slotsSource), '连续查不到必须放弃并跳过，不能无限回退');
ok(/const targetTradeDate = await resolveScheduleTargetTradeDate\(resolvedSchedule, businessDate\)/.test(slotsSource),
  '生成槽位时必须解析目标交易日');
ok(/if \(resolvedSchedule\.targetTradeDate && !targetTradeDate\) continue/.test(slotsSource),
  '解析不出目标交易日时不得生成槽位');
ok(/if \(resolvedSchedule\.market\) requestPayload\.market = String\(resolvedSchedule\.market\)\.toUpperCase\(\)/.test(slotsSource),
  '市场必须写进 request_payload');
ok(/if \(targetTradeDate\) requestPayload\.targetTradeDate = targetTradeDate/.test(slotsSource),
  '目标交易日必须写进 request_payload');

// Runner 侧读取口径：asOfDate 优先取 targetTradeDate，缺了就先看 targetDate —— 因此
// 上面两个字段缺一个都会退回错误目标日，这里把消费端也钉住。
const financeRunner = read('server/services/companyFinancialIncrementalSync.js');
ok(/asOfDate: options\.targetTradeDate \|\| options\.asOfDate \|\| options\.targetDate/.test(financeRunner),
  '补数 Runner 必须消费 targetTradeDate');
// 执行上下文是白名单构造的：payload 写了不代表 runner 收得到，两处透传必须都在。
const orchestratorSource = read('server/services/jobOrchestrator.js');
ok(/\['CN', 'HK'\]\.includes\(String\(claimed\.request_payload\.market \|\| ''\)\.toUpperCase\(\)\)/.test(orchestratorSource),
  'payload 的市场必须透传进执行上下文');
ok(/claimed\.job_code === 'company_financial_incremental_sync' && targetDate \? \{ targetTradeDate: targetDate \}/.test(orchestratorSource),
  '目标交易日必须透传成 targetTradeDate');

// ---------- 3. R01：PE 缺失但已核实亏损/零，不再判待补 ----------
const rules = require('../domain/stockSelectionRulesV2');
const params = { maxPb: 1.5, maxPbPeProduct: 22.5, r01Channel: 'pb_or_product' };
const annual = { years: [{ year: 2025, profit: 100, dividendKnown: true }] };

const lossNoPe = rules.evaluateValuationV2({
  pb: 3.29, peTtm: null, annual,
  ttmStatus: { status: 'loss', basis: 'computed_ttm' },
}, params);
eq(lossNoPe.valuationStatus, 'FAIL', 'PB>1.5 且已核实亏损、PE 缺失必须判不通过');
eq(lossNoPe.valuationPassReason, 'PE_NON_POSITIVE', '原因必须是 PE_NON_POSITIVE');
eq(lossNoPe.rule.detail, 'pe_unavailable_ttm_non_positive', '必须留下「PE 缺失但利润为负」的证据标记');
eq(lossNoPe.valuationPass, false, '不得放行');

const zeroNoPe = rules.evaluateValuationV2({
  pb: 5.68, peTtm: null, annual,
  ttmStatus: { status: 'zero', basis: 'computed_ttm' },
}, params);
eq(zeroNoPe.valuationStatus, 'FAIL', '已核实零利润同样不是待补');

const unknownNoPe = rules.evaluateValuationV2({
  pb: 3.29, peTtm: null, annual,
  ttmStatus: { status: 'unknown', basis: 'ttm_unavailable' },
}, params);
eq(unknownNoPe.valuationStatus, 'PENDING', '利润口径未知时仍必须待补，不能凭缺失判失败');
eq(unknownNoPe.valuationPassReason, 'PE_PENDING', '待补原因保持 PE_PENDING');

const profitNoPe = rules.evaluateValuationV2({
  pb: 3.29, peTtm: null, annual,
  ttmStatus: { status: 'profit', basis: 'computed_ttm' },
}, params);
eq(profitNoPe.valuationStatus, 'PENDING', '已核实盈利但没有 PE 数值时仍需待补（乘积无法计算）');

// PB≤1.5 的先通过通道不得被本次改动影响。
const lowPbWithLoss = rules.evaluateValuationV2({
  pb: 1.4, peTtm: null, annual,
  ttmStatus: { status: 'loss', basis: 'computed_ttm' },
}, params);
eq(lowPbWithLoss.valuationStatus, 'PASS', 'PB≤1.5 仍按原通道通过，不看 PE');
eq(lowPbWithLoss.valuationPassReason, 'PB_THRESHOLD', '通过原因保持 PB_THRESHOLD');

// PE 有值且非正 + 已核实亏损：保持原判定（不能被本次改动改写）。
const negativePe = rules.evaluateValuationV2({
  pb: 3.29, peTtm: -12, annual,
  ttmStatus: { status: 'loss', basis: 'provider_reported_pe_ttm' },
}, params);
eq(negativePe.valuationStatus, 'FAIL', 'PE≤0 且已核实亏损仍判不通过');
eq(negativePe.rule.detail, undefined, '有 PE 数值时不得套用「缺失」证据标记');

// ---------- 4. 上一交易日解析的真实行为（依赖本地交易日历，缺失则明确跳过） ----------
(async () => {
  const { previousTradingDateOf, resolveScheduleTargetTradeDate } = require('../services/jobScheduleSlots');
  eq(await resolveScheduleTargetTradeDate({ market: 'CN' }, '2026-11-09'), null,
    '未声明策略时不得自行推断目标交易日');
  eq(await resolveScheduleTargetTradeDate({ market: 'CN', targetTradeDate: 'previous_trading_day' }, '2026-11-09').catch(() => null),
    await previousTradingDateOf('CN', '2026-11-09'), '策略解析必须走同一条日历判定');
  eq(await previousTradingDateOf('US', '2026-11-09'), null, '只支持 CN/HK，其它市场直接返回空');

  const { getMarketState } = require('../services/marketState');
  const friday = await getMarketState({ market: 'CN', businessDate: '2026-11-06', time: '00:00' }).catch(() => null);
  if (friday && String(friday.status) === 'open') {
    eq(await previousTradingDateOf('CN', '2026-11-09'), '2026-11-06',
      '周一早上的目标交易日必须是上周五（跳过周末）');
  } else {
    console.log('[SKIP] 本地缺少 2026-11-06 的 CN 交易日历，跳过"周一→上周五"的真库断言');
  }

  console.log(`OK selection-inputs-daily-schedule: ${checks} 项日常按需补排程、目标交易日与 PE 缺失口径通过`);
})().catch(error => {
  console.error(error);
  process.exit(1);
});

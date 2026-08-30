// 收盘日次日（afterTradingDay）调度口径校验
// 背景：强赎公告、下修公告、完整行情等数据在收盘后才产生。若按「交易日当天」在早上跑，
// 周五盘后发布的数据要拖到下周一才同步。改为「收盘日的次日」后，普通周落在周二至周六，
// 节假日落在假期第一天（前一天是最后交易日），假期其余日期与假期后的周一都不执行。
const assert = require('assert');
const { JOB_DEFINITIONS, isSlotDayAllowed, isWeekday, previousDate } = require('../services/jobScheduleSlots');

const failures = [];
function check(ok, message) {
  if (!ok) failures.push(message);
}

const AFTER_TRADING_DAY = { afterTradingDay: true, weekdays: true };
const WEEKDAY_ONLY = { weekdays: true };

// 1. 口径定义：afterTradingDay = 前一天是交易日；weekdays = 当天是交易日
for (const date of ['2026-08-27', '2026-09-01', '2026-09-04']) {
  assert.ok(isWeekday(date), `${date} 应为交易日（用例前置条件）`);
  check(isSlotDayAllowed(date, AFTER_TRADING_DAY) === isWeekday(previousDate(date)),
    `${date}：afterTradingDay 应等于「前一天是交易日」`);
  check(isSlotDayAllowed(date, WEEKDAY_ONLY) === isWeekday(date),
    `${date}：weekdays 应等于「当天是交易日」`);
}

// 2. 普通周（无节假日）：周二至周六执行，周日与周一不执行
for (const [date, expected] of Object.entries({
  '2026-08-29': true,   // 周六，前一天周五有交易
  '2026-08-30': false,  // 周日
  '2026-08-31': false,  // 周一，前一天周日无交易
  '2026-09-01': true,   // 周二
  '2026-09-05': true,   // 周六
})) {
  check(isSlotDayAllowed(date, AFTER_TRADING_DAY) === expected, `${date}：afterTradingDay 期望 ${expected}`);
}

// 3. 同一周内 weekdays 口径保持不变：周一至周五执行、周末不执行
for (const [date, expected] of Object.entries({
  '2026-08-29': false, '2026-08-30': false, '2026-08-31': true, '2026-09-01': true,
})) {
  check(isSlotDayAllowed(date, WEEKDAY_ONLY) === expected, `${date}：weekdays 期望 ${expected}`);
}

// 4. 节假日：只有假期第一天执行，假期其余日期与假期后的周一都不执行
const holidays = require('../config/holidays.json');
const off2026 = (holidays.years && holidays.years['2026']) || [];
assert.ok(off2026.includes('2026-09-25'), '2026-09-25 应为休市日（用例前置条件，休市数据以 holidays.json 为准）');
check(isSlotDayAllowed('2026-09-25', AFTER_TRADING_DAY) === true, '假期第一天应执行（前一天 09-24 有交易）');
check(isSlotDayAllowed('2026-09-26', AFTER_TRADING_DAY) === false, '假期第二天不应执行（前一天放假）');
check(isSlotDayAllowed('2026-09-28', AFTER_TRADING_DAY) === false, '假期后的周一不应执行（前一天周日无交易）');

// 5. 收盘后才产生数据的早上任务必须声明 afterTradingDay
for (const jobCode of [
  'bond_safety_refresh',
  'convertible_bond_announcement_history_sync',
  'convertible_bond_redemption_announcement_sync',
  'convertible_bond_universe_refresh',
  'convertible_bond_valuation_refresh',
]) {
  const def = JOB_DEFINITIONS.find(item => item.jobCode === jobCode);
  check(def && def.afterTradingDay === true, `${jobCode} 应声明 afterTradingDay`);
}

// 6. 收盘后跑的任务维持「交易日当天」口径，不受本次改动影响
for (const jobCode of ['market_close:A股', 'market_close:可转债', 'nav_snapshot', 'ipo_calendar_refresh']) {
  const def = JOB_DEFINITIONS.find(item => item.jobCode === jobCode);
  check(def && def.afterTradingDay !== true, `${jobCode} 不应改为 afterTradingDay`);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} 项 afterTradingDay 调度校验失败`);
  for (const message of failures) console.error('  - ' + message);
  process.exit(1);
}
console.log('OK job-slot-after-trading-day: 收盘日次日口径正确（普通周二至周六、假期仅第一天，weekdays 口径未变）');
process.exit(0);

'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const CoreDate = require('../../public/shared/core-date.js');

const probe = String.raw`
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const fixedInstant = '2026-09-27T17:00:00.000Z';
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...args) { super(...(args.length ? args : [fixedInstant])); }
  static now() { return RealDate.parse(fixedInstant); }
}
global.Date = FixedDate;
const CoreDate = require('./public/shared/core-date.js');
const fxRate = require('./server/services/fxRate.js');
const ledger = require('./server/services/tradeLedger.js');
const businessDayBoundaries = [
  '2026-09-27T15:59:59Z', '2026-09-27T16:00:00Z',
  '2026-09-27T23:59:59Z', '2026-09-28T00:00:00Z',
].map(value => CoreDate.dateTimeInZone(new FixedDate(value), 'Asia/Shanghai'));

const holidayPath = path.join(process.cwd(), 'server/config/holidays.js');
const holidayModule = { exports: {} };
vm.runInNewContext(fs.readFileSync(holidayPath, 'utf8') + '\nmodule.exports.__todayCN = todayCN;', {
  module: holidayModule, exports: holidayModule.exports, require: createRequire(holidayPath),
  __dirname: path.dirname(holidayPath), __filename: holidayPath, process, Date: FixedDate, console,
});

const elements = { 'trade-date': { value: '' }, 'trade-time': { value: '' } };
const document = {
  querySelector() { return null; },
  querySelectorAll() { return []; },
  getElementById(id) { return elements[id] || null; },
  addEventListener() {},
  body: { appendChild() {}, removeChild() {} },
};
const window = {};
const coreTradePath = path.join(process.cwd(), 'public/shared/core-trade.js');
const coreTradeContext = {
  window, document, CoreDate, Date: FixedDate, console, Math, Intl, URL, URLSearchParams,
  setTimeout, clearTimeout, Buffer, process,
};
vm.runInNewContext(fs.readFileSync(coreTradePath, 'utf8') + '\nthis.__tradeDateFns = { nowSec, initTradeDateTime };', coreTradeContext);
coreTradeContext.__tradeDateFns.initTradeDateTime();
const defaultTradeForm = { date: elements['trade-date'].value, time: elements['trade-time'].value };
elements['trade-time'].value = '10:15';
coreTradeContext.__tradeDateFns.initTradeDateTime();

const utilsPath = path.join(process.cwd(), 'public/js/utils.js');
const utilsContext = { window, document, CoreDate, Date: FixedDate, console, Math, Intl, URL, URLSearchParams, process };
vm.runInNewContext(fs.readFileSync(utilsPath, 'utf8') + '\nthis.__todayCN = todayCN;', utilsContext);

const rangeHandlers = {};
const rangeStart = { value: '', addEventListener() {} };
const rangeEnd = { value: '2026-09-28', addEventListener() {} };
const rangeButton = {
  getAttribute(name) { return name === 'data-years' ? '1' : null; },
  addEventListener(name, handler) { rangeHandlers[name] = handler; },
};
const rangeRoot = {
  querySelector(selector) { return selector === '[data-role="start"]' ? rangeStart : rangeEnd; },
  querySelectorAll() { return [rangeButton]; },
};
const rangeWindow = {};
const rangeContext = { window: rangeWindow, CoreDate, Date: FixedDate, Array };
vm.runInNewContext(fs.readFileSync(path.join(process.cwd(), 'public/shared/date-range-control.js'), 'utf8'), rangeContext);
let emittedRange = null;
rangeWindow.DateRangeControl.bind({ querySelector() { return rangeRoot; } }, { id: 'test-range', onChange(value) { emittedRange = value; } });
rangeHandlers.click();
const oneYearRange = { start: rangeStart.value, end: rangeEnd.value, emitted: emittedRange };
rangeEnd.value = '2024-02-29';
rangeHandlers.click();
const leapRangeStart = rangeStart.value;

const stabilityRange = {};
const stabilityElement = { innerHTML: '' };
const chartControl = {
  render(options) { stabilityRange.options = options; return ''; },
  bind() {},
};
const chartWindow = { DateRangeControl: chartControl };
const chartDocument = { getElementById() { return stabilityElement; }, querySelector() { return null; }, body: { appendChild() {} } };
const chartGlobals = {
  window: chartWindow, document: chartDocument, DateRangeControl: chartControl, CoreDate, Date: FixedDate,
  escapeHtml(value) { return String(value); }, stockAnalysisNumber(value) { return String(value); },
  stockAnalysisPercent(value) { return String(value); }, Array, Math, Number, String, Intl,
};
vm.runInNewContext(fs.readFileSync(path.join(process.cwd(), 'public/js/stock-analysis-chart.js'), 'utf8'), chartGlobals);
chartWindow.stockAnalysisRenderStability({ years: [], dividend_history: [] });

console.log(JSON.stringify({
  processTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  businessDayBoundaries,
  fxRateDate: fxRate.cnDate(new FixedDate(fixedInstant)),
  fxRateDateText: fxRate.cnDate('2026-09-25'),
  holidayCacheDate: holidayModule.exports.__todayCN(),
  ledgerTime: ledger.nowStr(),
  utilityBusinessDate: utilsContext.__todayCN(),
  tradeTimestamp: coreTradeContext.__tradeDateFns.nowSec(),
  defaultTradeForm,
  prefilledTradeTimeAfterInitialization: elements['trade-time'].value,
  oneYearRange,
  leapRangeStart,
  stabilityRange: stabilityRange.options,
}));
`;

for (const TZ of ['UTC', 'Asia/Shanghai', 'America/New_York']) {
  const child = spawnSync(process.execPath, ['-e', probe], {
    cwd: path.resolve(__dirname, '..', '..'),
    encoding: 'utf8',
    env: { ...process.env, TZ },
  });
  assert.strictEqual(child.status, 0, child.stderr || `${TZ} 子进程失败`);
  const result = JSON.parse(child.stdout.trim());
  assert.strictEqual(result.processTimeZone, TZ);
  assert.deepStrictEqual(result.businessDayBoundaries, [
    '2026-09-27 23:59:59', '2026-09-28 00:00:00',
    '2026-09-28 07:59:59', '2026-09-28 08:00:00',
  ]);
  assert.strictEqual(result.fxRateDate, '2026-09-28');
  assert.strictEqual(result.fxRateDateText, '2026-09-25');
  assert.strictEqual(result.holidayCacheDate, '2026-09-28');
  assert.strictEqual(result.ledgerTime, '2026-09-28 01:00:00');
  assert.strictEqual(result.utilityBusinessDate, '2026-09-28');
  assert.strictEqual(result.tradeTimestamp, '2026-09-28 01:00:00');
  assert.deepStrictEqual(result.defaultTradeForm, { date: '2026-09-28', time: '01:00' });
  assert.strictEqual(result.prefilledTradeTimeAfterInitialization, '10:15');
  assert.deepStrictEqual(result.oneYearRange, {
    start: '2025-09-28', end: '2026-09-28',
    emitted: { start: '2025-09-28', end: '2026-09-28', activeYears: 1 },
  });
  assert.strictEqual(result.leapRangeStart, '2023-02-28');
  assert.strictEqual(result.stabilityRange.start, '2016-09-28');
  assert.strictEqual(result.stabilityRange.end, '2026-09-28');
}

assert.strictEqual(CoreDate.subtractYears('2026-09-28', 10), '2016-09-28');
assert.strictEqual(CoreDate.subtractYears('2026-09-28', 1), '2025-09-28');

console.log('R2 日期回归通过：汇率、节假日、账本、前端交易时间和图表范围在 UTC/上海/纽约结果一致。');

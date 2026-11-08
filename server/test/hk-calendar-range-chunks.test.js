// 港交所历史日历回补：长区间必须按年分段（2026-11-08）。
// 事故：Tushare hk_tradecal 单次最多返回 2000 行（约 5.5 年），
// 直接传 2016-01-01~2025-12-31 只拿到 2020-07 之后的数据，
// 日历缺档会被 loadPbWindow 误判为「已有日历」，港股十年窗口不可信。
// 只断言源码事实；生产补数与日历行数验收另见发布回执。
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const source = fs.readFileSync(path.join(ROOT, 'server', 'jobs', 'hkTradeCalendarSync.js'), 'utf8');

const tests = [];
function check(name, fn) {
  try { fn(); tests.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (error) { tests.push(['FAIL', name + ' :: ' + error.message]); console.log('  [FAIL] ' + name + ' :: ' + error.message); }
}

check('港股日历抓取按年分段', () => {
  const block = source.match(/async function fetchConfiguredHkCalendar\(fromDate, toDate\) \{[\s\S]*?\n\}/);
  assert.ok(block, '缺少港股日历抓取函数');
  assert.ok(/for \(let year = startYear; year <= endYear; year \+= 1\)/.test(block[0]),
    '必须逐年抓取，不能一次请求整个十年区间');
});

check('分段边界用自然年，首尾沿用调用方日期', () => {
  const block = source.match(/async function fetchConfiguredHkCalendar\(fromDate, toDate\) \{[\s\S]*?\n\}/);
  assert.ok(block);
  assert.ok(/year === startYear \? fromDate : `\$\{year\}-01-01`/.test(block[0]), '中间年份从 1 月 1 日起');
  assert.ok(/year === endYear \? toDate : `\$\{year\}-12-31`/.test(block[0]), '中间年份到 12 月 31 日止');
  assert.ok(/readHkTradingCalendar\(\{ startDate: partStart, endDate: partEnd \}\)/.test(block[0]),
    '每一段都要走统一数据层，不另起第二套请求');
});

check('单段结果经统一归一化后合并', () => {
  const block = source.match(/async function fetchConfiguredHkCalendar\(fromDate, toDate\) \{[\s\S]*?\n\}/);
  assert.ok(block);
  assert.ok(/rows\.push\(\.\.\.normalizeCalendarRows\(part\)\)/.test(block[0]), '分段结果必须归一化后合并');
  assert.ok(/return rows;/.test(block[0]));
});

check('分段原因留在代码里，避免以后被"优化"掉', () => {
  assert.ok(/2000 行/.test(source), '必须记录上游单次返回上限这一事实依据');
});

check('显式日期区间仍由 resolveSyncRange 透传', () => {
  assert.ok(/if \(fromDate \|\| toDate\)/.test(source)
    && /return \{ fromDate: start, toDate: end \};/.test(source),
    '历史回补依赖显式 fromDate/toDate 不被默认当年区间覆盖');
});

const failed = tests.filter(t => t[0] === 'FAIL');
console.log(`\n${tests.length - failed.length}/${tests.length} 通过`);
if (failed.length) process.exitCode = 1;

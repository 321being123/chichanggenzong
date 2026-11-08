// 股票筛选「每周正式 / 每日动态」手动触发回归（2026-11-08）。
// 旧写法把 enqueueSelectionPeriodJob 当三个位置参数调用，而它只收一个解构对象，
// 导致管理员点每日/每周必定返回 400「选股任务暂不可用」，线上永远出不了第一批结果。
// 只断言源码事实，不连数据库。
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const tests = [];
function check(name, fn) {
  try { fn(); tests.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (error) { tests.push(['FAIL', name + ' :: ' + error.message]); console.log('  [FAIL] ' + name + ' :: ' + error.message); }
}

check('周/日入队函数只收一个解构对象', () => {
  const slots = read('server/services/jobScheduleSlots.js');
  assert.ok(/async function enqueueSelectionPeriodJob\(\{ jobCode, payload, requestId \}\)/.test(slots),
    '入队函数签名必须是单个对象参数');
});

check('管理员手动触发用对象参数入队', () => {
  const route = read('server/routes/stockSelection.js');
  assert.ok(/enqueueSelectionPeriodJob\(\{ jobCode: 'stock_analysis_refresh', payload, requestId \}\)/.test(route),
    '路由必须按入队函数的对象签名传参');
  assert.ok(!/enqueueSelectionPeriodJob\('stock_analysis_refresh'/.test(route),
    '旧的三参数写法会让周/日模式必定 400');
});

check('周/日模式仍在管理员白名单且要求周期参数', () => {
  const route = read('server/routes/stockSelection.js');
  assert.ok(/'selection_daily', 'selection_weekly'/.test(route), '每日/每周模式不能被裁掉');
  assert.ok(/periodMode = mode === 'selection_daily' \|\| mode === 'selection_weekly'/.test(route),
    '周期模式判定必须同时覆盖每日与每周');
  assert.ok(/每日\/每周模式必须指定目标日期或周期键/.test(route), '周期模式必须要求明确业务日');
});

const failed = tests.filter(t => t[0] === 'FAIL');
console.log(`\n${tests.length - failed.length}/${tests.length} 通过`);
if (failed.length) process.exitCode = 1;

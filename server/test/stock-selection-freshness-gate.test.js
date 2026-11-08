// 选股周期槽入队必须显式关闭新鲜度门禁（2026-11-08）。
// 事故：首批 daily/weekly 槽报 succeeded，但 result_summary 是 status:'fresh'、datasets:[]，
// 编排器在调用 Runner 之前就 finishManagedRun，零批次产出；只有手动带 freshnessGate:false 才能跑。
// 18:40 周期槽与历史季度手动槽本来就带这个开关，是后台路由和两条自动入队链路漏了。
// 只断言源码事实，不连数据库；线上行为证据另见发布回执（不带额外开关的槽也能执行 Runner）。
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const route = read('server/routes/stockSelection.js');
const refresh = read('server/jobs/stockAnalysisRefresh.js');
const orchestrator = read('server/services/jobOrchestrator.js');
const definitions = read('server/services/jobDefinitions.js');

const tests = [];
function check(name, fn) {
  try { fn(); tests.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (error) { tests.push(['FAIL', name + ' :: ' + error.message]); console.log('  [FAIL] ' + name + ' :: ' + error.message); }
}

check('管理员手动入队带关闭新鲜度门禁', () => {
  const block = route.match(/const payload = \{[\s\S]*?\n    \};/);
  assert.ok(block, '缺少手动入队载荷');
  assert.ok(/freshnessGate: false/.test(block[0]), '后台点每周/每日必须带 freshnessGate:false');
});

check('每日/每周自动入队带关闭新鲜度门禁', () => {
  assert.ok(/const payload = \{ mode, market, targetDate: target\.targetDate, periodKey: target\.periodKey, freshnessGate: false \};/
    .test(refresh), 'enqueueDueSelectionPeriods 入队必须带 freshnessGate:false');
});

check('季度自动入队带关闭新鲜度门禁', () => {
  assert.ok(/mode: 'selection_quarterly', market, quarter: pending\.quarter, freshnessGate: false/
    .test(refresh), 'enqueueDueSelectionQuarters 入队必须带 freshnessGate:false');
});

check('18:40 周期槽调度定义仍按既有约定关闭门禁', () => {
  assert.ok(/mode: 'selection_periodic', afterTradingDay: false, freshnessGate: false/.test(definitions),
    '调度定义原本就带该开关，三条入队链路只是补齐同一约定');
});

check('编排器仍按载荷覆盖主定义，未改判定语义', () => {
  assert.ok(/hasOwnProperty\.call\(claimed\.request_payload, 'freshnessGate'\)/.test(orchestrator),
    '门禁开关仍由 request_payload 决定，不能改成按模式全局跳过');
  assert.ok(/isDataAsOfFresh\(dataAsOf, claimed\.business_date, definition\)/.test(orchestrator),
    '非选股任务的原有新鲜度短路保持不变');
});

check('三条链路合计恰好三处显式开关', () => {
  const hits = (refresh.match(/freshnessGate: false/g) || []).length;
  assert.strictEqual(hits, 2, '自动入队两条链路各一处');
  assert.strictEqual((route.match(/freshnessGate: false/g) || []).length, 1, '后台手动入队一处');
});

const failed = tests.filter(t => t[0] === 'FAIL');
console.log(`\n${tests.length - failed.length}/${tests.length} 通过`);
if (failed.length) process.exitCode = 1;

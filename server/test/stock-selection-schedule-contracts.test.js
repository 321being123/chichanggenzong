// 选股调度、新鲜度门禁与上下文契约合并测试（合并原 stock-selection-freshness-gate / period-enqueue / job-context）。
'use strict';
(async () => {

  // --- stock-selection-freshness-gate.test.js ---
  await (async () => {
// 选股周期槽入队必须显式关闭新鲜度门禁（2026-11-08）。
// 事故：首批 daily/weekly 槽报 succeeded，但 result_summary 是 status:'fresh'、datasets:[]，
// 编排器在调用 Runner 之前就 finishManagedRun，零批次产出；只有手动带 freshnessGate:false 才能跑。
// 18:40 周期槽与历史季度手动槽本来就带这个开关，是后台路由和两条自动入队链路漏了。
// 只断言源码事实，不连数据库；线上行为证据另见发布回执（不带额外开关的槽也能执行 Runner）。
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

  })();

  // --- stock-selection-period-enqueue.test.js ---
  await (async () => {
// 股票筛选「每周正式 / 每日动态」手动触发回归（2026-11-08）。
// 旧写法把 enqueueSelectionPeriodJob 当三个位置参数调用，而它只收一个解构对象，
// 导致管理员点每日/每周必定返回 400「选股任务暂不可用」，线上永远出不了第一批结果。
// 只断言源码事实，不连数据库。
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

  })();

  // --- stock-selection-job-context.test.js ---
  await (async () => {
// 选股任务的执行上下文专项（2026-11-03 线上回归）。
// 线上实证：入队时 request_payload 带了 market，但编排器按白名单构造执行上下文时没带上，
// 结果任务 12 秒被判 selection_market_required 阻断，季度批次永远生成不出来、页面永久空白。
// 本文件锁住"请求参数 → 执行上下文 → 任务入口"这条链，避免再次出现"入队成功、执行必败"。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const tests = [];
async function check(name, fn) {
  try { await fn(); tests.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (error) { tests.push(['FAIL', name + ' :: ' + error.message]); console.log('  [FAIL] ' + name + ' :: ' + error.message); }
}

const orchestrator = require('../services/jobOrchestrator');
const refresh = require('../jobs/stockAnalysisRefresh');

function slotOf(jobCode, payload) {
  return { job_code: jobCode, business_date: '2026-11-02T16:00:00.000Z', request_payload: payload };
}

async function main() {
  await check('季度选股：request_payload 的 market 必须带进执行上下文', () => {
    const context = orchestrator.selectionContextOf(slotOf('stock_analysis_refresh',
      { mode: 'selection_quarterly', market: 'CN', quarter: '2026Q3', requestId: 'sel-cn-1' }));
    assert.strictEqual(context.market, 'CN', '缺 market 时任务会在入口被判 selection_market_required');
    assert.strictEqual(context.quarter, '2026Q3', '管理员指定的季度不能被丢掉');
    assert.strictEqual(context.requestId, 'sel-cn-1', '批次要能按请求编号追溯');
  });

  await check('季度选股：小写市场代码归一化为大写', () => {
    const context = orchestrator.selectionContextOf(slotOf('stock_analysis_refresh',
      { mode: 'selection_quarterly', market: 'hk' }));
    assert.strictEqual(context.market, 'HK');
  });

  await check('季度选股：没有指定季度时不伪造 quarter，交给任务自己推最近已结束季度', () => {
    const context = orchestrator.selectionContextOf(slotOf('stock_analysis_refresh',
      { mode: 'selection_quarterly', market: 'CN' }));
    assert.strictEqual(Object.prototype.hasOwnProperty.call(context, 'quarter'), false);
  });

  await check('预览试算：按管理员指定目标日执行，不能用槽位业务日顶替', () => {
    const context = orchestrator.selectionContextOf(slotOf('stock_analysis_refresh',
      { mode: 'selection_preview', market: 'CN', targetDate: '2026-09-30' }));
    assert.strictEqual(context.targetDate, '2026-09-30');
  });

  await check('补数：selection_inputs 必须同时带 market 与目标交易日', () => {
    const context = orchestrator.selectionContextOf(slotOf('company_financial_incremental_sync',
      { mode: 'selection_inputs', market: 'CN', targetTradeDate: '2026-10-30' }));
    assert.strictEqual(context.market, 'CN', '缺 market 补数无法按市场冻结缺口');
    assert.strictEqual(context.targetTradeDate, '2026-10-30', '缺目标日会把缺口补到错误的一天');
  });

  await check('补数：batchLimit 必须带进上下文，否则静默退回默认 20 只', () => {
    const context = orchestrator.selectionContextOf(slotOf('company_financial_incremental_sync',
      { mode: 'selection_inputs', market: 'CN', targetTradeDate: '2026-10-30', batchLimit: 120 }));
    assert.strictEqual(context.batchLimit, 120, '批次大小丢失会让每批只跑 20 只，吞吐被批间隔拖垮');
    // 非法/缺省时不伪造：交给 syncSelectionInputs 用默认值
    const noLimit = orchestrator.selectionContextOf(slotOf('company_financial_incremental_sync',
      { mode: 'selection_inputs', market: 'CN', targetTradeDate: '2026-10-30', batchLimit: 'abc' }));
    assert.strictEqual(Object.prototype.hasOwnProperty.call(noLimit, 'batchLimit'), false);
  });

  await check('非选股模式：不注入选股字段，原有个股刷新流程不受影响', () => {
    const empty = orchestrator.selectionContextOf(slotOf('stock_analysis_refresh', { mode: 'core' }));
    assert.deepStrictEqual(empty, {});
    const noPayload = orchestrator.selectionContextOf({ job_code: 'stock_analysis_refresh' });
    assert.deepStrictEqual(noPayload, {});
  });

  await check('缺失市场时任务入口确实会阻断（这就是线上失败的原因）', async () => {
    const result = await refresh.runSelectionMode('selection_quarterly', 'test', { mode: 'selection_quarterly' });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'selection_market_required',
      '没有 market 时任务入口必须阻断，因此上下文漏字段就无法生成批次');
  });

  await check('执行上下文真的展开了这套字段（防止函数写了却没接上）', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'jobOrchestrator.js'), 'utf8');
    assert.ok(/\.\.\.selectionContextOf\(claimed\)/.test(source),
      'runContext 必须展开 selectionContextOf(claimed)，否则参数仍进不了任务');
  });

  const failed = tests.filter(item => item[0] === 'FAIL');
  console.log(`\n选股任务上下文：${tests.length - failed.length}/${tests.length} 通过`);
  if (failed.length) {
    failed.forEach(item => console.log('  ' + item[1]));
    process.exitCode = 1;
  }
}

return main();
  })();
})().catch(e => { console.error(e && e.stack ? e.stack : e); process.exitCode = 1; });

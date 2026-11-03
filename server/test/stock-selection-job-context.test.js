// 选股任务的执行上下文专项（2026-11-03 线上回归）。
// 线上实证：入队时 request_payload 带了 market，但编排器按白名单构造执行上下文时没带上，
// 结果任务 12 秒被判 selection_market_required 阻断，季度批次永远生成不出来、页面永久空白。
// 本文件锁住"请求参数 → 执行上下文 → 任务入口"这条链，避免再次出现"入队成功、执行必败"。
'use strict';
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

main().catch(error => { console.error(error); process.exitCode = 1; });

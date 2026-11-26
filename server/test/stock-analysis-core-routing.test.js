'use strict';

// INC-0054 第一阶段回归：core 模式（个股刷新）只能处理 A 股普通股。
// 事故现场：17:29 的 core 运行 11 只成功、21 只港股失败，任务落 failed——
// 混合跟踪列表被整批送进只支持 A 股的取数逻辑，港股并没有走它自己的 stock_analysis_hk 模式。
const assert = require('assert');
const { partitionCoreTargets } = require('../jobs/stockAnalysisRefresh');

function run() {
  const stocks = [
    { ts_code: '600519.SH' },
    { ts_code: '000001.SZ' },
    { ts_code: '00700.HK' },
    { ts_code: '09988.HK' },
  ];
  const { core, routed } = partitionCoreTargets(stocks);
  assert.deepStrictEqual(core.map(item => item.ts_code), ['600519.SH', '000001.SZ'],
    'core 模式不得把港股送进只支持 A 股的取数逻辑');
  assert.deepStrictEqual(routed, [
    { code: '00700.HK', reason: 'routed_to_stock_analysis_hk' },
    { code: '09988.HK', reason: 'routed_to_stock_analysis_hk' },
  ], '被分流的港股必须带原因返回，对象集才可审计（不能静默消失）');

  // 只有港股时 core 目标为空（交给港股模式），而不是报失败
  const hkOnly = partitionCoreTargets([{ ts_code: '00005.HK' }]);
  assert.strictEqual(hkOnly.core.length, 0, '全是港股时 core 目标必须为空');
  assert.strictEqual(hkOnly.routed.length, 1, '全是港股时全部记入分流');

  // 小写后缀、空对象、非数组输入都不能误判或抛错
  assert.strictEqual(partitionCoreTargets([{ ts_code: '00700.hk' }]).core.length, 0, '后缀大小写不敏感');
  assert.strictEqual(partitionCoreTargets([null, {}, { ts_code: '600000.SH' }]).core.length, 3, '缺代码的对象不得被当成港股剔除');
  assert.deepStrictEqual(partitionCoreTargets(null), { core: [], routed: [] }, '非数组输入必须安全返回空集');

  console.log('core 模式港股分流（routed_to_stock_analysis_hk）验证通过');
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}

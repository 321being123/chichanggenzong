// 线上实证（2026-11-10～11-14）：固化股票池名单与最新主档不一致时，
// universe_drift 成为选股唯一的质量阻断项，日/周选股永远判 partial/insufficient_data，
// 后台槽一直等 24 小时后报「续批止损」严重告警，每个交易日重复。
// 本文件锁住：只放行生产/预览发布路径，回测与 G0 审计仍按原口径严格阻断。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const { shouldBlockUniverseDrift } = require('../services/stockSelectionService');

let checks = 0;
const eq = (actual, expected, message) => { assert.strictEqual(actual, expected, message); checks += 1; };
const ok = (condition, message) => { assert.ok(condition, message); checks += 1; };

const drift = { missing: [1], added: [2], rosterHash: 'probe' };

// 1. 回测 / G0 审计（默认不传标志）仍严格阻断，历史名单不被今天的主档替换。
eq(shouldBlockUniverseDrift(drift, undefined), true, '默认必须按历史口径阻断名单漂移');
eq(shouldBlockUniverseDrift(drift, false), true, '显式 false 仍阻断');
// 2. 生产发布路径放行，否则同一目标日一旦名单变化就永远发不出结果。
eq(shouldBlockUniverseDrift(drift, true), false, '生产发布路径不得被名单漂移永久阻断');
// 3. 无漂移时两条路径都不产生阻断。
eq(shouldBlockUniverseDrift(null, undefined), false, '无漂移默认不阻断');
eq(shouldBlockUniverseDrift(null, true), false, '无漂移放行也保持不阻断');

// 4. 接线守卫：判定与放行必须真的连到实现，不能只留一个没被调用的纯函数。
const service = read('server/services/stockSelectionService.js');
ok(/shouldBlockUniverseDrift\(universeLoad\.evidence\.drift, input\.allowUniverseDrift\)/.test(service),
  '质量裁决必须调用该判定');
ok(/computeSelection\(Object\.assign\(\{\}, input, \{ allowUniverseDrift: true \}\), tx\)/.test(service),
  'computeAndPersist 发布路径必须显式放行');
ok(/function shouldBlockUniverseDrift\(drift, allowUniverseDrift\)/.test(service),
  '判定必须是同一个函数，不得在多处另写一份');
ok(!/allowUniverseDrift/.test(read('server/services/stockSelectionBacktest.js')),
  '回测不得放行名单漂移');
ok(!/allowUniverseDrift/.test(read('server/scripts/stockSelectionG0Audit.js')),
  'G0 审计不得放行名单漂移');

console.log(`名单漂移发布回归 ${checks} 项通过`);

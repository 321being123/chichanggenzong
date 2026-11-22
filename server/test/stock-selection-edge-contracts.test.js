// 选股边界契约合并测试（合并原 selection-inputs-delisted-gap / selection-universe-drift-release / stock-selection-empty-universe）。
'use strict';
(async () => {

  // --- selection-inputs-delisted-gap.test.js ---
  await (async () => {
// 生产实证（2026-11-13）：A 股缺口队列里唯一一条是 301139.SZ「元道退」——
// 主档 status 仍写 listed、delist_date 为空，但交易所简称已改成「元道退」，行情停在
// 退市日，行业源不会再返回它的分类。旧逻辑把 industry_unverified 当待补缺口，
// 补两次没进展就锁死 08:40 补数槽。港股那 4 只经核查不是退市，不在本次范围。
// 本文件锁住：已退市证券不进缺口队列、不去取数，正常证券与港股不受影响。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const { isDelistedSecurityName } = require('../services/stockSelectionService');

let checks = 0;
const eq = (actual, expected, message) => { assert.strictEqual(actual, expected, message); checks += 1; };
const ok = (condition, message) => { assert.ok(condition, message); checks += 1; };

// 1. 生产上实际存在的三种退市简称，只靠本地名称即可核验，不抓行情。
eq(isDelistedSecurityName('元道退'), true, '「XX退」必须判为已退市');
eq(isDelistedSecurityName('退市锦港'), true, '「退市XX」必须判为已退市');
eq(isDelistedSecurityName('摘牌蓝保'), true, '「摘牌XX」必须判为已退市');
eq(isDelistedSecurityName(' 元道退 '), true, '名称带空格也要识别');
// 2. 正常证券与港股一律不得误伤。
eq(isDelistedSecurityName('贵州茅台'), false, '正常 A 股不得被排除');
eq(isDelistedSecurityName('微创医疗'), false, '港股微创系经核查不是退市');
eq(isDelistedSecurityName('微创机器人-B'), false, '港股带后缀名称不受影响');
eq(isDelistedSecurityName('退避三舍'), false, '名称含「退」但不是退市标记不得误判');
eq(isDelistedSecurityName(''), false, '空名称不得误判');
eq(isDelistedSecurityName(null), false, '无名称不得抛错');

const service = read('server/services/stockSelectionService.js');
const pureFn = service.match(/function isDelistedSecurityName\([\s\S]*?\n\}/);

// 3. 接线守卫：过滤必须真的落在缺口审计上，并留下可查证据。
ok(/const excludedDelisted = \[\]/.test(service), '审计必须收集被排除的退市标的');
ok(/if \(isDelistedSecurityName\(item\.name\)\) \{/.test(service), '缺口审计必须调用退市判定');
ok(/excludedDelisted\.push\(\{ code: item\.code, name: item\.name \}\)/.test(service), '被排除标的必须留痕');
ok(/^\s+excludedDelisted,$/m.test(service) && /return \{ queueId[^}]*excludedDelisted/.test(service),
  '留痕必须同时写入队列快照与返回结果');
ok(/gaps\.push\(/.test(service), '正常证券的缺口仍必须保留，不能一起放行');
ok(pureFn && !/fetch|axios|http|dataAccess|require\(/.test(pureFn[0]),
  '判定只能是本地纯函数，不得触发外部取数');
ok(!/00823\.HK|00853\.HK|02172\.HK|02252\.HK/.test(service),
  '港股缺口不得被硬编码排除（它们不是退市）');

console.log(`退市股不进取数队列回归 ${checks} 项通过`);

  })();

  // --- selection-universe-drift-release.test.js ---
  await (async () => {
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

  })();

  // --- stock-selection-empty-universe.test.js ---
  await (async () => {
// 空候选池回归（2026-11-05 生产补数中断）：港股目标池主档的交易所字段是历史脏数据，
// loadUniverse 返回空时 computeSelection 提前返回却缺 evaluated，auditInputs 遍历即抛
// "Cannot read properties of undefined (reading 'forEach')"，整批补数被打成 failed。
// 本用例不连数据库、不调外部接口，只固定「空池返回契约」与「缺口审计不崩」两件事。
const assert = require('assert');

const tests = [];
async function check(name, fn) {
  try { await fn(); tests.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (error) {
    tests.push(['FAIL', name + ' :: ' + error.message]);
    console.log('  [FAIL] ' + name + ' :: ' + error.message);
  }
}

const REPO = '../repositories/stockSelectionRepository';
const SERVICE = '../services/stockSelectionService';

function stub(relativePath, exports) {
  const resolved = require.resolve(relativePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

function serviceWithEmptyUniverse() {
  stub(REPO, {
    loadMarketValuation: async () => ({}),
    loadUniverse: async () => [],
    loadUniverseRoster: async () => [],
    // V2 新增依赖：空池时不会写 artifact，但服务仍会先查一次历史池。
    findUniverseArtifact: async () => null,
    insertUniverseArtifact: async () => 1,
    loadTtmInputs: async () => new Map(),
    saveInputGapQueue: async () => 1,
  });
  const servicePath = require.resolve(SERVICE);
  delete require.cache[servicePath];
  return require(SERVICE);
}

async function main() {
  await check('空候选池时 computeSelection 仍返回 evaluated / anomalyById 契约', async () => {
    const service = serviceWithEmptyUniverse();
    const computed = await service.computeSelection({ market: 'HK', asOfDate: '2026-09-30' });
    assert.deepStrictEqual(computed.evaluated, []);
    assert.deepStrictEqual(computed.anomalyById, {});
    assert.strictEqual(computed.quality.reason, 'universe_empty');
  });

  await check('空候选池时 auditInputs 不抛错，返回零缺口并保存队列', async () => {
    const service = serviceWithEmptyUniverse();
    const audit = await service.auditInputs({ market: 'HK', asOfDate: '2026-09-30' });
    assert.strictEqual(audit.gapCount, 0);
    assert.deepStrictEqual(audit.gaps, []);
    assert.strictEqual(audit.coverage.universeCount, 0);
  });

  await check('港股候选池按市场纳入，不再被交易所脏值清空', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'repositories', 'stockSelectionRepository.js'), 'utf8');
    assert.match(source, /AND \(i\.market = 'HK' OR i\.exchange_code = ANY\(\$3::text\[\]\)\)/);
  });

  const failed = tests.filter(item => item[0] === 'FAIL');
  console.log(`\nstock-selection-empty-universe: ${tests.length - failed.length}/${tests.length} 通过`);
  if (failed.length) process.exitCode = 1;
}

return main();
  })();
})().catch(e => { console.error(e && e.stack ? e.stack : e); process.exitCode = 1; });

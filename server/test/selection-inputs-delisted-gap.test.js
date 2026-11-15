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

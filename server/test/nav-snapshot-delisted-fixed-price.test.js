// 退市债（搜特退债 404002）没有后续行情，价格固定为持仓里保留的最后退市价。
// 净值归因早已按此口径处理并记 manualPriceCodes；净值快照却仍把「目标日没有 daily_prices」
// 当成缺口，连续 3 次失败后熔断整日净值数据集并刷告警。
// 本文件锁住：快照复用同一固定价口径、不抓行情、普通证券缺行情仍严格算缺口。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const { fixedDelistedPrice } = require('../jobs/navSnapshot');

let checks = 0;
const eq = (actual, expected, message) => { assert.strictEqual(actual, expected, message); checks += 1; };
const ok = (condition, message) => { assert.ok(condition, message); checks += 1; };

const account = (positions, positionSnapshots = [], trades = []) => ({ positions, positionSnapshots, trades });
const fallback = (code, name) => ({ code, name });

// 1. 退市债取持仓里已固定的最后退市价，不需要也不允许再去抓行情。
eq(fixedDelistedPrice(
  account([{ code: '404002', name: '搜特退债', price: 2.362, quantity: 1000 }]),
  '404002', fallback('404002', '搜特退债')), 2.362, '搜特退债必须直接用持仓里的最后退市价');
// 2. 普通证券即使持仓有价，也不得被当成固定退市价放行。
eq(fixedDelistedPrice(
  account([{ code: '600519', name: '贵州茅台', price: 1800 }]),
  '600519', fallback('600519', '贵州茅台')), null, '普通证券缺行情仍必须算缺口');
// 3. 退市债但账户里没有留下任何价格 → 仍算缺口，不猜价格、不填零。
eq(fixedDelistedPrice(account([]), '404002', fallback('404002', '搜特退债')), null,
  '没有固定价证据时不得凭代码放行');
// 4. 同类：名称明确为退债的其他标的按同一口径。
eq(fixedDelistedPrice(
  account([{ code: '128044', name: '岭南退债', price: 71.37 }]),
  '128044', fallback('128044', '岭南退债')), 71.37, '名称明确的退市债同样用固定价');
// 5. 已清仓时最后一笔成交价仍可作为同一固定价兜底。
eq(fixedDelistedPrice(
  account([], [], [{ code: '404002', name: '搜特退债', price: 2.362 }]),
  '404002', fallback('404002', '搜特退债')), 2.362, '清仓后仍可用最后成交价');

const snapshot = read('server/jobs/navSnapshot.js');
const attribution = read('server/services/navAttribution.js');
const fixedFn = snapshot.match(/function fixedDelistedPrice\([\s\S]*?\n\}/);

// 6. 接线守卫：改动必须真的落在「取不到行情」这条分支上。
ok(/const fixed = fixedDelistedPrice\(data, code, \{ code, name: info\.name \}\)/.test(snapshot),
  '取不到行情时必须尝试固定退市价');
ok(/price = \{ price: fixed, date: null \}/.test(snapshot), '固定价不得伪造行情日期');
ok(/fixedDelistedCodes\.add\(code\)/.test(snapshot), '使用固定价必须留痕');
ok(/fixedDelistedPriceCodes: \[\.\.\.fixedDelistedCodes\]/.test(snapshot), '留痕必须随结果返回可查');
ok(/missingCodes\.push/.test(snapshot), '普通证券缺行情仍必须记缺口，不能被一起放行');
ok(!/404002/.test(snapshot), '快照不得自己复制一份退市债代码判定');
ok(/module\.exports = \{[^}]*manualDelistedPrice/.test(attribution), '必须复用归因模块的同一取价口径');
ok(fixedFn && /manualDelistedPrice/.test(fixedFn[0]), '固定价函数必须调用归因模块现成实现');
ok(fixedFn && !/fetch|axios|http|dataAccess|marketDatasets/.test(fixedFn[0]),
  '固定价只能读本地账户数据，不得触发任何外部行情采集');

console.log(`退市债固定价口径回归 ${checks} 项通过`);

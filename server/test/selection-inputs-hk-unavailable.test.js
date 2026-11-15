// 港股目标池里两类「客观补不到」的标的（生产实证 2026-11-15）：
// ①00823.HK 领展房产基金是恒生成分里的 REIT，主档只收股票、根本没有这只；
// ②00853/02172/02252 微创系自 2026-09-01 起集体停牌，行情齐刷刷停在 8-31。
// 旧逻辑把它们算进 remainingTargetPool，补两次没进展就锁死 08:45 补数槽。
// 本文件锁住：只排除这两类、新股仍保留、排除清单留证、批后复核用同一份收敛清单。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const { classifyUnavailableHkCodes } = require('../services/stockSelectionInputsSync');

let checks = 0;
const eq = (actual, expected, message) => { assert.strictEqual(actual, expected, message); checks += 1; };
const ok = (condition, message) => { assert.ok(condition, message); checks += 1; };

const metaByCode = new Map([
  ['00853.HK', { instrument_id: 1 }],
  ['02172.HK', { instrument_id: 2 }],
  ['02252.HK', { instrument_id: 3 }],
  ['09999.HK', { instrument_id: 4 }],
]);

// 1. 主档缺失（REIT）与长期停牌的老股都被排除，且排除原因可查。
const result = classifyUnavailableHkCodes({
  pending: ['00823.HK', '00853.HK', '02172.HK', '02252.HK', '09999.HK'],
  metaByCode,
  everTraded: new Set(['00853.HK', '02172.HK', '02252.HK']),
});
assert.deepStrictEqual(result.eligible, ['09999.HK'], '只有从未有过行情的新股仍应待补');
assert.deepStrictEqual(result.excluded, [
  { code: '00823.HK', reason: 'instrument_missing' },
  { code: '00853.HK', reason: 'no_recent_bars_suspended_or_delisted' },
  { code: '02172.HK', reason: 'no_recent_bars_suspended_or_delisted' },
  { code: '02252.HK', reason: 'no_recent_bars_suspended_or_delisted' },
], '排除清单必须逐条留证');
checks += 2;

// 2. 从未有过行情、主档存在的新上市标的不得被当成不可补。
const onlyNew = classifyUnavailableHkCodes({ pending: ['09999.HK'], metaByCode, everTraded: new Set() });
eq(onlyNew.eligible.length, 1, '新股缺口必须保留，不能把缺口伪装成完成');
eq(onlyNew.excluded.length, 0, '新股不得被排除');
// 3. 空队列、缺参数都不抛错。
const empty = classifyUnavailableHkCodes({ pending: [], metaByCode: new Map(), everTraded: new Set() });
eq(empty.eligible.length, 0, '空队列返回空结果');
eq(classifyUnavailableHkCodes({}).excluded.length, 0, '缺参数不得抛错');

const source = read('server/services/stockSelectionInputsSync.js');
const pureFn = source.match(/function classifyUnavailableHkCodes\([\s\S]*?\n\}/);

// 4. 接线守卫：分类真的用在目标池上，且下游批后复核拿到的是同一份收敛清单。
ok(/classifyUnavailableHkCodes\(\{ pending, metaByCode, everTraded \}\)/.test(source),
  '目标池必须调用该分类');
ok(/days: 3650/.test(source), '必须用全历史行情区分「停牌老股」与「从没交易过的新股」');
ok(/const eligibleCodes = codes\.filter\(code => !excludedCodes\.has\(code\)\)/.test(source),
  '目标池代码必须收敛，不能批前排除、批后又算回来');
ok(/codes: eligibleCodes/.test(source), '返回值必须给下游批后复核同一份收敛清单');
ok(/excludedUnavailable/.test(source), '排除清单必须随结果返回可查');
ok(/auditHkTargetPoolAfterBatch\(targetPool, asOfDate\)/.test(source),
  '批后复核仍按目标池清单取数');
ok(pureFn && !/fetch|axios|http|dataAccess|readStockDailySeries|repo\./.test(pureFn[0]),
  '分类只能是纯判定，不得触发外部取数或查库');

console.log(`港股目标池不可补标的回归 ${checks} 项通过`);

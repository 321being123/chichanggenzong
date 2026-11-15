// ========== 收盘价漏记(P0-3) + 调度时区(P0-4) 回归测试 ==========
// 运行：node server/test/marketclose.test.js
// 说明：核心判定 pickMissingCodes 与时间zone 辅助函数均为纯函数，无需数据库/网络即可回归。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const mc = require('../jobs/marketClose');
const { historicalKindFor } = require('../jobs/replayNav');

const results = [];
function check(name, fn) {
  try { fn(); results.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (e) { results.push(['FAIL', name + ' :: ' + e.message]); console.log('  [FAIL] ' + name + ' :: ' + e.message); }
}

// 与 MARKET_CLOSE_TIMES 一致的代码前缀判定（测试内镜像，避免耦合内部配置）
const isA = c => /^(00|30|60|68|[48])/.test(c);
const isBond = c => /^(11|12)/.test(c);
const isETF = c => /^(5|15|16|17|180|181|184)/.test(c) && c.length === 6;

const pos = (code, name) => ({ code, name: name || code });

console.log('A. pickMissingCodes —— P0-3 核心：按代码幂等，不因子账户任一条记录而整市场跳过');
check('仅 A 股账户：全部缺失代码被挑出', () => {
  const p = [pos('600000'), pos('000001'), pos('300750')];
  const got = mc.pickMissingCodes(p, new Set(), isA);
  assert.deepStrictEqual(got.sort(), ['000001', '300750', '600000']);
});
check('仅可转债账户：可转债代码被挑出', () => {
  const p = [pos('113000'), pos('123456')];
  const got = mc.pickMissingCodes(p, new Set(), isBond);
  assert.deepStrictEqual(got.sort(), ['113000', '123456']);
});
check('混合账户(A股+可转债+ETF)：A股已写不影响可转债/ETF', () => {
  // 已有 600000（A股）一条记录
  const existing = new Set(['600000']);
  const p = [pos('600000'), pos('113000'), pos('510300')];
  // 可转债视角：113000 缺失 -> 必须被挑出（旧逻辑会因 600000 存在而整市场跳过）
  assert.deepStrictEqual(mc.pickMissingCodes(p, existing, isBond), ['113000']);
  // ETF 视角：510300 缺失 -> 必须被挑出
  assert.deepStrictEqual(mc.pickMissingCodes(p, existing, isETF), ['510300']);
  // A股视角：600000 已存在 -> 不挑
  assert.deepStrictEqual(mc.pickMissingCodes(p, existing, isA), []);
});
check('部分代码缺失：只挑缺失项', () => {
  const p = [pos('600000'), pos('600001'), pos('600002')];
  const existing = new Set(['600000', '600002']);
  assert.deepStrictEqual(mc.pickMissingCodes(p, existing, isA), ['600001']);
});
check('某市场无任何持仓：返回空', () => {
  const p = [pos('600000')];
  assert.deepStrictEqual(mc.pickMissingCodes(p, new Set(), isBond), []);
});
check('已有代码集合为空且持仓为空：返回空', () => {
  assert.deepStrictEqual(mc.pickMissingCodes([], new Set(), isA), []);
});
check('共享行情缺失时支持按代码读取后续补取结果', () => {
  const quoteMap = new Map([['sz160719', { code: '160719', price: 1.9, quote_time: '2026-09-02T15:14:00+08:00' }]]);
  assert.strictEqual(mc.quoteForCode(quoteMap, '160719'), null, '腾讯映射键应使用统一代码或代码.市场，不应误认供应商 symbol');
  quoteMap.set('160719', { code: '160719', price: 1.9, quote_time: '2026-09-02T15:14:00+08:00' });
  assert.strictEqual(mc.isUsableQuote(mc.quoteForCode(quoteMap, '160719'), '2026-09-02'), true);
  assert.strictEqual(mc.isUsableQuote({ code: '160719', price: 1.9, quote_time: '2026-09-01T15:14:00+08:00' }, '2026-09-02'), false);
  mc.mergeQuoteMaps(quoteMap, new Map([['160719.SZ', { code: '160719', price: 1.91 }]]));
  assert.strictEqual(quoteMap.get('160719.SZ').price, 1.91);
});
check('批量行情缺失只允许一次有界补取，不能重复检查同一份空 Map', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'jobs', 'marketClose.js'), 'utf8')
    + fs.readFileSync(path.join(__dirname, '..', 'repositories', 'marketCloseRepository.js'), 'utf8');
  assert.ok(source.includes('refreshMissingQuotes'), '收盘任务必须有缺失代码补取入口');
  assert.ok(source.includes('force: true'), '缺失代码补取必须强制刷新腾讯缓存');
  assert.ok(source.includes('const refreshAttempted = new Set()'), '补取必须按代码去重并限制在本次任务一次');
  assert.ok(source.includes('getExternalCallStats().total'), '任务外部调用数必须来自统一 Guard 实际计数');
});
check('非标准证券显式进入覆盖检查，不再静默漏掉', () => {
  assert.strictEqual(mc.isUncoveredPosition('404002', { name: '搜特退债', quantity: 1000 }), true);
  assert.strictEqual(mc.isUncoveredPosition('600000', { name: '浦发银行', quantity: 1000 }), false);
  assert.strictEqual(mc.isUncoveredPosition('404002', { name: '搜特退债', quantity: 0 }), false);
});
check('历史回补按证券类型路由，禁止统一走股票日线', () => {
  // 2026-10-31 数据层收口：改判业务类型（供应商接口名在数据层内决定）。
  assert.strictEqual(historicalKindFor('00762', { subtype: '港股' }), 'hk_stock');
  assert.strictEqual(historicalKindFor('113575', { subtype: '可转债' }), 'bond');
  assert.strictEqual(historicalKindFor('510900', { subtype: '基金/ETF' }), 'fund');
  assert.strictEqual(historicalKindFor('600000', { subtype: '沪市' }), 'stock');
});

console.log('B. 时区辅助函数 —— P0-4：显式东八区，不受容器本地时区影响');
check('fmtCN 在 UTC 凌晨算北京时间日期（跨日正确）', () => {
  // 2026-07-16T16:00:00Z = 北京时间 2026-07-17 00:00
  assert.strictEqual(mc.fmtCN('2026-07-16T16:00:00Z'), '2026-07-17');
  // 2026-07-16T15:00:00Z = 北京时间 2026-07-16 23:00
  assert.strictEqual(mc.fmtCN('2026-07-16T15:00:00Z'), '2026-07-16');
});
check('cnWeekday 返回北京时间星期几', () => {
  // 2026-07-16 是周四(4)
  assert.strictEqual(mc.cnWeekday('2026-07-16T01:00:00Z'), 4);
  // 2026-07-19 是周日(0)
  assert.strictEqual(mc.cnWeekday('2026-07-19T01:00:00Z'), 0);
});
check('msUntil 落点固定为北京时间 h:m（不受主机时区影响）', () => {
  for (const [h, m] of [[15, 10], [16, 10]]) {
    const now = new Date();
    const ms = mc.msUntil(h, m, now);
    assert.ok(ms > 0 && ms < 48 * 3600 * 1000, `msUntil(${h},${m}) 区间异常: ${ms}`);
    const at = new Date(now.getTime() + ms);
    const beijing = new Date(at.getTime() + 8 * 3600 * 1000);
    assert.strictEqual(beijing.getUTCHours(), h, `落点小时应为 ${h}`);
    assert.strictEqual(beijing.getUTCMinutes(), m, `落点分钟应为 ${m}`);
  }
});

console.log('C. 收盘确认准入 —— 报价必须是当日且不早于收市时刻');
const closedCN = { status: 'open', isAfterMarketClose: true, closeTime: '15:00' };
const quoteAt = (date, time) => `${date}T${time}:00+08:00`;
check('已收盘 + 收盘后报价 -> 已确认终盘', () => {
  const q = mc.qualifyCloseQuote(closedCN, quoteAt('2026-09-24', '15:00'), '2026-09-24', '15:00');
  assert.strictEqual(q.quality, 'confirmed');
  assert.strictEqual(q.isFinal, true);
  assert.strictEqual(q.reason, null);
});
check('已收盘但拿到当天上午报价 -> 只能候选，不得写成终盘', () => {
  const q = mc.qualifyCloseQuote(closedCN, quoteAt('2026-09-24', '10:05'), '2026-09-24', '15:00');
  assert.strictEqual(q.quality, 'candidate', '上午报价在收盘任务里仍可能被拿到，不能当终盘');
  assert.strictEqual(q.isFinal, null);
  assert.strictEqual(q.reason, 'quote_before_close');
});
check('缺少报价时刻 -> 不能确认为终盘', () => {
  const q = mc.qualifyCloseQuote(closedCN, null, '2026-09-24', '15:00');
  assert.strictEqual(q.quality, 'candidate');
  assert.strictEqual(q.reason, 'quote_time_missing');
});
check('报价不属于目标交易日 -> 不能确认为终盘', () => {
  const q = mc.qualifyCloseQuote(closedCN, quoteAt('2026-09-23', '15:00'), '2026-09-24', '15:00');
  assert.strictEqual(q.quality, 'candidate');
  assert.strictEqual(q.reason, 'quote_not_same_day');
});
check('市场未过收市时刻 -> 不能确认为终盘', () => {
  const q = mc.qualifyCloseQuote({ status: 'open', isAfterMarketClose: false, closeTime: '15:00' },
    quoteAt('2026-09-24', '15:00'), '2026-09-24', '15:00');
  assert.strictEqual(q.quality, 'candidate');
  assert.strictEqual(q.reason, 'market_not_closed');
});
check('已有候选价不阻止收盘升级：只有已确认记录才算已处理', () => {
  const codes = mc.confirmedExistingCodes([
    { code: '600000', quality: 'candidate', is_final: null },
    { code: '600519', quality: 'legacy_unverified', is_final: null },
    { code: '000001', quality: 'confirmed', is_final: true },
  ]);
  assert.deepStrictEqual([...codes], ['000001'], '候选与遗留价必须留在待升级集合里');
});

console.log('D. 历史补漏授权门禁 —— 缺行补齐可直接写，改写存量历史日价必须显式授权');
check('没有既有记录 -> 直接补齐', () => {
  const plan = mc.splitHistoricalBackfill(['600000', '000001'], new Set(), false);
  assert.deepStrictEqual(plan.writable, ['600000', '000001']);
  assert.deepStrictEqual(plan.blocked, []);
});
check('已有未核验存量行 -> 默认不改写，计入待授权', () => {
  const plan = mc.splitHistoricalBackfill(['600000', '000001'], new Set(['600000']), false);
  assert.deepStrictEqual(plan.writable, ['000001'], '只有缺行的那只可以补写');
  assert.deepStrictEqual(plan.blocked, ['600000'], '存量历史日价必须留待授权');
});
check('显式授权后允许修订存量历史日价', () => {
  const plan = mc.splitHistoricalBackfill(['600000'], new Set(['600000']), true);
  assert.deepStrictEqual(plan.writable, ['600000']);
  assert.deepStrictEqual(plan.blocked, []);
});

const failed = results.filter(r => r[0] === 'FAIL');
console.log('\n========================================');
console.log(`P0-3/P0-4 回归：共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
if (failed.length) {
  console.log('失败项：'); failed.forEach(f => console.log('  - ' + f[1]));
  process.exit(1);
}
console.log('全部通过 ✅');

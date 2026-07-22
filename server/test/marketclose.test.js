// ========== 收盘价漏记(P0-3) + 调度时区(P0-4) 回归测试 ==========
// 运行：node server/test/marketclose.test.js
// 说明：核心判定 pickMissingCodes 与时间zone 辅助函数均为纯函数，无需数据库/网络即可回归。
const assert = require('assert');
const mc = require('../jobs/marketClose');

const results = [];
function check(name, fn) {
  try { fn(); results.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (e) { results.push(['FAIL', name + ' :: ' + e.message]); console.log('  [FAIL] ' + name + ' :: ' + e.message); }
}

// 与 MARKET_CLOSE_TIMES 一致的代码前缀判定（测试内镜像，避免耦合内部配置）
const isA = c => /^(00|30|60|68|[48])/.test(c);
const isBond = c => /^(11|12)/.test(c);
const isETF = c => /^(15|16|50|51)/.test(c) && c.length === 6;

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

const failed = results.filter(r => r[0] === 'FAIL');
console.log('\n========================================');
console.log(`P0-3/P0-4 回归：共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
if (failed.length) {
  console.log('失败项：'); failed.forEach(f => console.log('  - ' + f[1]));
  process.exit(1);
}
console.log('全部通过 ✅');

// ========== nav-math.js 回归测试（单一真相源：净值公式 + 投入本金）==========
// 运行：node server/test/nav-math.test.js
// 目的：合并后所有净值计算都走这一份，必须与原内联公式完全一致，且边界安全。
const assert = require('assert');
const path = require('path');

const { investedAt, chainNav } = require('../../public/shared/nav-math.js');

const results = [];
function check(name, fn) {
  try { fn(); results.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (e) { results.push(['FAIL', name + ' :: ' + e.message]); console.log('  [FAIL] ' + name + ' :: ' + e.message); }
}

// 原始内联公式（合并前 core-earnings / core-returns / navSnapshot / replayNav 里的写法）
function inlineChainNav(prevNav, prevTotal, newTotal, pcf) {
  const base = (prevTotal || 0) + (pcf || 0);
  if (base <= 0) return prevNav;
  return prevNav * (newTotal / base);
}

console.log('A. chainNav 与原内联公式逐字节等价（矩阵）');
check('正常区间矩阵等价', () => {
  const cases = [
    [1.0, 100, 110, 0],
    [1.05, 200, 180, 10],
    [0.98, 150.5, 160.2, -5.5],
    [1.234567, 99.99, 101.01, 3.33],
    [2.0, 1000, 1000, 0],
    [1.0, 50, 75, 25],
  ];
  cases.forEach(([pv, pt, nt, pcf]) => {
    assert.strictEqual(chainNav(pv, pt, nt, pcf), inlineChainNav(pv, pt, nt, pcf),
      `chainNav(${pv},${pt},${nt},${pcf}) 与原公式不等`);
  });
});

console.log('B. chainNav 除零/基准非正守卫（返回 prevNav，不崩）');
check('prevTotal=0,pcf=0 -> 返回 prevNav', () => {
  assert.strictEqual(chainNav(1.5, 0, 110, 0), 1.5);
});
check('基准为负 -> 返回 prevNav', () => {
  assert.strictEqual(chainNav(1.2, 100, 90, -200), 1.2);
});
check('newTotal=0 正常算（非守卫路径）', () => {
  assert.strictEqual(chainNav(1.0, 100, 0, 0), 0);
});

console.log('C. investedAt 三分支');
// 分支1：完全没有导入数据
check('无导入数据 -> 期初本金 + 截至当日累计出入金', () => {
  const navs = [];
  const cfs = [
    { date: '2026-01-01', amount: 100 },
    { date: '2026-01-10', amount: 50 },
    { date: '2026-02-01', amount: -30 },
  ];
  assert.strictEqual(investedAt(navs, cfs, 1000, '2026-01-15'), 1000 + 100 + 50); // 1120
  assert.strictEqual(investedAt(navs, cfs, 1000, '2026-03-01'), 1000 + 100 + 50 - 30); // 1120
  assert.strictEqual(investedAt(navs, cfs, 1000, '2025-12-31'), 1000); // 当日之前无出入金
});
// 分支2：目标日 <= 最后导入日
check('目标日<=最后导入日 -> 取该日导入本金', () => {
  const navs = [
    { date: '2026-01-01', invested: 1200 },
    { date: '2026-02-01', invested: 1300 },
  ];
  const cfs = [{ date: '2026-01-15', amount: 200 }];
  assert.strictEqual(investedAt(navs, cfs, 1000, '2026-01-01'), 1200);
  assert.strictEqual(investedAt(navs, cfs, 1000, '2026-02-01'), 1300);
  // 当日无导入值但有更早导入 -> 取最后一个 <= 当日的导入值
  assert.strictEqual(investedAt(navs, [], 1000, '2026-01-15'), 1200);
});
check('目标日<=最后导入日 且无匹配导入 -> 退回期初+出入金', () => {
  const navs = [{ date: '2026-02-01', invested: 1300 }];
  const cfs = [{ date: '2026-01-10', amount: 70 }];
  assert.strictEqual(investedAt(navs, cfs, 1000, '2026-01-05'), 1000); // 当日之前无导入也无出入金
});
// 分支3：目标日 > 最后导入日
check('目标日>最后导入日 -> 最后导入值 + 之后累计出入金', () => {
  const navs = [{ date: '2026-02-01', invested: 1300 }];
  const cfs = [
    { date: '2026-01-15', amount: 200 }, // 在最后导入日前，不计
    { date: '2026-02-10', amount: 300 },
    { date: '2026-03-01', amount: -100 },
  ];
  assert.strictEqual(investedAt(navs, cfs, 1000, '2026-02-20'), 1300 + 300); // 1600
  assert.strictEqual(investedAt(navs, cfs, 1000, '2026-03-05'), 1300 + 300 - 100); // 1500
});

console.log('D. UMD 浏览器全局模式可用');
check('window.NavMath / window.investedAt / window.chainNav 暴露', () => {
  global.window = {};
  delete require.cache[require.resolve('../../public/shared/nav-math.js')];
  require('../../public/shared/nav-math.js');
  assert.strictEqual(typeof global.window.NavMath.investedAt, 'function');
  assert.strictEqual(typeof global.window.chainNav, 'function');
  assert.strictEqual(global.window.NavMath.chainNav(1, 100, 110, 0), 1.1);
  delete global.window;
});

const pass = results.filter(r => r[0] === 'PASS').length;
const fail = results.filter(r => r[0] === 'FAIL').length;
console.log('\n===== nav-math 回归汇总 =====');
console.log('PASS=' + pass + '  FAIL=' + fail);
if (fail > 0) {
  console.log('HAS_ISSUES');
  process.exit(1);
} else {
  console.log('ALL PASS');
}

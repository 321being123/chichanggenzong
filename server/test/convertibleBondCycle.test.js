// 可转债周期：纯算法单元测试
// 运行：node server/test/convertibleBondCycle.test.js
const assert = require('assert');
const c = require('../services/convertibleBondCycle');

const results = [];
function check(name, fn) {
  try { fn(); results.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (e) { results.push(['FAIL', name + ' :: ' + e.message]); console.log('  [FAIL] ' + name + ' :: ' + e.message); }
}

console.log('A. median 奇数/偶数/无效值');
check('奇数 [1,2,3] -> 2', () => assert.strictEqual(c.median([1, 2, 3]), 2));
check('偶数 [1,2,3,4] -> 2.5', () => assert.strictEqual(c.median([1, 2, 3, 4]), 2.5));
check('空/字符串/NaN/null 不转成 0', () => assert.strictEqual(c.median([null, undefined, 'abc', NaN, '', '  ']), null));
check('混合无效值只取有效 [null,5] -> 5', () => assert.strictEqual(c.median([null, 5, 'x']), 5));
check('NaN 数返回 null', () => assert.strictEqual(c.median([NaN]), null));

console.log('B. 动态权重（20%～55%封顶）');
const W = [[95, 0.20], [100, 0.20], [110, 0.30], [120, 0.40], [130, 0.50], [135, 0.55], [145, 0.55]];
for (const [p, w] of W) {
  check(`价格中位数 ${p} -> 权重 ${w}`, () => assert.ok(Math.abs(c.computeWeight(p) - w) < 1e-9, `期望 ${w} 实得 ${c.computeWeight(p)}`));
}
check('135 元权重恰为 0.55', () => assert.ok(Math.abs(c.computeWeight(135) - 0.55) < 1e-9));
check('高于 135 元权重仍封顶 0.55', () => assert.ok(Math.abs(c.computeWeight(200) - 0.55) < 1e-9));
check('低于 100 元权重仍为下限 0.20', () => assert.ok(Math.abs(c.computeWeight(80) - 0.20) < 1e-9));

console.log('C. 综合估值 S = P + R × W');
const S = [[95, 60, 0.20, 107], [120, 30, 0.40, 132], [135, 20, 0.55, 146], [145, 20, 0.55, 156]];
for (const [p, r, w, s] of S) {
  check(`P=${p} R=${r}% W=${w} -> S=${s}`, () => assert.ok(Math.abs(c.computeComposite(p, r, w) - s) < 1e-9, `期望 ${s} 实得 ${c.computeComposite(p, r, w)}`));
}

console.log('D. 覆盖率与样本数质量门禁');
check('覆盖率恰好 90% 通过', () => assert.strictEqual(c.validateDataQuality({ rowCount: 150, bondCount: 100, coverageRatio: 0.9 }).ok, true));
check('覆盖率 89% 失败', () => assert.strictEqual(c.validateDataQuality({ rowCount: 150, bondCount: 100, coverageRatio: 0.89 }).ok, false));
check('样本数恰好 100 通过', () => assert.strictEqual(c.validateDataQuality({ rowCount: 150, bondCount: 100, coverageRatio: 0.95 }).ok, true));
check('样本数 99 失败', () => assert.strictEqual(c.validateDataQuality({ rowCount: 150, bondCount: 99, coverageRatio: 0.95 }).ok, false));
check('返回条数达 2000 拒绝发布', () => assert.strictEqual(c.validateDataQuality({ rowCount: 2000, bondCount: 500, coverageRatio: 1 }).ok, false));
check('价格有数据但溢价率全缺 -> premium_fields_missing（数据异常）', () => {
  const q = c.validateDataQuality({ rowCount: 500, bondCount: 500, premiumCount: 0, coverageRatio: 0 });
  assert.strictEqual(q.ok, false);
  assert.strictEqual(q.reason, 'premium_fields_missing');
  assert.ok(c.ANOMALY_REASONS.includes('premium_fields_missing'), '应列入异常原因清单');
});

console.log('E. 历史分位（中间秩 / 252 日门槛）');
// 注意：少于 252 个有效交易日 computePercentile 直接返回 null（方案 3.6），故中间秩测试需用足样本
check('完全相同值用中间秩且含当天自身（prior 251 个10，当前10 -> 恰为 50.0）', () => {
  const q = c.computePercentile(10, new Array(251).fill(10));
  assert.ok(q !== null && Math.abs(q - 50.0) < 1e-6, '期望 50.0，实得 ' + q);
});
check('混合值中间秩含当天（prior=100个5+100个10+51个15，当前10 -> 约 59.7）', () => {
  // less=100，equal=100(prior)+1(当天)=101，total=252 -> (100+50.5)/252×100≈59.7
  const prior = [].concat(new Array(100).fill(5), new Array(100).fill(10), new Array(51).fill(15));
  const q = c.computePercentile(10, prior);
  assert.ok(q !== null && Math.abs(q - 59.7) < 0.2, '期望约 59.7，实得 ' + q);
});
check('历史不足 252 日返回 null（prior 250 -> total 251）', () => assert.strictEqual(c.computePercentile(10, new Array(250).fill(5)), null));
check('历史恰好 252 日（prior 251 -> total 252）输出分位', () => assert.notStrictEqual(c.computePercentile(10, new Array(251).fill(5)), null));

console.log('F. 周期分档边界');
const L = [[0, '低位'], [19.9, '低位'], [20, '偏低'], [39.9, '偏低'], [40, '中位'], [59.9, '中位'], [60, '偏高'], [79.9, '偏高'], [80, '高位'], [100, '高位']];
for (const [q, lvl] of L) {
  check(`分位 ${q} -> ${lvl}`, () => assert.strictEqual(c.cycleLevel(q), lvl));
}
check('分位 null -> 返回 null', () => assert.strictEqual(c.cycleLevel(null), null));

console.log('G. 样本过滤与单日聚合');
function mk(ts, close, cbv, prem) { return { ts_code: ts, trade_date: '20260727', close, cb_value: cbv, cb_over_rate: prem }; }
// 3 只有效，全部满足溢价率样本条件
const good = [mk('113001.SH', 110, 90, 30), mk('113002.SH', 120, 100, 25), mk('123003.SZ', 100, 80, 35)];
check('价格中位数=110、溢价率中位数=30、综合估值=119', () => {
  const { metrics, quality } = c.aggregateDaily({ rows: good, tradeDate: '2026-07-27', sourceId: 1 });
  assert.strictEqual(metrics.bond_count, 3);
  assert.strictEqual(metrics.premium_count, 3);
  assert.ok(Math.abs(metrics.median_price - 110) < 1e-9);
  assert.ok(Math.abs(metrics.median_conversion_premium_pct - 30) < 1e-9);
  assert.ok(Math.abs(metrics.composite_value - 119) < 1e-9); // 110 + 30×0.30
  assert.strictEqual(quality.ok, false); // 样本数 3 < 100，质量不通过
});
// 非法代码、close<=0、缺溢价率 应被排除/计数诊断
const messy = [
  mk('600001.SH', 110, 90, 30),     // 非可转债代码 -> 排除
  mk('113004.SH', 0, 90, 30),       // close<=0 -> invalid_price
  mk('113005.SH', 120, 0, 25),      // cb_value<=0 -> 进价格样本但缺转股价值
  mk('113006.SH', 130, 100, null),  // cb_over_rate 缺失 -> 进价格样本但缺溢价率
  mk('113007.SH', 140, 110, 20),    // 完全有效
];
check('脏数据样本过滤与诊断计数', () => {
  const { priceRows, premiumRows, diagnostics } = c.filterSampleRows(messy);
  assert.strictEqual(diagnostics.invalid_price, 1);          // 113004 close=0
  assert.strictEqual(diagnostics.missing_conversion_value, 1); // 113005 cb_value=0（仍进价格样本）
  assert.strictEqual(diagnostics.missing_premium, 1);          // 113006 缺溢价率（仍进价格样本）
  assert.strictEqual(priceRows.length, 3);                    // 113005 + 113006 + 113007（close 均有效）
  assert.strictEqual(premiumRows.length, 1);                  // 仅 113007
});

console.log('H. finalizeCycle 结合历史补充分位');
check('finalizeCycle 用 prior 计算分位与档位', () => {
  const agg = c.aggregateDaily({ rows: good, tradeDate: '2026-07-27', sourceId: 1 });
  const prior = new Array(300).fill(agg.metrics.composite_value); // 全等于当前值
  const full = c.finalizeCycle(agg, prior);
  // 全等于当前值且含当天自身：less=0, equal=301, total=301 -> 恰为 50.0
  assert.ok(Math.abs(full.rolling_percentile - 50.0) < 1e-6, '期望 50.0，实得 ' + full.rolling_percentile);
  assert.strictEqual(full.cycle_level, '中位');
});

const pass = results.filter(r => r[0] === 'PASS').length;
const fail = results.filter(r => r[0] === 'FAIL').length;
console.log('\n===== convertibleBondCycle 算法测试汇总 =====');
console.log('PASS=' + pass + '  FAIL=' + fail);
if (fail > 0) { console.log('HAS_ISSUES'); process.exit(1); }
else { console.log('ALL PASS'); }

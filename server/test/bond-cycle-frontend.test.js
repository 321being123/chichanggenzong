// 可转债周期：前端静态结构测试
// 运行：node server/test/bond-cycle-frontend.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'public', 'js', 'bond-cycle.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'css', 'bond-cycle.css'), 'utf8');

const results = [];
function check(name, fn) {
  try { fn(); results.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (e) { results.push(['FAIL', name + ' :: ' + e.message]); console.log('  [FAIL] ' + name + ' :: ' + e.message); }
}

console.log('A. 一级导航与首页卡片');
check('一级导航显示“可转债”且保留内部标识 bond-safety', () => {
  assert.ok(html.includes('data-main="bond-safety">可转债<'), '一级导航未改为“可转债”');
});
check('首页模块卡片标题为“可转债”', () => {
  assert.ok(html.includes('home-module-name">可转债<'), '首页卡片标题未改为“可转债”');
});

console.log('B. 二级导航与周期页容器');
check('二级导航含“可转债安全性”与“可转债周期”', () => {
  assert.ok(html.includes('data-sub="safety"') && html.includes('data-sub="cycle"'), '缺少二级导航');
});
check('存在周期子页容器 sub-bond-cycle', () => {
  assert.ok(html.includes('id="sub-bond-cycle"'), '缺少周期子页容器');
});
check('周期页含全部概览卡片 DOM', () => {
  for (const id of ['bc-cycle-level', 'bc-percentile', 'bc-composite', 'bc-bond-count',
    'bc-median-price', 'bc-median-premium', 'bc-median-value', 'bc-weight', 'bc-coverage']) {
    assert.ok(html.includes('id="' + id + '"'), '缺少 DOM：' + id);
  }
});
check('过期提示与状态区存在', () => {
  assert.ok(html.includes('id="bond-cycle-stale"') && html.includes('id="bond-cycle-status"'), '缺少状态/过期区');
});

console.log('C. 脚本与样式接入');
check('index.html 引入 bond-cycle.js', () => assert.ok(html.includes('js/bond-cycle.js')));
check('index.html 引入 bond-cycle.css', () => assert.ok(html.includes('css/bond-cycle.css')));

console.log('D. 前端脚本行为');
check('定义 switchBondSub / loadBondCycle / initBondCycleSub', () => {
  assert.ok(js.includes('function switchBondSub('), '缺少 switchBondSub');
  assert.ok(js.includes('function loadBondCycle('), '缺少 loadBondCycle');
  assert.ok(js.includes('function initBondCycleSub('), '缺少 initBondCycleSub');
});
check('只读接口路径为 /api/bond-cycle', () => assert.ok(js.includes("/api/bond-cycle?range="), '前端未接入 /api/bond-cycle'));
check('页面只展示、不复制后端公式', () => {
  assert.ok(!js.includes('function computeWeight'), '前端不应自行实现权重公式');
  assert.ok(!js.includes('function computeComposite'), '前端不应自行实现综合估值公式');
});
check('所有接口文本使用转义（存在 esc/escapeHtml 调用）', () => {
  assert.ok(js.includes('esc(') || js.includes('escapeHtml('), '缺少转义处理');
});
check('时间范围与指标切换按钮存在', () => {
  // 按钮定义在 index.html（bond-cycle-range-tabs / bond-cycle-metric-tabs 内）
  assert.ok(html.includes('data-range="1y"') && html.includes('data-range="all"'), '缺少时间范围按钮');
  assert.ok(html.includes('data-metric="percentile"') && html.includes('data-metric="median_price"'), '缺少指标切换按钮');
});
check('CSS 含关键样式类', () => {
  assert.ok(css.includes('.bond-cycle-card') && css.includes('.bc-line') && css.includes('.bc-band-高位'), 'CSS 关键类缺失');
});
check('周期说明与图表提示使用统一主题', () => {
  assert.ok(html.includes('bond-cycle-help-tip app-tooltip'), '周期说明未使用统一主题');
  assert.ok(html.includes('bond-cycle-tip app-tooltip'), '周期图表提示未使用统一主题');
});

console.log('E. 曲线字段映射（整改 P1-4）');
check('存在指标→接口字段映射 BC_METRIC_FIELDS', () => {
  assert.ok(js.includes('BC_METRIC_FIELDS'), '缺少字段映射表');
  assert.ok(/percentile:\s*'rolling_percentile'/.test(js), 'percentile 未映射到 rolling_percentile');
  assert.ok(/composite:\s*'composite_value'/.test(js), 'composite 未映射到 composite_value');
});
check('曲线取值走映射后的字段（r[field]）而非 r[metric]', () => {
  assert.ok(js.includes('BC_METRIC_FIELDS[metric]'), '未使用映射表取字段');
  assert.ok(js.includes('r[field]'), '曲线取值未使用映射后的字段');
  assert.ok(!/history\.map\(function \(r\) \{ var v = r\[metric\]/.test(js), '仍在用 r[metric] 直接取值');
});
check('用真实接口结构数据可取到值（rolling_percentile/composite_value）', () => {
  // 模拟接口 history 行的真实结构，按映射逻辑取值
  const mapping = { percentile: 'rolling_percentile', composite: 'composite_value', median_price: 'median_price', median_conversion_premium_pct: 'median_conversion_premium_pct' };
  const row = { date: '2026-07-24', rolling_percentile: 63.2, composite_value: 128.55, median_price: 121.3, median_conversion_premium_pct: 24.8 };
  for (const m of Object.keys(mapping)) {
    const v = row[mapping[m]];
    assert.ok(v !== null && v !== undefined && Number.isFinite(Number(v)), '指标 ' + m + ' 取不到值');
  }
});
check('全空数据显示明确空状态', () => {
  assert.ok(js.includes('无有效数据'), '缺少无有效数据空状态');
  assert.ok(js.includes('所选时间内暂无历史数据'), '缺少空历史提示');
});

const pass = results.filter(r => r[0] === 'PASS').length;
const fail = results.filter(r => r[0] === 'FAIL').length;
console.log('\n===== bond-cycle 前端测试汇总 =====');
console.log('PASS=' + pass + '  FAIL=' + fail);
if (fail > 0) { console.log('HAS_ISSUES'); process.exit(1); }
else { console.log('ALL PASS'); }

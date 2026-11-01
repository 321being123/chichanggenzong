// 2026-10-31 两条界面反馈的静态回归：
//   #8 文章浏览页向上滚动时标题没有吸顶（public/css/knowledge.css）
//   #7 持仓页按钮尺寸/文字不统一（public/shared/style.css、public/shared/core-tables.js）
// 只断言样式与模板事实，不启动浏览器（低性能模式）。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const read = rel => fs.readFileSync(path.join(PUBLIC_DIR, rel), 'utf8');

const tests = [];
function check(name, fn) {
  try { fn(); tests.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (error) { tests.push(['FAIL', name + ' :: ' + error.message]); console.log('  [FAIL] ' + name + ' :: ' + error.message); }
}

check('#8 阅读视图标题吸顶，且 top 与导航高度变量对齐', () => {
  const css = read('css/knowledge.css');
  const rule = css.match(/\.ks-page\[data-view="read"\]\s+\.ks-article-header\s*\{[^}]*\}/);
  assert.ok(rule, '缺少阅读视图标题吸顶规则');
  assert.ok(/position:\s*sticky/.test(rule[0]), '标题必须 sticky');
  assert.ok(/top:\s*var\(--site-nav-height\)/.test(rule[0]), 'top 必须取 --site-nav-height，手机端含安全区');
  assert.ok(/background:\s*var\(--ks-surface\)/.test(rule[0]), '吸顶需不透明背景，否则正文从标题下穿出');
});

check('#8 吸顶只作用于阅读视图，不影响列表/编辑视图', () => {
  const css = read('css/knowledge.css');
  assert.ok(css.includes('.ks-page[data-view="read"] .ks-article-header'), '吸顶选择器应带阅读视图限定');
  const plain = css.match(/(?:^|\n)\.ks-article-header\s*\{[^}]*\}/);
  assert.ok(plain, '缺少默认文章头规则');
  assert.ok(!/position:\s*sticky/.test(plain[0]), '默认文章头不应全局吸顶');
});

check('#7 筛选栏按钮统一尺寸（桌面 36px / 手机 44px）', () => {
  const css = read('shared/style.css');
  const desk = css.match(/(?:^|\n)\.filter-bar \.btn\s*\{[^}]*\}/);
  assert.ok(desk, '缺少 .filter-bar .btn 统一尺寸规则');
  assert.ok(/min-height:\s*36px/.test(desk[0]), '桌面筛选栏按钮应与同栏输入框同高（36px）');
  assert.ok(/font-size:\s*13px/.test(desk[0]), '桌面筛选栏按钮字号应与筛选栏一致（13px）');
  const mobile = css.match(/\.filter-bar \.btn,\s*\.filter-bar \.filter-bar-btn\s*\{\s*min-height:\s*44px;?\s*\}/);
  assert.ok(mobile, '手机端筛选栏所有按钮（不只是 .filter-bar-btn）都应 ≥44px');
});

check('#7 顶部刷新按钮与同栏控件字号统一', () => {
  const css = read('shared/style.css');
  const rule = css.match(/(?:^|\n)\.btn-refresh\s*\{[^}]*\}/);
  assert.ok(rule, '缺少 .btn-refresh 规则');
  assert.ok(/font-size:\s*13px/.test(rule[0]), '刷新按钮字号应与筛选栏按钮一致（13px）');
});

check('#7 持仓表格导出按钮文案为“导出 Excel”', () => {
  const tpl = read('shared/core-tables.js');
  assert.ok(tpl.includes('>导出 Excel<'), '导出按钮应统一为“导出 Excel”（与可转债列表一致，避免全大写挤压）');
  assert.ok(!tpl.includes('导出EXCEL'), '不应残留全大写写法');
});

const pass = tests.filter(item => item[0] === 'PASS').length;
const fail = tests.filter(item => item[0] === 'FAIL').length;
console.log('\n===== feedback-ui-20261031 测试汇总 =====');
console.log('PASS=' + pass + '  FAIL=' + fail);
if (fail) process.exit(1);

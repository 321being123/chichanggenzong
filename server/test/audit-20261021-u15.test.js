// 审查 U-15 回归：内联样式/内联事件清零 + CSP 收紧 + ui-actions 机制在位
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.join(__dirname, '..', '..');

const HTML_FILES = ['index.html', 'login.html', 'admin.html', 'share-knowledge.html', 'ipo-report.html', 'bond-revision-motive.html'];
const JS_DIRS = ['public/js', 'public/shared'];

function read(p) { return fs.readFileSync(path.join(root, p), 'utf8'); }

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' —— ' + e.message); }
}

check('全部页面无内联 style= 属性（U-15a/b）', () => {
  for (const f of HTML_FILES) {
    const html = read('public/' + f);
    const m = html.match(/(?<![.\w-])style="/g);
    assert.strictEqual(m, null, f + ' 仍有内联 style 属性');
  }
});

check('全部页面无内联事件属性（U-15c）', () => {
  const re = /on(?:click|change|input|submit|keydown|keyup|blur|focus)="/;
  for (const f of HTML_FILES) {
    const html = read('public/' + f);
    assert.ok(!re.test(html), f + ' 仍有内联事件属性');
  }
});

check('JS 模板无 HTML 属性形态的内联 style=（U-15b）', () => {
  for (const d of JS_DIRS) {
    for (const f of fs.readdirSync(path.join(root, d))) {
      if (!f.endsWith('.js')) continue;
      const src = read(d + '/' + f);
      const m = src.match(/(?<![.\w-])style="/g);
      assert.strictEqual(m, null, d + '/' + f + ' 模板仍有内联 style');
    }
  }
});

check('JS 模板无内联事件属性（U-15c）', () => {
  const re = /on(?:click|change|input|submit)="/;
  for (const d of JS_DIRS) {
    for (const f of fs.readdirSync(path.join(root, d))) {
      if (!f.endsWith('.js')) continue;
      const src = read(d + '/' + f);
      assert.ok(!re.test(src), d + '/' + f + ' 模板仍有内联事件');
    }
  }
});

check('CSP 移除 style-src-attr/script-src-attr 的 unsafe-inline（U-15d）', () => {
  const sec = read('server/middleware/security.js');
  assert.ok(sec.includes("script-src-attr 'none'"), 'script-src-attr 未收紧');
  assert.ok(sec.includes("style-src-attr 'none'"), 'style-src-attr 未收紧');
  assert.ok(!/src-attr 'unsafe-inline'/.test(sec), 'src-attr 仍留 unsafe-inline');
});

check('ui-actions.js 提供 data-style→CSSOM 与 data-act 委托', () => {
  const ua = read('public/shared/ui-actions.js');
  assert.ok(ua.includes('data-style'), '缺 data-style 处理');
  assert.ok(ua.includes('data-act'), '缺 data-act 委托');
  assert.ok(ua.includes('MutationObserver'), '缺 MutationObserver');
  assert.ok(ua.includes('__THIS__'), '缺 this 参数占位');
  assert.ok(ua.includes('data-prevent'), '缺 preventDefault 支持');
});

check('全部页面加载 ui-actions.js', () => {
  for (const f of HTML_FILES) {
    const html = read('public/' + f);
    assert.ok(html.includes('ui-actions.js'), f + ' 未加载 ui-actions.js');
  }
});

check('初始隐藏元素用 js-hidden 类而非 style（U-15a）', () => {
  const css = read('public/shared/style.css');
  assert.ok(css.includes('.js-hidden { display: none; }'), '缺 js-hidden 基类');
  // index.html 中不应再有 style="display:none"
  const html = read('public/index.html');
  assert.ok(!html.includes('style="display:none"'), 'index.html 仍有 display:none 内联');
});

check('JS 恢复点先摘 js-hidden 类再置空 display（U-15a 补丁）', () => {
  // 抽查核心文件：恢复点必须带 classList.remove('js-hidden')
  const bv = read('public/js/bond-valuation.js');
  assert.ok(bv.includes("classList.remove('js-hidden')"), 'bond-valuation 恢复点未摘类');
  const mv = read('public/js/market-volatility.js');
  assert.ok(mv.includes("classList.remove('js-hidden')"), 'market-volatility 恢复点未摘类');
  const ce = read('public/shared/core-earnings.js');
  assert.ok(ce.includes("classList.remove('js-hidden')"), 'core-earnings 恢复点未摘类');
});

console.log(`\nPASS=${pass} FAIL=${fail}`);
process.exit(fail ? 1 : 0);

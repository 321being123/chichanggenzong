// HOME-01：首页按登录态的 DOM 顺序测试（jsdom，不依赖浏览器/接口/数据库）
// 验证：首页移除常用工具后，游客和登录用户共用剩余区块与导航。
// 只重排已有区块，不新增接口或统计口径。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'public', 'js', 'home-dashboard.js'), 'utf8');

const dom = new JSDOM(html, { runScripts: 'outside-only' });
const { window } = dom;
// 在 window 上下文执行 home-dashboard.js，使其函数挂到 window 上
window.eval(js);
const doc = window.document;

const EXPECT_ORDER = ['home-section-cycle', 'home-section-articles', 'home-section-secondary', 'home-section-capabilities'];
function sectionOrder() {
  return Array.from(doc.querySelector('.home-dashboard-shell').children).map(c => c.id);
}
for (const width of [320, 360, 390, 430, 760, 768, 900, 1024, 1440]) {
  window.innerWidth = width;
  for (const loggedIn of [false, true, false]) {
    window.applyHomeOrder(doc, loggedIn);
    assert.deepStrictEqual(sectionOrder(), EXPECT_ORDER, '首页剩余区块顺序应一致');
    assert.strictEqual(doc.getElementById('home-section-modules'), null, '首页不应保留常用工具区域');
    assert.strictEqual(doc.querySelectorAll('.main-nav .main-tab').length, 9, '应保留原九个导航入口');
  }
}
console.log('home-dashboard-order: 通过（9档宽度、游客/登录/切回游客、原导航保留）');

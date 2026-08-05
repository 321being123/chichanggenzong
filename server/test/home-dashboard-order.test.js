// HOME-01：首页按登录态的 DOM 顺序测试（jsdom，不依赖浏览器/接口/数据库）
// 验证：游客首页以公开文章+研究优先；登录用户把持仓总资产卡与资产入口置前。
// 只重排已有区块/卡片，不新增接口或统计口径。
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

const EXPECT_GUEST = ['home-section-articles', 'home-section-cycle', 'home-section-modules', 'home-section-secondary', 'home-section-capabilities'];
const EXPECT_LOGGED_FIRST = 'home-section-articles';

function sectionOrder() {
  const shell = doc.querySelector('.home-dashboard-shell');
  return Array.from(shell.children)
    .filter(function (c) { return c.id && c.id.indexOf('home-section-') === 0; })
    .map(function (c) { return c.id; });
}
function moduleFirstCard() {
  const grid = doc.querySelector('#home-section-modules .home-module-grid');
  const first = grid && grid.firstElementChild;
  return first ? first.id : null;
}

// 1) 游客：公开文章 + 研究优先（文章 → 周期 → 模块 → 次要 → 能力）
window.applyHomeOrder(doc, false);
assert.deepStrictEqual(sectionOrder(), EXPECT_GUEST,
  '游客首页顺序应为 文章→周期→模块→次要→能力，实际为 ' + sectionOrder().join(','));

// 2) 登录用户：持仓总资产卡与资产入口置前（常用工具区块第一位 + 持仓管理卡为模块网格首位）
window.applyHomeOrder(doc, true);
const logged = sectionOrder();
assert.strictEqual(logged[0], EXPECT_LOGGED_FIRST,
  '登录用户首页第一个区块应为 常用工具（含持仓总资产卡），实际为 ' + logged[0]);
assert.strictEqual(moduleFirstCard(), 'home-module-holdings',
  '登录用户“持仓管理”资产卡应为模块网格首位，实际为 ' + moduleFirstCard());

// 3) 顺序可逆：切回游客后文章重新置前
window.applyHomeOrder(doc, false);
assert.strictEqual(sectionOrder()[0], 'home-section-articles',
  '切回游客后文章应重新置前，实际为 ' + sectionOrder()[0]);

console.log('home-dashboard-order: 通过（游客文章优先 / 登录用户资产卡置前 / 可逆向切换）');

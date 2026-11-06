// 2026-11-06 线上反馈静态回归：
//   #19 投资笔记阅读页与分享页作者显示昵称，昵称缺失才回退账号
//   #20 网站顶部一级标题（深蓝顶栏）固定在视口最上端，滚动或回弹时上方不留空白
//   #21 禁止整页下拉回弹，避免固定顶栏下方被拽出一大片空白
//   #22 编辑器高度跟随正文，短文章下方不再留一大片空白
// 只断言源码事实，不启动浏览器（低性能模式）。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const tests = [];
function check(name, fn) {
  try { fn(); tests.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (error) { tests.push(['FAIL', name + ' :: ' + error.message]); console.log('  [FAIL] ' + name + ' :: ' + error.message); }
}

check('#19 阅读页作者优先用昵称', () => {
  const js = read('public/js/knowledge.js');
  assert.ok(/作者：.*a\.author_nickname/.test(js), '阅读页作者应使用作者昵称');
  assert.ok(/a\.author_nickname \|\| a\.author_username/.test(js), '昵称缺失时才回退账号');
});

check('#19 分享页作者同样优先用昵称', () => {
  const html = read('public/share-knowledge.html');
  assert.ok(/a\.author_nickname \|\| a\.author_username/.test(html), '分享页作者应优先昵称');
});

check('#19 文章详情与分享接口都返回作者昵称', () => {
  const repo = read('server/repositories/knowledgeRepository.js');
  const blocks = repo.match(/SELECT a\.\*, c\.name AS category_name,[\s\S]*?WHERE a\.(?:id|share_token)=\$1/g) || [];
  assert.strictEqual(blocks.length, 2, '阅读与分享两条查询都要带昵称');
  blocks.forEach((sql, i) => {
    assert.ok(/COALESCE\(NULLIF\(u\.nickname, ''\), a\.author_username\) AS author_nickname/.test(sql), `第${i + 1}条查询缺少昵称优先字段`);
    assert.ok(/LEFT JOIN users u ON u\.username = a\.author_username/.test(sql), `第${i + 1}条查询缺少用户表关联`);
  });
});

check('#20 顶栏固定在视口最上端', () => {
  const css = read('public/shared/style.css');
  const rule = css.match(/(?:^|\n)\.nav \{[^}]*\}/);
  assert.ok(rule, '缺少顶栏规则');
  assert.ok(/position:\s*fixed/.test(rule[0]), '顶栏必须固定定位，滚动或回弹都不会离开最上端');
  assert.ok(/top:\s*0/.test(rule[0]) && /left:\s*0/.test(rule[0]) && /right:\s*0/.test(rule[0]), '顶栏需贴齐视口三边');
  assert.ok(!/position:\s*sticky/.test(rule[0]), '不得退回随内容滚动的吸顶写法');
});

check('#20 固定顶栏后有占位，内容不被遮挡', () => {
  const css = read('public/shared/style.css');
  assert.ok(/body:has\(\.nav\)\s*\{[^}]*padding-top:\s*var\(--site-nav-height, 52px\)/.test(css), '带顶栏的页面需补回顶部占位，并跟随手机端真实导航高度');
});

check('#21 禁止整页下拉回弹', () => {
  const css = read('public/shared/style.css');
  assert.ok(/html,\s*body\s*\{[^}]*overscroll-behavior-y:\s*none/.test(css), '根滚动容器需禁止下拉回弹，否则固定顶栏下方仍会露出空白');
});

check('#21 回弹露出的画布与顶栏同色', () => {
  const css = read('public/shared/style.css');
  assert.ok(/html\s*\{\s*background:\s*#1a237e/i.test(css), '根元素需给出与深蓝顶栏同色的画布背景，否则下拉回弹会露出浅灰空白');
});

check('#21 编辑器图标不被 CSP 挤成占位块', () => {
  const css = read('public/css/knowledge.css');
  assert.ok(/body\s*>\s*svg\[version="1\.1"\]\s*\{[^}]*position:\s*absolute/.test(css), 'CSP 的 style-src-attr none 会忽略 sprite 自带的内联样式，必须由外部样式设为 absolute，否则它按 300×150 占据文档流、把页面顶部撑出空白');
  assert.ok(/body\s*>\s*svg\[version="1\.1"\]\s*\{[^}]*width:\s*0/.test(css), '图标 sprite 宽度必须为 0');
  assert.ok(/body\s*>\s*svg\[version="1\.1"\]\s*\{[^}]*height:\s*0/.test(css), '图标 sprite 高度必须为 0');
});

check('#22 编辑器高度跟随正文', () => {
  const js = read('public/js/knowledge.js');
  const cfg = js.match(/new Vditor\('ks-editor',\s*\{([\s\S]*?)placeholder:/);
  assert.ok(cfg, '缺少编辑器初始化配置');
  assert.ok(/height:\s*'auto'/.test(cfg[1]), '编辑器高度应随正文自适应，不写死固定高度');
  assert.ok(/minHeight:\s*\d+/.test(cfg[1]), '空文章时编辑区仍需保留最小高度');
  assert.ok(!/height:\s*460/.test(cfg[1]), '固定 460 会让短文章下方留一大片空白');
});

const failed = tests.filter(t => t[0] === 'FAIL');
console.log(`\n${tests.length - failed.length}/${tests.length} 通过`);
if (failed.length) process.exitCode = 1;

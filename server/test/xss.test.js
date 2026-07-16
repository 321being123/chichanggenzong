// ========== Markdown 存储型 XSS(P0-5) 回归测试 ==========
// 运行：node server/test/xss.test.js
// 用 jsdom 在 Node 内模拟浏览器环境，加载与生产一致的 vendor/marked + vendor/dompurify，
// 验证 marked 渲染结果经 DOMPurify 净化后，<script>/onerror/javascript:/svg/iframe 等载荷
// 只能显示为文本或被移除。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const results = [];
function check(name, fn) {
  try { fn(); results.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (e) { results.push(['FAIL', name + ' :: ' + e.message]); console.log('  [FAIL] ' + name + ' :: ' + e.message); }
}

const VENDOR = path.join(__dirname, '..', '..', 'public', 'vendor');
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { runScripts: 'outside-only' });
const { window } = dom;
global.window = window;
global.document = window.document;

// 加载生产同款 vendored 脚本到 jsdom window（与浏览器行为一致）
window.eval(fs.readFileSync(path.join(VENDOR, 'marked.min.js'), 'utf8'));
window.eval(fs.readFileSync(path.join(VENDOR, 'dompurify.min.js'), 'utf8'));

// 复刻 ipo-report.html 的渲染管线
function renderMarkdown(md) {
  return window.DOMPurify.sanitize(window.marked.parse(md || ''), { USE_PROFILES: { html: true } });
}

console.log('A. P0-5 XSS 载荷必须被净化（文本化或移除）');
const payloads = [
  { name: '<script>alert(1)</script>', expectRemoved: true },
  { name: '<img src=x onerror="alert(1)">', expectRemoved: true },
  { name: '[点我](javascript:alert(1))', expectRemoved: true },
  { name: '<svg/onload=alert(1)>', expectRemoved: true },
  { name: '<iframe src="https://evil.test"></iframe>', expectRemoved: true },
];

payloads.forEach(p => {
  check('载荷「' + p.name + '」被净化', () => {
    const html = renderMarkdown(p.name);
    assert.ok(!/onerror\s*=/i.test(html), '仍存在 onerror 事件属性');
    assert.ok(!/<script/i.test(html), '仍存在 <script>');
    assert.ok(!/javascript:/i.test(html), '仍存在 javascript: 协议');
    assert.ok(!/<svg/i.test(html), '仍存在 <svg>');
    assert.ok(!/<iframe/i.test(html), '仍存在 <iframe>');
  });
});

console.log('B. 正常 Markdown 元素应保留');
check('标题/表格/加粗保留', () => {
  const html = renderMarkdown('# 标题\n\n**加粗**\n\n| a | b |\n|---|---|\n| 1 | 2 |');
  assert.ok(/<h1/.test(html), '标题被误删');
  assert.ok(/<strong>加粗<\/strong>/.test(html), '加粗被误删');
  assert.ok(/<table/.test(html), '表格被误删');
});

const failed = results.filter(r => r[0] === 'FAIL');
console.log('\n========================================');
console.log(`P0-5 XSS 回归：共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
if (failed.length) { failed.forEach(f => console.log('  - ' + f[1])); process.exit(1); }
console.log('全部通过 ✅');

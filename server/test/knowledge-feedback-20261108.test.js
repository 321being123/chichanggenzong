// 2026-11-08 线上反馈静态回归：
//   #23 写文章时编辑器无法加载（失败结果被缓存、只能刷新整页）
//   #24 编辑器正文下方残留一个空占位框
//   #25 提交反馈的输入框被 Chrome 当成登录表单，反复提示保存密码
// 只断言源码事实，不启动浏览器（低性能模式）。
'use strict';
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

check('#23 编辑器初始化失败不缓存失败结果', () => {
  const js = read('public/js/knowledge.js');
  const block = js.match(/function ksEnsureVditor\(\) \{[\s\S]*?\n\}/);
  assert.ok(block, '缺少编辑器初始化函数');
  assert.ok(/\.catch\(function \(error\) \{/.test(block[0]), '必须在 Promise 外层统一清缓存');
  assert.ok(/ksState\.vditorReady = null/.test(block[0]), '失败时要清空 Promise 缓存');
  const split = block[0].indexOf('}).catch(');
  assert.ok(split > 0, '缺少外层 catch');
  const executor = block[0].slice(0, split);
  assert.ok(!/ksState\.vditorReady = null/.test(executor),
    'executor 同步执行，在其中置空会被外层赋值重新覆盖，不能当作失败清理');
});

check('#23 失败时清掉残留的编辑器 DOM', () => {
  const js = read('public/js/knowledge.js');
  assert.ok(/document\.getElementById\('ks-editor'\)/.test(js), '失败时要定位编辑器容器');
  assert.ok(/if \(host\) host\.innerHTML = ''/.test(js), '失败时要清空容器，避免留下空壳占位框');
});

check('#23 打开编辑器失败会重载栏目脚本再试一次', () => {
  const js = read('public/js/knowledge.js');
  const fn = js.match(/async function ksPaintEditor\(article\) \{[\s\S]*?\n\}/);
  assert.ok(fn, '缺少编辑器填充函数');
  assert.ok(/LazySections\.ensureSection\('knowledge'\)/.test(fn[0]), '首次失败要重新加载栏目脚本');
  const attempts = (fn[0].match(/await ksEnsureVditor\(\)/g) || []).length;
  assert.ok(attempts >= 2, '首次失败后要再初始化一次，不能只提示刷新整页');
  assert.ok(/showToast\('编辑器加载失败/.test(fn[0]) && /ksShowView\('list'\)/.test(fn[0]),
    '两次都失败仍保留原有提示与返回列表');
});

check('#24 编辑器高度由外部样式兜底', () => {
  const css = read('public/css/knowledge.css');
  const rule = css.match(/\.ks-editor-card #ks-editor > \.vditor \{[^}]*\}/);
  assert.ok(rule, 'CSP 禁止内联样式生效，必须由外部样式给出编辑区高度');
  assert.ok(/height:\s*auto !important/.test(rule[0]), '编辑区高度必须自适应');
  assert.ok(/min-height:\s*0/.test(rule[0]), '不得用固定最小高度留出空占位');
});

check('#24 底部辅助条不再露出占位框', () => {
  const css = read('public/css/knowledge.css');
  assert.ok(/\.ks-editor-card \.vditor-resize,\s*\.ks-editor-card \.vditor-counter \{[^}]*display:\s*none/.test(css),
    '拖拽条与计数角标不得在编辑器下方形成额外占位');
});

check('#25 反馈表单文本框不再被当成登录账号', () => {
  const guard = read('public/shared/autofill-guard.js');
  const feedback = read('public/js/feedback.js');
  assert.ok(/FEEDBACK_FIELD_IDS = new Set\(\['fb-form-title-input', 'fb-form-page'\]\)/.test(guard),
    '守门器要精确列出反馈表单的两个文本框');
  assert.ok(/FEEDBACK_FIELD_IDS\.has\(el\.id\)\) autocompleteValue = 'new-password'/.test(guard),
    '普通 off 拦不住 Chrome 的保存密码判定，反馈字段必须用 new-password');
  assert.ok(feedback.includes('id="fb-form-title-input"') && feedback.includes('id="fb-form-page"'),
    '反馈表单字段名必须与守门器白名单一致');
  assert.ok(guard.includes("isPasswordField(el) ? 'new-password' : 'off'"),
    '其它普通输入框仍必须保持 off，不得全站改用 new-password');
});

const failed = tests.filter(t => t[0] === 'FAIL');
console.log(`\n${tests.length - failed.length}/${tests.length} 通过`);
if (failed.length) process.exitCode = 1;

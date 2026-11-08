// 2026-11-08 线上反馈 #26 静态回归（真实浏览器行为另由专项实测覆盖）：
//   CSP 只允许同源外部脚本，Vditor 默认把图标代码塞进动态内联 <script> 执行 → 工具栏图标全空；
//   导出 iframe 与图标库的 HTML 内联 style 被 style-src-attr 'none' 忽略 → 编辑器下方空框。
// 只断言源码事实，不启动浏览器。
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

check('图标改由同源外部脚本加载', () => {
  const js = read('public/js/knowledge.js');
  const fn = js.match(/function ksLoadVditorIcons\(\) \{[\s\S]*?\n\}/);
  assert.ok(fn, '缺少图标加载函数');
  assert.ok(/script\.src\s*=\s*KS_VDITOR_ICON_SRC/.test(fn[0]), '必须用 src 加载同源外部脚本');
  assert.ok(!/script\.text\s*=/.test(fn[0]) && !/script\.innerHTML\s*=/.test(fn[0]),
    '不得把代码塞进内联 script');
  assert.ok(/script\.id\s*=\s*'vditorIconScript'/.test(fn[0]),
    'script 的 id 必须让 Vditor 跳过它自己的内联注入');
  assert.ok(js.includes("const KS_VDITOR_ICON_SRC = '/vendor/vditor/dist/js/icons/ant.js'"),
    '图标资源必须是站内同源文件');
  assert.ok(fs.existsSync(path.join(ROOT, 'public/vendor/vditor/dist/js/icons/ant.js')),
    '同源图标文件必须真实存在');
});

check('确认图标符号真的注册后才算就绪', () => {
  const js = read('public/js/knowledge.js');
  const registered = js.match(/function ksVditorIconsRegistered\(\) \{[\s\S]*?\n\}/);
  assert.ok(registered, '缺少图标注册检查');
  assert.ok(/vditor-icon-bold/.test(registered[0]) && /vditor-icon-table/.test(registered[0]),
    '必须检查工具栏实际引用的图标符号');
  const ready = js.match(/function ksEnsureVditor\(\) \{[\s\S]*?\n\}/);
  assert.ok(/ksLoadVditorIcons\(\)\.then\(ksCreateVditor\)/.test(ready[0]),
    '必须先加载图标再创建编辑器');
  const after = js.match(/after: function \(\) \{[\s\S]*?\n        \},/);
  assert.ok(after, '缺少编辑器就绪回调');
  assert.ok(/ksVditorIconsRegistered\(\)/.test(after[0]), '就绪前必须再次确认图标已注册');
  assert.ok(/reject\(new Error\('编辑器图标未注册'\)\)/.test(after[0]), '未注册时不得判定就绪');
});

check('图标加载失败有可重试提示且能重新加载', () => {
  const js = read('public/js/knowledge.js');
  const err = js.match(/function ksShowEditorError\(message, retry\) \{[\s\S]*?\n\}/);
  assert.ok(err, '缺少编辑器错误提示');
  assert.ok(/button\.textContent = '重试'/.test(err[0]) && /addEventListener\('click', retry\)/.test(err[0]),
    '提示必须带可点击的重试按钮');
  const loader = js.match(/function ksLoadVditorIcons\(\) \{[\s\S]*?\n\}/);
  assert.ok(/script\.remove\(\)/.test(loader[0]) && /if \(stale\) stale\.remove\(\)/.test(loader[0]),
    '失败后要移除残留脚本，否则重试不会重新发起加载');
  assert.ok(/script\.onerror/.test(loader[0]), '网络失败要有明确拒绝而不是静默通过');
});

check('导出 iframe 由外部 CSS 压成零高度且不影响打印', () => {
  const css = read('public/css/knowledge.css');
  const rule = css.match(/#vditorExportIframe \{[^}]*\}/);
  assert.ok(rule, '缺少导出 iframe 外部样式');
  assert.ok(/height:\s*0/.test(rule[0]) && /border:\s*0/.test(rule[0]),
    '必须恢复零高度与无边框');
  assert.ok(!/display:\s*none/.test(rule[0]), '不能用 display:none，否则导出打印会是空白');
});

check('编辑器容器选择器命中 #ks-editor 自身', () => {
  const css = read('public/css/knowledge.css');
  assert.ok(/\.ks-editor-card #ks-editor\.vditor \{/.test(css), 'vditor 类在容器自身，不是子元素');
  assert.ok(!/#ks-editor > \.vditor/.test(css), '不得再写成不生效的子元素选择器');
});

check('图标库容器的内联样式由外部 CSS 兜底', () => {
  const css = read('public/css/knowledge.css');
  const rule = css.match(/body > svg:first-child\[version="1\.1"\] \{[^}]*\}/);
  assert.ok(rule, '图标库 SVG 必须有外部隐藏样式');
  assert.ok(/position:\s*absolute/.test(rule[0]) && /overflow:\s*hidden/.test(rule[0]),
    '内联 style 被拦时不能让它撑出一块空白');
});

check('导出 PDF 的内联脚本被拦时由父页面补渲染与打印', () => {
  const js = read('public/js/knowledge.js');
  const fn = js.match(/function ksBridgeExportPdf\(\) \{[\s\S]*?\n\}/);
  assert.ok(fn, '缺少导出打印桥接');
  assert.ok(/document\.addEventListener\('click'[\s\S]*?true\)/.test(fn[0]), '必须在捕获阶段接住导出动作');
  assert.ok(/data-type="pdf"/.test(fn[0]) && /setTimeout\(function \(\) \{/.test(fn[0]),
    '必须等 Vditor 写完 iframe 再补渲染，不能抢在前面');
  assert.ok(/tries\+\+ < 20/.test(fn[0]) && /setTimeout\(render, 50\)/.test(fn[0]),
    'iframe 文档解析与预览脚本加载是异步的，必须等容器就绪再渲染');
  assert.ok(!/win\.setTimeout/.test(fn[0]), '打印计时器不能挂在会被重置的 iframe window 上');
  assert.ok(/win\.Vditor\.preview\(preview, editor\.getValue\(\)/.test(fn[0]),
    '必须用 iframe 里已加载的预览引擎渲染当前正文');
  assert.ok(/cdn:\s*KS_VDITOR_CDN/.test(fn[0]), '预览资源必须指向站内同源目录，不能回退外部 CDN');
  assert.ok(/win\.print\(\)/.test(fn[0]), '渲染后必须触发打印');
  assert.ok(/showToast\('导出预览没加载好，请重试'\)/.test(fn[0]), '预览引擎缺失时要有明确提示');
  assert.ok(/ksExportBridgeBound/.test(fn[0]), '重复初始化不得叠加多个点击监听');
  const after = js.match(/after: function \(\) \{[\s\S]*?\n        \},/);
  assert.ok(after && /ksBridgeExportPdf\(\)/.test(after[0]), '编辑器就绪后必须挂上桥接');
  assert.ok(/const KS_VDITOR_CDN = '\/vendor\/vditor'/.test(js) && /cdn: KS_VDITOR_CDN/.test(js),
    '编辑器与预览必须共用同一个站内资源目录');
});

check('修复导出打印不得放宽全站 CSP', () => {
  const security = read('server/middleware/security.js');
  assert.ok(/script-src-attr 'none'/.test(security) && /style-src-attr 'none'/.test(security),
    '内联脚本与内联样式策略不得放开');
  assert.ok(!/'unsafe-inline'/.test(security), '不得给全站加 unsafe-inline');
  assert.ok(/const scriptSources = \["'self'", \.\.\.CSP_INLINE_SCRIPT_HASHES\]/.test(security),
    'script-src 仍只允许同源外部脚本与 HTML 内联哈希');
});

const failed = tests.filter(t => t[0] === 'FAIL');
console.log(`\n${tests.length - failed.length}/${tests.length} 通过`);
if (failed.length) process.exitCode = 1;

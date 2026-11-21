// 前端 UI 设计系统重构验收门禁（2026-11-21）
// 只断言源码与静态资源事实，不启动浏览器（低性能模式）。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = rel => fs.existsSync(path.join(ROOT, rel));

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log('  [PASS] ' + name);
}

const styleCss = read('public/shared/style.css');
const loginHtml = read('public/login.html');
const loginCss = read('public/css/login.css');
const indexHtml = read('public/index.html');
const shareHtml = read('server/views/share.html');
const chartThemeJs = read('public/shared/chart-theme.js');
const boundaries = read('governance/architecture-boundaries.json');

check('1. CSS Design Tokens 完整声明', () => {
  ['--bg-canvas:', '--bg-surface:', '--blue-600: #2563eb', '--primary: var(--blue-600)', '--up:', '--down:',
   '--font-sans:', '--font-mono:', '--r-md:', '--shadow-xs:', '--focus-ring:',
   'prefers-reduced-motion: reduce'].forEach(token => {
    assert.ok(styleCss.includes(token), '缺少 Design Token: ' + token);
  });
});

check('2. Inter 字体本地自托管且无外链 CDN', () => {
  assert.ok(exists('public/vendor/fonts/inter/inter-latin-wght-normal.woff2'), '缺少 Inter woff2 字体文件');
  assert.ok(exists('public/vendor/fonts/inter/OFL.txt'), '缺少 Inter OFL 开源协议文件');
  assert.ok(styleCss.includes('/vendor/fonts/inter/inter-latin-wght-normal.woff2'), 'style.css 未声明 Inter @font-face');
  const allCss = [styleCss, loginCss, read('public/css/knowledge.css')].join('\n');
  assert.ok(!/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(allCss), '禁止引入外部 Google Fonts CDN');
});

check('3. 浅色磨砂顶栏与浅色现代卡片页头（无深蓝紫渐变 hero）', () => {
  const navRule = styleCss.match(/(?:^|\n)\.nav\s*\{[^}]*\}/);
  assert.ok(navRule && /backdrop-filter:\s*saturate\(180%\)\s*blur/.test(navRule[0]), '.nav 需使用浅色磨砂背景');
  assert.ok(!/linear-gradient[^;]*#1a237e/i.test(styleCss), 'shared/style.css 不得残留 #1a237e 渐变');
  ['public/css/bond-safety.css', 'public/css/bond-cycle.css', 'public/css/bond-valuation.css',
   'public/css/bond-redemption.css', 'public/css/stock-analysis.css', 'public/css/knowledge.css'].forEach(file => {
    const css = read(file);
    assert.ok(!/linear-gradient[^;]*(#1a237e|#3f51b5|#182848)/i.test(css), file + ' 不得残留深蓝紫渐变 hero');
  });
});

check('4. 管理后台侧栏切换为浅色主题', () => {
  const sidebarRule = styleCss.match(/\.admin-sidebar\s*\{[^}]*\}/);
  assert.ok(sidebarRule && sidebarRule[0].includes('var(--bg-surface)'), '.admin-sidebar 应使用浅色表面背景');
});

check('5. 统一按钮体系与焦点环/禁用态', () => {
  ['.btn-primary', '.btn-secondary', '.btn-ghost', '.btn-danger', '.btn-sm', '.btn-lg', '.btn:focus-visible'].forEach(sel => {
    assert.ok(styleCss.includes(sel), '缺少统一按钮样式: ' + sel);
  });
});

check('6. 统一表单控件、SVG 图标与开关组件', () => {
  assert.ok(exists('public/shared/icons/chevron-down.svg'), '缺少本地 chevron-down.svg');
  assert.ok(exists('public/shared/icons/search.svg'), '缺少本地 search.svg');
  assert.ok(styleCss.includes('.ui-switch') && styleCss.includes('.ui-secret-input'), '缺少 .ui-switch 或 .ui-secret-input');
});

check('7. 全站二级吸顶导航统一收口至 shared/style.css', () => {
  assert.ok(styleCss.includes('.holdings-header') && styleCss.includes('.bond-header') && styleCss.includes('.bond-sub-tab'), 'shared/style.css 缺少统一二级吸顶导航规则');
  assert.ok(!/\.bond-sub-tab\s*\{/.test(read('public/css/bond-cycle.css')), 'bond-cycle.css 不应重复定义 .bond-sub-tab');
});

check('8. login.html 剥离内联样式并规范版本号与 form 边界', () => {
  assert.ok(!/<style[\s>]/i.test(loginHtml), 'login.html 不得保留内联 <style> 块');
  assert.ok(loginHtml.includes('css/login.css?v=__APP_VERSION__'), 'login.html 必须引入 css/login.css?v=__APP_VERSION__');
  assert.ok(!/\?v=(?:0\.8\.2\.1|1|0\.8\.0\.12)/.test(loginHtml), 'login.html 不得残留过期固定版本号');
  assert.ok(loginHtml.includes('data-autofill-scope="credential"'), 'login.html 必须包裹 credential form 边界');
});

check('9. 图表主题读取器注册并接入', () => {
  assert.ok(chartThemeJs.includes('SiteChartTheme'), 'chart-theme.js 应导出 window.SiteChartTheme');
  assert.ok(boundaries.includes('public/shared/chart-theme.js'), 'architecture-boundaries.json 应登记 chart-theme.js');
  assert.ok(indexHtml.includes('shared/chart-theme.js?v=__APP_VERSION__'), 'index.html 应引入 chart-theme.js');
  assert.ok(shareHtml.includes('/shared/chart-theme.js?v=__APP_VERSION__'), 'share.html 应引入 chart-theme.js');
  ['public/js/home-dashboard.js', 'public/js/bond-cycle.js', 'public/js/bond-valuation.js',
   'public/shared/core-returns.js', 'public/shared/core-account.js'].forEach(file => {
    assert.ok(read(file).includes('SiteChartTheme'), file + ' 应接入 SiteChartTheme');
  });
});

check('10. 公开分享页取消白色 hero 标题覆盖', () => {
  const shareCss = read('public/css/share.css');
  assert.ok(!/\.stock-analysis-hero h1\s*\{[^}]*color:\s*#fff/i.test(shareCss), 'share.css 不得保留白色 hero 标题');
});

console.log(`ui-design-system: ${passed} 项门禁检查全部通过`);

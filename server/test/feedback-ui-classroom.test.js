// 2026-11-23：提交反馈 UI 统一到全站 Design Tokens + 模拟股市页面接入全局悬浮「提交反馈」
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (err) {
    fail++;
    console.log('  ✗ ' + name + ' —— ' + err.message);
  }
}

console.log('--- 提交反馈 UI 统一与模拟股市接入 ---');

test('feedback.css 使用全站 Design Tokens，不再残留旧版硬编码深靛蓝与失效变量', () => {
  const css = read('public/css/feedback.css');
  ['#1a237e', '#1a1a2e', '#eef1fb', '#e4e4e4', '#c0392b', '#c9cdd8', '#e0e3ee'].forEach((hex) => {
    assert.ok(!css.includes(hex), '不应再包含旧硬编码色 ' + hex);
  });
  ['var(--border)', 'var(--primary-50)', 'var(--primary-100)', 'var(--text-faint)', 'var(--t-fast)', 'var(--up-bg)', 'var(--down-bg)', 'var(--warn-bg)'].forEach((v) => {
    assert.ok(!css.includes(v), '不应再包含未定义变量 ' + v);
  });
  assert.ok(css.includes('var(--bg-surface)'), '应使用 --bg-surface');
  assert.ok(css.includes('var(--primary-text)'), '应使用 --primary-text');
  assert.ok(css.includes('var(--border-strong)'), '应使用 --border-strong');
  assert.ok(css.includes('var(--focus-ring)'), '应使用 --focus-ring');
});

test('悬浮入口 .fb-fab 与悬浮面板 .fb-float-panel 对齐全站浅色现代设计', () => {
  const css = read('public/css/feedback.css');
  const fabRule = css.match(/(?:^|\n)\.fb-fab\s*\{[^}]*\}/);
  assert.ok(fabRule, '缺少 .fb-fab 规则');
  assert.ok(fabRule[0].includes('var(--bg-surface)'), '.fb-fab 应使用 --bg-surface');
  assert.ok(fabRule[0].includes('var(--primary-text)'), '.fb-fab 应使用 --primary-text');
  assert.ok(fabRule[0].includes('var(--shadow-sm)'), '.fb-fab 应使用 --shadow-sm');
  const panelRule = css.match(/(?:^|\n)\.fb-float-panel\s*\{[^}]*\}/);
  assert.ok(panelRule, '缺少 .fb-float-panel 规则');
  assert.ok(panelRule[0].includes('var(--bg-surface)'), '.fb-float-panel 应使用 --bg-surface');
  assert.ok(panelRule[0].includes('var(--shadow-lg)'), '.fb-float-panel 应使用 --shadow-lg');
  const typeGroup = css.match(/(?:^|\n)\.fb-type-group\s*\{[^}]*\}/);
  assert.ok(typeGroup && typeGroup[0].includes('var(--bg-muted)'), '种类切换条应使用分段控件底色 --bg-muted');
});

test('模拟股市页面 public/classroom.html 已引入提交反馈样式与脚本', () => {
  const html = read('public/classroom.html');
  assert.ok(html.includes('href="css/feedback.css?v=__APP_VERSION__"'), '应引入 css/feedback.css');
  assert.ok(html.includes('src="shared/dialog.js?v=__APP_VERSION__"'), '应引入 shared/dialog.js');
  assert.ok(html.includes('src="js/presenters/feedback-presenter.js?v=__APP_VERSION__"'), '应引入 feedback-presenter.js');
  assert.ok(html.includes('src="js/feedback.js?v=__APP_VERSION__"'), '应引入 feedback.js');
  assert.ok(html.includes('src="js/feedback-fab.js?v=__APP_VERSION__"'), '应引入 feedback-fab.js');
});

test('versionedStaticPages 已纳入 /classroom.html 以随发版刷新脚本缓存（#78）', () => {
  const src = read('server/middleware/versionedStaticPages.js');
  assert.ok(src.includes("'/classroom.html': 'classroom.html'"), 'versionedStaticPages 应映射 /classroom.html');
});

test('模拟股市初始化同步 window.username 与 window.accountIdentity 供反馈入口识别登录态', () => {
  const js = read('public/js/classroom.js');
  assert.ok(js.includes('window.username = me.username;'), 'init 应同步设置 window.username');
  assert.ok(js.includes('window.accountIdentity = state.accountIdentity;'), 'init 应同步设置 window.accountIdentity');
});

test('feedback.js 与 feedback-fab.js 兼容独立页面（esc/toast 兜底与非根路径保留）', () => {
  const fbJs = read('public/js/feedback.js');
  const fabJs = read('public/js/feedback-fab.js');
  assert.ok(fbJs.includes("typeof escapeHtml === 'function'"), 'feedback.js esc() 应兼容无 utils.js 页面');
  assert.ok(fbJs.includes('fb-toast-fallback'), 'feedback.js toast() 应提供 .toast 兜底');
  assert.ok(fabJs.includes('fb-toast-fallback'), 'feedback-fab.js toast() 应提供 .toast 兜底');
  assert.ok(fbJs.includes("var pathname = window.location.pathname || '/';"), 'currentPagePath() 应保留非 / 路径如 /classroom.html');
});

test('#80 关闭/删除场次调用 loadLobby 且两阶段隔离刷新错误', () => {
  const js = read('public/js/classroom.js');
  assert.ok(!js.includes('loadMyClassrooms'), '不应残留不存在的 loadMyClassrooms 调用');
  assert.ok(js.includes('await loadLobby('), '关闭与删除场次应调用 loadLobby()');
  assert.ok(js.includes('场次已关闭，但列表刷新失败'), '关闭后刷新失败应明确提示已关闭');
  assert.ok(js.includes('场次已删除，但列表刷新失败'), '删除后刷新失败应明确提示已删除');
});

test('#81 半屏投入快捷按钮 2×4 布局与万元向下取整/超限置灰规则', () => {
  const html = read('public/classroom.html');
  const css = read('public/css/classroom.css');
  const presenter = require('../../public/js/presenters/classroom-presenter.js');
  for (const id of ['sheet-btn-zero', 'sheet-btn-25', 'sheet-btn-50', 'sheet-btn-max', 'sheet-btn-5w', 'sheet-btn-10w', 'sheet-btn-15w', 'sheet-btn-20w']) {
    assert.ok(html.includes(id), `classroom.html 应包含快捷按钮 ${id}`);
  }
  assert.ok(css.includes('min-height: 44px'), '快捷按钮最小高度应为 44px');
  const btns = presenter.computeQuickAllocButtons(12500000, 10000000); // 期初 12.5万, 上限 10万
  const byId = Object.fromEntries(btns.map((b) => [b.id, b]));
  assert.strictEqual(byId['sheet-btn-zero'].targetCents, 0);
  assert.strictEqual(byId['sheet-btn-zero'].disabled, false);
  assert.strictEqual(byId['sheet-btn-25'].targetCents, 3000000); // floor(12.5*0.25=3.125) -> 3万
  assert.strictEqual(byId['sheet-btn-25'].disabled, false);
  assert.strictEqual(byId['sheet-btn-50'].targetCents, 6000000); // floor(6.25) -> 6万
  assert.strictEqual(byId['sheet-btn-max'].targetCents, 12000000); // floor(12.5) -> 12万 > cap 10万
  assert.strictEqual(byId['sheet-btn-max'].disabled, true);
  assert.strictEqual(byId['sheet-btn-10w'].disabled, false);
  assert.strictEqual(byId['sheet-btn-15w'].disabled, true);
});

test('#82 手机端仅隐藏反馈浮框与股票灰色副标题，保留停牌与转债提示', () => {
  const js = read('public/js/classroom.js');
  const css = read('public/css/classroom.css');
  assert.ok(js.includes("nameSub.className = 'stat-sub cr-stock-name-sub'"), '股票副标题应使用 cr-stock-name-sub');
  assert.ok(css.includes('.fb-fab') && css.includes('.fb-float-panel') && css.includes('.cr-stock-name-sub'), '760px 媒体查询应隐藏反馈浮框与 cr-stock-name-sub');
  assert.ok(js.includes("span.className = 'stat-sub';") && js.includes('a.paused && a.pauseReason'), '停牌提示应继续使用 stat-sub 保留展示');
});

test('#83 移除 PRESET_INDUSTRIES 与 000333.SZ 硬编码并列出跨行业实际 SW2021 名称', () => {
  const js = read('public/js/classroom.js');
  const svc = read('server/services/classroomPrecheckService.js');
  assert.ok(!js.includes('PRESET_INDUSTRIES'), '应移除静态 PRESET_INDUSTRIES');
  assert.ok(!js.includes('000333.SZ'), '不应硬编码 2013 年上市的 000333.SZ');
  assert.ok(svc.includes('s.swIndustryName'), '跨行业错误应列出每只股票的实际 SW2021 一级行业名称');
});

test('#80/#83 F-01/F-02 刷新异常透传与抽样迟到失败守卫', () => {
  const js = read('public/js/classroom.js');
  assert.ok(js.includes('if (opts && opts.throwOnError) throw e;'), 'loadLobby/loadTeacherConsole/loadTeacherDetail 在 throwOnError 时必须透传异常');
  assert.ok(js.includes('await loadTeacherDetail(opts);'), 'loadTeacherConsole 应把 opts 透传给 loadTeacherDetail');
  assert.ok(js.includes('loadTeacherConsole({ throwOnError: true })') && js.includes('loadLobby({ throwOnError: true })'), '关闭/删除后刷新必须传 throwOnError: true');
  assert.ok(/catch \(e\) \{\s*const currentYear[\s\S]*?if \(reqSeq !== teacherOptionsState\.sampleReqSeq/.test(js), 'sampleTeacherSelection catch 必须校验 reqSeq 丢弃迟到失败');
});

console.log('PASS=' + pass + '  FAIL=' + fail);
if (fail) process.exit(1);

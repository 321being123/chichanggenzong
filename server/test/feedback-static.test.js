// ========== 反馈中心：静态契约一致性（2026-10-23） ==========
// 只做文件级断言，不连数据库：导航、访问矩阵、后台能力登记、路由注册顺序、依赖锁定。
// 这些是"改了文字却漏改另一处"的高发点，必须由自动检查兜住。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' —— ' + e.message); }
}
function read(rel) { return fs.readFileSync(path.join(root, rel), 'utf8'); }

console.log('--- 反馈中心静态契约 ---');

test('主站导航改为「反馈」且不再有旧键按钮', function () {
  const html = read('public/index.html');
  assert.ok(/data-main="feedback">反馈</.test(html), '主站导航应包含 data-main="feedback"');
  assert.ok(!/data-main="changelog"/.test(html), '主站导航不应再保留 data-main="changelog"');
});

test('登录页导航同步为「反馈」，避免两套栏目名', function () {
  const html = read('public/login.html');
  assert.ok(/main=feedback"/.test(html), '登录页导航应指向 main=feedback');
  assert.ok(!/main=changelog"/.test(html), '登录页不应再指向 main=changelog');
});

test('反馈页四个子栏目容器与懒加载脚本齐备', function () {
  const html = read('public/index.html');
  ['all', 'mine', 'ranking', 'versions'].forEach(function (sub) {
    assert.ok(html.indexOf('data-fb-sub="' + sub + '"') >= 0, '缺少子栏目 ' + sub);
  });
  assert.ok(html.indexOf('id="fb-body"') >= 0, '缺少反馈内容容器 #fb-body');
  assert.ok(/data-lazy-section="feedback"\s+src="js\/feedback\.js/.test(html), '反馈脚本应按栏目懒加载');
  assert.ok(html.indexOf('css/feedback.css') >= 0, '缺少反馈样式引用');
});

test('旧版本记录链接归一化到 feedback/sub=versions', function () {
  const html = read('public/index.html');
  assert.ok(html.indexOf("requestedMain === 'changelog'") >= 0, '启动段缺少旧键映射');
  const nav = read('public/js/navigation.js');
  assert.ok(nav.indexOf("main === 'changelog'") >= 0, 'switchMain 缺少旧键归一化');
  assert.ok(nav.indexOf("feedback: 'feedback'") >= 0, '缺少反馈栏目懒加载登记');
  assert.ok(nav.indexOf('loadFeedbackPage') >= 0, '缺少反馈页面入口调用');
});

test('访问矩阵保留公开别名 changelog 并加入 feedback', function () {
  const src = read('public/js/access-policy.js');
  assert.ok(/'feedback'/.test(src), 'ACCESS_POLICY 应包含 feedback');
  assert.ok(/'changelog'/.test(src), 'ACCESS_POLICY 应保留 changelog 公开别名');
});

test('统计页键白名单与看板文案包含反馈', function () {
  assert.ok(read('server/services/siteAnalytics.js').indexOf("'feedback.list'") >= 0, '统计页键白名单缺少 feedback.list');
  assert.ok(read('public/js/admin-analytics.js').indexOf("'feedback.list'") >= 0, '看板文案映射缺少 feedback.list');
});

test('后台菜单、视图容器、能力映射三者一致', function () {
  const html = read('public/admin.html');
  assert.ok(/data-view="feedback"/.test(html), '后台菜单缺少反馈管理');
  assert.ok(html.indexOf('id="view-feedback"') >= 0, '缺少反馈管理视图容器');
  assert.ok(html.indexOf('js/admin-feedback.js') >= 0, '缺少后台反馈脚本引用');
  const adminJs = read('public/js/admin.js');
  assert.ok(/feedback: '反馈管理'/.test(adminJs), 'VIEW_TITLES 缺少反馈');
  assert.ok(/feedback: 'content_manage'/.test(adminJs), 'VIEW_CAPABILITY 应把反馈登记为 content_manage');
  assert.ok(adminJs.indexOf("view === 'feedback'") >= 0, 'switchView 缺少反馈分支');
});

test('后台路径能力派发：/feedback 归 content_manage，未登记路径仍默认拒绝', function () {
  const { adminCapabilityForPath } = require('../routes/admin');
  assert.strictEqual(adminCapabilityForPath('/feedback'), 'content_manage');
  assert.strictEqual(adminCapabilityForPath('/feedback/releases'), 'content_manage');
  assert.strictEqual(adminCapabilityForPath('/feedback/12'), 'content_manage');
  assert.strictEqual(adminCapabilityForPath('/not-registered'), null);
});

test('前台路由固定路径先于 /:id 注册', function () {
  const src = read('server/routes/feedback.js');
  const idIndex = src.indexOf("router.get('/:id'");
  assert.ok(idIndex > 0, '缺少 /:id 路由');
  ['/mine', '/counts', '/ranking', '/version-links', '/attachments/:id'].forEach(function (p) {
    const idx = src.indexOf("router.get('" + p + "'");
    assert.ok(idx > 0, '缺少固定路径 ' + p);
    assert.ok(idx < idIndex, '固定路径 ' + p + ' 必须注册在 /:id 之前');
  });
});

test('后台发布接口先于 /:id 注册', function () {
  const src = read('server/routes/adminFeedback.js');
  const idIndex = src.indexOf("router.get('/:id'");
  assert.ok(idIndex > 0, '缺少 /:id 路由');
  assert.ok(src.indexOf("router.get('/releases'") < idIndex, '/releases 必须在 /:id 之前');
  assert.ok(src.indexOf("router.post('/releases'") < idIndex, 'POST /releases 必须在 /:id 之前');
});

test('后台反馈路由自身再次要求 content_manage', function () {
  const src = read('server/routes/adminFeedback.js');
  assert.ok(src.indexOf("requireCapability('content_manage')") >= 0, 'adminFeedback 应自行校验 content_manage');
  const adminJs = read('server/routes/admin.js');
  assert.ok(adminJs.indexOf("router.use('/feedback', require('./adminFeedback'))") >= 0, '应在既有权限链之后挂载反馈子路由');
});

test('审计模块登记 feedback_ 前缀', function () {
  assert.ok(read('server/db/config.js').indexOf("feedback: 'feedback_'") >= 0, 'AUDIT_MODULES 缺少 feedback');
});

test('迁移注册表把 170 作为最新一步，且按年代模块引入', function () {
  const src = read('server/db/migrations.js');
  assert.ok(src.indexOf("version: '170_feedback_module'") >= 0, '缺少 170 迁移');
  assert.ok(src.indexOf("require('./migrations/era07Feedback')") >= 0, '缺少 era07Feedback 引入');
  const idx170 = src.indexOf("version: '170_feedback_module'");
  const idx169 = src.indexOf("version: '169_instrument_name_cleanup'");
  assert.ok(idx169 < idx170, '170 必须排在 169 之后');
});

test('附件目录与图片上限在服务层集中定义', function () {
const src = read('server/services/feedbackService.js') + read('server/repositories/feedbackServiceRepository.js');
  assert.ok(src.indexOf('FEEDBACK_UPLOAD_DIR') >= 0, '附件目录应支持 FEEDBACK_UPLOAD_DIR 配置');
  assert.ok(/MAX_IMAGES = 3/.test(src), '最多 3 张截图');
  assert.ok(/MAX_FILE_BYTES = 2 \* 1024 \* 1024/.test(src), '单张接收上限 2MiB');
  assert.ok(/MAX_REQUEST_BYTES = 7 \* 1024 \* 1024/.test(src), '请求体上限 7MiB');
  assert.ok(/MAX_EDGE = 2048/.test(src), '最终长边 2048');
  assert.ok(/TARGET_FILE_BYTES = 1024 \* 1024/.test(src), '最终单张 1MiB');
  assert.ok(src.indexOf("require('sharp')") >= 0, '服务端必须用 sharp 真正解码重编码');
});

test('sharp 依赖锁定精确版本并声明在 dependencies', function () {
  const pkg = JSON.parse(read('package.json'));
  const declared = pkg.dependencies && pkg.dependencies.sharp;
  assert.ok(declared, 'dependencies 缺少 sharp');
  assert.ok(/^\d+\.\d+\.\d+$/.test(declared), 'sharp 必须锁定精确版本，实际为 ' + JSON.stringify(declared));
});

test('修复后的反馈模块文件均存在', function () {
  ['server/db/feedback.js', 'server/services/feedbackService.js', 'server/services/feedbackRelease.js',
    'server/routes/feedback.js', 'server/routes/adminFeedback.js', 'public/js/feedback.js',
    'public/js/admin-feedback.js', 'public/css/feedback.css', 'server/scripts/reconcileFeedbackRelease.js',
    'server/db/migrations/era07Feedback.js'].forEach(function (rel) {
    assert.ok(fs.existsSync(path.join(root, rel)), '缺少文件 ' + rel);
  });
});

test('反馈样式覆盖 760px 手机分界', function () {
  assert.ok(read('public/css/feedback.css').indexOf('@media (max-width: 760px)') >= 0, '缺少 760px 媒体查询');
});

// 2026-10-25 线上反馈 5 号：脚本 click() 唤起选择器在部分浏览器不生效，改回 label 关联
test('反馈表单图片入口用 label 关联文件域', function () {
  const js = read('public/js/feedback.js');
  assert.ok(/<label class="fb-img-btn" for="fb-form-files">/.test(js), '图片上传入口必须是 label[for="fb-form-files"]');
  assert.ok(!/id="fb-form-files"[^>]*\shidden/.test(js), '文件域不能用 hidden 属性，需靠 .fb-file-input 视觉隐藏');
  assert.ok(read('public/css/feedback.css').indexOf('.fb-file-input') >= 0, '缺少 .fb-file-input 视觉隐藏样式');
});

// 2026-10-25 线上反馈 5 号：缩略图走 URL.createObjectURL，CSP 不含 blob: 会被拦截成空白
test('CSP img-src 允许 blob:，否则反馈缩略图被拦截', function () {
  const src = read('server/middleware/security.js');
  const directive = src.match(/img-src[^"]*"/);
  assert.ok(directive, '缺少 img-src 指令');
  assert.ok(/\bblob:/.test(directive[0]), 'img-src 必须包含 blob:，实际为 ' + directive[0]);
});

console.log('\n--- 汇总 ---');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);

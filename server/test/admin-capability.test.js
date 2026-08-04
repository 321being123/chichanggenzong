// PERM-02 后台能力权限测试（运行态 + 源码静态断言，不依赖浏览器）
// 运行态：/api/admin 各模块按能力放行/拒绝（只读端点，无副作用）。
// 静态：共享数据刷新/导入、官方标杆发布等写端点已绑定对应能力，且不再使用 requireAdmin；
//       后台前端按能力隐藏菜单。
// 缺库时打印 ADMIN-CAPABILITY-SKIP 并跳过（不计入失败）。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const express = require('express');
const { pool, runMigrations } = require('../db');

const results = [];
async function check(name, fn) {
  try { await fn(); results.push('PASS'); console.log('  [PASS] ' + name); }
  catch (e) { results.push('FAIL'); console.log('  [FAIL] ' + name + ' :: ' + (e && e.message ? e.message : e)); }
}

const ROOT = path.join(__dirname, '..', '..');
function readSrc(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

(async () => {
  // ===== 静态断言（不依赖数据库）=====
  const bondSafetySrc = readSrc('server/routes/bondSafety.js');
  const bondValuationSrc = readSrc('server/routes/bondValuation.js');
  const marketVolatilitySrc = readSrc('server/routes/marketVolatility.js');
  const positionComparisonSrc = readSrc('server/routes/positionComparison.js');
  const adminRouteSrc = readSrc('server/routes/admin.js');
  const adminJsSrc = readSrc('public/js/admin.js');

  await check('可转债安全性刷新需要 ops_manage 能力', () => {
    assert.ok(bondSafetySrc.includes("router.post('/refresh', requireCapability('ops_manage')"),
      'bondSafety /refresh 未绑定 ops_manage');
  });
  await check('可转债估值刷新需要 ops_manage 能力', () => {
    assert.ok(bondValuationSrc.includes("router.post('/refresh', requireCapability('ops_manage')"),
      'bondValuation /refresh 未绑定 ops_manage');
  });
  await check('首页周期配置与利率文件导入需要 ops_manage 能力', () => {
    assert.ok(marketVolatilitySrc.includes("router.put('/home-cycle/config', requireCapability('ops_manage')"),
      '/home-cycle/config 未绑定 ops_manage');
    assert.ok(marketVolatilitySrc.includes("router.post('/federal-funds/import', requireCapability('ops_manage')"),
      '/federal-funds/import 未绑定 ops_manage');
  });
  await check('官方仓位标杆发布需要 benchmark_publish 能力且保留所有权校验', () => {
    assert.ok(positionComparisonSrc.includes("requireLogin, requireCapability('benchmark_publish'), assertOwnership"),
      'position-visibility 未绑定 benchmark_publish 或丢失所有权校验');
  });
  await check('已改造路由不再依赖 requireAdmin', () => {
    [['bondSafety', bondSafetySrc], ['bondValuation', bondValuationSrc],
     ['marketVolatility', marketVolatilitySrc], ['positionComparison', positionComparisonSrc],
     ['admin', adminRouteSrc]].forEach(function (pair) {
      assert.ok(pair[1].indexOf('requireAdmin') === -1, pair[0] + ' 仍在使用 requireAdmin');
    });
  });
  await check('后台入口使用 requireStaff 并按路径前缀派发能力', () => {
    assert.ok(adminRouteSrc.includes('router.use(requireStaff);'), '后台入口未使用 requireStaff');
    assert.ok(/function adminCapabilityForPath/.test(adminRouteSrc), '缺少能力派发函数');
    assert.ok(adminRouteSrc.includes("return 'user_manage'"), '缺少 user_manage 映射');
    assert.ok(adminRouteSrc.includes("return 'content_manage'"), '缺少 content_manage 映射');
    assert.ok(adminRouteSrc.includes("return 'ops_manage'"), '缺少 ops_manage 映射');
  });
  await check('后台前端按能力隐藏菜单（前端隐藏不作为安全边界）', () => {
    assert.ok(/const VIEW_CAPABILITY = \{/.test(adminJsSrc), '缺少 VIEW_CAPABILITY 映射');
    assert.ok(/function applyMenuPermissions/.test(adminJsSrc), '缺少 applyMenuPermissions');
    assert.ok(adminJsSrc.includes('applyMenuPermissions();'), '初始化未调用 applyMenuPermissions');
    assert.ok(adminJsSrc.indexOf("if (d.role !== 'admin') { window.location.href") === -1,
      '后台仍按 role 硬性拦截，未支持能力用户');
  });

  // ===== 运行态矩阵（需要数据库）=====
  let hasDb = true;
  try { await pool.query('SELECT 1'); } catch (e) { hasDb = false; }
  if (!hasDb) {
    console.log('ADMIN-CAPABILITY-SKIP (no database)');
    process.exit(0);
  }
  try { await runMigrations(); } catch (e) { /* 交由后续查询暴露 */ }

  const users = {};
  async function makeUser(name, opt) {
    opt = opt || {};
    await pool.query('DELETE FROM users WHERE username=$1', [name]);
    await pool.query(
      "INSERT INTO users (username, password, accounts, role, status, auth_version, permissions) VALUES ($1,'x','[]',$2,'active',1,$3)",
      [name, opt.role || 'user', JSON.stringify(opt.perms || {})]
    );
    users[name] = 1;
  }
  await makeUser('perm2_plain');
  await makeUser('perm2_user', { perms: { user_manage: true } });
  await makeUser('perm2_ops', { perms: { ops_manage: true } });
  await makeUser('perm2_content', { perms: { content_manage: true } });
  await makeUser('perm2_admin', { role: 'admin' });

  const app = express();
  app.use(express.json());
  app.use(function (req, res, next) {
    if (!req.session) req.session = {};
    const u = req.headers['x-test-user'];
    if (u && users[u] !== undefined) { req.session.user = u; req.session.authVersion = users[u]; }
    next();
  });
  app.use('/api/admin', require('../routes/admin'));

  const server = await new Promise(function (resolve) {
    const s = app.listen(0, '127.0.0.1', function () { resolve(s); });
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  function get(p, user) {
    return fetch(base + p, { headers: user ? { 'x-test-user': user } : {} });
  }

  await check('未登录访问后台：401', async () => {
    assert.strictEqual((await get('/api/admin/overview')).status, 401);
  });
  await check('无任何能力的普通用户：后台概览 403', async () => {
    assert.strictEqual((await get('/api/admin/overview', 'perm2_plain')).status, 403);
  });
  await check('有任一能力即可看概览与审计', async () => {
    assert.strictEqual((await get('/api/admin/overview', 'perm2_ops')).status, 200);
    assert.strictEqual((await get('/api/admin/audit', 'perm2_user')).status, 200);
  });
  await check('用户管理：user_manage 通过、ops/content 拒绝', async () => {
    assert.strictEqual((await get('/api/admin/users', 'perm2_user')).status, 200);
    assert.strictEqual((await get('/api/admin/users', 'perm2_ops')).status, 403);
    assert.strictEqual((await get('/api/admin/users', 'perm2_content')).status, 403);
  });
  await check('内容管理：content_manage 通过、user/ops 拒绝', async () => {
    assert.strictEqual((await get('/api/admin/knowledge/articles', 'perm2_content')).status, 200);
    assert.strictEqual((await get('/api/admin/knowledge/articles', 'perm2_user')).status, 403);
    assert.strictEqual((await get('/api/admin/knowledge/articles', 'perm2_ops')).status, 403);
  });
  await check('运维模块（券商/任务/休市日/模型/全局参数）：ops_manage 通过', async () => {
    for (const p of ['/brokers', '/jobs', '/holidays', '/models', '/settings']) {
      assert.strictEqual((await get('/api/admin' + p, 'perm2_ops')).status, 200, p + ' 未放行 ops_manage');
    }
  });
  await check('运维模块：无 ops_manage 一律拒绝', async () => {
    for (const p of ['/brokers', '/jobs', '/holidays', '/models', '/settings']) {
      assert.strictEqual((await get('/api/admin' + p, 'perm2_content')).status, 403, p + ' 未拦截无能力用户');
    }
  });
  await check('管理员：用户/内容/运维全部通过', async () => {
    for (const p of ['/users', '/knowledge/articles', '/brokers', '/settings']) {
      assert.strictEqual((await get('/api/admin' + p, 'perm2_admin')).status, 200, p + ' 管理员被拒');
    }
  });

  server.close();
  for (const u of Object.keys(users)) await pool.query('DELETE FROM users WHERE username=$1', [u]).catch(function () {});
  const failed = results.filter(function (r) { return r === 'FAIL'; }).length;
  console.log('admin-capability: ' + results.length + ' 项检查，失败 ' + failed);
  process.exit(failed ? 1 : 0);
})().catch(function (e) { console.error(e); process.exit(1); });

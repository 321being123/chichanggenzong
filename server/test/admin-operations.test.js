// OPS-01 后台“数据运维”入口测试（运行态 + 源码静态断言，不依赖浏览器）
// 运行态：共享数据刷新/导入端点按 ops_manage 能力放行/拒绝；后台任务列表对运维能力可见。
// 静态：新增数据运维菜单与视图；前台管理员刷新按钮（bond-safety-refresh）已移除。
// 缺库时打印 ADMIN-OPS-SKIP 并跳过（不计入失败）。
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
  const adminHtmlSrc = readSrc('public/admin.html');
  const adminJsSrc = readSrc('public/js/admin.js');
  const indexHtmlSrc = readSrc('public/index.html');
  const bondSafetyJsSrc = readSrc('public/js/bond-safety.js');

  await check('后台新增“数据运维”菜单与视图容器', () => {
    assert.ok(adminHtmlSrc.includes('data-view="ops"'), '后台缺少数据运维菜单项');
    assert.ok(adminHtmlSrc.includes('id="view-ops"'), '后台缺少 view-ops 视图容器');
  });
  await check('数据运维视图接入（标题/能力/渲染路由）', () => {
    assert.ok(adminJsSrc.includes("ops: '数据运维'"), 'VIEW_TITLES 缺少 ops');
    assert.ok(adminJsSrc.includes("ops: 'ops_manage'"), 'VIEW_CAPABILITY 缺少 ops:ops_manage');
    assert.ok(/function renderOps\(/.test(adminJsSrc), '缺少 renderOps 函数');
    assert.ok(adminJsSrc.includes("else if (view === 'ops') renderOps()"), 'switchView 未接入 renderOps');
  });
  await check('前台管理员刷新按钮已移除（迁至后台数据运维）', () => {
    assert.ok(indexHtmlSrc.indexOf('id="bond-safety-refresh"') === -1, '前台仍残留 bond-safety-refresh 按钮');
    assert.ok(bondSafetyJsSrc.indexOf('function refreshBondSafety') === -1, 'bond-safety.js 仍定义 refreshBondSafety');
  });

  // ===== 运行态（需要数据库）=====
  let hasDb = true;
  try { await pool.query('SELECT 1'); } catch (e) { hasDb = false; }
  if (!hasDb) {
    console.log('ADMIN-OPS-SKIP (no database)');
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
  await makeUser('ops_plain');
  await makeUser('ops_has', { perms: { ops_manage: true } });
  await makeUser('ops_admin', { role: 'admin' });

  const app = express();
  app.use(express.json());
  app.use(function (req, res, next) {
    if (!req.session) req.session = {};
    const u = req.headers['x-test-user'];
    if (u && users[u] !== undefined) { req.session.user = u; req.session.authVersion = users[u]; }
    next();
  });
  app.use('/api/admin', require('../routes/admin'));
  app.use('/api/bond-safety', require('../routes/bondSafety'));
  app.use('/api/bond-valuation', require('../routes/bondValuation'));
  app.use('/api/market-volatility', require('../routes/marketVolatility'));

  const server = await new Promise(function (resolve) {
    const s = app.listen(0, '127.0.0.1', function () { resolve(s); });
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  function call(method, p, user, body) {
    const headers = {};
    if (user) headers['x-test-user'] = user;
    if (body) { headers['Content-Type'] = 'application/json'; }
    return fetch(base + p, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined });
  }

  await check('未登录刷新安全性：401', async () => {
    assert.strictEqual((await call('POST', '/api/bond-safety/refresh')).status, 401);
  });
  await check('无能力用户刷新安全性：403', async () => {
    assert.strictEqual((await call('POST', '/api/bond-safety/refresh', 'ops_plain')).status, 403);
  });
  await check('无能力用户刷新估值：403', async () => {
    assert.strictEqual((await call('POST', '/api/bond-valuation/refresh', 'ops_plain')).status, 403);
  });
  await check('无能力用户导入利率文件：403', async () => {
    assert.strictEqual((await call('POST', '/api/market-volatility/federal-funds/import', 'ops_plain')).status, 403);
  });
  await check('运维能力用户：任务列表可见（200）', async () => {
    assert.strictEqual((await call('GET', '/api/admin/jobs', 'ops_has')).status, 200);
    assert.strictEqual((await call('GET', '/api/admin/jobs', 'ops_admin')).status, 200);
  });
  await check('无能力用户：任务列表拒绝（403）', async () => {
    assert.strictEqual((await call('GET', '/api/admin/jobs', 'ops_plain')).status, 403);
  });
  await check('运维能力用户导入利率（无文件）：400（过能力校验但缺文件，不触发外部调用）', async () => {
    assert.strictEqual((await call('POST', '/api/market-volatility/federal-funds/import', 'ops_has')).status, 400);
  });

  server.close();
  for (const u of Object.keys(users)) await pool.query('DELETE FROM users WHERE username=$1', [u]).catch(function () {});
  const failed = results.filter(function (r) { return r === 'FAIL'; }).length;
  console.log('admin-operations: ' + results.length + ' 项检查，失败 ' + failed);
  process.exit(failed ? 1 : 0);
})().catch(function (e) { console.error(e); process.exit(1); });

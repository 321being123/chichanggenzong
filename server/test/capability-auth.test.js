// PERM-01 能力权限矩阵接口测试（运行态，不依赖浏览器）
// 验证：普通用户无能力被拒；单项能力只可进入对应接口；管理员全通过；
// 禁用或会话版本失效无论能力如何均拒绝；/me 返回白名单过滤的能力布尔值。
// 缺库时打印 CAPABILITY-AUTH-SKIP 并跳过（不计入失败）。
const assert = require('assert');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const express = require('express');
const { pool, runMigrations } = require('../db');
const { requireStaff, requireCapability } = require('../middleware/auth');
const authRouter = require('../routes/auth');

const results = [];
async function check(name, fn) {
  try { await fn(); results.push('PASS'); console.log('  [PASS] ' + name); }
  catch (e) { results.push('FAIL'); console.log('  [FAIL] ' + name + ' :: ' + (e && e.message ? e.message : e)); }
}

(async () => {
  let hasDb = true;
  try { await pool.query('SELECT 1'); } catch (e) { hasDb = false; }
  if (!hasDb) {
    console.log('CAPABILITY-AUTH-SKIP (no database)');
    process.exit(0);
  }

  // 确保本地库已应用最新迁移（含 050 permissions 列），与服务器启动行为一致、幂等。
  try { await runMigrations(); } catch (e) { /* 迁移失败不阻断测试，交由后续查询暴露 */ }

  // ===== 创建测试用户（用后立即清理）=====
  const users = {};
  async function makeUser(name, opt) {
    opt = opt || {};
    const role = opt.role || 'user';
    const status = opt.status || 'active';
    const perms = opt.perms || {};
    await pool.query('DELETE FROM users WHERE username=$1', [name]);
    await pool.query(
      "INSERT INTO users (username, password, accounts, role, status, auth_version, permissions) VALUES ($1,'x','[]',$2,$3,1,$4) " +
      "ON CONFLICT (username) DO UPDATE SET role=$2, status=$3, auth_version=1, permissions=$4",
      [name, role, status, JSON.stringify(perms)]
    );
    const { rows } = await pool.query('SELECT auth_version FROM users WHERE username=$1', [name]);
    users[name] = rows[0].auth_version;
  }
  await makeUser('cap_plain');
  await makeUser('cap_content', { perms: { content_manage: true } });
  await makeUser('cap_ops', { perms: { ops_manage: true } });
  await makeUser('cap_admin', { role: 'admin' });
  await makeUser('cap_disabled', { perms: { content_manage: true }, status: 'disabled' });
  await makeUser('cap_badmin', { role: 'admin', status: 'disabled' });

  // ===== 测试 mini-app（用请求头注入登录态，避免真实会话依赖）=====
  const app = express();
  app.use(express.json());
  app.use(function (req, res, next) {
    if (!req.session) req.session = {};
    const u = req.headers['x-test-user'];
    if (u && users[u] !== undefined) {
      req.session.user = u;
      req.session.authVersion = Number(req.headers['x-test-version'] || users[u]);
    }
    next();
  });
  app.get('/api/cap/staff', requireStaff, function (req, res) { res.json({ ok: true }); });
  app.get('/api/cap/content', requireCapability('content_manage'), function (req, res) { res.json({ ok: true }); });
  app.get('/api/cap/ops', requireCapability('ops_manage'), function (req, res) { res.json({ ok: true }); });
  app.use('/api', authRouter);

  const server = await new Promise(function (resolve) {
    const s = app.listen(0, '127.0.0.1', function () { resolve(s); });
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  function get(p, user, version) {
    const h = {};
    if (user) {
      h['x-test-user'] = user;
      if (version !== undefined) h['x-test-version'] = String(version);
    }
    return fetch(base + p, { headers: h });
  }

  // ===== 矩阵 =====
  await check('普通用户无能力：staff 拒绝 403', async () => {
    assert.strictEqual((await get('/api/cap/staff', 'cap_plain')).status, 403);
  });
  await check('普通用户无能力：content 拒绝 403', async () => {
    assert.strictEqual((await get('/api/cap/content', 'cap_plain')).status, 403);
  });
  await check('仅 content_manage：content 通过 200', async () => {
    assert.strictEqual((await get('/api/cap/content', 'cap_content')).status, 200);
  });
  await check('仅 content_manage：ops 拒绝 403', async () => {
    assert.strictEqual((await get('/api/cap/ops', 'cap_content')).status, 403);
  });
  await check('仅 content_manage：staff 通过 200', async () => {
    assert.strictEqual((await get('/api/cap/staff', 'cap_content')).status, 200);
  });
  await check('仅 ops_manage：ops 通过 200', async () => {
    assert.strictEqual((await get('/api/cap/ops', 'cap_ops')).status, 200);
  });
  await check('仅 ops_manage：content 拒绝 403', async () => {
    assert.strictEqual((await get('/api/cap/content', 'cap_ops')).status, 403);
  });
  await check('管理员：staff/content/ops 全 200', async () => {
    assert.strictEqual((await get('/api/cap/staff', 'cap_admin')).status, 200);
    assert.strictEqual((await get('/api/cap/content', 'cap_admin')).status, 200);
    assert.strictEqual((await get('/api/cap/ops', 'cap_admin')).status, 200);
  });
  await check('禁用用户（有 content 能力）：staff/content 均 403', async () => {
    assert.strictEqual((await get('/api/cap/staff', 'cap_disabled')).status, 403);
    assert.strictEqual((await get('/api/cap/content', 'cap_disabled')).status, 403);
  });
  await check('禁用管理员：均 403', async () => {
    assert.strictEqual((await get('/api/cap/ops', 'cap_badmin')).status, 403);
  });
  await check('会话版本失效：401', async () => {
    assert.strictEqual((await get('/api/cap/content', 'cap_content', users['cap_content'] + 99)).status, 401);
  });
  await check('/me 返回白名单能力布尔值（content_manage=true，其余 false）', async () => {
    const r = await get('/api/me', 'cap_content');
    assert.strictEqual(r.status, 200);
    const d = await r.json();
    assert.strictEqual(d.capabilities.content_manage, true);
    assert.strictEqual(d.capabilities.ops_manage, false);
    assert.strictEqual(d.capabilities.knowledge_write, false);
    assert.strictEqual(d.capabilities.benchmark_publish, false);
  });
  await check('/me 管理员：全部能力 true', async () => {
    const r = await get('/api/me', 'cap_admin');
    const d = await r.json();
    assert.strictEqual(d.capabilities.content_manage, true);
    assert.strictEqual(d.capabilities.ops_manage, true);
    assert.strictEqual(d.capabilities.benchmark_publish, true);
  });
  await check('未知能力一律拒绝（白名单外字符串）', async () => {
    // 直接调用 hasCapability 验证白名单外能力不被授权
    const { hasCapability } = require('../middleware/auth');
    assert.strictEqual(hasCapability({ username: 'x', role: 'user', permissions: { super_power: true } }, 'super_power'), false);
  });

  server.close();
  for (const u of Object.keys(users)) await pool.query('DELETE FROM users WHERE username=$1', [u]).catch(function () {});
  const failed = results.filter(function (r) { return r === 'FAIL'; }).length;
  console.log('capability-auth: ' + results.length + ' 项检查，失败 ' + failed);
  process.exit(failed ? 1 : 0);
})().catch(function (e) { console.error(e); process.exit(1); });

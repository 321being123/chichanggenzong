// ========== AUTH-01：禁用/删号/改密后吊销旧 Session（P0）==========
// 方式：monkeypatch 权限中间件使用的 pool.query，返回按用户预设的状态/角色/会话版本，
//       直接驱动 requireLogin / requireAdmin，验证"失效即拒绝 + 缓存复用 + 改密递增版本"。
// 不依赖真实 PG。运行：node server/test/auth-session-revocation.test.js
const assert = require('assert');

// 预设用户（status / role / auth_version）
const USERS = {
  alice: { username: 'alice', role: 'user', status: 'active', auth_version: 1 },
  bob: { username: 'bob', role: 'user', status: 'disabled', auth_version: 1 }, // 已禁用
  carol: { username: 'carol', role: 'user', status: 'active', auth_version: 2 }, // 版本已递增
  admin: { username: 'admin', role: 'admin', status: 'active', auth_version: 1 },
  badadmin: { username: 'badadmin', role: 'admin', status: 'disabled', auth_version: 1 }, // 管理员被禁用
  legacy: { username: 'legacy', role: 'user', status: 'active', auth_version: 1 }, // 白名单管理员
};

const db = require('../db');
let userQueryCount = 0;
db.pool.query = async (text, params) => {
  if (/FROM users/.test(text)) {
    userQueryCount++;
    const u = params && params[0] ? USERS[params[0]] : null;
    return { rows: u ? [u] : [] };
  }
  return { rows: [] };
};

process.env.ADMIN_USERS = 'legacy'; // 环境变量白名单管理员

const auth = require('../middleware/auth');

function run(mw, session) {
  // 复用同一 req 对象：使同一次会话的 requireLogin 缓存可被子后续 requireAdmin 复用（对应 check 的「1 次查库」断言）
  const req = session.__req || (session.__req = { session });
  let settled = false;
  let resolve;
  function settle(val) { if (settled) return; settled = true; resolve(val); }
  const res = { code: 200, payload: null, status(c) { this.code = c; return this; }, json(p) { this.payload = p; settle({ req, res, nexted: false, err: null }); return this; } };
  return new Promise((res2) => {
    resolve = res2;
    mw(req, res, (e) => settle({ req, res, nexted: !e, err: e }));
  });
}
function session(over) {
  return Object.assign({ user: 'alice', authVersion: 1, destroy(cb) { this.destroyed = true; if (cb) cb(); } }, over || {});
}

const results = [];
function check(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    results.push(['PASS', name]); console.log('  [PASS] ' + name);
  }).catch((e) => {
    results.push(['FAIL', name + ' :: ' + (e && e.message)]); console.log('  [FAIL] ' + name + ' :: ' + (e && e.message));
  });
}

async function main() {
  await check('正常用户 + 版本一致：放行', async () => {
    const r = await run(auth.requireLogin, session());
    assert.strictEqual(r.nexted, true);
    assert.strictEqual(r.res.code, 200);
  });

  await check('已禁用用户：401 且销毁会话', async () => {
    const s = session({ user: 'bob' });
    const r = await run(auth.requireLogin, s);
    assert.strictEqual(r.res.code, 403);
    assert.strictEqual(r.nexted, false);
    assert.strictEqual(s.destroyed, true);
  });

  await check('已删除用户（库无记录）：401 且销毁会话', async () => {
    const s = session({ user: 'ghost' });
    const r = await run(auth.requireLogin, s);
    assert.strictEqual(r.res.code, 401);
    assert.strictEqual(s.destroyed, true);
  });

  await check('会话版本与库不一致（密码已改）：401', async () => {
    const s = session({ user: 'carol', authVersion: 1 }); // 库里 carol.auth_version=2
    const r = await run(auth.requireLogin, s);
    assert.strictEqual(r.res.code, 401);
    assert.strictEqual(s.destroyed, true);
  });

  await check('无会话：401', async () => {
    const r = await run(auth.requireLogin, {});
    assert.strictEqual(r.res.code, 401);
  });

  await check('公开路由可选登录：游客与正常会话均放行', async () => {
    assert.strictEqual((await run(auth.optionalLogin, {})).nexted, true);
    const active = await run(auth.optionalLogin, session({ user: 'alice' }));
    assert.strictEqual(active.nexted, true);
    assert.strictEqual(active.req.authUser.username, 'alice');
  });

  await check('公开路由可选登录：失效会话销毁后按游客放行', async () => {
    const s = session({ user: 'carol', authVersion: 1 });
    const r = await run(auth.optionalLogin, s);
    assert.strictEqual(r.nexted, true);
    assert.strictEqual(s.destroyed, true);
    assert.strictEqual(r.req.authUser, undefined);
  });

  await check('数据库管理员：requireAdmin 放行', async () => {
    const r = await run(auth.requireAdmin, session({ user: 'admin' }));
    assert.strictEqual(r.nexted, true);
  });

  await check('白名单管理员（role=user 但在 ADMIN_USERS）：requireAdmin 放行', async () => {
    const r = await run(auth.requireAdmin, session({ user: 'legacy' }));
    assert.strictEqual(r.nexted, true);
  });

  await check('管理员被禁用：requireAdmin 立即拒绝并销毁会话', async () => {
    const s = session({ user: 'badadmin' });
    const r = await run(auth.requireAdmin, s);
    assert.strictEqual(r.nexted, false);
    assert.ok(r.res.code === 401 || r.res.code === 403);
    assert.strictEqual(s.destroyed, true);
  });

  await check('普通用户调用管理员接口：403', async () => {
    const r = await run(auth.requireAdmin, session({ user: 'alice' }));
    assert.strictEqual(r.res.code, 403);
  });

  await check('同请求 requireLogin 后再 requireAdmin 只查一次用户', async () => {
    userQueryCount = 0;
    const s = session({ user: 'admin' });
    const r1 = await run(auth.requireLogin, s);
    assert.strictEqual(r1.req.authUser && r1.req.authUser.username, 'admin', 'requireLogin 应缓存 req.authUser');
    await run(auth.requireAdmin, s); // 复用同一 req 的 req.authUser，不应再查库
    assert.strictEqual(userQueryCount, 1, 'requireAdmin 应复用 req.authUser，不重复查库');
  });

  await check('旧会话无 authVersion（改密失效机制 P0）：401 且销毁会话', async () => {
    // 老 Session 在改密前签发，不带 authVersion 字段；移除守卫后必须一律判定失效
    const s = session({ user: 'alice', authVersion: undefined });
    const r = await run(auth.requireLogin, s);
    assert.strictEqual(r.res.code, 401);
    assert.strictEqual(s.destroyed, true);
  });

  // ====== users.js：改密/禁用/改角色 递增 auth_version；旧哈希升级不递增 ======
  let lastSql = '';
  db.pool.query = async (text) => { lastSql = text; return { rowCount: 1, rows: [] }; };
  const users = require('../db');

  await check('setUserStatus 递增 auth_version', async () => {
    lastSql = ''; await users.setUserStatus('x', 'disabled');
    assert.ok(/auth_version\s*=\s*auth_version\s*\+\s*1/.test(lastSql), 'SQL 应递增版本：' + lastSql);
  });
  await check('setUserRole 递增 auth_version', async () => {
    lastSql = ''; await users.setUserRole('x', 'admin');
    assert.ok(/auth_version\s*=\s*auth_version\s*\+\s*1/.test(lastSql));
  });
  await check('setKnowledgeEnabled 同步 knowledge_write 并递增 auth_version', async () => {
    lastSql = ''; await users.setKnowledgeEnabled('x', false);
    assert.ok(/knowledge_write/.test(lastSql));
    assert.ok(/auth_version\s*=\s*auth_version\s*\+\s*1/.test(lastSql));
  });
  await check('adminSetPassword 递增 auth_version', async () => {
    lastSql = ''; await users.adminSetPassword('x', 'hash');
    assert.ok(/auth_version\s*=\s*auth_version\s*\+\s*1/.test(lastSql));
  });
  await check('changePassword（本人/找回改密）递增 auth_version', async () => {
    lastSql = ''; await users.changePassword('x', 'hash');
    assert.ok(/auth_version\s*=\s*auth_version\s*\+\s*1/.test(lastSql));
  });
  await check('upgradePasswordHash（旧哈希透明升级）不递增 auth_version', async () => {
    lastSql = ''; await users.upgradePasswordHash('x', 'hash');
    assert.ok(!/auth_version/.test(lastSql), '透明升级不应触碰版本：' + lastSql);
  });

  const failed = results.filter(r => r[0] === 'FAIL');
  console.log('\n==== AUTH-01 结果: ' + (results.length - failed.length) + '/' + results.length + ' 通过 ====');
  if (failed.length) { failed.forEach(f => console.log('  - ' + f[1])); process.exit(1); }
  console.log('全部通过 ✅');
}
main().catch(e => { console.error(e); process.exit(1); });

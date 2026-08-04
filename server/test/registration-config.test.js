// ========== AUTH-02：注册配置与注册页完全一致（P0）==========
// 方式：monkeypatch db.getConfig / config.mailer，按用例重建 router（mailer 在加载时按值捕获），
//       验证 /api/config 返回四项开关，且 /register 作为最终校验与配置一致。
// 运行：node server/test/registration-config.test.js
const assert = require('assert');

const db = require('../db');
const config = require('../config');

// 配置桩
let store = {};
db.getConfig = async (k, def) => (k in store ? store[k] : (def === undefined ? '' : def));
db.registerUser = async () => true;
db.updateUserProfile = async () => {};
db.syncUserAccounts = async () => {};
db.getUserAuth = async () => ({ username: 'x', password: 'x', role: 'user', status: 'active', email: 'x', auth_version: 1 });
db.getUserForPasswordReset = async () => null;
db.changePassword = async () => {};

// mailer 在路由加载时按值捕获，故按 mailer 状态重建 router
function buildRouter(mailerVal) {
  config.mailer = mailerVal;
  delete require.cache[require.resolve('../routes/auth')];
  return require('../routes/auth');
}

let router = buildRouter(null);

async function invoke(path, body, session = {}) {
  const layer = router.stack.find(item => item.route && item.route.path === path);
  assert.ok(layer, '未找到路由：' + path);
  const req = { body, session, ip: 'test-' + Math.random().toString(36).slice(2), connection: {} };
  const response = { status: 200, body: undefined };
  const res = {
    status(code) { response.status = code; return this; },
    json(payload) { response.body = payload; return this; }
  };
  for (const middleware of layer.route.stack) {
    let cont = false;
    await new Promise((resolve, reject) => {
      const next = (error) => { if (error) return reject(error); cont = true; resolve(); };
      Promise.resolve(middleware.handle(req, res, next)).then(resolve, reject);
    });
    if (!cont) break;
  }
  return { req, response };
}

const results = [];
async function check(name, fn) {
  try { await fn(); results.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (e) { results.push(['FAIL', name + ' :: ' + (e && e.message)]); console.log('  [FAIL] ' + name + ' :: ' + (e && e.message)); }
}

async function main() {
  // 1) /api/config：邮件可用
  await check('/api/config 返回四项开关（邮件可用）', async () => {
    store = { register_open: '1', register_code: '', require_email: '0' };
    router = buildRouter({ sendMail: async () => ({}) });
    const r = await invoke('/config', {});
    assert.strictEqual(r.response.status, 200);
    assert.strictEqual(r.response.body.registerOpen, true);
    assert.strictEqual(r.response.body.needRegisterCode, false);
    assert.strictEqual(r.response.body.requireEmail, false);
    assert.strictEqual(r.response.body.emailServiceAvailable, true);
  });

  // 2) /api/config：要求邮箱但邮件不可用
  await check('/api/config 邮件不可用时 emailServiceAvailable=false', async () => {
    store = { register_open: '1', register_code: '', require_email: '1' };
    router = buildRouter(null);
    const r = await invoke('/config', {});
    assert.strictEqual(r.response.body.requireEmail, true);
    assert.strictEqual(r.response.body.emailServiceAvailable, false);
  });

  // 3) 注册关闭 → 拒绝
  await check('注册关闭时 /register 拒绝（403）', async () => {
    store = { register_open: '0', register_code: '', require_email: '0' };
    router = buildRouter(null);
    const r = await invoke('/register', { username: 'new', password: 'secret1' });
    assert.strictEqual(r.response.status, 403);
  });

  // 4) 开放 + 不要求邮箱 → 成功
  await check('开放且不需要邮箱时注册成功（200）', async () => {
    store = { register_open: '1', register_code: '', require_email: '0' };
    router = buildRouter(null);
    const r = await invoke('/register', { username: 'new', password: 'secret1' });
    assert.strictEqual(r.response.status, 200);
    assert.strictEqual(r.response.body.ok, true);
  });

  // 5) 要求邮箱但邮件服务不可用 → 503
  await check('要求邮箱但邮件服务不可用 → 503', async () => {
    store = { register_open: '1', register_code: '', require_email: '1' };
    router = buildRouter(null);
    const r = await invoke('/register', { username: 'new', password: 'secret1', email: 'a@b.com', emailCode: '123456' });
    assert.strictEqual(r.response.status, 503);
  });

  // 6) 要求邮箱且服务可用 → 缺验证码被拒（400）
  await check('要求邮箱且服务可用时，缺验证码被拒（400）', async () => {
    store = { register_open: '1', register_code: '', require_email: '1' };
    router = buildRouter({ sendMail: async () => ({}) });
    const r = await invoke('/register', { username: 'new', password: 'secret1', email: 'a@b.com' });
    assert.strictEqual(r.response.status, 400);
  });

  // 7) 邀请码：缺码 → 400；正确 → 200
  await check('开启邀请码且缺码 → 400', async () => {
    store = { register_open: '1', register_code: 'SECRET', require_email: '0' };
    router = buildRouter(null);
    const r = await invoke('/register', { username: 'new', password: 'secret1' });
    assert.strictEqual(r.response.status, 400);
  });
  await check('开启邀请码且正确 → 200', async () => {
    store = { register_open: '1', register_code: 'SECRET', require_email: '0' };
    router = buildRouter(null);
    const r = await invoke('/register', { username: 'new', password: 'secret1', code: 'SECRET' });
    assert.strictEqual(r.response.status, 200);
  });

  const failed = results.filter(x => x[0] === 'FAIL');
  console.log('\n==== AUTH-02 结果: ' + (results.length - failed.length) + '/' + results.length + ' 通过 ====');
  if (failed.length) { failed.forEach(f => console.log('  - ' + f[1])); process.exit(1); }
  console.log('全部通过 ✅');
}
main().catch(e => { console.error(e); process.exit(1); });

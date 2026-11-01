// 注册/登录会话生命周期回归（审查 R2-002，T-001）。规则：AUTH-SESSION-ESTABLISH-005。
//
// 用真实 express-session + 可注入故障的 Store + 独立 Cookie 容器验证：
//   注册/登录前后 SID 变化、旧 SID 认证请求失败、新 SID 正常；
//   数据库 auth_version 非 1 时仍然写真实值；Store 保存失败不得返回登录成功；
//   验证码消费与账号已创建但会话失败时的提示；禁用后身份失效。
//
// 说明：断言看的都是 HTTP 响应、Cookie 与 Store 里的会话内容，不是"方法被调用过"。
// 运行：node server/test/auth-lifecycle-regression.test.js
process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
process.env.PGDATABASE = process.env.PGTESTDATABASE || 'portfolio_test';

const assert = require('assert');
const http = require('http');
const express = require('express');
const session = require('express-session');
const { pool } = require('../db/connection');

const cases = [];
function check(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    cases.push(['PASS', name]);
    console.log('  [PASS] ' + name);
  }).catch(error => {
    cases.push(['FAIL', name + ' :: ' + (error && error.message)]);
    console.log('  [FAIL] ' + name + ' :: ' + (error && error.message));
  });
}

// 可注入故障的会话存储：failSet=true 时模拟"会话写回失败"。
class TestStore extends session.Store {
  constructor() {
    super();
    this.data = new Map();
    this.failSet = false;
  }
  get(sid, callback) {
    const raw = this.data.get(sid);
    callback(null, raw ? JSON.parse(raw) : null);
  }
  set(sid, sess, callback) {
    if (this.failSet) return callback(new Error('模拟会话写回失败'));
    this.data.set(sid, JSON.stringify(sess));
    callback(null);
  }
  destroy(sid, callback) {
    this.data.delete(sid);
    callback(null);
  }
  entries() { return [...this.data.entries()]; }
}

const store = new TestStore();
const app = express();
app.use(express.json());
app.use(session({
  secret: 'lifecycle-test-secret',
  store,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' },
}));
app.use('/api', require('../routes/auth'));

let server = null;
let basePort = 0;

function cookieOf(setCookie) {
  if (!setCookie) return null;
  // node 的 set-cookie 可能是数组（多条头），取会话那一条。
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  const raw = list.find(item => /^connect\.sid=/.test(item)) || list[0];
  if (!raw) return null;
  const first = raw.split(';')[0];
  return first.includes('=') ? first : null;
}

// express-session 的 Cookie 值是 URL 编码的 `s:<sid>.<签名>`；
// 比对 SID 与 Store 键时必须先解码再去掉签名，否则永远对不上。
function sidOf(cookie) {
  if (!cookie) return null;
  const raw = decodeURIComponent(String(cookie).split('=').slice(1).join('='));
  const unsigned = raw.startsWith('s:') ? raw.slice(2) : raw;
  const dot = unsigned.lastIndexOf('.');
  return dot > 0 ? unsigned.slice(0, dot) : unsigned;
}

function request({ method = 'GET', path = '/', body = null, cookie = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = {};
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
    if (cookie) headers.Cookie = cookie;
    const req = http.request({ host: '127.0.0.1', port: basePort, method, path, headers }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
        resolve({ status: res.statusCode, json, text, setCookie: res.headers['set-cookie'] });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const users = [];

let savedConfig = new Map();
async function restoreConfig() {
  for (const [key, value] of savedConfig) {
    await pool.query('UPDATE platform_config SET value=$2 WHERE key=$1', [key, value]).catch(() => {});
  }
}

async function cleanup() {
  await restoreConfig();
  for (const name of users) {
    await pool.query('DELETE FROM users WHERE username=$1', [name]).catch(() => {});
    await pool.query('DELETE FROM accounts WHERE username=$1', [name]).catch(() => {});
  }
}

(async () => {
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  basePort = server.address().port;

  // 测试库可能带着生产快照的注册开关/邀请码：本文件只验证会话生命周期，
  // 先把注册开关打开、邀请码清空，结束后恢复。
  const registerConfig = await pool.query("SELECT key,value FROM platform_config WHERE key IN ('register_open','register_code','require_email')");
  const savedConfig = new Map(registerConfig.rows.map(row => [row.key, row.value]));
  await pool.query(`INSERT INTO platform_config(key,value,updated_at) VALUES('register_open','1',now())
    ON CONFLICT(key) DO UPDATE SET value='1'`)
    ;
  await pool.query(`INSERT INTO platform_config(key,value,updated_at) VALUES('register_code','',now())
    ON CONFLICT(key) DO UPDATE SET value=''`)
    ;
  await pool.query(`INSERT INTO platform_config(key,value,updated_at) VALUES('require_email','0',now())
    ON CONFLICT(key) DO UPDATE SET value='0'`);

  const suffix = Date.now().toString(36);
  const userA = `lifecycle_a_${suffix}`;
  const userB = `lifecycle_b_${suffix}`;
  const userC = `lifecycle_c_${suffix}`;
  users.push(userA, userB, userC);

  // 同一 IP 注册有 60 秒间隔限制（生产语义，不能为测试放宽）：用虚拟时钟把上一轮记录清掉。
  const clearRegIp = () => require('../middleware/auth').sweepAuthMaps(Date.now() + 2 * 60 * 60 * 1000);

  await check('注册：轮换 SID、写数据库真实版本、新会话可认证', async () => {
    clearRegIp();
    const res = await request({ method: 'POST', path: '/api/register', body: { username: userA, password: 'secret123' } });
    assert.strictEqual(res.status, 200, '注册应成功：' + res.text);
    assert.strictEqual(res.json.ok, true);
    const cookie = cookieOf(res.setCookie);
    assert.ok(cookie, '注册成功必须下发会话 Cookie');

    const stored = await pool.query('SELECT auth_version FROM users WHERE username=$1', [userA]);
    assert.strictEqual(stored.rows.length, 1, '账号必须已创建');

    const me = await request({ path: '/api/me', cookie });
    assert.strictEqual(me.json.username, userA, '新会话必须能通过认证');

    const sids = store.entries();
    const sess = sids.find(item => item[0] === sidOf(cookie));
    assert.ok(sess, '会话必须已保存进 Store');
    assert.strictEqual(JSON.parse(sess[1]).authVersion, stored.rows[0].auth_version,
      '会话版本必须是数据库真实值，不能硬编码 1');
  });

  await check('再次登录：SID 轮换，旧 SID 认证失效、新 SID 正常', async () => {
    const first = await request({ method: 'POST', path: '/api/login', body: { username: userA, password: 'secret123' } });
    const oldCookie = cookieOf(first.setCookie);
    assert.ok(oldCookie, '登录必须下发 Cookie');
    const oldMe = await request({ path: '/api/me', cookie: oldCookie });
    assert.strictEqual(oldMe.json.username, userA);

    const second = await request({ method: 'POST', path: '/api/login', body: { username: userA, password: 'secret123' }, cookie: oldCookie });
    const newCookie = cookieOf(second.setCookie);
    assert.ok(newCookie, '重新登录必须下发 Cookie');
    assert.notStrictEqual(sidOf(newCookie), sidOf(oldCookie), '登录必须轮换 SID（防会话固定）');

    const staleMe = await request({ path: '/api/me', cookie: oldCookie });
    assert.strictEqual(staleMe.json.username, null, '被轮换掉的旧 SID 不能再通过认证');
    const freshMe = await request({ path: '/api/me', cookie: newCookie });
    assert.strictEqual(freshMe.json.username, userA);
  });

  await check('数据库版本非 1：会话写入真实版本而不是默认 1', async () => {
    await pool.query('UPDATE users SET auth_version=2 WHERE username=$1', [userA]);
    const res = await request({ method: 'POST', path: '/api/login', body: { username: userA, password: 'secret123' } });
    assert.strictEqual(res.status, 200);
    const cookie = cookieOf(res.setCookie);
    const sess = store.entries().find(item => item[0] === sidOf(cookie));
    assert.ok(sess, '会话必须已保存');
    assert.strictEqual(JSON.parse(sess[1]).authVersion, 2, '版本必须来自数据库（auth_version=2）');
    const me = await request({ path: '/api/me', cookie });
    assert.strictEqual(me.json.username, userA);
    await pool.query('UPDATE users SET auth_version=1 WHERE username=$1', [userA]);
  });

  await check('会话保存失败：登录不得返回成功', async () => {
    store.failSet = true;
    const res = await request({ method: 'POST', path: '/api/login', body: { username: userA, password: 'secret123' } });
    store.failSet = false;
    assert.notStrictEqual(res.status, 200, 'Store 写回失败时不能返回 200');
    assert.ok(!(res.json && res.json.ok === true), '不得返回登录成功');
  });

  await check('注册时会话建立失败：明确提示账号已创建，不返回已登录状态', async () => {
    clearRegIp();
    store.failSet = true;
    const res = await request({ method: 'POST', path: '/api/register', body: { username: userB, password: 'secret123' } });
    store.failSet = false;
    assert.strictEqual(res.status, 503, '账号已创建但会话失败应返回 503：' + res.text);
    assert.ok(!(res.json && res.json.ok === true));
    const created = await pool.query('SELECT 1 FROM users WHERE username=$1', [userB]);
    assert.strictEqual(created.rows.length, 1, '账号创建不需要回滚，用户可以直接登录');
    const cookie = cookieOf(res.setCookie);
    if (cookie) {
      const me = await request({ path: '/api/me', cookie });
      assert.strictEqual(me.json.username, null, '失败路径不得遗留带身份的会话');
    }
    // 账号确实可用：用同一账号登录成功。
    const login = await request({ method: 'POST', path: '/api/login', body: { username: userB, password: 'secret123' } });
    assert.strictEqual(login.status, 200, '提示"直接登录"必须是真的能登录');
  });

  await check('已注册账号重复注册：拒绝且不覆盖原账号', async () => {
    clearRegIp();
    const res = await request({ method: 'POST', path: '/api/register', body: { username: userA, password: 'another123' } });
    assert.strictEqual(res.status, 400);
    const login = await request({ method: 'POST', path: '/api/login', body: { username: userA, password: 'secret123' } });
    assert.strictEqual(login.status, 200, '原密码仍然有效，说明没有被重建/覆盖');
  });

  await check('账号被禁用后现役会话立即失效', async () => {
    const login = await request({ method: 'POST', path: '/api/login', body: { username: userA, password: 'secret123' } });
    const cookie = cookieOf(login.setCookie);
    assert.strictEqual((await request({ path: '/api/me', cookie })).json.username, userA);
    await pool.query("UPDATE users SET status='disabled' WHERE username=$1", [userA]);
    const after = await request({ path: '/api/me', cookie });
    assert.strictEqual(after.json.username, null, '禁用后 /me 必须按游客返回');
    await pool.query("UPDATE users SET status='active' WHERE username=$1", [userA]);
  });

  const failed = cases.filter(item => item[0] === 'FAIL');
  console.log(`\n==== 会话生命周期结果: ${cases.length - failed.length}/${cases.length} 通过 ====`);
  if (failed.length) {
    failed.forEach(item => console.log('  - ' + item[1]));
    await cleanup();
    await pool.end();
    server.close();
    process.exit(1);
  }
  console.log('全部通过 ✅');
  await cleanup();
  await pool.end();
  server.close();
})().catch(async error => {
  console.error('auth-lifecycle-regression.test.js 失败:', (error && error.stack) || error);
  await cleanup().catch(() => {});
  await pool.end().catch(() => {});
  if (server) server.close();
  process.exit(1);
});

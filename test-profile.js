// ============================================================
// test-profile.js — 个人中心 + 导航重构 回归测试（日志落盘版）
// 因 Bash 工具对长脚本 stdout 捕获异常，改用 fs.appendFileSync 落盘 tp_out.log
// 覆盖：P1 /api/me 含nickname+avatar；P2 /api/profile 完整字段+accounts；
//      P3 PUT 更新持久化；P4 校验；P5 改密码；P6 未登录401
// ============================================================
const fs = require('fs');
const LOG = 'D:/Users/持仓跟踪/portfolio-server/tp_out.log';
try { fs.writeFileSync(LOG, ''); } catch (e) {}
function L(...a) { try { fs.appendFileSync(LOG, a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ') + '\n'); } catch (e) {} }
L('=== 脚本启动 ===');

const http = require('http');
const { pool, hashPwd } = require('./server/db');
L('require db 完成, hashPwd=', typeof hashPwd, 'pool=', typeof pool);

const TEST_USER = '__ptest__';
const TEST_PWD = 'ptest123';
const TEST_PWD2 = 'ptest456';

let cookie = '';
let pass = 0, fail = 0;

function req(method, p, body, useCookie) {
  return new Promise((resolve, reject) => {
    const h = { host: '127.0.0.1', port: 3000, path: p, method, headers: { 'Content-Type': 'application/json', 'Origin': 'http://localhost:3000' } };
    if (useCookie && cookie) h.headers['Cookie'] = cookie;
    const q = http.request(h, res => {
      let b = '';
      const sc = res.headers['set-cookie'];
      if (sc) cookie = sc[0].split(';')[0];
      res.on('data', d => b += d);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(b) }); } catch (e) { resolve({ status: res.statusCode, body: b }); } });
    });
    q.on('error', reject);
    if (body) q.write(JSON.stringify(body));
    q.end();
  });
}
function ok(n) { L('  ✅ ' + n); pass++; }
function ng(n, got, want) { L('  ❌ ' + n + '：期望 ' + JSON.stringify(want) + '，实际 ' + JSON.stringify(got)); fail++; }

async function ensureTestUser() {
  await pool.query(
    'INSERT INTO users (username, password, accounts) VALUES ($1,$2,$3) ON CONFLICT (username) DO UPDATE SET password=$2, accounts=$3',
    [TEST_USER, hashPwd(TEST_PWD), JSON.stringify(['默认账户', '测试账户B'])]
  );
}
async function cleanup() {
  await pool.query('DELETE FROM accounts WHERE username=$1', [TEST_USER]);
  await pool.query('DELETE FROM users WHERE username=$1', [TEST_USER]);
}

(async () => {
  try {
    L('before ensureTestUser');
    await ensureTestUser();
    L('after ensureTestUser');

    const login = await req('POST', '/api/login', { username: TEST_USER, password: TEST_PWD });
    L('login ->', login.status, login.body);
    if (login.status !== 200) { ng('登录测试账户', login.status, 200); throw new Error('登录失败'); }
    ok('登录测试账户成功');

    const me = await req('GET', '/api/me', null, true);
    L('me ->', me.status, me.body);
    if (me.status === 200 && 'nickname' in me.body && 'avatar' in me.body) ok('GET /api/me 含 nickname+avatar 字段');
    else ng('GET /api/me 字段', me.body, '含 nickname+avatar');

    const prof = await req('GET', '/api/profile', null, true);
    L('profile ->', prof.status, prof.body);
    if (prof.status === 200) {
      const need = ['username', 'nickname', 'bio', 'avatar', 'email', 'last_login', 'accounts'];
      const miss = need.filter(f => !(f in prof.body));
      if (miss.length === 0) ok('GET /api/profile 返回全部字段(含 accounts)');
      else ng('GET /api/profile 字段缺失', miss, '无缺失');
      if (Array.isArray(prof.body.accounts) && prof.body.accounts.length === 2) ok('accounts 为数组且含 2 个账户');
      else ng('accounts 列表', prof.body.accounts, 'array len2');
    } else ng('GET /api/profile', prof.status, 200);

    const avatar = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAB//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AfwD/2Q==';
    const upd = await req('PUT', '/api/profile', { nickname: '测试昵称', bio: '简介内容', avatar, email: 'a@b.com' }, true);
    L('put profile ->', upd.status, upd.body);
    if (upd.status === 200) ok('PUT /api/profile 更新成功');
    else ng('PUT /api/profile', upd.status, 200);
    const prof2 = await req('GET', '/api/profile', null, true);
    if (prof2.status === 200 && prof2.body.nickname === '测试昵称' && prof2.body.email === 'a@b.com' && prof2.body.avatar === avatar) ok('资料持久化生效(昵称/邮箱/头像)');
    else ng('资料持久化', prof2.body, '昵称=测试昵称,email=a@b.com');

    const longNick = await req('PUT', '/api/profile', { nickname: 'x'.repeat(31) }, true);
    if (longNick.status === 400) ok('昵称超 30 字 → 400');
    else ng('昵称超长校验', longNick.status, 400);
    const badEmail = await req('PUT', '/api/profile', { email: 'notanemail' }, true);
    if (badEmail.status === 400) ok('邮箱格式错 → 400');
    else ng('邮箱格式校验', badEmail.status, 400);
    const badAvatar = await req('PUT', '/api/profile', { avatar: 'data:text/plain;base64,abc' }, true);
    if (badAvatar.status === 400) ok('头像非图片 → 400');
    else ng('头像格式校验', badAvatar.status, 400);

    const chg = await req('POST', '/api/profile/password', { oldPassword: TEST_PWD, newPassword: TEST_PWD2 }, true);
    L('change pwd ->', chg.status, chg.body);
    if (chg.status === 200) ok('改密码成功(旧密码正确+新密码≥6)');
    else ng('改密码', chg.status, 200);
    const oldLogin = await req('POST', '/api/login', { username: TEST_USER, password: TEST_PWD });
    if (oldLogin.status === 401) ok('旧密码已失效 → 401');
    else ng('旧密码失效', oldLogin.status, 401);
    const newLogin = await req('POST', '/api/login', { username: TEST_USER, password: TEST_PWD2 });
    if (newLogin.status === 200) ok('新密码可登录 → 200');
    else ng('新密码登录', newLogin.status, 200);
    const restore = await req('POST', '/api/profile/password', { oldPassword: TEST_PWD2, newPassword: TEST_PWD }, true);
    if (restore.status === 200) ok('密码还原成功');
    else ng('密码还原', restore.status, 200);

    const noAuth = await req('GET', '/api/profile');
    if (noAuth.status === 401) ok('未登录访问 /api/profile → 401');
    else ng('未登录拦截', noAuth.status, 401);

  } catch (e) {
    L('测试异常:', e.message);
  } finally {
    try { await cleanup(); L('cleanup done'); } catch (e) { L('cleanup err', e.message); }
    try { await pool.end(); } catch (e) {}
  }
  L('========== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ==========');
  process.exit(fail === 0 ? 0 : 1);
})();

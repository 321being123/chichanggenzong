// ========== 后台管理功能集成测试（需 server 在 localhost:3000 + 真实 PG）==========
// 运行：先 `node server.js`，再 `node test-admin.js`
// 覆盖：鉴权 / 概览 / 用户管理 / 券商 / 定时任务 / 费率 / 公告 / 版本 / 全局参数 / 休市 / 审计
// 结束自动还原会改动的全局状态（参数/费率/休市/版本文件）并删除测试券商/公告/用户。
// 注意：本环境 node 原生 http 客户端对 POST 响应有缺陷，统一改用 curl 发请求。
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const db = require('./server/db');

// 全局看门狗：任何意外卡死都在 120s 后强制退出，避免无限挂起
setTimeout(() => { console.error('⏰ WATCHDOG 120s 超时，强制退出'); process.exit(3); }, 120000).unref();

const BASE = 'http://localhost:3000';
// 用 ASCII 路径存放临时文件（curl 对含中文的 TMP 路径写 cookie/body 会异常）
const TMP = 'D:/admtest_' + process.pid;
fs.mkdirSync(TMP, { recursive: true });
const BODY_FILE = path.join(TMP, 'body.txt');
const ADMIN_JAR = path.join(TMP, 'admin.cookie');
const USER_JAR = path.join(TMP, 'user.cookie');
let pass = 0, fail = 0;
const createdBrokers = [], createdAnnounce = [], createdUsers = [];

// cookie: 'admin' | 'user' | null（用 cookie jar 文件维持会话）
function req(method, p, body, cookie) {
  const args = ['-s', '-m', '20', '-X', method, BASE + p,
    '-H', 'Content-Type: application/json', '-H', 'Origin: http://localhost:3000',
    '-o', BODY_FILE, '-w', '%{http_code}'];
  if (cookie === 'admin') { args.push('-b', ADMIN_JAR, '-c', ADMIN_JAR); }
  else if (cookie === 'user') { args.push('-b', USER_JAR, '-c', USER_JAR); }
  if (body) {
    // Windows 下 curl 命令行直接传中文参数会被按系统编码(GBK)处理导致乱码，
    // 改用 @文件 方式以 UTF-8 读取请求体，避免中文乱码。
    fs.writeFileSync(BODY_FILE + '.req.json', JSON.stringify(body), { encoding: 'utf-8' });
    args.push('-d', '@' + BODY_FILE + '.req.json');
  }
  const r = spawnSync('curl', args, { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 });
  const code = parseInt((r.stdout || '').trim(), 10) || 0;
  if (!code && r.status !== 0) console.error('[curl 异常] ' + method + ' ' + p + ' exit=' + r.status + ' err=' + (r.stderr || '').slice(0, 200));
  let raw = ''; try { raw = fs.readFileSync(BODY_FILE, 'utf-8'); } catch (e) {}
  let b; try { b = JSON.parse(raw); } catch (e) { b = raw; }
  return Promise.resolve({ status: code, body: b });
}

function ok(n) { console.log('  ✅ ' + n); pass++; }
function ng(n, got, want) { console.log('  ❌ ' + n + '：期望 ' + JSON.stringify(want) + '，实际 ' + JSON.stringify(got)); fail++; }
function ck(cond, n, got, want) { if (cond) ok(n); else ng(n, got, want); }

async function waitServer() {
  for (let i = 0; i < 40; i++) {
    try { const r = await req('GET', '/api/me'); if (r.status === 200 || r.status === 401) return; } catch (e) {}
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('server 未在 40s 内就绪');
}

(async () => {
  console.log('========== 后台功能集成测试 ==========');
  await waitServer();

  // ---- 登录 ----
  const adminLogin = await req('POST', '/api/login', { username: 'cunzaibeing', password: 'cunz.1234' }, 'admin');
  if (adminLogin.status !== 200) { ng('管理员登录', adminLogin.status, 200); console.log('无法登录，终止'); process.exit(1); }
  ok('管理员登录 cunzaibeing 成功');
  const me = await req('GET', '/api/me', null, 'admin');
  ck(me.body && me.body.role === 'admin', '/api/me 返回 role=admin', me.body && me.body.role, 'admin');

  // ---- 权限拦截 ----
  await req('POST', '/api/login', { username: 'daicunzai', password: '123456' }, 'user');
  const deny = await req('GET', '/api/admin/overview', null, 'user');
  ck(deny.status === 403, '普通用户访问 admin 接口被拒(403)', deny.status, 403);
  const noAuth = await req('GET', '/api/admin/overview');
  ck(noAuth.status === 401 || noAuth.status === 403, '未登录访问 admin 被拒', noAuth.status, '401/403');

  // ---- 概览 ----
  const ov = await req('GET', '/api/admin/overview', null, 'admin');
  ck(ov.status === 200 && typeof ov.body.totalUsers === 'number', '/api/admin/overview 返回总用户数', ov.status, 200);
  ck(typeof ov.body.totalAccounts === 'number', '概览含 totalAccounts', typeof ov.body.totalAccounts, 'number');
  ck(typeof ov.body.totalAsset === 'number', '概览含 totalAsset(全平台总资产)', typeof ov.body.totalAsset, 'number');

  // ---- 用户管理（造测试用户，避免污染真实账户）----
  const users = await db.loadUsers();
  users.admtest_user = { password: db.hashPwd('Test1234'), accounts: ['默认账户'] };
  await db.saveUsers(users);
  createdUsers.push('admtest_user');
  const ul = await req('GET', '/api/admin/users?search=admtest', null, 'admin');
  ck(ul.status === 200 && Array.isArray(ul.body.list) && ul.body.list.some(u => u.username === 'admtest_user'), '用户列表可搜索到测试用户', ul.status, 200);
  const ud = await req('GET', '/api/admin/users/admtest_user', null, 'admin');
  ck(ud.status === 200 && ud.body && ud.body.username === 'admtest_user', '用户详情接口可用', ud.status, 200);
  const setAdm = await req('POST', '/api/admin/users/admtest_user/role', { role: 'admin' }, 'admin');
  ck(setAdm.status === 200, '设为管理员成功', setAdm.status, 200);
  const ud2 = await req('GET', '/api/admin/users/admtest_user', null, 'admin');
  ck(ud2.body.role === 'admin', '用户角色已变为 admin', ud2.body.role, 'admin');
  const unsetAdm = await req('POST', '/api/admin/users/admtest_user/role', { role: 'user' }, 'admin');
  ck(unsetAdm.status === 200, '取消管理员成功', unsetAdm.status, 200);
  const dis = await req('POST', '/api/admin/users/admtest_user/status', { status: 'disabled' }, 'admin');
  ck(dis.status === 200, '禁用成功', dis.status, 200);
  const bannedLogin = await req('POST', '/api/login', { username: 'admtest_user', password: 'Test1234' });
  ck(bannedLogin.status === 403, '禁用账号登录被拒(403)', bannedLogin.status, 403);
  const en = await req('POST', '/api/admin/users/admtest_user/status', { status: 'active' }, 'admin');
  ck(en.status === 200, '重新启用成功', en.status, 200);
  const rp = await req('POST', '/api/admin/users/admtest_user/password', { password: 'NewPass9' }, 'admin');
  ck(rp.status === 200, '管理员重置密码成功', rp.status, 200);
  const newLogin = await req('POST', '/api/login', { username: 'admtest_user', password: 'NewPass9' });
  ck(newLogin.status === 200, '用新密码登录成功', newLogin.status, 200);
  const delSelf = await req('DELETE', '/api/admin/users/cunzaibeing', null, 'admin');
  ck(delSelf.status === 400, '不能删除当前登录账号(400)', delSelf.status, 400);

  // ---- 券商管理 ----
  const bl = await req('GET', '/api/admin/brokers', null, 'admin');
  ck(bl.status === 200 && Array.isArray(bl.body.list) && bl.body.list.length > 0, '券商列表返回', bl.status, 200);
  const bc = await req('POST', '/api/admin/brokers', { code: 'testbk', name: '测试券商', market: 'A', sort_order: 1 }, 'admin');
  ck(bc.status === 200, '新增券商成功', bc.status, 200);
  createdBrokers.push('testbk');
  const dup = await req('POST', '/api/admin/brokers', { code: 'testbk', name: '测试券商', market: 'A' }, 'admin');
  ck(dup.status === 409, '重复 code 返回 409', dup.status, 409);
  const badMkt = await req('POST', '/api/admin/brokers', { code: 'testbk2', name: 'X', market: 'Z' }, 'admin');
  ck(badMkt.status === 400, '非法市场返回 400', badMkt.status, 400);
  const bd = await req('GET', '/api/admin/brokers/testbk', null, 'admin');
  ck(bd.status === 200 && bd.body.name === '测试券商', '券商详情返回', bd.body && bd.body.name, '测试券商');
  const bu = await req('PUT', '/api/admin/brokers/testbk', { name: '测试券商改', market: 'A', sort_order: 2 }, 'admin');
  ck(bu.status === 200, '编辑券商成功', bu.status, 200);
  const bd2 = await req('GET', '/api/admin/brokers/testbk', null, 'admin');
  ck(bd2.body.name === '测试券商改', '券商名称已更新', bd2.body.name, '测试券商改');

  // ---- 定时任务 ----
  const jr = await req('GET', '/api/admin/jobs', null, 'admin');
  ck(jr.status === 200 && Array.isArray(jr.body.recent), '定时任务列表返回', jr.status, 200);
  const bf = await req('POST', '/api/admin/jobs/backfill', null, 'admin');
  ck(bf.status === 200, '手动补漏收盘数据成功(幂等)', bf.status, 200);
  const hs = await req('POST', '/api/admin/jobs/holiday-sync', null, 'admin');
  ck(hs.status === 200, '手动核对休市日历成功', hs.status, 200);

  // ---- 公告 ----
  const al = await req('GET', '/api/admin/announcements', null, 'admin');
  ck(al.status === 200 && Array.isArray(al.body.list), '公告列表返回', al.status, 200);
  const ac = await req('POST', '/api/admin/announcements', { title: '测试公告', content: '内容', pinned: true }, 'admin');
  ck(ac.status === 200 && ac.body.id, '发布公告成功', ac.status, 200);
  const aid = ac.body.id; createdAnnounce.push(aid);
  const au = await req('PUT', '/api/admin/announcements/' + aid, { title: '测试公告改', content: '内容2', pinned: false }, 'admin');
  ck(au.status === 200, '编辑公告成功', au.status, 200);

  // ---- 版本记录（写文件，结束后还原）----
  const clPath = path.join(__dirname, 'public/changelog.json');
  const clBackup = fs.readFileSync(clPath, 'utf8');
  const cl = await req('GET', '/api/admin/changelog', null, 'admin');
  ck(cl.status === 200 && Array.isArray(cl.body.list), '版本记录列表返回', cl.status, 200);
  const clAdd = await req('POST', '/api/admin/changelog', { date: '2099-01-01', item: '自动化测试临时记录' }, 'admin');
  ck(clAdd.status === 200, '新增版本记录成功', clAdd.status, 200);
  const clAfter = await req('GET', '/api/admin/changelog', null, 'admin');
  ck(clAfter.body.list.some(x => x.date === '2099-01-01'), '版本记录已写入', !!clAfter.body.list, true);

  // ---- 全局参数 ----
  const stBefore = await req('GET', '/api/admin/settings', null, 'admin');
  ck(stBefore.status === 200 && 'register_open' in stBefore.body, '全局参数读取', stBefore.status, 200);
  // /api/config 反映 register_code（有邀请码则需邀请码），故用 register_code 验证
  const stUpd = await req('PUT', '/api/admin/settings', { register_open: false, register_code: 'TESTCODE', require_email: false }, 'admin');
  ck(stUpd.status === 200, '更新全局参数成功', stUpd.status, 200);
  const cfg = await req('GET', '/api/config');
  ck(cfg.body && cfg.body.needRegisterCode === true, '配置邀请码后 /api/config 反映(needRegisterCode=true)', cfg.body && cfg.body.needRegisterCode, true);

  // ---- 休市日历 ----
  const ho = await req('GET', '/api/admin/holidays', null, 'admin');
  ck(ho.status === 200 && ho.body.years, '休市日历读取', ho.status, 200);
  const hoUpd = await req('PUT', '/api/admin/holidays', { year: '2030', dates: ['2030-01-01', '2030-10-01'] }, 'admin');
  ck(hoUpd.status === 200, '维护休市日历成功', hoUpd.status, 200);
  const hoAfter = await req('GET', '/api/admin/holidays', null, 'admin');
  ck(hoAfter.body.years['2030'] && hoAfter.body.years['2030'].length === 2, '休市日历已写入2030', hoAfter.body.years && hoAfter.body.years['2030'], ['2030-01-01', '2030-10-01']);

  // ---- 审计 ----
  const au2 = await req('GET', '/api/admin/audit?limit=50', null, 'admin');
  ck(au2.status === 200 && Array.isArray(au2.body.list), '审计日志列表返回', au2.status, 200);
  ck(au2.body.list.some(a => a.action === 'broker_create' || a.action === 'user_role'), '审计包含刚才的操作记录', !!au2.body.list, true);

  // ================= 清理（还原全局状态 + 删除测试数据）=================
  console.log('\n[cleanup] 还原全局状态并删除测试数据');
  if (stBefore.body) await req('PUT', '/api/admin/settings', stBefore.body, 'admin').catch(() => {});
  const hoClean = await req('GET', '/api/admin/holidays', null, 'admin');
  for (const y of Object.keys(hoClean.body.years || {})) {
    if (!(y in (ho.body.years || {}))) await req('PUT', '/api/admin/holidays', { year: y, dates: [] }, 'admin').catch(() => {});
    else await req('PUT', '/api/admin/holidays', { year: y, dates: ho.body.years[y] }, 'admin').catch(() => {});
  }
  fs.writeFileSync(clPath, clBackup);
  for (const id of createdAnnounce) await req('DELETE', '/api/admin/announcements/' + id, null, 'admin').catch(() => {});
  for (const code of createdBrokers) await req('DELETE', '/api/admin/brokers/' + code, null, 'admin').catch(() => {});
  for (const u of createdUsers) await req('DELETE', '/api/admin/users/' + u, null, 'admin').catch(() => {});

  console.log(`\n========== 后台功能测试完成：通过 ${pass} / 失败 ${fail} ==========`);
  await db.pool.end();
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('测试异常:', e && e.message); process.exit(1); });

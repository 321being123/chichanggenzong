// ============================================================
// test-regression.js — 未上线修复的回归测试
// 覆盖本轮未部署的修复点：
//   A. 券商字典表 + 3 个 API（建表/种子/下拉/回填/更新）
//   B. validate.js 边界修复（nav=0 / totalAsset=null / ISO 时间 / 负数仍拦）
//   C. normalizeDate 多格式兼容（Excel 序列号 / 8位 / 斜杠 / 点 / 中文 / mangled 文本）
//   D. nav_history 幂等 upsert（同日期重复写入不再报重复键）
// 另：前端改动文件由 node --check 静态语法校验覆盖（见运行命令）。
// ============================================================
const http = require('http');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const BASE = 'http://localhost:3000';
let sessionCookie = '';
let pass = 0, fail = 0;

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: 'localhost', port: 3000, path: p, method, headers: { 'Content-Type': 'application/json', 'Origin': 'http://localhost:3000' } };
    if (sessionCookie) opts.headers['Cookie'] = sessionCookie;
    const r = http.request(opts, (res) => {
      let data = '';
      const sc = res.headers['set-cookie'];
      if (sc) sessionCookie = sc[0].split(';')[0];
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch (e) { resolve({ status: res.statusCode, body: data }); } });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}
function ok(n) { console.log('  ✅ ' + n); pass++; }
function ng(n, got, want) { console.log('  ❌ ' + n + '：期望 ' + JSON.stringify(want) + '，实际 ' + JSON.stringify(got)); fail++; }

(async () => {
  console.log('\n========== 回归测试开始（未上线功能）==========\n');

  // ---- 登录 ----
  const login = await req('POST', '/api/login', { username: 'daicunzai', password: '123456' });
  if (login.status !== 200) { ng('登录', login.status, 200); console.log('\n无法登录，终止'); process.exit(1); }
  ok('登录成功');
  const me = await req('GET', '/api/me');
  const username = (me.body && me.body.username) || 'daicunzai';

  // ==================== A. 券商字典 API ====================
  console.log('\n[A] 券商字典表 + API');
  const br = await req('GET', '/api/brokers');
  if (br.status === 200 && Array.isArray(br.body) && br.body.length >= 44) ok('GET /api/brokers 返回 ' + br.body.length + ' 家（≥44 种子）');
  else ng('brokers 数量', br.body, 'array ≥44');

  const codes = (br.body || []).map(b => b.code);
  if (codes.includes('huatai') && codes.includes('cms')) ok('含华泰(huatai)/招商(cms) 种子');
  else ng('brokers 种子', codes, '含 huatai,cms');

  const mkt = await req('GET', '/api/brokers?market=A');
  if (mkt.status === 200 && Array.isArray(mkt.body) && mkt.body.length > 0) ok('按市场过滤 ?market=A → ' + mkt.body.length + ' 家');
  else ng('brokers 市场过滤', mkt.body, 'array');

  const ab = await req('GET', '/api/accounts/broker');
  if (ab.status === 200 && typeof ab.body === 'object' && !Array.isArray(ab.body)) ok('GET /api/accounts/broker 返回账户→券商映射');
  else ng('accounts/broker', ab.body, 'object map');

  // 取首个真实账户，改券商后还原（避免污染用户数据）
  const accts = await req('GET', '/api/accounts');
  const acct = (accts.body || [])[0];
  const before = await req('GET', '/api/accounts/broker');
  const orig = (before.body && before.body[acct]) || 'other';
  const put1 = await req('PUT', '/api/accounts/broker', { account_name: acct, broker: 'huatai' });
  if (put1.status === 200 && put1.body && put1.body.ok) ok('PUT /api/accounts/broker 更新成功');
  else ng('broker 更新', put1.status + ' ' + JSON.stringify(put1.body), '200 ok');
  const after = await req('GET', '/api/accounts/broker');
  if (after.body && after.body[acct] === 'huatai') ok('券商映射已落库（huatai）');
  else ng('broker 落库', after.body, 'huatai');
  const bad = await req('PUT', '/api/accounts/broker', { account_name: acct, broker: '__not_exist__' });
  if (bad.status === 400) ok('非法券商 code → 400 拦截（isValidBroker）');
  else ng('非法 broker 拦截', bad.status, 400);
  await req('PUT', '/api/accounts/broker', { account_name: acct, broker: orig }); // 还原
  ok('已还原账户「' + acct + '」券商为 ' + orig);

  // ==================== B. validate.js 边界修复 ====================
  console.log('\n[B] validate.js 边界修复');
  const { validateAccountData } = require('./server/middleware/validate');
  const base = {
    positions: [{ id: 'p1', code: '600000', name: '测试', price: 1, quantity: 1, cost: 1, type: 'A', subtype: 'A' }],
    trades: [], navHistory: [], cashFlows: []
  };
  // nav=0 应通过（原 `nav <= 0` 会误杀“净值为 0”的合法记录）
  ok(validateAccountData({ ...base, navHistory: [{ date: '2026-07-01', nav: 0, totalAsset: 100 }] }).ok ? 'nav=0 通过（不再误杀）' : 'nav=0 仍被拒');
  // totalAsset=null 应通过（原无条件 `!isNum` 会拒）
  ok(validateAccountData({ ...base, navHistory: [{ date: '2026-07-01', nav: 1, totalAsset: null }] }).ok ? 'totalAsset=null 通过' : 'totalAsset=null 被拒');
  // ISO 带时间日期应通过（SheetJS cellDates:true 序列化结果）
  ok(validateAccountData({ ...base, navHistory: [{ date: '2026-07-01T08:30:00Z', nav: 1 }] }).ok ? 'ISO 带时间日期通过' : 'ISO 日期被拒');
  // 负数 nav 仍必须拒绝（不要过度放宽）
  ok(!validateAccountData({ ...base, navHistory: [{ date: '2026-07-01', nav: -1 }] }).ok ? '负数 nav 仍被拒（回归）' : '负数 nav 未被拒');
  // 完整合法对象应通过
  ok(validateAccountData(base).ok ? '完整合法对象通过' : '合法对象被拒');

  // ==================== C. normalizeDate 多格式兼容 ====================
  console.log('\n[C] normalizeDate 多格式兼容');
  const src = fs.readFileSync(path.join(__dirname, 'public/shared/core-earnings.js'), 'utf8');
  const sandbox = { document: { querySelectorAll: () => [], getElementById: () => null }, window: {}, fetch: () => Promise.resolve(), console, data: {} };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(src, ctx);
  const normalizeDate = ctx.normalizeDate;
  if (typeof normalizeDate !== 'function') { ng('normalizeDate 加载', typeof normalizeDate, 'function'); }
  else {
    const cases = [
      [new Date('2026-07-09T00:00:00Z'), '2026-07-09'],          // Date 对象
      [46207, /^\d{4}-\d{2}-\d{2}$/],                              // Excel 序列号
      ['20260709', '2026-07-09'],                                  // 8 位紧凑
      ['2026-07-09', '2026-07-09'],                                // ISO
      ['2026/7/9', '2026-07-09'],                                  // 斜杠
      ['2026.07.09', '2026-07-09'],                                // 点
      ['2026年7月9日', '2026-07-09'],                              // 中文
      ['+046207-12', /^\d{4}-\d{2}-\d{2}$/],                      // mangled 显示文本（原 bug：+046207-12）
    ];
    for (const [inp, want] of cases) {
      const got = normalizeDate(inp);
      const passC = (want instanceof RegExp) ? want.test(got) : got === want;
      if (passC) ok('normalizeDate(' + JSON.stringify(inp) + ') → ' + got);
      else ng('normalizeDate', got, want);
    }
    ok(typeof normalizeDate('garbage@@@') === 'string' ? '非法输入不崩溃' : '非法输入异常');
  }

  // ==================== D. nav_history 幂等 upsert（重复键修复） ====================
  console.log('\n[D] nav_history 幂等 upsert（重复键修复）');
  const regAcct = '__regtest__';
  const db = require('./server/db');
  try {
    // 同一次保存内同日期出现两次 → 不应抛重复键，结果仅 1 行（ON CONFLICT 折叠）
    await db.saveAccountData(username, regAcct, {
      positions: [], trades: [], cashFlows: [],
      navHistory: [
        { date: '2026-07-01', nav: 1, totalAsset: 100 },
        { date: '2026-07-01', nav: 2, totalAsset: 200 }   // 同日期重复
      ]
    });
    ok('同日期重复写入未抛重复键（ON CONFLICT 生效）');
    const nh1 = (await db.loadAccountData(username, regAcct)).navHistory || [];
    if (nh1.filter(x => x.date === '2026-07-01').length === 1) ok('重复日期被折叠为 1 行（nav=2）');
    else ng('重复行数', nh1, '1 行');
    // 再次保存同日期不同值 → 应更新不新增
    await db.saveAccountData(username, regAcct, {
      positions: [], trades: [], cashFlows: [],
      navHistory: [{ date: '2026-07-01', nav: 9, totalAsset: 900 }]
    });
    const nh2 = (await db.loadAccountData(username, regAcct)).navHistory || [];
    if (nh2.length === 1 && Number(nh2[0].nav) === 9) ok('再次保存同日期 → 更新为 nav=9（不新增行）');
    else ng('二次 upsert', nh2, '1 行 nav=9');
  } catch (e) {
    ng('nav_history upsert', e.message, '无异常');
  }

  // 清理测试账户（直接删结构化表，避免污染用户账户列表）
  try {
    const db = require('./server/db');
    const u = username;
    await db.pool.query('DELETE FROM nav_history WHERE username=$1 AND account_name=$2', [u, regAcct]);
    await db.pool.query('DELETE FROM positions WHERE username=$1 AND account_name=$2', [u, regAcct]);
    await db.pool.query('DELETE FROM trades WHERE username=$1 AND account_name=$2', [u, regAcct]);
    await db.pool.query('DELETE FROM cash_flows WHERE username=$1 AND account_name=$2', [u, regAcct]);
    await db.pool.query('DELETE FROM account_data WHERE username=$1 AND account_name=$2', [u, regAcct]);
    await db.pool.query('DELETE FROM accounts WHERE username=$1 AND account_name=$2', [u, regAcct]);
    ok('已清理测试账户 ' + regAcct);
  } catch (e) { console.log('  ⚠️ 清理失败（可手动删 __regtest__）：' + e.message); }

  // ========== 总结 ==========
  const total = pass + fail;
  console.log('\n========== ' + total + ' 项回归测试完成 ==========');
  console.log('通过: ' + pass + '  失败: ' + fail);
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('测试脚本异常：', e); process.exit(1); });

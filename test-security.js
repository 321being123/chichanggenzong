// ============================================================
// test-security.js — 今日安全整改专项测试（零依赖，Node 内置 assert + vm）
// 运行: node test-security.js
// 覆盖: AI SSRF / 数据 schema 校验 / XSS 转义 / CSRF 来源校验 / 限流降级 / 账户归属越权
// 不依赖数据库与浏览器，可直接在本地运行（集成类见下方说明）。
// ============================================================
const assert = require('assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

// 必须在 require 任何依赖 config 的模块之前设置，config 首次加载时读取
process.env.AI_ALLOWED_HOSTS = 'api.openai.com,apihub.agnes-ai.com';
process.env.ALLOWED_ORIGIN = 'localhost,127.0.0.1';
// 不设 REDIS_URL => redis.ready=false => rateLimit 走内存降级路径

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log('  \u2705 ' + name); pass++; }
  catch (e) { console.log('  \u274c ' + name + ' :: ' + e.message); fail++; }
}

// ---------- 加载真实源码 ----------
// escapeHtml：用 vm 在沙箱执行 utils.js 真实源码，取出全局函数（前端脚本无 module.exports）
const utilsCode = fs.readFileSync(path.join(__dirname, 'public/js/utils.js'), 'utf8');
const sandbox = { module: {}, require, console, window: {}, document: { querySelector: () => null, getElementById: () => null }, classifyCode: () => null, data: {} };
vm.createContext(sandbox);
vm.runInContext(utilsCode, sandbox);
const escapeHtml = sandbox.escapeHtml;

const { assertSafeUrl } = require('./server/services/ai');
const validateAccountData = require('./server/middleware/validate');
const { isAllowedOrigin, csrfMiddleware } = require('./server/middleware/security');
const rateLimit = require('./server/middleware/rateLimit');

// assertOwnership 依赖 db 的 loadUsers/loadAccountData：先 monkeypatch 再加载 auth（解构会拿到 mock）
const db = require('./server/db');
db.loadUsers = async () => ({ daicunzai: { accounts: ['华泰账户'] } });
db.loadAccountData = async () => ({ positions: [], trades: [], navHistory: [], cashFlows: [] });
db.saveUsers = async () => {};
const { assertOwnership } = require('./server/middleware/auth');

// ---------- mock 辅助 ----------
function makeRes() {
  const r = { _code: null, _body: null };
  r.status = function (c) { r._code = c; return r; };
  r.json = function (b) { r._body = b; return r; };
  r.setHeader = function () {};
  r.getHeader = function () {};
  return r;
}
const next = () => {}; // 占位，实际测试用闭包捕获

// ============================================================
(async () => {
  console.log('\n========== 安全整改专项测试 ==========\n');

  console.log('[1] XSS 转义 (escapeHtml)');
  await test('转义 < > & " \' 全部字符', () => {
    const r = escapeHtml('<script>"\'&</script>');
    assert.strictEqual(r, '&lt;script&gt;&quot;&#39;&amp;&lt;/script&gt;');
  });
  await test('空值/Null 返回空串', () => {
    assert.strictEqual(escapeHtml(''), '');
    assert.strictEqual(escapeHtml(null), '');
    assert.strictEqual(escapeHtml(undefined), '');
  });
  await test('正常文本原样输出', () => {
    assert.strictEqual(escapeHtml('中远海控 601919'), '中远海控 601919');
  });

  console.log('\n[2] AI 接口 SSRF (assertSafeUrl)');
  await test('放行白名单 HTTPS 公网地址', () => {
    assert.strictEqual(assertSafeUrl('https://api.openai.com/v1/chat'), true);
  });
  await test('拒绝非 HTTPS 协议', () => {
    assert.throws(() => assertSafeUrl('http://api.openai.com/x'));
  });
  await test('拒绝私网链路本地 169.254.169.254', () => {
    assert.throws(() => assertSafeUrl('https://169.254.169.254/latest'));
  });
  await test('拒绝回环 127.0.0.1 / localhost', () => {
    assert.throws(() => assertSafeUrl('https://127.0.0.1/x'));
    assert.throws(() => assertSafeUrl('https://localhost/x'));
  });
  await test('拒绝非白名单域名', () => {
    assert.throws(() => assertSafeUrl('https://evil-attacker.com/steal'));
  });
  await test('拒绝非法 URL', () => {
    assert.throws(() => assertSafeUrl('not-a-url'));
  });

  console.log('\n[3] 服务端数据 schema 校验 (validateAccountData)');
  await test('放行合法完整数据', () => {
    const r = validateAccountData({
      positions: [{ code: '601919', name: '中远', price: 10, quantity: 100, cost: 9 }],
      trades: [{ date: '2024-01-01', direction: 'buy', price: 9, quantity: 100, amount: 900 }],
      navHistory: [{ date: '2024-01-01', nav: 1.0, totalAsset: 100 }],
      cashFlows: [{ date: '2024-01-01', amount: 100 }],
    });
    assert.ok(r.ok, '合法数据应通过');
  });
  await test('拒绝超长代码(>20)', () => {
    assert.ok(!validateAccountData({ positions: [{ code: 'x'.repeat(21), name: 'a', price: 1, quantity: 1 }] }).ok);
  });
  await test('拒绝负价格', () => {
    assert.ok(!validateAccountData({ positions: [{ code: '1', name: 'a', price: -1, quantity: 1 }] }).ok);
  });
  await test('拒绝非法日期格式', () => {
    assert.ok(!validateAccountData({ trades: [{ date: '2024/01/01', direction: 'buy', price: 1, quantity: 1, amount: 1 }] }).ok);
  });
  await test('拒绝非法交易方向', () => {
    assert.ok(!validateAccountData({ trades: [{ date: '2024-01-01', direction: 'hack', price: 1, quantity: 1, amount: 1 }] }).ok);
  });
  await test('拒绝非正净值', () => {
    assert.ok(!validateAccountData({ navHistory: [{ date: '2024-01-01', nav: 0, totalAsset: 1 }] }).ok);
  });
  await test('拒绝超大持仓数组(>5000)', () => {
    assert.ok(!validateAccountData({ positions: Array(5001).fill({ code: '1', name: 'a', price: 1, quantity: 1 }) }).ok);
  });
  await test('拒绝非对象载荷', () => {
    assert.ok(!validateAccountData(null).ok);
    assert.ok(!validateAccountData('x').ok);
  });

  console.log('\n[4] CSRF / 来源校验 (isAllowedOrigin, csrfMiddleware)');
  await test('isAllowedOrigin 放行 localhost / 127.0.0.1', () => {
    assert.ok(isAllowedOrigin('http://localhost:3000'));
    assert.ok(isAllowedOrigin('http://127.0.0.1'));
  });
  await test('isAllowedOrigin 拒绝外部域名', () => {
    assert.ok(!isAllowedOrigin('http://evil.com'));
  });
  await test('写请求带非法 Origin => 403', () => {
    const req = { method: 'PUT', headers: { origin: 'http://evil.com' }, get: () => 'localhost:3000' };
    const res = makeRes(); let n = false;
    csrfMiddleware(req, res, () => { n = true; });
    assert.strictEqual(res._code, 403);
  });
  await test('写请求带白名单 Origin => 放行', () => {
    const req = { method: 'PUT', headers: { origin: 'http://localhost:3000' }, get: () => '' };
    const res = makeRes(); let n = false;
    csrfMiddleware(req, res, () => { n = true; });
    assert.ok(n, '应放行');
  });
  await test('非写请求(GET) 不校验来源 => 放行', () => {
    const req = { method: 'GET', headers: {} };
    const res = makeRes(); let n = false;
    csrfMiddleware(req, res, () => { n = true; });
    assert.ok(n);
  });

  console.log('\n[5] 限流降级 (rateLimit 内存兜底)');
  await test('超 max 次请求被拦截(429)，其余放行', async () => {
    const mw = rateLimit({ prefix: 't' + Date.now(), windowMs: 60000, max: 3, getKey: () => 'u1', message: '频繁' });
    let allowed = 0, blocked = 0;
    for (let i = 0; i < 5; i++) {
      const req = { ip: 'u1' }; const res = makeRes(); let n = false;
      await mw(req, res, () => { n = true; });
      if (n) allowed++; else blocked++;
    }
    assert.strictEqual(allowed, 3);
    assert.strictEqual(blocked, 2);
  });

  console.log('\n[6] 账户归属校验 (assertOwnership) — 今日 daily-prices 修复依赖此中间件');
  await test('越权访问他人账户(无数据) => 403', async () => {
    const req = { session: { user: 'daicunzai' }, params: { name: '他人账户' } };
    const res = makeRes(); let n = false;
    await assertOwnership(req, res, () => { n = true; });
    assert.strictEqual(res._code, 403, '越权应被拒绝');
  });
  await test('访问本人账户 => 放行(next)', async () => {
    const req = { session: { user: 'daicunzai' }, params: { name: '华泰账户' } };
    const res = makeRes(); let n = false;
    await assertOwnership(req, res, () => { n = true; });
    assert.ok(n, '本人账户应放行');
  });

  console.log('\n[7] 事务保存结构 (saveAccountData 源码含 BEGIN/COMMIT/ROLLBACK)');
  await test('源码含事务三关键字', () => {
    const src = fs.readFileSync(path.join(__dirname, 'server/db.js'), 'utf8');
    assert.ok(src.includes('BEGIN') && src.includes('COMMIT') && src.includes('ROLLBACK'));
  });

  // ---------- 总结 ----------
  const total = pass + fail;
  console.log(`\n========== ${total} 项测试完成 ==========`);
  console.log(`通过: ${pass}  失败: ${fail}`);
  if (fail > 0) process.exit(1);
})();

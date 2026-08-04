// ========== 保存接口下线 + 快照导入 HTTP 集成测试（2026-08-04 DATA-01 整改） ==========
// 覆盖：
//  1) 日常全量保存（PUT /api/data/:name）→ 410 下线（阶段三要求，证明日常无整包写请求）
//  2) 专属快照导入 POST /api/accounts/:name/import-snapshot → 全量覆盖成功，无需版本号
//  3) import-snapshot 数据校验失败 → 400
//  4) import-snapshot 无会话 → 401
//  5) 静态：前端已移除 saveData* 死代码，导入改调 import-snapshot
// 走真实 HTTP（mini app + session mock），验证路由层行为。
const assert = require('assert');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const express = require('express');
const { pool } = require('../db');
const accountsRouter = require('../routes/accounts');
const { saveAccountData, upsertNav, loadAccountData } = require('../db/accounts');

const U = 'http_guard_test';
const A = 'HTTP守卫账户';
const results = [];
async function checkAsync(name, fn) {
  try { await fn(); results.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (e) { results.push(['FAIL', name + ' :: ' + (e && e.message ? e.message : e)]); console.log('  [FAIL] ' + name + ' :: ' + (e && e.message ? e.message : e)); }
}

function payload(over) {
  return Object.assign({
    positions: [{ id: 'p1', code: '600519', name: '贵州茅台', price: 1000, quantity: 10, cost: 900, type: '股票', subtype: 'A股', note: '' }],
    trades: [], navHistory: [{ date: '2026-08-01', nav: 1.0, totalAsset: 100000, invested: 80000 }], cashFlows: [],
    cash: 0, hkRate: 0.868, cashBase: 0, totalAsset: 100000, feeSettings: {}
  }, over || {});
}

(async () => {
  let skip = false;
  let server = null;
  let port = 0;
  try { await pool.query('SELECT 1'); } catch (e) { skip = true; }
  if (!skip) {
    for (const t of ['positions', 'trades', 'nav_history', 'cash_flows', 'index_history', 'daily_prices', 'account_data', 'accounts']) {
      await pool.query(`DELETE FROM ${t} WHERE username=$1`, [U]);
    }
    await pool.query(`DELETE FROM users WHERE username=$1`, [U]);
    await pool.query(`INSERT INTO users (username, password, accounts, role, status) VALUES ($1,'x','["${A}"]','user','active') ON CONFLICT (username) DO UPDATE SET accounts=EXCLUDED.accounts`, [U]);
    const r0 = await saveAccountData(U, A, payload(), 0, { positions: 0, trades: 0, navHistory: 0, cashFlows: 0 });
    await upsertNav(U, A, { date: '2026-08-02', nav: 1.05, totalAsset: 105000, invested: 80000 });

    const app = express();
    app.use(express.json());
    app.use(function (req, res, next) { req.session = { user: U }; next(); });
    app.use('/api', accountsRouter);
    server = await new Promise(function (resolve) { const s = app.listen(0, '127.0.0.1', function () { resolve(s); }); });
    port = server.address().port;
    const dataUrl = 'http://127.0.0.1:' + port + '/api/data/' + encodeURIComponent(A);
    const snapUrl = 'http://127.0.0.1:' + port + '/api/accounts/' + encodeURIComponent(A) + '/import-snapshot';

    await checkAsync('前端已移除 saveData* 全量保存死代码', () => {
      const idx = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf-8');
      assert.ok(!/function saveData\(/.test(idx), 'index.html 不应再定义 saveData');
      assert.ok(!/function saveDataNow/.test(idx), 'index.html 不应再定义 saveDataNow');
      assert.ok(!/function saveDataAndWait/.test(idx), 'index.html 不应再定义 saveDataAndWait');
      const ct = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'shared', 'core-trade.js'), 'utf-8');
      assert.ok(!/restore=true/.test(ct), 'core-trade.js 不应再使用 PUT ?restore=true 整包写');
      assert.ok(/import-snapshot/.test(ct), 'core-trade.js 导入应改调 import-snapshot 专用接口');
    });

    await checkAsync('日常全量保存（PUT /api/data/:name）→ 410 下线', async () => {
      const d = await loadAccountData(U, A);
      const q = '?version=' + d.version + '&posV=' + d.posVersion + '&tradeV=' + d.tradeVersion +
        '&navV=' + d.navVersion + '&cashV=' + d.cashflowVersion;
      const res = await fetch(dataUrl + q, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload({ positions: [{ id: 'p1', code: '600519', name: '贵州茅台', price: 999, quantity: 10, cost: 900, type: '股票', subtype: 'A股', note: '' }] })) });
      assert.strictEqual(res.status, 410, '日常保存应 410 下线，状态=' + res.status);
      const d2 = await loadAccountData(U, A);
      assert.strictEqual(d2.positions[0].price, 1000, '410 后持仓不应被改动');
      assert.ok(d2.navHistory.some(n => n.date === '2026-08-02'), '后台净值不应被覆盖');
    });

    await checkAsync('快照导入 import-snapshot → 全量覆盖成功（无需版本号）', async () => {
      const res = await fetch(snapUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload({ positions: [{ id: 'p1', code: '600519', name: '贵州茅台', price: 888, quantity: 10, cost: 900, type: '股票', subtype: 'A股', note: '' }] })) });
      assert.strictEqual(res.status, 200, 'import-snapshot 应成功，状态=' + res.status);
      const d2 = await loadAccountData(U, A);
      assert.strictEqual(d2.positions[0].price, 888, '快照导入后持仓价格应被覆盖');
      assert.ok(!d2.navHistory.some(n => n.date === '2026-08-02'), '快照导入以导入数据为准（08-02 后台净值被覆盖）');
    });

    await checkAsync('import-snapshot 数据校验失败 → 400', async () => {
      const res = await fetch(snapUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ positions: 'bad' }) });
      assert.strictEqual(res.status, 400, '非法数据应 400，状态=' + res.status);
    });

    // 无会话 → 401（独立 app，不设 req.session）
    await checkAsync('import-snapshot 无会话 → 401', async () => {
      const noSessionApp = express();
      noSessionApp.use(express.json());
      noSessionApp.use('/api', accountsRouter);
      const s2 = await new Promise(function (resolve) { const s = noSessionApp.listen(0, '127.0.0.1', function () { resolve(s); }); });
      const p2 = s2.address().port;
      const res = await fetch('http://127.0.0.1:' + p2 + '/api/accounts/' + encodeURIComponent(A) + '/import-snapshot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload()) });
      assert.strictEqual(res.status, 401, '未登录应 401，状态=' + res.status);
      s2.close();
    });
  }

  if (server) server.close();
  for (const t of ['positions', 'trades', 'nav_history', 'cash_flows', 'index_history', 'daily_prices', 'account_data', 'accounts']) {
    await pool.query(`DELETE FROM ${t} WHERE username=$1`, [U]);
  }
  await pool.query(`DELETE FROM users WHERE username=$1`, [U]);
  await pool.end();

  const pass = results.filter(r => r[0] === 'PASS').length;
  const fail = results.filter(r => r[0] === 'FAIL').length;
  console.log('\n===== 保存接口下线/快照导入 HTTP 集成汇总 =====');
  console.log('PASS=' + pass + '  FAIL=' + fail + '  SKIP=' + (results.length - pass - fail));
  if (fail > 0) { console.log('HAS_ISSUES'); process.exit(1); }
  console.log('ALL PASS');
  process.exit(0);
})().catch(async e => {
  console.error('异常', e);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});

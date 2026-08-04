// ========== 保存接口下线 + 恢复导入 HTTP 集成测试（2026-08-04 整改后适配） ==========
// 覆盖：
//  1) 日常全量保存（无 restore）→ 410 下线（阶段三要求）
//  2) restore=true → 全量覆盖成功，无需版本号
//  3) restore=true 数据校验失败 → 400
// 走真实 HTTP（mini app + session mock），验证路由层行为。
const assert = require('assert');
const path = require('path');
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
    // 清理 + 造数
    for (const t of ['positions', 'trades', 'nav_history', 'cash_flows', 'index_history', 'daily_prices', 'account_data', 'accounts']) {
      await pool.query(`DELETE FROM ${t} WHERE username=$1`, [U]);
    }
    await pool.query(`DELETE FROM users WHERE username=$1`, [U]);
    await pool.query(`INSERT INTO users (username, password, accounts, role, status) VALUES ($1,'x','["${A}"]','user','active') ON CONFLICT (username) DO UPDATE SET accounts=EXCLUDED.accounts`, [U]);
    const r0 = await saveAccountData(U, A, payload(), 0, { positions: 0, trades: 0, navHistory: 0, cashFlows: 0 });
    // 后台写净值 → nav_version +1
    await upsertNav(U, A, { date: '2026-08-02', nav: 1.05, totalAsset: 105000, invested: 80000 });

    const app = express();
    app.use(express.json());
    app.use(function (req, res, next) { req.session = { user: U }; next(); });
    app.use('/api', accountsRouter);
    server = await new Promise(function (resolve) { const s = app.listen(0, '127.0.0.1', function () { resolve(s); }); });
    port = server.address().port;
    const url = 'http://127.0.0.1:' + port + '/api/data/' + encodeURIComponent(A);

    const put = function (q, body) {
      return fetch(url + q, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    };

    await checkAsync('日常全量保存（无 restore）→ 410 下线', async () => {
      const d = await loadAccountData(U, A);
      const q = '?version=' + d.version + '&posV=' + d.posVersion + '&tradeV=' + d.tradeVersion +
        '&navV=' + d.navVersion + '&cashV=' + d.cashflowVersion;
      const res = await put(q, payload({ positions: [{ id: 'p1', code: '600519', name: '贵州茅台', price: 999, quantity: 10, cost: 900, type: '股票', subtype: 'A股', note: '' }] }));
      assert.strictEqual(res.status, 410, '日常保存应 410 下线，状态=' + res.status);
      const d2 = await loadAccountData(U, A);
      assert.strictEqual(d2.positions[0].price, 1000, '410 后持仓不应被改动');
      assert.ok(d2.navHistory.some(n => n.date === '2026-08-02'), '后台净值不应被覆盖');
    });

    await checkAsync('restore=true → 全量覆盖成功（无需版本号）', async () => {
      const res = await put('?restore=true', payload({ positions: [{ id: 'p1', code: '600519', name: '贵州茅台', price: 888, quantity: 10, cost: 900, type: '股票', subtype: 'A股', note: '' }] }));
      assert.strictEqual(res.status, 200, 'restore 应成功，状态=' + res.status);
      const d2 = await loadAccountData(U, A);
      assert.strictEqual(d2.positions[0].price, 888, 'restore 后持仓价格应被覆盖');
      assert.ok(!d2.navHistory.some(n => n.date === '2026-08-02'), 'restore 以导入数据为准（08-02 后台净值被覆盖）');
    });

    await checkAsync('restore=true 数据校验失败 → 400', async () => {
      const res = await put('?restore=true', { positions: 'bad' });
      assert.strictEqual(res.status, 400, '非法数据应 400，状态=' + res.status);
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
  console.log('\n===== 保存接口下线/恢复导入 HTTP 集成汇总 =====');
  console.log('PASS=' + pass + '  FAIL=' + fail + '  SKIP=' + (results.length - pass - fail));
  if (fail > 0) { console.log('HAS_ISSUES'); process.exit(1); }
  console.log('ALL PASS');
  process.exit(0);
})().catch(async e => {
  console.error('异常', e);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});

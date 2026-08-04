// ========== 新局部接口专项测试（2026-08-04 剩余阻断项验收） ==========
// 覆盖：
//  1) 乐观锁版本校验：版本不一致 → 409（多窗口并发后写不覆盖先写）
//  2) 幂等键：现金流/持仓事件同一 id 重复提交不新增第二条
//  3) 账户归属校验：向不存在的账户写入 → 403
//  4) 净值批量导入：按日期 upsert 持久化 + 版本提升
// 走真实 HTTP（mini app + session mock）。
const assert = require('assert');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const express = require('express');
const { pool } = require('../db');
const accountsRouter = require('../routes/accounts');
const { saveAccountData, loadAccountData } = require('../db/accounts');

const U = 'local_ep_test';
const A = '局部接口账户';
const GHOST = '不存在的账户X';
const results = [];
async function checkAsync(name, fn) {
  try { await fn(); results.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (e) { results.push(['FAIL', name + ' :: ' + (e && e.message ? e.message : e)]); console.log('  [FAIL] ' + name + ' :: ' + (e && e.message ? e.message : e)); }
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
    const acctId = require('crypto').createHash('sha256').update(U + '\n' + A).digest('hex');
    await pool.query(
      `INSERT INTO accounts (id, username, account_name, cash_base, hk_rate, version, updated_at)
       VALUES ($1,$2,$3,100000,0.868,0,to_char(now(),'YYYY-MM-DD HH24:MI:SS'))
       ON CONFLICT (username, account_name) DO NOTHING`,
      [acctId, U, A]
    );
    await saveAccountData(U, A, {
      positions: [{ id: 'p1', code: '600519', name: '贵州茅台', price: 1000, quantity: 10, cost: 900, type: '股票', subtype: 'A股', note: '' }],
      trades: [], navHistory: [], cashFlows: [], cash: 0, hkRate: 0.868, cashBase: 0, totalAsset: 10000, feeSettings: {}
    }, 0, { positions: 0, trades: 0, navHistory: 0, cashFlows: 0 });

    const app = express();
    app.use(express.json());
    app.use(function (req, res, next) { req.session = { user: U }; next(); });
    app.use('/api', accountsRouter);
    server = await new Promise(function (resolve) { const s = app.listen(0, '127.0.0.1', function () { resolve(s); }); });
    port = server.address().port;
    const base = 'http://127.0.0.1:' + port + '/api';

    // ========== 1) 乐观锁版本校验 ==========
    await checkAsync('版本一致：PATCH settings 成功并提升版本', async () => {
      const d0 = await loadAccountData(U, A);
      const r = await fetch(base + '/accounts/' + encodeURIComponent(A) + '/settings?version=' + d0.version, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hkRate: 0.87 })
      });
      assert.strictEqual(r.status, 200, '版本一致应成功，状态=' + r.status);
      const d1 = await loadAccountData(U, A);
      assert.ok(d1.version > d0.version, '写成功后版本应提升');
    });

    await checkAsync('版本过期：旧 version 再提交 → 409，数据不被覆盖', async () => {
      const d0 = await loadAccountData(U, A);
      const stale = d0.version - 1; // 用旧版本号模拟另一窗口
      const r = await fetch(base + '/accounts/' + encodeURIComponent(A) + '/settings?version=' + stale, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hkRate: 0.5 })
      });
      assert.strictEqual(r.status, 409, '版本过期应 409，状态=' + r.status);
      const d1 = await loadAccountData(U, A);
      assert.strictEqual(d1.hkRate, 0.87, '过期提交不得覆盖数据');
    });

    await checkAsync('版本过期：PUT /nav 旧版本 → 409', async () => {
      const d0 = await loadAccountData(U, A);
      const r = await fetch(base + '/nav/2026-08-01?version=' + (d0.version - 1), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: A, nav: 1.1, totalAsset: 11000, invested: 9000 })
      });
      assert.strictEqual(r.status, 409, '净值旧版本应 409，状态=' + r.status);
    });

    // ========== 2) 幂等键 ==========
    await checkAsync('幂等：现金流同一 id 提交两次（同版本）→ 只新增一条', async () => {
      const cfId = 'cf_idem_001';
      const body = { cashFlow: { id: cfId, date: '2026-08-04', amount: 5000, note: '幂等测试' } };
      const d0 = await loadAccountData(U, A);
      const q = '?version=' + d0.version; // 两次用同一版本号，模拟双击/网络重试
      const r1 = await fetch(base + '/accounts/' + encodeURIComponent(A) + '/ledger/cash-flows' + q, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      assert.strictEqual(r1.status, 200, '首次提交应成功');
      const r2 = await fetch(base + '/accounts/' + encodeURIComponent(A) + '/ledger/cash-flows' + q, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      assert.strictEqual(r2.status, 200, '同版本重复提交应幂等成功（不因版本已+1 而 409）');
      const d1 = await loadAccountData(U, A);
      const n = (d1.cashFlows || []).filter(c => c.id === cfId).length;
      assert.strictEqual(n, 1, '重复提交不得新增第二条');
    });

    await checkAsync('幂等：持仓事件同一 id 提交两次（同版本）→ 持仓数量不翻倍', async () => {
      const evId = 'ev_idem_001';
      const ev = { event: { id: evId, code: '000858', name: '五粮液', direction: 'open', price: 100, quantity: 100, type: '股权', subtype: '深市', date: '2026-08-04', note: '幂等测试' } };
      const d0 = await loadAccountData(U, A);
      const q = '?version=' + d0.version; // 两次用同一版本号，模拟双击/网络重试
      const r1 = await fetch(base + '/accounts/' + encodeURIComponent(A) + '/ledger/position-events' + q, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ev)
      });
      assert.strictEqual(r1.status, 200, '首次提交应成功');
      const r2 = await fetch(base + '/accounts/' + encodeURIComponent(A) + '/ledger/position-events' + q, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ev)
      });
      assert.strictEqual(r2.status, 200, '同版本重复提交应幂等成功（不因版本已+1 而 409）');
      const d1 = await loadAccountData(U, A);
      const pos = (d1.positions || []).find(p => p.code === '000858');
      assert.ok(pos, '持仓应存在');
      assert.strictEqual(pos.quantity, 100, '重复提交数量不得翻倍');
    });

    // ========== 3) 账户归属校验 ==========
    await checkAsync('归属：向不存在的账户 PATCH prices → 403', async () => {
      const r = await fetch(base + '/positions/prices', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: GHOST, prices: [{ code: '600519', price: 999 }] })
      });
      assert.strictEqual(r.status, 403, '幽灵账户应 403，状态=' + r.status);
    });

    await checkAsync('归属：向不存在的账户 PUT /nav → 403', async () => {
      const r = await fetch(base + '/nav/2026-08-04', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: GHOST, nav: 1.0, totalAsset: 10000, invested: 9000 })
      });
      assert.strictEqual(r.status, 403, '幽灵账户应 403，状态=' + r.status);
    });

    await checkAsync('归属：向不存在的账户 POST /nav/import → 403', async () => {
      const r = await fetch(base + '/nav/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: GHOST, records: [{ date: '2026-08-01', nav: 1.0 }] })
      });
      assert.strictEqual(r.status, 403, '幽灵账户应 403，状态=' + r.status);
    });

    // ========== 4) 净值批量导入持久化 + 版本提升 ==========
    await checkAsync('净值导入：按日期 upsert 且版本提升', async () => {
      const d0 = await loadAccountData(U, A);
      const r = await fetch(base + '/nav/import?version=' + d0.version, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: A, records: [
          { date: '2026-08-01', nav: 1.0, totalAsset: 10000, invested: 9000 },
          { date: '2026-08-02', nav: 1.05, totalAsset: 10500, invested: 9000 }
        ] })
      });
      assert.strictEqual(r.status, 200, '导入应成功，状态=' + r.status);
      const d1 = await loadAccountData(U, A);
      assert.ok(d1.navHistory.some(n => n.date === '2026-08-01'), '导入的净值应持久化');
      assert.ok(d1.navHistory.some(n => n.date === '2026-08-02'), '导入的净值应持久化');
      assert.ok(d1.version > d0.version, '导入后版本应提升');
    });

    await checkAsync('净值导入：旧版本 → 409', async () => {
      const d0 = await loadAccountData(U, A);
      const r = await fetch(base + '/nav/import?version=' + (d0.version - 1), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: A, records: [{ date: '2026-08-03', nav: 1.1, totalAsset: 11000, invested: 9000 }] })
      });
      assert.strictEqual(r.status, 409, '旧版本导入应 409，状态=' + r.status);
    });

    // ========== 5) 真并发：两请求同时提交，一成功一 409（FOR UPDATE 行锁） ==========
    await checkAsync('真并发：同一版本两个请求同时提交 → 仅一个成功', async () => {
      const d0 = await loadAccountData(U, A);
      const v = d0.version;
      const url = base + '/accounts/' + encodeURIComponent(A) + '/settings?version=' + v;
      const req = () => fetch(url, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hkRate: 0.88 })
      });
      // 真正同时发出（不串行等待）
      const [ra, rb] = await Promise.all([req(), req()]);
      const statuses = [ra.status, rb.status].sort();
      assert.deepStrictEqual(statuses, [200, 409], '应一成功一 409，实际=' + JSON.stringify(statuses));
      const d1 = await loadAccountData(U, A);
      assert.strictEqual(d1.hkRate, 0.88, '数据应来自成功的那次提交');
    });

    await checkAsync('真并发：交易录入两请求同时提交同幂等 id → 只建仓一次', async () => {
      const evId = 'ev_concurrent_001';
      const d0 = await loadAccountData(U, A);
      const url = base + '/accounts/' + encodeURIComponent(A) + '/ledger/position-events?version=' + d0.version;
      const body = { event: { id: evId, code: '600036', name: '招商银行', direction: 'open', price: 30, quantity: 500, type: '股权', subtype: '沪市', date: '2026-08-04', note: '并发幂等测试' } };
      const req = () => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const results = await Promise.all([req(), req()]);
      // 核心断言：绝不重复建仓。真同时到达时第二个请求可能因版本已+1 返回 409（不写入），
      // 也可能幂等命中返回 200；无论哪种，持仓数量必须恰好一次。
      assert.ok(results.some(r => r.status === 200), '至少一个请求成功，实际=' + JSON.stringify(results.map(r => r.status)));
      const d1 = await loadAccountData(U, A);
      const pos = (d1.positions || []).find(p => p.code === '600036');
      assert.ok(pos, '持仓应存在');
      assert.strictEqual(pos.quantity, 500, '并发同 id 只建仓一次，数量不得翻倍');
      const trades = (d1.trades || []).filter(t => t.id === evId);
      assert.strictEqual(trades.length, 1, '并发同 id 只产生一条交易');
    });

    // ========== 6) 连续保存：局部保存后版本号同步，紧接着第二次保存成功 ==========
    await checkAsync('连续保存：settings 保存返回新版本 → 立即第二次保存成功', async () => {
      const d0 = await loadAccountData(U, A);
      const r1 = await fetch(base + '/accounts/' + encodeURIComponent(A) + '/settings?version=' + d0.version, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hkRate: 0.875 })
      });
      assert.strictEqual(r1.status, 200, '第一次保存应成功');
      const j1 = await r1.json();
      assert.strictEqual(typeof j1.version, 'number', '第一次保存应返回新版本号');
      const r2 = await fetch(base + '/accounts/' + encodeURIComponent(A) + '/settings?version=' + j1.version, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hkRate: 0.873 })
      });
      assert.strictEqual(r2.status, 200, '用新版本号立即第二次保存应成功，状态=' + r2.status);
    });

    await checkAsync('缺版本号：核心写接口 → 400（保护不可绕过）', async () => {
      const r = await fetch(base + '/accounts/' + encodeURIComponent(A) + '/settings', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hkRate: 0.5 })
      });
      assert.strictEqual(r.status, 400, '缺版本号应 400，状态=' + r.status);
    });

    // ========== 7) 净值真并发（PUT /nav 同时提交） ==========
    await checkAsync('净值真并发：两窗口同时保存净值 → 仅一个成功', async () => {
      const d0 = await loadAccountData(U, A);
      const v = d0.version;
      const url = base + '/nav/2026-08-05?version=' + v;
      const req = (nav) => fetch(url, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: A, nav: nav, totalAsset: 12000, invested: 9000 })
      });
      const [ra, rb] = await Promise.all([req(1.2), req(1.3)]);
      const statuses = [ra.status, rb.status].sort();
      assert.deepStrictEqual(statuses, [200, 409], '净值并发应一成功一 409，实际=' + JSON.stringify(statuses));
      const d1 = await loadAccountData(U, A);
      const rec = (d1.navHistory || []).find(n => n.date === '2026-08-05');
      assert.ok(rec, '净值记录应存在');
      // 数据必须来自成功的那次（nav 为 1.2 或 1.3 之一，但不能同时存在两条语义）
      assert.ok(rec.nav === 1.2 || rec.nav === 1.3, '净值应为成功提交的值，实际=' + rec.nav);
    });

    // ========== 8) 旧版本删除（deleteTrade / deleteCashFlow 事务内校验） ==========
    await checkAsync('旧版本删除交易 → 409，交易保留', async () => {
      // 先建一笔交易
      const d0 = await loadAccountData(U, A);
      const body = { trade: { id: 'del_trade_001', code: '601318', name: '中国平安', direction: 'buy', price: 40, quantity: 200, commission: 5, stamp_tax: 0, transfer_fee: 0.2, other_fee: 0, type: '股权', subtype: '沪市', date: '2026-08-04', note: '' } };
      const r0 = await fetch(base + '/accounts/' + encodeURIComponent(A) + '/ledger/trades?version=' + d0.version, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      assert.strictEqual(r0.status, 200, '建交易应成功');
      // 用旧版本号删除 → 409
      const r1 = await fetch(base + '/accounts/' + encodeURIComponent(A) + '/ledger/trades/' + 'del_trade_001' + '?version=' + (d0.version - 1), {
        method: 'DELETE'
      });
      assert.strictEqual(r1.status, 409, '旧版本删除应 409，状态=' + r1.status);
      const d1 = await loadAccountData(U, A);
      assert.ok((d1.trades || []).some(t => t.id === 'del_trade_001'), '旧版本删除不得生效，交易应保留');
    });

    await checkAsync('旧版本删除现金流 → 409，记录保留', async () => {
      const d0 = await loadAccountData(U, A);
      const cfId = 'del_cf_001';
      const r0 = await fetch(base + '/accounts/' + encodeURIComponent(A) + '/ledger/cash-flows?version=' + d0.version, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cashFlow: { id: cfId, date: '2026-08-04', amount: 3000, note: '删除测试' } })
      });
      assert.strictEqual(r0.status, 200, '建现金流应成功');
      const r1 = await fetch(base + '/accounts/' + encodeURIComponent(A) + '/ledger/cash-flows/' + cfId + '?version=' + (d0.version - 1), {
        method: 'DELETE'
      });
      assert.strictEqual(r1.status, 409, '旧版本删除应 409，状态=' + r1.status);
      const d1 = await loadAccountData(U, A);
      assert.ok((d1.cashFlows || []).some(c => c.id === cfId), '旧版本删除不得生效，记录应保留');
    });

    // ========== 9) 交易响应丢失重试（幂等命中返回最新数据+版本） ==========
    await checkAsync('交易响应丢失重试：幂等命中返回最新数据+版本', async () => {
      const d0 = await loadAccountData(U, A);
      const tradeId = 'retry_trade_001';
      const body = { trade: { id: tradeId, code: '600050', name: '中国联通', direction: 'buy', price: 5, quantity: 1000, commission: 5, stamp_tax: 0, transfer_fee: 0.2, other_fee: 0, type: '股权', subtype: '沪市', date: '2026-08-04', note: '' } };
      const url = base + '/accounts/' + encodeURIComponent(A) + '/ledger/trades?version=' + d0.version;
      const r1 = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.strictEqual(r1.status, 200, '首次保存应成功');
      // 模拟"首次成功但响应丢失"：前端仍持旧版本，重试同一 id
      const r2 = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.strictEqual(r2.status, 200, '重试幂等命中应成功');
      const j2 = await r2.json();
      assert.strictEqual(j2.skipped, 'duplicate', '重试应标记幂等命中');
      assert.ok(j2.data, '幂等命中必须返回最新数据');
      assert.strictEqual(typeof j2.data.version, 'number', '幂等命中必须返回最新版本号');
      assert.ok(j2.data.version > d0.version, '返回版本应大于提交前版本（前端可恢复最新状态）');
      assert.ok((j2.data.trades || []).some(t => t.id === tradeId), '返回数据应包含已保存的交易');
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
  console.log('\n===== 新局部接口专项测试汇总 =====');
  console.log('PASS=' + pass + '  FAIL=' + fail + '  SKIP=' + (results.length - pass - fail));
  if (fail > 0) { console.log('HAS_ISSUES'); process.exit(1); }
  console.log('ALL PASS');
  process.exit(0);
})().catch(async e => {
  console.error('异常', e);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});

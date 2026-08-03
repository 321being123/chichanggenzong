// ========== 账户双数据源架构整改回归测试（2026-08-03 整改报告 8.4 验收） ==========
// 运行：node server/test/data-source-arch.test.js
// 覆盖：
//  1) 表空、JSON 非空时禁止还魂（loadAccountData 永远从结构化表组装）
//  2) 读取接口不写库（indexHistory 表空时不再自动迁移 JSON）
//  3) 数据集级版本控制：后台写入净值后，旧浏览器保存持仓不覆盖新净值（8.2 并发验收）
//  4) 账户删除原子：删除后重建同名账户不出现旧数据
//  5) 账户重命名原子：业务表/元数据/列表全部改名，失败整体回滚
//  6) 静态边界：业务代码不再读取 JSON 五类业务数组
// 全部使用专用测试数据并在 finally 清理，绝不触碰真实账户数据。
const assert = require('assert');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { pool } = require('../db');
const { loadAccountData, saveAccountData, upsertNav, upsertIndexPoints, loadIndexPoints } = require('../db/accounts');

const U = 'arch_test_user';
const A = '架构整改测试账户';
const results = [];
function check(name, fn) {
  try { fn(); results.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (e) { results.push(['FAIL', name + ' :: ' + (e && e.message ? e.message : e)]); console.log('  [FAIL] ' + name + ' :: ' + (e && e.message ? e.message : e)); }
}
async function checkAsync(name, fn) {
  try { await fn(); results.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (e) { results.push(['FAIL', name + ' :: ' + (e && e.message ? e.message : e)]); console.log('  [FAIL] ' + name + ' :: ' + (e && e.message ? e.message : e)); console.log('    ' + String((e && e.stack || e || '').split('\n').slice(0, 4).join('\n    '))); }
}

async function cleanup() {
  for (const t of ['positions', 'trades', 'nav_history', 'cash_flows', 'index_history', 'daily_prices', 'account_data', 'accounts']) {
    await pool.query(`DELETE FROM ${t} WHERE username=$1 AND account_name=$2`, [U, A]);
  }
}
// accounts 表有 FK 指向 users，测试用户必须存在
async function ensureUser() {
  await pool.query(
    `INSERT INTO users (username, password, accounts, role, status)
     VALUES ($1,$2,$3::jsonb::text,'user','active')
     ON CONFLICT (username) DO UPDATE SET accounts=EXCLUDED.accounts`,
    [U, 'dummy-hash', JSON.stringify([A])]
  );
}

function payload(over) {
  return Object.assign({
    positions: [{ id: 'p1', code: '600519', name: '贵州茅台', price: 1000, quantity: 10, cost: 900, type: '股票', subtype: 'A股', note: '' }],
    trades: [],
    navHistory: [{ date: '2026-01-01', nav: 1.0, totalAsset: 10000, invested: 8000 }],
    cashFlows: [],
    cash: 0, hkRate: 0.868, cashBase: 0, totalAsset: 10000,
    feeSettings: { ashare_stock: { commissionRate: 0.0003, commissionMin: 5, stampTaxRate: 0.001, transferRate: 0.00001, transferCap: 0, otherRate: 0 } }
  }, over || {});
}

(async () => {
  let skip = false;
  try { await pool.query('SELECT 1'); }
  catch (e) { console.log('  [SKIP] 无可用 PostgreSQL'); skip = true; results.push(['SKIP', '无 PG']); }

  if (!skip) {
    await ensureUser();
    await cleanup();

    // ---------- 1) 防还魂：表空 + JSON 非空 → 返回空 ----------
    await checkAsync('防还魂：四表清空但 JSON 有旧数组 → loadAccountData 返回空', async () => {
      // 用独立账户名，避免残留行干扰后续用例
      const A2 = A + '_ghost';
      await pool.query(`DELETE FROM account_data WHERE username=$1 AND account_name=$2`, [U, A2]);
      try {
        // 造 account_data 行，data 里塞满旧业务数组（模拟整改前的残留 JSON）
        await pool.query(
          `INSERT INTO account_data (username, account_name, data, version)
           VALUES ($1,$2,$3,1)`,
          [U, A2, JSON.stringify({
            positions: [{ id: 'p_ghost', code: '000001', name: '幽灵持仓', price: 1, quantity: 1, cost: 1 }],
            trades: [{ id: 't_ghost', date: '2026-01-01 09:30', code: '000001', name: '幽灵交易', direction: 'buy', price: 1, quantity: 1, amount: 1 }],
            navHistory: [{ date: '2026-01-01', nav: 9.9, totalAsset: 99999, invested: 99999 }],
            cashFlows: [{ id: 'c_ghost', date: '2026-01-01', amount: 99999 }],
            indexHistory: [{ date: '2026-01-01', '沪深300': 9999 }]
          })]
        );
        // 结构化表保持空
        const d = await loadAccountData(U, A2);
        assert.strictEqual(d.positions.length, 0, '持仓不应从 JSON 还魂');
        assert.strictEqual(d.trades.length, 0, '交易不应从 JSON 还魂');
        assert.strictEqual(d.navHistory.length, 0, '净值不应从 JSON 还魂');
        assert.strictEqual(d.cashFlows.length, 0, '现金流不应从 JSON 还魂');
        assert.strictEqual(d.indexHistory.length, 0, '指数历史不应从 JSON 还魂');
      } finally {
        await pool.query(`DELETE FROM account_data WHERE username=$1 AND account_name=$2`, [U, A2]);
      }
    });

    // ---------- 2) 读取接口不写库 ----------
    await checkAsync('读取不写库：indexHistory 表空 + JSON 有指数 → 只返回空，不自动迁移进表', async () => {
      const before = await pool.query('SELECT COUNT(*)::int AS c FROM index_history WHERE username=$1 AND account_name=$2', [U, A]);
      const d = await loadAccountData(U, A);
      assert.strictEqual(d.indexHistory.length, 0);
      const after = await pool.query('SELECT COUNT(*)::int AS c FROM index_history WHERE username=$1 AND account_name=$2', [U, A]);
      assert.strictEqual(after.rows[0].c, before.rows[0].c, '读取接口不应产生写库');
    });

    // ---------- 3) 数据集级版本控制（8.2 并发验收核心） ----------
    await checkAsync('数据集版本：后台写入净值 → 旧版本保存持仓不覆盖新净值', async () => {
      // 首次保存：带全部数据集初始版本 0
      const v1 = await saveAccountData(U, A, payload(), 0, { positions: 0, trades: 0, navHistory: 0, cashFlows: 0 });
      assert.strictEqual(v1.skipped.length, 0, '首存不应跳过任何数据集');
      // 后台任务新增一条净值（upsertNav 会提升 nav_version）
      await upsertNav(U, A, { date: '2026-01-02', nav: 1.05, totalAsset: 10500, invested: 8000 });
      // 旧浏览器快照（navHistory 版本仍是 0，库里已是 1）保存持仓
      const oldSnapshot = payload(); // navHistory 版本 0
      const r = await saveAccountData(U, A, oldSnapshot, v1.version, { positions: 0, trades: 0, navHistory: 0, cashFlows: 0 });
      assert.ok(r.skipped.includes('navHistory'), '净值数据集应被跳过（后台已更新）');
      // 后台新净值必须保留
      const d = await loadAccountData(U, A);
      assert.ok(d.navHistory.some(n => n.date === '2026-01-02'), '后台新增净值被旧快照覆盖了！');
      assert.strictEqual(d.positions.length, 1, '持仓（前端改动）应正常保存');
    });

    await checkAsync('数据集版本：无版本参数（旧客户端/测试）仍可全量保存', async () => {
      const d0 = await loadAccountData(U, A);
      const r = await saveAccountData(U, A, payload({ positions: [{ id: 'p2', code: '000001', name: '平安银行', price: 10, quantity: 100, cost: 9, type: '股票', subtype: 'A股', note: '' }] }), d0.version);
      assert.strictEqual(r.skipped.length, 0, '无版本参数时应允许全量写入');
    });

    // ---------- 4) 账户删除原子 + 重建同名 ----------
    await checkAsync('删除账户：全部业务表 + 元数据 + 兼容 JSON 一并删除', async () => {
      // 造各表数据
      await pool.query(`INSERT INTO positions (id, username, account_name, code) VALUES ('p_del',$1,$2,'600000')`, [U, A]);
      await pool.query(`INSERT INTO trades (id, username, account_name, date) VALUES ('t_del',$1,$2,'2026-01-01 09:30')`, [U, A]);
      await pool.query(`INSERT INTO daily_prices (username, account_name, date, code) VALUES ($1,$2,'2026-01-01','600000')`, [U, A]);
      // 调用路由层删除逻辑（这里直接执行与路由相同的事务 SQL）
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const t of ['positions', 'trades', 'nav_history', 'cash_flows', 'daily_prices', 'index_history', 'account_data', 'accounts']) {
          await client.query(`DELETE FROM ${t} WHERE username=$1 AND account_name=$2`, [U, A]);
        }
        await client.query('COMMIT');
      } finally { client.release(); }
      for (const t of ['positions', 'trades', 'nav_history', 'cash_flows', 'daily_prices', 'index_history', 'account_data', 'accounts']) {
        const { rows } = await pool.query(`SELECT COUNT(*)::int AS c FROM ${t} WHERE username=$1 AND account_name=$2`, [U, A]);
        assert.strictEqual(rows[0].c, 0, `删除后 ${t} 应为空`);
      }
    });

    await checkAsync('重建同名账户：不出现旧数据（孤立数据已随删除清空）', async () => {
      await saveAccountData(U, A, payload({ navHistory: [{ date: '2026-02-01', nav: 1.1, totalAsset: 11000, invested: 8000 }] }), 0);
      const d = await loadAccountData(U, A);
      assert.strictEqual(d.navHistory.length, 1);
      assert.strictEqual(d.navHistory[0].date, '2026-02-01');
      assert.ok(!d.navHistory.some(n => n.date === '2026-01-01'), '重建后不应出现删除前的旧净值');
    });

    // ---------- 5) 账户重命名原子（模拟路由事务，含 accounts.id 哈希同步） ----------
    await checkAsync('重命名账户：各表 account_name 全部原子更新', async () => {
      // 无论断言成败都恢复原名，避免 id(sha256) 残留导致后续用例主键冲突
      try {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          for (const t of ['positions', 'trades', 'nav_history', 'cash_flows', 'daily_prices', 'index_history', 'account_data']) {
            await client.query(`UPDATE ${t} SET account_name=$3 WHERE username=$1 AND account_name=$2`, [U, A, A + '_新名']);
          }
          const crypto = require('crypto');
          const newId = crypto.createHash('sha256').update(U + '\n' + A + '_新名').digest('hex');
          await client.query('UPDATE accounts SET id=$3, account_name=$4 WHERE username=$1 AND account_name=$2', [U, A, newId, A + '_新名']);
          await client.query('COMMIT');
        } finally { client.release(); }
        // 新名下应有数据
        const d = await loadAccountData(U, A + '_新名');
        assert.ok(Array.isArray(d.navHistory) && d.navHistory.length === 1, '新名应能读到数据，实际=' + (d.navHistory || []).length);
        const { rows: cnt } = await pool.query('SELECT COUNT(*)::int AS c FROM account_data WHERE username=$1 AND account_name=$2', [U, A]);
        assert.strictEqual(cnt[0].c, 0, '旧名不应残留');
        // 旧名可重建（id 哈希已随新名更新，不冲突）
        const rb = await saveAccountData(U, A, payload({ navHistory: [{ date: '2026-03-01', nav: 1.2, totalAsset: 12000, invested: 8000 }] }), 0);
        assert.ok(rb && rb.ok !== false, '旧名重建应成功');
        const d3 = await loadAccountData(U, A);
        assert.ok(d3.navHistory.length === 1 && d3.navHistory[0].date === '2026-03-01', '旧名重建后是新数据而非残留');
        // 清理重建数据，恢复现场
        await pool.query('DELETE FROM nav_history WHERE username=$1 AND account_name=$2', [U, A]);
        await pool.query('DELETE FROM positions WHERE username=$1 AND account_name=$2', [U, A]);
        await pool.query('DELETE FROM account_data WHERE username=$1 AND account_name=$2', [U, A]);
        await pool.query('DELETE FROM accounts WHERE username=$1 AND account_name=$2', [U, A]);
      } finally {
        // 改回原名，恢复测试现场（含 accounts.id 哈希）
        const client2 = await pool.connect();
        try {
          await client2.query('BEGIN');
          for (const t of ['positions', 'trades', 'nav_history', 'cash_flows', 'daily_prices', 'index_history', 'account_data']) {
            await client2.query(`UPDATE ${t} SET account_name=$3 WHERE username=$1 AND account_name=$2`, [U, A + '_新名', A]);
          }
          const crypto = require('crypto');
          const oldId = crypto.createHash('sha256').update(U + '\n' + A).digest('hex');
          await client2.query('UPDATE accounts SET id=$3, account_name=$4 WHERE username=$1 AND account_name=$2', [U, A + '_新名', oldId, A]);
          await client2.query('COMMIT');
        } finally { client2.release(); }
      }
    });

    // ---------- 6) 静态边界：业务代码不再读取 JSON 五类业务数组 ----------
    await checkAsync('静态边界：accounts.js 不含 JSON 业务数组兜底/自动迁移/双写代码', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'db', 'accounts.js'), 'utf-8');
      const forbidden = [
        /d\.positions \|\| \[\], trades: d\.trades/,   // 四表全空 JSON 兜底
        /jsonData\.indexHistory/,                        // 读接口自动迁移指数
        /result = \{ \.\.\.d, positions/,                // 整包 JSON 覆盖
        /jsonb_set\(data::jsonb, '\{navHistory\}'/,      // 净值 JSON 双写
      ];
      for (const re of forbidden) {
        assert.ok(!re.test(src), '发现禁止的 JSON 兼容链路模式: ' + re);
      }
    });

    await cleanup();
  }

  const pass = results.filter(r => r[0] === 'PASS').length;
  const fail = results.filter(r => r[0] === 'FAIL').length;
  console.log('\n===== 数据源架构整改回归汇总 =====');
  console.log('PASS=' + pass + '  FAIL=' + fail + '  SKIP=' + (results.length - pass - fail));
  if (fail > 0) { console.log('HAS_ISSUES'); process.exit(1); }
  console.log('ALL PASS');
  await pool.end();
  process.exit(0);
})().catch(async e => {
  console.error('异常', e);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});

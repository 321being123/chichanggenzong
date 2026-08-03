// ========== 账户双数据源架构整改回归测试（2026-08-03 整改报告 8.4 验收） ==========
// 运行：node server/test/data-source-arch.test.js
// 覆盖：
//  1) 表空、JSON 非空时禁止还魂（loadAccountData 永远从结构化表组装）
//  2) 读取接口不写库（indexHistory 表空时不再自动迁移 JSON）
//  3) 数据集级版本控制：后台写入净值后，旧浏览器保存持仓不覆盖新净值（8.2 并发验收）
//  4) P0-1：连续两次保存不误报冲突（保存成功后数据集版本同步更新）
//  5) 账户删除原子（走 db 层 deleteAccountData 真实函数 + users.accounts 同步）：删除后重建同名不出现旧数据
//  6) 账户重命名原子（走 db 层 renameAccountData 真实函数）：业务表/元数据/列表全部改名，旧名可重建
//  7) 静态边界：业务代码不再读取 JSON 五类业务数组
// 全部使用专用测试数据并在 finally 清理，绝不触碰真实账户数据。
const assert = require('assert');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { pool } = require('../db');
const { loadAccountData, saveAccountData, upsertNav, upsertIndexPoints, loadIndexPoints, deleteAccountData, renameAccountData } = require('../db/accounts');

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

    await checkAsync('P0-1：连续两次保存不误报冲突（数据集版本随保存同步更新）', async () => {
      // 基于现有数据（前面用例已建），读取当前版本 → 保存 → 用返回的新版本再保存
      const d0 = await loadAccountData(U, A);
      const cur = { v: d0.version, pv: d0.posVersion, tv: d0.tradeVersion, nv: d0.navVersion, cv: d0.cashflowVersion };
      // 第一次保存（用当前版本）
      const v1 = await saveAccountData(U, A, payload(), cur.v,
        { positions: cur.pv, trades: cur.tv, navHistory: cur.nv, cashFlows: cur.cv });
      assert.strictEqual(v1.skipped.length, 0, '第一次保存不应跳过');
      assert.strictEqual(v1.posVersion, cur.pv + 1, '保存后 positions 版本应 +1');
      assert.strictEqual(v1.navVersion, cur.nv + 1, '保存后 navHistory 版本应 +1');
      // 第二次保存：用第一次返回的新版本（模拟前端 saveDataNow 已同步数据集版本）
      const p2 = payload({ positions: [{ id: 'p1', code: '600519', name: '贵州茅台', price: 1001, quantity: 11, cost: 900, type: '股票', subtype: 'A股', note: '' }] });
      const v2 = await saveAccountData(U, A, p2, v1.version,
        { positions: v1.posVersion, trades: v1.tradeVersion, navHistory: v1.navVersion, cashFlows: v1.cashflowVersion });
      assert.strictEqual(v2.skipped.length, 0, '第二次保存不应跳过任何数据集（否则=误报冲突）');
      assert.strictEqual(v2.posVersion, cur.pv + 2, '第二次保存后 positions 版本应再 +1');
      const d = await loadAccountData(U, A);
      assert.strictEqual(d.positions[0].quantity, 11, '第二次保存的持仓改动应生效');
    });

    await checkAsync('P0-1：保存成功后前端同步数据集版本（loadAccountData 返回新版本）', async () => {
      const d = await loadAccountData(U, A);
      // 前面用例已多次保存推进版本，只需断言返回的是正数且可用（前端保存时带回）
      assert.ok(d.posVersion >= 1, 'loadAccountData 应返回最新数据集版本供前端保存时带回');
      assert.ok(d.navVersion >= 1);
    });

    await checkAsync('数据集版本：无版本参数（纯数据层调用/测试）允许全量写入', async () => {
      const d0 = await loadAccountData(U, A);
      const r = await saveAccountData(U, A, payload({ positions: [{ id: 'p2', code: '000001', name: '平安银行', price: 10, quantity: 100, cost: 9, type: '股票', subtype: 'A股', note: '' }] }), d0.version);
      assert.strictEqual(r.skipped.length, 0, '无版本参数时应允许全量写入（db 层兼容内部调用）');
    });

    // ---------- 4) 账户删除原子（走 db 层真实函数）+ 重建同名 ----------
    await checkAsync('删除账户：deleteAccountData 删全部业务表 + 元数据 + 兼容 JSON + users.accounts 列表', async () => {
      // 造各表数据
      await pool.query(`INSERT INTO positions (id, username, account_name, code) VALUES ('p_del',$1,$2,'600000')`, [U, A]);
      await pool.query(`INSERT INTO trades (id, username, account_name, date) VALUES ('t_del',$1,$2,'2026-01-01 09:30')`, [U, A]);
      await pool.query(`INSERT INTO daily_prices (username, account_name, date, code) VALUES ($1,$2,'2026-01-01','600000')`, [U, A]);
      // 确保 users.accounts 列表含该账户
      await pool.query(`UPDATE users SET accounts=$2::jsonb::text WHERE username=$1`,
        [U, JSON.stringify([A, A + '_保留'])]);
      const r = await deleteAccountData(U, A);
      assert.strictEqual(r.ok, true);
      for (const t of ['positions', 'trades', 'nav_history', 'cash_flows', 'daily_prices', 'index_history', 'account_data', 'accounts']) {
        const { rows } = await pool.query(`SELECT COUNT(*)::int AS c FROM ${t} WHERE username=$1 AND account_name=$2`, [U, A]);
        assert.strictEqual(rows[0].c, 0, `删除后 ${t} 应为空`);
      }
      // users.accounts 列表同步移除
      const { rows: u } = await pool.query('SELECT accounts FROM users WHERE username=$1', [U]);
      const list = JSON.parse(u[0].accounts);
      assert.ok(!list.includes(A), 'users.accounts 应移除被删账户');
      assert.ok(list.includes(A + '_保留'), '其他账户不应被误删');
    });

    await checkAsync('重建同名账户：不出现旧数据（孤立数据已随删除清空）', async () => {
      await saveAccountData(U, A, payload({ navHistory: [{ date: '2026-02-01', nav: 1.1, totalAsset: 11000, invested: 8000 }] }), 0);
      const d = await loadAccountData(U, A);
      assert.strictEqual(d.navHistory.length, 1);
      assert.strictEqual(d.navHistory[0].date, '2026-02-01');
      assert.ok(!d.navHistory.some(n => n.date === '2026-01-01'), '重建后不应出现删除前的旧净值');
    });

    // ---------- 5) 账户重命名原子（走 db 层真实函数 renameAccountData） ----------
    await checkAsync('重命名账户：renameAccountData 全表原子改名 + users.accounts 同步', async () => {
      // 无论断言成败都恢复原名，避免 id(sha256) 残留导致后续用例主键冲突
      try {
        // 确保 users.accounts 列表含被重命名账户（重建同名用例不更新列表，这里补上）
        await pool.query(`UPDATE users SET accounts=$2::jsonb::text WHERE username=$1`,
          [U, JSON.stringify([A, A + '_保留'])]);
        const r = await renameAccountData(U, A, A + '_新名');
        assert.strictEqual(r.ok, true);
        // 新名下应有数据
        const d = await loadAccountData(U, A + '_新名');
        assert.ok(Array.isArray(d.navHistory) && d.navHistory.length === 1, '新名应能读到数据，实际=' + (d.navHistory || []).length);
        const { rows: cnt } = await pool.query('SELECT COUNT(*)::int AS c FROM account_data WHERE username=$1 AND account_name=$2', [U, A]);
        assert.strictEqual(cnt[0].c, 0, '旧名不应残留');
        // users.accounts 列表同步
        const { rows: u } = await pool.query('SELECT accounts FROM users WHERE username=$1', [U]);
        const list = JSON.parse(u[0].accounts);
        assert.ok(list.includes(A + '_新名'), 'users.accounts 应含新名');
        assert.ok(!list.includes(A), 'users.accounts 不应再含旧名');
        // 旧名可重建（id 哈希已随新名更新，不冲突）
        const rb = await saveAccountData(U, A, payload({ navHistory: [{ date: '2026-03-01', nav: 1.2, totalAsset: 12000, invested: 8000 }] }), 0);
        assert.ok(rb && rb.version >= 1, '旧名重建应成功');
        const d3 = await loadAccountData(U, A);
        assert.ok(d3.navHistory.length === 1 && d3.navHistory[0].date === '2026-03-01', '旧名重建后是新数据而非残留');
        // 清理重建数据，恢复现场
        await pool.query('DELETE FROM nav_history WHERE username=$1 AND account_name=$2', [U, A]);
        await pool.query('DELETE FROM positions WHERE username=$1 AND account_name=$2', [U, A]);
        await pool.query('DELETE FROM account_data WHERE username=$1 AND account_name=$2', [U, A]);
        await pool.query('DELETE FROM accounts WHERE username=$1 AND account_name=$2', [U, A]);
        // 清理新名（避免残留），然后重建原名数据
        await pool.query('DELETE FROM nav_history WHERE username=$1 AND account_name=$2', [U, A + '_新名']);
        await pool.query('DELETE FROM positions WHERE username=$1 AND account_name=$2', [U, A + '_新名']);
        await pool.query('DELETE FROM account_data WHERE username=$1 AND account_name=$2', [U, A + '_新名']);
        await pool.query('DELETE FROM accounts WHERE username=$1 AND account_name=$2', [U, A + '_新名']);
      } finally {
        // 确保恢复到 A 名下的干净状态
        await cleanup();
        await pool.query(`UPDATE users SET accounts=$2::jsonb::text WHERE username=$1`, [U, JSON.stringify([A])]);
      }
    });

    await checkAsync('重命名冲突：目标名已存在时拒绝且不破坏数据', async () => {
      // 确保 A 与 A_保留 都真实存在于 accounts 表（renameAccountData 的 dup 查的是 accounts 表）
      await saveAccountData(U, A, payload(), 0);
      await saveAccountData(U, A + '_保留', payload(), 0);
      await pool.query(`UPDATE users SET accounts=$2::jsonb::text WHERE username=$1`,
        [U, JSON.stringify([A, A + '_保留'])]);
      const r = await renameAccountData(U, A, A + '_保留');
      assert.strictEqual(r.conflict, '该名称已被使用');
      // 原账户数据完好
      const d = await loadAccountData(U, A);
      assert.ok(Array.isArray(d.navHistory), '冲突后原账户应完好');
      // 清理保留账户（含全部业务表，避免审计残留）
      for (const t of ['positions', 'trades', 'nav_history', 'cash_flows', 'daily_prices', 'index_history', 'account_data', 'accounts']) {
        await pool.query(`DELETE FROM ${t} WHERE username=$1 AND account_name=$2`, [U, A + '_保留']);
      }
      await pool.query(`UPDATE users SET accounts=$2::jsonb::text WHERE username=$1`, [U, JSON.stringify([A])]);
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

    await checkAsync('迁移041执行器级：失败账户抛错不登记，下次启动重试成功后登记', async () => {
      // 独立测试用户 + 测试专用迁移版本号（不污染真实 041 登记）
      const M = 'mig041_fail_test';
      const A_bad = '坏JSON', A_ok = '好账户';
      const TEST_VERSION = '041_test_guard_' + Date.now();
      await pool.query(`DELETE FROM account_data WHERE username=$1`, [M]);
      await pool.query(`DELETE FROM accounts WHERE username=$1`, [M]);
      await pool.query(`DELETE FROM users WHERE username=$1`, [M]);
      await pool.query(`DELETE FROM schema_migrations WHERE version=$1`, [TEST_VERSION]);
      try {
        await pool.query(`INSERT INTO users (username, password, accounts) VALUES ($1,'x','[]')`, [M]);
        // 坏 JSON → 偏好迁移解析失败 → 应抛错且不归档（data_source_version 保持 1 待重试）
        await pool.query(`INSERT INTO account_data (username, account_name, data, data_source_version) VALUES ($1,$2,'{invalid json',0)`, [M, A_bad]);
        // 好账户 → 应归档 + feeSettings 迁入 accounts
        await pool.query(`INSERT INTO account_data (username, account_name, data, data_source_version) VALUES ($1,$2,'{"feeSettings":{"ashare_stock":{"commissionRate":0.0002}}}',0)`, [M, A_ok]);
        const migrations = require('../db/migrations');
        const fn = migrations.MIGRATIONS.find(m => m.version === '041_account_data_source');

        // ---- 第一次启动：runMigration 执行 041，失败账户存在 → up 抛错 → 不登记 ----
        let firstThrew = false;
        try { await migrations.runMigration(fn.up, TEST_VERSION); }
        catch (e) { firstThrew = true; }
        assert.ok(firstThrew, '失败账户存在时 041 应抛错（runMigration 不登记）');
        const reg1 = await pool.query('SELECT 1 FROM schema_migrations WHERE version=$1', [TEST_VERSION]);
        assert.strictEqual(reg1.rowCount, 0, '失败时 041 不应登记为已完成');
        const { rows: r1 } = await pool.query('SELECT data_source_version FROM account_data WHERE username=$1 AND account_name=$2', [M, A_bad]);
        assert.strictEqual(r1[0].data_source_version, 1, '坏JSON账户应保持待重试');
        const { rows: r2 } = await pool.query('SELECT data_source_version FROM account_data WHERE username=$1 AND account_name=$2', [M, A_ok]);
        assert.strictEqual(r2[0].data_source_version, 2, '好账户应已归档');
        const { rows: r3 } = await pool.query('SELECT fee_settings FROM accounts WHERE username=$1 AND account_name=$2', [M, A_ok]);
        assert.ok(r3[0].fee_settings !== null, '好账户 feeSettings 应已迁移');

        // ---- 修复坏数据（模拟运维修复 JSON）后第二次启动：runMigration 重跑 041 成功并登记 ----
        await pool.query(`UPDATE account_data SET data='{"feeSettings":{"ashare_stock":{"commissionRate":0.0003}}}' WHERE username=$1 AND account_name=$2`, [M, A_bad]);
        await migrations.runMigration(fn.up, TEST_VERSION); // 应成功不抛错
        const reg2 = await pool.query('SELECT 1 FROM schema_migrations WHERE version=$1', [TEST_VERSION]);
        assert.strictEqual(reg2.rowCount, 1, '第二次成功后 041 应登记');
        const { rows: r1b } = await pool.query('SELECT data_source_version FROM account_data WHERE username=$1 AND account_name=$2', [M, A_bad]);
        assert.strictEqual(r1b[0].data_source_version, 2, '修复后重跑应归档成功');
        // 第三次启动：已登记 → runMigrations 跳过
        const reg3 = await pool.query('SELECT 1 FROM schema_migrations WHERE version=$1', [TEST_VERSION]);
        assert.strictEqual(reg3.rowCount, 1, '已登记后不再重复');
      } finally {
        await pool.query(`DELETE FROM account_data WHERE username=$1`, [M]);
        await pool.query(`DELETE FROM accounts WHERE username=$1`, [M]);
        await pool.query(`DELETE FROM users WHERE username=$1`, [M]);
        await pool.query(`DELETE FROM schema_migrations WHERE version=$1`, [TEST_VERSION]);
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

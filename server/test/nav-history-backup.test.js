// ========== 历史净值备份/还原/清理（db 层）回归测试 ==========
// 运行：node server/test/nav-history-backup.test.js
// 验证：备份/还原/清理操作的是真实 nav_history 表（页面读取来源），且还原提升 version；
//      无备份还原报错；全部使用专用测试数据并在 finally 清理，绝不触碰真实账户数据。
const assert = require('assert');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { pool } = require('../db');
const { backupNavHistory, restoreNavHistory, clearNavHistory } = require('../db/accounts');

const U = 'nav_test_user';
const A = '净值备份测试账户';
const results = [];
function check(name, fn) {
  try { fn(); results.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (e) { results.push(['FAIL', name + ' :: ' + (e && e.message ? e.message : e)]); console.log('  [FAIL] ' + name + ' :: ' + (e && e.message ? e.message : e)); }
}
async function checkAsync(name, fn) {
  try { await fn(); results.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (e) { results.push(['FAIL', name + ' :: ' + (e && e.message ? e.message : e)]); console.log('  [FAIL] ' + name + ' :: ' + (e && e.message ? e.message : e)); }
}

// 清理测试数据（幂等）
async function cleanup() {
  await pool.query('DELETE FROM nav_history WHERE username=$1 AND account_name=$2', [U, A]);
  await pool.query('DELETE FROM account_data WHERE username=$1 AND account_name=$2', [U, A]);
}

(async () => {
  let skip = false;
  try { await pool.query('SELECT 1'); }
  catch (e) { console.log('  [SKIP] 无可用 PostgreSQL'); skip = true; results.push(['SKIP', '无 PG']); }

  if (!skip) {
    await cleanup();
    // 造初始数据：account_data 行 + nav_history 3 条
    await pool.query(
      `INSERT INTO account_data (username, account_name, data, version) VALUES ($1,$2,$3,1)`,
      [U, A, JSON.stringify({ positions: [], trades: [], navHistory: [], cashFlows: [], cash: 0, hkRate: 0.868, cashBase: 0, totalAsset: 0, fundRecord: null, feeSettings: {} })]
    );
    await pool.query(
      `INSERT INTO nav_history (username, account_name, date, nav, total_asset, invested) VALUES
       ($1,$2,'2024-01-01',1.0,1000,500),($1,$2,'2024-01-02',1.1,1100,600),($1,$2,'2024-01-03',1.2,1200,700)`,
      [U, A]
    );

    await checkAsync('备份：nav_history 表快照写入 nav_history_backup', async () => {
      const r = await backupNavHistory(U, A);
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.rows, 3);
      const { rows } = await pool.query('SELECT nav_history_backup FROM account_data WHERE username=$1 AND account_name=$2', [U, A]);
      assert.ok(Array.isArray(rows[0].nav_history_backup) && rows[0].nav_history_backup.length === 3);
    });

    await checkAsync('还原：写回 nav_history 表且 version 提升', async () => {
      // 先破坏：删掉两条 + 改一条 invested
      await pool.query('DELETE FROM nav_history WHERE username=$1 AND account_name=$2 AND date=$3', [U, A, '2024-01-02']);
      await pool.query('UPDATE nav_history SET invested=99999 WHERE username=$1 AND account_name=$2 AND date=$3', [U, A, '2024-01-03']);
      const { rows: v1 } = await pool.query('SELECT version FROM account_data WHERE username=$1 AND account_name=$2', [U, A]);
      const r = await restoreNavHistory(U, A);
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.rows, 3);
      const { rows: hist } = await pool.query('SELECT date, invested FROM nav_history WHERE username=$1 AND account_name=$2 ORDER BY date', [U, A]);
      assert.strictEqual(hist.length, 3);
      assert.strictEqual(hist[1].date, '2024-01-02'); // 被删的恢复了
      assert.strictEqual(Number(hist[2].invested), 700); // 被改的还原了
      const { rows: v2 } = await pool.query('SELECT version FROM account_data WHERE username=$1 AND account_name=$2', [U, A]);
      assert.ok(v2[0].version > v1[0].version, '还原后 version 应提升');
    });

    await checkAsync('还原：无备份时明确报错', async () => {
      await pool.query('UPDATE account_data SET nav_history_backup=NULL, nav_history_backup_at=NULL WHERE username=$1 AND account_name=$2', [U, A]);
      let threw = false;
      try { await restoreNavHistory(U, A); }
      catch (e) { threw = true; assert.ok(/没有备份/.test(e.message), '错误提示不符: ' + e.message); assert.strictEqual(e.status, 404); }
      assert.ok(threw, '无备份应报错');
    });

    await checkAsync('清理 invested-only：清空投入本金字段（表 + JSON 双写）', async () => {
      await backupNavHistory(U, A); // 重新造备份（还原用例清过）
      const r = await clearNavHistory(U, A, 'invested-only');
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.rows, 0, '清空投入本金不删除记录');
      const { rows: hist } = await pool.query('SELECT invested FROM nav_history WHERE username=$1 AND account_name=$2', [U, A]);
      assert.ok(hist.every(h => h.invested === null), '表 invested 应全为 null');
      const { rows: jr } = await pool.query('SELECT data FROM account_data WHERE username=$1 AND account_name=$2', [U, A]);
      const jd = JSON.parse(jr[0].data);
      assert.ok(jd.navHistory.every(n => n.invested == null), 'JSON invested 应全为 null');
    });

    await checkAsync('清理 before-date：删除指定日期前（含）记录', async () => {
      const r = await clearNavHistory(U, A, 'before-date', '2024-01-02');
      assert.strictEqual(r.ok, true);
      const { rows: hist } = await pool.query('SELECT date FROM nav_history WHERE username=$1 AND account_name=$2 ORDER BY date', [U, A]);
      assert.strictEqual(hist.length, 1);
      assert.strictEqual(hist[0].date, '2024-01-03');
    });

    await checkAsync('清理 keep-latest：删除除最近一天外全部记录', async () => {
      // 先清空再补 3 条
      await pool.query('DELETE FROM nav_history WHERE username=$1 AND account_name=$2', [U, A]);
      await pool.query(
        `INSERT INTO nav_history (username, account_name, date, nav, total_asset, invested) VALUES
         ($1,$2,'2024-01-01',1.0,1000,500),($1,$2,'2024-01-02',1.1,1100,600),($1,$2,'2024-01-03',1.2,1200,700)`,
        [U, A]
      );
      const r = await clearNavHistory(U, A, 'keep-latest');
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.rows, 2, '应删除最近一天之外的全部（删除 2 条）');
      const { rows: hist } = await pool.query('SELECT date FROM nav_history WHERE username=$1 AND account_name=$2 ORDER BY date', [U, A]);
      assert.strictEqual(hist.length, 1);
      assert.strictEqual(hist[0].date, '2024-01-03', '应保留最近一天');
      const { rows: jr } = await pool.query('SELECT data FROM account_data WHERE username=$1 AND account_name=$2', [U, A]);
      const jd = JSON.parse(jr[0].data);
      assert.ok(Array.isArray(jd.navHistory) && jd.navHistory.length === 1 && jd.navHistory[0].date === '2024-01-03',
        'JSON navHistory 应同步只保留最近一天');
    });

    await checkAsync('清理：非法模式报错', async () => {
      let threw = false;
      try { await clearNavHistory(U, A, 'nonsense'); }
      catch (e) { threw = true; assert.strictEqual(e.status, 400); }
      assert.ok(threw, '非法模式应报错');
    });

    await checkAsync('新账户（无 account_data 行）备份也能保存快照', async () => {
      // 用独立账户名模拟"从未保存过"的新账户
      const U2 = U + '_new', A2 = A + '_新';
      await pool.query('DELETE FROM account_data WHERE username=$1 AND account_name=$2', [U2, A2]);
      await pool.query('DELETE FROM nav_history WHERE username=$1 AND account_name=$2', [U2, A2]);
      try {
        const r = await backupNavHistory(U2, A2); // 无 account_data 行
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.rows, 0);
        const { rows } = await pool.query('SELECT nav_history_backup, version FROM account_data WHERE username=$1 AND account_name=$2', [U2, A2]);
        assert.ok(rows.length === 1, '应创建 account_data 行');
        assert.ok(Array.isArray(rows[0].nav_history_backup) && rows[0].nav_history_backup.length === 0, '快照应为空数组');
        assert.strictEqual(rows[0].version, 0, '新行 version 应为 0（不破坏前端首存）');
      } finally {
        await pool.query('DELETE FROM account_data WHERE username=$1 AND account_name=$2', [U2, A2]);
        await pool.query('DELETE FROM nav_history WHERE username=$1 AND account_name=$2', [U2, A2]);
      }
    });

    await checkAsync('空快照（0 条）可还原为空历史，不误判为无备份', async () => {
      const U2 = U + '_empty', A2 = A + '_空';
      await pool.query('DELETE FROM account_data WHERE username=$1 AND account_name=$2', [U2, A2]);
      await pool.query('DELETE FROM nav_history WHERE username=$1 AND account_name=$2', [U2, A2]);
      try {
        // 造一条数据再清掉：验证"导入前有数据 → 备份(1条) → 导入清空 → 还原恢复"之外的场景
        await pool.query(`INSERT INTO nav_history (username, account_name, date, nav, total_asset, invested)
                          VALUES ($1,$2,'2024-01-01',1.0,1000,500)`, [U2, A2]);
        await backupNavHistory(U2, A2); // 备份 1 条
        await pool.query('DELETE FROM nav_history WHERE username=$1 AND account_name=$2', [U2, A2]); // 模拟误操作清空
        // 此时快照 1 条 → 还原
        const r = await restoreNavHistory(U2, A2);
        assert.strictEqual(r.rows, 1);
        // 现在制造"0 条快照"：先清空表再备份（0 条），再插入数据，再还原 → 应清空
        await pool.query('DELETE FROM nav_history WHERE username=$1 AND account_name=$2', [U2, A2]);
        await backupNavHistory(U2, A2); // 覆盖为 0 条快照
        await pool.query(`INSERT INTO nav_history (username, account_name, date, nav, total_asset, invested)
                          VALUES ($1,$2,'2025-05-05',2.0,2000,800)`, [U2, A2]);
        const r2 = await restoreNavHistory(U2, A2); // 0 条快照 → 应成功清空
        assert.strictEqual(r2.ok, true);
        assert.strictEqual(r2.rows, 0);
        const { rows: hist } = await pool.query('SELECT date FROM nav_history WHERE username=$1 AND account_name=$2', [U2, A2]);
        assert.strictEqual(hist.length, 0, '0 条快照还原后历史应为空');
      } finally {
        await pool.query('DELETE FROM account_data WHERE username=$1 AND account_name=$2', [U2, A2]);
        await pool.query('DELETE FROM nav_history WHERE username=$1 AND account_name=$2', [U2, A2]);
      }
    });

    await cleanup();
  }

  const pass = results.filter(r => r[0] === 'PASS').length;
  const fail = results.filter(r => r[0] === 'FAIL').length;
  console.log('\n===== 历史净值备份/还原回归汇总 =====');
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

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

    await checkAsync('清理 invested-only：清空投入本金字段', async () => {
      await backupNavHistory(U, A); // 重新造备份（还原用例清过）
      const r = await clearNavHistory(U, A, 'invested-only');
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.rows, 3);
      const { rows: hist } = await pool.query('SELECT invested FROM nav_history WHERE username=$1 AND account_name=$2', [U, A]);
      assert.ok(hist.every(h => h.invested === null), 'invested 应全为 null');
    });

    await checkAsync('清理 before-date：删除指定日期前（含）记录', async () => {
      const r = await clearNavHistory(U, A, 'before-date', '2024-01-02');
      assert.strictEqual(r.ok, true);
      const { rows: hist } = await pool.query('SELECT date FROM nav_history WHERE username=$1 AND account_name=$2 ORDER BY date', [U, A]);
      assert.strictEqual(hist.length, 1);
      assert.strictEqual(hist[0].date, '2024-01-03');
    });

    await checkAsync('清理：非法模式报错', async () => {
      let threw = false;
      try { await clearNavHistory(U, A, 'nonsense'); }
      catch (e) { threw = true; assert.strictEqual(e.status, 400); }
      assert.ok(threw, '非法模式应报错');
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

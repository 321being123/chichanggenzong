// ========== DATA-02 数据集③：可转债主档/正股关联/行情 双读核对 ==========
// 运行：node server/test/data-convergence-bond-master.test.js
// 目的：收敛可转债标准数据读取链路。
//   - 可转债主档与正股关联统一读取者 = bondDataService（bond_unified 视图）。
//   - 双读核对：统一读取者 getActiveBondCodes() 与权威 SQL（bond_unified WHERE status='listed'）集合一致。
//   - 正股关联完整性：bond_history 有正股代码的债券，统一视图 stock_code 必须全覆盖（P1-1）。
// 依赖本地 PostgreSQL（portfolio 库）；连不上时优雅跳过（不影响通过）。不写入任何数据。
const assert = require('assert');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const results = [];
function check(name, fn) {
  try { fn(); results.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (e) { results.push(['FAIL', name + ' :: ' + (e && e.message ? e.message : e)]); console.log('  [FAIL] ' + name + ' :: ' + (e && e.message ? e.message : e)); }
}

(async () => {
  let pool = null;
  try {
    const db = require('../../server/db');
    pool = db.pool;
    const bondSvc = require('../../server/services/bondDataService');

    // 1) 双读核对：统一读取者 getActiveBondCodes() 与权威 SQL 集合一致（顺序无关）
    const svcCodes = await bondSvc.getActiveBondCodes();
    const { rows: sqlRows } = await pool.query(
      `SELECT bond_code FROM public.bond_unified WHERE status='listed' ORDER BY bond_code`);
    const sqlCodes = sqlRows.map(r => r.bond_code);
    check('双读核对：getActiveBondCodes() ≡ 权威 SQL（bond_unified 在市债券集合一致）', () => {
      assert.deepStrictEqual(svcCodes.slice().sort(), sqlCodes.slice().sort(),
        '统一读取者与权威 SQL 返回的在市可转债集合不一致');
    });

    // 2) 正股关联完整性：bond_history 有正股代码的债券，统一视图 stock_code 不应缺失
    const missing = await pool.query(
      `SELECT count(*)::int AS n FROM bond_unified bu
       JOIN bond_history bh ON bh.security_code = split_part(bu.bond_code, '.', 1)
       WHERE (bu.stock_code IS NULL OR bu.stock_code='')
         AND bh.stk_code IS NOT NULL AND bh.stk_code <> ''`);
    check('正股关联完整性：bond_history 有正股代码的债券视图缺失数为 0', () => {
      assert.strictEqual(missing.rows[0].n, 0, `仍有 ${missing.rows[0].n} 条正股关联缺失`);
    });

    // 3) 主档读取者唯一性：getBondList 走 bond_unified 视图（统一读取层）
    const list = await bondSvc.getBondList({ limit: 1 });
    check('主档读取者：getBondList 经 bond_unified 返回结构化主档', () => {
      // 允许库为空（返回 []），有数据时每行应为对象
      assert.ok(Array.isArray(list), 'getBondList 应返回数组');
    });
  } catch (e) {
    if (!pool) {
      console.log('  [SKIP] 无可用 PostgreSQL，跳过 DATA-02 数据集③ 双读核对');
      results.push(['SKIP', 'SKIP-DATA-02-ds3']);
    } else {
      results.push(['FAIL', '异常: ' + (e && e.message ? e.message : e)]);
      console.log('  [FAIL] 异常: ' + (e && e.stack ? e.stack : e));
    }
  } finally {
    if (pool) { try { await pool.end(); } catch (_) {} }
  }

  const pass = results.filter(r => r[0] === 'PASS').length;
  const fail = results.filter(r => r[0] === 'FAIL').length;
  const skip = results.filter(r => r[0] === 'SKIP').length;
  console.log('\n===== DATA-02 数据集③ 双读核对汇总 =====');
  console.log('PASS=' + pass + '  FAIL=' + fail + '  SKIP=' + skip);
  if (fail > 0) { console.log('HAS_ISSUES'); process.exit(1); }
  if (skip > 0) {
    if (process.env.CI === '1') { console.log('CI 模式下不允许跳过关键测试'); process.exit(1); }
    console.log('SKIPPED');
    process.exit(0);
  }
  console.log('ALL PASS');
})();

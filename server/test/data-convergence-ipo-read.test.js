// ========== DATA-02 数据集④：打新统一读取核对 ==========
// 运行：node server/test/data-convergence-ipo-read.test.js
// 目的：收敛打新（可转债发行）标准数据读取链路。
//   - 统一读取者 = bondDataService.getBondHistoryList（bond_unified 视图）。
//   - 统一读取者返回的证券集合与标准 bond_unified 视图一致（按六位 security_code）。
//   - 兼容编码：security_code 为六位纯数字、canonical_code 带 .SH/.SZ 后缀（P2-1）。
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

    // 1) 标准视图每只证券都必须被统一读取者命中（无遗漏）
    const list = await bondSvc.getBondHistoryList(100000);
    const { rows: histRows } = await pool.query(
      `SELECT security_code FROM public.bond_unified
       WHERE issue_type IS NULL OR issue_type NOT IN ('定向', '私募')`);
    const newCodes = list.map(r => r.security_code);
    const oldCodes = histRows.map(r => r.security_code);
    check('统一读取核对：标准视图证券均被读取者覆盖（无遗漏）', () => {
      const missing = oldCodes.filter(c => !newCodes.includes(c));
      assert.strictEqual(missing.length, 0,
        '以下标准视图证券未被统一读取者覆盖: ' + missing.slice(0, 10).join(','));
    });

    // 2) 兼容编码：security_code 六位纯数字、canonical_code 带后缀
    check('兼容编码：security_code 六位纯数字 + canonical_code 带后缀', () => {
      for (const row of list) {
        assert.match(String(row.security_code), /^\d{6}$/, `非六位: ${row.security_code}`);
        assert.ok(String(row.canonical_code).includes('.'), `canonical_code 缺后缀: ${row.canonical_code}`);
      }
    });

    // 3) 定向/私募已被兼容读取过滤（issue_type 不在展示范围）
    check('兼容读取：已过滤定向/私募发行', () => {
      for (const row of list) {
        assert.notStrictEqual(row.issue_type, '定向');
        assert.notStrictEqual(row.issue_type, '私募');
      }
    });
  } catch (e) {
    if (!pool || e.code === 'ECONNREFUSED' || e.name === 'AggregateError') {
      console.log('  [SKIP] 无可用 PostgreSQL，跳过 DATA-02 数据集④ 双读核对');
      results.push(['SKIP', 'SKIP-DATA-02-ds4']);
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
  console.log('\n===== DATA-02 数据集④ 双读核对汇总 =====');
  console.log('PASS=' + pass + '  FAIL=' + fail + '  SKIP=' + skip);
  if (fail > 0) { console.log('HAS_ISSUES'); process.exit(1); }
  if (skip > 0) {
    if (process.env.CI === '1') { console.log('CI 模式下不允许跳过关键测试'); process.exit(1); }
    console.log('SKIPPED');
    process.exit(0);
  }
  console.log('ALL PASS');
})();

// ========== 统一数据层集成测试（P2-2 验收）==========
// 运行：node server/test/unified-data-layer.test.js
// 目的：验证 035 迁移后的 bond_unified 正股代码兜底、IPO 六位 security_code 兼容、
//       stockDataService 按目标交易日聚合、回填幂等。
// 依赖本地 PostgreSQL（portfolio 库）；连不上时优雅跳过（不影响通过）。
const assert = require('assert');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { Client } = require('pg');

const results = [];
function check(name, fn) {
  try { fn(); results.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (e) { results.push(['FAIL', name + ' :: ' + (e && e.message ? e.message : e)]); console.log('  [FAIL] ' + name + ' :: ' + (e && e.message ? e.message : e)); }
}
async function checkAsync(name, fn) {
  try { await fn(); results.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (e) { results.push(['FAIL', name + ' :: ' + (e && e.message ? e.message : e)]); console.log('  [FAIL] ' + name + ' :: ' + (e && e.message ? e.message : e)); }
}

(async () => {
  let pool = null;
  try {
    const db = require('../../server/db');
    pool = db.pool;
    const bondSvc = require('../../server/services/bondDataService');
    const stockSvc = require('../../server/services/stockDataService');

    // 1) 035 迁移的 normalize_stock_code 函数存在且规则正确
    const fnRows = await pool.query(
      `SELECT prosrc FROM pg_proc WHERE proname='normalize_stock_code'`
    );
    check('normalize_stock_code 函数已创建（035）', () => {
      assert.ok(fnRows.rows.length > 0, '缺少 normalize_stock_code 函数');
      assert.ok(/raw ~ '\^\(0\|3\)'/.test(fnRows.rows[0].prosrc), '深市规则缺失（0/3 → .SZ）');
    });
    const fnResult = await pool.query(
      `SELECT normalize_stock_code('000001') AS sz, normalize_stock_code('600000') AS sh,
              normalize_stock_code('300750') AS cyb, normalize_stock_code('600000.SH') AS passthrough`
    );
    check('normalize_stock_code 规则正确', () => {
      const r = fnResult.rows[0];
      assert.strictEqual(r.sz, '000001.SZ');
      assert.strictEqual(r.sh, '600000.SH');
      assert.strictEqual(r.cyb, '300750.SZ');
      assert.strictEqual(r.passthrough, '600000.SH');
    });

    // 2) bond_history 有正股代码的债券，统一视图 stock_code 缺失数为 0（P1-1 验收）
    const missing = await pool.query(
      `SELECT count(*)::int AS n FROM bond_unified bu
       JOIN bond_history bh ON bh.security_code = split_part(bu.bond_code, '.', 1)
       WHERE (bu.stock_code IS NULL OR bu.stock_code='')
         AND bh.stk_code IS NOT NULL AND bh.stk_code <> ''`
    );
    check('bond_history 有正股代码的债券视图缺失数为 0', () => {
      assert.strictEqual(missing.rows[0].n, 0, `仍有 ${missing.rows[0].n} 条缺失`);
    });

    // 3) IPO 打新历史：security_code 六位纯数字、canonical_code 带后缀（P2-1 验收）
    //    干净库（CI）无真实数据 → 自建一条测试债券（验证后清理），不依赖生产数据
    const TEST_BOND_CODE = '999900.SH';
    await pool.query(`DELETE FROM core.instruments WHERE canonical_code=$1`, [TEST_BOND_CODE]);
    await pool.query(
      `INSERT INTO core.instruments(canonical_code,name,asset_class,market)
       VALUES ($1,'CI测试可转债','convertible_bond','SH')`, [TEST_BOND_CODE]);
    try {
      const history = await bondSvc.getBondHistoryList(50);
      check('打新历史接口 security_code 为六位纯数字', () => {
        assert.ok(history.length > 0, '打新历史为空');
        for (const row of history) {
          assert.match(String(row.security_code), /^\d{6}$/, `非六位: ${row.security_code}`);
          assert.ok(String(row.canonical_code).includes('.'), `canonical_code 缺后缀: ${row.canonical_code}`);
        }
      });
    } finally {
      await pool.query(`DELETE FROM core.instruments WHERE canonical_code=$1`, [TEST_BOND_CODE]);
    }

    // 4) stockDataService.getTotalMarketCap 按目标交易日聚合（P0-1 验收）
    //    干净库（CI）无真实数据 → 自建测试股票 + 市值行（验证后清理）
    const TEST_STOCK_CODE = '999901.SH';
    await pool.query(`DELETE FROM core.instruments WHERE canonical_code=$1`, [TEST_STOCK_CODE]);
    const insStock = await pool.query(
      `INSERT INTO core.instruments(canonical_code,name,asset_class,market)
       VALUES ($1,'CI测试股票','stock','SH') RETURNING instrument_id`, [TEST_STOCK_CODE]);
    const { rows: srcRows } = await pool.query(
      `SELECT source_id FROM ops.data_sources WHERE source_code='tushare' LIMIT 1`);
    const srcId = srcRows.length ? srcRows[0].source_id : 1;
    try {
      await pool.query(
        `INSERT INTO market.daily_valuations(instrument_id,trade_date,source_id,total_market_cap)
         VALUES ($1,'2026-07-30',$2,1000000000000)`, [insStock.rows[0].instrument_id, srcId]);
      const cap = await stockSvc.getTotalMarketCap('2026-07-30');
      check('getTotalMarketCap(2026-07-30) 返回单日聚合', () => {
        assert.ok(cap && typeof cap.total_cap === 'number' && cap.total_cap > 0, 'total_cap 无效');
        assert.ok(cap.stock_count > 0, 'stock_count 无效');
      });
    } finally {
      await pool.query(`DELETE FROM market.daily_valuations WHERE instrument_id=$1`, [insStock.rows[0].instrument_id]);
      await pool.query(`DELETE FROM core.instruments WHERE canonical_code=$1`, [TEST_STOCK_CODE]);
    }
    const noDate = await stockSvc.getTotalMarketCap(null);
    check('getTotalMarketCap 无日期参数返回 0（拒绝全表混合聚合）', () => {
      assert.strictEqual(noDate.total_cap, 0);
      assert.strictEqual(noDate.stock_count, 0);
    });

    // 5) 回填幂等：重复执行 bootstrapBondsFromHistory 不新增重复关联
    const { bootstrapBondsFromHistory } = require('../../server/services/convertibleBondAnalysis');
    const before = await pool.query(
      `SELECT count(*)::int AS n FROM bond_unified WHERE stock_code IS NOT NULL AND stock_code <> ''`
    );
    const client = await pool.connect();
    let rerun = null;
    try {
      await client.query('BEGIN');
      const src = await client.query('SELECT source_code, source_id FROM ops.data_sources');
      const sources = Object.fromEntries(src.rows.map(r => [r.source_code, r.source_id]));
      rerun = await bootstrapBondsFromHistory(client, sources);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
    const after = await pool.query(
      `SELECT count(*)::int AS n FROM bond_unified WHERE stock_code IS NOT NULL AND stock_code <> ''`
    );
    check('重复执行回填幂等（不新增重复关联）', () => {
      assert.strictEqual(before.rows[0].n, after.rows[0].n,
        `回填前 ${before.rows[0].n} → 回填后 ${after.rows[0].n}`);
      console.log(`    （本次重跑补齐/确认 ${rerun} 只，总数未变化）`);
    });
  } catch (e) {
    if (!pool) {
      console.log('  [SKIP] 无可用 PostgreSQL，跳过统一数据层集成测试');
      results.push(['SKIP', 'SKIP-统一数据层']);
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
  console.log('\n===== 统一数据层集成测试汇总 =====');
  console.log('PASS=' + pass + '  FAIL=' + fail + '  SKIP=' + skip);
  if (fail > 0) { console.log('HAS_ISSUES'); process.exit(1); }
  if (skip > 0) {
    if (process.env.CI === '1') { console.log('CI 模式下不允许跳过关键测试'); process.exit(1); }
    console.log('SKIPPED');
    process.exit(0);
  }
  console.log('ALL PASS');
})();

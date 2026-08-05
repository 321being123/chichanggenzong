// ========== DATA-02 数据集②：股票行情/估值/财务事实 双读核对 ==========
// 运行：node server/test/data-convergence-stock-valuation.test.js
// 目的：收敛标准数据读取链路，验证「统一读取者」与「权威聚合 SQL」结果一致，
//       并证明 stock_unified 视图（单券最新）不能替代跨交易日全市场聚合。
// 依赖本地 PostgreSQL（portfolio 库）；连不上时优雅跳过（不影响通过）。
// 测试数据全部为自建夹具，验证后清理，不触碰生产数据。
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
    const stockSvc = require('../../server/services/stockDataService');

    // 自建夹具：两只测试股票 + 各两个交易日市值（单位：元）
    const CODE_A = '999911.SH';
    const CODE_B = '999912.SZ';
    // 使用确定无真实数据的未来日期，避免与本地 portfolio 库既有每日市值数据混淆
    const DATE_OLD = '2099-01-01';
    const DATE_NEW = '2099-01-02';
    const CAP_A_OLD = 1200000000000; // 1.2 万亿元（元）
    const CAP_A_NEW = 1300000000000; // 1.3 万亿元（元）
    const CAP_B_NEW = 500000000000;  // 0.5 万亿元（元）

    const srcRows = await pool.query(`SELECT source_id FROM ops.data_sources WHERE source_code='tushare' LIMIT 1`);
    const srcId = srcRows.rows.length ? srcRows.rows[0].source_id : 1;

    async function cleanup() {
      await pool.query(`DELETE FROM market.daily_valuations WHERE instrument_id IN (SELECT instrument_id FROM core.instruments WHERE canonical_code IN ($1,$2))`, [CODE_A, CODE_B]);
      await pool.query(`DELETE FROM core.instruments WHERE canonical_code IN ($1,$2)`, [CODE_A, CODE_B]);
    }
    await cleanup();
    const ia = await pool.query(
      `INSERT INTO core.instruments(canonical_code,name,asset_class,market) VALUES ($1,'DC测试股票A','stock','SH') RETURNING instrument_id`, [CODE_A]);
    const ib = await pool.query(
      `INSERT INTO core.instruments(canonical_code,name,asset_class,market) VALUES ($1,'DC测试股票B','stock','SZ') RETURNING instrument_id`, [CODE_B]);
    const idA = ia.rows[0].instrument_id, idB = ib.rows[0].instrument_id;
    await pool.query(
      `INSERT INTO market.daily_valuations(instrument_id,trade_date,source_id,total_market_cap) VALUES
       ($1,$3,$5,$6), ($1,$4,$5,$7), ($2,$4,$5,$8)`,
      [idA, idB, DATE_OLD, DATE_NEW, srcId, CAP_A_OLD, CAP_A_NEW, CAP_B_NEW]);

    try {
      // 1) 新读取者：按目标交易日聚合（DATE_NEW）
      const capNew = await stockSvc.getTotalMarketCap(DATE_NEW);
      // 2) 旧权威聚合 SQL（与 stockDataService 内部一致，双读核对基准）
      const { rows: oldAgg } = await pool.query(
        `SELECT COALESCE(SUM(dv.total_market_cap),0)::double precision AS total_cap, COUNT(*)::int AS stock_count
         FROM market.daily_valuations dv
         JOIN core.instruments i ON i.instrument_id = dv.instrument_id
         WHERE i.asset_class='stock' AND dv.trade_date=$1 AND dv.total_market_cap>0`, [DATE_NEW]);
      const expectCap = CAP_A_NEW + CAP_B_NEW; // 1.3 + 0.5 = 1.8 万亿元（元）
      const expectCount = 2;

      check('双读核对：getTotalMarketCap 与权威聚合 SQL 总市值一致（单位：元）', () => {
        assert.strictEqual(capNew.total_cap, oldAgg[0].total_cap, '总市值不一致');
        assert.strictEqual(capNew.total_cap, expectCap, '总市值应为 ' + expectCap + ' 元');
      });
      check('双读核对：getTotalMarketCap 与权威聚合 SQL 证券数量一致', () => {
        assert.strictEqual(capNew.stock_count, oldAgg[0].stock_count, '证券数不一致');
        assert.strictEqual(capNew.stock_count, expectCount, '证券数应为 ' + expectCount);
      });

      // 3) 跨日聚合正确性：DATE_OLD 只应包含 A（1.2 万亿元），不含 B（B 无该日）
      const capOld = await stockSvc.getTotalMarketCap(DATE_OLD);
      check('双读核对：按目标日聚合仅含当日分区（DATE_OLD 只算 A）', () => {
        assert.strictEqual(capOld.total_cap, CAP_A_OLD, 'DATE_OLD 总市值应为 ' + CAP_A_OLD);
        assert.strictEqual(capOld.stock_count, 1, 'DATE_OLD 证券数应为 1');
      });

      // 4) 反例：stock_unified 为单券最新快照，不能用于跨日全市场聚合
      //    DATE_OLD 用 stock_unified 会得到 A 的“最新”（NEW 日）值，与当日聚合不同
      const { rows: su } = await pool.query(
        `SELECT COALESCE(SUM(total_market_cap),0)::double precision AS total_cap
         FROM public.stock_unified WHERE stock_code IN ($1,$2)`, [CODE_A, CODE_B]);
      check('反例：stock_unified（单券最新）≠ 跨日聚合，证明不可混用', () => {
        assert.notStrictEqual(Number(su[0].total_cap), capOld.total_cap,
          'stock_unified 与跨日聚合结果相同，说明语义被错误替代');
      });
    } finally {
      await cleanup();
    }
  } catch (e) {
    if (!pool) {
      console.log('  [SKIP] 无可用 PostgreSQL，跳过 DATA-02 数据集② 双读核对');
      results.push(['SKIP', 'SKIP-DATA-02-ds2']);
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
  console.log('\n===== DATA-02 数据集② 双读核对汇总 =====');
  console.log('PASS=' + pass + '  FAIL=' + fail + '  SKIP=' + skip);
  if (fail > 0) { console.log('HAS_ISSUES'); process.exit(1); }
  if (skip > 0) {
    if (process.env.CI === '1') { console.log('CI 模式下不允许跳过关键测试'); process.exit(1); }
    console.log('SKIPPED');
    process.exit(0);
  }
  console.log('ALL PASS');
})();

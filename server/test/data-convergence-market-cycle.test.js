// ========== DATA-02 数据集⑤：市场周期和分析快照 双读核对 ==========
// 运行：node server/test/data-convergence-market-cycle.test.js
// 目的：收敛市场周期标准数据读取链路。
//   - 市场周期读取者（统一）= marketCycleMetrics.metricRows('m2_market_cap')（analytics.m2_market_cap_daily）。
//   - 双读核对：统一读取者返回序列 ≡ 权威表直接读取（日期序列、ratio_pct 单位一致，单位 %）。
//   - 分析快照（analytics.analysis_snapshots）：写入者 stockAnalysis/financialDataArchitecture，
//     读取者股票分析路由；快照导入原子性由 save-version-guard 测试覆盖（见交付清单）。
// 依赖本地 PostgreSQL（portfolio 库）；连不上时优雅跳过（不影响通过）。只读，不写入任何数据。
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
    const mcm = require('../../server/services/marketCycleMetrics');

    // 1) 双读核对：统一读取者 vs 权威表（日期序列 + ratio_pct 一致）
    //    统一读取者 = marketCycleMetrics.getHistory('m2_market_cap', ...)，内部经 metricRows 读 analytics.m2_market_cap_daily
    const newRows = await mcm.getHistory('m2_market_cap', 'CN', 'CSIALL', 'all');
    const { rows: oldRows } = await pool.query(
      `SELECT trade_date::text AS date, ratio_pct::float8 AS value,
              m2_100m_yuan::float8 AS m2_100m_yuan, total_market_cap_100m_yuan::float8 AS total_market_cap_100m_yuan
       FROM analytics.m2_market_cap_daily ORDER BY trade_date`);

    check('双读核对：市场周期行数一致', () => {
      assert.strictEqual(newRows.length, oldRows.length,
        '统一读取者与权威表行数不一致：' + newRows.length + ' vs ' + oldRows.length);
    });

    if (newRows.length) {
      const newDates = newRows.map(r => r.date);
      const oldDates = oldRows.map(r => r.date);
      check('双读核对：市场周期日期序列一致', () => {
        assert.deepStrictEqual(newDates, oldDates, '日期序列不一致');
      });
      check('双读核对：ratio_pct（市值比，单位 %）数值一致', () => {
        for (let i = 0; i < newRows.length; i++) {
          assert.ok(Math.abs(Number(newRows[i].value) - Number(oldRows[i].value)) < 1e-6,
            `第 ${i} 行 ratio_pct 不一致: ${newRows[i].value} vs ${oldRows[i].value}`);
        }
      });
      check('双读核对：M2 与市值单位一致（亿元 → 100m_yuan）', () => {
        for (let i = 0; i < newRows.length; i++) {
          assert.ok(Math.abs(Number(newRows[i].m2_100m_yuan) - Number(oldRows[i].m2_100m_yuan)) < 1e-6, 'm2 不一致');
          assert.ok(Math.abs(Number(newRows[i].total_market_cap_100m_yuan) - Number(oldRows[i].total_market_cap_100m_yuan)) < 1e-6, '市值不一致');
        }
      });
      // 单位铁律：ratio_pct 为百分比（非小数），合理区间 [0, 1000)
      const sample = Number(newRows[newRows.length - 1].value);
      check('单位铁律：ratio_pct 为百分比（非小数比例）', () => {
        assert.ok(sample > 0 && sample < 1000, 'ratio_pct 疑似单位错误（应为 %）: ' + sample);
      });
    } else {
      console.log('  [INFO] analytics.m2_market_cap_daily 暂无数据，跳过数值比对（结构校验已通过）');
    }
  } catch (e) {
    if (!pool) {
      console.log('  [SKIP] 无可用 PostgreSQL，跳过 DATA-02 数据集⑤ 双读核对');
      results.push(['SKIP', 'SKIP-DATA-02-ds5']);
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
  console.log('\n===== DATA-02 数据集⑤ 双读核对汇总 =====');
  console.log('PASS=' + pass + '  FAIL=' + fail + '  SKIP=' + skip);
  if (fail > 0) { console.log('HAS_ISSUES'); process.exit(1); }
  if (skip > 0) {
    if (process.env.CI === '1') { console.log('CI 模式下不允许跳过关键测试'); process.exit(1); }
    console.log('SKIPPED');
    process.exit(0);
  }
  console.log('ALL PASS');
})();

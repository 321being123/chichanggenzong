// ========== calculateGraham 完整成功路径回归（二次验收阻断缺陷）==========
// 运行：node server/test/calculateGraham-success.test.js
// 目的：防止 calculateGraham() 末尾引用已删除变量 valid 的 ReferenceError 回潮。
//       此前现有测试只覆盖了“无数据提前返回 0”的路径，未执行分批写入后的
//       日志与 return 语句，因此漏掉了这个会令市场周期任务记为失败的阻断缺陷。
// 做法：用唯一标记 seed 最小源数据 → 调用完整成功路径 → 断言返回数字且未抛错 → 清理。
const assert = require('assert');
const { pool } = require('../db/connection');
const { calculateGraham } = require('../jobs/marketVolatilitySync');

const MK = 'TEST_GR';              // 唯一市场标记，避免污染/误删真实数据
const BM = 'TESTB_GR';             // 唯一基准标记

async function cleanup() {
  await pool.query('DELETE FROM analytics.graham_index_daily WHERE market_code=$1', [MK]);
  await pool.query('DELETE FROM market.market_valuation_daily WHERE market_code=$1', [MK]);
  await pool.query('DELETE FROM market.sovereign_yield_daily WHERE market_code=$1', [MK]);
}

(async () => {
  await cleanup();
  try {
    const day = new Date().toISOString().slice(0, 10); // 今天，必落在任意 45 天水位窗口内
    // 1) 估值源：pe>0，保证 DISTINCT ON 被选中且 earnings=100/pe>0
    await pool.query(`INSERT INTO market.market_valuation_daily(market_code,benchmark_code,trade_date,pe,source_code,source_date,raw_payload)
      VALUES($1,$2,$3,$4,'test_seed',$3,$5)`, [MK, BM, day, 10, JSON.stringify({ seed: true })]);
    // 2) 无风险利率：同交易日、yield_pct>0，满足 join 窗口（CN 为 trade_date±5 天）
    await pool.query(`INSERT INTO market.sovereign_yield_daily(market_code,tenor_years,trade_date,yield_pct,source_code,source_date,raw_payload)
      VALUES($1,10,$2,$3,'test_seed',$2,$4)`, [MK, day, 3, JSON.stringify({ seed: true })]);

    // 完整成功路径：会执行分批写入 + 末尾日志 + return
    // 注意：不能用 assert.doesNotThrow(async fn)——它不会 await 异步函数，
    // 会导致断言先于 calculateGraham 完成而误判返回 undefined。这里直接 try/catch。
    let ret;
    try {
      ret = await calculateGraham();
    } catch (e) {
      throw new Error('calculateGraham 成功路径抛错（曾因 valid 未定义报 ReferenceError）：' + e.message);
    }
    assert.strictEqual(typeof ret, 'number', 'calculateGraham 应返回数字（写入条数）');
    assert.ok(ret >= 1, '应至少写入 1 条格雷厄姆指数（实际 ' + ret + '）');
    console.log('calculateGraham success-path test passed (写入 ' + ret + ' 条)');
  } finally {
    await cleanup();
    await pool.end();
  }
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });

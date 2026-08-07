// ========== calculateGraham 完整成功路径回归（二次验收阻断缺陷）==========
// 运行：node server/test/calculateGraham-success.test.js
// 目的：防止 calculateGraham() 末尾引用已删除变量 valid 的 ReferenceError 回潮。
//       此前现有测试只覆盖了“无数据提前返回 0”的路径，未执行分批写入后的
//       日志与 return 语句，因此漏掉了这个会令市场周期任务记为失败的阻断缺陷。
// 隔离策略：全程在单个事务(client)内完成 seed → 计算 → 断言 → 回滚，绝不触碰真实已落库数据。
//   - 把同一 client 传给 calculateGraham(pg=client)，整段在事务内可见、回滚后无痕
//     （即使它顺带重算了其它真实市场的最近 45 天，回滚后也不会真正改写任何真实行）。
//   - 断言明确查询 TEST_GR / TESTB_GR 的结果行确实存在，证明是种子被正确处理，
//     而非被真实数据凑数（ret>=1 仅靠真实数据也可能满足）。
const assert = require('assert');
const { pool } = require('../db/connection');
const { calculateGraham } = require('../jobs/marketVolatilitySync');

const MK = 'TEST_GR';              // 唯一市场标记
const BM = 'TESTB_GR';             // 唯一基准标记

(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const day = new Date().toISOString().slice(0, 10); // 今天，必落在任意 45 天水位窗口内
    // 1) 估值源：pe>0，保证 DISTINCT ON 被选中且 earnings=100/pe>0
    await client.query(`INSERT INTO market.market_valuation_daily(market_code,benchmark_code,trade_date,pe,source_code,source_date,raw_payload)
      VALUES($1,$2,$3,$4,'test_seed',$3,$5)`, [MK, BM, day, 10, JSON.stringify({ seed: true })]);
    // 2) 无风险利率：同交易日、yield_pct>0，满足 join 窗口（非 HK 为 trade_date±5 天）
    await client.query(`INSERT INTO market.sovereign_yield_daily(market_code,tenor_years,trade_date,yield_pct,source_code,source_date,raw_payload)
      VALUES($1,10,$2,$3,'test_seed',$2,$4)`, [MK, day, 3, JSON.stringify({ seed: true })]);

    // 完整成功路径：会执行分批写入 + 末尾日志 + return。
    // 注意：不能用 assert.doesNotThrow(async fn)——它不会 await 异步函数，
    // 会导致断言先于 calculateGraham 完成而误判返回 undefined。这里直接 try/catch。
    let ret;
    try {
      ret = await calculateGraham(client);
    } catch (e) {
      throw new Error('calculateGraham 成功路径抛错（曾因 valid 未定义报 ReferenceError）：' + e.message);
    }
    assert.strictEqual(typeof ret, 'number', 'calculateGraham 应返回数字（写入条数）');
    assert.ok(ret >= 1, '应至少写入 1 条格雷厄姆指数（实际 ' + ret + '）');

    // 隔离关键：明确断言种子对应的结果行确实存在（earnings 10 - yield 3 = graham 7 > 0）
    const res = await client.query(
      'SELECT market_code,benchmark_code,graham_index_pct FROM analytics.graham_index_daily WHERE market_code=$1 AND benchmark_code=$2 AND trade_date=$3',
      [MK, BM, day]);
    assert.strictEqual(res.rows.length, 1, 'TEST_GR/TESTB_GR 的结果行应恰好 1 条（实际 ' + res.rows.length + '）');
    assert.ok(Number(res.rows[0].graham_index_pct) > 0, '格雷厄姆指数应>0（earnings 10 - yield 3 = 7）');
    console.log('calculateGraham success-path test passed (写入 ' + ret + ' 条, 种子结果 graham=' + res.rows[0].graham_index_pct + ')');
  } finally {
    // 回滚：seed 源数据、本次计算产生的所有 graham 行（含真实市场被重算的行）全部撤销，开发库无痕。
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });

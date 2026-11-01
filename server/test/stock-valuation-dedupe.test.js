// 换来源后同一个交易日会同时存在两行估值（理杏仁官方 + 原来源）。
// 读取端必须按「日期只取一行、官方优先」，否则分析页序列会出现重复日期点、分位样本被重复计数。
process.env.NODE_ENV = 'test';
const assert = require('assert');
const { pool } = require('../db/connection');
const repo = require('../repositories/stockAnalysisRepository');
const { migration180LixingerOfficialSource } = require('../db/migrations/lixingerOfficialSource');

const TS_CODE = '600519.SH';
const TRADE_DATE = '2021-01-04';

(async () => {
  try {
    await migration180LixingerOfficialSource(pool);
    const { rows: [instrument] } = await pool.query(
      `SELECT instrument_id FROM core.instruments WHERE canonical_code=$1`, [TS_CODE]);
    assert.ok(instrument, `测试库缺少 ${TS_CODE} 证券档案`);
    const { rows: sources } = await pool.query(
      `SELECT source_id, source_code FROM ops.data_sources WHERE source_code IN ('tushare','lixinger_official')`);
    const byCode = new Map(sources.map(row => [row.source_code, row.source_id]));
    assert.ok(byCode.get('tushare') && byCode.get('lixinger_official'), '测试库缺少来源登记');

    const cleanup = () => pool.query(
      `DELETE FROM market.daily_valuations WHERE instrument_id=$1 AND trade_date=$2::date`, [instrument.instrument_id, TRADE_DATE]);
    await cleanup();
    await pool.query(
      `INSERT INTO market.daily_valuations(instrument_id,trade_date,source_id,pe_static,pe_ttm,pb,total_market_cap)
       VALUES ($1,$2::date,$3,9.5,10.0,1.10,100000000000),
              ($1,$2::date,$4,NULL,99.0,7.70,900000000000)`,
      [instrument.instrument_id, TRADE_DATE, byCode.get('tushare'), byCode.get('lixinger_official')]);

    const inputs = await repo.loadAnalysisInputs({ tsCode: TS_CODE });
    const sameDay = (inputs.valuations || []).filter(row => String(row.trade_date) === TRADE_DATE.replace(/-/g, ''));
    assert.strictEqual(sameDay.length, 1, `同一交易日只能返回一行，实际 ${sameDay.length} 行（重复点会导致图表重复、分位失真）`);
    assert.strictEqual(Number(sameDay[0].pe_ttm), 99, '必须取官方那一行（官方优先），不能取回原来源');
    assert.strictEqual(Number(sameDay[0].total_mv), 90000000, '总市值同样要取官方行（万元口径）');

    await cleanup();
    console.log('stock-valuation-dedupe：同交易日双来源按日期去重、官方优先，通过');
  } finally {
    await pool.end().catch(() => {});
    process.exit(0);
  }
})().catch(async error => { console.error(error); process.exit(1); });

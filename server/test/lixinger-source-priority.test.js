// 数据源优先级方向：官方（lixinger_official）必须排在备源（tushare）之前。
//
// 背景：`ops.data_sources.priority` 的语义是「数值小者优先」，2026-10-30 迁移 180 登记官方来源时
// 写成了 70，比 tushare 的 10 大——`stockRepository.totalMarketCap` 这类按 priority ASC 择优的
// 查询实际仍取 tushare。数值恰好相同才没暴露，一旦官方修正数据就会读旧来源，且标签写的是官方。
// 本用例用真实测试库验证「迁移后的优先级」和「聚合确实取官方且不重复计数」。
process.env.NODE_ENV = 'test';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pool } = require('../db/connection');
const { migration180LixingerOfficialSource, migration181LixingerOfficialPriority } = require('../db/migrations/lixingerOfficialSource');
const stockRepository = require('../repositories/stockRepository');

const CODE = 'PRIO999.SH';
const DAY = '2026-10-30';

(async () => {
  await migration180LixingerOfficialSource(pool);
  await migration181LixingerOfficialPriority(pool);
  await migration181LixingerOfficialPriority(pool); // 幂等：重复跑不许把值改回去

  const sources = await pool.query(
    `SELECT source_code, priority FROM ops.data_sources WHERE source_code = ANY($1::text[])`,
    [['lixinger_official', 'tushare']],
  );
  const priority = Object.fromEntries(sources.rows.map(row => [row.source_code, Number(row.priority)]));
  assert.ok(
    priority.lixinger_official < priority.tushare,
    `官方来源必须优先于备源（数值小者优先）：官方=${priority.lixinger_official}，tushare=${priority.tushare}`,
  );

  // 真实择优：同一只股票同一天两来源、数值故意不同（官方 900 / 备源 100），
  // 聚合必须取官方那条，且该证券只计一次。
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const instrument = await client.query(
      `INSERT INTO core.instruments(canonical_code,name,asset_class,market)
       VALUES($1,'优先级测试股票','stock','SH') RETURNING instrument_id`,
      [CODE],
    );
    const instrumentId = instrument.rows[0].instrument_id;
    await client.query(
      `INSERT INTO market.daily_valuations(instrument_id,trade_date,source_id,total_market_cap)
       SELECT $1, $2::date, s.source_id, v.cap
         FROM (VALUES ('lixinger_official', 900::numeric), ('tushare', 100::numeric)) AS v(code, cap)
         JOIN ops.data_sources s ON s.source_code = v.code`,
      [instrumentId, DAY],
    );
    const cap = await stockRepository.totalMarketCap({ tradeDate: DAY }, client);
    assert.strictEqual(Math.round(Number(cap.total_cap)), 900, '同一天两来源并存时必须取官方那条（priority 小的）');
    assert.strictEqual(Number(cap.stock_count), 1, '同一证券只能计一次，不能把两个来源都累加进去');
    await client.query('ROLLBACK');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  // 防方向回归：仓储择优排序必须仍是 priority 升序（改 DESC 等于把备源排到前面）。
  const repositorySource = fs.readFileSync(path.join(__dirname, '../repositories/stockRepository.js'), 'utf8');
  assert.ok(
    /ORDER BY\s+dv\.instrument_id,\s*s\.priority ASC/i.test(repositorySource),
    '总市值聚合的择优方向必须保持 priority 升序（数值小者优先）',
  );

  console.log('lixinger-source-priority：官方来源优先于备源，聚合取官方且不重复计数');
  await pool.end();
})().catch(async error => {
  console.error(String(error && error.stack ? error.stack : error));
  try { await pool.end(); } catch (_) { /* 连接已关闭 */ }
  process.exit(1);
});

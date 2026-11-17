// 停牌参考估值：真实 PG 事务验证完整停牌链、参考价证据及失败关闭。
const assert = require('assert');
const { pool } = require('../db/connection');
const { resolveSuspendedReference } = require('../services/effectivePrice');
const { computeNavHistoryTotals, buildNavPerformance } = require('../services/navAttribution');

(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TEMP TABLE daily_prices (
      username text, account_name text, date text, code text, market text, price numeric,
      quality text, is_final boolean, source text, evidence jsonb
    ) ON COMMIT DROP`);
    const source = (await client.query(`SELECT source_id FROM ops.data_sources WHERE source_code='tushare'`)).rows[0];
    assert(source, '测试库须含登记的停牌来源');
    const instrument = (await client.query(`INSERT INTO core.instruments
      (canonical_code,name,asset_class,market,exchange_code,list_date,status)
      VALUES ('699997.SH','停牌回归','stock','CN','SSE','2020-01-01','listed') RETURNING instrument_id`)).rows[0];
    await client.query(`INSERT INTO market.trade_calendar(exchange,trade_date,is_open,source_code)
      SELECT 'SSE', d::date, EXTRACT(ISODOW FROM d)<6, 'test'
        FROM generate_series('2026-09-18'::date,'2026-09-22'::date,interval '1 day') d
      ON CONFLICT(exchange,trade_date) DO UPDATE SET is_open=EXCLUDED.is_open,source_code='test'`);
    for (const day of ['2026-09-21','2026-09-22']) {
      await client.query(`INSERT INTO ops.dataset_partitions(dataset_code,scope_key,partition_key,status,is_stale,diagnostics)
        VALUES ('stock_suspend_calendar','CN',$1::date,'published',false,'{"query_status":"success"}'::jsonb)
        ON CONFLICT(dataset_code,scope_key,partition_key) DO UPDATE
          SET status='published',is_stale=false,diagnostics=EXCLUDED.diagnostics`, [day]);
      await client.query(`INSERT INTO market.stock_suspend_calendar(instrument_id,trade_date,suspend_type,source_id)
        VALUES ($1,$2::date,'S',$3)`, [instrument.instrument_id, day, source.source_id]);
    }
    await client.query(`INSERT INTO daily_prices VALUES
      ('fixture','account','2026-09-18','699997','CN',10,'confirmed',true,'history_backfill:test','{"price_adjust":"none"}'),
      ('fixture','account','2026-09-21','699997','CN',99,'legacy_unverified',false,NULL,'{}')`);
    const candidate = { date: '2026-09-18', price: 10, quality: 'confirmed', isFinal: true,
      source: 'history_backfill:test', evidence: { price_adjust: 'none' } };
    const get = overrides => resolveSuspendedReference({ code: '699997', market: 'CN', candidate,
      targetDate: '2026-09-22', query: client.query.bind(client), ...overrides });
    const reference = await get();
    assert(reference, '连续停牌且终盘证据完整应允许参考估值');
    assert.strictEqual(reference.tradeDate, '2026-09-18');
    assert.strictEqual(reference.asOfDate, '2026-09-22');
    assert.strictEqual(reference.priceKind, 'suspension_reference');
    assert.strictEqual(reference.suspensionOpenDays, 2);

    const data = {
      cashBase: 0, cashFlows: [], trades: [],
      positions: [{ code: '699997', quantity: 100, subtype: '沪市' }],
      positionSnapshots: [{ snapshotId: 'fixture-import', snapshotDate: '2026-09-18', code: '699997', quantity: 100, quoteCurrency: 'CNY' }],
      navHistory: [
        { date: '2026-09-18', nav: 1, totalAsset: 1000, snapshotSource: 'imported', isLocked: true, importBatchId: 'fixture-import' },
        { date: '2026-09-21', snapshotSource: 'system' },
        { date: '2026-09-22', snapshotSource: 'system' },
      ],
    };
    let suspensionQueries = 0;
    const query = (sql, params) => {
      if (String(sql).includes('jsonb_to_recordset')) suspensionQueries++;
      return client.query(sql, params);
    };
    const totals = await computeNavHistoryTotals('fixture', 'account', data, query);
    assert.strictEqual(suspensionQueries, 1, '多个日期的停牌证据必须批量查询');
    assert.strictEqual(totals['2026-09-21'], 1000);
    assert.strictEqual(totals['2026-09-22'], 1000);
    assert.strictEqual(totals.suspensionEvidence['2026-09-22'][0].tradeDate, '2026-09-18');
    const performance = await buildNavPerformance(data, totals, { requireLive: false });
    const final = performance.find(row => row.date === '2026-09-22');
    assert.strictEqual(final.nav, 1);
    assert.strictEqual(final.basis.suspensionReferencePrices.current[0].tradeDate, '2026-09-18');

    assert.strictEqual(await get({ candidate: { ...candidate, isFinal: false } }), null, '未确认终盘不可引用');
    assert.strictEqual(await get({ candidate: { ...candidate, evidence: { price_adjust: 'qfq' } } }), null, '复权价不可引用');
    assert.strictEqual(await get({ market: 'HK' }), null, '不得跨市场引用');
    assert.strictEqual(await get({ candidate: { ...candidate, source: 'nav_import_anchor' } }), null, '账户私有参考价不可冒充市场成交');
    await client.query(`UPDATE market.trade_calendar SET is_open=false WHERE exchange='SSE' AND trade_date='2026-09-18'`);
    assert.strictEqual(await get(), null, '最后成交日不是开市日必须失败关闭');
    await client.query(`UPDATE market.trade_calendar SET is_open=true WHERE exchange='SSE' AND trade_date='2026-09-18'`);
    await client.query(`INSERT INTO fundamental.corporate_actions(instrument_id,action_type,ex_date,source_id,source_key)
      VALUES ($1,'dividend','2026-09-21',$2,'suspension-reference-test')`, [instrument.instrument_id, source.source_id]);
    assert.strictEqual(await get(), null, '已知除权除息不能直接沿用原成交价');
    await client.query(`DELETE FROM fundamental.corporate_actions WHERE instrument_id=$1`, [instrument.instrument_id]);
    await client.query(`DELETE FROM market.stock_suspend_calendar WHERE instrument_id=$1 AND trade_date='2026-09-21'`, [instrument.instrument_id]);
    assert.strictEqual(await get(), null, '停牌日缺失必须失败关闭');
    await client.query(`INSERT INTO market.stock_suspend_calendar(instrument_id,trade_date,suspend_type,source_id)
      VALUES ($1,'2026-09-21','S',$2)`, [instrument.instrument_id, source.source_id]);
    await client.query(`UPDATE ops.dataset_partitions SET is_stale=true
      WHERE dataset_code='stock_suspend_calendar' AND scope_key='CN' AND partition_key='2026-09-21'`);
    assert.strictEqual(await get(), null, '过期分区不可作为停牌证据');
    await client.query(`UPDATE ops.dataset_partitions SET is_stale=false
      WHERE dataset_code='stock_suspend_calendar' AND scope_key='CN' AND partition_key='2026-09-21'`);
    await client.query(`DELETE FROM market.trade_calendar WHERE exchange='SSE' AND trade_date='2026-09-20'`);
    assert.strictEqual(await get(), null, '自然日历缺失不可猜测休市');
    await client.query(`INSERT INTO market.trade_calendar(exchange,trade_date,is_open,source_code)
      VALUES ('SSE','2026-09-20',false,'test')`);
    await client.query(`INSERT INTO daily_prices VALUES
      ('other','account','2026-09-18','699997','CN',11,'confirmed',true,'history_backfill:test','{"price_adjust":"none"}')`);
    assert.strictEqual(await get(), null, '跨账户确认价冲突不得选一边');
    await client.query(`DELETE FROM daily_prices WHERE username='other'`);
    await client.query(`UPDATE core.instruments SET status='delisted',delist_date='2026-09-22' WHERE instrument_id=$1`, [instrument.instrument_id]);
    assert.strictEqual(await get(), null, '退市日及之后不能按停牌参考估值');
    console.log('HOLDINGS-NAV-SUSPENSION-001: real PG evidence, valuation and failure boundaries passed');
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

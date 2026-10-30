// 用独立临时库执行真实批量写入，验证参数绑定与重复更新。
const assert = require('assert');
const { Client } = require('pg');
const repository = require('../repositories/convertibleBondCycleServiceRepository');
const market = require('../repositories/marketRepository');

(async () => {
  const name = `portfolio_test_cycle_${process.pid}_${Date.now()}`;
  const config = { host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'postgres', password: process.env.PGPASSWORD || '' };
  const admin = new Client({ ...config, database: process.env.PGDATABASE || 'portfolio' });
  await admin.connect();
  let db;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    db = new Client({ ...config, database: name });
    await db.connect();
    await db.query(`CREATE SCHEMA market;
      CREATE TABLE market.convertible_bond_daily_metrics (
        instrument_id bigint, trade_date date, source_id smallint, close numeric, conversion_value numeric,
        conversion_premium_pct numeric, bond_value numeric, bond_premium_pct numeric, raw_payload jsonb,
        ingested_at timestamptz DEFAULT now(), PRIMARY KEY(instrument_id,trade_date,source_id));
      CREATE TABLE market.daily_bars (
        instrument_id bigint, trade_date date, source_id smallint, open numeric, high numeric, low numeric,
        close numeric, volume numeric, amount numeric, ingested_at timestamptz DEFAULT now(),
        PRIMARY KEY(instrument_id,trade_date,source_id));
      CREATE TABLE market_quote_cache (
        symbol text, source text, code text, market text, name text, price numeric,
        change_pct numeric, quote_time text, fetched_at timestamptz DEFAULT now(), PRIMARY KEY(symbol,source));`);
    const row = (id, close) => ({ id, close, cbValue: 90, cbOverRate: 12, bondValue: 80, bondOverRate: 5,
      open: 100, high: 110, low: 98, vol: 42, amount: 456, raw: JSON.stringify({ id }) });
    await repository.upsertDailyFacts({ date: '2026-10-29', sourceId: 1, rows: [row(11, 101), row(12, 102)] }, db);
    await repository.upsertDailyFacts({ date: '2026-10-29', sourceId: 1, rows: [row(11, 103)] }, db);
    const metrics = await db.query('SELECT instrument_id::int, close::int, raw_payload FROM market.convertible_bond_daily_metrics ORDER BY instrument_id');
    const bars = await db.query('SELECT instrument_id::int, close::int, volume::int FROM market.daily_bars ORDER BY instrument_id');
    assert.deepStrictEqual(metrics.rows, [{ instrument_id: 11, close: 103, raw_payload: { id: 11 } }, { instrument_id: 12, close: 102, raw_payload: { id: 12 } }]);
    assert.deepStrictEqual(bars.rows, [{ instrument_id: 11, close: 103, volume: 42 }, { instrument_id: 12, close: 102, volume: 42 }]);
    const quote = (ts_code, close) => ({ ts_code, close, pct_chg: 2, quote_time: '2026-10-29T15:00:00+08:00' });
    await market.saveDailyQuoteCache([quote('600001.SH', 10), quote('000001.SZ', 20)], db);
    await market.saveDailyQuoteCache([quote('600001.SH', 11)], db);
    const quotes = await db.query('SELECT symbol, price::int FROM market_quote_cache ORDER BY symbol');
    assert.deepStrictEqual(quotes.rows, [{ symbol: '000001.SZ', price: 20 }, { symbol: '600001.SH', price: 11 }]);
    console.log('转债周期与行情缓存批量写入、重复更新：真实 PostgreSQL 通过');
  } finally {
    if (db) await db.end();
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.end();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

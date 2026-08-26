const { pool } = require('../db');
const { tushareQuery, tsRows } = require('../services/market');

const targetDate = process.argv[2] || '20260805';
const isoDate = value => {
  const text = String(value || '').replace(/-/g, '').slice(0, 8);
  return /^\d{8}$/.test(text) ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}` : null;
};

(async () => {
  const [{ rows: instruments }, dailyData, valuationData] = await Promise.all([
    pool.query(`SELECT DISTINCT s.canonical_code,s.instrument_id
                  FROM fundamental.convertible_bond_profiles p
                  JOIN core.instruments b ON b.instrument_id=p.instrument_id
                  JOIN core.instruments s ON s.instrument_id=p.stock_instrument_id
                 WHERE b.status != 'delisted'
                   AND (p.maturity_date IS NULL OR p.maturity_date >= CURRENT_DATE)`),
    tushareQuery('daily', { trade_date: targetDate }, 'ts_code,trade_date,open,high,low,close,vol,amount', { allowEmpty: true }),
    tushareQuery('daily_basic', { trade_date: targetDate }, 'ts_code,trade_date,pe,pe_ttm,pb,dv_ttm,total_mv,circ_mv', { allowEmpty: true }),
  ]);
  const instrumentMap = new Map(instruments.map(row => [row.canonical_code, row.instrument_id]));
  const bars = tsRows(dailyData).map(row => ({
    instrument_id: instrumentMap.get(row.ts_code), trade_date: isoDate(row.trade_date),
    open: row.open, high: row.high, low: row.low, close: row.close, volume: row.vol, amount: row.amount,
  })).filter(row => row.instrument_id && row.trade_date);
  const valuations = tsRows(valuationData).map(row => ({
    instrument_id: instrumentMap.get(row.ts_code), trade_date: isoDate(row.trade_date),
    pe_static: row.pe, pe_ttm: row.pe_ttm, pb: row.pb, dividend_yield_ttm: row.dv_ttm,
    total_market_cap: row.total_mv == null ? null : Number(row.total_mv) * 10000,
    circulating_market_cap: row.circ_mv == null ? null : Number(row.circ_mv) * 10000,
  })).filter(row => row.instrument_id && row.trade_date && [row.pe_static,row.pe_ttm,row.pb,row.dividend_yield_ttm,row.total_market_cap,row.circulating_market_cap].some(value => value != null));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const barResult = await client.query(`
      INSERT INTO market.daily_bars(instrument_id,trade_date,source_id,open,high,low,close,volume,amount)
      SELECT x.instrument_id,x.trade_date,1,x.open,x.high,x.low,x.close,x.volume,x.amount
        FROM jsonb_to_recordset($1::jsonb) AS x(instrument_id bigint,trade_date date,open numeric,high numeric,low numeric,close numeric,volume numeric,amount numeric)
      ON CONFLICT(instrument_id,trade_date,source_id) DO UPDATE SET
        open=EXCLUDED.open,high=EXCLUDED.high,low=EXCLUDED.low,close=EXCLUDED.close,
        volume=EXCLUDED.volume,amount=EXCLUDED.amount,ingested_at=now()`, [JSON.stringify(bars)]);
    const valuationResult = await client.query(`
      INSERT INTO market.daily_valuations(instrument_id,trade_date,source_id,pe_static,pe_ttm,pb,dividend_yield_ttm,total_market_cap,circulating_market_cap)
      SELECT x.instrument_id,x.trade_date,1,x.pe_static,x.pe_ttm,x.pb,x.dividend_yield_ttm,x.total_market_cap,x.circulating_market_cap
        FROM jsonb_to_recordset($1::jsonb) AS x(instrument_id bigint,trade_date date,pe_static numeric,pe_ttm numeric,pb numeric,dividend_yield_ttm numeric,total_market_cap numeric,circulating_market_cap numeric)
      ON CONFLICT(instrument_id,trade_date,source_id) DO UPDATE SET
        pe_static=EXCLUDED.pe_static,pe_ttm=EXCLUDED.pe_ttm,pb=EXCLUDED.pb,dividend_yield_ttm=EXCLUDED.dividend_yield_ttm,
        total_market_cap=EXCLUDED.total_market_cap,circulating_market_cap=EXCLUDED.circulating_market_cap,ingested_at=now()`, [JSON.stringify(valuations)]);
    await client.query('COMMIT');
    console.log(JSON.stringify({ targetDate, instrumentCount: instrumentMap.size, dailyRows: tsRows(dailyData).length, bars: bars.length, barRowCount: barResult.rowCount, valuations: valuations.length, valuationRowCount: valuationResult.rowCount }));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); await pool.end(); }
})().catch(error => { console.error(error.stack || error); process.exit(1); });

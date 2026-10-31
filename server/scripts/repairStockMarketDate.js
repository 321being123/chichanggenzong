const { pool } = require('../db');
// 行情与估值都属于「行情/估值数据集」：脚本只表达"要哪一天的行情与估值"，
// 具体来源（官方优先、原来源补齐）与日期格式转换都由数据层负责。
const marketDatasets = require('../dataAccess/marketDatasets');

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
    marketDatasets.readStockDailyByDate({ tradeDate: isoDate(targetDate) }),
    marketDatasets.readStockValuationRows({ tradeDate: isoDate(targetDate) }),
  ]);
  const instrumentMap = new Map(instruments.map(row => [row.canonical_code, row.instrument_id]));
  // 数据层读函数返回行数组（不再套 tsRows：它只认 fields/items 信封），行上自带 source_code。
  const bars = dailyData.map(row => ({
    instrument_id: instrumentMap.get(row.ts_code), trade_date: isoDate(row.trade_date),
    open: row.open, high: row.high, low: row.low, close: row.close, volume: row.vol, amount: row.amount,
    source_code: row.source_code || 'tushare',
  })).filter(row => row.instrument_id && row.trade_date);
  const valuations = valuationData.map(row => ({
    instrument_id: instrumentMap.get(row.ts_code), trade_date: isoDate(row.trade_date),
    pe_static: row.pe, pe_ttm: row.pe_ttm, pb: row.pb,
    // 口径已由数据层换算：dv_ttm 是百分数点 → 比例小数，市值是万元 → 元。
    dividend_yield_ttm: row.dv_ttm == null ? null : Number(row.dv_ttm) / 100,
    total_market_cap: row.total_mv == null ? null : Number(row.total_mv) * 10000,
    circulating_market_cap: row.circ_mv == null ? null : Number(row.circ_mv) * 10000,
    source_code: row.source_code || 'tushare',
  })).filter(row => row.instrument_id && row.trade_date && [row.pe_static,row.pe_ttm,row.pb,row.dividend_yield_ttm,row.total_market_cap,row.circulating_market_cap].some(value => value != null));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 来源 id 从登记表解析，不再硬编码 1；按来源分组写入，避免把某家数据记到别人名下。
    const { rows: sourceRows } = await client.query('SELECT source_code,source_id FROM ops.data_sources');
    const sourceIdByCode = new Map(sourceRows.map(row => [row.source_code, row.source_id]));
    const groupBy = (list) => {
      const map = new Map();
      for (const row of list) {
        if (!sourceIdByCode.has(row.source_code)) continue;
        if (!map.has(row.source_code)) map.set(row.source_code, []);
        map.get(row.source_code).push(row);
      }
      return map;
    };
    const barsBySource = groupBy(bars);
    const valuationsBySource = groupBy(valuations);
    let barRowCount = 0;
    let valuationRowCount = 0;
    for (const [code, rows] of barsBySource) {
      const result = await client.query(`
        INSERT INTO market.daily_bars(instrument_id,trade_date,source_id,open,high,low,close,volume,amount)
        SELECT x.instrument_id,x.trade_date,$2,x.open,x.high,x.low,x.close,x.volume,x.amount
          FROM jsonb_to_recordset($1::jsonb) AS x(instrument_id bigint,trade_date date,open numeric,high numeric,low numeric,close numeric,volume numeric,amount numeric)
        ON CONFLICT(instrument_id,trade_date,source_id) DO UPDATE SET
          open=EXCLUDED.open,high=EXCLUDED.high,low=EXCLUDED.low,close=EXCLUDED.close,
          volume=EXCLUDED.volume,amount=EXCLUDED.amount,ingested_at=now()`,
      [JSON.stringify(rows), sourceIdByCode.get(code)]);
      barRowCount += result.rowCount;
    }
    for (const [code, rows] of valuationsBySource) {
      const result = await client.query(`
        INSERT INTO market.daily_valuations(instrument_id,trade_date,source_id,pe_static,pe_ttm,pb,dividend_yield_ttm,total_market_cap,circulating_market_cap)
        SELECT x.instrument_id,x.trade_date,$2,x.pe_static,x.pe_ttm,x.pb,x.dividend_yield_ttm,x.total_market_cap,x.circulating_market_cap
          FROM jsonb_to_recordset($1::jsonb) AS x(instrument_id bigint,trade_date date,pe_static numeric,pe_ttm numeric,pb numeric,dividend_yield_ttm numeric,total_market_cap numeric,circulating_market_cap numeric)
        ON CONFLICT(instrument_id,trade_date,source_id) DO UPDATE SET
          pe_static=EXCLUDED.pe_static,pe_ttm=EXCLUDED.pe_ttm,pb=EXCLUDED.pb,dividend_yield_ttm=EXCLUDED.dividend_yield_ttm,
          total_market_cap=EXCLUDED.total_market_cap,circulating_market_cap=EXCLUDED.circulating_market_cap,ingested_at=now()`,
      [JSON.stringify(rows), sourceIdByCode.get(code)]);
      valuationRowCount += result.rowCount;
    }
    await client.query('COMMIT');
    console.log(JSON.stringify({ targetDate, instrumentCount: instrumentMap.size, dailyRows: dailyData.length, bars: bars.length, barRowCount, valuations: valuations.length, valuationRowCount }));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); await pool.end(); }
})().catch(error => { console.error(error.stack || error); process.exit(1); });

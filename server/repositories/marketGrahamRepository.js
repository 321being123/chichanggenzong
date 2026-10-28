async function readWatermark(pg) {
  return pg.query(`SELECT max(trade_date)::text AS mx FROM analytics.graham_index_daily`);
}

async function listInputs(pg, since) {
  return pg.query(`SELECT v.market_code,v.benchmark_code,v.trade_date,v.pe,
    (SELECT y.yield_pct FROM market.sovereign_yield_daily y WHERE y.market_code=CASE WHEN v.market_code='HK' THEN 'US' ELSE v.market_code END AND y.tenor_years=10 AND (v.market_code<>'HK' OR y.source_code='tushare_us_tycr') AND y.trade_date<=v.trade_date AND y.trade_date>=v.trade_date-CASE WHEN v.market_code='HK' THEN 10 ELSE 5 END ORDER BY y.trade_date DESC LIMIT 1) AS yield_pct,
    (SELECT y.trade_date FROM market.sovereign_yield_daily y WHERE y.market_code=CASE WHEN v.market_code='HK' THEN 'US' ELSE v.market_code END AND y.tenor_years=10 AND (v.market_code<>'HK' OR y.source_code='tushare_us_tycr') AND y.trade_date<=v.trade_date AND y.trade_date>=v.trade_date-CASE WHEN v.market_code='HK' THEN 10 ELSE 5 END ORDER BY y.trade_date DESC LIMIT 1) AS yield_date
    FROM (SELECT DISTINCT ON (market_code,benchmark_code,trade_date) market_code,benchmark_code,trade_date,pe
      FROM market.market_valuation_daily WHERE pe>0
      ORDER BY market_code,benchmark_code,trade_date,CASE WHEN source_code='hsi_weighted_manual' THEN 0 WHEN source_code='hsi_official' THEN 1 ELSE 2 END) v
    WHERE v.trade_date >= $1`, [since]);
}

async function saveChunk(pg, chunk) {
  const values = [], params = []; let p = 1;
  for (const row of chunk) {
    values.push(`($${p},$${p+1},$${p+2},$${p+3},$${p+4},$${p+5},$${p+6},$${p+7},$${p+8})`);
    params.push(row.market_code, row.benchmark_code, row.trade_date, row.pe, row.earnings, row.y, row.yield_date, row.graham, row.status);
    p += 9;
  }
  await pg.query(`INSERT INTO analytics.graham_index_daily(market_code,benchmark_code,trade_date,pe,earnings_yield_pct,sovereign_yield_pct,sovereign_yield_date,graham_index_pct,data_status)
    VALUES ${values.join(',')}
    ON CONFLICT(market_code,benchmark_code,trade_date,formula_version) DO UPDATE SET
      pe=EXCLUDED.pe,earnings_yield_pct=EXCLUDED.earnings_yield_pct,sovereign_yield_pct=EXCLUDED.sovereign_yield_pct,
      sovereign_yield_date=EXCLUDED.sovereign_yield_date,graham_index_pct=EXCLUDED.graham_index_pct,data_status=EXCLUDED.data_status,calculated_at=now()`, params);
}

module.exports = { readWatermark, listInputs, saveChunk };

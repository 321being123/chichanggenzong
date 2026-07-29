const fs = require('fs');
const { pool } = require('../db');

function chunks(list, size) {
  const result = [];
  for (let i = 0; i < list.length; i += size) result.push(list.slice(i, i + size));
  return result;
}

async function importRows(client, rows, sql) {
  for (const group of chunks(rows || [], 500)) await client.query(sql, [JSON.stringify(group)]);
}

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('请提供市场数据导出 JSON 文件路径');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await importRows(client, data.marketValuations, `
      INSERT INTO market.market_valuation_daily(market_code,benchmark_code,trade_date,pe,source_code,source_date,raw_payload)
      SELECT market_code,benchmark_code,trade_date,pe,source_code,source_date,raw_payload
      FROM jsonb_to_recordset($1::jsonb) AS x(market_code text,benchmark_code text,trade_date date,pe numeric,source_code text,source_date date,raw_payload jsonb)
      ON CONFLICT(market_code,benchmark_code,trade_date,source_code) DO UPDATE SET pe=EXCLUDED.pe,source_date=EXCLUDED.source_date,raw_payload=EXCLUDED.raw_payload,ingested_at=now()`);
    await importRows(client, data.sovereignYields, `
      INSERT INTO market.sovereign_yield_daily(market_code,tenor_years,trade_date,yield_pct,source_code,source_date,raw_payload)
      SELECT market_code,tenor_years,trade_date,yield_pct,source_code,source_date,raw_payload
      FROM jsonb_to_recordset($1::jsonb) AS x(market_code text,tenor_years smallint,trade_date date,yield_pct numeric,source_code text,source_date date,raw_payload jsonb)
      ON CONFLICT(market_code,tenor_years,trade_date,source_code) DO UPDATE SET yield_pct=EXCLUDED.yield_pct,source_date=EXCLUDED.source_date,raw_payload=EXCLUDED.raw_payload,ingested_at=now()`);
    await importRows(client, data.indexValuations, `
      INSERT INTO market.index_valuation_history(index_code,valuation_method,trade_date,close,market_cap,pe_ttm,pb,pe_percentile,pe_p80,pe_p50,pe_p20,pb_percentile,pb_p80,pb_p50,pb_p20,source_code,raw_payload)
      SELECT index_code,valuation_method,trade_date,close,market_cap,pe_ttm,pb,pe_percentile,pe_p80,pe_p50,pe_p20,pb_percentile,pb_p80,pb_p50,pb_p20,source_code,raw_payload
      FROM jsonb_to_recordset($1::jsonb) AS x(index_code text,valuation_method text,trade_date date,close numeric,market_cap numeric,pe_ttm numeric,pb numeric,pe_percentile numeric,pe_p80 numeric,pe_p50 numeric,pe_p20 numeric,pb_percentile numeric,pb_p80 numeric,pb_p50 numeric,pb_p20 numeric,source_code text,raw_payload jsonb)
      ON CONFLICT(index_code,valuation_method,trade_date,source_code) DO UPDATE SET close=EXCLUDED.close,market_cap=EXCLUDED.market_cap,pe_ttm=EXCLUDED.pe_ttm,pb=EXCLUDED.pb,pe_percentile=EXCLUDED.pe_percentile,pe_p80=EXCLUDED.pe_p80,pe_p50=EXCLUDED.pe_p50,pe_p20=EXCLUDED.pe_p20,pb_percentile=EXCLUDED.pb_percentile,pb_p80=EXCLUDED.pb_p80,pb_p50=EXCLUDED.pb_p50,pb_p20=EXCLUDED.pb_p20,raw_payload=EXCLUDED.raw_payload,ingested_at=now()`);
    await importRows(client, data.grahamIndexes, `
      INSERT INTO analytics.graham_index_daily(market_code,benchmark_code,trade_date,pe,earnings_yield_pct,sovereign_yield_pct,sovereign_yield_date,graham_index_pct,data_status,formula_version)
      SELECT market_code,benchmark_code,trade_date,pe,earnings_yield_pct,sovereign_yield_pct,sovereign_yield_date,graham_index_pct,data_status,formula_version
      FROM jsonb_to_recordset($1::jsonb) AS x(market_code text,benchmark_code text,trade_date date,pe numeric,earnings_yield_pct numeric,sovereign_yield_pct numeric,sovereign_yield_date date,graham_index_pct numeric,data_status text,formula_version text)
      ON CONFLICT(market_code,benchmark_code,trade_date,formula_version) DO UPDATE SET pe=EXCLUDED.pe,earnings_yield_pct=EXCLUDED.earnings_yield_pct,sovereign_yield_pct=EXCLUDED.sovereign_yield_pct,sovereign_yield_date=EXCLUDED.sovereign_yield_date,graham_index_pct=EXCLUDED.graham_index_pct,data_status=EXCLUDED.data_status,calculated_at=now()`);
    await client.query('COMMIT');
    console.log(JSON.stringify({ marketValuations: data.marketValuations.length, sovereignYields: data.sovereignYields.length, indexValuations: data.indexValuations.length, grahamIndexes: data.grahamIndexes.length }));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => pool.end());

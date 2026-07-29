const fs = require('fs');
const { pool } = require('../db');
const { calculateGraham } = require('../jobs/marketVolatilitySync');

function number(value) {
  const n = Number(String(value == null ? '' : value).trim().replace(/^=/, ''));
  return Number.isFinite(n) ? n : null;
}
function read(file, kind) {
  const rows = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/).slice(1), out = new Map();
  for (const line of rows) {
    const cells = line.split(','), date = String(cells[0] || '').trim(), value = number(cells[3]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !(value > 0)) continue;
    out.set(date, { trade_date: date, close: number(cells[1]), market_cap: number(cells[2]), [kind]: value,
      percentile: number(cells[4]), p80: number(cells[5]), p50: number(cells[6]), p20: number(cells[7]) });
  }
  return out;
}
async function main() {
  const [peFile, pbFile] = process.argv.slice(2); if (!peFile || !pbFile) throw new Error('请提供 PE 和 PB CSV 文件路径');
  const pe = read(peFile, 'pe_ttm'), pb = read(pbFile, 'pb'), dates = new Set([...pe.keys(), ...pb.keys()]);
  const records = Array.from(dates).sort().map(date => ({ ...pe.get(date), ...pb.get(date), trade_date: date }));
  if (!records.length) throw new Error('未识别到有效市值加权估值数据');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const removed = await client.query(`DELETE FROM market.index_valuation_history
      WHERE index_code='HSI' AND valuation_method='equal_weight' AND source_code='user_supplied_csv'`);
    await client.query(`INSERT INTO market.index_valuation_history(index_code,valuation_method,trade_date,close,market_cap,pe_ttm,pb,pe_percentile,pe_p80,pe_p50,pe_p20,pb_percentile,pb_p80,pb_p50,pb_p20,source_code,raw_payload)
      SELECT 'HSI','market_cap_weighted',x.trade_date,x.close,x.market_cap,x.pe_ttm,x.pb,x.pe_percentile,x.pe_p80,x.pe_p50,x.pe_p20,x.pb_percentile,x.pb_p80,x.pb_p50,x.pb_p20,'user_supplied_weighted_csv',to_jsonb(x)
      FROM jsonb_to_recordset($1::jsonb) AS x(trade_date date,close numeric,market_cap numeric,pe_ttm numeric,pb numeric,percentile numeric,p80 numeric,p50 numeric,p20 numeric,pe_percentile numeric,pe_p80 numeric,pe_p50 numeric,pe_p20 numeric,pb_percentile numeric,pb_p80 numeric,pb_p50 numeric,pb_p20 numeric)
      ON CONFLICT(index_code,valuation_method,trade_date,source_code) DO UPDATE SET close=EXCLUDED.close,market_cap=EXCLUDED.market_cap,pe_ttm=EXCLUDED.pe_ttm,pb=EXCLUDED.pb,pe_percentile=EXCLUDED.pe_percentile,pe_p80=EXCLUDED.pe_p80,pe_p50=EXCLUDED.pe_p50,pe_p20=EXCLUDED.pe_p20,pb_percentile=EXCLUDED.pb_percentile,pb_p80=EXCLUDED.pb_p80,pb_p50=EXCLUDED.pb_p50,pb_p20=EXCLUDED.pb_p20,raw_payload=EXCLUDED.raw_payload,ingested_at=now()`, [JSON.stringify(records.map(r => ({ ...r, pe_percentile: pe.get(r.trade_date)?.percentile, pe_p80: pe.get(r.trade_date)?.p80, pe_p50: pe.get(r.trade_date)?.p50, pe_p20: pe.get(r.trade_date)?.p20, pb_percentile: pb.get(r.trade_date)?.percentile, pb_p80: pb.get(r.trade_date)?.p80, pb_p50: pb.get(r.trade_date)?.p50, pb_p20: pb.get(r.trade_date)?.p20 })))]);
    await client.query(`INSERT INTO market.market_valuation_daily(market_code,benchmark_code,trade_date,pe,source_code,source_date,raw_payload)
      SELECT 'HK','HSI',x.trade_date,x.pe_ttm,'hsi_weighted_manual',x.trade_date,to_jsonb(x)
      FROM jsonb_to_recordset($1::jsonb) AS x(trade_date date,pe_ttm numeric)
      WHERE x.pe_ttm > 0
      ON CONFLICT(market_code,benchmark_code,trade_date,source_code) DO UPDATE SET pe=EXCLUDED.pe,raw_payload=EXCLUDED.raw_payload,ingested_at=now()`, [JSON.stringify(records)]);
    await client.query('COMMIT');
    await calculateGraham();
    console.log(JSON.stringify({ removedEqualWeight: removed.rowCount, importedWeighted: records.length, earliest: records[0].trade_date, latest: records.at(-1).trade_date }));
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());

const fs = require('fs');
const { pool } = require('../db');
const { calculateGraham } = require('../jobs/marketVolatilitySync');

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('请提供 CSV 文件路径');
  const source = [];
  for (const line of fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const [day, raw] = line.trim().split(','); const value = Number(String(raw || '').replace(/^=/, ''));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '') || !(value > 0)) continue;
    source.push({ day, rate: Number((value <= 1 ? value * 100 : value).toFixed(6)) });
  }
  if (!source.length) throw new Error('未识别到有效的日期和利率数据');
  source.sort((a, b) => a.day.localeCompare(b.day)); const records = [], today = new Date().toISOString().slice(0, 10);
  for (let i = 0; i < source.length; i++) {
    const start = new Date(source[i].day + 'T00:00:00Z'), next = source[i + 1] && new Date(source[i + 1].day + 'T00:00:00Z'), end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 6); if (next) { const beforeNext = new Date(next); beforeNext.setUTCDate(beforeNext.getUTCDate() - 1); if (beforeNext < end) end.setTime(beforeNext.getTime()); }
    const todayDate = new Date(today + 'T00:00:00Z'); if (todayDate < end) end.setTime(todayDate.getTime());
    for (const day = new Date(start); day <= end; day.setUTCDate(day.getUTCDate() + 1)) records.push({ day: day.toISOString().slice(0, 10), rate: source[i].rate, source_date: source[i].day });
  }
  await pool.query(`INSERT INTO market.sovereign_yield_daily(market_code,tenor_years,trade_date,yield_pct,source_code,source_date,raw_payload)
    SELECT 'US',10,x.day,x.rate,'manual_fed_funds',x.source_date,jsonb_build_object('source',$2::text,'sourceDate',x.source_date,'rate',x.rate)
    FROM jsonb_to_recordset($1::jsonb) AS x(day date,rate numeric,source_date date)
    ON CONFLICT(market_code,tenor_years,trade_date,source_code) DO UPDATE SET yield_pct=EXCLUDED.yield_pct,source_date=EXCLUDED.source_date,raw_payload=EXCLUDED.raw_payload,ingested_at=now()`, [JSON.stringify(records), file.split(/[\\/]/).pop()]);
  await calculateGraham();
  const verify = await pool.query(`SELECT count(*)::int AS fed_rows, min(trade_date)::text AS fed_start, max(trade_date)::text AS fed_end
    FROM market.sovereign_yield_daily WHERE market_code='US' AND source_code='manual_fed_funds'`);
  const hsi = await pool.query(`SELECT count(*)::int AS rows, max(trade_date)::text AS latest
    FROM analytics.graham_index_daily WHERE market_code='HK' AND benchmark_code='HSI'`);
  console.log(JSON.stringify({ sourceRows: source.length, imported: records.length, earliest: records[0].day, latest: records.at(-1).day, stored: verify.rows[0], hsiGraham: hsi.rows[0] }));
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());

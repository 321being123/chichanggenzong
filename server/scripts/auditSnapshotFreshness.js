// 快照一致性审计：找出与当前标准事实不一致的股债分析快照。
// 用法：node server/scripts/auditSnapshotFreshness.js
// 依赖：server/db/connection 中的 pool（自动读取 .env 的 PG* 连接配置）。
const { pool } = require('../db/connection');

async function main() {
  console.log('=== 可转债：快照转股价 vs 主档 current_conv_price 不一致 ===');
  const cbConv = await pool.query(`
    SELECT i.canonical_code, s.created_at,
           (s.payload->'basic'->>'convert_price')::numeric AS snap_conv,
           p.current_conv_price
    FROM analytics.analysis_snapshots s
    JOIN core.instruments i ON i.instrument_id = s.instrument_id
    LEFT JOIN fundamental.convertible_bond_profiles p ON p.instrument_id = i.instrument_id
    WHERE s.snapshot_type = 'convertible_bond_analysis'
      AND (s.payload->'basic'->>'convert_price')::numeric IS DISTINCT FROM p.current_conv_price
    ORDER BY i.canonical_code`);
  console.log('数量:', cbConv.rowCount);
  cbConv.rows.forEach(r => console.log(`  ${r.canonical_code}\t快照=${r.snap_conv}\t主档=${r.current_conv_price}\t快照时间=${r.created_at}`));

  console.log('\n=== 可转债：主档更新时间晚于快照生成时间 ===');
  const cbProf = await pool.query(`
    SELECT i.canonical_code, s.created_at, p.source_updated_at, p.updated_at
    FROM analytics.analysis_snapshots s
    JOIN core.instruments i ON i.instrument_id = s.instrument_id
    JOIN fundamental.convertible_bond_profiles p ON p.instrument_id = i.instrument_id
    WHERE s.snapshot_type = 'convertible_bond_analysis'
      AND (p.source_updated_at > s.created_at OR p.updated_at > s.created_at)
    ORDER BY i.canonical_code`);
  console.log('数量:', cbProf.rowCount);
  cbProf.rows.forEach(r => console.log(`  ${r.canonical_code}\t快照=${r.created_at}\tsource_updated_at=${r.source_updated_at}\tupdated_at=${r.updated_at}`));

  console.log('\n=== 可转债：行情比快照更新（已有新交易日行情） ===');
  const cbMkt = await pool.query(`
    SELECT i.canonical_code, s.as_of_date, max(b.trade_date) AS latest_bond_date
    FROM analytics.analysis_snapshots s
    JOIN core.instruments i ON i.instrument_id = s.instrument_id
    JOIN market.daily_bars b ON b.instrument_id = i.instrument_id
    WHERE s.snapshot_type = 'convertible_bond_analysis'
    GROUP BY i.canonical_code, s.as_of_date
    HAVING max(b.trade_date) > s.as_of_date
    ORDER BY i.canonical_code`);
  console.log('数量:', cbMkt.rowCount);
  cbMkt.rows.forEach(r => console.log(`  ${r.canonical_code}\t快照as_of=${r.as_of_date}\t最新行情=${r.latest_bond_date}`));

  console.log('\n=== 股票：仍为旧版 legacy 占位水位 ===');
  const stk = await pool.query(`
    SELECT count(*) AS n FROM analytics.analysis_snapshots
    WHERE snapshot_type = 'stock_analysis'
      AND source_watermark = '{"source":"legacy_projection"}'::jsonb`);
  console.log('数量:', stk.rows[0].n);

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });

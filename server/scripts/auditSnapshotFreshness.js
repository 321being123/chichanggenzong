// 快照一致性审计：找出与当前标准事实不一致的股债分析快照（仅取每只证券最新一份快照）。
// 用法：node server/scripts/auditSnapshotFreshness.js
// 依赖：server/db/connection 中的 pool（自动读取 .env 的 PG* 连接配置）。
const { pool } = require('../db/connection');

// 每只证券只取最新快照，避免历史旧快照被反复计入（与 dailyConsistencyStats 口径一致）
const LATEST_CB = `
  SELECT * FROM (
    SELECT DISTINCT ON (instrument_id) *
      FROM analytics.analysis_snapshots
     WHERE snapshot_type = 'convertible_bond_analysis'
     ORDER BY instrument_id, as_of_date DESC, created_at DESC
  ) s`;

const LATEST_STOCK = `
  SELECT * FROM (
    SELECT DISTINCT ON (instrument_id) *
      FROM analytics.analysis_snapshots
     WHERE snapshot_type = 'stock_analysis'
     ORDER BY instrument_id, as_of_date DESC, created_at DESC
  ) s`;

async function runAudit() {
  const result = {};

  const cbConv = await pool.query(`
    SELECT i.canonical_code, s.created_at,
           (s.payload->'basic'->>'convert_price')::numeric AS snap_conv,
           p.current_conv_price
    FROM (${LATEST_CB}) s
    JOIN core.instruments i ON i.instrument_id = s.instrument_id
    LEFT JOIN fundamental.convertible_bond_profiles p ON p.instrument_id = i.instrument_id
    WHERE (s.payload->'basic'->>'convert_price')::numeric IS DISTINCT FROM p.current_conv_price
    ORDER BY i.canonical_code`);
  result.cbConv = cbConv.rows;

  const cbProf = await pool.query(`
    SELECT i.canonical_code, s.created_at, p.source_updated_at, p.updated_at
    FROM (${LATEST_CB}) s
    JOIN core.instruments i ON i.instrument_id = s.instrument_id
    JOIN fundamental.convertible_bond_profiles p ON p.instrument_id = i.instrument_id
    WHERE (p.source_updated_at > s.created_at OR p.updated_at > s.created_at)
    ORDER BY i.canonical_code`);
  result.cbProf = cbProf.rows;

  const cbMkt = await pool.query(`
    SELECT i.canonical_code, s.as_of_date, max(b.trade_date) AS latest_bond_date
    FROM (${LATEST_CB}) s
    JOIN core.instruments i ON i.instrument_id = s.instrument_id
    JOIN market.daily_bars b ON b.instrument_id = i.instrument_id
    GROUP BY i.canonical_code, s.as_of_date
    HAVING max(b.trade_date) > s.as_of_date
    ORDER BY i.canonical_code`);
  result.cbMkt = cbMkt.rows;

  const stk = await pool.query(`
    SELECT count(*)::int AS n FROM (${LATEST_STOCK}) s
    WHERE s.source_watermark = '{"source":"legacy_projection"}'::jsonb`);
  result.stockLegacy = stk.rows[0].n;

  return result;
}

async function main() {
  const r = await runAudit();
  console.log('=== 可转债：快照转股价 vs 主档 current_conv_price 不一致（最新快照） ===');
  console.log('数量:', r.cbConv.length);
  r.cbConv.forEach(x => console.log(`  ${x.canonical_code}\t快照=${x.snap_conv}\t主档=${x.current_conv_price}\t快照时间=${x.created_at}`));

  console.log('\n=== 可转债：主档更新时间晚于快照生成时间（最新快照） ===');
  console.log('数量:', r.cbProf.length);
  r.cbProf.forEach(x => console.log(`  ${x.canonical_code}\t快照=${x.created_at}\tsource_updated_at=${x.source_updated_at}\tupdated_at=${x.updated_at}`));

  console.log('\n=== 可转债：行情比快照更新（已有新交易日行情，最新快照） ===');
  console.log('数量:', r.cbMkt.length);
  r.cbMkt.forEach(x => console.log(`  ${x.canonical_code}\t快照as_of=${x.as_of_date}\t最新行情=${x.latest_bond_date}`));

  console.log('\n=== 股票：仍为旧版 legacy 占位水位（最新快照） ===');
  console.log('数量:', r.stockLegacy);

  await pool.end();
}

module.exports = { runAudit, main };

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

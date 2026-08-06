// 每日快照一致性统计（方案 P2.6）
// 对比页面分析快照与当前入库事实，输出数量级结论，供每日任务链结束时打印监控。
const { pool } = require('../db/connection');

async function dailyConsistencyStats() {
  const { rows } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM (
        SELECT DISTINCT ON (s.instrument_id) s.instrument_id
          FROM analytics.analysis_snapshots s
         WHERE s.snapshot_type='stock_analysis'
         ORDER BY s.instrument_id, s.as_of_date DESC, s.created_at DESC
      ) t) AS stock_snapshots,
      (SELECT COUNT(*) FROM (
        SELECT DISTINCT ON (s.instrument_id) s.source_watermark
          FROM analytics.analysis_snapshots s
         WHERE s.snapshot_type='stock_analysis'
         ORDER BY s.instrument_id, s.as_of_date DESC, s.created_at DESC
      ) t WHERE t.source_watermark IS NULL OR t.source_watermark = '{"source":"legacy_projection"}'::jsonb) AS stock_legacy_watermark,
      (SELECT COUNT(*) FROM (
        SELECT DISTINCT ON (s.instrument_id) s.instrument_id
          FROM analytics.analysis_snapshots s
         WHERE s.snapshot_type='convertible_bond_analysis'
         ORDER BY s.instrument_id, s.as_of_date DESC, s.created_at DESC
      ) t) AS bond_snapshots,
      (SELECT COUNT(*) FROM (
        SELECT DISTINCT ON (s.instrument_id) (s.payload->'basic'->>'convert_price')::numeric AS snap_price, p.current_conv_price
          FROM analytics.analysis_snapshots s
          JOIN fundamental.convertible_bond_profiles p ON p.instrument_id = s.instrument_id
         WHERE s.snapshot_type='convertible_bond_analysis'
         ORDER BY s.instrument_id, s.as_of_date DESC, s.created_at DESC
      ) t WHERE t.snap_price IS NOT NULL AND t.current_conv_price IS NOT NULL
          AND abs(t.snap_price - t.current_conv_price) > 0.001) AS bond_conv_price_mismatch,
      (SELECT COUNT(*) FROM ops.data_quality_issues
        WHERE issue_type='snapshot_input_mismatch' AND status='open') AS open_conv_price_issues
  `);
  return rows[0] || {};
}

module.exports = { dailyConsistencyStats };

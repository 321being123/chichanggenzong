const { pool } = require('../db/connection');

// 数据库存储保留清理仓储：按小批次删除超期未引用原始报文与历史未发布 partial 选股试算运行。

async function deleteExpiredUnreferencedRawRecords({
  datasetCodes,
  retentionDays,
  batchSize = 2000,
  maxBatches = 50,
}, client = pool) {
  let deleted = 0;
  for (let i = 0; i < maxBatches; i++) {
    const result = await client.query(
      `WITH doomed AS (
         SELECT r.raw_record_id
           FROM ops.raw_records r
          WHERE r.dataset_code = ANY($1::text[])
            AND r.ingested_at < now() - make_interval(days => $2)
            AND NOT EXISTS (SELECT 1 FROM fundamental.financial_reports fr WHERE fr.raw_record_id = r.raw_record_id)
            AND NOT EXISTS (SELECT 1 FROM event.documents d WHERE d.raw_record_id = r.raw_record_id)
            AND NOT EXISTS (SELECT 1 FROM market.repo_daily_rates rr WHERE rr.raw_record_id = r.raw_record_id)
            AND NOT EXISTS (SELECT 1 FROM market.instrument_trade_rules tr WHERE tr.raw_record_id = r.raw_record_id)
          LIMIT $3
       )
       DELETE FROM ops.raw_records r
        USING doomed d
        WHERE r.raw_record_id = d.raw_record_id`,
      [datasetCodes, retentionDays, batchSize]
    );
    const count = result.rowCount || 0;
    deleted += count;
    if (count < batchSize) break;
  }
  return deleted;
}

async function deleteStalePartialSelectionRuns({
  retentionDays,
  batchSize = 50,
  maxBatches = 20,
}, client = pool) {
  let deleted = 0;
  for (let i = 0; i < maxBatches; i++) {
    const result = await client.query(
      `WITH doomed AS (
         SELECT r.run_id
           FROM analytics.stock_selection_runs r
          WHERE r.run_kind IN ('daily', 'weekly')
            AND r.quality_status = 'partial'
            AND r.created_at < now() - make_interval(days => $1)
            AND NOT EXISTS (SELECT 1 FROM analytics.stock_selection_publications p WHERE p.run_id = r.run_id)
            AND NOT EXISTS (SELECT 1 FROM analytics.stock_selection_runs r2 WHERE r2.supersedes_run_id = r.run_id)
          LIMIT $2
       )
       DELETE FROM analytics.stock_selection_runs r
        USING doomed d
        WHERE r.run_id = d.run_id`,
      [retentionDays, batchSize]
    );
    const count = result.rowCount || 0;
    deleted += count;
    if (count < batchSize) break;
  }
  return deleted;
}

module.exports = {
  deleteExpiredUnreferencedRawRecords,
  deleteStalePartialSelectionRuns,
};

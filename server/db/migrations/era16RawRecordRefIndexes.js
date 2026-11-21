// 207：为引用 ops.raw_records(raw_record_id) 的外键子表补齐部分索引。
// 缺少这些索引时，清理 ops.raw_records 过期记录会对每行触发四张大表的全表扫描校验。
async function migration207RawRecordRefIndexes(pool) {
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ix_event_documents_raw_record_id
      ON event.documents (raw_record_id)
      WHERE raw_record_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS ix_fundamental_financial_reports_raw_record_id
      ON fundamental.financial_reports (raw_record_id)
      WHERE raw_record_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS ix_market_instrument_trade_rules_raw_record_id
      ON market.instrument_trade_rules (raw_record_id)
      WHERE raw_record_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS ix_market_repo_daily_rates_raw_record_id
      ON market.repo_daily_rates (raw_record_id)
      WHERE raw_record_id IS NOT NULL;
  `);
}

module.exports = { migration207RawRecordRefIndexes };

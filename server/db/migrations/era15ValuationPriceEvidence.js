// 持仓统一估值价格：为账户日价补充可核验的收盘证据元数据（合同 8.3）
// 只增加兼容元数据与索引，不改动已有价格值；存量行统一标记 legacy_unverified，
// 不把迁移运行时间伪造成源端报价时间，也不默认把旧价当作已确认收盘价。
async function migration195ValuationPriceEvidence(pool) {
  await pool.query(`
    ALTER TABLE daily_prices ADD COLUMN IF NOT EXISTS source TEXT;
    ALTER TABLE daily_prices ADD COLUMN IF NOT EXISTS quote_at TIMESTAMPTZ;
    ALTER TABLE daily_prices ADD COLUMN IF NOT EXISTS is_final BOOLEAN;
    ALTER TABLE daily_prices ADD COLUMN IF NOT EXISTS quality TEXT NOT NULL DEFAULT 'legacy_unverified';
    ALTER TABLE daily_prices ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE daily_prices ADD COLUMN IF NOT EXISTS previous_price NUMERIC(20,4);
    ALTER TABLE daily_prices ADD COLUMN IF NOT EXISTS evidence JSONB NOT NULL DEFAULT '{}'::jsonb;
  `);
  // 统一取价按“证券 + 业务日”跨账户读取同一用户的候选，需要代码维度索引支持批量查询。
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_daily_prices_code_date
      ON daily_prices (username, code, date DESC);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_daily_prices_account_date
      ON daily_prices (username, account_name, date DESC);
  `);
}

module.exports = { migration195ValuationPriceEvidence };

// 日价补充“市场”字段：同一段代码在 A 股与港股可能是两只完全不同的证券
// （港股 00001 补零后与 A 股 000001 同形），只按代码跨账户读取会把两者串在一起。
// 存量行按代码长度回填（港股 5 位、A 股 6 位，取自生产库实际分布），不改动任何价格值。
async function migration196DailyPriceMarket(pool) {
  await pool.query(`
    ALTER TABLE daily_prices ADD COLUMN IF NOT EXISTS market TEXT;
  `);
  await pool.query(`
    UPDATE daily_prices
       SET market = CASE WHEN length(code) = 5 THEN 'HK' WHEN length(code) = 6 THEN 'CN' END
     WHERE market IS NULL;
  `);
  // 统一取价按“市场 + 代码 + 业务日”跨账户读取，需要市场维度索引支持。
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_daily_prices_market_code_date
      ON daily_prices (market, code, date DESC);
  `);
}

module.exports = { migration196DailyPriceMarket };

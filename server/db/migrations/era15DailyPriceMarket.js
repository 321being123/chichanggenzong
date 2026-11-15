// 日价补充“市场”字段：同一段代码在 A 股与港股可能是两只完全不同的证券
// （港股 00001 补零后与 A 股 000001 同形），只按代码跨账户读取会把两者串在一起。
//
// 回填只采用**可核实的证券身份**，不按长度一刀切：
// - 5 位代码只可能是港股（A 股/基金/债券代码均为 6 位）；
// - 6 位且不以 00 开头不可能是港股补零（港股都以 0 开头，补零后必然是 00 开头）；
// - 6 位且以 00 开头存在同形歧义：必须用行情缓存的交易所、或本账户持仓的 subtype 核实是 A 股；
// - 核实不了的保持 NULL（身份不明），由取价层按“缺口”处理，绝不猜。
// 每次判定同时把依据写进 evidence.market_basis，便于事后审计。
async function migration196DailyPriceMarket(pool) {
  await pool.query(`
    ALTER TABLE daily_prices ADD COLUMN IF NOT EXISTS market TEXT;
  `);

  // 5 位：只能是港股。
  await pool.query(`
    UPDATE daily_prices
       SET market = 'HK',
           evidence = COALESCE(evidence, '{}'::jsonb) || '{"market_basis":"code_length_5"}'::jsonb
     WHERE market IS NULL AND length(code) = 5;
  `);

  // 6 位不以 00 开头：只能是 A 股。
  await pool.query(`
    UPDATE daily_prices
       SET market = 'CN',
           evidence = COALESCE(evidence, '{}'::jsonb) || '{"market_basis":"code_shape"}'::jsonb
     WHERE market IS NULL AND length(code) = 6 AND code NOT LIKE '00%';
  `);

  // 6 位以 00 开头：用行情缓存的交易所核实 A 股身份。
  await pool.query(`
    UPDATE daily_prices d
       SET market = 'CN',
           evidence = COALESCE(d.evidence, '{}'::jsonb) || '{"market_basis":"quote_cache"}'::jsonb
     WHERE d.market IS NULL AND length(d.code) = 6 AND d.code LIKE '00%'
       AND EXISTS (
         SELECT 1 FROM market_quote_cache m
          WHERE m.code = d.code AND m.market IN ('sh', 'sz', 'bj')
       );
  `);

  // 仍无法核实的：用本账户持仓的 subtype 核实（非港股 subtype 即 A 股）。
  await pool.query(`
    UPDATE daily_prices d
       SET market = 'CN',
           evidence = COALESCE(d.evidence, '{}'::jsonb) || '{"market_basis":"account_position"}'::jsonb
     WHERE d.market IS NULL AND length(d.code) = 6 AND d.code LIKE '00%'
       AND EXISTS (
         SELECT 1 FROM positions p
          WHERE p.username = d.username AND p.account_name = d.account_name
            AND p.code = d.code AND COALESCE(p.subtype, '') <> '港股'
       );
  `);

  // 统一取价按“市场 + 代码 + 业务日”跨账户读取，需要市场维度索引支持。
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_daily_prices_market_code_date
      ON daily_prices (market, code, date DESC);
  `);
}

module.exports = { migration196DailyPriceMarket };

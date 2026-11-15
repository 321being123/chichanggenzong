// 市场依据补标：196 首版按长度判定后没有写 evidence.market_basis，
// 导致这些行的市场结论“无凭据”，取价层对同形代码（6 位 00 开头）会保守地判为身份不明。
// 这里只对**形状本身就能确定市场**的行补依据（5 位=港股；6 位不以 00 开头=A 股），
// 不改变任何 market 结论，也不猜测有歧义的行。
async function migration198DailyPriceMarketBasis(pool) {
  await pool.query(`
    UPDATE daily_prices
       SET evidence = COALESCE(evidence, '{}'::jsonb) || '{"market_basis":"code_length_5"}'::jsonb
     WHERE COALESCE(evidence->>'market_basis', '') = '' AND market = 'HK' AND length(code) = 5;
  `);
  await pool.query(`
    UPDATE daily_prices
       SET evidence = COALESCE(evidence, '{}'::jsonb) || '{"market_basis":"code_shape"}'::jsonb
     WHERE COALESCE(evidence->>'market_basis', '') = '' AND market = 'CN'
       AND length(code) = 6 AND code NOT LIKE '00%';
  `);
}

module.exports = { migration198DailyPriceMarketBasis };

// 市场回填的证据收紧：行情缓存里存在同码 A 股，只能说明"A 股里也有这段代码"，
// 不能证明某个账户某一天那条历史价格就属于 A 股（它也可能是补零存储的港股）。
// 因此把仅凭 quote_cache / account_position 得出的 CN 结论撤回为 UNKNOWN（身份不明 → 缺口），
// 只保留"该行自身来源标签"这类直接证据。
async function migration200DailyPriceMarketEvidence(pool) {
  await pool.query(`
    UPDATE daily_prices
       SET market = 'UNKNOWN',
           evidence = COALESCE(evidence, '{}'::jsonb) || '{"market_basis":"unverified","market_recheck":"weak_evidence"}'::jsonb
     WHERE length(code) = 6 AND code LIKE '00%'
       AND market = 'CN'
       AND COALESCE(evidence->>'market_basis', '') IN ('quote_cache', 'account_position');
  `);
}

module.exports = { migration200DailyPriceMarketEvidence };

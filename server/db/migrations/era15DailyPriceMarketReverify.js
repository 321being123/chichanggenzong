// 196 的首版实现按代码长度回填 market，会把“六位补零的港股”错标成 A 股（CN）。
// 这里对已标记的行做一次**基于可核实身份的复核**：
// ① 来源标签能证明市场时（收盘任务/历史补录带“港股”“A股”等标签），以来源为准修正；
// ② 6 位以 00 开头、且没有可核实依据的行，一律退回 NULL（身份不明 → 取价层按缺口处理），
//    不让“猜出来的 CN”继续被 A 股持仓当成自己的收盘价。
// ③ 复核通过的行补写 evidence.market_basis，便于审计。
async function migration197DailyPriceMarketReverify(pool) {
  // ① 来源标签：港股结论优先修正错标的行。
  await pool.query(`
    UPDATE daily_prices
       SET market = 'HK',
           evidence = COALESCE(evidence, '{}'::jsonb) || '{"market_basis":"source_label"}'::jsonb
     WHERE COALESCE(source, '') LIKE '%港股%' AND (market IS NULL OR market <> 'HK');
  `);
  await pool.query(`
    UPDATE daily_prices
       SET market = 'CN',
           evidence = COALESCE(evidence, '{}'::jsonb) || '{"market_basis":"source_label"}'::jsonb
     WHERE (COALESCE(source, '') LIKE '%A股%' OR COALESCE(source, '') LIKE '%沪市%'
            OR COALESCE(source, '') LIKE '%深市%' OR COALESCE(source, '') LIKE '%京市%')
       AND (market IS NULL OR market <> 'CN');
  `);

  // ② 6 位以 00 开头：只有行情缓存或账户持仓能证明是 A 股时才保留 CN，否则退回未知。
  await pool.query(`
    UPDATE daily_prices d
       SET evidence = COALESCE(d.evidence, '{}'::jsonb) || '{"market_basis":"quote_cache"}'::jsonb
     WHERE d.market = 'CN' AND length(d.code) = 6 AND d.code LIKE '00%'
       AND COALESCE(d.evidence->>'market_basis', '') IN ('', 'code_length_5')
       AND EXISTS (
         SELECT 1 FROM market_quote_cache m
          WHERE m.code = d.code AND m.market IN ('sh', 'sz', 'bj')
       );
  `);
  await pool.query(`
    UPDATE daily_prices d
       SET market = NULL,
           evidence = COALESCE(d.evidence, '{}'::jsonb) || '{"market_basis":"unverified"}'::jsonb
     WHERE d.market = 'CN' AND length(d.code) = 6 AND d.code LIKE '00%'
       AND COALESCE(d.evidence->>'market_basis', '') IN ('', 'code_length_5')
       AND NOT EXISTS (
         SELECT 1 FROM market_quote_cache m
          WHERE m.code = d.code AND m.market IN ('sh', 'sz', 'bj')
       )
       AND NOT EXISTS (
         SELECT 1 FROM positions p
          WHERE p.username = d.username AND p.account_name = d.account_name
            AND p.code = d.code AND COALESCE(p.subtype, '') <> '港股'
       );
  `);

  // ③ 来源是收盘任务/历史补录但还没有依据标记的行：补写，供取价层作为可核实凭据。
  await pool.query(`
    UPDATE daily_prices
       SET evidence = COALESCE(evidence, '{}'::jsonb) || jsonb_build_object('market_basis', 'source_label')
     WHERE market IS NOT NULL
       AND COALESCE(evidence->>'market_basis', '') = ''
       AND (COALESCE(source, '') LIKE '%港股%' OR COALESCE(source, '') LIKE '%A股%'
            OR COALESCE(source, '') LIKE '%history_backfill%' OR COALESCE(source, '') LIKE '%nav_import_anchor%');
  `);
}

module.exports = { migration197DailyPriceMarketReverify };

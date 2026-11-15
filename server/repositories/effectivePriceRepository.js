const { pool } = require('../db/connection');

// 统一估值价格的批量只读仓储。
// 只做 SQL，不做业务判断：来源白名单、质量分级、市场时段与缺失原因都在 services/effectivePrice 内决定。
// 所有查询都接受外层事务连接，避免在一次账户读取里另开连接池连接造成口径分裂。

// 按证券取最近若干交易日的日价候选，跨用户读取普通市场事实：
// 同一证券同一交易日的收盘价是公开市场事实，不属于某个账户，因此不能按用户各选一份，
// 否则两位用户持有同一证券会各自得到“完整”但不同的价格。
// 账户私有的派生价（导入锚点等，见 $4 排除名单）只回给其所属账户，保持人工/派生估值隔离。
async function listRecentDailyPriceCandidates(params, client = pool) {
  const [username, codes, upperDate, privateSources, dateWindow] = params;
  return client.query(
    `SELECT code, date::text AS date, price::float8 AS price, username, account_name,
            quality, is_final, source, quote_at, revision
       FROM (
         SELECT code, date, price, username, account_name, quality, is_final, source, quote_at, revision,
                DENSE_RANK() OVER (PARTITION BY code ORDER BY date DESC) AS date_rank
           FROM daily_prices
          WHERE code = ANY($2::text[])
            AND date::date <= $3::date
            AND (COALESCE(source, '') <> ALL($4::text[]) OR username = $1)
       ) ranked
      WHERE date_rank <= $5
      ORDER BY code, date DESC, revision DESC`,
    [username, codes, upperDate, privateSources, dateWindow]
  );
}

// 共享行情缓存只含公开市场事实，不按账户隔离，也不写入账户专属人工估值。
async function listQuoteCacheCandidates(params, client = pool) {
  const [codes, sources] = params;
  return client.query(
    `SELECT code, symbol, source, market, name, price::float8 AS price, quote_time, fetched_at
       FROM market_quote_cache
      WHERE code = ANY($1::text[])
        AND ($2::text[] IS NULL OR source = ANY($2::text[]))
      ORDER BY code, fetched_at DESC`,
    [codes, sources]
  );
}

// 兼容持仓价：仅作为无任何行情证据时的“未核实参考价”，不构成正常证券估值权威。
async function listPositionPriceCache(params, client = pool) {
  const [username, accountName, codes] = params;
  return client.query(
    `SELECT code, price::float8 AS price, quantity::float8 AS quantity, subtype
       FROM positions
      WHERE username = $1 AND account_name = $2 AND code = ANY($3::text[])`,
    [username, accountName, codes]
  );
}

async function selectAccountId(params, client = pool) {
  const [username, accountName] = params;
  return client.query('SELECT id FROM accounts WHERE username=$1 AND account_name=$2', params);
}

// 条件写入：
// ①已确认收盘价不允许被较低资格（候选/遗留/派生）覆盖；
// ②同级 confirmed 更正必须能核验修订关系，只认两种情形：
//   a) 同一已准入来源、报价时刻严格更新（正常修订/重取）；
//   b) 同一已准入来源、同一报价时刻但价格确实不同（来源侧更正）。
//   报价时刻缺失，或来源不同且时刻相同（迟到响应/来源打架）一律不写，冲突留待人工核验；
// ③完全相同（同质量、同价、同来源时刻）视为幂等重复，不更新也不递增 revision。
// previous_price / revision 保留可追溯性与“合法更正使版本变化”的语义。
async function upsertDailyPrice(params, client = pool) {
  const [row] = params;
  return client.query(
    `INSERT INTO daily_prices
       (username, account_name, account_id, date, code, name, price, source, quote_at, is_final, quality, revision, evidence)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,$12::jsonb)
     ON CONFLICT (username, account_name, date, code) DO UPDATE SET
       name = EXCLUDED.name,
       previous_price = CASE
         WHEN daily_prices.price IS DISTINCT FROM EXCLUDED.price THEN daily_prices.price
         ELSE daily_prices.previous_price END,
       revision = daily_prices.revision + 1,
       price = EXCLUDED.price,
       source = EXCLUDED.source,
       quote_at = EXCLUDED.quote_at,
       is_final = EXCLUDED.is_final,
       quality = EXCLUDED.quality,
       evidence = EXCLUDED.evidence
     WHERE daily_prices.quality <> 'confirmed'
        OR (EXCLUDED.quality = 'confirmed'
            AND EXCLUDED.source IS NOT DISTINCT FROM daily_prices.source
            AND (
              -- a) 同来源、报价时刻严格更新
              (EXCLUDED.quote_at IS NOT NULL
                AND (daily_prices.quote_at IS NULL OR EXCLUDED.quote_at > daily_prices.quote_at))
              -- b) 同来源、同一报价时刻但价格不同：来源侧更正
              OR (daily_prices.quote_at IS NOT NULL
                  AND EXCLUDED.quote_at IS NOT DISTINCT FROM daily_prices.quote_at
                  AND EXCLUDED.price IS DISTINCT FROM daily_prices.price)
            ))
     RETURNING date::text AS date, code, revision, quality, is_final`,
    [row.username, row.accountName, row.accountId, row.date, row.code, row.name || '',
      row.price, row.source || null, row.quoteAt || null, row.isFinal == null ? null : !!row.isFinal,
      row.quality || 'candidate', JSON.stringify(row.evidence || {})]
  );
}

module.exports = {
  listRecentDailyPriceCandidates,
  listQuoteCacheCandidates,
  listPositionPriceCache,
  selectAccountId,
  upsertDailyPrice,
};

const { pool } = require('../db/connection');

// 统一估值价格的批量只读仓储。
// 只做 SQL，不做业务判断：来源白名单、质量分级、市场时段与缺失原因都在 services/effectivePrice 内决定。
// 所有查询都接受外层事务连接，避免在一次账户读取里另开连接池连接造成口径分裂。

// 按证券取逐账户最近候选（窗口函数限流，避免历史账户把全表读进来）。
// 同一证券在不同账户的同日记录都会返回：上层据此判定“同一证券同一时点只有一个价格”，
// 冲突时报告并核验，而不是各账户各自给出不同的完整估值。
async function listRecentDailyPriceCandidates(params, client = pool) {
  const [username, codes, upperDate, perCode] = params;
  return client.query(
    `SELECT code, date::text AS date, price::float8 AS price, account_name,
            quality, is_final, source, quote_at, revision
       FROM (
         SELECT code, date, price, account_name, quality, is_final, source, quote_at, revision,
                ROW_NUMBER() OVER (PARTITION BY code ORDER BY date DESC, revision DESC) AS rn
           FROM daily_prices
          WHERE username = $1
            AND code = ANY($2::text[])
            AND date::date <= $3::date
       ) ranked
      WHERE rn <= $4
      ORDER BY code, date DESC, revision DESC`,
    [username, codes, upperDate, perCode]
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

// 条件写入：已确认收盘价不允许被较低资格（候选/遗留）覆盖，只能接受同级更正或更高资格。
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
        OR EXCLUDED.quality = 'confirmed'
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

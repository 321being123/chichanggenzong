const { pool } = require('../db/connection');

const SOURCE = 'tencent';

async function loadCache(symbols) {
  if (!symbols.length) return new Map();
  try {
    const { rows } = await pool.query(
      `SELECT symbol, code, market, name, price, change_pct, quote_time, fetched_at
         FROM market_quote_cache WHERE source = $1 AND symbol = ANY($2::text[])`,
      [SOURCE, symbols]
    );
    return new Map(rows.map(row => [row.symbol, {
      symbol: row.symbol,
      code: row.code,
      market: row.market,
      name: row.name,
      price: row.price == null ? null : Number(row.price),
      change: row.change_pct == null ? null : Number(row.change_pct),
      quote_time: row.quote_time,
      fetched_at: row.fetched_at,
      source: SOURCE,
      cached: true,
    }]));
  } catch (_) {
    // 兼容迁移尚未执行或数据库临时不可用；行情仍可直连上游。
    return new Map();
  }
}

async function saveCache(quotes) {
  const rows = Array.from(quotes.values());
  if (!rows.length) return;
  const chunkSize = 100;
  try {
    for (let start = 0; start < rows.length; start += chunkSize) {
      const chunk = rows.slice(start, start + chunkSize);
      const values = [];
      const params = [];
      chunk.forEach((row, index) => {
        const base = index * 8;
        values.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8})`);
        params.push(row.symbol, SOURCE, row.code, row.market, row.name || '', row.price, row.change, row.quote_time);
      });
      await pool.query(
        `INSERT INTO market_quote_cache
           (symbol, source, code, market, name, price, change_pct, quote_time)
         VALUES ${values.join(',')}
         ON CONFLICT (symbol, source) DO UPDATE SET
           code=EXCLUDED.code, market=EXCLUDED.market, name=EXCLUDED.name,
           price=EXCLUDED.price, change_pct=EXCLUDED.change_pct,
           quote_time=EXCLUDED.quote_time, fetched_at=now()`,
        params
      );
    }
  } catch (_) {
    // 缓存写入失败不能让行情请求失败。
  }
}

module.exports = { loadCache, saveCache };

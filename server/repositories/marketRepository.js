const { pool } = require('../db/connection');

// 自 server/services/market.js 迁入的数据读写函数（只做标准事实读写，业务判定仍留在服务层）。

async function loadInstrumentCache() {
  try {
    const { rows } = await pool.query(
      `SELECT ts_code, name, fetched_at FROM market_instruments WHERE source = 'tushare'`
    );
    const map = new Map(rows.map(row => [row.ts_code, row.name]));
    const newest = rows.reduce((value, row) => Math.max(value, new Date(row.fetched_at).getTime() || 0), 0);
    return { map, newest };
  } catch (_) {
    return { map: new Map(), newest: 0 };
  }
}

async function saveInstrumentCache(rows) {
  try {
    for (let start = 0; start < rows.length; start += 500) {
      const chunk = rows.slice(start, start + 500);
      const params = [];
      const values = chunk.map((row, index) => {
        params.push(row.ts_code, row.name || '');
        return `($${index * 2 + 1},$${index * 2 + 2},'tushare')`;
      });
      await pool.query(
        `INSERT INTO market_instruments (ts_code, name, source) VALUES ${values.join(',')}
         ON CONFLICT (ts_code) DO UPDATE SET
           name=EXCLUDED.name, source=EXCLUDED.source, fetched_at=now()`,
        params
      );
      // core.instruments 由共享 stock_basic 主档批次统一写入；行情缓存层不再直接造主档。
    }
  } catch (_) {}
}

async function select_market_quote_cache(params, client = pool) {
  return client.query(`SELECT symbol AS ts_code, price, change_pct, quote_time, fetched_at
         FROM market_quote_cache WHERE source = 'tushare_daily'`);
}

// 批量写入日线行情缓存：每 300 行一批，占位符与参数在此层拼装
async function saveDailyQuoteCache(rows, client = pool) {
  for (let start = 0; start < rows.length; start += 300) {
    const chunk = rows.slice(start, start + 300);
    const params = [];
    const values = chunk.map((row, index) => {
      const base = index * 8;
      params.push(row.ts_code, 'tushare_daily', row.ts_code, String(row.ts_code).split('.')[1].toLowerCase(), '', row.close, row.pct_chg, row.quote_time);
      return `(${Array.from({ length: 8 }, (_, i) => '$' + (base + i + 1)).join(',')})`;
    });
    await client.query(
      `INSERT INTO market_quote_cache
           (symbol, source, code, market, name, price, change_pct, quote_time)
         VALUES ${values.join(',')}
         ON CONFLICT (symbol, source) DO UPDATE SET
           price=EXCLUDED.price, change_pct=EXCLUDED.change_pct,
           quote_time=EXCLUDED.quote_time, fetched_at=now()`,
      params,
    );
  }
}

module.exports = {
  saveDailyQuoteCache,
  loadInstrumentCache,
  saveInstrumentCache,
  select_market_quote_cache,
};

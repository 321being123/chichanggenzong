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

module.exports = {
  loadInstrumentCache,
  saveInstrumentCache,
};

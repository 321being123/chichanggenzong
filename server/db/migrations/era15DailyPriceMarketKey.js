// 日价主键补市场维度：同一账户可能在同一天同时持有 6 位 A 股与补零同形的港股，
// 旧主键 (username, account_name, date, code) 会把两只证券的日价写成同一行（后写覆盖先写），
// 于是“取价按市场分开”也就失去了存储基础。
//
// 处理方式：
// ① 把未知市场统一写成 'UNKNOWN'（不再用 NULL，便于参与唯一约束）；
// ② 主键扩为 (username, account_name, date, market, code)；
// ③ market 默认 'UNKNOWN' 且非空，写入必须显式给出（由仓储按可核实身份判定）。
async function migration199DailyPriceMarketKey(pool) {
  await pool.query(`UPDATE daily_prices SET market = 'UNKNOWN' WHERE market IS NULL;`);
  await pool.query(`ALTER TABLE daily_prices ALTER COLUMN market SET DEFAULT 'UNKNOWN';`);
  await pool.query(`ALTER TABLE daily_prices ALTER COLUMN market SET NOT NULL;`);
  await pool.query(`ALTER TABLE daily_prices DROP CONSTRAINT IF EXISTS daily_prices_pkey;`);
  await pool.query(`
    ALTER TABLE daily_prices
      ADD CONSTRAINT daily_prices_pkey PRIMARY KEY (username, account_name, date, market, code);
  `);
}

module.exports = { migration199DailyPriceMarketKey };

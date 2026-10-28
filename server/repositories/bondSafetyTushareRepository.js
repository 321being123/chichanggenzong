const { pool } = require('../db/connection');

// 自 server/services/bondSafetyTushare.js 迁入的数据读写函数（只做标准事实读写，业务判定仍留在服务层）。

async function loadFinancialCache() {
  const { rows } = await pool.query('SELECT ts_code, stock_name, data, fetched_at FROM bond_safety_financial_cache');
  return new Map(rows.map(row => [row.ts_code, {
    stock_name: row.stock_name,
    data: row.data || {},
    fetched_at: new Date(row.fetched_at).getTime(),
  }]));
}

async function saveFinancialCache(tsCode, stockName, data) {
  await pool.query(
    `INSERT INTO bond_safety_financial_cache
       (ts_code, stock_name, report_end_date, announced_at, data)
     VALUES ($1,$2,$3,$4,$5::jsonb)
     ON CONFLICT (ts_code) DO UPDATE SET stock_name=EXCLUDED.stock_name,
       report_end_date=EXCLUDED.report_end_date, announced_at=EXCLUDED.announced_at,
       data=EXCLUDED.data, fetched_at=now()`,
    [tsCode, stockName || '', data.report_end_date, data.announced_at, JSON.stringify(data)]
  );
}

// 按证券代码读取发行方式，供服务层排除非公开发行标的
async function loadIssuanceTypes(codes, client = pool) {
  const result = await client.query(`
    SELECT i.canonical_code, v.issue_type
      FROM core.instruments i
      JOIN fundamental.convertible_bond_issuance v ON v.instrument_id=i.instrument_id
     WHERE i.canonical_code = ANY($1::text[])
  `, [codes]);
  return result.rows;
}

module.exports = {
  loadFinancialCache,
  loadIssuanceTypes,
  saveFinancialCache,
};

// ====== 股票统一数据服务 ======
// 标准模式（与 bondDataService 一致）：
//   1. checkStockData(code) → 查 stock_unified，判断数据是否完整
//   2. 完整 → 直接用；缺字段 → 补缺；不存在 → 全量写入
//
// 关键：market.js 的 saveInstrumentCache 是唯一写入入口。
// 其他模块通过本服务读取，不再各自调 Tushare stock_basic/daily_basic。
const { pool } = require('../db');

// 查单只股票在 stock_unified 中的数据完整性
async function getStockInfo(code) {
  const cleanCode = code.includes('.') ? code : null;
  if (cleanCode) {
    const { rows } = await pool.query(
      'SELECT * FROM public.stock_unified WHERE stock_code = $1', [cleanCode]
    );
    if (rows.length) return rows[0];
  }
  // 兜底：前缀匹配
  const { rows: r2 } = await pool.query(
    "SELECT * FROM public.stock_unified WHERE stock_code LIKE $1", [code + '.%']
  );
  return r2[0] || null;
}

// 全量股票列表
async function getStockList(filters = {}) {
  const where = ["status = 'listed'"];
  const params = [];
  let pi = 1;
  if (filters.search) {
    where.push(`(stock_code ILIKE $${pi} OR stock_name ILIKE $${pi})`);
    params.push('%' + filters.search + '%'); pi++;
  }
  if (filters.market) {
    where.push(`market = $${pi}`); params.push(filters.market); pi++;
  }
  const { rows } = await pool.query(
    `SELECT * FROM public.stock_unified WHERE ${where.join(' AND ')} ORDER BY stock_code`,
    params
  );
  return rows;
}

// 获取最新估值数据（PE/PB/市值），marketVolatilitySync 等模块用
async function getLatestValuations(codes) {
  if (!codes || !codes.length) return [];
  const { rows } = await pool.query(
    `SELECT stock_code, stock_name, pe_ttm, pb, total_market_cap, circulating_market_cap, last_valuation_date
     FROM public.stock_unified WHERE stock_code = ANY($1)`,
    [codes]
  );
  return rows;
}

// 全市场总市值汇总（marketVolatilitySync 用）
async function getTotalMarketCap() {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(total_market_cap), 0) AS total_cap,
            COUNT(*) AS stock_count
     FROM public.stock_unified WHERE status = 'listed' AND total_market_cap > 0`
  );
  return rows[0] || { total_cap: 0, stock_count: 0 };
}

module.exports = {
  getStockInfo,
  getStockList,
  getLatestValuations,
  getTotalMarketCap,
};

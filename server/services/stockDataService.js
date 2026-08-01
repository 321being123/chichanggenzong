// ====== 股票统一数据服务 ======
// 统一读取层：从标准估值表 market.daily_valuations 聚合读取股票数据。
//
// 当前真实调用方：
//   - getTotalMarketCap(tradeDate)：marketVolatilitySync 按目标交易日聚合全市场总市值。
// 其余函数（getStockInfo / getStockList / getLatestValuations）为预留标准接口，
// 供后续模块迁移接入统一层时使用，暂未有模块调用。
//
// 写入入口（注意：本服务只读，不负责写入）：
//   - 标准估值：financialDataArchitecture.js（个股分析落库）与
//     convertibleBondAnalysis.js 的 saveFullStockMarketPartition（可转债正股行情同步）。
//
// ⚠️ stock_unified 视图 = core.instruments + 每只股票"自身最新一条估值"，
//    只适合单券最新数据展示，不能用于跨日期全市场聚合；全市场聚合必须走
//    getTotalMarketCap(tradeDate) 按目标交易日读取完整分区。
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

// 全量股票列表（预留接口：当前无模块调用）
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

// 获取单只股票最新估值（预留接口：当前无模块调用）
async function getLatestValuations(codes) {
  if (!codes || !codes.length) return [];
  const { rows } = await pool.query(
    `SELECT stock_code, stock_name, pe_ttm, pb, total_market_cap, circulating_market_cap, last_valuation_date
     FROM public.stock_unified WHERE stock_code = ANY($1)`,
    [codes]
  );
  return rows;
}

// 指定交易日全市场总市值（marketVolatilitySync 用）
// 只聚合该 tradeDate 的完整分区，杜绝"每只证券最新值"造成的混合截面。
// 返回 total_cap 单位：元（与 market.daily_valuations.total_market_cap 一致）。
async function getTotalMarketCap(tradeDate) {
  if (!tradeDate) return { total_cap: 0, stock_count: 0 };
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(dv.total_market_cap), 0)::double precision AS total_cap,
            COUNT(*)::int AS stock_count
     FROM market.daily_valuations dv
     JOIN core.instruments i ON i.instrument_id = dv.instrument_id
     WHERE i.asset_class = 'stock' AND dv.trade_date = $1 AND dv.total_market_cap > 0`,
    [tradeDate]
  );
  return rows[0] || { total_cap: 0, stock_count: 0 };
}

module.exports = {
  getStockInfo,
  getStockList,
  getLatestValuations,
  getTotalMarketCap,
};

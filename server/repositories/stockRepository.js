// 股票标准读取仓储（批次1，从 stockDataService 迁入的 SQL）。
// 合同：方法签名 method(params, tx)；tx 缺省时使用连接池（只读查询）。
// 只读 market/core 标准层，不触发外采、不写任何表。
const { pool } = require('../db');

// 单只股票在 stock_unified 中的完整性数据：先精确匹配，再前缀兜底。
async function findStockInfo(params = {}, tx) {
  const runner = tx || pool;
  const code = params.code;
  const cleanCode = String(code || '').includes('.') ? code : null;
  if (cleanCode) {
    const { rows } = await runner.query('SELECT * FROM public.stock_unified WHERE stock_code = $1', [cleanCode]);
    if (rows.length) return rows[0];
  }
  const { rows } = await runner.query('SELECT * FROM public.stock_unified WHERE stock_code LIKE $1', [code + '.%']);
  return rows[0] || null;
}

// 全量股票列表
async function listStocks(params = {}, tx) {
  const runner = tx || pool;
  const filters = params.filters || {};
  const where = ["status = 'listed'"];
  const binds = [];
  let pi = 1;
  if (filters.search) {
    where.push(`(stock_code ILIKE $${pi} OR stock_name ILIKE $${pi})`);
    binds.push('%' + filters.search + '%'); pi++;
  }
  if (filters.market) {
    where.push(`market = $${pi}`); binds.push(filters.market); pi++;
  }
  const { rows } = await runner.query(
    `SELECT * FROM public.stock_unified WHERE ${where.join(' AND ')} ORDER BY stock_code`,
    binds,
  );
  return rows;
}

// 单只股票最新估值
async function listLatestValuations(params = {}, tx) {
  const runner = tx || pool;
  const codes = params.codes;
  if (!codes || !codes.length) return [];
  const { rows } = await runner.query(
    `SELECT stock_code, stock_name, pe_ttm, pb, total_market_cap, circulating_market_cap, last_valuation_date
     FROM public.stock_unified WHERE stock_code = ANY($1)`,
    [codes],
  );
  return rows;
}

// 指定交易日全市场总市值（只聚合该 tradeDate 的完整分区，杜绝混合截面）。
// 同一证券、同一交易日若存在多个来源，按 ops.data_sources.priority（数值小者优先）
// 只取一条，避免把两个来源当成两只证券相加；无多来源时结果与原聚合完全一致。
// 返回 total_cap 单位：元（与 market.daily_valuations.total_market_cap 一致）。
async function totalMarketCap(params = {}, tx) {
  const runner = tx || pool;
  const tradeDate = params.tradeDate;
  if (!tradeDate) return { total_cap: 0, stock_count: 0 };
  const { rows } = await runner.query(
    `WITH chosen AS (
       SELECT DISTINCT ON (dv.instrument_id)
              dv.instrument_id, dv.total_market_cap
         FROM market.daily_valuations dv
         JOIN core.instruments i ON i.instrument_id = dv.instrument_id
         LEFT JOIN ops.data_sources s ON s.source_id = dv.source_id
        WHERE i.asset_class = 'stock' AND dv.trade_date = $1 AND dv.total_market_cap > 0
        ORDER BY dv.instrument_id, s.priority ASC NULLS LAST, dv.source_id ASC
     )
     SELECT COALESCE(SUM(total_market_cap), 0)::double precision AS total_cap,
            COUNT(*)::int AS stock_count
       FROM chosen`,
    [tradeDate],
  );
  return rows[0] || { total_cap: 0, stock_count: 0 };
}

module.exports = {
  findStockInfo,
  listLatestValuations,
  listStocks,
  totalMarketCap,
};

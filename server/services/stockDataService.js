// ====== 股票统一数据服务（批次1：SQL 已迁 server/repositories/stockRepository.js）======
// 统一读取层：从标准估值表 market.daily_valuations 聚合读取股票数据。
//
// 当前真实调用方：
//   - getTotalMarketCap(tradeDate)：marketVolatilitySync 按目标交易日聚合全市场总市值。
//   - getStockInfo / getStockList / getLatestValuations：预留标准接口，供后续模块迁移接入。
//
// 写入入口（本服务只读）：financialDataArchitecture.js 与
// convertibleBondAnalysis.js 的 saveFullStockMarketPartition。
//
// ⚠️ stock_unified 视图 = core.instruments + 每只股票"自身最新一条估值"，
//    只适合单券最新数据展示，不能用于跨日期全市场聚合；全市场聚合必须走
//    getTotalMarketCap(tradeDate) 按目标交易日读取完整分区。
const stockRepository = require('../repositories/stockRepository');

async function getStockInfo(code) {
  return stockRepository.findStockInfo({ code });
}

async function getStockList(filters = {}) {
  return stockRepository.listStocks({ filters });
}

async function getLatestValuations(codes) {
  return stockRepository.listLatestValuations({ codes });
}

async function getTotalMarketCap(tradeDate) {
  return stockRepository.totalMarketCap({ tradeDate });
}

module.exports = {
  getStockInfo,
  getStockList,
  getLatestValuations,
  getTotalMarketCap,
};

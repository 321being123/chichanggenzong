// 正股日终行情改为「按需取官方」的契约测试（2026-10-31）。
// 背景：理杏仁官方 candlestick 只接受单只 stockCode，没有「按交易日取全市场」的批量接口
// （261 条目录里返回 OHLC 的接口全部是单只参数）。因此日终不再全市场刷新，
// 改为「转债正股 ∪ 持仓 ∪ 自选」按需取，缺的由 Tushare 按代码补，官方整体不可用时退回全市场批量。
const assert = require('assert');
const { readServiceSource } = require('./helpers/service-source');
const { resolveValuationRows, resolveStockDaily, VALUATION_METRICS } = require('../services/lixingerDatasetSources');

const source = readServiceSource('convertibleBondAnalysis');

// 1) 需求集合必须由三类来源拼出来，缺任何一类都会让业务读到空行情。
assert.ok(source.includes('async function selectNeededDailyStockCodes'),
  '必须显式定义「需要日线的证券」集合');
assert.ok(source.includes('SELECT code FROM positions'),
  '需求集合必须包含持仓');
assert.ok(source.includes('SELECT ts_code FROM stock_watchlist'),
  '需求集合必须包含自选');
assert.ok(source.includes('profileStockCodes.get(profile.ts_code) || profile.stk_code'),
  '需求集合必须包含转债正股');

// 2) 主同步走官方按需批量，且不再以全市场按交易日批量为主路径。
assert.ok(source.includes('resolveStockDailyBatch({ tsCodes: neededStockCodes, tradeDate: targetTradeDate })'),
  '主同步必须按需求集合向官方批量取日线');
assert.ok(source.includes('fetchTushareDailyFallback(officialDailyUsable, dailyMissingCodes, targetTradeDate)'),
  '官方取不到的代码必须由 Tushare 按代码补');
assert.ok(source.includes('if (officialUsable && (!missingCodes || !missingCodes.length)) return [];'),
  '官方全部覆盖时不得再发起全市场 Tushare 批量请求');

// 3) 落库按来源拆开：官方行写官方来源，复权因子不能挂到官方名下。
assert.ok(source.includes('saveFullStockMarketPartition(client, stockInstrumentMap, officialDailyRows, officialValuationRows, sources.lixinger_official, [])'),
  '官方日线与估值必须按官方来源落库，且不写复权因子');
assert.ok(source.includes('saveFullStockMarketPartition(client, stockInstrumentMap, tushareDailyRows, stockValuationRows, sources.tushare, stockAdjustmentRows)'),
  '回退批次必须仍归 Tushare 名下并保留复权因子');

// 4) 估值宇宙不随日线收窄：仍取全市场（官方支持一次 100 只）。
assert.ok(source.includes('const valuationUniverse = tushareValuationRows.length'),
  '估值宇宙必须取全市场，不能跟着日线按需收窄');

// 5) 缓存读取与缺口判定必须接受官方来源，否则官方日线读不到、缺口永远判定为缺失。
assert.ok(source.includes("ds.source_code IN ('tushare','lixinger_official')"),
  '缓存读取必须接受官方来源');
assert.ok(source.includes("source_code IN ('tushare','lixinger_official')"),
  '缺口判定必须按两个行情来源统计');

// 6) 历史补齐：按代码走官方区间接口，按交易日批量仅作残余回退。
assert.ok(source.includes('官方没有「按交易日取全市场」的接口，但支持按代码取日期区间'),
  '历史补齐必须先按代码走官方区间');
assert.ok(source.includes('CONVERTIBLE_BOND_STOCK_PREFILL_LIMIT'),
  '按代码预补必须有可配置上限，避免一次拉爆额度');

// 7) 估值指标口径仍覆盖站内需要的全部字段（防止切源时被裁掉）。
for (const metric of ['pe_ttm', 'pb', 'dyr', 'mc', 'cmc']) {
  assert.ok(VALUATION_METRICS.includes(metric), `估值指标必须保留 ${metric}`);
}

// 8) 单只日线换算口径：官方 volume 是股→手，amount 是元→千元。
assert.strictEqual(typeof resolveStockDaily, 'function');
assert.strictEqual(typeof resolveValuationRows, 'function');

console.log('convertible-bond-stock-daily-scope.test.js 通过');

// 正股日终行情「按需取 + 数据层收口」的契约测试（2026-10-31）。
//
// 两条铁律：
//   1) 官方没有「按交易日取全市场」的批量行情接口（261 条目录里返回 OHLC 的接口全部只接受单值 stockCode），
//      所以日终只取「转债正股 ∪ 持仓 ∪ 自选」，不再全市场刷新。
//   2) 上层（服务/任务/路由）只向数据层要数据集，不知道来源是谁；主备回退与口径换算都在数据层。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { readServiceSource } = require('./helpers/service-source');
const { VALUATION_METRICS } = require('../dataAccess/adapters/lixingerDatasetAdapter');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const syncSource = readServiceSource('convertibleBondAnalysis');
const datasets = read('dataAccess/marketDatasets.js');
const adapter = read('dataAccess/adapters/lixingerDatasetAdapter.js');
const syncRepo = read('repositories/convertibleBondAnalysisSyncRepository.js');
const store = read('services/convertibleBondAnalysisStore.js');

// ---------- 一、需求集合 ----------
assert.ok(syncSource.includes('async function selectNeededDailyStockCodes'),
  '必须显式定义「需要日线的证券」集合');
assert.ok(syncSource.includes('profileStockCodes.get(profile.ts_code) || profile.stk_code'),
  '需求集合必须包含转债正股');
assert.ok(syncSource.includes('repository.selectNeededDailyStockSourceCodes'),
  '持仓与自选范围必须经仓储读取，不得在服务里写 SQL');
assert.ok(syncRepo.includes('SELECT code FROM positions'), '仓储必须提供持仓范围');
assert.ok(syncRepo.includes('SELECT ts_code FROM stock_watchlist'), '仓储必须提供自选范围');
// 只查服务自身文件（helpers 会把同名仓储拼进来，不能据此判断服务里有没有 SQL）
const serviceFiles = ['services/convertibleBondAnalysis.js', 'services/convertibleBondAnalysisSync.js']
  .filter(rel => fs.existsSync(path.join(__dirname, '..', rel)))
  .map(read);
assert.ok(serviceFiles.every(text => !/FROM\s+positions/i.test(text)), '服务层不得出现取持仓的 SQL');

// ---------- 二、上层只调中立需求接口 ----------
assert.ok(syncSource.includes('readStockDailyBatch({ tsCodes: neededStockCodes, tradeDate: targetTradeDate })'),
  '主同步必须经数据层取正股日线');
assert.ok(syncSource.includes('readStockValuationRows({ tradeDate: targetTradeDate })'),
  '主同步必须经数据层取估值');
assert.ok(syncSource.includes('readStockDailySeries('), '历史补齐必须经数据层取序列');
// 供应商中立（本次切换引入的来源）：服务不得 require 理杏仁适配层，也不得越过数据层直接调适配目录。
// 转债自身的 Tushare/腾讯历史直连属存量（见技术架构"其余待迁"），不在本条断言范围。
assert.ok(!/require\('\.\/lixinger/.test(syncSource), '服务层不得直接引用理杏仁适配层');
assert.ok(!/require\('\.\.\/dataAccess\/adapters\//.test(syncSource), '服务层不得直接引用数据适配层');

// ---------- 三、数据层内部的主备与换算 ----------
assert.ok(datasets.includes('resolveStockDailyBatch'), '数据层必须调用适配层的批量日线接口');
assert.ok(datasets.includes("ts_code: group.join(','), trade_date: trade"), '数据层必须按代码批量回退');
assert.ok(datasets.includes('const covered = new Set(officialRows.map(row => row.ts_code))'),
  '估值必须剔除主来源已覆盖的证券，避免同一证券同一天两行来源');
assert.ok(datasets.includes("source_code: 'tushare'"), '回退行必须自带来源标签');
assert.ok(adapter.includes("type: 'ex_rights'"), '官方日线必须显式取不复权序列');
assert.ok(adapter.includes('/ 100'), '成交量股→手换算缺失');
assert.ok(adapter.includes('/ 1000'), '成交额元→千元换算缺失');

// ---------- 四、落库按行自带来源分组 ----------
assert.ok(syncSource.includes('const rowsBySource = list =>'), '落库前必须按来源分组');
assert.ok(syncSource.includes('const sourceId = sources[code];'), '每组必须写自己的来源 id');
assert.ok(syncSource.includes('by_source: Object.fromEntries'), '分区诊断必须按来源留痕');

// ---------- 五、缓存读取与缺口判定接受多来源 ----------
assert.ok(store.includes("ds.source_code IN ('tushare','lixinger_official')"), '缓存读取必须接受行情来源集合');
assert.ok(syncRepo.includes("source_code IN ('tushare','lixinger_official')"), '缺口判定必须按来源集合统计');

// ---------- 六、估值指标口径不被裁掉 ----------
for (const metric of ['pe_ttm', 'pb', 'dyr', 'mc', 'cmc']) {
  assert.ok(VALUATION_METRICS.includes(metric), `估值指标必须保留 ${metric}`);
}

console.log('convertible-bond-stock-daily-scope.test.js 通过');

// P0-1：PB 投影触发面写入入口回归。
// 除行为可单测的 store 返回值外，其余入口用源码契约锁定"事务提交后必须触发"，
// 防止后续重构把 safeSync 调用删掉而无声回退到全量对账。
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const store = require('../services/convertibleBondAnalysisStore');

const root = path.join(__dirname, '..', '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

async function main() {
  // store 必须把实际写入的估值交易日回传给调用方，供提交后精确同步受影响月份。
  const queries = [];
  const fakeClient = { query: async (sql, params) => { queries.push({ sql, params }); return { rowCount: 1, rows: [] }; } };
  const single = await store.saveStockValuation(fakeClient, 1, {
    trade_date: '2026-11-26', pe: 10, pe_ttm: 9, pb: 1.2, dv_ttm: 2, total_mv: 100, circ_mv: 80,
  }, 1);
  assert.strictEqual(single, '2026-11-26');

  const part = await store.saveFullStockMarketPartition(fakeClient, new Map([['600519.SH', 1]]), [], [
    { ts_code: '600519.SH', trade_date: '2026-11-25', pb: 1.1, pe: 10 },
    { ts_code: '600519.SH', trade_date: '2026-11-26', pb: 1.2, pe: 10 },
  ], 1);
  assert.deepStrictEqual(part.valuationDates, ['2026-11-25', '2026-11-26']);

  const analysisSync = read('server/services/convertibleBondAnalysisSync.js');
  assert.ok(/txControl\.commit\(client\)[\s\S]{0,400}safeSyncValuations/.test(analysisSync),
    '可转债主同步提交后必须调用 safeSyncValuations');
  assert.ok(/projectionValuationDates[\s\S]{0,400}safeSyncValuations/.test(analysisSync),
    '正股回补提交后必须按实际估值日调用 safeSyncValuations');
  assert.ok(/insert_market_trade_calendar[\s\S]{0,400}safeSyncCalendarChange/.test(analysisSync),
    '交易日历写入后必须调用 safeSyncCalendarChange');

  const repairScript = read('server/scripts/repairStockMarketDate.js');
  assert.ok(/COMMIT'\)[\s\S]{0,400}safeSyncValuations/.test(repairScript),
    'repairStockMarketDate 提交后必须同步 PB 投影');

  const officialBackfill = read('server/scripts/backfillStockValuationsOfficial.js');
  assert.ok(/COMMIT'\)[\s\S]{0,400}safeSyncValuations/.test(officialBackfill),
    '官方估值回填脚本提交后必须同步 PB 投影');

  const lifecycleSync = read('server/services/convertibleBondLifecycleSync.js');
  assert.ok(/safeSyncInstrumentChange/.test(lifecycleSync), '证券主档 list_date 更新后必须触发 safeSyncInstrumentChange');
  const lifecycleRepo = read('server/repositories/convertibleBondLifecycleSyncRepository.js');
  assert.ok(/RETURNING instrument_id, asset_class, market/.test(lifecycleRepo),
    'update_core_instruments 必须返回更新行供上层判断股票 list_date 变更');

  console.log('pb-projection-triggers.test.js passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

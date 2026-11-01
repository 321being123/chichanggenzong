// 数据层「数值与来源标签一致」验收（隔离样本，不连数据库、不发真实请求）。
//
// 覆盖 2026-10-31 复核提出的两个问题：
//   1. 估值历史只改来源标签、数值仍来自 Tushare（隔离样本：官方 PE=99 / Tushare PE=10）；
//   2. 历史收盘（净值回补入口）固定走 Tushare，没有接入官方优先的正股日线。
// 上游一律用假传输：Tushare 模块整体替换，理杏仁适配层只替换需要构造样本的函数，
// 静态市盈率派生用真实实现（fillStaticPe），确保断言落在真实换算逻辑上。
process.env.NODE_ENV = 'test';

const assert = require('assert');

// ---------- 一、假 Tushare 传输 ----------
const tushareCalls = [];
const TUSHARE_ROWS = {
  daily_basic: [
    { ts_code: '600519.SH', trade_date: '20261029', close: 5, pe: 10, pe_ttm: 10, pb: 1, dv_ttm: 1, total_share: 1, float_share: 1, free_share: 1, total_mv: 100, circ_mv: 100 },
    { ts_code: '600519.SH', trade_date: '20261030', close: 6, pe: 10, pe_ttm: 10, pb: 1, dv_ttm: 1, total_share: 1, float_share: 1, free_share: 1, total_mv: 100, circ_mv: 100 },
    { ts_code: '600519.SH', trade_date: '20261102', close: 7, pe: 10, pe_ttm: 10, pb: 1, dv_ttm: 1, total_share: 1, float_share: 1, free_share: 1, total_mv: 100, circ_mv: 100 },
  ],
  daily: [
    { ts_code: '600519.SH', trade_date: '20261029', open: 10, high: 10, low: 10, close: 10.5, vol: 1, amount: 1 },
    { ts_code: '600519.SH', trade_date: '20261030', open: 10, high: 10, low: 10, close: 10.6, vol: 1, amount: 1 },
  ],
  cb_daily: [
    { ts_code: '113050.SH', trade_date: '20261029', close: 118.8 },
  ],
};

function tsTable(fields, rows) {
  const list = String(fields || 'trade_date').split(',');
  return { fields: list, items: rows.map(row => list.map(field => (row[field] === undefined ? null : row[field]))) };
}

// 备源故障开关：复核样本「官方六项齐全、Tushare 凭据失效」用它复现。
let tushareFailure = null;
const tushareStub = {
  tushareQuery: async (apiName, params, fields) => {
    tushareCalls.push({ apiName, params });
    if (tushareFailure) throw tushareFailure;
    const rows = TUSHARE_ROWS[apiName] || [];
    return tsTable(fields || 'trade_date', rows);
  },
  TushareRequestError: class TushareRequestError extends Error {},
  supportsTushareApi: () => true,
  ACCOUNT_POINTS: {},
  ENDPOINT_MIN_POINTS: {},
};
const tusharePath = require.resolve('../services/tushare');
require.cache[tusharePath] = { id: tusharePath, filename: tusharePath, loaded: true, exports: tushareStub };

const adapter = require('../dataAccess/adapters/lixingerDatasetAdapter');
const datasets = require('../dataAccess/marketDatasets');

// ---------- 二、假官方传输（只替换构造样本的函数） ----------
const OFFICIAL = adapter.SOURCE;
// 官方这一天：滚动市盈率 99、市净率 9、股息率 0.09、总市值 1,740,176,092,672.05 元
const OFFICIAL_VALUATION = [
  { ts_code: '600519.SH', trade_date: '20261029', pe: null, pe_ttm: 99, pb: 9, dv_ttm: 9, total_mv: 174017609.267205, circ_mv: 170000000, source_code: OFFICIAL },
  { ts_code: '600519.SH', trade_date: '20261030', pe: null, pe_ttm: 98, pb: 8, dv_ttm: 8, total_mv: 174017609.267205, circ_mv: 170000000, source_code: OFFICIAL },
  // 备源没有这一天：官方有数据就必须给出来
  { ts_code: '600519.SH', trade_date: '20261031', pe: null, pe_ttm: 97, pb: 7, dv_ttm: 7, total_mv: 174017609.267205, circ_mv: 170000000, source_code: OFFICIAL },
  // 官方这一天没有滚动市盈率（缺项），备源有值 → 必须按字段标出「carried」
  { ts_code: '600519.SH', trade_date: '20261102', pe: null, pe_ttm: null, pb: 6, dv_ttm: 6, total_mv: 174017609.267205, circ_mv: 170000000, source_code: OFFICIAL },
];
let officialValuationCalled = 0;
// R2-001 后估值历史走详细结果入口：给出 rows 与"计划段全部成功"的完整性信息，
// 断言仍是"数值必须来自官方"，不只是换标签。
adapter.resolveValuationSeriesDetailed = async () => {
  officialValuationCalled += 1;
  return {
    rows: OFFICIAL_VALUATION, planned: 1, attempted: 1, succeeded: 1, failed: 0,
    notAttempted: 0, emptyBatches: 0, complete: true, failures: [], scope: { kind: 'series' },
  };
};
adapter.resolveAnnualNetProfits = async () => ([
  { periodEnd: '20241231', announcedAt: '20250425', reportType: 'annual_report', netProfit: 80000000000 },
  { periodEnd: '20251231', announcedAt: '20260417', reportType: 'annual_report', netProfit: 82320067102 },
]);

(async () => {
  // ---------- 三、估值历史：数值必须来自官方 ----------
  const history = await datasets.readStockValuationHistory({
    tsCode: '600519.SH', startDate: '2026-10-29', endDate: '2026-11-02',
    // 与 stockAnalysis 实际传入的字段一致：估值六项 + 收盘价 + 股本
    fields: 'ts_code,trade_date,close,pe,pe_ttm,pb,dv_ttm,total_share,float_share,free_share,total_mv,circ_mv',
  });
  const byDate = new Map(history.map(row => [String(row.trade_date), row]));

  assert.ok(officialValuationCalled >= 1, '估值历史必须走官方的区间入口');
  assert.deepStrictEqual(history.map(row => String(row.trade_date)), ['20261029', '20261030', '20261031', '20261102'],
    '返回必须按日期升序且包含官方独有的交易日');

  const d29 = byDate.get('20261029');
  assert.strictEqual(Number(d29.pe_ttm), 99, '官方覆盖的日期，滚动市盈率必须取官方 99，不能是备源 10');
  assert.strictEqual(Number(d29.pb), 9, '官方覆盖的日期，市净率必须取官方 9，不能是备源 1');
  assert.strictEqual(Number(d29.dv_ttm), 9, '官方覆盖的日期，股息率必须取官方');
  assert.strictEqual(Number(d29.total_mv), 174017609.267205, '官方覆盖的日期，总市值必须取官方（万元口径）');
  assert.strictEqual(d29.source_code, OFFICIAL, '官方覆盖的日期，行来源必须是官方');
  assert.strictEqual(d29.share_source_code, 'tushare', '股本字段来自备源，必须单独标出来源');
  assert.strictEqual(Number(d29.close), 5, '收盘价仍取备源骨架（官方估值接口不提供）');
  assert.strictEqual(Number(d29.total_share), 1, '股本仍取备源骨架');
  // 静态市盈率：官方市值 1,740,176,092,672.05 ÷ 2025 年报归母 82,320,067,102 = 21.1391（与 Tushare 静 PE 同口径）
  assert.ok(Math.abs(Number(d29.pe) - 21.1391) < 0.001, `静态市盈率必须按官方输入派生，实际 ${d29.pe}`);
  assert.strictEqual(d29.carried_fields, undefined, '官方六项齐备时不应出现 carried_fields');

  assert.strictEqual(Number(byDate.get('20261030').pe_ttm), 98, '第二天的官方数值同理会生效');

  const d31 = byDate.get('20261031');
  assert.strictEqual(d31.source_code, OFFICIAL, '备源没有的交易日也要返回官方行');
  assert.strictEqual(Number(d31.pe_ttm), 97);
  assert.strictEqual(d31.close, null, '备源没有的日期，收盘价为空而不是补一个假数');

  const d02 = byDate.get('20261102');
  assert.strictEqual(Number(d02.pb), 6, '官方有值的字段仍取官方');
  assert.strictEqual(Number(d02.pe_ttm), 10, '官方缺项时保留备源数值');
  assert.deepStrictEqual(d02.carried_fields, ['pe_ttm'], '沿用备源的字段必须显式标出，不允许静默混源');

  // ---------- 三之二、备源故障不得拖垮主来源 ----------
  // 复核样本：官方六项齐全、Tushare 凭据失效 → 官方数据照常返回，备源负责的字段明确标缺失。
  tushareFailure = Object.assign(new Error('Tushare 凭据失效'), { code: 'AUTH_ERROR' });
  const degraded = await datasets.readStockValuationHistory({
    tsCode: '600519.SH', startDate: '2026-10-29', endDate: '2026-11-02',
    fields: 'ts_code,trade_date,close,pe,pe_ttm,pb,dv_ttm,total_share,float_share,free_share,total_mv,circ_mv',
  });
  tushareFailure = null;
  assert.strictEqual(degraded.length, 4, '备源故障时官方覆盖的 4 个交易日必须照常返回');
  const g29 = degraded.find(row => String(row.trade_date) === '20261029');
  assert.strictEqual(Number(g29.pe_ttm), 99, '官方数值不受备源故障影响');
  assert.strictEqual(g29.source_code, 'lixinger_official', '来源仍标官方');
  assert.strictEqual(g29.close, null, '备源故障时收盘价为空，不补假数');
  assert.strictEqual(g29.share_source_code, null, '没有股本数据就不声称股本来源');
  assert.deepStrictEqual(g29.missing_fields, ['close', 'total_share', 'float_share', 'free_share'], '备源负责的字段要明确标缺失');
  assert.strictEqual(g29.backup_unavailable, true, '要能区分「备源整体不可用」和「这天备源没有数据」');

  // ---------- 四、历史收盘（净值回补入口）：正股走官方优先 ----------
  adapter.resolveStockDaily = async () => ([
    { ts_code: '600519.SH', trade_date: '20261029', open: 11, high: 11.5, low: 10.9, close: 11.11, vol: 1, amount: 1, source_code: OFFICIAL },
    { ts_code: '600519.SH', trade_date: '20261030', open: 11, high: 12, low: 11, close: 12.22, vol: 1, amount: 1, source_code: OFFICIAL },
  ]);
  tushareCalls.length = 0;
  const stockClose = await datasets.readHistoricalCloseSeries({ tsCode: '600519.SH', kind: 'stock', startDate: '2026-10-29', endDate: '2026-10-30' });
  assert.deepStrictEqual(stockClose.map(row => [row.trade_date, Number(row.close), row.source_code]),
    [['20261029', 11.11, OFFICIAL], ['20261030', 12.22, OFFICIAL]], '正股历史收盘必须取官方数值并标官方来源');
  assert.ok(!tushareCalls.some(call => call.apiName === 'daily'), '官方有数据时不应再调 Tushare 日线');

  // 官方没覆盖：回退备源，来源标回 tushare
  adapter.resolveStockDaily = async () => null;
  const fallbackClose = await datasets.readHistoricalCloseSeries({ tsCode: '600519.SH', kind: 'stock', startDate: '2026-10-29', endDate: '2026-10-30' });
  assert.deepStrictEqual(fallbackClose.map(row => [row.trade_date, Number(row.close), row.source_code]),
    [['20261029', 10.5, 'tushare'], ['20261030', 10.6, 'tushare']], '官方不可用时应回退备源并标回备源来源');

  // 指数：与页面指数线同一入口
  adapter.resolveIndexDaily = async () => ([{ date: '2026-10-30', close: 3985.5 }]);
  const indexClose = await datasets.readHistoricalCloseSeries({ tsCode: '000300.SH', kind: 'index', startDate: '2026-10-30', endDate: '2026-10-30' });
  assert.deepStrictEqual(indexClose.map(row => [row.trade_date, Number(row.close), row.source_code]),
    [['20261030', 3985.5, OFFICIAL]], '指数历史收盘也必须走官方优先');

  // 债券（可转债个券）：官方目录无接口，仍是单一来源，来源标 tushare
  const bondClose = await datasets.readHistoricalCloseSeries({ tsCode: '113050.SH', kind: 'bond', startDate: '2026-10-29', endDate: '2026-10-29' });
  assert.deepStrictEqual(bondClose.map(row => [row.trade_date, Number(row.close), row.source_code]),
    [['20261029', 118.8, 'tushare']], '可转债个券官方无接口，保持单一来源');

  console.log('data-layer-source-truth：估值历史数值与来源一致、历史收盘走官方优先，全部通过');
})().catch(error => {
  console.error(String(error && error.stack ? error.stack : error));
  process.exit(1);
});

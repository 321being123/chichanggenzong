// 全市场 PE「只认理杏仁」的不变式，覆盖数据层回退路径（复核样本：官方返空、Tushare 返回 77）。
//
// 关键点：本用例**不替换数据层入口**，而是替换最底层的两个来源（官方适配器返回空、Tushare 返回 PE=77），
// 让真实的 `readIndexValuationSeries` 回退逻辑跑起来——这正是上一版专项用例漏掉的那段。
// 期望：同步任务失败、一条都不写；绝不允许把 Tushare 的 77 按「理杏仁」名义落库。
process.env.NODE_ENV = 'test';

const assert = require('assert');

const stub = (relativePath, exports) => {
  const resolved = require.resolve(relativePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

// ---- 底层来源一：Tushare index_dailybasic（回退源），pe_ttm = 77 ----
const tushareCalls = [];
stub('../services/tushare', {
  tushareQuery: async (apiName, params, fields) => {
    tushareCalls.push({ apiName, params });
    if (apiName !== 'index_dailybasic') return { fields: [], items: [] };
    const list = String(fields || 'trade_date').split(',');
    // 数据层请求的字段顺序：ts_code,trade_date,total_mv,pe_ttm,pb
    const row = { ts_code: '000985.SH', trade_date: '20261030', total_mv: 100, pe_ttm: 77, pb: 1.5 };
    return { fields: list, items: [list.map(field => (row[field] === undefined ? null : row[field]))] };
  },
  TushareRequestError: class TushareRequestError extends Error {},
  supportsTushareApi: () => true,
  ACCOUNT_POINTS: {},
  ENDPOINT_MIN_POINTS: {},
});

// ---- 底层来源二：中证官网（CPI），本链路不该被调用 ----
let csindexCalls = 0;
stub('../services/marketVolatilitySource', {
  fetchCsiPe: async () => { csindexCalls += 1; return { success: true, data: [] }; },
  fetchChinaYield: async () => ({}),
  fetchHsiPe: async () => Buffer.from(''),
});

// ---- 仓储：记录写入，不落库 ----
const saved = [];
stub('../repositories/marketYieldRepository', {
  readCsiWatermark: async () => ({ rows: [{ mx: null }] }),
  saveCsiValuations: async (benchmark, kept, sourceCode) => { saved.push({ benchmark, count: kept.length, sourceCode, first: kept[0] }); },
});

// ---- 官方适配器：模拟「理杏仁返空」 ----
const adapter = require('../dataAccess/adapters/lixingerDatasetAdapter');
adapter.resolveIndexValuation = async () => [];

const datasets = require('../dataAccess/marketDatasets');
const job = require('../jobs/marketVolatilitySync');

(async () => {
  // 一、数据层默认允许回退——证明这个回退确实存在（也就是误标的来源）
  const fallbackRows = await datasets.readIndexValuationSeries({ indexCode: '000985', startDate: '2026-10-30', endDate: '2026-10-30' });
  assert.strictEqual(fallbackRows.length, 1, '默认应回退到 Tushare');
  assert.strictEqual(Number(fallbackRows[0].pe), 77, '回退拿到的是 Tushare 的 77');
  assert.strictEqual(fallbackRows[0].source_code, 'tushare_index_dailybasic', '回退行必须标 Tushare 来源');

  // 二、allowFallback=false 时不许换源：直接返回空
  const callsBefore = tushareCalls.length;
  const strictRows = await datasets.readIndexValuationSeries({ indexCode: '000985', startDate: '2026-10-30', endDate: '2026-10-30', allowFallback: false });
  assert.deepStrictEqual(strictRows, [], '关闭回退后官方没有数据就返回空');
  assert.strictEqual(tushareCalls.length, callsBefore, '关闭回退后不得再请求 Tushare');

  // 三、复核样本：官方返空 + Tushare=77 → 同步任务必须失败，且一条不写
  saved.length = 0;
  await assert.rejects(
    () => job.syncCsiIndexPe('CSIALL', '000985'),
    /官方口径本次无数据写入/,
    '官方取不到数据时任务必须失败'
  );
  assert.deepStrictEqual(saved, [], '失败时不得写入任何行（尤其不能把 Tushare 的 77 写成官方）');
  assert.strictEqual(csindexCalls, 0, '也不得回落到中证官网');

  console.log('csi-all-no-fallback：官方返空时任务失败、Tushare 的 77 不会被写成理杏仁');
  await require('../db/connection').pool.end().catch(() => {});
  process.exit(0);
})().catch(error => {
  console.error(String(error && error.stack ? error.stack : error));
  process.exit(1);
});

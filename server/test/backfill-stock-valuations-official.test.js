// 全市场逐只估值回填（官方口径）的不变式：
//   1. 回填只补「现有分区已有 (证券, 交易日)」，不新增日期分区（新增日期会改下游口径）；
//   2. 只回官方、官方失败不得回落 Tushare（否则会把别家数值写成官方）；
//   3. 已有官方行跳过、不删旧行。
// 数据层入口用替代适配器验证（不连外部），脚本约束用静态断言钉住。
process.env.NODE_ENV = 'test';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const stub = (relativePath, exports) => {
  const resolved = require.resolve(relativePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

let seriesCalls = 0;
let tushareCalls = 0;
let mode = 'ok';

// 官方适配器：正常返回一行 Tushare 形状（total_mv 万元、dv_ttm 百分数点）
stub('../dataAccess/adapters/lixingerDatasetAdapter', {
  SOURCE: 'lixinger_official',
  resolveValuationSeries: async ({ codes, startDate, endDate }) => {
    seriesCalls += 1;
    if (mode === 'throw') throw new Error('官方 403 时间跨度不能超过10年');
    return [{
      ts_code: codes[0], trade_date: '2026-10-28',
      pe: null, pe_ttm: 12.5, pb: 1.2, dv_ttm: 3.5, total_mv: 123456, circ_mv: 100000,
    }];
  },
  resolveValuationRows: async () => [],
  resolveIndexValuation: async () => [],
  resolveStockDaily: async () => [],
  resolveAnnualNetProfits: async () => [],
  resolveSovereignYield10y: async () => [],
  resolveMoneySupply: async () => [],
  fillStaticPe: rows => rows,
});

// 备源：一旦被调用就说明发生了不该有的回退
stub('../services/tushare', {
  tushareQuery: async () => { tushareCalls += 1; return { fields: [], items: [] }; },
  TushareRequestError: class TushareRequestError extends Error {},
  supportsTushareApi: () => true,
  ACCOUNT_POINTS: {},
  ENDPOINT_MIN_POINTS: {},
});

stub('../services/marketVolatilitySource', { fetchChinaYield: async () => ({}), fetchCsiPe: async () => ({}), fetchHsiPe: async () => Buffer.from('') });
stub('../services/tencentQuote', { requestTencentHkKline: async () => ({}) });
stub('../services/externalCallGuard', { withExternalCallGuard: (source, dataset, date, fn) => fn() });

const datasets = require('../dataAccess/marketDatasets');

(async () => {
  // 一、正常：返回官方行并标官方来源
  mode = 'ok';
  seriesCalls = 0;
  const rows = await datasets.readStockValuationSeriesBatch({
    codes: ['600519.SH', '000001.SZ'], startDate: '2026-10-01', endDate: '2026-10-30',
  });
  assert.strictEqual(seriesCalls, 1, '应按批次调用一次官方区间接口');
  assert.strictEqual(rows.length, 1, '应返回官方行');
  assert.strictEqual(rows[0].source_code, 'lixinger_official', '返回行必须标官方来源');
  assert.strictEqual(Number(rows[0].total_mv), 123456, '总市值保持万元口径，由写入方换算');

  // 二、官方失败：返回空数组且绝不回落 Tushare
  mode = 'throw';
  tushareCalls = 0;
  const failed = await datasets.readStockValuationSeriesBatch({
    codes: ['600519.SH'], startDate: '2026-10-01', endDate: '2026-10-30',
  });
  assert.deepStrictEqual(failed, [], '官方失败时返回空数组，不能假装有数据');
  assert.strictEqual(tushareCalls, 0, '回填链路不得回退 Tushare（否则会把别家数值标成官方）');

  // 三、参数缺失时不发请求
  seriesCalls = 0;
  assert.deepStrictEqual(await datasets.readStockValuationSeriesBatch({ codes: [] }), [], '无代码不发请求');
  assert.strictEqual(seriesCalls, 0, '无代码时不应调用官方接口');

  // 四、脚本约束（静态）：只写现有分区、不新增日期、不回落备源、空批次不算成功
  const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'backfillStockValuationsOfficial.js'), 'utf8');
  assert.ok(/targets\.has\(key\(instrumentId, day\)\)/.test(script), '必须只写入现有分区已有的 (证券, 交易日)');
  assert.ok(/covered\.has\(key\(instrumentId, day\)\)/.test(script), '已有官方行要跳过，避免重复写');
  assert.ok(!/DELETE\s+FROM\s+market\.daily_valuations/i.test(script), '回填不得删除旧来源行');
  assert.ok(!/tushareQuery/.test(script), '脚本不得直接调 Tushare（回填只认官方）');
  assert.ok(/emptyBatches/.test(script) && /process\.exit\(2\)/.test(script), '官方返回 0 行必须当异常处理并返回非零退出码');
  // 官方适配层返回的 trade_date 是 YYYYMMDD，分区键是 YYYY-MM-DD；不归一化会「有数据但命中 0 行」。
  assert.ok(/replace\(\/-\/g, ''\)\.slice\(0, 8\)/.test(script) && /trade_date: day/.test(script),
    '官方 8 位日期必须先归一成 YYYY-MM-DD 再和分区键比对');

  console.log('backfill-stock-valuations-official：只回官方、不回落备源、只写现有分区，通过');
})().catch(error => {
  console.error(String(error && error.stack ? error.stack : error));
  process.exit(1);
});

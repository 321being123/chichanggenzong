// A股指数 PE（沪深300 / 中证全指）只认理杏仁官方来源，不允许掺中证官网另一种口径。
//
// 背景：中证官网是整体法（Σ总市值 ÷ Σ净利润），理杏仁是总市值加权平均，同一天差 −17.6%～+18.7%，
// 掺在一条序列里会让格雷厄姆指数失真。所以官方取不到数据时必须让任务失败，而不是回落写另一种口径。
// 2026-11-01 起沪深300 也按用户决定切到官方口径（此前只有 CSIALL 走官方、CSI300 仍走中证官网）。
// 本用例用替代模块（数据层 / 中证官网 / 仓储）验证这条不变式，不连数据库、不发外部请求。
process.env.NODE_ENV = 'test';

const assert = require('assert');

let csindexCalls = 0;
let savedSources = [];

const stub = (relativePath, exports) => {
  const resolved = require.resolve(relativePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

// 数据层：由用例控制官方是否返回数据（只在最后一段区间返回，前面几段按 5 年分段为空）
let officialRows = [];
stub('../dataAccess/marketDatasets', {
  readIndexValuationSeries: async ({ indexCode, endDate }) => {
    if (indexCode !== '000985' && indexCode !== '000300') return [];
    return String(endDate) >= '2026-01-01' ? officialRows : [];
  },
});

// 中证官网：切换后任何基准都不该再被调用，一旦调用就是回归
stub('../services/marketVolatilitySource', {
  fetchCsiPe: async () => {
    csindexCalls += 1;
    return { success: true, data: [{ tradeDate: '20261030', peg: 14.2 }] };
  },
  fetchChinaYield: async () => ({}),
  fetchHsiPe: async () => Buffer.from(''),
});

// 仓储：记录写入来源，不落库
stub('../repositories/marketYieldRepository', {
  readCsiWatermark: async () => ({ rows: [{ mx: null }] }),
  saveCsiValuations: async (benchmark, kept, sourceCode) => { savedSources.push({ benchmark, count: kept.length, sourceCode }); },
});

const job = require('../jobs/marketVolatilitySync');

(async () => {
  // 一、官方无数据：必须失败，且不得回落到中证官网
  officialRows = [];
  await assert.rejects(
    () => job.syncCsiIndexPe('CSIALL', '000985'),
    /官方口径本次无数据写入/,
    '官方取不到数据时任务应失败，不允许写另一种口径'
  );
  assert.strictEqual(csindexCalls, 0, 'CSIALL 不得回落中证官网（算法不同，掺着会让格雷厄姆失真）');

  // 二、官方有数据：正常写入，来源必须是 lixinger_official
  officialRows = [
    { day: '2026-10-29', pe: 18.49, pb: 1.55, raw: { 'pe_ttm.mcw': 18.49 } },
    { day: '2026-10-30', pe: 18.16, pb: 1.55, raw: { 'pe_ttm.mcw': 18.16 } },
  ];
  savedSources = [];
  const written = await job.syncCsiIndexPe('CSIALL', '000985');
  assert.strictEqual(written, 2, '应写入 2 条官方 PE');
  assert.deepStrictEqual(savedSources.map(item => item.sourceCode), ['lixinger_official'], '全市场 PE 只写官方来源');
  assert.strictEqual(csindexCalls, 0, '官方成功时同样不得调用中证官网');

  // 三、沪深300 同样只走官方：来源必须是 lixinger_official，且不得碰中证官网
  officialRows = [{ day: '2026-10-30', pe: 12.61, pb: 1.42, raw: { 'pe_ttm.mcw': 12.61 } }];
  savedSources = [];
  const csi300 = await job.syncCsiIndexPe('CSI300', '000300');
  assert.strictEqual(csi300, 1, '沪深300 应写入 1 条官方 PE');
  assert.strictEqual(csindexCalls, 0, '沪深300 切官方后不得再调用中证官网（两种算法不能掺）');
  assert.deepStrictEqual(savedSources.map(item => item.sourceCode), ['lixinger_official'], '沪深300 也必须写官方来源');

  // 四、沪深300 官方返空：同样只能失败，不能回退中证官网
  officialRows = [];
  savedSources = [];
  await assert.rejects(
    () => job.syncCsiIndexPe('CSI300', '000300'),
    /官方口径本次无数据写入/,
    '沪深300 官方取不到数据时任务必须失败'
  );
  assert.deepStrictEqual(savedSources, [], '失败时一条都不许写');
  assert.strictEqual(csindexCalls, 0, '沪深300 失败时也不得回退中证官网');

  // 五、没登记官方起点的基准不许偷偷走别的口径
  await assert.rejects(
    () => job.syncCsiIndexPe('CSI500', '000905'),
    /未配置官方 PE 起点/,
    '未登记官方起点的基准必须直接报错，不按中证口径写入'
  );

  console.log('csi-all-official-only：沪深300 与全市场 PE 都只认官方、失败不回退中证');
})().catch(error => {
  console.error(String(error && error.stack ? error.stack : error));
  process.exit(1);
});

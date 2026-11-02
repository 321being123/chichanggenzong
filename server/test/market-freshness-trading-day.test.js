// 市场周期子数据集的新鲜度判定：滞后必须按「交易日」算，不能用自然日。
//
// 2026-11-02 生产实测：`cn_yield`（10 年期国债）最新数据是 10-30（周五），
// 11-02（周一）18:45 跑任务时官方还没发布当日值。自然日差是 3 天 > maxLagDays=1，
// 于是被判 stale、整个 market_volatility_sync 报 partial 失败——每个周一都会重演。
// 按交易日算：10-30 之后到 11-02 之间只有 11-02 一个开市日，滞后 1 天，正常。
//
// 这里直接替换仓储层实现，验证三种情形：周末不放大滞后、真滞后仍能抓到、日历缺失时回退自然日。
const assert = require('assert');
const path = require('path');

const TRADING_DAYS = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-11-02'];

function loadJob(options) {
  const repoPath = require.resolve('../repositories/marketYieldRepository');
  const fakeRepo = {
    readSubdatasetFreshness: async () => ({ rows: [{ data_as_of: options.dataAsOf }] }),
    listOpenTradingDays: async ({ fromDate, toDate }) =>
      (options.calendar === null ? [] : TRADING_DAYS.filter(day => day >= fromDate && day <= toDate)),
  };
  delete require.cache[repoPath];
  require.cache[repoPath] = { id: repoPath, filename: repoPath, loaded: true, exports: fakeRepo };
  const jobPath = require.resolve('../jobs/marketVolatilitySync');
  delete require.cache[jobPath];
  return require(jobPath);
}

(async () => {
  // ① 周五数据 + 周一判定：按交易日只滞后 1 天 → fresh（自然日会是 3 天 → stale）
  let job = loadJob({ dataAsOf: '2026-10-30' });
  let diag = await job.readMarketSubdatasetFreshness('2026-11-02');
  assert.strictEqual(diag.cn_yield.lag_days, 1, '10-30 之后的交易日只有 11-02，滞后应为 1 个交易日');
  assert.strictEqual(diag.cn_yield.status, 'fresh', '周五数据在周一必须判为新鲜，不能把周末算成滞后');
  console.log('  ✓ 周五数据到周一：按交易日滞后 1 天，判 fresh');

  // ② 真滞后仍要抓到：10-27 的数据拖到 11-02，交易日差 3 天 → stale
  job = loadJob({ dataAsOf: '2026-10-27' });
  diag = await job.readMarketSubdatasetFreshness('2026-11-02');
  assert.strictEqual(diag.cn_yield.lag_days, 4, '10-27 之后有 10-28/10-29/10-30/11-02 四个开市日，按交易日应为 4');
  assert.strictEqual(diag.cn_yield.status, 'stale', '真正的多日滞后仍必须判 stale，不能因为改口径放过');
  console.log('  ✓ 真实滞后：交易日差超出阈值仍判 stale');

  // ③ 日历取不到时回退自然日，宁可多报一次 stale，也不能把滞后算小
  job = loadJob({ dataAsOf: '2026-10-30', calendar: null });
  diag = await job.readMarketSubdatasetFreshness('2026-11-02');
  assert.strictEqual(diag.cn_yield.lag_days, 3, '日历缺失时回退自然日差（10-30 到 11-02 为 3 天）');
  assert.strictEqual(diag.cn_yield.status, 'stale', '日历缺失不能放宽判定，必须按自然日判 stale');
  console.log('  ✓ 日历缺失：回退自然日差，不放宽判定');

  console.log('市场周期新鲜度：交易日口径通过');
})().catch(error => { console.error(error); process.exitCode = 1; });

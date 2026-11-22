'use strict';

const assert = require('assert');
const { MARKET_INDICES, findMarketIndex } = require('../domain/marketIndexCatalog');
const {
  PERIOD_KEYS,
  mergeIndexCloseAndValuationRows,
  computePeriodMetric,
  computeSeriesPercentileStats,
  buildIndexOverviewItem,
} = require('../domain/marketCycleIndices');

// 1. 10大指数目录与存量兼容键
assert.strictEqual(MARKET_INDICES.length, 10, '常见指数应包含10个指数');
assert.strictEqual(findMarketIndex('000300.SH').storageCode, 'CSI300');
assert.strictEqual(findMarketIndex('CSI300').indexCode, '000300.SH');
assert.strictEqual(findMarketIndex('000985.CSI').storageCode, '000985');
assert.strictEqual(findMarketIndex('899050.BJ').lixingerCode, '899050');
assert.strictEqual(findMarketIndex('HSCEI').market, 'HK');
assert.strictEqual(findMarketIndex('HSTECH').market, 'HK');

// 2. 合并收盘点位与估值行（单边缺失不丢弃）
const merged = mergeIndexCloseAndValuationRows(
  [{ date: '2026-11-19', close: 100 }, { date: '2026-11-20', close: 105 }],
  [{ day: '2026-11-20', pe: 12.5, pb: 1.35 }, { day: '2026-11-21', pe: 12.8, pb: 1.38 }]
);
assert.strictEqual(merged.length, 3);
assert.deepStrictEqual(merged[0], { day: '2026-11-19', close: 100, pe: null, pb: null, marketCap: null, raw: {} });
assert.strictEqual(merged[1].close, 105);
assert.strictEqual(merged[1].pe, 12.5);
assert.strictEqual(merged[2].close, null);
assert.strictEqual(merged[2].pb, 1.38);

// 3. 10 个周期维度（WTD/MTD/QTD/YTD/YTD_MDD/1Y/3Y/5Y/10Y + 成立不足N年）
const series = [
  { date: '2023-11-20', close: 800 },
  { date: '2025-11-20', close: 1000 },
  { date: '2025-12-31', close: 1100 },
  { date: '2026-06-30', close: 1300 },
  { date: '2026-09-30', close: 1200 },
  { date: '2026-10-30', close: 1250 },
  { date: '2026-11-13', close: 1400 }, // 上周五
  { date: '2026-11-16', close: 1350 }, // 本周一
  { date: '2026-11-19', close: 1450 },
  { date: '2026-11-20', close: 1470 }, // 周五
];

assert.strictEqual(computePeriodMetric(series, '1d').pct, Number((((1470 / 1450) - 1) * 100).toFixed(2)));
assert.strictEqual(computePeriodMetric(series, '1w').baseDate, '2026-11-13');
assert.strictEqual(computePeriodMetric(series, '1w').pct, Number((((1470 / 1400) - 1) * 100).toFixed(2)));
assert.strictEqual(computePeriodMetric(series, '1m').baseDate, '2026-10-30');
assert.strictEqual(computePeriodMetric(series, '1q').baseDate, '2026-09-30');
assert.strictEqual(computePeriodMetric(series, 'ytd').baseDate, '2025-12-31');
assert.strictEqual(computePeriodMetric(series, '1y').baseDate, '2025-11-20');
assert.strictEqual(computePeriodMetric(series, '3y').baseDate, '2023-11-20');

const insufficient5y = computePeriodMetric(series, '5y');
assert.strictEqual(insufficient5y.pct, null);
assert.strictEqual(insufficient5y.insufficientYears, 5);

const mdd = computePeriodMetric(series, 'ytd_mdd');
assert.strictEqual(mdd.pct, Number((((1200 - 1300) / 1300) * 100).toFixed(2)));
assert.strictEqual(mdd.peakDate, '2026-06-30');
assert.strictEqual(mdd.troughDate, '2026-09-30');

// 4. 分位点统计与总览组装
const peRows = [
  { date: '2026-11-16', close: 1350, pe: 10, pb: 1.0 },
  { date: '2026-11-17', close: 1380, pe: 12, pb: 1.2 },
  { date: '2026-11-18', close: 1400, pe: 14, pb: 1.4 },
  { date: '2026-11-19', close: 1450, pe: 16, pb: 1.6 },
  { date: '2026-11-20', close: 1470, pe: 12, pb: 1.2 },
];
const stats = computeSeriesPercentileStats(peRows, 'pe');
assert.strictEqual(stats.count, 5);
assert.strictEqual(stats.p50, 12);
assert.strictEqual(stats.current, 12);

const overviewItem = buildIndexOverviewItem(findMarketIndex('899050.BJ'), peRows);
assert.strictEqual(overviewItem.indexCode, '899050.BJ');
assert.strictEqual(Object.keys(overviewItem.periods).length, PERIOD_KEYS.length);
assert.strictEqual(overviewItem.latestClose, 1470);

console.log('marketCycleIndices.test.js passed');

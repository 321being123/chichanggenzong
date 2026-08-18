const assert = require('assert');
const { pool } = require('../db/connection');
const { computeNavAttribution } = require('../services/navAttribution');
const { todayCN } = require('../services/market');

const today = todayCN();
const previousDay = (() => {
  const [y, m, d] = today.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
})();

const originalQuery = pool.query;
pool.query = async (sql) => {
  if (sql.includes('FROM daily_prices')) {
    return { rows: [{ date: previousDay, code: '600000', price: 11 }, { date: previousDay, code: '160719', price: 11 }] };
  }
  if (sql.includes('FROM market.fx_rates')) return { rows: [] };
  throw new Error('unexpected query in baseline attribution test');
};

(async () => {
  try {
    const data = {
      hkRate: 1,
      cashBase: 980,
      cashFlows: [],
      trades: [{ trade_date: '2026-08-01', code: '600000', direction: 'buy', quantity: 10, amount_cny: 100, quote_currency: 'CNY' }],
      positions: [{ code: '600000', price: 12, quantity: 10, subtype: '沪市' }],
      navHistory: [
        { date: previousDay, totalAsset: 980, hkRate: 1, snapshotSource: 'legacy', snapshot_at: previousDay + 'T08:00:00.000Z' },
        { date: today, totalAsset: 1000, hkRate: 1, snapshotSource: 'legacy', snapshot_at: today + 'T08:00:00.000Z' }
      ]
    };
    const result = await computeNavAttribution('u', 'a', data, 1000);
    assert.strictEqual(result.previousTotalAsset, 990, '期初总资产必须按基准日收盘价和现金重建');
    assert.strictEqual(Math.round(result.totalChange), 10, '总涨跌必须使用重建后的期初总资产');
    assert.strictEqual(Math.round(result.priceImpact), 10, '价格影响应与基准日收盘价一致');
    assert.strictEqual(Math.round(result.snapshotDrift), 0, '同一价格口径下归因必须闭合');

    const anchored = await computeNavAttribution('u', 'a', {
      hkRate: 1,
      cashBase: 0,
      cashFlows: [],
      trades: [
        { trade_date: '2026-06-26', code: '160719', direction: 'buy', quantity: 40, amount_cny: 98.11, quote_currency: 'CNY' },
        { trade_date: '2026-06-26', code: '160719', direction: 'buy', quantity: 40, amount_cny: 98.11, quote_currency: 'CNY' },
        { trade_date: '2026-06-26', code: '160719', direction: 'buy', quantity: 40, amount_cny: 98.11, quote_currency: 'CNY' }
      ],
      positions: [{ code: '160719', price: 12, quantity: 120, subtype: '沪市' }],
      positionSnapshots: [{ snapshotId: 'import-1', snapshotDate: previousDay, code: '160719', quantity: 40, quoteCurrency: 'CNY' }],
      navHistory: [
        { date: previousDay, totalAsset: 1320, hkRate: 1, snapshotSource: 'imported', importBatchId: 'import-1', snapshot_at: previousDay + 'T23:59:59.000Z' },
        { date: today, totalAsset: 1440, hkRate: 1, snapshotSource: 'legacy', snapshot_at: today + 'T08:00:00.000Z' }
      ]
    }, 1440);
    assert.strictEqual(Math.round(anchored.priceImpact), 120, '当前持仓校正后应按120份计算价格影响');
    assert.strictEqual(Math.round(anchored.snapshotDrift), 0, '导入快照锚定后归因必须闭合');
    console.log('nav attribution baseline tests passed');
  } finally {
    pool.query = originalQuery;
    await pool.end();
  }
})().catch((error) => { console.error(error); process.exit(1); });

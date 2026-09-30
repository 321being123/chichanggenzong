const assert = require('assert');
const db = require('../db');
const state = require('../services/marketState');
const partitions = require('../services/datasetPartitionRegistry');
let currentExists = true;
let published = [];
db.tryClaimJob = async () => true;
db.releaseJob = async () => {};
db.startJobRun = async () => 1;
db.finishJobRun = async () => {};
db.upsertNav = async () => { throw new Error('缺持仓基准不能补造净值'); };
db.loadAccountData = async () => ({ positions: [{ code: '600000', name: '测试股', quantity: 100 }],
  trades: [], cashFlows: [], positionSnapshots: [], navHistory: [
    { date: '2026-07-02', nav: 1, totalAsset: 1000, snapshotSource: 'imported', isLocked: true },
    ...(currentExists ? [{ date: '2026-09-30', nav: 1, totalAsset: 1000 }] : []),
  ] });
state.isCnTradingDate = () => true;
state.getMarketState = async () => ({ status: 'open' });
state.prefetchMarketFacts = async () => {};
db.pool.query = async (sql, params) => {
  if (sql.includes('FROM accounts')) return { rows: [{ username: 'test', account_name: '账户甲' }, { username: 'test', account_name: '账户乙' }] };
  if (sql.includes('FROM daily_prices')) return { rows: [{ date: '2026-07-03', code: '600000', price: 10 }] };
  if (sql.includes('FROM market.fx_rates')) return { rows: [] };
  if (sql.includes('FROM nav_history')) {
    assert.strictEqual(params[2], '2026-09-30');
    return { rows: currentExists ? [{ date: params[2] }] : [] };
  }
  throw new Error(`未声明查询: ${sql}`);
};
partitions.publishDatasetSnapshot = async (code, options) => {
  assert.strictEqual(code, 'nav_snapshot');
  assert.strictEqual(options.partitionKey, '2026-09-30');
  assert.deepStrictEqual(options.diagnostics.historical_missing_dates, ['2026-07-03']);
  assert.strictEqual(options.diagnostics.checked_accounts, 2);
  published.push(options);
  return { published: true, datasetCode: code, partitionKey: options.partitionKey };
};
const { runNavSnapshotJob } = require('../jobs/navSnapshot');
(async () => {
  const result = await runNavSnapshotJob({ targetDate: '2026-09-30' });
  assert.strictEqual(result.ok, false, '历史缺口不能被当日净值成功掩盖');
  assert.strictEqual(result.currentDate.complete, true);
  assert.strictEqual(result.failedAccounts.length, 2);
  assert.strictEqual(published.length, 1, '当日完整分区应独立发布');
  currentExists = false;
  const missingCurrent = await runNavSnapshotJob({ targetDate: '2026-09-30' });
  assert.strictEqual(missingCurrent.currentDate.complete, false);
  assert.strictEqual(published.length, 1, '当日缺真实基准不得发布');
  console.log('nav current partition and historical gaps independently verified');
})().catch(error => { console.error(error); process.exitCode = 1; });

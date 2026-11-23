// STOCK-SWAP-SETTLE-067：换股调度阶段、目标日、实施证据缺口及账本记账日契约回归
// （合并原 stock-swap-job-execution / stock-swap-runner-contract / stock-swap-ledger-date 3 个小单测）。
const assert = require('assert');
const db = require('../db');
const cache = require('../services/arbitragePdfCache');
const repo = require('../repositories/stockSwapSettlementRepository');
const svc = require('../services/stockSwapSettlement');
const { runJobByCode } = require('../services/jobRunners');

// 1. 换股账本记账日必须是「实际执行日」而不是「公告日」
{
  const BASE_PLAN = {
    case_id: 208, username: 'u1', account_name: 'A',
    settlement_date: '2026-10-27', ledger_date: '2026-10-29',
    source_code: '601198', source_name: '东兴证券', source_quantity: 3100, source_cost_unit: 13.6,
    target_code: '601995', target_name: '中金公司', target_quantity: 1356, existing_target_quantity: 0,
    cost_total_before: 42196.27, cost_unit_after: 31.1182, ratio_applied: 0.437568,
    source_type: '股权', source_subtype: '沪市', target_type: '股权', target_subtype: '沪市',
  };
  const events = svc.buildLedgerEvents(BASE_PLAN);
  assert.strictEqual(events.length, 2, '应生成两条账本事件（来源清零 + 合并方建仓）');
  for (const e of events) {
    assert.strictEqual(e.date, '2026-10-29', '账本事件日期必须用实际执行日');
    assert.strictEqual(e.direction, 'adjust', '换股用 adjust，不产生现金流');
  }
  assert.strictEqual(events[0].code, '601198');
  assert.strictEqual(events[0].quantity, 0, '被合并方清零');
  assert.strictEqual(events[1].code, '601995');
  assert.strictEqual(events[1].quantity, 1356, '合并方数量=换得股数+原有持仓');

  const fallback = svc.buildLedgerEvents({ ...BASE_PLAN, ledger_date: undefined });
  assert.strictEqual(fallback[0].date, '2026-10-27', '缺 ledger_date 时回退为结算日');
}

(async () => {
  // 2. 调度阶段、目标业务日与缺失关联证据不得误报成功
  const job = require('../jobs/arbitrageSync');
  const oldJob = job.runArbitrageSync;
  let captured;
  try {
    job.runArbitrageSync = async (reason, ctx) => {
      captured = ctx;
      return { ok: true, dataAsOf: ctx.targetDate, publishDatasets: false, stageComplete: true };
    };
    let r = await runJobByCode('arbitrage_sync', 'test', '2026-10-20', { mode: 'stock_swap_settle' });
    assert.equal(r.mode, 'stock_swap_settle');
    assert.deepEqual(r.publishDatasetCodes, ['stock_swap_settlements']);
    assert.equal(r.dataAsOf, '2026-10-20');
    assert.equal(captured.targetDate, '2026-10-20');

    r = await runJobByCode('arbitrage_sync', 'test', '2026-10-20', { mode: 'cash_dividends' });
    assert.equal(r.mode, 'cash_dividends');
    assert.deepEqual(r.publishDatasetCodes, ['stock_cash_dividend_facts']);

    r = await runJobByCode('arbitrage_sync', 'test', '2026-10-20', {});
    assert.equal(r.mode, 'core');
    assert.deepEqual(r.publishDatasetCodes, ['arbitrage_cases']);
  } finally {
    job.runArbitrageSync = oldJob;
  }

  const oldImplemented = repo.selectImplementedSwapCases;
  const oldUnlinked = repo.selectUnlinkedImplementationCandidates;
  try {
    repo.selectImplementedSwapCases = async (patterns, date) => {
      assert.equal(date, '2026-10-20');
      assert(!patterns.some(x => x.includes('换股实施公告')));
      return [];
    };
    repo.selectUnlinkedImplementationCandidates = async (date) => {
      assert.equal(date, '2026-10-20');
      return [{ case_id: 208, document_id: 495046 }];
    };
    const r = await svc.runStockSwapSettlement({ targetDate: '2026-10-20', dryRun: true });
    assert.equal(r.ranAt, '2026-10-20');
    assert.equal(r.ok, false);
    assert.equal(r.pendingCount, 1);
    assert.equal(r.unlinkedEvidenceCount, 1);
    await assert.rejects(svc.runStockSwapSettlement({ targetDate: '2026-02-30', dryRun: true }), /目标业务日无效/);
  } finally {
    repo.selectImplementedSwapCases = oldImplemented;
    repo.selectUnlinkedImplementationCandidates = oldUnlinked;
  }

  // 3. Runner 的目标日、失败传播及发布边界
  const saved = {
    claim: db.tryClaimJob, release: db.releaseJob, start: db.startJobRun, finish: db.finishJobRun,
    cache: cache.cleanupArbitragePdfCache, run: svc.runStockSwapSettlement,
  };
  try {
    db.tryClaimJob = async () => true;
    db.releaseJob = async () => {};
    db.startJobRun = async () => 1;
    db.finishJobRun = async () => {};
    cache.cleanupArbitragePdfCache = () => ({});
    let seen;
    svc.runStockSwapSettlement = async opts => {
      seen = opts;
      return { ok: true, ranAt: opts.targetDate, caseCount: 0, settlementCount: 0, appliedCount: 0, pendingCount: 0, failedCount: 0, errors: [] };
    };
    delete require.cache[require.resolve('../jobs/arbitrageSync')];
    const reloadedJob = require('../jobs/arbitrageSync');
    let r = await reloadedJob.runArbitrageSync('test', { mode: 'stock_swap_settle', targetDate: '2026-10-20' });
    assert.equal(seen.targetDate, '2026-10-20');
    assert.equal(r.ok, true);
    assert.equal(r.dataAsOf, '2026-10-20');
    assert.equal(r.stageComplete, true);
    assert.equal(r.publishDatasets, false);

    svc.runStockSwapSettlement = async opts => ({
      ok: false, ranAt: opts.targetDate, caseCount: 0, settlementCount: 0,
      appliedCount: 0, pendingCount: 1, failedCount: 0, errors: [],
      failureDetail: ['case208:官方实施结果未关联，待核查'],
    });
    r = await reloadedJob.runArbitrageSync('test', { mode: 'stock_swap_settle', targetDate: '2026-10-20' });
    assert.equal(r.ok, false);
    assert.equal(r.stageComplete, false);
    assert.match(r.error, /未关联/);
  } finally {
    db.tryClaimJob = saved.claim;
    db.releaseJob = saved.release;
    db.startJobRun = saved.start;
    db.finishJobRun = saved.finish;
    cache.cleanupArbitragePdfCache = saved.cache;
    svc.runStockSwapSettlement = saved.run;
    await db.pool.end();
  }

  console.log('换股契约、调度阶段、目标日及记账日回归合并通过');
})().catch(e => { console.error(e); process.exitCode = 1; });

// STOCK-SWAP-SETTLE-067：调度阶段、目标日、实施证据缺口不得误报成功。
const assert=require('assert');
const repo=require('../repositories/stockSwapSettlementRepository');
const svc=require('../services/stockSwapSettlement');
const job=require('../jobs/arbitrageSync');
const {runJobByCode}=require('../services/jobRunners');
(async()=>{
 const oldJob=job.runArbitrageSync;let captured;
 try {
  job.runArbitrageSync=async(reason,ctx)=>{captured=ctx;return {ok:true,dataAsOf:ctx.targetDate,publishDatasets:false,stageComplete:true}};
  let r=await runJobByCode('arbitrage_sync','test','2026-10-20',{mode:'stock_swap_settle'});
  assert.equal(r.mode,'stock_swap_settle');assert.deepEqual(r.publishDatasetCodes,['stock_swap_settlements']);assert.equal(r.dataAsOf,'2026-10-20');assert.equal(captured.targetDate,'2026-10-20');
  r=await runJobByCode('arbitrage_sync','test','2026-10-20',{mode:'cash_dividends'});assert.equal(r.mode,'cash_dividends');assert.deepEqual(r.publishDatasetCodes,['stock_cash_dividend_facts']);
  r=await runJobByCode('arbitrage_sync','test','2026-10-20',{});assert.equal(r.mode,'core');assert.deepEqual(r.publishDatasetCodes,['arbitrage_cases']);
 } finally {job.runArbitrageSync=oldJob}
 const oldImplemented=repo.selectImplementedSwapCases,oldUnlinked=repo.selectUnlinkedImplementationCandidates;
 try {
  repo.selectImplementedSwapCases=async(patterns,date)=>{assert.equal(date,'2026-10-20');assert(!patterns.some(x=>x.includes('换股实施公告')));return []};
  repo.selectUnlinkedImplementationCandidates=async(date)=>{assert.equal(date,'2026-10-20');return [{case_id:208,document_id:495046}]};
  const r=await svc.runStockSwapSettlement({targetDate:'2026-10-20',dryRun:true});assert.equal(r.ranAt,'2026-10-20');assert.equal(r.ok,false);assert.equal(r.pendingCount,1);assert.equal(r.unlinkedEvidenceCount,1);
  await assert.rejects(svc.runStockSwapSettlement({targetDate:'2026-02-30',dryRun:true}),/目标业务日无效/);
 } finally {repo.selectImplementedSwapCases=oldImplemented;repo.selectUnlinkedImplementationCandidates=oldUnlinked}
 console.log('换股阶段模式、目标业务日和缺失关联证据回归通过');
})().catch(e=>{console.error(e);process.exitCode=1});

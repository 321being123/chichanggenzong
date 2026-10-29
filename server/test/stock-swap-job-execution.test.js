// STOCK-SWAP-SETTLE-067：目标日和阶段失败传播。
const assert=require('assert');
const db=require('../db'),cache=require('../services/arbitragePdfCache'),svc=require('../services/stockSwapSettlement');
const saved={claim:db.tryClaimJob,release:db.releaseJob,start:db.startJobRun,finish:db.finishJobRun,cache:cache.cleanupArbitragePdfCache,run:svc.runStockSwapSettlement};
(async()=>{try{
 db.tryClaimJob=async()=>true;db.releaseJob=async()=>{};db.startJobRun=async()=>1;db.finishJobRun=async()=>{};cache.cleanupArbitragePdfCache=()=>({});let seen;
 svc.runStockSwapSettlement=async opts=>{seen=opts;return {ok:true,ranAt:opts.targetDate,caseCount:0,settlementCount:0,appliedCount:0,pendingCount:0,failedCount:0,errors:[]}};
 delete require.cache[require.resolve('../jobs/arbitrageSync')];const job=require('../jobs/arbitrageSync');
 let r=await job.runArbitrageSync('test',{mode:'stock_swap_settle',targetDate:'2026-10-20'});
 assert.equal(seen.targetDate,'2026-10-20');assert.equal(r.ok,true);assert.equal(r.dataAsOf,'2026-10-20');assert.equal(r.stageComplete,true);assert.equal(r.publishDatasets,false);
 svc.runStockSwapSettlement=async opts=>({ok:false,ranAt:opts.targetDate,caseCount:0,settlementCount:0,appliedCount:0,pendingCount:1,failedCount:0,errors:[],failureDetail:['case208:官方实施结果未关联，待核查']});
 r=await job.runArbitrageSync('test',{mode:'stock_swap_settle',targetDate:'2026-10-20'});
 assert.equal(r.ok,false);assert.equal(r.stageComplete,false);assert.match(r.error,/未关联/);
 console.log('换股 Runner 的目标日、失败传播及发布边界通过');
}finally{db.tryClaimJob=saved.claim;db.releaseJob=saved.release;db.startJobRun=saved.start;db.finishJobRun=saved.finish;cache.cleanupArbitragePdfCache=saved.cache;svc.runStockSwapSettlement=saved.run;await db.pool.end()}})().catch(e=>{console.error(e);process.exitCode=1});

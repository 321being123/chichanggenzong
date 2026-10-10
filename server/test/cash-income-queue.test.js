const assert=require('assert');require('dotenv').config();delete process.env.DATABASE_URL;process.env.PGDATABASE=process.env.PGTESTDATABASE||'portfolio_test';
const {pool}=require('../db/connection'),queue=require('../services/cashIncomeQueue');
const {resolveDatasetScope,areJobDatasetsPublished}=require('../services/datasetPartitionRegistry');
const U='cash_queue_test',A='分批:账户',ID='cash_queue_test_id',targetDate='2026-07-09',context={username:U,accountName:A,targetDate,enabled:true,mode:'cash_income'};
async function cleanup(){await pool.query("DELETE FROM job_runs WHERE slot_id IN (SELECT slot_id FROM ops.job_schedule_slots WHERE request_payload->>'username'=$1)",[U]);await pool.query("DELETE FROM ops.job_schedule_slots WHERE request_payload->>'username'=$1",[U]);await pool.query('DELETE FROM ops.dataset_partitions WHERE scope_key=$1',[resolveDatasetScope('account_cash_income',context)]);await pool.query('DELETE FROM accounts WHERE username=$1',[U]);for(const t of ['nav_history','account_data'])await pool.query(`DELETE FROM ${t} WHERE username=$1`,[U]);await pool.query('DELETE FROM users WHERE username=$1',[U]);}
(async()=>{try{
await cleanup();assert.strictEqual(resolveDatasetScope('account_cash_income',{}),null);assert.strictEqual(resolveDatasetScope('account_cash_income',context),'account:cash_queue_test:%E5%88%86%E6%89%B9%3A%E8%B4%A6%E6%88%B7');
await assert.rejects(()=>queue.enqueue(U,A,{targetDate:'2026-02-30',version:0}),/目标日/);
await pool.query("INSERT INTO users(username,password,accounts,status,auth_version) VALUES($1,'x',$2,'active',1)",[U,JSON.stringify([A])]);
await pool.query('INSERT INTO accounts(id,username,account_name,cash_base,hk_rate) VALUES($1,$2,$3,0,1)',[ID,U,A]);await pool.query("INSERT INTO account_data(username,account_name,data,version) VALUES($1,$2,'{}',0)",[U,A]);
await pool.query(`INSERT INTO nav_history(username,account_name,account_id,date,nav,total_asset,invested,cash_cny,market_value_cny,system_market_value_at_snapshot,snapshot_source,is_locked,source_priority) VALUES($1,$2,$3,'2026-05-01',1,100000,100000,100000,0,0,'imported',true,100)`,[U,A,ID]);
const queued=await queue.enqueue(U,A,{targetDate,enabled:true,version:0}),duplicate=await queue.enqueue(U,A,{targetDate,enabled:true,version:0});assert.strictEqual(queued.slotId,duplicate.slotId);
assert.strictEqual((await pool.query('SELECT business_date::text FROM ops.job_schedule_slots WHERE slot_id=$1',[queued.slotId])).rows[0].business_date,targetDate);
const slot=(await pool.query('SELECT *,business_date::text FROM ops.job_schedule_slots WHERE slot_id=$1',[queued.slotId])).rows[0];
const execution=await require('../services/jobOrchestrator').runSlot(slot,'manual-cash-income-test');const first=execution.result||execution;assert(first.continuationRequired,JSON.stringify(execution));assert.strictEqual(first.stageComplete,false);assert(first.remainingCount>0);
assert.strictEqual(await areJobDatasetsPublished('nav_snapshot',targetDate,['account_cash_income'],context),false,'第一批不能发布最终分区');
const state=(await pool.query('SELECT cash_income_state FROM accounts WHERE id=$1',[ID])).rows[0].cash_income_state;assert.strictEqual(state.recalculation.processedThrough,'2026-05-31');assert(state.recalculation.nextAttemptAt);
const second=await queue.run(context);assert(second.continuationRequired);assert(second.remainingCount<first.remainingCount);
const final=await queue.run(context);assert(final.ok);assert(final.stageComplete);assert.strictEqual(await areJobDatasetsPublished('nav_snapshot',targetDate,['account_cash_income'],context),true);
assert.strictEqual(await areJobDatasetsPublished('nav_snapshot',targetDate,['account_cash_income'],{...context,accountName:'其他账户'}),false,'其他账户不能复用成功分区');
assert.strictEqual((await queue.run(context)).changed,0,'重跑不得重复入账');
console.log('cash income queue: atomic slot dedupe, target date, persisted batches, remaining progress and account partition isolation passed');
}finally{await cleanup();await pool.end();}})().catch(e=>{console.error(e);process.exitCode=1;});

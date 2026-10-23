const assert=require('assert');
const {pool}=require('../db/connection');
const {recoverNavDependencies,attemptLimit,mergeSlotExternalCallSummary}=require('../services/jobScheduleSlots');
(async()=>{
 const c=await pool.connect(),original=pool.query;
 try{
  await c.query('BEGIN');
  await c.query("UPDATE ops.job_schedule_slots SET acknowledged_at=now() WHERE status='blocked'");
  const source=(await c.query('SELECT source_id FROM ops.data_sources ORDER BY source_id LIMIT 1')).rows[0].source_id;
  const instrument=(await c.query("INSERT INTO core.instruments(canonical_code,name,asset_class,market,exchange_code,currency_code) VALUES('204001.SH','GC001','repo','CN','SSE','CNY') ON CONFLICT(canonical_code) DO UPDATE SET canonical_code=EXCLUDED.canonical_code RETURNING instrument_id")).rows[0].instrument_id;
  const date='2020-01-02';
  await c.query("DELETE FROM ops.dataset_partitions WHERE dataset_code='repo_daily_rates' AND partition_key=$1",[date]);
  await c.query("DELETE FROM market.repo_daily_rates WHERE instrument_id=$1 AND trade_date=$2",[instrument,date]);
  const summary={repoRates:{ok:false,failures:[{code:'EMPTY_DATA'}]},failedAccounts:[{diagnostics:[{date,reason:'cash_income_recalculation_incomplete',pending:[{code:'204001.SH',date,reason:'missing_repo_daily_rate'}]}]}]};
  const slot=(await c.query(`INSERT INTO ops.job_schedule_slots(job_code,scheduled_for,business_date,status,attempt_count,last_error,result_summary,updated_at)
   VALUES('nav_snapshot',now()-interval '10 days',$1,'blocked',3,'数据集 nav_snapshot 连续3次未完成',$2,now()-interval '1 hour') RETURNING *`,[date,summary])).rows[0];
  pool.query=c.query.bind(c);
  const state=async()=>(await c.query('SELECT * FROM ops.job_schedule_slots WHERE slot_id=$1',[slot.slot_id])).rows[0];
  await recoverNavDependencies();assert.strictEqual((await state()).status,'blocked','空证据不得恢复');
  await c.query("INSERT INTO ops.dataset_partitions(dataset_code,scope_key,partition_key,status,is_stale,diagnostics) VALUES('repo_daily_rates','CN',$1,'published',false,$2)",[date,{quality_status:'passed'}]);
  await recoverNavDependencies();assert.strictEqual((await state()).status,'blocked','只有分区而无利率事实不得恢复');
  await c.query("INSERT INTO market.repo_daily_rates(instrument_id,trade_date,source_id,tenor_days,weighted_annual_rate,close_annual_rate,unit,quality_status,source_revision) VALUES($1,$2,$3,1,0.01,0.01,'annual_decimal','passed','test')",[instrument,date,source]);
  await c.query("UPDATE ops.dataset_partitions SET scope_key='wrong' WHERE dataset_code='repo_daily_rates' AND partition_key=$1",[date]);
  await recoverNavDependencies();assert.strictEqual((await state()).status,'blocked','错scope不得恢复');
  await c.query("UPDATE ops.dataset_partitions SET scope_key='CN' WHERE dataset_code='repo_daily_rates' AND partition_key=$1",[date]);
  await Promise.all([recoverNavDependencies(),recoverNavDependencies()]);
  const ready=await state();assert.strictEqual(ready.status,'pending');assert.strictEqual(ready.attempt_count,3,'保留原失败次数');
  assert.strictEqual(attemptLimit(ready,{maxAttempts:3}),4,'证据恢复仅额外一次实际核验');
  await c.query("UPDATE ops.job_schedule_slots SET status='running' WHERE slot_id=$1",[slot.slot_id]);
  const merged=await mergeSlotExternalCallSummary(slot.slot_id,{ok:false});assert(merged.dependencyRecovery,'失败后保留证据，不能重复放行');
  await c.query("UPDATE ops.job_schedule_slots SET status='blocked',result_summary=$2 WHERE slot_id=$1",[slot.slot_id,merged]);
  await recoverNavDependencies();assert.strictEqual((await state()).status,'blocked');
  console.log('净值依赖真实PG恢复：空事实、错scope、并发幂等、保留次数、额外单次核验及失败证据保留通过');
 }finally{pool.query=original;await c.query('ROLLBACK');c.release();await pool.end();}
})().catch(e=>{console.error(e);process.exitCode=1;});

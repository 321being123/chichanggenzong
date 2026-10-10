const {pool}=require('../db/connection');
const CoreDate=require('../../public/shared/core-date');
async function enqueue(username,accountName,{targetDate,enabled,version}={}) {
  if(!CoreDate.normalizeBusinessDate(targetDate)||targetDate>CoreDate.todayInZone('Asia/Shanghai'))throw Object.assign(new Error('无效收益目标日'),{status:400});
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const row=(await client.query('SELECT id FROM accounts WHERE username=$1 AND account_name=$2 FOR UPDATE',[username,accountName])).rows[0];
    if(!row)throw Object.assign(new Error('账户不存在'),{status:404});
    await require('./tradeLedger').checkVersionInTxn(client,username,accountName,version);
    await client.query(`UPDATE accounts SET cash_income_state=cash_income_state||$2::jsonb WHERE id=$1`,[row.id,JSON.stringify({recalculation:{status:'queued',targetDate,requestedAt:new Date().toISOString()}})]);
    const slot=await require('./jobScheduleSlots').enqueueManualJob('nav_snapshot',{mode:'cash_income',username,accountName,targetDate,enabled:enabled===true},client);
    if(!slot)throw new Error('现金收益任务没有注册');
    await client.query('UPDATE ops.job_schedule_slots SET business_date=$2::date WHERE slot_id=$1',[slot.slot_id,targetDate]);
    await client.query('COMMIT');
    return {status:'queued',slotId:slot.slot_id,targetDate};
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
async function run(context) {
  if(!CoreDate.normalizeBusinessDate(context.targetDate)||context.targetDate>CoreDate.todayInZone('Asia/Shanghai'))throw Object.assign(new Error('无效收益目标日'),{status:400});
  const input=await require('./accountCash').loadCashInputs(context.username,context.accountName);
  const anchor=require('../../public/shared/nav-math').selectCashAnchor(input.navHistory,context.targetDate);
  const saved=(await pool.query('SELECT cash_income_state FROM accounts WHERE username=$1 AND account_name=$2',[context.username,context.accountName])).rows[0]?.cash_income_state?.recalculation;
  const from=saved?.targetDate===context.targetDate&&CoreDate.normalizeBusinessDate(saved?.processedThrough)?saved.processedThrough:anchor?.date;
  // 30个自然日只是一次提交批次；剩余区间及下一次时间持久化，最终目标不截断。
  const through=from?[require('./cashIncome').shiftDay(from,30),context.targetDate].sort()[0]:context.targetDate;
  const result=await require('./cashIncome').settleCashIncome(context.username,context.accountName,{targetDate:through,enable:context.enabled===true});
  const processedThrough=result.progress?.processedThrough;
  const continuing=!!processedThrough&&processedThrough===through&&through<context.targetDate;
  const nextAttemptAt=continuing?new Date(Date.now()+60000).toISOString():result.progress?.nextAttemptAt||null;
  const progress={status:continuing?'partial':result.status==='calculated'?'completed':'pending_evidence',targetDate:context.targetDate,processedThrough:processedThrough||null,
    remainingDays:processedThrough?Math.max(0,Math.round((new Date(context.targetDate+'T12:00:00+08:00')-new Date(processedThrough+'T12:00:00+08:00'))/86400000)):null,
    remainingStages:continuing?['cash_income_calculation']:result.progress?.remainingStages||['cash_anchor_or_policy'],nextAttemptAt,lastProgressAt:new Date().toISOString()};
  await pool.query(`UPDATE accounts SET cash_income_state=cash_income_state||$3::jsonb WHERE username=$1 AND account_name=$2`,[context.username,context.accountName,JSON.stringify({recalculation:progress})]);
  if(continuing)return {...result,mode:'cash_income',targetDate:context.targetDate,ok:true,status:'partial',stageComplete:false,publishDatasets:false,publishDatasetCodes:['account_cash_income'],continuationRequired:true,pendingStages:['cash_income_calculation'],remainingCount:progress.remainingDays,nextAttemptInMinutes:1};
  const ok=result.status==='calculated';
  await require('./datasetPartitions').publishDatasetPartition('account_cash_income',require('./datasetPartitionRegistry').resolveDatasetScope('account_cash_income',context),{partitionKey:context.targetDate,dataAsOf:context.targetDate,status:ok?'published':'rejected',rowCount:result.changed||0,diagnostics:{...result,quality_status:ok?'passed':'failed',verified_no_change:ok&&result.changed===0}});
  return {...result,mode:'cash_income',username:context.username,accountName:context.accountName,publishDatasetCodes:['account_cash_income'],ok,status:ok?'succeeded':'partial',dataAsOf:context.targetDate,publishDatasets:false,stageComplete:ok,
    failedDatasets:ok?[]:['account_cash_income'],pendingStages:ok?[]:['cashIncomeEvidence'],...(ok?{}:{error:'现金收益存在待补来源或结算证据',errorCode:'DATASET_INCOMPLETE',errorType:'data_quality'})};
}
module.exports={enqueue,run};

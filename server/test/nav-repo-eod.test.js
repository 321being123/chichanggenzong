const assert=require('assert');
const {completedRepoTarget,ensureNavRepoRate}=require('../services/repoDailyRates');
const {loadCandidates}=require('../services/hkDailyCoverage');
(async()=>{
  const {isCashIncomeDependencyWait}=require('../jobs/navSnapshot');
  const wait=[{diagnostics:[{reason:'cash_income_recalculation_incomplete',pending:[{reason:'missing_repo_daily_rate'}]}]}];
  assert.strictEqual(isCashIncomeDependencyWait(wait,{ok:false,failures:[{code:'EMPTY_DATA'}]}),true);
  assert.strictEqual(isCashIncomeDependencyWait(wait,{ok:false,failures:[{code:'PERMISSION_DENIED'}]}),false);
  assert.strictEqual(isCashIncomeDependencyWait([{error:'坏数据'}],null),false);
  assert.strictEqual(isCashIncomeDependencyWait([{diagnostics:[{reason:'missing_prices',pending:[{reason:'missing_repo_daily_rate'}]}]}],null),false);
  assert.strictEqual(isCashIncomeDependencyWait([{diagnostics:[{reason:'cash_income_recalculation_incomplete',pending:[{reason:'missing_acquisition_date'}]}]}],null),false);
  assert.strictEqual(isCashIncomeDependencyWait([],null),false);
  // NAV-REPO-EOD-001: 上海收盘边界与缺口定点补采。
  const options={allowCompletedToday:true,now:new Date('2026-10-13T07:29:59Z')};
  assert.strictEqual(completedRepoTarget('2026-10-13',options),false);
  options.now=new Date('2026-10-13T07:30:00Z');
  assert.strictEqual(completedRepoTarget('2026-10-13',options),true);
  assert.strictEqual(completedRepoTarget('2026-10-13',{now:options.now}),false);
  assert.strictEqual(completedRepoTarget('2026-10-14',options),false);
  assert.strictEqual(completedRepoTarget('2026-10-12',options),true);
  assert.strictEqual(completedRepoTarget('2026-10-11',{allowCompletedToday:true,now:new Date('2026-10-11T08:00:00Z')}),false);
  let enabled=2,saved=true,calls=0;
  const query=async(sql,params)=>{
    if(sql.includes('COUNT(*)')) return {rows:[{enabled_count:enabled}]};
    assert.match(sql,/quality_status='passed'/);
    assert.deepStrictEqual(params,['2026-10-13']);
    return {rows:saved?[{exists:1}]:[]};
  };
  const sync=async args=>{calls++;assert.deepStrictEqual(args,{targetDate:'2026-10-13',startDate:'2026-10-13',allowCompletedToday:true});return {ok:true};};
  assert.strictEqual(await ensureNavRepoRate('2026-10-13',{query,sync}),null);
  assert.strictEqual(calls,0);
  saved=false;
  assert.strictEqual((await ensureNavRepoRate('2026-10-13',{query,sync})).ok,true);
  assert.strictEqual(calls,1);
  const failed=await ensureNavRepoRate('2026-10-13',{query,sync:async()=>{throw new Error('上游空响应');}});
  assert.strictEqual(failed.ok,false);
  enabled=0;
  assert.strictEqual(await ensureNavRepoRate('2026-10-13',{query,sync}),null);
  assert.strictEqual(calls,1);
  // HK-DAILY-LIFECYCLE-001: 定向代码也不能跳过目标日上市生命周期。
  await loadCandidates({query:async(sql,params)=>{
    assert.match(sql,/i.list_date IS NOT NULL AND i.list_date::date <= \$1::date/);
    assert.deepStrictEqual(params,['2026-10-13',['02636.HK']]);
    return {rows:[]};
  }},'2025-08-04','2026-10-13',null,['02636.HK']);
  console.log('NAV-REPO-EOD-001 / HK-DAILY-LIFECYCLE-001 passed');
})().catch(error=>{console.error(error);process.exitCode=1;});

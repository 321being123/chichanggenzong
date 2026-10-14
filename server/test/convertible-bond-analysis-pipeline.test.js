const assert=require('assert');
const {refreshAllConvertibleBondAnalysis}=require('../services/convertibleBondAnalysisSnapshots');
const {syncConvertibleBondAnalysisInputs,inputDocuments}=require('../services/convertibleBondAnalysisInputs');
const {pool}=require('../db/connection');

(async()=>{
  // BOND-ANALYSIS-001: 全量详细快照无隐性上限、日期与失败对象分别核验。
  // BOND-ANALYSIS-005: 上游同日任务缺失不阻挡已发布的上一交易日输入。
  const valuation=require('../services/jobDefinitions').getJobDefinition('convertible_bond_valuation_refresh');
  assert.deepEqual(valuation.dependencyCodes||[],[],'已经发布的输入不能被同日不存在的上游任务阻挡');
  assert.deepEqual(valuation.datasetDependencies.map(d=>[d.datasetCode,d.scopeKey,d.partitionDatePolicy]),
    ['bond_master','bond_daily','stock_daily','stock_suspend_calendar'].map(d=>[d,'CN','previous_trading_day']));
  const rows=Array.from({length:350},(_,i)=>({ts_code:String(i),raw_payload:{}}));
  let persisted;
  const complete=await refreshAllConvertibleBondAnalysis('2026-09-30',{
    loadUniverse:async()=>rows,build:async()=>({as_of:'2026-09-30',completeness:{missing:[]}}),persist:async(d,date,s)=>{persisted=s;},
  });
  assert.equal(complete.count,350);assert.equal(complete.ok,true);assert.deepEqual(persisted.remaining,[]);
  const failed=await refreshAllConvertibleBondAnalysis('2026-09-30',{
    loadUniverse:async()=>rows,build:async(code)=>({as_of:code==='349'?'2026-09-29':'2026-09-30',completeness:{missing:[]}}),persist:async(d,date,s)=>{persisted=s;},
  });
  assert.equal(failed.ok,false);assert.deepEqual(failed.remaining,['349']);assert.ok(persisted.nextRunAt);assert.deepEqual(persisted.pendingStages,['analysis_snapshot']);
  const empty=await refreshAllConvertibleBondAnalysis('2026-09-30',{loadUniverse:async()=>[],persist:async()=>{}});
  assert.equal(empty.ok,false);

  // BOND-ANALYSIS-002: 资料续跑复用已解析原文，失败/空结果不得发布全量分区。
  const bond={ts_code:'127040.SZ',stock_code:'002091.SZ',bond_short_name:'国泰转债',value_date:'2021-07-07',raw_payload:{}};
  const events=[
    {url:'old',title:'公司公开发行可转换公司债券募集说明书',event_date:'2021-07-03'},
    {url:'other-issue',title:'公司公开发行可转换公司债券募集说明书',event_date:'2025-01-01'},
    {url:'report',title:'公司2026年半年度报告',event_date:'2026-08-22'},
    {url:'rating',title:'公司2026年评级报告',event_date:'2026-06-25'},
  ];
  assert.equal(inputDocuments(events,bond).find(d=>d.kind==='prospectus').event.url,'old');
  assert.equal(inputDocuments(events,{...bond,value_date:'2026-10-10'}).some(d=>d.kind==='holders'),false,
    '发行前报告不能把其他转债持有人表投影到新债');
  const {requiredReportPeriod}=require('../services/convertibleBondAnalysisInputs');
  assert.equal(requiredReportPeriod('2026-08-31'),'2025-12-31');assert.equal(requiredReportPeriod('2026-09-01'),'2026-06-30');
  assert.equal(requiredReportPeriod('2026-04-30'),'2025-06-30');assert.equal(requiredReportPeriod('2026-05-01'),'2025-12-31');
  let discovered=0,projected=0;
  const deps={latestDate:async()=> '2026-09-30',loadUniverse:async()=>[bond],discover:async()=>{discovered++;},
    readDocuments:async()=>events,project:async(kind)=>{projected++;if(kind==='holders')throw new Error('报告解析失败');return {document_hash:'hash'};},
    save:async()=>{},persistBond:async(b,state)=>{b.raw_payload.analysis_inputs=structuredClone(state);},persist:async(d,date,s)=>{persisted=s;}};
  const first=await syncConvertibleBondAnalysisInputs({businessDate:'2026-10-12',targetCodes:['127040']},deps);
  assert.equal(first.ok,false);assert.deepEqual(first.remaining,['127040.SZ']);assert.deepEqual(first.publishDatasets,[]);
  assert.equal(persisted.scopeKey.startsWith('convertible_bond_analysis:targeted:'),true);
  assert.equal(discovered,1);assert.equal(projected,4);
  deps.project=async()=>{projected++;return {document_hash:'hash'};};
  const second=await syncConvertibleBondAnalysisInputs({businessDate:'2026-10-12',targetCodes:['127040']},deps);
  assert.equal(second.ok,true);assert.equal(discovered,1);assert.equal(projected,5,'只续补上轮失败文档');
  for(const document of Object.values(bond.raw_payload.analysis_inputs.documents)) {document.parserVersion='analysis-input-v3';document.documentHash='a'.repeat(64);}
  for(const event of events)event.content_hash='a'.repeat(64);
  const legacy=await syncConvertibleBondAnalysisInputs({businessDate:'2026-10-12',targetCodes:['127040']},deps);
  assert.equal(legacy.ok,true);assert.equal(projected,5,'版本升级仍复用已完成且同原文SHA的有效投影');
  bond.raw_payload.analysis_inputs.coveredThrough='2026-10-13';
  const oldDay=await syncConvertibleBondAnalysisInputs({businessDate:'2026-10-12',targetCodes:['127040']},{...deps,latestDate:async date=>{assert.equal(date,'2026-10-12');return '2026-09-30';}});
  assert.equal(oldDay.ok,true);assert.equal(bond.raw_payload.analysis_inputs.coveredThrough,'2026-10-13','旧日复验不得回退覆盖水位');
  bond.raw_payload.analysis_inputs.coveredThrough='2026-10-12';
  const {getJobDefinition,stageCompletionEvidence}=require('../services/jobDefinitions');
  assert.equal(stageCompletionEvidence(getJobDefinition('convertible_bond_announcement_history_sync'),second,
    {mode:'analysis_inputs_targeted',targetCodes:['127040.SZ']}),true);
  const {publishJobDatasets}=require('../services/datasetPartitionRegistry');
  assert.deepEqual(await publishJobDatasets('convertible_bond_announcement_history_sync','2026-10-12',second),[]);
  const stateBefore=structuredClone(bond.raw_payload.analysis_inputs);
  deps.discover=async()=>{throw new Error('官方分页不完整');};
  const third=await syncConvertibleBondAnalysisInputs({businessDate:'2026-10-13',targetCodes:['127040']},deps);
  assert.equal(third.ok,false);assert.equal(bond.raw_payload.analysis_inputs.coveredThrough,stateBefore.coveredThrough);
  const stopped=await syncConvertibleBondAnalysisInputs({businessDate:'2026-10-13',maxRuntimeMs:0},deps);
  assert.equal(stopped.continuationRequired,true);assert.equal(stopped.remainingCount,1);assert.ok(stopped.nextRunAt);
  assert.deepEqual(stopped.pendingStages,['analysis_inputs']);assert.equal(stopped.publishDatasets,false);
  const noSources=await syncConvertibleBondAnalysisInputs({businessDate:'2026-10-12'}, {...deps,loadUniverse:async()=>[],persist:async()=>{}});
  assert.equal(noSources.ok,false);
  const order=[];
  const secondBond={...bond,ts_code:'127041.SZ',raw_payload:{}};
  await syncConvertibleBondAnalysisInputs({businessDate:'2026-10-13'}, {...deps,
    loadUniverse:async()=>[bond,secondBond],readProgress:async()=>({attemptedCodes:['127040.SZ']}),
    discover:async(b)=>{order.push(b.ts_code);throw new Error('文档失败');},persist:async()=>{},
  });
  assert.deepEqual(order,['127041.SZ','127040.SZ'],'历史失败对象不能阻挡尚未采集证券，跨日期仍保存首次遍历顺序');
  // BOND-ANALYSIS-FAIR-006: 首次遍历完成后的超时续批也不能反复卡在同一前缀。
  const fairRows=['127050.SZ','127051.SZ','127052.SZ'].map(ts_code=>({...bond,ts_code,raw_payload:{analysis_inputs:{coveredThrough:'2026-10-13',documents:{}}}}));
  const fairOrder=[];
  let elapsed=0;
  const realNow=Date.now;
  const fairDeps={...deps,loadUniverse:async()=>fairRows,readProgress:async()=>({attemptedCodes:fairRows.map(b=>b.ts_code)}),
    readDocuments:async b=>{fairOrder.push(b.ts_code);elapsed=2;return [];},persist:async()=>{}};
  try {
    Date.now=()=>elapsed;
    for(let batch=0;batch<3;batch++) {
      elapsed=0;
      const result=await syncConvertibleBondAnalysisInputs({businessDate:'2026-10-13',maxRuntimeMs:1},fairDeps);
      assert.equal(result.ok,false);assert.equal(result.remainingCount,3);assert.equal(result.continuationRequired,true);
    }
  } finally {Date.now=realNow;}
  assert.deepEqual(fairOrder,['127050.SZ','127051.SZ','127052.SZ']);
  // BOND-RATING-IDENTITY-011: 初发唯一匹配限定公告到实际发行窗口，并且必须是目标证券。
  const {initialRatingBindingArguments}=require('../services/convertibleBondAnalysisInputs');
  const initialBond={instrument_id:123,stock_code:'605123.SH',value_date:'2026-08-06',maturity_date:'2032-08-06',raw_payload:{issue_size:1580000000}};
  const initialEvent={event_date:'2026-08-04'};
  let matched={matches:1,is_target:true};
  const identityQuery=async(sql,params)=>{
    assert.match(sql,/p.value_date BETWEEN \$4::date AND \$5::date/);
    assert.deepEqual(params,['605123.SH',1580000000,123,'2026-04-02','2026-08-06']);
    return {rows:[matched]};
  };
  assert.deepEqual(await initialRatingBindingArguments(initialBond,initialEvent,identityQuery,'2026-04-02'),['--initial-issue-size-yuan','1580000000','--initial-tenor-years','6']);
  for(const invalid of [{matches:2,is_target:true},{matches:1,is_target:false},{matches:0,is_target:false}]) {
    matched=invalid;assert.deepEqual(await initialRatingBindingArguments(initialBond,initialEvent,identityQuery,'2026-04-02'),[]);
  }
  assert.deepEqual(await initialRatingBindingArguments(initialBond,{event_date:'2026-08-07'},()=>{throw Error('跟踪文件不进入初发匹配');}),[]);
  // BOND-RATING-ROLE-017: 延期通知不是评级结果，仍缺实际评级报告时禁止成功。
  const delay={url:'delay',title:'中证鹏元关于延迟披露公司及相关债券2026年定期跟踪评级报告的公告',event_date:'2026-06-24'};
  assert.equal(inputDocuments([delay],bond).some(d=>d.kind==='rating'),false);
  assert.deepEqual(inputDocuments([...events,delay],bond).filter(d=>d.kind==='rating').map(d=>d.event.url),['rating']);
  assert.equal(inputDocuments([{...delay,title:'关于可转换公司债券2026年跟踪评级调整的公告'}],bond).filter(d=>d.kind==='rating').length,1);
  let projectedDelay=false;
  let classifiedDelay;
  const delayOnly=await syncConvertibleBondAnalysisInputs({businessDate:'2026-10-13',targetCodes:['127040']},{...deps,
    loadUniverse:async()=>[{...bond,raw_payload:{analysis_inputs:{documents:{'rating:delay':{status:'failed',error:'旧解析失败'}}}}}],readDocuments:async()=>events.filter(e=>e.url!=='rating').concat(delay),
    project:async(kind,event)=>{if(event.url==='delay')projectedDelay=true;return {document_hash:'hash'};},
    persistBond:async(b,state)=>{classifiedDelay=state.documents['rating:delay'];},
  });
  assert.equal(projectedDelay,false);assert.equal(delayOnly.ok,false);assert.ok(delayOnly.missingFields['127040.SZ'].includes('rating_report'));
  assert.equal(classifiedDelay.status,'not_applicable');assert.equal(classifiedDelay.previousFailure,'旧解析失败');
  assert.equal(classifiedDelay.classificationEvidence.url,'delay');
  // BOND-RATING-REVALIDATE-019: 已完成但疑似取前次日期只重验该原文，不借旧标准事实再次完成。
  const {suspectRatingUrls}=require('../services/convertibleBondAnalysisInputs');
  const suspect=await suspectRatingUrls({instrument_id:123},async(sql,args)=>{
    assert.match(sql,/NOT raw_payload \? 'identity_binding'/);assert.deepEqual(args,[123]);return {rows:[{url:'rating'}]};
  });
  assert.deepEqual([...suspect],['rating']);
  let revalidated=[];
  const savedBond={...bond,raw_payload:{analysis_inputs:{coveredThrough:'2026-10-13',documents:Object.fromEntries(inputDocuments(events,bond).map(d=>[`${d.kind}:${d.event.url}`,{status:'complete',parserVersion:'analysis-input-v4'}]))}}};
  const revalidationDeps={...deps,loadUniverse:async()=>[savedBond],suspectRatingUrls:async()=>suspect,
    project:async(kind,event)=>{revalidated.push(event.url);return {document_hash:'hash',rating_date_source:'official_document'};},save:async()=>{},persistBond:async()=>{}};
  assert.equal((await syncConvertibleBondAnalysisInputs({businessDate:'2026-10-13',targetCodes:['127040']},revalidationDeps)).ok,true);
  assert.deepEqual(revalidated,['rating']);
  let dubiousSaved=false;
  const dubious=await syncConvertibleBondAnalysisInputs({businessDate:'2026-10-13',targetCodes:['127040']},{...revalidationDeps,
    project:async()=>({document_hash:'hash',rating_date_source:'announcement_fallback'}),save:async()=>{dubiousSaved=true;},
  });
  assert.equal(dubious.ok,false);assert.equal(dubiousSaved,false);assert.ok(dubious.missingFields['127040.SZ'].includes('rating'));
  console.log('BOND-ANALYSIS-001/002 passed: 全量覆盖、目标日期、失败保留、定向作用域与资料续跑');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>pool.end());

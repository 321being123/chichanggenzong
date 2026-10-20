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
  // BOND-REPORT-FULL-TEXT-035：提示/审议/更正公告不代正文；同报告期优先正式更新全文。
  const {latestFullReport}=require('../services/convertibleBondAnalysis').analysisInputTools;
  const fullReport={url:'full-report',title:'长海股份：2026年半年度报告',event_date:'2026-08-22'};
  const announcement={url:'notice-only',title:'长海股份：2026年半年度报告披露提示性公告',event_date:'2026-08-22'};
  assert.equal(latestFullReport([announcement,fullReport]).url,'full-report');
  for(const title of ['2026年半年度报告披露的提示性公告','关于2026年半年度报告的更正公告','2026年半年度报告摘要','2026年半年度报告的审议公告','2026年半年度报告专项审核意见']) {
    assert.equal(latestFullReport([{...announcement,title}]),null,'非完整正文不能进入持有人/转股价解析');
  }
  const revised={...fullReport,url:'revised-report',title:'长海股份：2026年半年度报告（更正后）',event_date:'2026-08-30'};
  assert.equal(latestFullReport([fullReport,revised]).url,'revised-report');
  assert.equal(latestFullReport([{...fullReport,title:'长海股份：2026 年半年度报告全文'}]).url,'full-report');
  const selectedReport=inputDocuments([...events.filter(e=>e.url!=='report'),announcement,fullReport],bond);
  assert.equal(selectedReport.find(d=>d.kind==='holders').event.url,'full-report');
  assert.equal(selectedReport.find(d=>d.kind==='price_history').event.url,'full-report');
  // BOND-RATING-NOTICE-CANDIDATES-028：标题未写简称仍须读取发行人结果公告，由原文代码身份决定覆盖资格。
  const untitledBondNotice={url:'issuer-rating-notice',title:'公司关于公开发行可转换公司债券2023年跟踪评级结果的公告',event_date:'2023-06-10'};
  assert.equal(inputDocuments([...events,untitledBondNotice],bond).some(d=>d.kind==='rating'&&d.event.url===untitledBondNotice.url),true);
  assert.equal(inputDocuments([{...untitledBondNotice,title:'关于信用评级机构业务变更的提示性公告'}],bond).some(d=>d.kind==='rating'),false);
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
  // BOND-RATING-ISSUE-PUBLICATION-024: 首发报告可在实际发行后/上市前公布，身份仍按实际评级日至发行日唯一匹配。
  const listedBond={...initialBond,list_date:'2026-08-20'};
  matched={matches:1,is_target:true};
  for(const event_date of ['2026-08-07','2026-08-20']) {
    assert.equal((await initialRatingBindingArguments(listedBond,{event_date},identityQuery,'2026-04-02')).length,4);
  }
  assert.deepEqual(await initialRatingBindingArguments(listedBond,{event_date:'2026-08-21'},()=>{throw Error('上市后不允许首发兜底');}),[]);
  assert.deepEqual(await initialRatingBindingArguments(listedBond,initialEvent,()=>{throw Error('评级日不可晚于实际发行');},'2026-08-07'),[]);
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
    assert.match(sql,/NOT raw_payload \? 'identity_binding'/);assert.match(sql,/text_method.*rapidocr-onnx-v1/);
    assert.match(sql,/rating_grade_context_version/);assert.deepEqual(args,[123]);return {rows:[{url:'rating'}]};
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
  // BOND-RATING-GRADE-CONFLICT-023: 旧OCR无符号结论定点重验，冲突不写入、不发布且保留剩余证据。
  let conflictSaved=false,conflictState;
  const conflicting=await syncConvertibleBondAnalysisInputs({businessDate:'2026-10-13',targetCodes:['127040']},{...revalidationDeps,
    project:async()=>({rating:'AA',document_hash:'a'.repeat(64),rating_date_source:'official_document',rating_conflicts:[{rating:'AA',evidence:'通知书AA'},{rating:'AA-',evidence:'本次债项表AA-'}]}),
    save:async()=>{conflictSaved=true;},persistBond:async(b,state)=>{conflictState=state;},
  });
  assert.equal(conflicting.ok,false);assert.equal(conflictSaved,false);assert.equal(conflicting.remainingCount,1);
  assert.deepEqual(conflicting.publishDatasets,[]);assert.ok(conflicting.nextRunAt);
  assert.match(conflictState.documents['rating:rating'].error,/本次评级结论冲突/);
  // BOND-RATING-DATE-SCOPE-021: 当前日期缺失而OCR历史标签残缺时，年度不一致的无本次作用域不能入库。
  const {validateTrackingRatingYear}=require('../services/convertibleBondAnalysisInputs');
  const tracking={title:'公司公开发行可转换公司债券2024年跟踪评级报告'};
  const priorDate={rating_date:'2023-05-29',rating_date_source:'official_document',rating_date_context:'official_unscoped'};
  assert.throws(()=>validateTrackingRatingYear(tracking,priorDate),/疑似历史日期/);
  for(const scope of ['current_explicit_label','current_summary_table','current_report_issuance']) {
    assert.doesNotThrow(()=>validateTrackingRatingYear(tracking,{...priorDate,rating_date_context:scope}),'明确本次原文日期允许真实跨年');
  }
  assert.doesNotThrow(()=>validateTrackingRatingYear(tracking,{...priorDate,rating_date:'2024-05-27'}));
  assert.doesNotThrow(()=>validateTrackingRatingYear({title:'公司首次公开发行可转换公司债券信用评级报告'},priorDate),'初发不凭公告年份猜评级日');
  // BOND-RATING-RESULT-NOTICE-025: 以同日同标题公告覆盖报告义务，原失败仍可查；前次明确债项只能补发行前历史。
  const issuer='贵州永吉印务股份有限公司';
  const noticeEvent={url:'notice-2024',source:'sse',title:'关于“永吉转债”2024年跟踪评级结果的公告',event_date:'2024-05-29'};
  const initialReport={url:'initial-2022',source:'sse',title:issuer+'公开发行可转换公司债券信用评级报告',event_date:'2022-04-12'};
  const trackingReport={url:'tracking-2024',source:'sse',title:issuer+'2024年跟踪评级报告',event_date:'2024-05-29'};
  const noticeResult={document_hash:'b'.repeat(64),source_url:noticeEvent.url,rating_com_name:'远东资信评估有限公司',rating:'AA-',rating_outlook:'稳定',rating_date:'2024-05-27',
    rating_date_source:'official_document',rating_date_context:'current_report_issuance',rating_conflicts:[],
    rating_result_notice:{version:'named-result-v1',bond_code:'113646.SH',bond_name:'永吉转债',issuer_name:issuer,rating_company:'远东资信评估有限公司',
      report_reference:{title:trackingReport.title,issued_at:'2024-05-27'},previous_ratings:[{rating_com_name:'远东资信评估有限公司',rating:'AA-',rating_outlook:'稳定',rating_date:'2021-03-15',
        rating_date_source:'official_document',rating_date_context:'explicit_previous_named_bond',rating_evidence:'永吉转债前次评级结果为AA-；评级时间为2021年3月15日。',date_evidence:'评级时间为2021年3月15日。'}]}};
  const noticeBond={ts_code:'113646.SH',stock_code:'603058.SH',bond_short_name:'永吉转债',bond_full_name:issuer+'公开发行可转换公司债券',
    value_date:'2022-04-14',list_date:'2022-05-17',raw_payload:{analysis_inputs:{coveredThrough:'2026-10-13',documents:{
      'rating:initial-2022':{status:'failed',parserVersion:'analysis-input-v4',error:'金额不符'},
      'rating:tracking-2024':{status:'failed',parserVersion:'analysis-input-v4',error:'OCR日期残缺'},
    }}}};
  const noticeEvents=[trackingReport,initialReport,noticeEvent,{url:'prospectus',title:'公开发行可转换公司债券募集说明书',event_date:'2022-04-12'},events[2]];
  let noticeSaves=0;
  const noticeDeps={...deps,loadUniverse:async()=>[noticeBond],discover:async()=>{},readDocuments:async()=>noticeEvents,
    suspectRatingUrls:async()=>new Set([trackingReport.url]),project:async(kind,event)=>{
      if(kind==='rating'){assert.equal(event.url,noticeEvent.url,'已核验替代证据避免重复扫描原失败报告');return structuredClone(noticeResult);}
      return {document_hash:'c'.repeat(64)};
    },save:async(kind)=>{if(kind==='rating')noticeSaves++;}};
  const covered=await syncConvertibleBondAnalysisInputs({businessDate:'2026-10-13',targetCodes:['113646']},noticeDeps);
  assert.equal(covered.ok,true);assert.equal(covered.remainingCount,0);assert.deepEqual(covered.publishDatasets,[]);assert.equal(noticeSaves,1);
  const coverageState=noticeBond.raw_payload.analysis_inputs;
  assert.equal(coverageState.documents['rating:initial-2022'].status,'failed');
  assert.equal(coverageState.documents['rating:tracking-2024'].error,'OCR日期残缺');
  assert.equal(coverageState.rating_coverage['tracking-2024'].method,'exact_report_reference');
  assert.equal(coverageState.rating_coverage['initial-2022'].method,'explicit_named_bond_previous_rating');
  const resumed=await syncConvertibleBondAnalysisInputs({businessDate:'2026-10-13',targetCodes:['113646']},noticeDeps);
  assert.equal(resumed.ok,true);assert.equal(noticeSaves,1,'同SHA公告复用已落库证据，不能重复采集或保存');
  const {ratingCoverageForReport,validateRatingResultNotice}=require('../services/convertibleBondAnalysisInputs');
  assert.equal(ratingCoverageForReport({...trackingReport,event_date:'2024-05-30'},[noticeEvent],coverageState.documents,noticeBond),null);
  // BOND-RATING-REPORT-PUBLICATION-040：明确本年报告引用及全范围唯一URL可覆盖跨日发布，歧义/早于实际日拒绝。
  const nextDayReport={...trackingReport,event_date:'2024-05-30'};
  const crossDay=ratingCoverageForReport(nextDayReport,[noticeEvent],coverageState.documents,noticeBond,[{event:nextDayReport}]);
  assert.equal(crossDay.method,'exact_report_reference');assert.equal(crossDay.match_scope,'unique_annual_report_reference');
  assert.equal(crossDay.report_announced_at,'2024-05-30');assert.equal(crossDay.notice_announced_at,'2024-05-29');
  assert.equal(ratingCoverageForReport(nextDayReport,[noticeEvent],coverageState.documents,noticeBond,[{event:nextDayReport},{event:{...trackingReport,url:'different-day-version'}}]),null);
  assert.equal(ratingCoverageForReport({...trackingReport,event_date:'2024-05-26'},[noticeEvent],coverageState.documents,noticeBond,[{event:nextDayReport}]),null);
  assert.equal(ratingCoverageForReport({...trackingReport,title:issuer+'2025年跟踪评级报告'},[noticeEvent],coverageState.documents,noticeBond),null);
  assert.equal(ratingCoverageForReport({...trackingReport,source:'szse'},[noticeEvent],coverageState.documents,noticeBond),null);
  assert.equal(ratingCoverageForReport(trackingReport,[noticeEvent],coverageState.documents,noticeBond,
    [{event:trackingReport},{event:{...trackingReport,url:'another-same-title-report'}}]),null,'同日同标题多个不同原报告URL不能猜关联');
  const wrongBond={...noticeBond,ts_code:'113647.SH'};
  assert.throws(()=>validateRatingResultNotice(noticeEvent,noticeResult,wrongBond),/目标代码/);
  assert.equal(ratingCoverageForReport(initialReport,[noticeEvent],coverageState.documents,wrongBond),null);
  const futurePrior=structuredClone(coverageState.documents);futurePrior['rating:notice-2024'].ratingResult.rating_result_notice.previous_ratings[0].rating_date='2023-03-15';
  assert.equal(ratingCoverageForReport(initialReport,[noticeEvent],futurePrior,noticeBond),null,'发行后的前次记录不能补初发');
  const failedNotice=structuredClone(coverageState.documents);failedNotice['rating:notice-2024'].status='failed';
  assert.equal(ratingCoverageForReport(trackingReport,[noticeEvent],failedNotice,noticeBond),null,'失败公告/旧残留元数据不能提供恢复证据');
  noticeBond.raw_payload.analysis_inputs.documents=failedNotice;
  const failedSource=await syncConvertibleBondAnalysisInputs({businessDate:'2026-10-13',targetCodes:['113646']},{...noticeDeps,
    project:async(kind)=>{if(kind==='rating')throw Error('公告解析不完整');return {document_hash:'c'.repeat(64)};}});
  assert.equal(failedSource.ok,false);assert.equal(failedSource.remainingCount,1);assert.ok(failedSource.nextRunAt);
  assert.deepEqual(noticeBond.raw_payload.analysis_inputs.rating_coverage,{});
  assert.equal(noticeBond.raw_payload.analysis_inputs.documents['rating:initial-2022'].status,'failed');
  // BOND-HOLDERS-NOT-LISTED-029：在原始报告明示且实际上日晚于报告期时豁免，不写入零基金事实。
  const {validateHolderExemption}=require('../services/convertibleBondAnalysisInputs');
  const exemptBond={...bond,ts_code:'110101.SH',bond_short_name:'宝钛转债',value_date:'2026-06-25',list_date:'2026-07-16',raw_payload:{}};
  const holderExemption={reason:'not_listed_by_report_period',bond_name:'宝钛转债',listing_date:'2026-07-16',evidence:'报告期内公司可转换公司债券未上市'};
  const exemptionResult={document_hash:'e'.repeat(64),parse_status:'not_applicable',holder_table_bond:'宝钛转债',holder_exemption:holderExemption,report_date:'2026-06-30'};
  validateHolderExemption(exemptionResult,exemptBond);
  for(const bad of [{...exemptBond,list_date:null},{...exemptBond,list_date:'2026-06-01'},{...exemptBond,bond_short_name:'其他转债'}])assert.throws(()=>validateHolderExemption(exemptionResult,bad),/不适用缺少/);
  const exemptionDeps={latestDate:async()=> '2026-09-30',loadUniverse:async()=>[exemptBond],discover:async()=>{},
    readDocuments:async()=>[{url:'prospectus-exempt',title:'公司公开发行可转换公司债券募集说明书',event_date:'2026-06-20'},
      {url:'report-exempt',title:'公司2026年半年度报告',event_date:'2026-08-26'},{url:'rating-exempt',title:'公司公开发行可转换公司债券信用评级报告',event_date:'2026-06-20'}],
    project:async kind=>kind==='holders'?exemptionResult:{document_hash:'e'.repeat(64)},
    save:async(kind,event,result,b)=>{if(kind==='holders'){validateHolderExemption(result,b);assert.equal(result.fund_count,undefined);}},
    persistBond:async(b,state)=>{b.raw_payload.analysis_inputs=structuredClone(state);},persist:async()=>{}};
  assert.equal((await syncConvertibleBondAnalysisInputs({businessDate:'2026-10-13'},exemptionDeps)).ok,true);
  assert.equal(exemptBond.raw_payload.analysis_inputs.not_due.basis,'official_not_listed_by_report_period');
  assert.equal((await syncConvertibleBondAnalysisInputs({businessDate:'2026-10-13'},{...exemptionDeps,project:async()=>{throw Error('重复解析已完成原文');}})).ok,true);
  // BOND-REPORT-ROLE-037：旧误选提示公告保留失败证据并改非适用角色，正式全文仍需真正解析。
  const roleBond={...bond,raw_payload:{analysis_inputs:{coveredThrough:'2026-10-13',documents:{
    'holders:notice-only':{status:'failed',error:'定期报告未披露持有人表'},
    'price_history:notice-only':{status:'failed',error:'旧误选公告'},
  }}}};
  const roleEvents=[...events.filter(e=>e.url!=='report'),announcement,fullReport];
  const roleDeps={...exemptionDeps,loadUniverse:async()=>[roleBond],readDocuments:async()=>roleEvents,
    project:async(kind,event)=>{assert.notEqual(event.url,'notice-only');return {document_hash:'f'.repeat(64)};},save:async()=>{}};
  assert.equal((await syncConvertibleBondAnalysisInputs({businessDate:'2026-10-13'},roleDeps)).ok,true);
  const role=roleBond.raw_payload.analysis_inputs.documents['holders:notice-only'];
  assert.equal(role.status,'not_applicable');assert.equal(role.previousFailure,'定期报告未披露持有人表');
  assert.equal(role.classificationEvidence.reason,'not_full_periodic_report');
  assert.equal(roleBond.raw_payload.analysis_inputs.documents['holders:full-report'].status,'complete');
  console.log('BOND-ANALYSIS-001/002 passed: 全量覆盖、目标日期、失败保留、定向作用域与资料续跑');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>pool.end());

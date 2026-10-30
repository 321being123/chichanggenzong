// 可转债详细分析资料入口：文书发现 → 统一文档库 → 版本化投影 → 资料同步编排。
// 2026-10-30 S5 分层：纯判定（文档选择、评级要求、标题与身份校验）已提取到
// server/domain/convertibleBondAnalysisRules.js；本文件只保留取数、解析子进程、事务写入和编排。
// 导出面不变，原调用方仍从本文件引入。
const layerSql = require('../repositories/convertibleBondAnalysisInputsRepository');
const {pool}=require('../db/connection');
const {execFile}=require('child_process');
const path=require('path');
const {fetchSseEvents,fetchSzseEvents}=require('./stockAnalysis');
const {saveCollectedEvents}=require('./financialDataArchitecture');
const {childProcessEnv,mergeExternalCallStatsFromStderr}=require('./externalCallGuard');
const {isoDate,normalizeBondCode,announcementDateWindows,analysisInputTools:tools}=require('./convertibleBondAnalysis');
const {loadAnalysisUniverse,persistAnalysisProgress,latestAnalysisDate}=require('./convertibleBondAnalysisSnapshots');
const {tryAnalysisApiFallback,terminalApplies,APIS:FALLBACK_APIS}=require('./convertibleBondAnalysisFallback');
const txControl = require('../repositories/transactionControl');
const { persistBondInputs, readDocuments, readRatingHistory } = require('../repositories/convertibleBondAnalysisInputsRepository.js');
const repository = require('../repositories/convertibleBondAnalysisInputsRepository.js');

const {
  INPUT_VERSION,DOCUMENT_SELECTION_VERSION,RATING_REQUIREMENT_VERSION,RATING_RETRY_CAPABILITY,
  TERMINAL_GAP_STATUSES,sha,requiredReportPeriod,reportPeriod,
  shouldRetryRatingFailure,needRatingResultNotices,validateRatingGrade,validateTrackingRatingYear,
  issuerNameOf,isRatingPublicationDelay,isRatingResultNotice,isBondRatingDocument,terminalGap,
  validateHolderExemption,validateRatingResultNotice,ratingCoverageForReport,inputDocuments,
  missingReportRepairStart,ratingRequirement
} = require('../domain/convertibleBondAnalysisRules');

async function suspectRatingUrls(bond,query=pool.query.bind(pool)) {
  if(!bond.instrument_id)return new Set();
  const {rows}=await layerSql.suspectRatingUrlsQuery1(query, [bond.instrument_id]);
  return new Set(rows.map(row=>row.url).filter(Boolean));
}
async function initialRatingBindingArguments(bond,event,query=pool.query.bind(pool),creditDate=null) {
  const size=Number(bond.raw_payload?.issue_size),issued=isoDate(bond.value_date),maturity=isoDate(bond.maturity_date),announced=isoDate(event.event_date);
  const listed=isoDate(bond.list_date),publicationEnd=listed&&listed>=issued?listed:issued;
  if(!(size>0&&issued&&maturity&&announced&&maturity.slice(5)===issued.slice(5)&&announced<=publicationEnd))return [];
  if(creditDate&&creditDate>issued)return [];
  const args=['--initial-issue-size-yuan',String(size),'--initial-tenor-years',String(Number(maturity.slice(0,4))-Number(issued.slice(0,4)))];
  if(!creditDate)return args;
  const {rows}=await layerSql.initialRatingBindingArgumentsQuery1(query, [bond.stock_code,size,bond.instrument_id,creditDate,issued]);
  return rows[0]?.matches===1&&rows[0]?.is_target===true?
    args:[];
}

async function projectDocument(kind,event,bond) {
  const scripts={prospectus:'Prospectus',issuance_terms:'Prospectus',holders:'FundHoldings',rating:'Rating',price_history:'PriceHistory'};
  const script=path.join(__dirname,'..','scripts',`extractConvertibleBond${scripts[kind]}.py`);
  const args=[script,event.url,'--security-code',bond.stock_code];
  if(kind==='prospectus')args.push('--require-bond-prospectus');
  if(kind!=='prospectus')args.push('--bond-name',bond.bond_short_name);
  const issuer=issuerNameOf(bond.bond_full_name);
  if(issuer)args.push('--issuer-name',issuer);
  if(kind==='rating') {
    args.push('--announcement-date',isoDate(event.event_date));
    args.push('--bond-code',bond.ts_code);
    if(bond.value_date)args.push('--issue-date',isoDate(bond.value_date));
    if(bond.list_date)args.push('--list-date',isoDate(bond.list_date));
    args.push(...await initialRatingBindingArguments(bond,event));
  }
  if(kind==='price_history'&&bond.first_conv_price!=null)args.push('--initial-price',String(bond.first_conv_price));
  const output=await new Promise((resolve,reject)=>execFile(tools.pythonCandidates()[0],args,
    {cwd:path.join(__dirname,'..','..'),env:childProcessEnv({PYTHONUTF8:'1'}),windowsHide:true,timeout:90000,maxBuffer:8*1024*1024},
    (error,stdout,stderr)=>{mergeExternalCallStatsFromStderr(stderr);if(error)return reject(error);try{resolve(JSON.parse(stdout));}catch(e){reject(e);}}));
  if(output.identity_binding) {
    if(output.rating_date_source!=='official_document'||!output.rating_date ||
      !(await initialRatingBindingArguments(bond,event,pool.query.bind(pool),output.rating_date)).length)throw new Error('初发评级未按原文实际日期唯一绑定目标证券，保留原事实');
    output.identity_binding={...output.identity_binding,method:'unique_issuer_credit_date_issue_amount_tenor',validated:true,instrument_id:bond.instrument_id};
  }
  return {...output,source_title:event.title,report_date:kind==='holders'?
    (event.title.match(/(20\d{2})年?\s*(半年度|年度)报告/)||[]).slice(1).map((v,index)=>index?v==='半年度'?'06-30':'12-31':v).join('-'):undefined};
}

/* readDocuments 已迁入 server/repositories/convertibleBondAnalysisInputsRepository.js */

async function discoverDocuments(bond,targetDate,state,{repairStart}={}) {
  const scopeKey=`bond_analysis_documents:${bond.stock_code}`;
  const {rows:coverage}=await repository.select_ops_sync_cursors([scopeKey]);
  const cursor=coverage[0]?.last_success_date||state.coveredThrough;
  if(cursor&&cursor>=targetDate&&!repairStart)return [];
  const {rows:dates}=await repository.select_fundamental_convertible_bond_profiles([bond.stock_code]);
  const firstDate=dates[0]?.date||isoDate(bond.value_date);
  if(!firstDate)throw new Error('发行生效日期缺失，无法确定首次公告范围');
  const from=new Date(`${repairStart||cursor||firstDate}T00:00:00+08:00`);
  if(!repairStart)from.setUTCDate(from.getUTCDate()-(cursor?3:365));
  const fetcher=bond.stock_code.endsWith('.SH')?fetchSseEvents:bond.stock_code.endsWith('.SZ')?fetchSzseEvents:null;
  if(!fetcher)throw new Error('未登记目标公司的官方交易所');
  const events=[];
  for(const window of announcementDateWindows(isoDate(from),targetDate)) {
    const result=await fetcher(bond.stock_code,window.start,window.end,'',{structured:true});
    if(!result||result.complete!==true)throw new Error('官方公告分页不完整，保留覆盖水位');
    events.push(...result.events);
    // Persist every completed window before moving on; interrupted discovery retains its documents.
    await saveCollectedEvents(bond.stock_code,result.events.map(e=>({...e,event_date:String(e.event_date).replace(/-/g,'')})));
    const sources=await tools.sourceIds(pool);
    const rawRecords=result.events.map(event=>({source_id:sources[event.source],
      source_key:`${event.source}:${event.source_number||event.url}`,payload:{...event,stock_code:bond.stock_code},payload_hash:sha(event.raw||event)}));
    if(rawRecords.length)await repository.with_ops_raw_records([JSON.stringify(rawRecords)]);
    await repository.insert_ops_sync_cursors([scopeKey,window.end,JSON.stringify({query_status:result.events.length?'success':'verified_no_change',complete:true,start:window.start,end:window.end,count:result.events.length})]);
  }
  return events;
}

async function saveProjection(kind,event,result,bond) {
  if(!/^[a-f0-9]{64}$/i.test(result.document_hash||'')) throw new Error('原文SHA-256缺失或无效，保留原投影');
  if(kind==='holders'&&result.parse_status==='not_applicable')validateHolderExemption(result,bond);
  const client=await pool.connect();
  try {
    await txControl.begin(client);
    const sources=await tools.sourceIds(client);
    const sourceId=sources[event.source];
    if(!sourceId)throw new Error('公告来源未登记');
    if(kind==='rating'&&result.rating_result_notice) {
      const {rows:existingFacts}=await repository.select_fundamental_convertible_bond_ratings([bond.instrument_id,result.rating_date,result.rating_com_name], client);
      const priorFacts=existingFacts.filter(row=>row.rating!==result.rating);
      if(priorFacts.some(row=>row.raw_payload.text_method==='pdf_text')||priorFacts.length&&result.text_method!=='pdf_text') {
        throw new Error('官方结果公告与已有原生本次评级结论冲突，保留原事实');
      }
      const replacements=[...existingFacts.filter(row=>row.rating===result.rating&&row.raw_payload.source_url===event.url)
        .flatMap(row=>row.raw_payload.replaced_rating_evidence||[]),...priorFacts.map(row=>({rating:row.rating,
        source_url:row.raw_payload.source_url,document_hash:row.raw_payload.document_hash,text_method:row.raw_payload.text_method,
        reason:'explicit_named_native_notice_replaces_previous_ocr'}))];
      if(replacements.length)result.replaced_rating_evidence=[...new Map(replacements.map(row=>[JSON.stringify(row),row])).values()];
    }
    const record=(await repository.insert_ops_raw_records([sourceId,`${event.url}:${kind}:${INPUT_VERSION}`,JSON.stringify(result),sha(result)], client)).rows[0];
    await repository.update_event_documents([event.document_id,result.document_hash,record.raw_record_id,JSON.stringify({[kind]:{...result,parser_version:INPUT_VERSION}})], client);
    if(kind==='prospectus'||kind==='issuance_terms') {
      if(kind==='prospectus'&&!result.fundraising_purpose)throw new Error('募集用途解析缺失');
      if(!result.coupon_rates?.length && !(kind==='prospectus'&&['not_disclosed','missing'].includes(result.coupon_status)))throw new Error('完整票息解析缺失');
      const years=Number(isoDate(bond.maturity_date)?.slice(0,4))-Number(isoDate(bond.value_date)?.slice(0,4));
      if(result.coupon_rates?.length&&years>0&&(result.coupon_rates.length!==years||result.coupon_rates.some((rate,index)=>rate.interest_year!==index+1)))throw new Error('票息年限未完整覆盖目标债券，保留原事实');
      await tools.saveProspectusDetails(client,bond.instrument_id,bond,result,sourceId);
    }
    if(kind==='holders') {
      if(result.parse_status!=='not_applicable') {
        if(result.parse_status!=='complete')throw new Error('定期报告未披露可唯一核验的持有人表');
        await tools.saveReportFundHolding(client,bond.instrument_id,result,sourceId);
      }
    }
    if(kind==='rating') {
      validateRatingGrade(result);
      if(result.identity_binding&&result.identity_binding.validated!==true)throw new Error('初发评级身份未核验，禁止写入事实');
      if(!result.rating||!result.rating_outlook)throw new Error('评级或展望解析缺失');
      if(result.rating_date_source==='announcement_fallback') {
        const {rows:dates}=await repository.select_fundamental_convertible_bond_ratings_1([bond.instrument_id,event.event_date,sources.tushare,result.rating,bond.ts_code], client);
        if(dates.length!==1)throw new Error('评级实际日期未唯一核验，不能把公告日写成评级日');
        result.rating_date=dates[0].date;result.rating_date_source='existing_standard_fact';
      }
      const previous=result.rating_requirement_version===RATING_REQUIREMENT_VERSION?[]:result.rating_result_notice?.previous_ratings||[];
      if(result.rating_requirement_version!==RATING_REQUIREMENT_VERSION)await repository.delete_fundamental_convertible_bond_ratings([bond.instrument_id,event.url,[result.rating_date,...previous.map(row=>row.rating_date)]], client);
      for(const row of previous) {
        // Explicit prior results may fill history, but cannot replace a validated current original.
        const {rows:current}=await repository.select_fundamental_convertible_bond_ratings_2([bond.instrument_id,row.rating_date,row.rating_com_name||result.rating_com_name||bond.raw_payload.rating_comp||''], client);
        if(current.some(item=>item.rating!==row.rating))throw new Error('结果公告前次评级与已核验本次原文冲突，保留原事实');
        if(!current.length)await tools.saveRatingHistory(client,bond.instrument_id,[{...result,...row,
          outlook_source_url:result.source_url,ann_date:event.event_date,rating_com_name:row.rating_com_name||result.rating_com_name||bond.raw_payload.rating_comp}],sourceId);
      }
      await tools.saveRatingHistory(client,bond.instrument_id,[{...result,ann_date:event.event_date,rating_com_name:result.rating_com_name||bond.raw_payload.rating_comp}],sourceId);
      if(result.rating_result_notice)await repository.update_fundamental_convertible_bond_ratings([bond.instrument_id,event.url,sourceId,[result.rating_date,...previous.map(row=>row.rating_date)]], client);
      if(result.rating_requirement_version!==RATING_REQUIREMENT_VERSION)await tools.saveRatingOutlooks(client,bond.instrument_id,[result]);
    }
    if(kind==='price_history'&&result.price_changes?.length) await tools.savePriceChanges(client,bond.instrument_id,result.price_changes,sourceId);
    await txControl.commit(client);
  } catch(error){await txControl.rollback(client);throw error;} finally{client.release();}
}

/* persistBondInputs 已迁入 server/repositories/convertibleBondAnalysisInputsRepository.js */

async function markTerminalGap(tsCode,field,{status,reason,evidence,checkedAt}={}) {
  if(!TERMINAL_GAP_STATUSES.includes(String(status||'')))throw new Error('不支持的资料终态：'+status);
  if(!field)throw new Error('资料终态必须指定字段');
  if(!reason)throw new Error('资料终态必须写明原因');
  if(!evidence||typeof evidence!=='object'||!Object.keys(evidence).length)throw new Error('资料终态必须附带证据');
  const {rows}=await repository.select_fundamental_convertible_bond_profiles_1([tsCode]);
  if(!rows.length)throw new Error('未建档的可转债：'+tsCode);
  const payload=rows[0].raw_payload||{};
  const state={...(payload.analysis_inputs||{}),terminal_gaps:{...(payload.analysis_inputs?.terminal_gaps||{}),
    [field]:{status,reason,evidence,checkedAt:checkedAt||new Date().toISOString()}}};
  await repository.update_fundamental_convertible_bond_profiles([rows[0].instrument_id,field,JSON.stringify(state.terminal_gaps[field])]);
  return state.terminal_gaps[field];
}

/* readRatingHistory 已迁入 server/repositories/convertibleBondAnalysisInputsRepository.js */

async function syncConvertibleBondAnalysisInputs({businessDate,targetCodes=[],maxRuntimeMs=10*60000}={},deps={}) {
  const targetDate=isoDate(businessDate);
  if(!targetDate)throw new Error('资料补全必须传入任务目标日');
  const marketDate=await (deps.latestDate||latestAnalysisDate)(targetDate);
  if(!marketDate||marketDate>targetDate)throw new Error('缺少目标日可核验的证券集合');
  const all=await (deps.loadUniverse||loadAnalysisUniverse)(marketDate);
  const codes=targetCodes.map(normalizeBondCode);
  if(codes.some(c=>!c))throw new Error('目标代码格式无效');
  const rows=codes.length?all.filter(b=>codes.includes(b.ts_code)):all;
  if(codes.length&&rows.length!==new Set(codes).size)throw new Error('请求目标不属于目标日上市转债集合');
  const started=Date.now(),remaining=[],failures=[],missingFields={};
  let nextRunAt=new Date(Date.now()+15*60000).toISOString();
  const scopeKey=codes.length?`convertible_bond_analysis:targeted:${sha([...new Set(codes)].sort())}`:'convertible_bond_analysis';
  const previous=deps.readProgress?await deps.readProgress():deps.loadUniverse?null:
    (await repository.select_ops_sync_cursors_1([scopeKey])).rows[0]?.cursor_payload;
  const attemptedCodes=new Set([...(previous?.attemptedCodes||[]),...rows.filter(b=>b.raw_payload.analysis_inputs?.coveredThrough)
    .map(b=>b.ts_code)]);
  // A failed historical PDF cannot keep every later security behind the same batch boundary.
  rows.sort((a,b)=>Number(attemptedCodes.has(a.ts_code))-Number(attemptedCodes.has(b.ts_code)) ||
    (Date.parse(a.raw_payload.analysis_inputs?.lastAttemptAt||'1970-01-01')-Date.parse(b.raw_payload.analysis_inputs?.lastAttemptAt||'1970-01-01')));
  const persist=async(dataset,date,state)=>(deps.persist||persistAnalysisProgress)(dataset,date,{...state,scopeKey});
  let count=0,attempted=0;
  let stoppedForTime=false;
  for(const bond of rows) {
    if(Date.now()-started>=maxRuntimeMs){remaining.push(bond.ts_code);stoppedForTime=true;continue;}
    attempted++;
    attemptedCodes.add(bond.ts_code);
    const state={...(bond.raw_payload.analysis_inputs||{}),documents:{...(bond.raw_payload.analysis_inputs?.documents||{})},parserVersion:INPUT_VERSION,lastAttemptAt:new Date().toISOString()};
    try {
      await (deps.persistBond||persistBondInputs)(bond,state);
      const missing=[];
      if(!state.coveredThrough||state.coveredThrough<targetDate) {
        try {
          await (deps.discover||discoverDocuments)(bond,targetDate,state);
          state.coveredThrough=targetDate;delete state.discoveryError;
        } catch(error) {
          missing.push('discovery');state.discoveryError=error.message;
          failures.push({code:bond.ts_code,error:error.message,errorCode:error.code,errorType:error.errorType,source:error.source,apiName:error.apiName,recoverAt:error.recoverAt});
        }
        await (deps.persistBond||persistBondInputs)(bond,state);
      }
      let events=await (deps.readDocuments||readDocuments)(bond,targetDate);
      let selected=inputDocuments(events,bond,state);
      const repairStart=missingReportRepairStart(bond,state,targetDate,selected);
      const repair=deps.repairReport||(!deps.loadUniverse&&discoverDocuments);
      if(repairStart&&repair) {
        try {
          await repair(bond,targetDate,state,{repairStart});
          state.reportRepair={version:DOCUMENT_SELECTION_VERSION,reportPeriod:requiredReportPeriod(targetDate),checkedThrough:targetDate};
          events=await (deps.readDocuments||readDocuments)(bond,targetDate);
          selected=inputDocuments(events,bond,state);
        } catch(error) {state.reportRepair={...state.reportRepair,lastError:error.message};}
        await (deps.persistBond||persistBondInputs)(bond,state);
      }
      for(const event of events.filter(e=>tools.reportPeriod(e.title)&&!tools.isFullReport(e))) {
        for(const kind of ['holders','price_history']) {
          const key=`${kind}:${event.url}`,prior=state.documents[key];
          if(prior&&prior.status!=='complete')state.documents[key]={...prior,status:'not_applicable',parserVersion:INPUT_VERSION,
            previousFailure:prior.previousFailure||prior.error||null,
            classificationEvidence:{reason:'not_full_periodic_report',title:event.title,url:event.url,announcedAt:isoDate(event.event_date)}};
        }
      }
      state.rating_publication_delays=events.filter(isRatingPublicationDelay).map(event=>({url:event.url,title:event.title,
        announcedAt:isoDate(event.event_date),status:'not_applicable',reason:'publication_delay_is_not_rating_result'}));
      for(const notice of state.rating_publication_delays) {
        const key=`rating:${notice.url}`,prior=state.documents[key];
        state.documents[key]={...prior,status:'not_applicable',parserVersion:INPUT_VERSION,
          classificationEvidence:notice,previousFailure:prior?.previousFailure||prior?.error||null};
      }
      const ratingRecords=await (deps.readRatings||readRatingHistory)(bond,targetDate);
      const ratingDocuments=selected.filter(item=>item.kind==='rating');
      const suspectUrls=await (deps.suspectRatingUrls||suspectRatingUrls)(bond);
      let ratingState=ratingRequirement(bond,ratingRecords,ratingDocuments,targetDate,suspectUrls);
      const keepRatingEvidence=()=>{if(!isoDate(state.rating_requirement?.target_date)||state.rating_requirement.target_date<=targetDate)state.rating_requirement=ratingState;};
      keepRatingEvidence();
      const notices=selected.filter(d=>d.kind==='rating'&&isRatingResultNotice(d.event)).map(d=>d.event);
      const ratingReports=selected.filter(d=>d.kind==='rating'&&!isRatingResultNotice(d.event));
      // 最新评级仍不完整时也必须处理评级结果公告：结果公告本身可能才是本期评级/展望/实际日的唯一原文证据。
      const hasIncompleteReport=ratingReports.some(d=>state.documents[`rating:${d.event.url}`]?.status!=='complete'||suspectUrls.has(d.event.url));
      const needNotices=needRatingResultNotices({reportCount:ratingReports.length,latestComplete:ratingState.latest_complete,hasIncompleteReport});
      state.rating_coverage={};
      const expectedPeriod=requiredReportPeriod(targetDate);
      state.required_report_period=expectedPeriod;
      state.current_report_url=selected.find(d=>d.kind==='holders')?.event.url||null;
      const reportNotDue=isoDate(bond.value_date)>expectedPeriod&&!selected.some(d=>d.kind==='holders');
      state.not_due=reportNotDue?{report_period:expectedPeriod,value_date:isoDate(bond.value_date),fields:['holders','price_history'],basis:'annual_4_months_halfyear_2_months'}:null;
      if(!selected.some(d=>d.kind==='prospectus')&&!terminalGap(state,'prospectus'))missing.push('prospectus');
      if(!selected.some(d=>d.kind==='holders')&&!reportNotDue&&!terminalApplies(terminalGap(state,'holders'),state.current_report_url,expectedPeriod))missing.push('latest_report');
      if(selected.some(d=>d.kind==='holders'&&tools.reportPeriod(d.event.title)<expectedPeriod)&&!terminalApplies(terminalGap(state,'holders'),state.current_report_url,expectedPeriod))missing.push('latest_report_stale');
      for(const {kind,event} of selected) {
        // 有原文结案证据时只跳过这份同字段文档；新报告仍须重新解析核验。
        const coveredTerminal=terminalApplies(terminalGap(state,kind),event.url,expectedPeriod);
        if(kind!=='rating'&&coveredTerminal)continue;
        if(kind==='rating'&&(ratingState.latest_complete||!ratingState.required_document_urls.includes(event.url)))continue;
        if(kind==='issuance_terms'&&!Object.entries(state.documents).some(([key,value])=>key.startsWith('prospectus:')&&['not_disclosed','missing'].includes(value.couponStatus)))continue;
        const key=`${kind}:${event.url}`,prior=state.documents[key];
        const revalidateReport=['holders','price_history'].includes(kind)&&prior?.status==='blocked'&&prior?.documentCapability!==DOCUMENT_SELECTION_VERSION;
        const optionalNotice=kind==='rating'&&isRatingResultNotice(event);
        if(optionalNotice&&!needNotices)continue;
        if(kind==='rating'&&!optionalNotice&&prior?.ratingCapability===RATING_RETRY_CAPABILITY) {
          // 覆盖结论是旧解析能力下算出来的，能力版本一变必须重算一次，否则新解析器永远不生效。
          const coverage=ratingCoverageForReport(event,notices,state.documents,bond,ratingReports);
          if(coverage){state.rating_coverage[event.url]=coverage;continue;}
        }
        const revalidateRating=kind==='rating'&&suspectUrls.has(event.url);
        if(kind!=='rating'&&!revalidateRating&&prior?.status==='complete'&&(prior.parserVersion===INPUT_VERSION||prior.parserVersion==='analysis-input-v3'&&/^[a-f0-9]{64}$/i.test(prior.documentHash||'')&&prior.documentHash===event.content_hash))continue;
        if(!revalidateReport&&!shouldRetryRatingFailure(kind,prior)&&prior?.status==='blocked'&&prior.parserVersion===INPUT_VERSION){if(kind!=='rating'&&!optionalNotice&&!coveredTerminal)missing.push(kind);continue;}
        if(Date.now()-started>=maxRuntimeMs){if(kind!=='rating'&&!optionalNotice&&!coveredTerminal)missing.push(kind);stoppedForTime=true;continue;}
        try {
          const result=await (deps.project||projectDocument)(kind,event,bond);
          if(kind==='rating'){result.rating_requirement_version=RATING_REQUIREMENT_VERSION;validateRatingGrade(result);validateTrackingRatingYear(event,result);validateRatingResultNotice(event,result,bond);}
          if(revalidateRating&&result.rating_date_source!=='official_document')throw new Error('原评级日期疑似前次，缺本次原文实际日期，不能沿用可疑标准日期');
          await (deps.save||saveProjection)(kind,event,result,bond);
          if(kind==='rating') {
            if(revalidateRating&&result.rating_date_source==='official_document')suspectUrls.delete(event.url);
            const record={rating_date:result.rating_date,announced_at:isoDate(event.event_date),
              rating:result.rating,rating_outlook:result.rating_outlook,rating_company:result.rating_com_name,raw_payload:result};
            const priorIndex=ratingRecords.findIndex(row=>isoDate(row.rating_date)===isoDate(record.rating_date)&&row.rating_company===record.rating_company);
            if(priorIndex<0)ratingRecords.push(record);else ratingRecords[priorIndex]=record;
            ratingState=ratingRequirement(bond,ratingRecords,ratingDocuments,targetDate,suspectUrls);
            keepRatingEvidence();
          }
          state.documents[key]={status:'complete',parserVersion:INPUT_VERSION,ratingCapability:RATING_RETRY_CAPABILITY,documentCapability:DOCUMENT_SELECTION_VERSION,documentHash:result.document_hash,couponStatus:result.coupon_status,announcedAt:isoDate(event.event_date)};
          if(state.api_fallbacks?.[kind]){state.api_fallbacks={...state.api_fallbacks};delete state.api_fallbacks[kind];}
          if(kind==='holders'&&result.parse_status==='not_applicable')state.documents[key].holderExemption={...result.holder_exemption,report_date:result.report_date};
          if(optionalNotice)state.documents[key].ratingResult=result;
        } catch(error) {
          const message=String(error.stderr||error.message).trim().split(/\r?\n/).filter(Boolean).at(-1).slice(-600);
          if(prior?.status==='complete'&&!revalidateRating) {
            // 已解析正确的记录不被重试失败覆盖：只留失败痕迹供审计，也不计缺失，避免重跑破坏既有事实。
            // 明确的可疑评级重验除外——那类记录本就不该继续按完整结案。
            state.documents[key]={...prior,lastError:message,attemptedAt:new Date().toISOString()};
          } else {
            if(kind!=='rating'&&!optionalNotice)missing.push(kind);
            state.documents[key]={...prior,previousStatus:prior?.previousStatus||prior?.status,status:message.includes('需要OCR')?'blocked':'failed',parserVersion:INPUT_VERSION,ratingCapability:RATING_RETRY_CAPABILITY,documentCapability:DOCUMENT_SELECTION_VERSION,error:message,announcedAt:isoDate(event.event_date),attemptedAt:new Date().toISOString()};
          }
        }
        await (deps.persistBond||persistBondInputs)(bond,state);
      }
      for(const {event} of ratingReports) {
        const coverage=ratingCoverageForReport(event,notices,state.documents,bond,ratingReports);
        if(coverage)state.rating_coverage[event.url]=coverage;
      }
      if(!ratingState.history_available&&!terminalGap(state,'rating_history'))missing.push('rating_history');
      if(!ratingState.latest_complete&&!terminalGap(state,'rating')&&!terminalGap(state,'rating_history'))missing.push('rating');
      const exemptHolder=selected.filter(d=>d.kind==='holders').map(d=>state.documents[`holders:${d.event.url}`]?.holderExemption).find(e=>e?.report_date===expectedPeriod);
      if(exemptHolder) {
        validateHolderExemption({parse_status:'not_applicable',holder_exemption:exemptHolder,holder_table_bond:bond.bond_short_name,report_date:exemptHolder.report_date},bond);
        state.not_due={report_period:expectedPeriod,fields:['holders'],basis:'official_not_listed_by_report_period',evidence:exemptHolder};
      }
      if(selected.some(({kind,event})=>kind==='prospectus'&&['not_disclosed','missing'].includes(state.documents[`prospectus:${event.url}`]?.couponStatus))&&!selected.some(({kind,event})=>kind==='issuance_terms'&&state.documents[`issuance_terms:${event.url}`]?.status==='complete'))missing.push('coupon_terms');
      // 主源已失败/仍有缺项后才启用已授权的Tushare末级备源；原文失败证据保持原样。
      const fallback=deps.apiFallback||(!deps.loadUniverse&&tryAnalysisApiFallback);
      if(fallback&&Date.now()-started<maxRuntimeMs)for(const kind of new Set(missing.map(field=>field==='rating_history'?'rating':field).filter(field=>FALLBACK_APIS[field]))) {
        const period=expectedPeriod;
        const documentUrls=selected.filter(d=>d.kind===kind).map(d=>d.event.url);
        const result=await fallback({kind,bond,targetDate,period,documentUrls});
        state.api_fallbacks={...(state.api_fallbacks||{}),[kind]:result};
        if(result.status!=='complete') {
          if(result.errorCode)failures.push({code:bond.ts_code,error:result.reason,errorCode:result.errorCode,errorType:result.errorType,source:result.source,apiName:result.apiName,recoverAt:result.recoverAt});
          continue;
        }
        if(kind==='rating') {
          const refreshed=await (deps.readRatings||readRatingHistory)(bond,targetDate);
          ratingRecords.splice(0,ratingRecords.length,...refreshed);
          ratingState=ratingRequirement(bond,ratingRecords,ratingDocuments,targetDate,suspectUrls);keepRatingEvidence();
          if(!ratingState.latest_complete){state.api_fallbacks.rating={...result,status:'incomplete',reason:'备用评级未满足目标日最新评级要求'};continue;}
        }
        for(let index=missing.length-1;index>=0;index--)if(missing[index]===kind||kind==='rating'&&missing[index]==='rating_history')missing.splice(index,1);
      }
      state.missing=[...new Set(missing)];state.status=missing.length?'partial':'complete';state.targetDate=targetDate;
      await (deps.persistBond||persistBondInputs)(bond,state);
      if(missing.length){remaining.push(bond.ts_code);missingFields[bond.ts_code]=state.missing;}else count++;
    } catch(error){remaining.push(bond.ts_code);failures.push({code:bond.ts_code,error:error.message});}
    await persist('inputs',targetDate,{count,expected:rows.length,attemptedCodes:[...attemptedCodes],remaining:[...remaining,...rows.slice(attempted).map(b=>b.ts_code)],missingFields,failures,pendingStages:['analysis_inputs'],nextRunAt});
  }
  const ok=rows.length>0&&!remaining.length;
  const sourceFailure=failures.find(f=>f.errorCode&&['CIRCUIT_OPEN','RATE_LIMIT','BUDGET_WAIT','PERMISSION_DENIED','AUTH_ERROR'].includes(f.errorCode));
  nextRunAt=sourceFailure?.recoverAt||new Date(Date.now()+15*60000).toISOString();
  await persist('inputs',targetDate,{count,expected:rows.length,attemptedCodes:[...attemptedCodes],remaining,missingFields,failures,pendingStages:ok?[]:['analysis_inputs'],nextRunAt:ok?null:nextRunAt});
  return {ok,status:ok?'succeeded':'partial',mode:codes.length?'analysis_inputs_targeted':'analysis_inputs',
    stageComplete:ok,codes:[...new Set(codes)].sort(),targetFields:[],dataAsOf:targetDate,count,attempted,remaining,remainingCount:remaining.length,missingFields,failures,
    publishDatasetCodes:codes.length?[]:['bond_analysis_inputs'],
    datasetDiagnostics:codes.length?{}:{bond_analysis_inputs:{quality_status:ok?'passed':'failed',query_status:ok?'success':'failed',expected_count:rows.length,completed_count:count,object_date:marketDate,remaining_count:remaining.length}},
    publishDatasets:codes.length?[]:ok?['bond_analysis_inputs']:false,
    failedDatasets:ok||codes.length?[]:['bond_analysis_inputs'],pendingStages:ok?[]:['analysis_inputs'],
    continuationRequired:stoppedForTime&&remaining.length>0,nextAttemptInMinutes:15,
    nextRunAt:ok?null:nextRunAt,error:ok?null:'可转债详细分析资料尚未全部完成',errorType:ok?null:'data_quality',
    ...(sourceFailure?{errorCode:sourceFailure.errorCode,errorType:sourceFailure.errorType,source:sourceFailure.source,apiName:sourceFailure.apiName,recoverAt:sourceFailure.recoverAt}:{}),};
}

// 导出面保持不变：纯判定从 domain 层转出，调用方无需改 import。
module.exports={
  syncConvertibleBondAnalysisInputs,projectDocument,suspectRatingUrls,markTerminalGap,
  inputDocuments,requiredReportPeriod,missingReportRepairStart,initialRatingBindingArguments,isRatingPublicationDelay,isRatingResultNotice,
  validateRatingResultNotice,ratingCoverageForReport,validateTrackingRatingYear,validateRatingGrade,validateHolderExemption,issuerNameOf,
  isBondRatingDocument,ratingRequirement,terminalGap,TERMINAL_GAP_STATUSES,shouldRetryRatingFailure,needRatingResultNotices,
  RATING_RETRY_CAPABILITY,INPUT_VERSION,RATING_REQUIREMENT_VERSION
};

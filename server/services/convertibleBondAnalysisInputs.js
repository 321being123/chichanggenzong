// Extend the existing announcement Runner: discovery -> shared documents -> versioned projections.
const {pool}=require('../db/connection');
const {execFile}=require('child_process');
const crypto=require('crypto');
const path=require('path');
const {fetchSseEvents,fetchSzseEvents}=require('./stockAnalysis');
const {saveCollectedEvents}=require('./financialDataArchitecture');
const {childProcessEnv,mergeExternalCallStatsFromStderr}=require('./externalCallGuard');
const {isoDate,normalizeBondCode,announcementDateWindows,analysisInputTools:tools}=require('./convertibleBondAnalysis');
const {loadAnalysisUniverse,persistAnalysisProgress,latestAnalysisDate}=require('./convertibleBondAnalysisSnapshots');

const INPUT_VERSION='analysis-input-v4';
function sha(value){return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');}
async function suspectRatingUrls(bond,query=pool.query.bind(pool)) {
  if(!bond.instrument_id)return new Set();
  const {rows}=await query(`SELECT DISTINCT raw_payload->>'source_url' AS url FROM fundamental.convertible_bond_ratings
    WHERE instrument_id=$1 AND raw_payload->>'rating_date_source'='official_document'
    AND raw_payload->>'rating_context_version' IS DISTINCT FROM 'current-narrative-v1'
    AND NOT raw_payload ? 'identity_binding' AND rating_date<date_trunc('year',announced_at)`,[bond.instrument_id]);
  return new Set(rows.map(row=>row.url).filter(Boolean));
}
async function initialRatingBindingArguments(bond,event,query=pool.query.bind(pool),creditDate=null) {
  const size=Number(bond.raw_payload?.issue_size),issued=isoDate(bond.value_date),maturity=isoDate(bond.maturity_date),announced=isoDate(event.event_date);
  if(!(size>0&&issued&&maturity&&announced&&maturity.slice(5)===issued.slice(5)&&announced<=issued))return [];
  const args=['--initial-issue-size-yuan',String(size),'--initial-tenor-years',String(Number(maturity.slice(0,4))-Number(issued.slice(0,4)))];
  if(!creditDate)return args;
  const {rows}=await query(`SELECT COUNT(*)::int AS matches,BOOL_OR(p.instrument_id=$3) AS is_target FROM fundamental.convertible_bond_profiles p
    JOIN core.instruments s ON s.instrument_id=p.stock_instrument_id WHERE s.canonical_code=$1 AND p.issue_size=$2
    AND p.value_date BETWEEN $4::date AND $5::date`,[bond.stock_code,size,bond.instrument_id,creditDate,issued]);
  return rows[0]?.matches===1&&rows[0]?.is_target===true?
    args:[];
}

async function projectDocument(kind,event,bond) {
  const scripts={prospectus:'Prospectus',issuance_terms:'Prospectus',holders:'FundHoldings',rating:'Rating',price_history:'PriceHistory'};
  const script=path.join(__dirname,'..','scripts',`extractConvertibleBond${scripts[kind]}.py`);
  const args=[script,event.url,'--security-code',bond.stock_code];
  if(kind!=='prospectus')args.push('--bond-name',bond.bond_short_name);
  const issuer=(bond.bond_full_name||'').match(/^(.+?(?:股份有限公司|有限责任公司))/)?.[1];
  if(issuer)args.push('--issuer-name',issuer);
  if(kind==='rating') {
    args.push('--announcement-date',isoDate(event.event_date));
    if(bond.value_date)args.push('--issue-date',isoDate(bond.value_date));
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

async function readDocuments(bond,targetDate) {
  const {rows}=await pool.query(`SELECT DISTINCT d.document_id,d.url,d.title,d.content_hash,d.announced_at::text AS event_date,
    ds.source_code AS source,d.raw_payload FROM event.documents d
    JOIN ops.data_sources ds USING(source_id) JOIN core.company_instruments ci USING(company_id)
    JOIN core.instruments i ON i.instrument_id=ci.instrument_id
    WHERE i.canonical_code=$1 AND d.announced_at<=$2::date AND d.url<>'' ORDER BY event_date DESC`,[bond.stock_code,targetDate]);
  return rows;
}

async function discoverDocuments(bond,targetDate,state) {
  const scopeKey=`bond_analysis_documents:${bond.stock_code}`;
  const {rows:coverage}=await pool.query(`SELECT last_success_date::text FROM ops.sync_cursors WHERE scope_key=$1 AND dataset_code='official_documents'`,[scopeKey]);
  const cursor=coverage[0]?.last_success_date||state.coveredThrough;
  if(cursor&&cursor>=targetDate)return [];
  const {rows:dates}=await pool.query(`SELECT MIN(p.value_date)::text AS date FROM fundamental.convertible_bond_profiles p
    JOIN core.instruments s ON s.instrument_id=p.stock_instrument_id WHERE s.canonical_code=$1`,[bond.stock_code]);
  const firstDate=dates[0]?.date||isoDate(bond.value_date);
  if(!firstDate)throw new Error('发行生效日期缺失，无法确定首次公告范围');
  const from=cursor?new Date(`${cursor}T00:00:00+08:00`):new Date(`${firstDate}T00:00:00+08:00`);
  from.setUTCDate(from.getUTCDate()-(cursor?3:365));
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
    if(rawRecords.length)await pool.query(`WITH saved AS (
      INSERT INTO ops.raw_records(source_id,dataset_code,source_key,payload,payload_hash)
      SELECT source_id,'official_company_announcements',source_key,payload,payload_hash FROM
      jsonb_to_recordset($1::jsonb) AS r(source_id smallint,source_key text,payload jsonb,payload_hash text)
      ON CONFLICT(source_id,dataset_code,source_key,payload_hash) DO UPDATE SET payload=EXCLUDED.payload
      RETURNING raw_record_id,source_id,payload
    ) UPDATE event.documents d SET raw_record_id=saved.raw_record_id FROM saved
      WHERE d.source_id=saved.source_id AND d.url=saved.payload->>'url'`,[JSON.stringify(rawRecords)]);
    await pool.query(`INSERT INTO ops.sync_cursors(scope_key,dataset_code,last_success_date,cursor_payload,last_attempt_at)
      VALUES($1,'official_documents',$2,$3::jsonb,now()) ON CONFLICT(scope_key,dataset_code) DO UPDATE SET
      last_success_date=GREATEST(ops.sync_cursors.last_success_date,EXCLUDED.last_success_date),cursor_payload=EXCLUDED.cursor_payload,last_attempt_at=now(),updated_at=now()`,
      [scopeKey,window.end,JSON.stringify({query_status:result.events.length?'success':'verified_no_change',complete:true,start:window.start,end:window.end,count:result.events.length})]);
  }
  return events;
}

async function saveProjection(kind,event,result,bond) {
  if(!/^[a-f0-9]{64}$/i.test(result.document_hash||'')) throw new Error('原文SHA-256缺失或无效，保留原投影');
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const sources=await tools.sourceIds(client);
    const sourceId=sources[event.source];
    if(!sourceId)throw new Error('公告来源未登记');
    const record=(await client.query(`INSERT INTO ops.raw_records(source_id,dataset_code,source_key,payload,payload_hash)
      VALUES($1,'bond_analysis_inputs',$2,$3::jsonb,$4) ON CONFLICT(source_id,dataset_code,source_key,payload_hash)
      DO UPDATE SET payload=EXCLUDED.payload RETURNING raw_record_id`,
    [sourceId,`${event.url}:${kind}:${INPUT_VERSION}`,JSON.stringify(result),sha(result)])).rows[0];
    await client.query(`UPDATE event.documents d SET content_hash=CASE WHEN NOT EXISTS(SELECT 1 FROM event.documents other
      WHERE other.source_id=d.source_id AND other.url=d.url AND other.content_hash=$2 AND other.document_id<>d.document_id) THEN $2 ELSE d.content_hash END,raw_record_id=$3,
      raw_payload=raw_payload || jsonb_build_object('analysis_projections',COALESCE(raw_payload->'analysis_projections','{}'::jsonb)||$4::jsonb)
    WHERE document_id=$1`,[event.document_id,result.document_hash,record.raw_record_id,JSON.stringify({[kind]:{...result,parser_version:INPUT_VERSION}})]);
    if(kind==='prospectus'||kind==='issuance_terms') {
      if(kind==='prospectus'&&!result.fundraising_purpose)throw new Error('募集用途解析缺失');
      if(!result.coupon_rates?.length && !(kind==='prospectus'&&result.coupon_status==='not_disclosed'))throw new Error('完整票息解析缺失');
      const years=Number(isoDate(bond.maturity_date)?.slice(0,4))-Number(isoDate(bond.value_date)?.slice(0,4));
      if(result.coupon_rates?.length&&years>0&&(result.coupon_rates.length!==years||result.coupon_rates.some((rate,index)=>rate.interest_year!==index+1)))throw new Error('票息年限未完整覆盖目标债券，保留原事实');
      await tools.saveProspectusDetails(client,bond.instrument_id,bond,result,sourceId);
    }
    if(kind==='holders') {
      if(result.parse_status!=='complete')throw new Error('定期报告未披露可唯一核验的持有人表');
      await tools.saveReportFundHolding(client,bond.instrument_id,result,sourceId);
    }
    if(kind==='rating') {
      if(result.identity_binding&&result.identity_binding.validated!==true)throw new Error('初发评级身份未核验，禁止写入事实');
      if(!result.rating||!result.rating_outlook)throw new Error('评级或展望解析缺失');
      if(result.rating_date_source==='announcement_fallback') {
        const {rows:dates}=await client.query(`SELECT DISTINCT rating_date::text AS date FROM fundamental.convertible_bond_ratings
          WHERE instrument_id=$1 AND announced_at=$2::date AND rating=$4 AND
          (source_id=$3 OR (raw_payload->>'ts_code'=$5 AND raw_payload->>'ann_date'=replace($2::text,'-','') AND raw_payload ? 'rating_way'))`,
          [bond.instrument_id,event.event_date,sources.tushare,result.rating,bond.ts_code]);
        if(dates.length!==1)throw new Error('评级实际日期未唯一核验，不能把公告日写成评级日');
        result.rating_date=dates[0].date;result.rating_date_source='existing_standard_fact';
      }
      await client.query(`DELETE FROM fundamental.convertible_bond_ratings WHERE instrument_id=$1
        AND raw_payload->>'source_url'=$2 AND raw_payload ? 'document_hash' AND rating_date<>$3::date`,[bond.instrument_id,event.url,result.rating_date]);
      await tools.saveRatingHistory(client,bond.instrument_id,[{...result,ann_date:event.event_date,rating_com_name:bond.raw_payload.rating_comp}],sourceId);
      await tools.saveRatingOutlooks(client,bond.instrument_id,[result]);
    }
    if(kind==='price_history'&&result.price_changes?.length) await tools.savePriceChanges(client,bond.instrument_id,result.price_changes,sourceId);
    await client.query('COMMIT');
  } catch(error){await client.query('ROLLBACK');throw error;} finally{client.release();}
}

async function persistBondInputs(bond,state) {
  await pool.query(`UPDATE fundamental.convertible_bond_profiles SET raw_payload=raw_payload||jsonb_build_object('analysis_inputs',$2::jsonb),updated_at=now()
    WHERE instrument_id=$1`,[bond.instrument_id,JSON.stringify(state)]);
}

function isRatingPublicationDelay(event) {
  const title=String(event.title||'').trim();
  return /(?:延迟|延期)披露.*评级报告(?:的)?公告$/.test(title)&&!/评级调整|信用等级.*调整|调整.*信用等级/.test(title);
}

function inputDocuments(events,bond={}) {
  const selected=[];
  const issueDate=isoDate(bond.value_date);
  const prospectus=tools.latestProspectus(events.filter(e=>!issueDate||isoDate(e.event_date)<=issueDate&&isoDate(e.event_date)>=`${Number(issueDate.slice(0,4))-1}${issueDate.slice(4)}`)),
    report=tools.latestFullReport(events.filter(e=>!issueDate||tools.reportPeriod(e.title)>=issueDate));
  if(prospectus)selected.push({kind:'prospectus',event:prospectus});
  if(issueDate) {
    const issuance=events.filter(e=>/发行公告|上市公告书/.test(e.title)&&isoDate(e.event_date)>=`${Number(issueDate.slice(0,4))-1}${issueDate.slice(4)}`)
      .sort((a,b)=>Math.abs(new Date(isoDate(a.event_date))-new Date(issueDate))-Math.abs(new Date(isoDate(b.event_date))-new Date(issueDate)))[0];
    if(issuance)selected.push({kind:'issuance_terms',event:issuance});
  }
  if(report)selected.push({kind:'holders',event:report},{kind:'price_history',event:report});
  for(const event of events.filter(e=>!isRatingPublicationDelay(e)&&/评级报告|评级调整/.test(e.title)&&(!issueDate||
    isoDate(e.event_date)>=issueDate||isoDate(e.event_date)>=`${Number(issueDate.slice(0,4))-1}${issueDate.slice(4)}`&&/可转债|可转换公司债券/.test(e.title))))selected.push({kind:'rating',event});
  return selected;
}

// Securities Law reporting periods: annual reports within four months; half-year within two.
function requiredReportPeriod(targetDate) {
  const year=Number(targetDate.slice(0,4)),month=Number(targetDate.slice(5,7));
  return month>=9?`${year}-06-30`:month>=5?`${year-1}-12-31`:`${year-1}-06-30`;
}

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
    (await pool.query("SELECT cursor_payload FROM ops.sync_cursors WHERE scope_key=$1 AND dataset_code='inputs'",[scopeKey])).rows[0]?.cursor_payload;
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
      const events=await (deps.readDocuments||readDocuments)(bond,targetDate);
      state.rating_publication_delays=events.filter(isRatingPublicationDelay).map(event=>({url:event.url,title:event.title,
        announcedAt:isoDate(event.event_date),status:'not_applicable',reason:'publication_delay_is_not_rating_result'}));
      for(const notice of state.rating_publication_delays) {
        const key=`rating:${notice.url}`,prior=state.documents[key];
        state.documents[key]={...prior,status:'not_applicable',parserVersion:INPUT_VERSION,
          classificationEvidence:notice,previousFailure:prior?.previousFailure||prior?.error||null};
      }
      const selected=inputDocuments(events,bond);
      const suspectUrls=await (deps.suspectRatingUrls||suspectRatingUrls)(bond);
      const expectedPeriod=requiredReportPeriod(targetDate);
      const reportNotDue=isoDate(bond.value_date)>expectedPeriod&&!selected.some(d=>d.kind==='holders');
      state.not_due=reportNotDue?{report_period:expectedPeriod,value_date:isoDate(bond.value_date),fields:['holders','price_history'],basis:'annual_4_months_halfyear_2_months'}:null;
      if(!selected.some(d=>d.kind==='prospectus'))missing.push('prospectus');
      if(!selected.some(d=>d.kind==='holders')&&!reportNotDue)missing.push('latest_report');
      if(selected.some(d=>d.kind==='holders'&&tools.reportPeriod(d.event.title)<expectedPeriod))missing.push('latest_report_stale');
      if(!selected.some(d=>d.kind==='rating'))missing.push('rating_report');
      for(const {kind,event} of selected) {
        if(kind==='issuance_terms'&&!Object.entries(state.documents).some(([key,value])=>key.startsWith('prospectus:')&&value.couponStatus==='not_disclosed'))continue;
        const key=`${kind}:${event.url}`,prior=state.documents[key];
        const revalidateRating=kind==='rating'&&suspectUrls.has(event.url);
        if(!revalidateRating&&prior?.status==='complete'&&(prior.parserVersion===INPUT_VERSION||prior.parserVersion==='analysis-input-v3'&&/^[a-f0-9]{64}$/i.test(prior.documentHash||'')&&prior.documentHash===event.content_hash))continue;
        if(prior?.status==='blocked'&&prior.parserVersion===INPUT_VERSION){missing.push(kind);continue;}
        if(Date.now()-started>=maxRuntimeMs){missing.push(kind);stoppedForTime=true;continue;}
        try {
          const result=await (deps.project||projectDocument)(kind,event,bond);
          if(revalidateRating&&result.rating_date_source!=='official_document')throw new Error('原评级日期疑似前次，缺本次原文实际日期，不能沿用可疑标准日期');
          await (deps.save||saveProjection)(kind,event,result,bond);
          state.documents[key]={status:'complete',parserVersion:INPUT_VERSION,documentHash:result.document_hash,couponStatus:result.coupon_status,announcedAt:isoDate(event.event_date)};
        } catch(error) {missing.push(kind);const message=String(error.stderr||error.message).trim().split(/\r?\n/).filter(Boolean).at(-1).slice(-600);state.documents[key]={status:message.includes('需要OCR')?'blocked':'failed',parserVersion:INPUT_VERSION,error:message,attemptedAt:new Date().toISOString()};}
        await (deps.persistBond||persistBondInputs)(bond,state);
      }
      if(Object.entries(state.documents).some(([key,value])=>key.startsWith('prospectus:')&&value.couponStatus==='not_disclosed')&&!Object.entries(state.documents).some(([key,value])=>key.startsWith('issuance_terms:')&&value.status==='complete'))missing.push('coupon_terms');
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
module.exports={syncConvertibleBondAnalysisInputs,inputDocuments,projectDocument,requiredReportPeriod,initialRatingBindingArguments,isRatingPublicationDelay,suspectRatingUrls,INPUT_VERSION};

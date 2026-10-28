const layerSql = require('../repositories/convertibleBondAnalysisInputsRepository');
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
const {tryAnalysisApiFallback,terminalApplies,APIS:FALLBACK_APIS}=require('./convertibleBondAnalysisFallback');
const txControl = require('../repositories/transactionControl');
const { persistBondInputs, readDocuments, readRatingHistory } = require('../repositories/convertibleBondAnalysisInputsRepository.js');
const repository = require('../repositories/convertibleBondAnalysisInputsRepository.js');

const INPUT_VERSION='analysis-input-v4';
const DOCUMENT_SELECTION_VERSION='bond-doc-selection-2026-10-24-v2';
const RATING_REQUIREMENT_VERSION='latest-complete-history-present-v1';
// 评级解析能力版本：只用于让历史 failed 文档在解析器/执行环境改进后重试一次，
// 不影响 complete 文档（它们仍按 INPUT_VERSION 跳过），避免全量重算。
const RATING_RETRY_CAPABILITY='rating-retry-2026-10-24e';
function shouldRetryRatingFailure(kind,prior) {
  return kind==='rating'&&prior?.status==='failed'&&prior?.ratingCapability!==RATING_RETRY_CAPABILITY;
}
// 评级结果公告是否需要处理：报告缺失、报告解析不完整，或最新评级本身仍不完整（缺展望/实际日等）。
function needRatingResultNotices({reportCount,latestComplete,hasIncompleteReport}) {
  if(!reportCount)return true;
  if(hasIncompleteReport)return true;
  return latestComplete===false;
}
function sha(value){return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');}
function validateRatingGrade(result) {
  if(result.rating_conflicts?.length)throw new Error(`目标债项本次评级结论冲突，保留原事实：${JSON.stringify(result.rating_conflicts)}`);
}
async function suspectRatingUrls(bond,query=pool.query.bind(pool)) {
  if(!bond.instrument_id)return new Set();
  const {rows}=await layerSql.suspectRatingUrlsQuery1(query, [bond.instrument_id]);
  return new Set(rows.map(row=>row.url).filter(Boolean));
}
function validateTrackingRatingYear(event,output) {
  const years=[...new Set([...String(event.title||'').normalize('NFKC').replace(/\s+/g,'').matchAll(/(20\d{2})年(?:度)?(?:定期)?跟踪(?:信用)?评级(?:报告|结果)/g)].map(match=>match[1]))];
  if(years.length===1&&output.rating_date_source==='official_document'&&output.rating_date?.slice(0,4)!==years[0]&&
    !['current_explicit_label','current_summary_table','current_report_issuance'].includes(output.rating_date_context)) {
    throw new Error('跟踪报告年度与未限定本次的评级日期不一致，疑似历史日期，保留待核验');
  }
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

// 发行人全称：交易所公告里“股份有限公司/有限责任公司/股份公司”三种写法都存在。
function issuerNameOf(fullName) {
  return String(fullName||'').match(/^(.+?(?:股份有限公司|有限责任公司|股份公司))/)?.[1];
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

function validateHolderExemption(result,bond) {
  const exemption=result.holder_exemption,period=isoDate(result.report_date),listed=isoDate(bond.list_date);
  if(result.parse_status!=='not_applicable'||!period||!listed||listed<=period||exemption?.reason!=='not_listed_by_report_period'
    ||exemption.listing_date!==listed||exemption.bond_name!==bond.bond_short_name||result.holder_table_bond!==bond.bond_short_name
    ||!exemption.evidence?.includes('未上市'))throw new Error('持有人不适用缺少目标债券、报告期和实际上市日一致证据');
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

// 资料终态：来源确实未覆盖、原文明确未披露、或存在无法消解的证据冲突。
// 终态只用于停止每日重试并保留证据，不改变“已完整”事实；无证据不得写入。
const TERMINAL_GAP_STATUSES=Object.freeze(['source_unavailable','not_disclosed','conflict']);

function terminalGap(state,field) {
  const item=state&&state.terminal_gaps&&state.terminal_gaps[field];
  return item&&TERMINAL_GAP_STATUSES.includes(String(item.status||''))?item:null;
}

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

function isRatingPublicationDelay(event) {
  const title=String(event.title||'').trim();
  return /(?:延迟|延期)披露.*评级报告(?:的)?公告$/.test(title)&&!/评级调整|信用等级.*调整|调整.*信用等级/.test(title);
}

function isRatingResultNotice(event) {
  return /评级结果(?:的)?公告$/.test(String(event.title||''))&&!isRatingPublicationDelay(event);
}

function validateRatingResultNotice(event,result,bond) {
  if(!isRatingResultNotice(event))return;
  const notice=result.rating_result_notice;
  if(!['sse','szse'].includes(event.source)||notice?.version!=='named-result-v1'||notice.bond_code!==bond.ts_code||
    notice.bond_name!==bond.bond_short_name||!notice.issuer_name||!String(bond.bond_full_name||'').startsWith(notice.issuer_name)||
    !result.rating_com_name||notice.rating_company!==result.rating_com_name||
    result.source_url!==event.url||!/^[a-f0-9]{64}$/i.test(result.document_hash||'')||!result.rating||!result.rating_outlook||result.rating_conflicts?.length||
    result.rating_date_source!=='official_document'||!result.rating_date||result.rating_date>isoDate(event.event_date)||
    notice.report_reference?.issued_at!==result.rating_date||!String(notice.report_reference.title||'').includes(notice.issuer_name)) {
    throw new Error('评级结果公告缺目标代码、发行人或本次原文证据，禁止替代报告');
  }
  for(const prior of result.rating_requirement_version===RATING_REQUIREMENT_VERSION?[]:notice.previous_ratings||[])if(!prior.rating||!prior.rating_outlook||!prior.date_evidence||!prior.rating_evidence||
    prior.rating_com_name!==result.rating_com_name||
    prior.rating_date_source!=='official_document'||prior.rating_date_context!=='explicit_previous_named_bond'||!prior.rating_date||prior.rating_date>=result.rating_date) {
    throw new Error('结果公告前次评级缺独立债项、实际日与展望证据');
  }
}

function readValidatedRatingNotice(event,documents,bond) {
  const saved=documents[`rating:${event.url}`];
  if(saved?.status!=='complete'||saved.parserVersion!==INPUT_VERSION||!saved.ratingResult||saved.documentHash!==saved.ratingResult.document_hash)return null;
  try{validateRatingResultNotice(event,saved.ratingResult,bond);return saved.ratingResult;}catch{return null;}
}

function ratingCoverageForReport(event,notices,documents,bond,reports=[]) {
  const normalize=value=>String(value||'').normalize('NFKC').replace(/\s+/g,'');
  const title=normalize(event.title),issued=isoDate(bond.value_date),listed=isoDate(bond.list_date)||issued;
  const candidates=[];
  for(const noticeEvent of notices) {
    const result=readValidatedRatingNotice(noticeEvent,documents,bond);
    if(!result)continue;
    if(noticeEvent.source!==event.source)continue;
    const notice=result.rating_result_notice,reference=notice.report_reference;
    let date=null,method=null;
    const samePublication=isoDate(noticeEvent.event_date)===isoDate(event.event_date);
    const datedTracking=new RegExp(`${reference.issued_at.slice(0,4)}年(?:度)?(?:定期)?(?:信用)?跟踪`).test(title)&&
      isoDate(event.event_date)>=reference.issued_at;
    if(normalize(reference.title)===title&&(samePublication||datedTracking)) {
      const urls=new Set(reports.filter(item=>item.event.source===event.source&&normalize(item.event.title)===title).map(item=>item.event.url));
      if(urls.size>1||(!samePublication&&urls.size!==1))continue;
      date=reference.issued_at;method='exact_report_reference';
    } else if(issued&&listed&&isoDate(event.event_date)<=listed&&isoDate(event.event_date)<=isoDate(noticeEvent.event_date)) {
      const prefix=normalize(notice.issuer_name);
      const suffix=title.startsWith(prefix)?title.slice(prefix.length):'';
      if(/^(?:公开发行(?:A股)?|向不特定对象发行)可转换公司债券(?:信用)?评级报告(?:[（(]修订稿[）)])?$/.test(suffix)) {
        for(const prior of notice.previous_ratings||[])if(prior.rating_date<=issued) {
          candidates.push({notice_url:noticeEvent.url,document_hash:result.document_hash,rating_date:prior.rating_date,
            rating:prior.rating,method:'explicit_named_bond_previous_rating',evidence:prior.rating_evidence});
        }
      }
    }
    if(method)candidates.push({notice_url:noticeEvent.url,document_hash:result.document_hash,rating_date:date,
      report_announced_at:isoDate(event.event_date),notice_announced_at:isoDate(noticeEvent.event_date),
      match_scope:samePublication?'same_publication_date':'unique_annual_report_reference',
      rating:result.rating,method,evidence:reference});
  }
  if(new Set(candidates.map(row=>`${row.rating_date}:${row.rating}`)).size!==1)return null;
  return candidates.length?{status:'covered_by_official_result_notice',...candidates[0]}:null;
}

// 主体（发行人）信用评级报告不含本债债项结论，不能当债项评级来源；
// 债项报告标题必须提到可转债/可转换公司债券/转债，或本身就是评级结果公告。
function isBondRatingDocument(event) {
  const title=String(event?.title||'');
  if(isRatingResultNotice(event)||/评级调整|信用等级.*调整|调整.*信用等级/.test(title))return true;
  if(/可转债|可转换公司债券|转债/.test(title))return true;
  return !/主体|发行人|公司信用评级报告|年度.{0,12}信用评级报告/.test(title);
}

function inputDocuments(events,bond={},state=null) {
  const selected=[];
  const issueDate=isoDate(bond.value_date);
  // 已解析完成的文件优先锁定：同一发行的旧版/更正版同名文件不得在重跑中被无声换绑。
  const boundUrl=kind=>{
    const rows=Object.entries(state?.documents||{})
      .filter(([key,value])=>key.startsWith(`${kind}:`)&&value?.status==='complete')
      .map(([key,value])=>({url:key.slice(kind.length+1),announcedAt:String(value?.announcedAt||'')}))
      .sort((a,b)=>b.announcedAt.localeCompare(a.announcedAt)||a.url.localeCompare(b.url));
    return rows.length?rows[0].url:null;
  };
  const prospectus=tools.latestProspectus(events.filter(e=>!issueDate||isoDate(e.event_date)<=issueDate&&isoDate(e.event_date)>=`${Number(issueDate.slice(0,4))-1}${issueDate.slice(4)}`),{allowGeneric:true,preferUrl:boundUrl('prospectus')}),
    report=tools.latestFullReport(events.filter(e=>!issueDate||tools.reportPeriod(e.title)>=issueDate));
  if(prospectus)selected.push({kind:'prospectus',event:prospectus});
  if(issueDate) {
    // 更正公告/提示公告只是"通知"，不含条款正文，不能与真正的发行公告/上市公告书并列择优。
    const issuanceCandidates=events.filter(e=>/发行公告|上市公告书/.test(e.title)
        &&!/更正公告|提示(?:性)?公告|摘要|申报稿|上会稿|反馈|补充法律意见/.test(e.title)
        &&isoDate(e.event_date)>=`${Number(issueDate.slice(0,4))-1}${issueDate.slice(4)}`);
    const boundIssuance=boundUrl('issuance_terms');
    const issuance=(boundIssuance&&issuanceCandidates.find(e=>e.url===boundIssuance))||issuanceCandidates
      .sort((a,b)=>{
        const dist=e=>Math.abs(new Date(isoDate(e.event_date))-new Date(issueDate));
        const correction=e=>/更正版|修订版|更新版|更正后/.test(e.title)?0:1;
        return dist(a)-dist(b)||correction(a)-correction(b)||String(a.url).localeCompare(String(b.url));
      })[0];
    if(issuance)selected.push({kind:'issuance_terms',event:issuance});
  }
  if(report)selected.push({kind:'holders',event:report},{kind:'price_history',event:report});
  for(const event of events.filter(e=>!isRatingPublicationDelay(e)&&isBondRatingDocument(e)&&(/评级报告|评级调整/.test(e.title)||
    isRatingResultNotice(e)&&bond.bond_short_name)&&(!issueDate||
    isoDate(e.event_date)>=issueDate||isoDate(e.event_date)>=`${Number(issueDate.slice(0,4))-1}${issueDate.slice(4)}`&&/可转债|可转换公司债券/.test(e.title))))selected.push({kind:'rating',event});
  return [...selected.filter(d=>d.kind==='rating'&&isRatingResultNotice(d.event)).sort((a,b)=>String(a.event.event_date).localeCompare(String(b.event.event_date))),
    ...selected.filter(d=>d.kind!=='rating'||!isRatingResultNotice(d.event))];
}

// Securities Law reporting periods: annual reports within four months; half-year within two.
function requiredReportPeriod(targetDate) {
  const year=Number(targetDate.slice(0,4)),month=Number(targetDate.slice(5,7));
  return month>=9?`${year}-06-30`:month>=5?`${year-1}-12-31`:`${year-1}-06-30`;
}

function missingReportRepairStart(bond,state,targetDate,selected) {
  const period=requiredReportPeriod(targetDate);
  if(!isoDate(bond.value_date)||isoDate(bond.value_date)>period||selected.some(d=>d.kind==='holders'&&tools.reportPeriod(d.event.title)>=period))return null;
  const prior=state.reportRepair;
  const covered=prior?.version===DOCUMENT_SELECTION_VERSION&&prior.reportPeriod===period?isoDate(prior.checkedThrough):null;
  if(covered&&covered>=targetDate)return null;
  const start=new Date(`${covered||period}T00:00:00+08:00`);
  start.setUTCDate(start.getUTCDate()+1);
  return isoDate(start);
}

/* readRatingHistory 已迁入 server/repositories/convertibleBondAnalysisInputsRepository.js */

function ratingRequirement(bond,records,documents,targetDate,suspectUrls=new Set()) {
  const available=records.filter(row=>row.rating&&isoDate(row.rating_date)&&isoDate(row.rating_date)<=targetDate&&
    (!row.announced_at||isoDate(row.announced_at)<=targetDate));
  available.sort((a,b)=>String(isoDate(b.rating_date)).localeCompare(String(isoDate(a.rating_date)))||
    String(isoDate(b.announced_at)||'').localeCompare(String(isoDate(a.announced_at)||'')));
  const latest=available[0],raw=latest?.raw_payload||{},date=isoDate(latest?.rating_date),announced=isoDate(latest?.announced_at);
  // 只有“评级结果公告”才可能携带比既有事实更新的评级；后面发布的评级报告只是复盘同一结论，
  // 不能因为它日期更晚就把接口/既有的最新评级判成不完整。
  const newestDocumentDate=documents.filter(item=>isRatingResultNotice(item.event||{})).map(item=>isoDate(item.event.event_date)).filter(Boolean).sort().at(-1);
  const requiredDocumentDate=newestDocumentDate||documents.map(item=>isoDate(item.event.event_date)).filter(Boolean).sort().at(-1);
  const documentIdentity=/^[a-f0-9]{64}$/i.test(raw.document_hash||'')&&
    (raw.rating_result_notice?raw.rating_result_notice.bond_code===bond.ts_code&&
      raw.rating_result_notice.bond_name===bond.bond_short_name&&raw.rating_result_notice.rating_company===latest.rating_company:
      raw.identity_binding?raw.identity_binding.validated===true&&String(raw.identity_binding.instrument_id)===String(bond.instrument_id):
      raw.bond_name===bond.bond_short_name&&raw.security_code===bond.stock_code);
  const identity=raw.document_hash?documentIdentity:raw.ts_code===bond.ts_code;
  const actualDate=['official_document','existing_standard_fact'].includes(raw.rating_date_source)||
    !raw.rating_date_source&&raw.ts_code===bond.ts_code;
  const sameLatest=available.filter(row=>isoDate(row.rating_date)===date&&isoDate(row.announced_at)===announced);
  const conflict=new Set(sameLatest.map(row=>row.rating)).size>1||raw.rating_conflicts?.length>0;
  // 接口来源（cb_rating）多数不提供展望：展望留空但已标注 api_unavailable 时，不得当作缺项否决，
  // 也不得默认成“稳定”；原文来源仍必须给出展望。
  const outlookApiMissing=raw.outlook_status==='api_unavailable';
  const complete=Boolean(latest&&identity&&actualDate&&!conflict&&!suspectUrls.has(raw.source_url)&&latest.rating_company&&(latest.rating_outlook||outlookApiMissing)&&
    raw.rating===latest.rating&&raw.rating_com_name===latest.rating_company&&(outlookApiMissing||raw.rating_outlook===latest.rating_outlook)&&
    isoDate(raw.rating_date)===date&&announced&&date<=announced&&
    !/主体|发行人/.test(String(raw.rating_type||''))&&(!newestDocumentDate||announced>=newestDocumentDate));
  return {version:RATING_REQUIREMENT_VERSION,target_date:targetDate,history_available:available.length>0,history_count:available.length,
    latest_complete:complete,latest_rating_date:date||null,latest_announced_at:announced||null,
    latest_rating:latest?.rating||null,latest_agency:latest?.rating_company||null,
    latest_outlook:complete?latest.rating_outlook:null,outlook_status:outlookApiMissing?'api_unavailable':'original',
    required_document_urls:complete?[]:documents.filter(item=>isoDate(item.event.event_date)===requiredDocumentDate).map(item=>item.event.url)};
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
module.exports={syncConvertibleBondAnalysisInputs,inputDocuments,projectDocument,requiredReportPeriod,missingReportRepairStart,initialRatingBindingArguments,isRatingPublicationDelay,isRatingResultNotice,validateRatingResultNotice,ratingCoverageForReport,suspectRatingUrls,validateTrackingRatingYear,validateRatingGrade,validateHolderExemption,issuerNameOf,isBondRatingDocument,ratingRequirement,markTerminalGap,terminalGap,TERMINAL_GAP_STATUSES,shouldRetryRatingFailure,needRatingResultNotices,RATING_RETRY_CAPABILITY,INPUT_VERSION,RATING_REQUIREMENT_VERSION};

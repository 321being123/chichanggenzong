// 持仓分红扩展统一官方公告采集，原文/事实分别存既有 raw_records、documents、corporate_actions。
const {pool}=require('../db/connection');
const CoreDate=require('../../public/shared/core-date');
const {resolveInstrument}=require('./securityIdentity');
const crypto=require('crypto');
const PARSER='cash-dividend-v6';
function normalizeChineseDates(text){
  const digits={'零':0,'〇':0,'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9};
  const n=s=>s.includes('十')?Number(s.split('十')[0]?digits[s.split('十')[0]]:1)*10+Number(s.split('十')[1]?digits[s.split('十')[1]]:0):Number([...s].map(c=>digits[c]).join(''));
  return String(text||'').normalize('NFKC').replace(/\s+/g,'').replace(/([二零〇一三四五六七八九]{4})年([一二三四五六七八九十]{1,3})月([一二三四五六七八九十]{1,3})日/g,(_,y,m,d)=>`${n(y)}年${n(m)}月${n(d)}日`);
}
// 补充说明只关联已核验同发行人的标准股息表，不再制造第二笔公司行动。
function resolveHkRelatedDocument(text,identity,references,{announcedAt}={}){
  const compact=normalizeChineseDates(text).replace(/\s+/g,''),bare=String(identity.canonical_code||identity.code).split('.')[0];
  const stock=compact.match(/(?:股份代號|股份代号|Stockcode)[:：]?(\d{1,6})/i);
  if(stock&&Number(stock[1])!==Number(bare))return null;
  const aCode=compact.match(/(?:证券代码|證券代碼)[:：]?(\d{6})/);
  if(stock&&aCode&&/海外監管公告/.test(compact)&&/上海[證证]券交易所/.test(compact)&&/尚需提交公司股[东東][会會]審?议|尚需提交公司股东会审议|拟向全体股东/.test(compact))return {classification:'excluded_a_share_regulatory_proposal',identityBasis:'explicit_hk_cover_and_a_share_attachment',attachmentCode:aCode[1],sourceExcerpt:compact.slice(Math.max(0,compact.indexOf('海外監管公告')-30),compact.indexOf('海外監管公告')+250),parserVersion:PARSER};
  const names=references.map(r=>r.issuerName).filter(Boolean);
  if(!stock&&!names.some(name=>compact.includes(name.replace(/\s+/g,''))))return null;
  const amounts=[];
  for(const m of compact.matchAll(/每(?:(\d+))?股(?:普通股|股份|H股|股息|現金股利|派發現金股利|派發現金股息|派發股息|股份的末期股息|股息相當於)?(?:人民幣|人民币|RMB)([\d.]+)(元|分)?/g))amounts.push({currency:'CNY',amount:Number(m[2])/Number(m[1]||1)/(m[3]==='分'?100:1)});
  for(const m of compact.matchAll(/每(?:(\d+))?股(?:H股股息)?([\d.]+)(RMB|CNY|HKD|港元)/g))amounts.push({currency:/RMB|CNY/.test(m[3])?'CNY':'HKD',amount:Number(m[2])/Number(m[1]||1)});
  const dates=new Set([...compact.matchAll(/20\d{2}年\d{1,2}月\d{1,2}日/g)].map(m=>dateValue(m[0])));
  const complete=references.filter(r=>!r.fact.reason&&r.fact.recordDate&&r.fact.payDate).sort((a,b)=>String(b.announcedAt||'').localeCompare(String(a.announcedAt||''))||Number(b.documentId)-Number(a.documentId));
  const matches=[];
  for(const ref of complete){
    const f=ref.fact;
    if(!amounts.some(a=>a.currency===f.currency&&Math.abs(a.amount-f.amount)<1e-12)||!dates.has(f.recordDate))continue;
    let relation='same_issuer_amount_record_and_payment_dates',prior=null;
    if(!dates.has(f.payDate)){
      prior=references.find(r=>r.fact.reason&&sameDividendPeriod(r.fact,f)&&dates.has(r.fact.payDate));
      if(!prior||!announcedAt||!ref.announcedAt||ref.announcedAt<=announcedAt)continue;
      relation='historical_schedule_superseded_by_official_update';
    }
    matches.push({documentId:ref.documentId,url:ref.url,contentHash:ref.contentHash,period:f.period,dividendType:f.dividendType,dividendNature:f.dividendNature,currency:f.currency,amount:f.amount,recordDate:f.recordDate,payDate:f.payDate,relation,...(prior?{priorDocumentId:prior.documentId,priorPayDate:prior.fact.payDate}:{})});
  }
  const unique=new Map();for(const m of matches){const k=[m.period,m.dividendType,m.dividendNature,m.currency,m.amount,m.recordDate,m.payDate].join('|');if(!unique.has(k))unique.set(k,m);}const groups=[...unique.values()];
  if(groups.length!==1)return null; // 财报中的多期分红或日期/金额歧义继续阻塞。
  return {classification:'verified_related_announcement',relatedFact:groups[0],identityBasis:stock?'explicit_hk_stock_code':'exact_official_issuer_name_from_verified_dividend_form',parserVersion:PARSER};
}
function dateValue(text) {
  const m=String(text||'').match(/(20\d{2})\s*[年\-/]\s*(\d{1,2})\s*[月\-/]\s*(\d{1,2})/);
  if(m) return CoreDate.normalizeBusinessDate(`${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`);
  const e=String(text||'').match(/(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(20\d{2})/i);
  if(!e) return null;
  const month=['january','february','march','april','may','june','july','august','september','october','november','december'].indexOf(e[2].toLowerCase())+1;
  return CoreDate.normalizeBusinessDate(`${e[3]}-${String(month).padStart(2,'0')}-${e[1].padStart(2,'0')}`);
}
function labeledDate(text,labels) {
  const match=text.match(new RegExp('(?:'+labels+')\\s*(?:为|為)?\\s*[：:]?\\s*((?:20\\d{2}\\s*[年\\-/]\\s*\\d{1,2}\\s*[月\\-/]\\s*\\d{1,2})|(?:\\d{1,2}\\s+[A-Za-z]+\\s+20\\d{2}))','i'));
  return match?dateValue(match[1]):null;
}
function parseDividend(text,identity) {
  const flat=String(text||'').replace(/\r/g,'').replace(/\n\s*\n\d{1,3}\n/g,'\n');
  // 港股监管附件中的A股子公司代码不能作为港股主体身份。
  const stock=flat.match(identity.market==='HK'?/(?:股份代號|股份代号|Stock\s*code)\s*[：:]?\s*(\d{1,6})/i:/(?:證券代碼|证券代码)\s*[：:]?\s*(\d{1,6})/i);
  const bare=String(identity.canonical_code||identity.code).split('.')[0];
  if(!stock||Number(stock[1])!==Number(bare)) return {reason:'document_security_not_verified'};
  let recordDate=labeledDate(flat,'股[權权]登[記记]日(?:期)?|[記记][錄录]日(?:期)?|Record date');
  let exDate=labeledDate(flat,'除[淨净]日(?:期)?|除[權权]除息日|Ex.dividend date');
  let payDate=labeledDate(flat,'股息派[發发]日(?:期)?|派息日(?:期)?|[發发]放日(?:期)?|現金紅利發放日|现金红利发放日|Payment date');
  const compact=flat.replace(/\s/g,'');
  if(identity.market==='CN') {
    payDate=payDate||labeledDate(compact,'现金红利将于|現金紅利將於|现金红利(?:将|將)于');
    // 上交所固定表头后仅接受A股行，不能抓全篇最后一个日期。
    const table=compact.match(/股份类别股权登记日最后交易日除权[（(]息[）)]日现金红利发放日[ＡA]股(20\d{2}\/\d{1,2}\/\d{1,2})[－—-](20\d{2}\/\d{1,2}\/\d{1,2})(20\d{2}\/\d{1,2}\/\d{1,2})/);
    if(table) {recordDate=recordDate||dateValue(table[1]);exDate=exDate||dateValue(table[2]);payDate=payDate||dateValue(table[3]);}
  }
  let currency=null,amount=null;
  if(identity.market==='HK') {
    const m=flat.match(/(?:股息金[額额]|Dividend per share|Dividend amount(?: per share)?)\s*[：:]?\s*(?:\n\s*)?(HKD|RMB|CNY|USD|港元|人民[幣币]|美元)\s*([\d.]+)/i);
    if(m) {currency=({RMB:'CNY','港元':'HKD','人民币':'CNY','人民幣':'CNY','美元':'USD'})[m[1]]||m[1].toUpperCase();amount=Number(m[2]);}
    else {const form=flat.match(/宣派股息\s*每\s*(?:(\d+)\s*)?股\s*([\d.]+)\s*(HKD|RMB|CNY|USD)/i);if(form&&Number(form[1]||1)>0){amount=Number(form[2])/Number(form[1]||1);currency=form[3].toUpperCase()==='RMB'?'CNY':form[3].toUpperCase();}}
  } else {
    const section=compact.match(/(?:二、|本次实施的)(?:本次实施的)?(?:权益分派方案|利润分配方案)[\s\S]*/)?.[0]||compact;
    const m=section.match(/每(?:(\d+))?股(?:派发现金(?:红利|股利)(?:人民币)?([\d.]+)元|派(?:发)?([\d.]+)(?:元)?人民币现金)/);
    if(m && Number(m[1]||1)>0) {amount=Number(m[2]||m[3])/Number(m[1]||1);currency='CNY';}
  }
  const period=identity.market==='HK'?labeledDate(flat,'宣派股息的報告期末|宣派股息的报告期末'):null;
  const dividendType=flat.match(/股息類型\s*([^\n]+)/)?.[1]?.trim()||null;
  const dividendNature=flat.match(/股息性質\s*([^\n]+)/)?.[1]?.trim()||null;
  const taxTreatment=identity.market==='CN'?require('./cashDividendSettlement').parseCnTaxTreatment(flat):require('./cashDividendSettlement').parseHkTaxTreatment(flat);
  const terms={recordDate,exDate,payDate,currency,amount,period,dividendType,dividendNature,...(taxTreatment?{taxTreatment}: {})};
  if(!recordDate||!payDate||!currency||amount==null||!Number.isFinite(amount)||amount<0) return {reason:'incomplete_dividend_terms',...terms};
  if(payDate<recordDate) return {reason:'invalid_dividend_timeline',...terms};
  return {...terms,parserVersion:PARSER};
}
async function cohort() {
  const rows=(await pool.query(`SELECT DISTINCT code FROM positions p JOIN accounts a ON a.username=p.username AND a.account_name=p.account_name WHERE a.cash_income_policy->>'enabled'='true'
    UNION SELECT DISTINCT code FROM trades t JOIN accounts a ON a.username=t.username AND a.account_name=t.account_name WHERE a.cash_income_policy->>'enabled'='true'`)).rows;
  const list=[];
  for(const r of rows) {const canonical=await require('./securityIdentity').resolveCanonicalCode(r.code);const i=await resolveInstrument({canonicalCode:canonical});if(i?.asset_class==='stock') list.push({...i,code:r.code});}
  if(!list.length) throw new Error('已启用账户证券集合为空，不能证明分红覆盖恢复');
  return [...new Map(list.map(i=>[i.instrument_id,i])).values()];
}
async function storeDocument(identity,ann,sourceId) {
  const {runPythonExtraction}=require('./arbitrageParser');
  const url=ann.fileLink||ann.url,sourceKey=ann.sourceKey||ann.source_number||url;
  const cached=(await pool.query(`SELECT document_id,raw_payload FROM event.documents WHERE source_id=$1 AND url=$2 ORDER BY document_id DESC LIMIT 1`,[sourceId,url])).rows[0];
  if(cached?.raw_payload?.cashDividend?.parserVersion===PARSER && cached.raw_payload.cashDividend.quality==='passed') return {ok:true,cached:true,fact:cached.raw_payload.cashDividend,url,code:identity.code};
  const body=cached?.raw_payload?.text?{text:cached.raw_payload.text}:await runPythonExtraction(url,String(identity.canonical_code).split('.')[0],{rawText:true});
  let fact=parseDividend(body.text,identity);
  if(identity.market==='HK'&&fact.reason){
    const related=(await pool.query("SELECT document_id,url,content_hash,announced_at::date::text,raw_payload FROM event.documents WHERE source_id=$1 AND document_type='cash_dividend_announcement' AND raw_payload->'cashDividend'->>'instrumentId'=$2",[sourceId,String(identity.instrument_id)])).rows;
    const references=related.filter(r=>/股票發行人現金股息公告/.test(r.raw_payload.text||'')).map(r=>({documentId:r.document_id,url:r.url,contentHash:r.content_hash,announcedAt:r.announced_at,issuerName:r.raw_payload.text.match(/發行人名稱\s*\n([^\n]+)/)?.[1]?.trim(),fact:parseDividend(r.raw_payload.text,identity)}));
    const documentDate=ann.announcedAt||dateValue(ann.event_date?.replace(/(\d{4})(\d{2})(\d{2})/,'$1-$2-$3'));
    const finalForm=references.filter(r=>!r.fact.reason&&sameDividendPeriod(fact,r.fact)&&documentDate&&r.announcedAt>=documentDate).sort((a,b)=>b.announcedAt.localeCompare(a.announcedAt)||Number(b.documentId)-Number(a.documentId))[0];
    const linked=finalForm?{classification:'superseded_incomplete_official_form',relatedFact:{documentId:finalForm.documentId,url:finalForm.url,contentHash:finalForm.contentHash,period:finalForm.fact.period,dividendType:finalForm.fact.dividendType,dividendNature:finalForm.fact.dividendNature,currency:finalForm.fact.currency,amount:finalForm.fact.amount,recordDate:finalForm.fact.recordDate,payDate:finalForm.fact.payDate},identityBasis:'same_verified_hk_stock_code_period_and_distribution',parserVersion:PARSER}:resolveHkRelatedDocument(body.text,identity,references,{announcedAt:documentDate});
    if(linked)fact=linked;
  }
  const contentHash=crypto.createHash('sha256').update(body.text).digest('hex');
  const payload={announcement:ann,text:body.text,cashDividend:{...fact,instrumentId:identity.instrument_id,parserVersion:PARSER,quality:fact.reason?'pending':'passed',contentHash}};
  const payloadHash=crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const raw=(await client.query(`INSERT INTO ops.raw_records(source_id,dataset_code,source_key,payload,payload_hash) VALUES($1,'stock_cash_dividend_facts',$2,$3,$4)
      ON CONFLICT(source_id,dataset_code,source_key,payload_hash) DO UPDATE SET ingested_at=now() RETURNING raw_record_id`,[sourceId,sourceKey,payload,payloadHash])).rows[0];
    const announcedAt=ann.announcedAt||dateValue(ann.event_date?.replace(/(\d{4})(\d{2})(\d{2})/,'$1-$2-$3'));
    const document=(await client.query(`INSERT INTO event.documents(document_type,title,announced_at,url,source_id,content_hash,raw_record_id,raw_payload)
      VALUES('cash_dividend_announcement',$1,$2,$3,$4,$5,$6,$7) ON CONFLICT(source_id,url,content_hash) DO UPDATE SET raw_payload=EXCLUDED.raw_payload RETURNING document_id`,[ann.title,announcedAt,url,sourceId,contentHash,raw.raw_record_id,payload])).rows[0];
    if(!fact.reason&&!fact.classification) await client.query(`INSERT INTO fundamental.corporate_actions(instrument_id,action_type,announced_at,record_date,ex_date,pay_date,status,cash_per_share_pre_tax,currency_code,source_id,source_key,raw_payload)
      VALUES($1,'dividend',$2,$3,$4,$5,'实施',$6,$7,$8,$9,$10) ON CONFLICT(source_id,source_key) DO UPDATE SET announced_at=EXCLUDED.announced_at,
      record_date=EXCLUDED.record_date,ex_date=EXCLUDED.ex_date,pay_date=EXCLUDED.pay_date,cash_per_share_pre_tax=EXCLUDED.cash_per_share_pre_tax,currency_code=EXCLUDED.currency_code,raw_payload=EXCLUDED.raw_payload,ingested_at=now()`,[identity.instrument_id,announcedAt,fact.recordDate,fact.exDate,fact.payDate,fact.amount,fact.currency,sourceId,sourceKey,{...payload.cashDividend,documentId:document.document_id,url,sourceKey,issuerTaxEvidence:'not_verified',stockConnectSettlement:'not_verified'}]);
    await client.query('COMMIT');return {ok:!fact.reason,fact,url,code:identity.code};
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
function sameDividendPeriod(a,b) {
  return a.period && a.dividendType && a.period===b.period && a.dividendType===b.dividendType && a.currency===b.currency && a.amount===b.amount && (!a.dividendNature||!b.dividendNature||a.dividendNature===b.dividendNature);
}
async function syncCashDividends({targetDate=CoreDate.todayInZone('Asia/Shanghai'),startDate,targetCodes,deadlineAt,localOnly=false}={}) {
  if(!CoreDate.normalizeBusinessDate(targetDate)||targetDate>CoreDate.todayInZone('Asia/Shanghai')) throw new Error('分红采集目标日无效');
  const all=await cohort(),identities=targetCodes?.length?all.filter(i=>targetCodes.includes(i.code)||targetCodes.includes(i.canonical_code)):all;
  if(!identities.length) throw new Error('目标证券没有匹配启用账户范围');
  const result={ok:true,mode:'cash_dividends',dataAsOf:targetDate,codes:[],remainingCodes:[],documents:[],failures:[],publishDatasets:false};
  for(const identity of identities) {
    if(deadlineAt&&Date.now()>=Number(deadlineAt)) {result.remainingCodes.push(identity.code);continue;}
    const scope='cash_dividend:'+identity.instrument_id;
    const cursor=(await pool.query("SELECT last_success_date::text,cursor_payload,last_error FROM ops.sync_cursors WHERE scope_key=$1 AND dataset_code='stock_cash_dividend_facts'",[scope])).rows[0];
    const discovered=cursor?.cursor_payload?.discoveryThrough || (cursor?.cursor_payload?.targetDate && cursor.last_error==='公告条款解析未完成'?cursor.cursor_payload.targetDate:null) || cursor?.last_success_date;
    const from=startDate || (discovered?require('./cashIncome').shiftDay(discovered):targetDate.slice(0,4)+'-01-01');
    const sourceCode=identity.market==='HK'?'hkex':identity.exchange_code==='SSE'?'sse':identity.exchange_code==='SZSE'?'szse':null;
    try {
      if(!sourceCode) throw new Error('该市场的分红官方源尚未准入');
      const sourceId=(await pool.query('SELECT source_id FROM ops.data_sources WHERE source_code=$1',[sourceCode])).rows[0]?.source_id;
      const local=(await pool.query(`SELECT raw_payload->'announcement' AS announcement FROM event.documents WHERE source_id=$1 AND document_type='cash_dividend_announcement'
        AND ((raw_payload->'announcement'->>'stockCode')=ANY($2::text[]) OR (raw_payload->'announcement'->>'stock_code')=ANY($2::text[]) OR raw_payload->'cashDividend'->>'instrumentId'=$3)
        AND announced_at::date <= $4::date`,[sourceId,[identity.code,identity.canonical_code,String(identity.canonical_code).split('.')[0]],String(identity.instrument_id),targetDate])).rows.map(r=>r.announcement);
      let announcements=local.concat(cursor?.cursor_payload?.announcementQueue||[]);
      if(!localOnly&&from<=targetDate&&sourceCode==='hkex') announcements=announcements.concat(await require('./hkexAnnouncement').searchAnnouncements({fromDate:from,toDate:targetDate,stockCode:String(identity.canonical_code).split('.')[0]}));
      else if(!localOnly&&from<=targetDate) {
        const module=require('./stockAnalysis');
        const batch=await (sourceCode==='sse'?module.fetchSseEvents:module.fetchSzseEvents)(identity.canonical_code,from,targetDate,'',{structured:true});
        if(!batch.complete) throw new Error('官方公告分页不完整');announcements=announcements.concat(batch.events);
      }
      const candidates=[...new Map(announcements.filter(a=>sourceCode==='hkex'?/股息|Dividend/i.test(a.title)&&!/計劃|计划|代息股份|董事|股[东東]大[会會]|取消|cancel/i.test(a.title):/(?:权益分派|利润分配).*实施公告/.test(a.title)).map(a=>[a.fileLink||a.url,a])).values()];
      const discoveryThrough=localOnly?discovered:[discovered,targetDate].filter(Boolean).sort().at(-1);
      // 发现列表先持久化；下载超时或进程退出后仍能续解析，不把丢失URL当成无公告。
      await pool.query(`INSERT INTO ops.sync_cursors(instrument_id,scope_key,dataset_code,last_attempt_at,cursor_payload,last_error)
        VALUES($1,$2,'stock_cash_dividend_facts',now(),$3,'公告解析阶段进行中') ON CONFLICT(scope_key,dataset_code)
        DO UPDATE SET last_attempt_at=now(),cursor_payload=EXCLUDED.cursor_payload,last_error=EXCLUDED.last_error`,[identity.instrument_id,scope,{...cursor?.cursor_payload,fromDate:cursor?.cursor_payload?.fromDate||from,targetDate,discoveryThrough,complete:false,announcementQueue:candidates,parserVersion:PARSER}]);
      let complete=!localOnly||!!discovered&&discovered>=targetDate;
      const objectRows=[];
      for(const ann of candidates) {
        if(deadlineAt&&Date.now()>=Number(deadlineAt)) {complete=false;break;}
        try {const row=await storeDocument(identity,ann,sourceId);result.documents.push(row);objectRows.push(row);}
        catch(e){complete=false;result.failures.push({code:identity.code,url:ann.fileLink||ann.url,reason:e.message});}
      }
      for(const row of objectRows.filter(r=>!r.ok)) {
        const replacement=objectRows.find(r=>r.ok&&sameDividendPeriod(row.fact,r.fact));
        if(replacement) {row.ok=true;row.excluded='superseded_incomplete_terms';row.replacedBy=replacement.url;}
        else complete=false;
      }
      await pool.query(`INSERT INTO ops.sync_cursors(instrument_id,scope_key,dataset_code,last_success_date,last_attempt_at,cursor_payload,last_error)
        VALUES($1,$2,'stock_cash_dividend_facts',CASE WHEN $4 THEN $3::date ELSE NULL END,now(),$5,$6)
        ON CONFLICT(scope_key,dataset_code) DO UPDATE SET last_success_date=CASE WHEN $4 THEN GREATEST(ops.sync_cursors.last_success_date,$3::date) ELSE ops.sync_cursors.last_success_date END,
        last_attempt_at=now(),cursor_payload=EXCLUDED.cursor_payload,last_error=EXCLUDED.last_error`,[identity.instrument_id,scope,targetDate,complete,{fromDate:cursor?.cursor_payload?.fromDate||from,targetDate,discoveryThrough,complete,announcements:candidates.length,announcementQueue:candidates,parserVersion:PARSER,remainingDocuments:candidates.filter(a=>!objectRows.some(r=>r.ok&&r.url===(a.fileLink||a.url))).map(a=>a.fileLink||a.url)},complete?'':'公告条款解析未完成']);
      if(complete) result.codes.push(identity.code);else result.remainingCodes.push(identity.code);
    }catch(e){result.failures.push({code:identity.code,reason:e.message});result.remainingCodes.push(identity.code);}
  }
  result.ok=!result.remainingCodes.length&&!result.failures.length;result.status=result.ok?'succeeded':'partial';
  result.failedDatasets=result.ok?[]:['stock_cash_dividend_facts'];result.pendingStages=result.ok?[]:['cashDividends'];result.remainingCount=result.remainingCodes.length;
  result.stageComplete=result.ok;result.nextAttemptInMinutes=result.ok?null:15;
  await require('./datasetPartitions').publishDatasetPartition('stock_cash_dividend_facts','GLOBAL',{partitionKey:targetDate,dataAsOf:targetDate,status:result.ok?'published':'rejected',rowCount:result.documents.filter(d=>d.ok).length,diagnostics:{...result,quality_status:result.ok?'passed':'failed',verified_no_change:result.ok&&!result.documents.length}});
  return result;
}
module.exports={parseDividend,dateValue,syncCashDividends,cohort,PARSER,sameDividendPeriod,normalizeChineseDates,resolveHkRelatedDocument};

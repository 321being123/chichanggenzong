// 来源准入与字段质量分开；人工交叉样本复用既有探测入口，不增加行情事实表或调度。
const crypto=require('crypto'),DateApi=require('../../public/shared/core-date');
const CODE='204001.SH',DOC='https://tushare.pro/document/2?doc_id=256';
function assess({rows,expectedDates,targetDate,officialSamples=[],fetchedAt,permissionVerified=false}){
  const gaps=[],mismatches=[],seen=new Set();
  if(!DateApi.normalizeBusinessDate(targetDate)||targetDate>=DateApi.todayInZone('Asia/Shanghai'))throw new TypeError('准入只核验已完成交易日');
  if(!Array.isArray(expectedDates)||!expectedDates.length||JSON.stringify(expectedDates)!==JSON.stringify(require('./repoDailyRates').tradingDates(expectedDates[0],targetDate)))throw new TypeError('准入样本必须是连续完整交易日期差集');
  const fetchedDate=fetchedAt&&DateApi.dateInZone(new Date(fetchedAt),'Asia/Shanghai');
  if(!fetchedDate||fetchedDate<=targetDate)gaps.push('missing_after_day_publication_evidence');
  if(!permissionVerified)gaps.push('source_permission_not_verified');
  if(expectedDates.length<30)gaps.push('sample_under_30_trading_days');
  for(const row of rows){const d=String(row.trade_date).replace(/^(\d{4})(\d{2})(\d{2})$/,'$1-$2-$3');if(seen.has(d))mismatches.push({date:d,reason:'duplicate_source_date'});seen.add(d);
    if(!expectedDates.includes(d))mismatches.push({date:d,reason:'unexpected_source_date'});
    try{require('./repoDailyRates').normalize(row);}catch(e){mismatches.push({date:d,reason:e.message});}
  }
  const missing=expectedDates.filter(d=>!seen.has(d));if(missing.length)gaps.push('missing_sample_dates');
  const comparable=[];
  for(const sample of officialSamples){
    const url=(()=>{try{return new URL(sample.sourceUrl);}catch{return null;}})();
    if(!url||url.protocol!=='https:'||!['sse.com.cn','www.sse.com.cn','bond.sse.com.cn'].includes(url.hostname)||sample.code!==CODE||sample.unit!=='percent'||!DateApi.normalizeBusinessDate(sample.date))throw new TypeError('跨源证据必须是相同证券/日期/百分数单位的上交所原文');
    if(sample.metric!=='daily_volume_weighted') {gaps.push('official_metric_not_comparable');continue;}
    const row=rows.find(r=>String(r.trade_date).replace(/-/g,'')===sample.date.replace(/-/g,''));
    if(!row){gaps.push('official_sample_without_source_row');continue;}
    if(typeof sample.value!=='string'||!/^\d+(?:\.\d+)?$/.test(sample.value)||!String(sample.label||'').trim()||!String(sample.contentHash||'').match(/^[a-f0-9]{64}$/))throw new TypeError('官方交叉样本必须保存标签、原文哈希与金额文本');
    const matched=Number(row.weight)===Number(sample.value);comparable.push({...sample,sourceWeight:String(row.weight),matched});if(!matched)mismatches.push({date:sample.date,reason:'official_weight_mismatch',source:row.weight,official:sample.value});
  }
  if(!comparable.length)gaps.push('no_comparable_official_sample');
  const status=mismatches.length?'rejected':gaps.length?'pending_evidence':'admitted';
  return {version:'repo-source-admission-v1',status,code:CODE,metric:'daily_volume_weighted',inputUnit:'percent',storedUnit:'annual_decimal',scale:'divide_by_100',doc:DOC,targetDate,fetchedAt,expectedDays:expectedDates.length,observedDays:seen.size,missing,mismatches,gaps:[...new Set(gaps)],officialSamples:comparable,officialEvidence:officialSamples,permissionVerified,brokerVerified:false};
}
async function record(report,executor){const source=(await executor("SELECT source_id FROM ops.data_sources WHERE source_code='tushare'")).rows[0];if(!source)throw new Error('Tushare来源未注册');const payloadHash=crypto.createHash('sha256').update(JSON.stringify(report)).digest('hex');const raw=(await executor(`INSERT INTO ops.raw_records(source_id,dataset_code,source_key,payload,payload_hash) VALUES($1,'repo_daily_admission',$2,$3,$4) ON CONFLICT(source_id,dataset_code,source_key,payload_hash) DO UPDATE SET ingested_at=now() RETURNING raw_record_id`,[source.source_id,CODE+':'+report.targetDate,report,payloadHash])).rows[0];return {...report,rawRecordId:raw.raw_record_id};}
async function load(executor){return (await executor("SELECT raw_record_id,payload FROM ops.raw_records WHERE dataset_code='repo_daily_admission' AND source_key LIKE '204001.SH:%' ORDER BY ingested_at DESC,raw_record_id DESC LIMIT 1")).rows[0]||null;}
async function probeOfficial(targetDate,executor){
  if(!DateApi.normalizeBusinessDate(targetDate)||targetDate>=DateApi.todayInZone('Asia/Shanghai'))throw new TypeError('官方准入样本须为已完成交易日');
  const source=(await executor("SELECT source_id FROM ops.data_sources WHERE source_code='sse'")).rows[0];
  if(!source)throw new Error('上交所来源未注册');
  const cached=(await executor("SELECT payload FROM ops.raw_records WHERE source_id=$1 AND dataset_code='repo_daily_admission' AND source_key=$2 ORDER BY ingested_at DESC,raw_record_id DESC LIMIT 1",[source.source_id,'official:'+CODE+':'+targetDate])).rows[0];
  if(cached&&cached.payload.date===targetDate&&cached.payload.code===CODE&&cached.payload.metric==='daily_volume_weighted'&&cached.payload.sqlId==='COMMON_SSEBOND_SCSJ_SCTJ_SCGL_ZQZYSHGSCGL_CX_L')return cached.payload;
  await executor(`INSERT INTO ops.source_endpoint_policies(source_id,api_name,credential_profile,permission_mode,official_doc_url,notes) VALUES($1,'repo_overview','anonymous','public','https://bond.sse.com.cn/data/statistics/overview/Pledgerepo/','人工准入交叉样本，仅目标完成交易日；不写市场行情事实、不自动抓取；额度未知保持NULL') ON CONFLICT(source_id,api_name,credential_profile) DO NOTHING`,[source.source_id]);
  const {promisify}=require('util'),{execFile}=require('child_process'),path=require('path');
  const python=process.env.IPO_PYTHON_PATH||path.resolve('venv/Scripts/python.exe');
  const output=await promisify(execFile)(python,[path.resolve('server/scripts/probeRepoOfficial.py'),targetDate],{timeout:45000,maxBuffer:2*1024*1024,windowsHide:true,env:process.env});
  const sample=JSON.parse(output.stdout.trim());if(sample.error)throw new Error(sample.error);
  await executor(`INSERT INTO ops.raw_records(source_id,dataset_code,source_key,payload,payload_hash) VALUES($1,'repo_daily_admission',$2,$3,$4) ON CONFLICT(source_id,dataset_code,source_key,payload_hash) DO NOTHING`,[source.source_id,'official:'+CODE+':'+targetDate,sample,sample.contentHash]);
  return sample;
}
module.exports={assess,record,load,probeOfficial};

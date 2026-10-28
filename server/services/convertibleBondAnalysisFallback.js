const layerSql = require('../repositories/convertibleBondAnalysisFallbackRepository');
// 原资料Runner的Tushare末级备源：原文失败后才调用，原始响应先入库，空结果不生成事实。
const crypto=require('crypto');
const {pool}=require('../db/connection');
const {tushareQuery,tsRows}=require('./market');
const CoreDate=require('../../public/shared/core-date');
const store=require('./convertibleBondAnalysisStore');
const {isoDate,finite}=require('./convertibleBondAnalysisCore');
const {sanitizeJobError}=require('./jobErrorSanitizer');
const txControl = require('../repositories/transactionControl');
const repository = require('../repositories/convertibleBondAnalysisFallbackRepository.js');

const VERSION='tushare-input-fallback-v1';
const APIS=Object.freeze({
  rating:{name:'cb_rating',limit:3000,fields:'ts_code,ann_date,rating_date,rating_com_name,rating_way,rating_type,rating,rating_outlook'},
  holders:{name:'top10_cb_holders',limit:3000,fields:'ts_code,end_date,holder_rank,holder_name,hold_amount,hold_ratio'},
  price_history:{name:'cb_price_chg',limit:2000,fields:'ts_code,bond_short_name,publish_date,change_date,convert_price_initial,convertprice_bef,convertprice_aft'},
  coupon_terms:{name:'cb_rate',limit:2000,fields:'ts_code,rate_freq,rate_start_date,rate_end_date,coupon_rate'},
});

function validateRows(kind,rows,bond,targetDate,period) {
  if(!Array.isArray(rows)||!rows.length)throw Error('备用接口未返回可核验数据');
  if(rows.some(r=>r.ts_code!==bond.ts_code))throw Error('备用接口返回其他债券，禁止混用');
  if(kind==='holders') {
    const ranks=new Set(rows.map(r=>Number(r.holder_rank)));
    if(rows.length!==10||ranks.size!==10||[...ranks].some(r=>!Number.isInteger(r)||r<1||r>10)||
      rows.some(r=>isoDate(r.end_date)!==period||!r.holder_name||!(finite(r.hold_amount)>0)||finite(r.hold_ratio)==null||Number(r.hold_ratio)<=0||Number(r.hold_ratio)>100)||
      rows.reduce((sum,r)=>sum+Number(r.hold_ratio),0)>100.1)throw Error('备用持有人缺十名、报告期不符或数量比例无效');
    const funds=rows.filter(r=>/基金|养老金|年金|社保|资产管理计划|集合资产管理/.test(r.holder_name));
    const quantity=funds.reduce((sum,r)=>sum+Number(r.hold_amount),0);
    return {report_date:period,fund_count:funds.length,holding_quantity:quantity,holding_market_value:quantity*100,
      remain_size_ratio:funds.reduce((sum,r)=>sum+Number(r.hold_ratio),0)/100,all_holders:rows,
      availability_policy:'statutory_report_deadline',api_source:APIS[kind].name,ts_code:bond.ts_code};
  }
  if(kind==='rating') {
    const eligible=rows.filter(r=>isoDate(r.rating_date)&&isoDate(r.ann_date)&&isoDate(r.rating_date)<=targetDate&&isoDate(r.ann_date)<=targetDate);
    if(!eligible.length||eligible.some(r=>isoDate(r.rating_date)>isoDate(r.ann_date)||!r.rating||!r.rating_com_name))throw Error('备用评级缺明确日期、等级或机构');
    const keys=new Map();
    for(const r of eligible){const key=`${isoDate(r.rating_date)}:${r.rating_com_name}`;if(keys.has(key)&&keys.get(key)!==r.rating)throw Error('备用评级同日同机构冲突');keys.set(key,r.rating);}
    return eligible.map(r=>({...r,api_source:'cb_rating',rating_date_source:'existing_standard_fact',outlook_status:r.rating_outlook?'api_provided':'api_unavailable'}));
  }
  if(kind==='price_history') {
    const baseline=r=>isoDate(r.change_date)===isoDate(bond.value_date)&&r.convertprice_bef==null&&r.convertprice_aft==null&&
      finite(r.convert_price_initial)!=null&&Math.abs(Number(r.convert_price_initial)-Number(bond.first_conv_price))<1e-6;
    const eligible=rows.filter(r=>!baseline(r)&&isoDate(r.change_date)&&isoDate(r.change_date)<=period&&isoDate(r.publish_date)&&isoDate(r.publish_date)<=targetDate)
      .sort((a,b)=>isoDate(a.change_date).localeCompare(isoDate(b.change_date)));
    let previous=finite(bond.first_conv_price);const dates=new Set();
    if(previous==null||!eligible.length&&!rows.some(baseline))throw Error('备用转股价缺初始价或目标期内记录');
    for(const r of eligible){const date=isoDate(r.change_date),after=finite(r.convertprice_aft),before=finite(r.convertprice_bef);
      if(dates.has(date)||before==null||!(after>0)||Math.abs(before-previous)>1e-6)throw Error('备用转股价历史不连续或日期重复');
      dates.add(date);previous=after;}
    // 返回了目标期内但缺公告日的记录时，不能把被过滤的缺段当作完整。
    if(rows.some(r=>!isoDate(r.change_date)||!baseline(r)&&isoDate(r.change_date)<=period&&(!isoDate(r.publish_date)||isoDate(r.publish_date)>targetDate)))throw Error('备用转股价缺公告日期，不能证明历史完整');
    return eligible;
  }
  const sorted=rows.slice().sort((a,b)=>String(a.rate_start_date).localeCompare(String(b.rate_start_date)));
  const years=Number(isoDate(bond.maturity_date)?.slice(0,4))-Number(isoDate(bond.value_date)?.slice(0,4));
  if(!(years>0)||sorted.length!==years||isoDate(sorted[0].rate_start_date)!==isoDate(bond.value_date)||
    sorted.some((r,i)=>Number(r.rate_freq)!==1||finite(r.coupon_rate)==null||Number(r.coupon_rate)<0||!isoDate(r.rate_start_date)||!isoDate(r.rate_end_date)||
      isoDate(r.rate_start_date)>isoDate(r.rate_end_date)||Number(isoDate(r.rate_start_date).slice(0,4))!==Number(isoDate(bond.value_date).slice(0,4))+i))throw Error('备用票息未完整覆盖发行期限');
  return sorted;
}

async function readApiRows(kind,bond,period,deps={}) {
  const api=APIS[kind],query=deps.query||pool.query.bind(pool);
  // 已有同报告期的标准持有人事实优先，禁止为同一份名单重复外采。
  if(kind==='holders') {
    const local=await layerSql.readApiRowsQuery1(query, [bond.instrument_id,period]);
    if(local.rows.length===10) {
      const rows=local.rows.map(r=>r.raw_payload);
      try{validateRows(kind,rows,bond,period,period);return {rows,cache:'standard_facts'};}catch{}
    }
  }
  const key=`analysis-backup:${bond.ts_code}:${kind==='holders'?period:'history'}`;
  const today=CoreDate.todayInZone();
  const client=deps.client||await pool.connect();
  try {
    await txControl.begin(client);
    await repository.select_data([`${api.name}:${key}`], client);
    const cached=await repository.select_ops_raw_records([api.name,key], client);
    if(cached.rows[0]?.payload?.fetched_on===today) {
      await txControl.commit(client);return {rows:cached.rows[0].payload.rows,rawRecordId:cached.rows[0].raw_record_id,cache:'raw_records'};
    }
    const params={ts_code:bond.ts_code};if(kind==='holders')params.period=period.replace(/-/g,'');
    const response=await (deps.fetch||tushareQuery)(api.name,params,api.fields,{allowEmpty:true});
    if(!Array.isArray(response?.fields)||!Array.isArray(response?.items)||!response.fields.includes('ts_code'))throw Error('备用接口响应结构无效');
    const rows=tsRows(response);
    const payload={ts_code:bond.ts_code,params,fields:response.fields,rows,fetched_on:today,version:VERSION};
    const hash=crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const saved=await repository.insert_ops_raw_records([api.name,key,JSON.stringify(payload),hash], client);
    if(!saved.rows.length)throw Error('Tushare来源未登记');
    await txControl.commit(client);return {rows,rawRecordId:saved.rows[0].raw_record_id,cache:'api'};
  } catch(error){await txControl.rollback(client);throw error;}
  finally{if(!deps.client)client.release();}
}

async function saveFallback(kind,bond,value,evidence) {
  const client=await pool.connect();
  try {
    await txControl.begin(client);
    const source=(await store.sourceIds(client)).tushare;
    if(kind==='holders') {
      const existing=await repository.select_fundamental_convertible_bond_fund_holdings([bond.instrument_id,value.report_date], client);
      if(existing.rows[0]?.raw_payload?.document_hash)throw Error('已有原文持有人事实，禁止备源覆盖');
      await store.saveReportFundHolding(client,bond.instrument_id,{...value,...evidence},source);
    } else if(kind==='rating') {
      for(const row of value) {
        const existing=await repository.select_fundamental_convertible_bond_ratings([bond.instrument_id,isoDate(row.rating_date),row.rating_com_name], client);
        const prior=existing.rows[0];
        // 同一Tushare事实的旧空展望需补来源标记；不得借备源重写原文、改等级/公告日或抹掉已有展望。
        const repairApiMetadata=prior&&Number(prior.source_id)===Number(source)&&prior.rating===row.rating&&!prior.rating_outlook&&
          prior.raw_payload?.ts_code===bond.ts_code&&!prior.raw_payload.document_hash&&!prior.raw_payload.outlook_source_url&&
          isoDate(prior.announced_at)===isoDate(row.ann_date);
        if(!prior||repairApiMetadata)await store.saveRatingHistory(client,bond.instrument_id,[{...row,...evidence}],source);
      }
    } else if(kind==='price_history') {
      const existing=await repository.select_fundamental_convertible_bond_price_changes([bond.instrument_id], client);
      for(const row of value){const prior=existing.rows.find(r=>r.change_date===isoDate(row.change_date));if(prior&&(Math.abs(Number(prior.price_before)-Number(row.convertprice_bef))>1e-6||Math.abs(Number(prior.price_after)-Number(row.convertprice_aft))>1e-6))throw Error('备用转股价与既有事实冲突，保留原值');}
      const dates=new Set(existing.rows.map(r=>r.change_date));
      await store.savePriceChanges(client,bond.instrument_id,value.filter(r=>!dates.has(isoDate(r.change_date))).map(r=>({...r,...evidence})),source);
    } else {
      const existing=await repository.select_fundamental_convertible_bond_coupon_schedule([bond.instrument_id], client);
      for(let index=0;index<value.length;index++) {
        const row=value[index],prior=existing.rows.find(r=>Number(r.interest_year)===index+1);
        if(prior&&Math.abs(Number(prior.coupon_rate)-Number(row.coupon_rate))>1e-6)throw Error('备用票息与既有事实冲突，保留原值');
        await repository.insert_fundamental_convertible_bond_coupon_schedule([bond.instrument_id,index+1,row.coupon_rate,isoDate(row.rate_end_date),Number(row.coupon_rate)*.8,source], client);
      }
    }
    await txControl.commit(client);
  } catch(error){await txControl.rollback(client);throw error;}
  finally{client.release();}
}

async function tryAnalysisApiFallback({kind,bond,targetDate,period,documentUrls=[]},deps={}) {
  if(!APIS[kind])return {status:'unsupported'};
  const evidence={version:VERSION,source:'tushare',api_source:APIS[kind].name,ts_code:bond.ts_code,
    target_date:targetDate,report_period:period,document_urls:documentUrls};
  try {
    const raw=await readApiRows(kind,bond,period,deps);
    evidence.raw_record_id=raw.rawRecordId||null;evidence.cache=raw.cache;
    if(!raw.rows.length)return {...evidence,status:'empty',row_count:0};
    if(raw.rows.length>=APIS[kind].limit)throw Error('备用接口达到官方返回行数边界，不能宣告完整');
    const value=validateRows(kind,raw.rows,bond,targetDate,period);
    await (deps.save||saveFallback)(kind,bond,value,evidence);
    return {...evidence,status:'complete',row_count:raw.rows.length};
  } catch(error){return {...evidence,status:'failed',reason:sanitizeJobError(error.message,600),errorCode:error.code||null,
    errorType:error.errorType||null,apiName:APIS[kind].name,recoverAt:error.recoverAt||null};}
}

function coversDocument(fallback,kind,url,targetDate,period,tsCode) {
  return fallback?.version===VERSION&&fallback.status==='complete'&&fallback.api_source===APIS[kind]?.name&&
    fallback.source==='tushare'&&fallback.ts_code===tsCode&&fallback.target_date===targetDate&&fallback.report_period===period&&fallback.document_urls?.includes(url);
}
function terminalApplies(entry,url,period) {
  return Boolean(entry&&['source_unavailable','not_disclosed','conflict'].includes(entry.status)&&url&&entry.evidence?.url===url&&
    (!entry.evidence.report_date||entry.evidence.report_date===period));
}
module.exports={tryAnalysisApiFallback,validateRows,readApiRows,coversDocument,terminalApplies,APIS,VERSION};

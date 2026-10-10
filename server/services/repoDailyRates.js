// GC001 市场日加权利率唯一采集入口；计算和页面只读标准事实。
const {pool}=require('../db/connection');
const {tushareQuery}=require('./tushare');
const CoreDate=require('../../public/shared/core-date');
const {resolveInstrument}=require('./securityIdentity');
const {loadHolidays}=require('../config/holidays');
const crypto=require('crypto');
const CODE='204001.SH', DOC='https://tushare.pro/document/2?doc_id=256';
function day(value) {const s=String(value||'').replace(/-/g,'');return /^\d{8}$/.test(s)?CoreDate.normalizeBusinessDate(s.slice(0,4)+'-'+s.slice(4,6)+'-'+s.slice(6)):null;}
function normalize(row) {
  const date=day(row.trade_date);
  if(row.ts_code!==CODE || !date || !/^(GC001|1|1天|1D)$/i.test(String(row.repo_maturity))) throw new Error('回购证券、期限或日期不匹配');
  for(const k of ['weight','close']) if(row[k]==null || row[k]==='' || !Number.isFinite(Number(row[k]))) throw new Error('缺少有效回购利率：'+k);
  return {date,weighted:Number(row.weight)/100,close:Number(row.close)/100,unit:'annual_decimal',tenor:1};
}
function tradingDates(start,end) {
  const {calendarFor,shiftDay}=require('./cashIncome');
  const trading=calendarFor(loadHolidays().years),dates=[];
  for(let d=start;d<=end;d=shiftDay(d)) if(trading(d)) dates.push(d);
  return dates;
}
async function syncRepoDailyRates({targetDate,startDate,probe=false}={}) {
  if(!startDate) {
    const anchors=(await pool.query(`SELECT MIN(anchor_date)::text AS start_date FROM (SELECT MAX(n.date) AS anchor_date FROM nav_history n JOIN accounts a ON a.username=n.username AND a.account_name=n.account_name
      WHERE a.cash_income_policy->>'enabled'='true' AND (n.is_locked OR n.snapshot_source='imported') AND n.date <= $1 GROUP BY a.id) anchors`,[targetDate])).rows[0];
    startDate=anchors?.start_date||targetDate;
  }
  if(!CoreDate.normalizeBusinessDate(targetDate)||!CoreDate.normalizeBusinessDate(startDate)||startDate>targetDate || targetDate>=CoreDate.todayInZone('Asia/Shanghai')) throw new Error('回购采集仅接受已完成交易日区间');
  let identity=await resolveInstrument({canonicalCode:CODE});
  if(!identity) {
    const master=await require('./securityIdentity').ensureInstrumentIdentity({canonicalCode:CODE,name:'GC001',assetClass:'repo',market:'CN',exchangeCode:'SSE',currencyCode:'CNY',status:'listed'});
    identity={instrument_id:master.instrumentId};
  }
  const source=(await pool.query("SELECT source_id FROM ops.data_sources WHERE source_code='tushare'")).rows[0].source_id;
  const expected=tradingDates(startDate,targetDate);
  const saved=(await pool.query("SELECT trade_date::text FROM market.repo_daily_rates WHERE instrument_id=$1 AND quality_status='passed' AND trade_date BETWEEN $2 AND $3",[identity.instrument_id,startDate,targetDate])).rows.map(r=>r.trade_date);
  const missing=expected.filter(d=>!saved.includes(d));
  const requested=probe?expected:missing;
  const failures=[],samples=[];
  // 单品种按完整自然年分批，每批最多366天，不会触碰官方2000行截断；业务范围不截断。
  for(const year of [...new Set(requested.map(d=>d.slice(0,4)))]) {
    const dates=requested.filter(d=>d.startsWith(year));
    try {
      const response=await tushareQuery('repo_daily',{ts_code:CODE,start_date:dates[0].replace(/-/g,''),end_date:dates.at(-1).replace(/-/g,'')},'ts_code,trade_date,repo_maturity,weight,close');
      const data=response.data||response;
      const rows=(data.items||[]).map(r=>Object.fromEntries(data.fields.map((f,i)=>[f,r[i]])));
      if(rows.length>=2000) throw new Error('回购响应可能截断');
      const seen=new Set();
      for(const row of rows) {
        const value=normalize(row);
        if(!expected.includes(value.date)) continue;
        if(seen.has(value.date)) throw new Error('回购重复交易日');
        seen.add(value.date);
        const payloadHash=crypto.createHash('sha256').update(JSON.stringify(row)).digest('hex');
        const client=await pool.connect();
        try {
          await client.query('BEGIN');
          const raw=(await client.query(`INSERT INTO ops.raw_records(source_id,dataset_code,source_key,payload,payload_hash)
            VALUES($1,'repo_daily_rates',$2,$3,$4) ON CONFLICT(source_id,dataset_code,source_key,payload_hash)
            DO UPDATE SET ingested_at=now() RETURNING raw_record_id`,[source,CODE+':'+value.date,row,payloadHash])).rows[0];
          await client.query(`INSERT INTO market.repo_daily_rates(instrument_id,trade_date,source_id,tenor_days,weighted_annual_rate,close_annual_rate,unit,raw_record_id,quality_status,source_revision)
            VALUES($1,$2,$3,1,$4,$5,'annual_decimal',$6,'passed',$7)
            ON CONFLICT(instrument_id,trade_date,source_id) DO UPDATE SET weighted_annual_rate=EXCLUDED.weighted_annual_rate,
            close_annual_rate=EXCLUDED.close_annual_rate,raw_record_id=EXCLUDED.raw_record_id,source_revision=EXCLUDED.source_revision,ingested_at=now()`,[identity.instrument_id,value.date,source,value.weighted,value.close,raw.raw_record_id,payloadHash]);
          await client.query('COMMIT');samples.push({...row,weighted_annual_rate:value.weighted});
        } catch(e) {await client.query('ROLLBACK');throw e;} finally {client.release();}
      }
    } catch(e) {failures.push({year,message:e.message,code:e.code||'DATASET_INCOMPLETE'});}
  }
  const current=(await pool.query("SELECT trade_date::text FROM market.repo_daily_rates WHERE instrument_id=$1 AND quality_status='passed' AND trade_date BETWEEN $2 AND $3",[identity.instrument_id,startDate,targetDate])).rows.map(r=>r.trade_date);
  const remaining=expected.filter(d=>!current.includes(d));
  const ok=!remaining.length&&!failures.length;
  const report={ok,stageComplete:ok,mode:'repo_daily',publishDatasetCodes:['repo_daily_rates'],status:ok?'succeeded':'partial',dataAsOf:targetDate,code:CODE,startDate,targetDate,expectedDays:expected.length,remaining,remainingCount:remaining.length,failures,samples,unit:'annual_decimal',conversion:'weight / 100',officialDocumentation:DOC,publishDatasets:false,failedDatasets:ok?[]:['repo_daily_rates'],pendingStages:ok?[]:['repoDailyRates'],nextAttemptInMinutes:remaining.length?15:null};
  await require('./datasetPartitions').publishDatasetPartition('repo_daily_rates','CN',{partitionKey:targetDate,dataAsOf:targetDate,status:ok?'published':'rejected',rowCount:expected.length-remaining.length,sourceId:source,diagnostics:{...report,quality_status:ok?'passed':'failed',query_status:ok?'success':'incomplete'}});
  return report;
}
async function loadRepoRates(executor=pool.query.bind(pool)) {
  const rows=(await executor(`SELECT r.*,r.trade_date::text FROM market.repo_daily_rates r JOIN core.instruments i USING(instrument_id)
    WHERE i.canonical_code=$1 AND r.quality_status='passed' ORDER BY r.trade_date,r.ingested_at`,[CODE])).rows;
  return Object.fromEntries(rows.map(r=>[r.trade_date,{annualRate:Number(r.weighted_annual_rate),sourceId:r.source_id,rawRecordId:r.raw_record_id,sourceRevision:r.source_revision}]));
}
module.exports={normalize,tradingDates,syncRepoDailyRates,loadRepoRates};

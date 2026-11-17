// 只重解析已登记的单份官方公告，不碰全局分区或覆盖游标。
const assert=require('assert');
const {reprocessKnownDividendDocument}=require('../services/cashDividendFacts');
const {pool}=require('../db/connection');
(async()=>{let instrumentId,documentId,sourceId;const url='https://sse.com.cn/disclosure/cash-reprocess-fixture-699990.pdf';try{
 const identity={code:'601766',canonical_code:'601766.SH',instrument_id:'15',asset_class:'stock',market:'CN',exchange_code:'SSE'};
 const doc={document_id:'42',title:'中国中车2026年半年度权益分派实施公告',url:'https://big5.sse.com.cn/disclosure/601766.pdf',announced_at:'2026-10-09',source_id:14,source_code:'sse',raw_payload:{SECURITY_CODE:'601766'}};
 let stored=0;const deps={cohort:async()=>[identity],findDocument:async()=>({rows:[doc]}),storeDocument:async(i,a,s)=>{stored++;assert.strictEqual(i.instrument_id,'15');assert.strictEqual(a.url,doc.url);assert.strictEqual(s,14);return{ok:true};}};
 assert.deepStrictEqual(await reprocessKnownDividendDocument({documentId:42,code:'601766'},deps),{ok:true});assert.strictEqual(stored,1);
 const wrong=async patch=>{await assert.rejects(()=>reprocessKnownDividendDocument({documentId:42,code:'601766'},{...deps,findDocument:async()=>({rows:[{...doc,...patch}]})}));};
 await wrong({source_code:'tushare'});await wrong({url:'https://sse.com.cn.attacker.invalid/601766.pdf'});await wrong({raw_payload:{SECURITY_CODE:'601995'}});await wrong({title:'中国中车普通公告'});await wrong({announced_at:'2099-01-01'});
 await assert.rejects(()=>reprocessKnownDividendDocument({documentId:42,code:'601766'},{...deps,cohort:async()=>[]}));assert.strictEqual(stored,1);
 const db=(await pool.query('SELECT current_database() AS name')).rows[0].name;assert(/test/.test(db));
 sourceId=(await pool.query("SELECT source_id FROM ops.data_sources WHERE source_code='sse'")).rows[0].source_id;
 instrumentId=(await pool.query(`INSERT INTO core.instruments(canonical_code,name,asset_class,market,exchange_code,status) VALUES('699990.SH','定向公告测试','stock','CN','SSE','listed') RETURNING instrument_id`)).rows[0].instrument_id;
 documentId=(await pool.query(`INSERT INTO event.documents(document_type,title,announced_at,url,source_id,raw_payload) VALUES('announcement','定向公告测试权益分派实施公告','2026-10-09',$1,$2,'{"SECURITY_CODE":"699990"}') RETURNING document_id`,[url,sourceId])).rows[0].document_id;
 const bridge=require('../services/arbitrageDocumentSource'),old=bridge.runPythonExtraction;let extractions=0;
 bridge.runPythonExtraction=async()=>{extractions++;return{text:'证券代码：699990\n股份类别 股权登记日 除权（息）日 现金红利发放日 A股 2026/10/14 2026/10/15 2026/10/15\n每股派发现金红利0.11元（含税）\n个人股东和证券投资基金根据财税〔2015〕101号规定，公司派发股息红利时暂不扣缴个人所得税'};};
 try{
  const before=(await pool.query("SELECT count(*)::int AS n FROM ops.dataset_partitions WHERE dataset_code='stock_cash_dividend_facts'")).rows[0].n;
  const fixture={...identity,code:'699990',canonical_code:'699990.SH',instrument_id:instrumentId};
  const apply=()=>reprocessKnownDividendDocument({documentId,code:'699990'},{cohort:async()=>[fixture]});
  const first=await apply();assert.strictEqual(first.ok,true,JSON.stringify(first));
  const action=(await pool.query(`SELECT cash_per_share_pre_tax::float8 AS amount,raw_payload FROM fundamental.corporate_actions WHERE instrument_id=$1 AND source_key=$2`,[instrumentId,url])).rows[0];
  assert.strictEqual(action.amount,0.11);assert(action.raw_payload.documentId);assert(action.raw_payload.taxTreatment,'公告税务条款必须随事实保存');
  assert.strictEqual((await apply()).ok,true);assert.strictEqual(extractions,1,'重复解析必须复用已通过的官方事实');
  assert.strictEqual((await pool.query("SELECT count(*)::int AS n FROM ops.dataset_partitions WHERE dataset_code='stock_cash_dividend_facts'")).rows[0].n,before,'局部重解析不得修改全局分区');
 }finally{bridge.runPythonExtraction=old;}
 console.log('CASH-DIVIDEND-REPROCESS-001: source, identity, URL, date and target isolation passed');
}finally{if(instrumentId)await pool.query('DELETE FROM fundamental.corporate_actions WHERE instrument_id=$1',[instrumentId]).catch(()=>{});if(sourceId)await pool.query('DELETE FROM event.documents WHERE source_id=$1 AND url=$2',[sourceId,url]).catch(()=>{});if(sourceId)await pool.query('DELETE FROM ops.raw_records WHERE source_id=$1 AND source_key=$2',[sourceId,url]).catch(()=>{});if(instrumentId)await pool.query('DELETE FROM core.instruments WHERE instrument_id=$1',[instrumentId]).catch(()=>{});await pool.end();}})().catch(e=>{console.error(e);process.exitCode=1});

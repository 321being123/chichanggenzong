const assert=require('assert');
require('dotenv').config();
if(process.env.NODE_ENV!=='test')throw new Error('本回归只允许使用隔离测试库');
const {pool}=require('../db/connection');
const {buildConvertibleBondAnalysisFromDatabase}=require('../services/convertibleBondAnalysis');
const express=require('express');
const bondRouter=require('../routes/bondAnalysis');
let ids=[],server,noticeDocument;
const noticeUrl='https://disc.static.szse.cn/test-rating-result-025.pdf';
(async()=>{
  const source=(await pool.query("SELECT source_id FROM ops.data_sources WHERE source_code='tushare'")).rows[0].source_id;
  const stock=(await pool.query("INSERT INTO core.instruments(canonical_code,name,asset_class,market,exchange_code) VALUES('009991.SZ','测试正股','stock','CN','SZSE') RETURNING instrument_id")).rows[0].instrument_id;
  ids.push(stock);
  const bond=(await pool.query("INSERT INTO core.instruments(canonical_code,name,asset_class,market,exchange_code) VALUES('127991.SZ','测试转债','convertible_bond','CN','SZSE') RETURNING instrument_id")).rows[0].instrument_id;
  ids.push(bond);
  const profile={ts_code:'127991.SZ',stk_code:'009991.SZ',bond_short_name:'测试转债',value_date:'2024-01-01',maturity_date:'2030-01-01',
    call_clause:'连续30个交易日中至少15个交易日收盘价不低于转股价格的130%',reset_clause:'连续30个交易日中至少15个交易日收盘价低于转股价格的85%',
    put_clause:'最后两个计息年度连续30个交易日收盘价低于转股价格的70%',rate_clause:'第一年0.3%、第二年0.5%、第三年1%、第四年1.5%、第五年1.8%、第六年2%',maturity_call_price:'110',issue_rating:'AA+'};
  await pool.query(`INSERT INTO fundamental.convertible_bond_profiles(instrument_id,stock_instrument_id,bond_short_name,current_conv_price,
    value_date,maturity_date,rate_clause,maturity_call_price,issue_rating,raw_payload) VALUES($1,$2,'测试转债',10,'2024-01-01','2030-01-01',$3,'110','AA+',$4::jsonb)`,[bond,stock,profile.rate_clause,JSON.stringify(profile)]);
  await pool.query("INSERT INTO market.daily_bars(instrument_id,trade_date,source_id,close) VALUES($1,'2026-09-30',$2,12)",[stock,source]);
  await pool.query("INSERT INTO market.convertible_bond_daily_metrics(instrument_id,trade_date,source_id,close,bond_value) VALUES($1,'2026-09-30',$2,115,105)",[bond,source]);
  await pool.query("INSERT INTO market.daily_valuations(instrument_id,trade_date,source_id,pb,dividend_yield_ttm) VALUES($1,'2026-09-30',$2,1.2,0.025)",[stock,source]);
  await pool.query(`INSERT INTO fundamental.convertible_bond_ratings(instrument_id,rating_date,announced_at,rating_company,rating,rating_outlook,raw_payload)
    VALUES($1,'2026-06-23','2026-06-25','测试机构','AA+','稳定','{"outlook_inferred_from_date":"2025-06-23"}')`,[bond]);
  // BOND-ANALYSIS-003: 真实PG无快照公开读取完整本地分析、股息单位与目标日期正确且不写库。
  let writes=0;
  const originalQuery=pool.query.bind(pool);
  pool.query=(sql,...args)=>{if(/^\s*(INSERT|UPDATE|DELETE)/i.test(sql))writes++;return originalQuery(sql,...args);};
  const analysis=await buildConvertibleBondAnalysisFromDatabase('127991.SZ','2026-09-30',{persist:false});
  assert.equal(analysis.basic.convert_value,120);assert.equal(analysis.stock.dividend_yield,0.025);
  assert.equal(analysis.terms.call.ratio,1.3);assert.equal(analysis.bond.coupons.length,6);
  assert.equal(analysis.as_of,'2026-09-30');assert.equal(writes,0);
  assert.equal(analysis.rating_history[0].outlook_estimated,true,'沿用展望必须标记待核验，不能冒充原文采集值');
  await assert.rejects(buildConvertibleBondAnalysisFromDatabase('127991.SZ','2026-10-09',{persist:false}),/目标交易日/);
  const app=express();app.use('/api/bond-analysis',bondRouter);
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/bond-analysis/127991`);
  assert.equal(response.status,200);const payload=await response.json();assert.equal(payload.terms.call.ratio,1.3);assert.equal(writes,0);
  pool.query=originalQuery;
  // BOND-REPORT-ROLE-037：非适用旧记录不再制造历史缺口，真正失败仍需展示。
  await pool.query(`UPDATE fundamental.convertible_bond_profiles SET raw_payload=raw_payload||$2::jsonb WHERE instrument_id=$1`,
    [bond,JSON.stringify({analysis_inputs:{documents:{'holders:notice-only':{status:'not_applicable',previousFailure:'旧误选'},'rating:real-report':{status:'failed',error:'缺本次证据'}}}})]);
  const withFailure=await buildConvertibleBondAnalysisFromDatabase('127991.SZ','2026-09-30',{persist:false});
  assert.deepEqual(withFailure.completeness.pending_documents.map(d=>d.key),['rating:real-report']);
  assert(withFailure.completeness.missing.includes('historical_documents'));
  await pool.query(`UPDATE fundamental.convertible_bond_profiles SET raw_payload=jsonb_set(raw_payload,'{analysis_inputs,documents,rating:real-report,status}','"complete"') WHERE instrument_id=$1`,[bond]);
  const withoutFailure=await buildConvertibleBondAnalysisFromDatabase('127991.SZ','2026-09-30',{persist:false});
  assert.equal(withoutFailure.completeness.pending_documents.length,0);
  assert(!withoutFailure.completeness.missing.includes('historical_documents'));
  // BOND-API-FALLBACK-066：真实PG先存响应与标准事实，失败原文保留，API覆盖按证券/报告期/URL隔离。
  const {tryAnalysisApiFallback}=require('../services/convertibleBondAnalysisFallback');
  const apiBond={instrument_id:bond,ts_code:'127991.SZ',value_date:'2024-01-01',maturity_date:'2030-01-01'};
  const fallbackResult=await tryAnalysisApiFallback({kind:'holders',bond:apiBond,targetDate:'2026-09-30',period:'2026-06-30',documentUrls:['failed-report']},{
    fetch:async()=>({fields:['ts_code','end_date','holder_rank','holder_name','hold_amount','hold_ratio'],
      items:Array.from({length:10},(_,i)=>['127991.SZ','20260630',i+1,i===0?'真实PG测试基金':'测试自然人'+i,1,1])})});
  assert.equal(fallbackResult.status,'complete');assert.ok(fallbackResult.raw_record_id);
  const holding=(await pool.query('SELECT fund_count,holding_quantity,holding_market_value FROM fundamental.convertible_bond_fund_holdings WHERE instrument_id=$1',[bond])).rows[0];
  assert.equal(holding.fund_count,1);assert.equal(Number(holding.holding_quantity),1);assert.equal(Number(holding.holding_market_value),100);
  await pool.query(`UPDATE fundamental.convertible_bond_profiles SET raw_payload=raw_payload||$2::jsonb WHERE instrument_id=$1`,[bond,JSON.stringify({analysis_inputs:{
    targetDate:'2026-09-30',required_report_period:'2026-06-30',documents:{'holders:failed-report':{status:'failed',error:'原文解析失败'}},api_fallbacks:{holders:fallbackResult}}})]);
  const apiCovered=await buildConvertibleBondAnalysisFromDatabase('127991.SZ','2026-09-30',{persist:false});
  assert.equal(apiCovered.basic.fund_holding.fund_count,1);assert.deepEqual(apiCovered.completeness.pending_documents,[]);
  assert.equal(apiCovered.completeness.inputs.api_fallbacks.holders.api_source,'top10_cb_holders');
  await pool.query(`UPDATE fundamental.convertible_bond_profiles SET raw_payload=jsonb_set(raw_payload,'{analysis_inputs,api_fallbacks,holders,document_urls}','["other-report"]') WHERE instrument_id=$1`,[bond]);
  assert.equal((await buildConvertibleBondAnalysisFromDatabase('127991.SZ','2026-09-30',{persist:false})).completeness.pending_documents.length,1,'异URL不能覆盖失败原文');
  // 旧接口记录没有outlook_status时应按本次接口响应补标记，不借后来的评级替代历史目标日。
  const oldApiRating={ts_code:'127991.SZ',ann_date:'20260814',rating_date:'20251205',rating_com_name:'旧API测试机构',rating:'AA-',rating_outlook:null,rating_type:'长期'};
  await pool.query(`INSERT INTO fundamental.convertible_bond_ratings(instrument_id,rating_date,announced_at,rating_company,rating,source_id,raw_payload)
    VALUES($1,'2025-12-05','2026-08-14','旧API测试机构','AA-',$2,$3::jsonb)`,[bond,source,JSON.stringify(oldApiRating)]);
  const apiRepair=await tryAnalysisApiFallback({kind:'rating',bond:apiBond,targetDate:'2026-09-30',period:'2026-06-30',documentUrls:[]},{
    fetch:async()=>({fields:Object.keys(oldApiRating),items:[Object.values(oldApiRating)]})});
  assert.equal(apiRepair.status,'complete');
  const repaired=(await pool.query(`SELECT rating,raw_payload FROM fundamental.convertible_bond_ratings WHERE instrument_id=$1 AND rating_company='旧API测试机构'`,[bond])).rows[0];
  assert.equal(repaired.rating,'AA-');assert.equal(repaired.raw_payload.outlook_status,'api_unavailable');
  await pool.query(`UPDATE fundamental.convertible_bond_ratings SET raw_payload=(raw_payload-'outlook_status')||$2::jsonb WHERE instrument_id=$1 AND rating_company='旧API测试机构'`,[bond,JSON.stringify({document_hash:'c'.repeat(64)})]);
  await tryAnalysisApiFallback({kind:'rating',bond:apiBond,targetDate:'2026-09-30',period:'2026-06-30',documentUrls:[]});
  assert.equal((await pool.query(`SELECT raw_payload->>'outlook_status' status FROM fundamental.convertible_bond_ratings WHERE instrument_id=$1 AND rating_company='旧API测试机构'`,[bond])).rows[0].status,null,'原文证据不能被接口空展望改标记');
  await pool.query(`DELETE FROM fundamental.convertible_bond_ratings WHERE instrument_id=$1 AND rating_company='旧API测试机构'`,[bond]);
  await pool.query('DELETE FROM fundamental.convertible_bond_fund_holdings WHERE instrument_id=$1',[bond]);
  await pool.query(`UPDATE fundamental.convertible_bond_profiles SET raw_payload=raw_payload||$2::jsonb WHERE instrument_id=$1`,[bond,JSON.stringify({analysis_inputs:{
    targetDate:'2026-09-30',current_report_url:'undisclosed-report',required_report_period:'2026-06-30',
    terminal_gaps:{holders:{status:'not_disclosed',reason:'原文该节确为空白',evidence:{url:'undisclosed-report',document_hash:'b'.repeat(64),report_date:'2026-06-30'}}},
    documents:{'holders:undisclosed-report':{status:'failed',error:'未披露名单'}}}})]);
  const undisclosed=await buildConvertibleBondAnalysisFromDatabase('127991.SZ','2026-09-30',{persist:false});
  assert.equal(undisclosed.data_status.fund_holding,'not_disclosed');assert.equal(undisclosed.basic.fund_holding,null);
  assert.deepEqual(undisclosed.completeness.not_disclosed_fields,['fund_holding']);assert.deepEqual(undisclosed.completeness.pending_documents,[]);
  assert.equal(undisclosed.completeness.status,'partial','未披露不得伪称财务资料全齐');
  // BOND-RATING-LATEST-045：历史失败只留证据，当前要求仍须展示真实缺口。
  await pool.query(`UPDATE fundamental.convertible_bond_profiles SET raw_payload=raw_payload||$2::jsonb WHERE instrument_id=$1`,
    [bond,JSON.stringify({analysis_inputs:{rating_requirement:{version:'latest-complete-history-present-v1',latest_complete:true,required_document_urls:[]},
      documents:{'rating:old-report':{status:'failed',error:'历史缺展望'}}}})]);
  const historicalOnly=await buildConvertibleBondAnalysisFromDatabase('127991.SZ','2026-09-30',{persist:false});
  assert.deepEqual(historicalOnly.completeness.pending_documents,[]);
  assert(!historicalOnly.completeness.missing.includes('historical_documents'));
  await pool.query(`UPDATE fundamental.convertible_bond_profiles SET raw_payload=jsonb_set(raw_payload,'{analysis_inputs,rating_requirement,latest_complete}','false') WHERE instrument_id=$1`,[bond]);
  const latestMissing=await buildConvertibleBondAnalysisFromDatabase('127991.SZ','2026-09-30',{persist:false});
  assert(latestMissing.completeness.missing.includes('rating'));
  await pool.query("UPDATE fundamental.convertible_bond_profiles SET raw_payload=raw_payload-'analysis_inputs' WHERE instrument_id=$1",[bond]);
  const {readSnapshot}=require('../services/datasetPartitionRegistry');
  const baseline=await readSnapshot('bond_analysis_snapshot',{partitionKey:'2026-09-30'});
  await pool.query(`INSERT INTO analytics.analysis_snapshots(instrument_id,as_of_date,snapshot_type,formula_bundle_version,payload)
    VALUES($1,'2026-09-29','convertible_bond_analysis','4','{}'),($1,'2026-09-30','convertible_bond_analysis','4','{}')`,[bond]);
  const partition=await readSnapshot('bond_analysis_snapshot',{partitionKey:'2026-09-30'});
  assert.equal(partition.rowCount,baseline.rowCount+1,'历史快照不能充当当前分区覆盖行数');
  assert.equal(partition.dataAsOf,'2026-09-30');
  // BOND-ANALYSIS-LIFECYCLE-015: 当前退市标签不能抹去原目标日真实存续集合。
  const {loadAnalysisUniverse}=require('../services/convertibleBondAnalysisSnapshots');
  await pool.query("UPDATE core.instruments SET status='delisted',list_date='2024-01-01',delist_date='2026-10-20' WHERE instrument_id=$1",[bond]);
  assert.ok((await loadAnalysisUniverse('2026-09-30')).some(row=>String(row.instrument_id)===String(bond)));
  await pool.query("UPDATE core.instruments SET delist_date='2026-09-30' WHERE instrument_id=$1",[bond]);
  assert.ok(!(await loadAnalysisUniverse('2026-09-30')).some(row=>String(row.instrument_id)===String(bond)));
  await pool.query("UPDATE core.instruments SET status='pre_listing',delist_date='2026-10-20' WHERE instrument_id=$1",[bond]);
  assert.ok(!(await loadAnalysisUniverse('2026-09-30')).some(row=>String(row.instrument_id)===String(bond)));
  // BOND-RATING-RESULT-NOTICE-025: 真实事务保存本次与明确前次；重跑不能互删，已核验本次冲突时整体回滚。
  const official=(await pool.query("SELECT source_id FROM ops.data_sources WHERE source_code='szse'")).rows[0].source_id;
  noticeDocument=(await pool.query(`INSERT INTO event.documents(document_type,title,announced_at,url,source_id)
    VALUES('announcement','关于测试转债2026年跟踪评级结果的公告','2026-06-25',$1,$2) RETURNING document_id`,[noticeUrl,official])).rows[0].document_id;
  const noticeEvent={document_id:noticeDocument,url:noticeUrl,source:'szse',title:'关于测试转债2026年跟踪评级结果的公告',event_date:'2026-06-25'};
  const noticeResult={source_url:noticeUrl,document_hash:'d'.repeat(64),text_method:'pdf_text',rating_com_name:'测试机构',rating:'AA-',rating_outlook:'稳定',rating_date:'2026-06-23',
    rating_date_source:'official_document',rating_date_context:'current_report_issuance',rating_grade_context_version:'current-grade-v1',
    rating_context_version:'current-narrative-v2',rating_result_notice:{version:'named-result-v1',bond_code:'127991.SZ',bond_name:'测试转债',
      issuer_name:'测试股份有限公司',rating_company:'测试机构',report_reference:{title:'测试股份有限公司2026年跟踪评级报告',issued_at:'2026-06-23'},
      previous_ratings:[{rating_com_name:'测试机构',rating:'AA-',rating_outlook:'稳定',rating_date:'2023-11-01',rating_date_source:'official_document',
        rating_date_context:'explicit_previous_named_bond',date_evidence:'评级时间为2023年11月1日',rating_evidence:'测试转债前次评级结果为AA-'}]}};
  const inputBond={instrument_id:bond,ts_code:'127991.SZ',stock_code:'009991.SZ',bond_short_name:'测试转债',bond_full_name:'测试股份有限公司公开发行可转换公司债券',
    value_date:'2024-01-01',raw_payload:{rating_comp:'测试机构',analysis_inputs:{coveredThrough:'2026-09-30',documents:{}}}};
  const {syncConvertibleBondAnalysisInputs}=require('../services/convertibleBondAnalysisInputs');
  const deps={latestDate:async()=> '2026-09-30',loadUniverse:async()=>[inputBond],readDocuments:async()=>[noticeEvent],
    suspectRatingUrls:async()=>new Set(),project:async()=>structuredClone(noticeResult),persist:async()=>{}};
  const run=()=>syncConvertibleBondAnalysisInputs({businessDate:'2026-09-30',targetCodes:['127991']},deps);
  await pool.query(`UPDATE fundamental.convertible_bond_ratings SET raw_payload=raw_payload||$2::jsonb
    WHERE instrument_id=$1 AND rating_date='2026-06-23'`,[bond,JSON.stringify({rating_date_source:'official_document',
      text_method:'rapidocr-onnx-v1',document_hash:'a'.repeat(64),source_url:'old-ocr-report',rating_grade_context_version:'current-grade-v1'})]);
  await pool.query(`INSERT INTO fundamental.convertible_bond_ratings(instrument_id,rating_date,announced_at,rating_company,rating,source_id,raw_payload)
    VALUES($1,'2023-11-01','2023-11-03','测试机构','AA-',$2,'{}')`,[bond,source]);
  await run();await run();
  const saved=(await pool.query(`SELECT rating_date::text,rating,rating_outlook,source_id,raw_payload FROM fundamental.convertible_bond_ratings WHERE instrument_id=$1 ORDER BY rating_date`,[bond])).rows;
  assert.deepEqual(saved.map(r=>[r.rating_date,r.rating]),[['2023-11-01','AA-'],['2026-06-23','AA-']]);
  assert.deepEqual(saved[0].raw_payload,{},'不为旧评级补造日期/展望证据');
  assert(!saved[0].rating_outlook,'相同等级的旧评级也不沿用最新展望补写');
  assert.equal(saved[0].source_id,source,'历史记录的来源保留');
  assert.equal(saved[1].source_id,official,'最新官方公告事实来源与原文一致');
  assert.equal(saved[1].raw_payload.replaced_rating_evidence[0].rating,'AA+');
  assert.equal(saved[1].raw_payload.replaced_rating_evidence[0].document_hash,'a'.repeat(64));
  await pool.query(`UPDATE fundamental.convertible_bond_ratings SET rating='AA+',raw_payload=raw_payload||
    '{"rating_date_context":"current_summary_table","rating_grade_context_version":"current-grade-v1"}'::jsonb
    WHERE instrument_id=$1 AND rating_date='2023-11-01'`,[bond]);
  noticeResult.document_hash='e'.repeat(64);
  noticeResult.rating_outlook='负面';
  await pool.query(`UPDATE fundamental.convertible_bond_ratings SET raw_payload=raw_payload||' {"rating_outlook":null}'::jsonb WHERE instrument_id=$1 AND rating_date='2026-06-23'`,[bond]);
  await run();
  const retained=(await pool.query(`SELECT rating_date::text,rating FROM fundamental.convertible_bond_ratings WHERE instrument_id=$1 ORDER BY rating_date`,[bond])).rows;
  assert.deepEqual(retained.map(r=>r.rating),['AA+','AA-'],'历史前次差异保留，不阻塞本次最新事实');
  const doc=(await pool.query("SELECT raw_payload->'analysis_projections'->'rating' as rating FROM event.documents WHERE document_id=$1",[noticeDocument])).rows[0];
  assert.equal(doc.rating.rating,'AA-');
  assert.equal(doc.rating.rating_outlook,'负面','最新展望仍实际补齐');
  assert.equal(doc.rating.document_hash,'e'.repeat(64));
  let failedState=(await pool.query("SELECT raw_payload->'analysis_inputs'->'documents'->$2->>'error' as error FROM fundamental.convertible_bond_profiles WHERE instrument_id=$1",[bond,'rating:'+noticeUrl])).rows[0];
  assert.equal(failedState.error,null,'不因历史前次三项产生失败');
  noticeResult.rating='A';
  await pool.query(`UPDATE fundamental.convertible_bond_ratings SET raw_payload=raw_payload||' {"rating_outlook":null}'::jsonb WHERE instrument_id=$1 AND rating_date='2026-06-23'`,[bond]);
  await run();
  failedState=(await pool.query("SELECT raw_payload->'analysis_inputs'->'documents'->$2->>'error' as error FROM fundamental.convertible_bond_profiles WHERE instrument_id=$1",[bond,'rating:'+noticeUrl])).rows[0];
  assert.match(failedState.error,/已有原生本次评级结论冲突/);
  console.log('BOND-ANALYSIS-003 passed: 真实PG、公开API、零写入、日期及金融单位');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{
  if(server)await new Promise(resolve=>server.close(resolve));
  if(noticeDocument)await pool.query('DELETE FROM event.documents WHERE document_id=$1',[noticeDocument]);
  await pool.query("DELETE FROM ops.raw_records WHERE dataset_code='bond_analysis_inputs' AND source_key LIKE $1",[noticeUrl+':%']);
  await pool.query("DELETE FROM ops.raw_records WHERE source_key LIKE 'analysis-backup:127991.SZ:%'");
  if(ids.length){await pool.query('DELETE FROM fundamental.convertible_bond_fund_holdings WHERE instrument_id=ANY($1::bigint[])',[ids]);
    await pool.query('DELETE FROM market.daily_valuations WHERE instrument_id=ANY($1::bigint[])',[ids]);
    await pool.query('DELETE FROM analytics.analysis_snapshots WHERE instrument_id=ANY($1::bigint[])',[ids]);
    await pool.query('DELETE FROM fundamental.convertible_bond_ratings WHERE instrument_id=ANY($1::bigint[])',[ids]);
    await pool.query('DELETE FROM market.daily_bars WHERE instrument_id=ANY($1::bigint[])',[ids]);
    await pool.query('DELETE FROM market.convertible_bond_daily_metrics WHERE instrument_id=ANY($1::bigint[])',[ids]);
    await pool.query('DELETE FROM fundamental.convertible_bond_profiles WHERE instrument_id=ANY($1::bigint[])',[ids]);
    await pool.query('DELETE FROM core.instruments WHERE instrument_id=ANY($1::bigint[])',[ids]);}
  await pool.end();
});

const assert=require('assert');
const {validateRows,tryAnalysisApiFallback,coversDocument,VERSION}=require('../services/convertibleBondAnalysisFallback');
const {syncConvertibleBondAnalysisInputs}=require('../services/convertibleBondAnalysisInputs');
const {supportsTushareApi}=require('../services/tushare');
const bond={instrument_id:1,ts_code:'127040.SZ',stock_code:'002091.SZ',bond_short_name:'测试转债',value_date:'2021-07-03',
  maturity_date:'2027-07-03',first_conv_price:10,raw_payload:{analysis_inputs:{coveredThrough:'2026-10-24',documents:{}}}};
const holders=Array.from({length:10},(_,i)=>({ts_code:bond.ts_code,end_date:'20260630',holder_rank:i+1,
  holder_name:i===0?'测试基金':'自然人'+i,hold_amount:1,hold_ratio:1}));
const holderValue=validateRows('holders',holders,bond,'2026-10-24','2026-06-30');
assert.equal(holderValue.holding_quantity,1);assert.equal(holderValue.holding_market_value,100);assert.equal(holderValue.remain_size_ratio,.01);
assert.equal(validateRows('holders',holders.map(r=>({...r,holder_name:'自然人'})),bond,'2026-10-24','2026-06-30').fund_count,0,'完整十名名单可以证明零基金，空响应不能');
for(const broken of [holders.slice(1),holders.map(r=>({...r,holder_rank:1})),holders.map(r=>({...r,ts_code:'123274.SZ'})),holders.map(r=>({...r,end_date:'20251231'})),holders.map(r=>({...r,hold_amount:null}))])
  assert.throws(()=>validateRows('holders',broken,bond,'2026-10-24','2026-06-30'));
const rating=[{ts_code:bond.ts_code,rating_date:'20260601',ann_date:'20260602',rating:'AA',rating_com_name:'测试机构',rating_outlook:null}];
assert.equal(validateRows('rating',rating,bond,'2026-10-12','2026-06-30')[0].outlook_status,'api_unavailable');
assert.throws(()=>validateRows('rating',rating,bond,'2026-06-01','2026-06-30'),'未来公告不能补历史');
assert.throws(()=>validateRows('rating',[...rating,{...rating[0],rating:'A'}],bond,'2026-10-12','2026-06-30'));
const prices=[{ts_code:bond.ts_code,change_date:'20210703',convert_price_initial:10},
  {ts_code:bond.ts_code,change_date:'20220102',publish_date:'20211230',convertprice_bef:10,convertprice_aft:9}];
assert.equal(validateRows('price_history',prices,bond,'2026-10-12','2026-06-30').length,1);
assert.equal(validateRows('price_history',prices.slice(0,1),bond,'2026-10-12','2026-06-30').length,0,'初始价基线是有证据的无调整，与空响应区分');
assert.throws(()=>validateRows('price_history',[{...prices[1],publish_date:null}],bond,'2026-10-12','2026-06-30'));
assert.throws(()=>validateRows('price_history',[{...prices[1],convertprice_bef:8}],bond,'2026-10-12','2026-06-30'));
const coupons=Array.from({length:6},(_,i)=>({ts_code:bond.ts_code,rate_freq:1,rate_start_date:`${2021+i}0703`,rate_end_date:`${2022+i}0702`,coupon_rate:i/10}));
assert.equal(validateRows('coupon_terms',coupons,bond,'2026-10-12','2026-06-30').length,6);
assert.throws(()=>validateRows('coupon_terms',coupons.slice(1),bond,'2026-10-12','2026-06-30'));
assert.equal(supportsTushareApi('cb_rate','backup'),false);

(async()=>{
  let cached=null,fetches=0,saves=0;const order=[];
  const client={query:async(sql,args)=>{
    if(sql.startsWith('SELECT raw_record_id'))return {rows:cached?[{raw_record_id:1,payload:cached}]:[]};
    if(sql.startsWith('INSERT INTO ops.raw_records')){order.push('raw');cached=JSON.parse(args[2]);return {rows:[{raw_record_id:1}]};}
    return {rows:[]};
  }};
  const deps={client,query:async()=>({rows:[]}),fetch:async()=>{fetches++;return {fields:Object.keys(holders[0]),items:holders.map(r=>Object.values(r))};},
    save:async()=>{order.push('facts');saves++;}};
  const args={kind:'holders',bond,targetDate:'2026-10-24',period:'2026-06-30',documentUrls:['report']};
  const first=await tryAnalysisApiFallback(args,deps);
  assert.equal(first.status,'complete');assert.deepEqual(order,['raw','facts'],'原始数据必须先于标准事实入库');
  assert.equal((await tryAnalysisApiFallback({...args,targetDate:'2026-10-12'},deps)).status,'complete');
  assert.equal(fetches,1,'同一报告期跨历史任务复用已入库响应');assert.equal(saves,2);
  assert.ok(coversDocument(first,'holders','report','2026-10-24','2026-06-30',bond.ts_code));
  assert.equal(coversDocument(first,'holders','other-report','2026-10-24','2026-06-30',bond.ts_code),false);
  assert.equal(coversDocument(first,'holders','report','2026-10-13','2026-06-30',bond.ts_code),false);
  assert.equal(coversDocument(first,'holders','report','2026-10-24','2025-12-31',bond.ts_code),false);
  assert.equal(coversDocument(first,'holders','report','2026-10-24','2026-06-30','123274.SZ'),false);
  cached=null;let emptyCalls=0;
  const emptyDeps={...deps,fetch:async()=>{emptyCalls++;return {fields:['ts_code'],items:[]};},save:async()=>assert.fail('空响应不得写零持仓')};
  assert.equal((await tryAnalysisApiFallback(args,emptyDeps)).status,'empty');
  assert.equal((await tryAnalysisApiFallback(args,emptyDeps)).status,'empty');assert.equal(emptyCalls,1,'空响应也缓存，失败不冒充恢复');
  cached=null;const denied=await tryAnalysisApiFallback(args,{...deps,fetch:async()=>{throw Object.assign(Error('quota'),{code:'RATE_LIMIT',recoverAt:'2026-10-25T07:00:00Z'});}});
  assert.equal(denied.status,'failed');assert.equal(denied.errorCode,'RATE_LIMIT');assert.ok(denied.recoverAt);
  const events=[{url:'prospectus',title:'公司公开发行可转换公司债券募集说明书',event_date:'2021-07-02'},
    {url:'report',title:'公司2026年半年度报告',event_date:'2026-08-20'}];
  let attempts=0;const localBond=structuredClone(bond);
  const pipeline={loadUniverse:async()=>[localBond],latestDate:async()=> '2026-10-23',readDocuments:async()=>events,
    persist:async()=>{},persistBond:async(b,state)=>{b.raw_payload.analysis_inputs=state;},suspectRatingUrls:async()=>new Set(),
    readRatings:async()=>[{rating_date:'2026-06-01',announced_at:'2026-06-02',rating_company:'机构',rating:'AA',rating_outlook:'稳定',raw_payload:{ts_code:bond.ts_code,rating:'AA',rating_com_name:'机构',rating_date:'20260601',rating_outlook:'稳定'}}],
    project:async kind=>{if(kind==='holders')throw Error('主源解析失败');return {document_hash:'a'.repeat(64),coupon_status:'parsed'};},save:async()=>{},
    apiFallback:async()=>{attempts++;return {version:VERSION,status:'empty'};}};
  const incomplete=await syncConvertibleBondAnalysisInputs({businessDate:'2026-10-24',targetCodes:[bond.ts_code]},pipeline);
  assert.equal(attempts,1);assert.deepEqual(incomplete.missingFields[bond.ts_code],['holders']);
  const recovered=await syncConvertibleBondAnalysisInputs({businessDate:'2026-10-24',targetCodes:[bond.ts_code]},{...pipeline,apiFallback:async()=>first});
  assert.equal(recovered.ok,true);assert.deepEqual(recovered.publishDatasets,[],'单债成功不发布全市场分区');
  assert.equal(localBond.raw_payload.analysis_inputs.documents['holders:report'].status,'failed','备源不能伪造原文解析成功');
  const primary=await syncConvertibleBondAnalysisInputs({businessDate:'2026-10-24',targetCodes:[bond.ts_code]},{...pipeline,
    project:async()=>({document_hash:'a'.repeat(64),coupon_status:'parsed'}),apiFallback:async()=>assert.fail('主源成功不调用备源')});
  assert.equal(primary.ok,true);
  console.log('BOND-API-FALLBACK-066：主源优先、先入库、空值/跨债/日期/单位/完整性、历史缓存与失败保留通过');
})().catch(error=>{console.error(error);process.exitCode=1;});

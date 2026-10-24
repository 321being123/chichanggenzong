const assert=require('assert');
const {ratingRequirement,syncConvertibleBondAnalysisInputs,RATING_REQUIREMENT_VERSION}=require('../services/convertibleBondAnalysisInputs');
const {pool}=require('../db/connection');
const bond={ts_code:'113646.SH',stock_code:'603058.SH',bond_short_name:'永吉转债',value_date:'2022-04-14',raw_payload:{}};
const latest={rating_date:'2026-06-18',announced_at:'2026-06-23',rating_company:'测试评级机构',rating:'AA-',rating_outlook:'稳定',
  raw_payload:{ts_code:bond.ts_code,rating_date:'20260618',rating_com_name:'测试评级机构',rating:'AA-',rating_outlook:'稳定'}};
const historical={rating_date:'2022-03-01',announced_at:'2022-03-03',rating:'AA-',rating_company:'',rating_outlook:'',raw_payload:{}};
const old={kind:'rating',event:{url:'old-report',title:'公司2022年评级报告',event_date:'2022-03-03'}};
const current={kind:'rating',event:{url:'latest-report',title:'公司2026年评级报告',event_date:'2026-06-23'}};
const check=(rows,docs=[old,current],date='2026-10-20')=>ratingRequirement(bond,rows,docs,date);

// BOND-RATING-LATEST-045：历史只需有评级，最新必须具备本债身份、实际日、机构和非沿用展望。
assert.strictEqual(check([historical,latest]).latest_complete,true);
assert.strictEqual(check([historical,latest]).history_count,2);
for(const change of [{rating_outlook:''},{rating_company:''},
  {raw_payload:{...latest.raw_payload,ts_code:'113647.SH'}},
  {raw_payload:{...latest.raw_payload,rating_outlook:null,outlook_inferred_from_date:'2022-03-01'}},
  {raw_payload:{...latest.raw_payload,rating_date_source:'announcement_fallback'}},
  {raw_payload:{...latest.raw_payload,rating_type:'主体信用评级'}}]) {
  const result=check([{...latest,...change},{...historical,rating_company:'旧机构',rating_outlook:'稳定'}]);
  assert.strictEqual(result.latest_complete,false,'不能用旧的完整记录代替最新缺项');
  assert.deepStrictEqual(result.required_document_urls,['latest-report']);
}
assert.strictEqual(check([latest,{...latest,rating:'AA'}]).latest_complete,false);
assert.strictEqual(check([latest],[{kind:'rating',event:{...current.event,url:'newer',event_date:'2026-07-01'}},old]).latest_complete,true,'后发报告不能阻塞已有完整评级');
const newerNotice={kind:'rating',event:{url:'newer-notice',title:'公司评级结果公告',event_date:'2026-07-01'}};
assert.strictEqual(check([latest],[newerNotice,current]).latest_complete,false,'更新结果公告必须重新核验');
assert.deepStrictEqual(check([], [old,current]).required_document_urls,['latest-report'],'没有结果公告时仍须解析最新评级报告');
assert.strictEqual(check([latest],[], '2026-06-22').history_available,false,'不能使用未来公布的评级');
assert.strictEqual(check([latest],[], '2026-06-23').latest_complete,true);
const wrongNotice={...latest,raw_payload:{...latest.raw_payload,document_hash:'a'.repeat(64),bond_name:bond.bond_short_name,
  security_code:bond.stock_code,rating_date_source:'official_document',rating_result_notice:{bond_code:'113647.SH',bond_name:bond.bond_short_name,rating_company:latest.rating_company}}};
assert.strictEqual(check([wrongNotice]).latest_complete,false,'明确错误债券代码不能退回名称匹配');

(async()=>{
  const failures={'rating:old-report':{status:'failed',error:'旧报告缺实际评级日或展望',parserVersion:'analysis-input-v4'}};
  bond.raw_payload.analysis_inputs={coveredThrough:'2026-10-20',documents:structuredClone(failures)};
  const parsed=[];
  const docs=[old.event,current.event,{url:'prospectus',title:'公司可转换公司债券募集说明书',event_date:'2022-04-12'},
    {url:'halfyear',title:'公司2026年半年度报告',event_date:'2026-08-20'}];
  const deps={latestDate:async()=> '2026-10-20',loadUniverse:async()=>[bond],readDocuments:async()=>docs,
    readRatings:async()=>[historical,latest],suspectRatingUrls:async()=>new Set(),persist:async()=>{},
    persistBond:async(b,state)=>{b.raw_payload.analysis_inputs=structuredClone(state);},
    project:async(kind,event)=>{parsed.push(event.url);if(kind==='rating')throw Error('当前标准评级完整，不应读取评级PDF');return {document_hash:'b'.repeat(64)};},save:async()=>{}};
  const result=await syncConvertibleBondAnalysisInputs({businessDate:'2026-10-20'},deps);
  assert.strictEqual(result.ok,true);
  assert(!parsed.includes('old-report')&&!parsed.includes('latest-report'));
  assert.deepStrictEqual(bond.raw_payload.analysis_inputs.documents['rating:old-report'],failures['rating:old-report'],'旧失败证据保留，不伪装为解析成功');
  assert.strictEqual(bond.raw_payload.analysis_inputs.rating_requirement.version,RATING_REQUIREMENT_VERSION);
  assert.deepStrictEqual(bond.raw_payload.analysis_inputs.rating_requirement.required_document_urls,[]);
  await syncConvertibleBondAnalysisInputs({businessDate:'2026-10-19'},{...deps,latestDate:async()=> '2026-10-19'});
  assert.strictEqual(bond.raw_payload.analysis_inputs.rating_requirement.target_date,'2026-10-20','补旧日不覆盖已核验的更新评级范围证据');
  parsed.length=0;
  const missingLatest=await syncConvertibleBondAnalysisInputs({businessDate:'2026-10-20'},{...deps,
    readRatings:async()=>[historical,{...latest,rating_outlook:'',raw_payload:{...latest.raw_payload,rating_outlook:null}}]});
  assert.strictEqual(missingLatest.ok,false);
  assert(parsed.includes('latest-report')&&!parsed.includes('old-report'));
  assert(missingLatest.missingFields[bond.ts_code].includes('rating'));
  console.log('BOND-RATING-LATEST-045: 历史可缺三项、最新严格核验、未来隔离、旧失败保留和不再重复解析历史通过');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>pool.end());

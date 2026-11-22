// 现金收益纯单测合并文件（合并原 cash-income-facts / related-documents / announcement / calculation / contract / settlement / import / source-admission）。
const assert = require('assert');
const { spawnSync } = require('child_process');

// --- cash-income-contract.test.js ---
const M = require('../../public/shared/nav-math');

function pure() {
  const anchor = { date:'2026-10-01',snapshotSource:'imported',isLocked:true,cashCny:1000,invested:2000 };
  const future = { ...anchor,date:'2026-11-01',cashCny:99999,invested:99999 };
  const flows = [
    {date:'2026-10-01',amount:100}, // 同日已吸收
    {date:'2026-10-02',amount:200}, // 旧行兼容外部资金
    {date:'2026-10-02',amount:10,flow_type:'dividend'},
    {date:'2026-10-02',amount:-2,flow_type:'dividend_tax'},
    {date:'2026-10-02',amount:3,flow_type:'repo_interest',status:'estimated'},
    {date:'2026-10-02',amount:-0.1,flow_type:'repo_fee',status:'estimated'},
    {date:'2026-10-02',amount:888,flow_type:'dividend',status:'estimated'},
    {date:'2026-10-02',amount:999,flow_type:'repo_interest',status:'revoked'},
    {date:'2026-12-01',amount:90000}
  ];
  const data = { cashBase:100,navHistory:[future,anchor],cashFlows:flows,trades:[
    {date:'2026-10-02',direction:'buy',amount:100,commission:1,created_at:'2026-10-10 09:00:00'},
    {date:'2026-10-02',direction:'open',amount:888},
    {date:'2026-10-02',direction:'adjust',amount:888},
    {date:'2026-11-02',direction:'sell',amount:888}
  ]};
  const state = M.cashAt(data,'2026-10-02');
  assert.strictEqual(state.value,1109.9);
  assert.strictEqual(state.cashConfirmed,1107);
  assert.strictEqual(state.cashEstimatedDelta,2.9);
  assert.strictEqual(state.cashIncludesEstimates,true);
  assert.strictEqual(state.incomplete,false);
  assert.strictEqual(M.investedAt(data.navHistory,flows,100,'2026-10-02'),2200);
  assert.strictEqual(M.investedAt(data.navHistory,flows,100,'2026-09-30'),100);
  assert.strictEqual(M.investedAt([],flows,100,'2026-10-02'),400);
  assert.strictEqual(M.cashAt({cashBase:1,navHistory:[{...anchor,cashCny:null}]},'2026-10-02').value,1);
  assert.strictEqual(M.cashAt({cashFlows:[{date:'2026-10-01',amount:0.1},{date:'2026-10-01',amount:0.2}]},'2026-10-02').value,0.3);
  assert.strictEqual(M.cashAt({...data,navHistory:[{...anchor,date:'2026-10-03'}]},'2026-10-02').anchor,null);
  assert.strictEqual(M.cashAt({...data,trades:[{date:'2026-10-02',direction:'buy',quote_currency:'HKD',amount:100}]},'2026-10-02').incomplete,true);
  assert.strictEqual(M.cashAt({...data,cashFlows:[{date:'2026-10-02',amount:1,flow_type:'unknown'}]},'2026-10-02').incomplete,true);
  assert.strictEqual(M.isExternalTransfer({flow_type:'unknown'}),false);
  assert.throws(()=>M.cashAt(data,'2026-02-30'));
  const timed = {cashBase:0,cashFlows:[{date:'2026-10-02',amount:10,created_at:'2026-10-09 09:00:00'},
    {date:'2026-10-02',amount:20,settled_at:'2026-10-02T18:00:00+08:00'}]};
  assert.strictEqual(M.cashAt(timed,'2026-10-02','2026-10-02T17:00:00+08:00').value,10,'补录创建时间不影响历史生效日，真实到账时刻仍受截止保护');
}
if (process.argv.includes('--tz-child')) { pure(); process.exit(0); }
pure();
for (const TZ of ['UTC','Asia/Shanghai','America/New_York']) {
  const r = spawnSync(process.execPath,[__filename,'--tz-child'],{env:{...process.env,TZ},encoding:'utf8'});
  assert.strictEqual(r.status,0,r.stderr);
}
console.log('cash income contract: dates, origins, precision, capital and estimates passed in 3 timezones');


// --- cash-income-facts.test.js ---
{
const assert=require('assert');
const {parseDividend,sameDividendPeriod}=require('../services/cashDividendFacts');
const cn={canonical_code:'600219.SH',market:'CN'},hk={canonical_code:'00358.HK',market:'HK'};
const sse='证券代码：600219\n股份类别 股权登记日 最后交易日 除权（息）日 现金红利发放日 Ａ股 2026/10/14 － 2026/10/15 2026/10/15\n二、分配方案 每股派发现金红利0.265元（含税）\n每股现金红利=0.263元';
assert.deepStrictEqual([parseDividend(sse,cn).recordDate,parseDividend(sse,cn).payDate,parseDividend(sse,cn).amount],['2026-10-14','2026-10-15',0.265]);
const shortTable='证券代码：601995\n股份类别\n股权登记日\n除权（息）日\n现金红利发放日\nＡ股\n2026/8/21\n2026/8/24\n2026/8/24\n每股派发现金红利人民币0.23元';
const shortFact=parseDividend(shortTable,{canonical_code:'601995.SH',market:'CN'});
assert.deepStrictEqual([shortFact.recordDate,shortFact.exDate,shortFact.payDate,shortFact.amount],['2026-08-21','2026-08-24','2026-08-24',0.23]);
const conflict=shortTable+'\n股份类别 股权登记日 除权（息）日 现金红利发放日 A股 2026/8/20 2026/8/24 2026/8/24';
assert.strictEqual(parseDividend(conflict,{canonical_code:'601995.SH',market:'CN'}).reason,'incomplete_dividend_terms');
assert.strictEqual(parseDividend(shortTable,{canonical_code:'601996.SH',market:'CN'}).reason,'document_security_not_verified');
const sz='证券代码：000719\n二、权益分派方案 每10股派发6.6元人民币现金（含税）\n股权登记日为：2026年6月30日\n现金红利将于2026年7月1日直接划入资金账户';
assert(Math.abs(parseDividend(sz,{market:'CN',canonical_code:'000719.SZ'}).amount-0.66)<1e-12);
assert.strictEqual(parseDividend(sz,{market:'CN',canonical_code:'000719.SZ'}).payDate,'2026-07-01');
const form='股份代號\n00358\n股息類型\n末期\n宣派股息的報告期末\n2025年12月31日\n宣派股息\n每10 股6 RMB\n記錄日期\n2026年6月19日\n股息派發日\n2026年7月17日';
const fact=parseDividend(form,hk);assert.strictEqual(fact.amount,0.6);assert.strictEqual(fact.currency,'CNY');
assert.strictEqual(parseDividend(form.replace('每10 股6','每股0.6'),hk).amount,0.6);
assert.strictEqual(parseDividend(form.replace('2026年6月19日','有待公佈'),hk).reason,'incomplete_dividend_terms');
assert(sameDividendPeriod(fact,parseDividend(form.replace('2026年6月19日','有待公佈'),hk)));
assert(!sameDividendPeriod(fact,{...fact,period:'2024-12-31'}));
assert.strictEqual(parseDividend(form.replace('每10 股6','每0股6'),hk).reason,'incomplete_dividend_terms');
assert.strictEqual(parseDividend(form,hk).reason,undefined);
assert.strictEqual(parseDividend('股份代號：1066\n海外監管公佈\n证券代码：688161\n'+sz,{market:'HK',canonical_code:'01066.HK'}).reason,'incomplete_dividend_terms');
assert.strictEqual(parseDividend(form,{market:'HK',canonical_code:'00598.HK'}).reason,'document_security_not_verified');
assert.strictEqual(parseDividend(form.replace('2026年7月17日','2026年5月17日'),hk).reason,'invalid_dividend_timeline');
console.log('cash income facts: market identity, SSE date table, actual distribution units and same-period replacement passed');

}

// --- cash-income-related-documents.test.js ---
{
const assert=require('assert'),{resolveHkRelatedDocument,normalizeChineseDates}=require('../services/cashDividendFacts');
const cases=[
 ['00358','江西銅業股份有限公司','0.6','2026-06-19','2026-07-17','有關末期股息每股人民幣0.60元。江西銅業股份有限公司向二零二六年六月十九日名列股東名冊的H股股東派發，股息單於二零二六年七月十七日寄發。'],
 ['00762','中國聯合網絡通信(香港)股份有限公司','0.1329','2026-06-05','2026-06-24','股份代號：762 每股人民幣0.1329元。2026年6月5日名列股東名冊，有關末期股息預計將於2026年6月24日或前後支付。'],
 ['00874','廣州白雲山醫藥集團股份有限公司','0.3','2026-09-10','2026-09-30','廣州白雲山醫藥集團股份有限公司：每股派發現金股息人民幣0.30元，2026年9月10日登記在冊的H股股東，股息將於2026年9月30日由本公司發放至中登公司。'],
 ['01066','山東威高集團醫用高分子製品股份有限公司','0.06','2026-06-09','2026-07-10','股份代號：1066 每股股份人民幣0.06元，二零二六年六月九日名列股東名冊。收款代理人將於二零二六年七月十日派發。'],
 ['01186','中國鐵建股份有限公司','0.3','2026-07-27','2026-08-21','中國鐵建股份有限公司：末期股息每股人民幣0.3元。A股和H股股權登記日2026年7月27日；A股派息2026年7月28日；H股派息2026年8月21日。'],
 ['01800','中國交通建設股份有限公司','0.07729','2026-07-20','2026-08-14','股份代號：1800 每股人民幣0.07729元，2026年7月20日H股名列股東名冊，2026年8月14日派付末期股息。'],
 ['02357','中國航空科技工業股份有限公司','0.0665','2026-05-29','2026-06-25','股份代號：2357 每股人民幣0.0665元，二零二六年五月二十九日名列本公司H股股東登記名冊，二零二六年六月二十五日派發。'],
 ['02877','中國神威藥業集團有限公司','0.43','2026-05-07','2026-05-19','股份代號：2877 二零二六年第一次中期股息每股人民幣43分，二零二六年五月十九日派付予二零二六年五月七日名列股東名冊的股東。'],
 ['06881','中國銀河證券股份有限公司','0.225','2026-07-13','2026-08-21','股份代號：06881 每10股派發現金股利人民幣2.25元。H股登記2026年7月13日，2026年8月21日派息；A股派息2026年7月14日。']
];
for(const [code,name,amount,recordDate,payDate,text] of cases){
 const identity={canonical_code:code+'.HK',market:'HK'},ref={documentId:'official_'+code,url:'https://www1.hkexnews.hk/'+code,contentHash:'a'.repeat(64),issuerName:name,announcedAt:'2026-09-01',fact:{recordDate,payDate,currency:'CNY',amount:Number(amount),period:'2025-12-31',dividendType:'末期',dividendNature:'普通股息'}};
 const linked=resolveHkRelatedDocument(text,identity,[ref]);assert(linked,code+'本地九个对象补充公告关联');assert.strictEqual(linked.relatedFact.payDate,payDate);assert.strictEqual(linked.relatedFact.documentId,ref.documentId);
 assert.strictEqual(resolveHkRelatedDocument(text.replace(/人民幣[\d.]+/,'人民幣99'),identity,[ref]),null,'金额不匹配不得关联');
 assert.strictEqual(resolveHkRelatedDocument('股份代號：9999 '+text,identity,[ref]),null,'外公司代码不得凭日期金额拼接');
 const ambiguous={...ref,documentId:'other',fact:{...ref.fact,payDate:'2026-12-30'}};assert.strictEqual(resolveHkRelatedDocument(text+' 2026年12月30日',identity,[ref,ambiguous]),null,'多事件歧义不宣称完成');
 assert.strictEqual(linked.classification,'verified_related_announcement');assert.strictEqual(linked.recordDate,undefined,'补充说明不生成第二份实施事实');
}
assert.strictEqual(normalizeChineseDates('二零\n二六年十二月三十一日'),'2026年12月31日','中文跨行日期解析');
const excluded=resolveHkRelatedDocument('股份代號：1800 海外監管公告 上海证券交易所 证券代码：601800 拟向全体股东每股派发现金股利0.07729元',{canonical_code:'01800.HK',market:'HK'},[]);
assert.strictEqual(excluded.classification,'excluded_a_share_regulatory_proposal','A股监管附件不冒充H股实施');
console.log('HK related documents: nine identities, Chinese dates, amounts, stock mismatch, ambiguity and A-share attachment isolation passed');

}

// --- cash-income-announcement.test.js ---
{
const assert=require('assert'),{parseHkTaxTreatment,estimateHkAnnouncement,hkReceiptDate}=require('../services/cashDividendSettlement');
const M=require('../../public/shared/nav-math');
const tax=parseHkTaxTreatment('股息所涉及的代扣所得稅\n不適用');assert(tax);assert.strictEqual(tax.layers[0].rate,'0.20');
assert(parseHkTaxTreatment('個人居民（中國內地登記地址）20%適用於內地個人投資者通過滬港通或深港通投資香港上市H股所得股息'));
assert.strictEqual(parseHkTaxTreatment('非居民企業10% H股個人股東10%'),null,'外國/企業投資者條款不套港股通個人');
const action=(id,amount,nature='普通股息')=>({action_id:id,pay_date:'2026-09-25',currency_code:'HKD',cash_per_share_pre_tax:amount,raw_payload:{documentId:id,contentHash:'a'.repeat(64),period:'2026-06-30',dividendType:'中期',dividendNature:nature,taxTreatment:tax}});
const fx=[{base_currency:'HKD',quote_currency:'CNY',rate_date:'2026-09-30',rate:'0.90',source_id:7},{base_currency:'HKD',quote_currency:'CNY',rate_date:'2026-10-01',rate:'1.1',source_id:7}];
const total=estimateHkAnnouncement({actions:[action(2,'0.056'),action(1,'0.056'),action(3,'0.008','特別股息')],quantity:10000,fxRows:fx,receiptDate:'2026-09-30'});
assert.strictEqual(total.amount,460.8,'普通+特别合计，旧版重复不叠加');assert.strictEqual(total.components.length,2);assert.strictEqual(total.components[0].fxDate,'2026-09-30');assert.strictEqual(total.brokerVerified,false);
assert.strictEqual(estimateHkAnnouncement({actions:[action(1,'1')],quantity:100,fxRows:[],receiptDate:'2026-09-30'}).reason,'missing_historical_dividend_fx');
const net={...action(4,'100'),cash_per_share_after_tax:'72',currency_code:'CNY',raw_payload:{...action(4,'100').raw_payload,taxTreatment:{kind:'HK_connect_personal',amountBasis:'net',layers:[]}}};
assert.strictEqual(estimateHkAnnouncement({actions:[net],quantity:1,receiptDate:'2026-09-30'}).amount,72,'公告明确税后净额不重扣');
const {hkDividendCalendar}=require('../services/cashIncome'),years=require('../config/holidays').loadHolidays().years;
const calendar=hkDividendCalendar(years,[]);
assert.strictEqual(hkReceiptDate('2026-09-08',calendar).receiptDate,'2026-09-11');
assert.strictEqual(hkReceiptDate('2026-09-30',calendar).receiptDate,'2026-10-12','国庆及周末顺延，不按自然日+3');
assert.strictEqual(hkReceiptDate('2026-08-14',calendar).receiptDate,'2026-08-19','派息早于导入基准但到账晚于基准');
assert.strictEqual(hkReceiptDate('2026-10-16',calendar).receiptDate,'2026-10-22','香港重阳休市顺延');
assert.strictEqual(hkReceiptDate('2026-12-31',calendar).reason,'missing_hk_dividend_calendar','未知下一年不猜开市');
assert.strictEqual(estimateHkAnnouncement({actions:[net],quantity:1}).reason,'missing_hk_dividend_calendar','不隐式回退T+0');
assert.strictEqual(M.isEffectiveFlow({flow_type:'dividend_tax',status:'estimated',quality_status:'authorized_deferred_tax_calculation',evidence:{authorizedPolicy:'cash-income-v1'}}),true);
assert.strictEqual(M.isEffectiveFlow({flow_type:'dividend_tax',status:'estimated',quality_status:'authorized_deferred_tax_calculation',evidence:{}}),false);
console.log('announcement cash income: personal tax isolation, ordinary/special components, historical FX, net no double tax and authorized deferred tax passed');
const {userTaxExemption,userScopeExclusion}=require('../services/cashIncome');
const exemption={eventKey:'event-a',code:'000001',confirmedBy:'owner',holdingPeriod:'over_one_year',allEntitledShares:true,quantity:1900};
const policy={cnDividendExemptions:[exemption],dividendScopeExclusions:[{code:'404002',confirmedBy:'owner',reason:'退市搜特转债不参与股票分红',outsideStockDividendScope:true}]};
const cnIdentity={market:'CN',code:'000001'},cnAction={currency_code:'CNY',raw_payload:{documentId:'official'}};
assert.deepStrictEqual(userTaxExemption(policy,'owner',cnIdentity,cnAction,'event-a',{quantity:1900}),exemption);
assert.strictEqual(userTaxExemption(policy,'other',cnIdentity,cnAction,'event-a',{quantity:1900}),null);
assert.strictEqual(userTaxExemption(policy,'owner',cnIdentity,cnAction,'different-event',{quantity:1900}),null);
assert.strictEqual(userTaxExemption(policy,'owner',cnIdentity,cnAction,'event-a',{quantity:2000}),null);
assert.strictEqual(userTaxExemption(policy,'owner',{...cnIdentity,market:'HK'},cnAction,'event-a',{quantity:1900}),null);
assert.strictEqual(userTaxExemption(policy,'owner',cnIdentity,{currency_code:'CNY'},'event-a',{quantity:1900}),null);
assert.strictEqual(userScopeExclusion(policy,'owner','404002').outsideStockDividendScope,true);
assert.strictEqual(userScopeExclusion(policy,'other','404002'),null);
assert.strictEqual(userScopeExclusion(policy,'owner','501312'),null);

}

// --- cash-income-calculation.test.js ---
{
const assert=require('assert');
const {calculateRepo,calendarFor,holdingAt}=require('../services/cashIncome');
const M=require('../../public/shared/nav-math');
const anchor={date:'2026-09-09',cashCny:100000,snapshotSource:'imported',isLocked:true,invested:100000};
const input={cashBase:0,cashFlows:[],trades:[],navHistory:[anchor]};
const calendar=calendarFor({'2026':[]});
const result=calculateRepo(input,anchor,'2026-09-14',calendar);
assert.strictEqual(result.trades[0].tradeDate,'2026-09-10');
assert.strictEqual(result.trades[0].interestDays,3);
assert.strictEqual(result.trades[0].availableDate,'2026-09-11');
assert.strictEqual(result.trades[0].interestEndExclusive,'2026-09-14');
assert.strictEqual(result.trades[0].principal,99000); // 整千本金之外须留出费用，不能透支。
assert.strictEqual(result.trades[0].gross,10.58);
assert.strictEqual(result.trades[0].fee,0.10);
assert.deepStrictEqual(result.trades.map(r=>r.tradeDate),['2026-09-10','2026-09-11','2026-09-14']);
assert.strictEqual(result.flows.filter(f=>f.flow_type==='repo_interest').length,2); // 下一日未到账不入账
assert.strictEqual(M.investedAt([anchor],result.flows,0,'2026-09-14'),100000);
const noFuture=calculateRepo({...input,cashFlows:[{date:'2026-09-10',amount:2000}]}, {...anchor,cashCny:0},'2026-09-11',calendar);
// 日终入金不能提前投入；这里覆盖现金基准与真实数据不一致的情况，重新使用零基准。
const zero={...input,navHistory:[{...anchor,cashCny:0}],cashFlows:[{date:'2026-09-10',amount:2000}]};
const funded=calculateRepo(zero,zero.navHistory[0],'2026-09-11',calendar);
assert.deepStrictEqual(funded.trades.map(r=>r.tradeDate),['2026-09-11']);
const holiday=calculateRepo(input,anchor,'2026-09-10',calendarFor({'2026':['2026-09-11']}));
assert.strictEqual(holiday.trades[0].availableDate,'2026-09-14');
assert.strictEqual(holiday.trades[0].interestDays,1);
assert.throws(()=>calendarFor({})('2026-09-10'),/缺少/);
const trades=[{id:'1',code:'x',direction:'open',date:'2026-09-01',quantity:1000},
  {id:'2',code:'x',direction:'sell',date:'2026-09-08',quantity:400}];
assert.strictEqual(holdingAt(trades,'x','2026-09-07',[{code:'x',quantity:600}]).quantity,1000);
assert.strictEqual(holdingAt(trades,'x','2026-09-09',[{code:'x',quantity:600}]).quantity,600);
assert.strictEqual(holdingAt(trades,'x','2026-09-07',[{code:'x',quantity:500}]).reason,'position_history_does_not_reconcile');
assert.strictEqual(holdingAt([], 'x','2026-09-07',[]).reason,'missing_position_history');
const authorized={date:'2026-09-10',amount:100,flow_type:'dividend',status:'estimated',quality_status:'authorized_dividend_calculation',evidence:{authorizedPolicy:'cash-income-v1'}};
const hkFuture={...authorized,date:'2026-09-11',amount:5000};
const delayed=calculateRepo(input,anchor,'2026-09-14',calendar,[hkFuture]);
assert.strictEqual(delayed.trades[0].principal,result.trades[0].principal,'港股T+3到账前不提前投入回购');
assert.strictEqual(delayed.trades[1].principal,result.trades[1].principal,'港股到账日仍按前日现金投入');
assert(delayed.trades[2].principal>result.trades[2].principal,'港股到账后的下一交易日参与回购');
assert.strictEqual(M.cashAt({...input,cashFlows:[authorized]},'2026-09-10').cashEstimatedDelta,100);
assert.strictEqual(M.isEffectiveFlow({...authorized,evidence:{}}),false);
const octoberAnchor={...anchor,date:'2026-10-09'},octoberInput={...input,navHistory:[octoberAnchor]};
const missing=calculateRepo(octoberInput,octoberAnchor,'2026-10-14',calendar);
assert.strictEqual(missing.pending[0].date,'2026-10-12');assert.strictEqual(missing.processedThrough,'2026-10-11');assert.strictEqual(missing.trades.length,0);
const market=calculateRepo(octoberInput,octoberAnchor,'2026-10-12',calendar,[],{rates:{'2026-10-12':{annualRate:0.01,rawRecordId:1}}});
assert.strictEqual(market.trades[0].annualRate,0.01);assert.strictEqual(market.flows[0].status,'estimated');
for(const status of ['rejected','pending_evidence']){
  const blocked=calculateRepo(octoberInput,octoberAnchor,'2026-10-12',calendar,[],{rates:{'2026-10-12':{annualRate:0.01}},sourceAdmission:{status}});
  assert.strictEqual(blocked.trades.length,0,'未准入即使字段存在也不能使用市场利率');assert.strictEqual(blocked.pending[0].reason,'repo_source_admission_pending');
}
assert.strictEqual(calculateRepo(octoberInput,octoberAnchor,'2026-10-12',calendar,[],{rates:{'2026-10-12':{annualRate:0.01}},sourceAdmission:{status:'admitted'}}).trades.length,1);
const excludedRepo=calculateRepo(input,anchor,'2026-09-10',calendar,[],{excludedEvents:['repo:204001.SH:2026-09-10']});assert.strictEqual(excludedRepo.trades.length,0);
console.log('cash income calculation: settlement weekends/holidays, next-day funds, no future credit, eligibility and estimate authorization passed');

}

// --- cash-income-settlement.test.js ---
{
const assert=require('assert');
const {calculateHkNet,assessDeferredTax,taxRate,anniversary}=require('../services/cashDividendSettlement');
const {parseCnTaxTreatment}=require('../services/cashDividendSettlement');
assert(parseCnTaxTreatment('财税〔2015〕101号规定，对自然人股东持股一年以内，公司暂不扣缴个人所得税'));
assert.strictEqual(parseCnTaxTreatment('对企业股东公司暂不扣缴个人所得税 财税2015年101号'),null);
assert.strictEqual(parseCnTaxTreatment('对自然人股东暂不扣缴个人所得税'),null);
const common={currency:'HKD',settlementDate:'2026-09-08',fxRate:'0.90',sourceRef:'actual-event-fx-voucher'};
assert.strictEqual(calculateHkNet({...common,amountBasis:'gross',originalAmount:'100',layers:[{rate:'0.20',base:'gross',sourceRef:'event-personal-connect-tax'}]}).amountCny,'72.00');
const layered=calculateHkNet({...common,amountBasis:'gross',originalAmount:'100',layers:[{rate:'0.10',base:'gross',sourceRef:'issuer-event-withholding'},{rate:'0.20',base:'previous_net',sourceRef:'connect-settlement'}]});assert.strictEqual(layered.netOriginal,'72.000000000000');assert.strictEqual(layered.amountCny,'64.80');
assert.strictEqual(calculateHkNet({...common,amountBasis:'net',originalAmount:'72'}).amountCny,'64.80');
assert.strictEqual(calculateHkNet({...common,amountBasis:'net',originalAmount:'1.999999',fxRate:'1'}).amountCny,'1.99');
assert.throws(()=>calculateHkNet({...common,amountBasis:'net',originalAmount:'100',layers:[{rate:'0.2'}]}),/重复扣税/);
assert.throws(()=>calculateHkNet({...common,amountBasis:'gross',originalAmount:'100'}),/逐层/);
assert.throws(()=>calculateHkNet({...common,amountBasis:'gross',originalAmount:'100',layers:[{rate:'0.20',base:'gross'}]}),/证据/);
assert.strictEqual(taxRate('2026-01-15','2026-02-15'),0.2);assert.strictEqual(taxRate('2026-01-15','2026-02-16'),0.1);
assert.strictEqual(taxRate('2025-01-15','2026-01-15'),0.1);assert.strictEqual(taxRate('2025-01-15','2026-01-16'),0);
assert.strictEqual(anniversary('2024-02-29',12),'2025-02-28');assert.strictEqual(anniversary('2026-01-31',1),'2026-02-28');
const code='600000',eventKey='dividend:1:2026-08-20:2026-08-25';
const trade=(id,date,direction,quantity)=>({id,date,code,direction,quantity});
const base={code,eventKey,recordDate:'2026-08-20',payDate:'2026-08-25',targetDate:'2026-10-10',grossPerShare:'0.1234567890'};
const fifo=assessDeferredTax({...base,trades:[trade('old','2025-01-01','buy',100),trade('new','2026-08-01','buy',100),trade('sale','2026-08-28','sell',150)]});
assert(fifo.complete);assert.deepStrictEqual(fifo.sales[0].parts.map(p=>p.quantity),[100,50]);assert.deepStrictEqual(fifo.sales[0].parts.map(p=>p.rate),[0,0.2]);assert.strictEqual(fifo.sales[0].amount,'1.23');
assert.strictEqual(fifo.remainingEntitlement[0].quantity,50);
const intraday=assessDeferredTax({...base,trades:[trade('old','2026-08-01','buy',100),trade('buy','2026-08-28','buy',100),trade('sell','2026-08-28','sell',100)]});assert.strictEqual(intraday.sales.length,0,'同日日终净额为零不重复计算回转税');
const before=assessDeferredTax({...base,trades:[trade('old','2026-08-01','buy',100),trade('before','2026-08-19','sell',100)]});assert.strictEqual(before.sales.length,0);
const unknown=assessDeferredTax({...base,trades:[trade('open','2026-08-01','open',100),trade('sale','2026-08-28','sell',100)]});assert.strictEqual(unknown.sales[0].amount,null);assert.strictEqual(unknown.sales[0].parts[0].acquired,null);
assert.strictEqual(unknown.complete,false);
assert.strictEqual(assessDeferredTax({...base,expectedQuantity:1,trades:[trade('buy','2026-08-01','buy',100),trade('sale','2026-08-28','sell',50)]}).sales[0].amount,null,'未闭合持仓不能猜税款');
assert.strictEqual(assessDeferredTax({...base,trades:[trade('buy','2026-08-01','buy',100),trade('adjust','2026-08-22','adjust',100),trade('sale','2026-08-28','sell',50)]}).sales[0].amount,null,'未解释数量调整阻止税率猜测');
console.log('cash dividend settlement: net vs gross, evidenced layered tax, FX/floor rounding, FIFO daily net and calendar holding boundaries passed');

}

// --- cash-income-import.test.js ---
{
const assert=require('assert'),crypto=require('crypto');
const {validate}=require('../scripts/importCashIncomeEvidence');
const text='official dividend fixture',contentHash=crypto.createHash('sha256').update(text).digest('hex');
const fixture={username:'daicunzai',targetDate:'2026-10-10',anchorDate:'2026-08-16',accounts:[{name:'华泰账户'},{name:'招商证券账户'}],documents:Array.from({length:75},()=>({payload:{text,announcement:{}},contentHash,sourceCode:'hkex'})),coverages:Array(38).fill({}),rates:Array(34).fill({})};
assert.strictEqual(validate(fixture),fixture);
for(const changed of [{username:'other'},{targetDate:'2026-10-11'},{accounts:[{name:'华泰账户'}]},{documents:fixture.documents.slice(1)},{rates:fixture.rates.slice(1)}])assert.throws(()=>validate({...fixture,...changed}));
assert.throws(()=>validate({...fixture,documents:fixture.documents.map((r,i)=>i===0?{...r,contentHash:'wrong'}:r)}),/哈希/);
assert.throws(()=>validate({...fixture,documents:fixture.documents.map((r,i)=>i===0?{...r,sourceCode:'unadmitted'}:r)}),/来源/);
console.log('cash income evidence import: explicit user, date, account scope, complete fact counts and source text hash passed');
const {Readable}=require('stream');
const utf8=Buffer.from(JSON.stringify(fixture));
// 中文账户名和公告原文可以在任意字节处被SSH管道分块，不能逐块转字符串。
require('../scripts/importCashIncomeEvidence').readBundle(Readable.from(Array.from(utf8,b=>Buffer.from([b])))).then(result=>assert.deepStrictEqual(result,fixture)).catch(e=>{console.error(e);process.exitCode=1});

}

// --- cash-income-source-admission.test.js ---
{
const assert=require('assert'),{assess}=require('../services/repoSourceAdmission');
const dates=require('../services/repoDailyRates').tradingDates('2026-07-20','2026-08-31');
const rows=dates.map(d=>({ts_code:'204001.SH',trade_date:d.replace(/-/g,''),repo_maturity:'GC001',weight:1.283,close:1.295}));
const sample={date:dates[0],code:'204001.SH',metric:'daily_volume_weighted',unit:'percent',value:'1.283',label:'加权平均利率(%)',sourceUrl:'https://bond.sse.com.cn/data/statistics/overview/Pledgerepo/',contentHash:'a'.repeat(64)};
const base={rows,expectedDates:dates,targetDate:dates.at(-1),officialSamples:[sample],fetchedAt:'2026-09-01T10:00:00+08:00',permissionVerified:true};
assert.strictEqual(assess(base).status,'admitted');
assert.strictEqual(assess({...base,officialSamples:[]}).status,'pending_evidence');
assert.strictEqual(assess({...base,officialSamples:[{...sample,metric:'five_day_mean'}]}).status,'pending_evidence','跨统计指标不能冒充匹配');
assert.strictEqual(assess({...base,officialSamples:[{...sample,value:'1.391'}]}).status,'rejected');
assert.strictEqual(assess({...base,rows:rows.concat(rows[0])}).status,'rejected');
assert.strictEqual(assess({...base,rows:rows.slice(1)}).status,'pending_evidence');
assert.strictEqual(assess({...base,permissionVerified:false}).status,'pending_evidence');
assert.throws(()=>assess({...base,officialSamples:[{...sample,sourceUrl:'https://example.com/'}]}),/上交所/);
assert.strictEqual(assess({...base,fetchedAt:'2026-08-30T10:00:00+08:00'}).status,'pending_evidence');
console.log('cash income source admission: sample coverage, same metric, official provenance, mismatch rejection and publication observation passed');
async function cacheRegression(){
  const calls=[];
  const result=await require('../services/repoSourceAdmission').probeOfficial(sample.date,async(sql,args)=>{calls.push({sql,args});return {rows:sql.includes('ops.data_sources')?[{source_id:1}]:[{payload:{...sample,sqlId:'COMMON_SSEBOND_SCSJ_SCTJ_SCGL_ZQZYSHGSCGL_CX_L'}}]};});
  assert.strictEqual(result.value,'1.283');assert.strictEqual(calls.length,2,'已有官方原文证据命中不联网、不重写策略');
  await assert.rejects(()=>require('../services/repoSourceAdmission').probeOfficial(require('../../public/shared/core-date').todayInZone('Asia/Shanghai'),async()=>{throw new Error('不得访问');}),/已完成/);
  // 解释器：显式配置优先；独立 worktree 默认不带 venv，退回 PATH 上的 python（与 run-all 的解析顺序一致），
  // 避免“代码已通过、却在收尾 spawn 时因固定相对路径找不到解释器”造成假失败。
  const fs = require('fs');
  const local = require('path').resolve('venv/Scripts/python.exe');
  const python = process.env.IPO_PYTHON_PATH || process.env.PYTHON || (fs.existsSync(local) ? local : 'python');
  const script=`import importlib.util, json, io
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('probe','server/scripts/probeRepoOfficial.py'); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
payload={'pageHelp':{'total':1},'result':[{'BOND_CODE':'204001','BOND_NAME':'GC001','TRADE_DATE':'2026-08-31','WEIGHT_RATE':'1.283'}]}
def fake(request,**kw):
 assert kw['source']=='sse' and kw['api_name']=='repo_overview' and kw['dataset']=='repo-official-admission:2026-08-31'
 assert 'TRADE_DATE=2026-08-31' in request.full_url
 return io.BytesIO(json.dumps(payload).encode('utf-8'))
with patch.object(m,'guarded_urlopen',fake):
 assert m.probe('2026-08-31')['value']=='1.283'
 payload['pageHelp']['total']=2
 try:m.probe('2026-08-31');raise AssertionError('incomplete accepted')
 except ValueError as e:assert 'pagination incomplete' in str(e)
 payload['pageHelp']['total']=1;payload['result'][0]['TRADE_DATE']='2026-08-30'
 try:m.probe('2026-08-31');raise AssertionError('wrong date accepted')
 except ValueError as e:assert 'unique same-date' in str(e)
print('official probe Guard scope, incomplete pagination and identity/date validation passed')`;
  const output=await require('util').promisify(require('child_process').execFile)(python,['-c',script],{windowsHide:true,timeout:10000});console.log(output.stdout.trim());
  console.log('official admission cache reuse and completed-day boundary passed');
}

cacheRegression().finally(() => require('../db/connection').pool.end().catch(() => {})).catch(e => { console.error(e); process.exitCode = 1; });
}

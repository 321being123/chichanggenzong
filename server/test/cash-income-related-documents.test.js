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
require('../db/connection').pool.end();

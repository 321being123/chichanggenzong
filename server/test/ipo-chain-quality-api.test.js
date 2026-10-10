const assert=require('assert');
const {pool}=require('../db/connection');
const {stockFieldStatusSql}=require('../routes/ipo');
(async()=>{
  const complete={exposures:[],industry_chain:{status:'complete',products:['收纳盒'],upstream:[{industry:'木板'}],downstream:[{industry:'家庭收纳'}],evidence:{url:'https://www.sse.com.cn/prospectus.pdf',content_hash:'a'.repeat(64)}}};
  const cases=[ [complete,'value'],
    [{...complete,industry_chain:{...complete.industry_chain,status:'partial'}},'missing'],
    [{...complete,industry_chain:{...complete.industry_chain,evidence:{}}},'missing'],
    [{...complete,industry_chain:{...complete.industry_chain,products:{malformed:true}}},'missing'] ];
  for(const [exposure,expected] of cases){
    const {rows}=await pool.query(`SELECT ${stockFieldStatusSql('h')} AS field_status FROM jsonb_populate_record(NULL::ipo_history,$1::jsonb) h`,[JSON.stringify({security_code:'CHAIN_API',market_code:'CN',ipo_date:'2026-01-01',business_exposure:exposure})]);
    assert.strictEqual(rows[0].field_status.business_exposure,expected,'完整原文关系与空赛道必须采用同一API质量口径');
  }
  console.log('OK IPO chain API: complete unmapped evidence, partial, missing proof and malformed arrays');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>pool.end());

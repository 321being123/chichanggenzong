const assert=require('assert');
const path=require('path');
const {spawnSync}=require('child_process');
const fs=require('fs');
const cache=fs.mkdtempSync(path.join(require('os').tmpdir(),'portfolio-pricing-test-'));
process.env.DOCUMENT_PDF_CACHE_DIR=cache;
const {pool}=require('../db/connection');
const {syncHkexPricingFacts}=require('../services/hkexIpo');
const root=path.resolve(__dirname,'../..');
const python=require('../services/arbitrageParser').resolvePython();

(async()=>{
  // HK-IPO-PRICING-001：真实PG，定价公告不能被配发未来日期掩盖；不改招股区间/配发/上市。
  const generated=spawnSync(python,['-c',String.raw`
import sys,fitz
sys.path.insert(0,'server/scripts')
from extractHkIpoAllotment import parse_pricing_text
text='全球发售\n股份代号：9001\n于2099年10月13日，发售价已厘定为每股H股35.30港元。'
parsed=parse_pricing_text(text,'09001')
assert parsed['actualPricingDate']=='2099-10-13' and parsed['finalOfferPrice']==35.30
for bad in [text.replace('9001','9002'),text.replace('港元','人民币'),text.replace('于2099','预计于2099')]:
    try: parse_pricing_text(bad,'09001');assert False
    except ValueError: pass
document=fitz.open();page=document.new_page();page.insert_text((30,50),text,fontname='china-s',fontsize=12)
sys.stdout.buffer.write(document.tobytes())
`],{cwd:root,env:{...process.env,PYTHONUTF8:'1'},timeout:30000});
  assert.equal(generated.status,0,String(generated.stderr));
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    await client.query(`INSERT INTO public.ipo_history(security_code,market_code,ipo_status,issue_price_low,issue_price_high,data_completeness,source_documents)
      VALUES('09001.HK','HK','active',35.30,38.80,$1::jsonb,'[]') ON CONFLICT(security_code) DO UPDATE SET market_code='HK',ipo_status='active',issue_price_final=NULL,pricing_at=NULL,
      issue_price_low=35.30,issue_price_high=38.80,data_completeness=EXCLUDED.data_completeness,source_documents='[]'`,[JSON.stringify({prospectus:{expectedEvents:{pricingDate:{date:'2099-10-13'},allotmentDate:{date:'2099-10-14'}}}})]);
    let requests=0;
    const result=await syncHkexPricingFacts({asOfDate:'2099-10-13',targetCodes:['09001.HK'],executor:client.query.bind(client),
      searchImpl:async options=>{assert.equal(options.stockCode,'09001');assert.deepEqual(options.categories,['-2']);return [{title:'發售價公告',announcedAt:'2099-10-13',fileLink:'https://www1.hkexnews.hk/pricing-regression-20991013.pdf'}];},
      fetchImpl:async()=>{requests++;return generated.stdout;}});
    assert.equal(result.ok,true);assert.equal(result.enriched,1);
    const row=(await client.query("SELECT issue_price_low::float8,issue_price_high::float8,issue_price_final::float8,pricing_at::date::text,allotment_at,listing_at,source_documents FROM public.ipo_history WHERE security_code='09001.HK'")).rows[0];
    assert.equal(row.issue_price_final,35.30);assert.equal(row.pricing_at,'2099-10-13');
    assert.equal(row.issue_price_low,35.30);assert.equal(row.issue_price_high,38.80);assert.equal(row.allotment_at,null);assert.equal(row.listing_at,null);
    assert.equal(row.source_documents[0].type,'pricing_result');assert.equal(row.source_documents[0].contentSha256.length,64);
    await syncHkexPricingFacts({asOfDate:'2099-10-13',targetCodes:['09001.HK'],executor:client.query.bind(client),searchImpl:async()=>{throw new Error('已补齐不得重复查源');}});
    assert.equal(requests,1);
  }finally{await client.query('ROLLBACK');client.release();await pool.end();fs.rmSync(cache,{recursive:true,force:true});}
  console.log('HK-IPO-PRICING-001: official identity, date, price, range isolation and reuse passed');
})().catch(error=>{console.error(error.stack);process.exitCode=1;});

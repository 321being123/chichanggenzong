// 经明确授权的事实搬运：原文进入统一公告库，随后只调用原分红Runner和现金服务；不搬运余额或自动流水。
const crypto=require('crypto');
const {pool}=require('../db/connection');
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function accountFingerprint(username,name){
 const result={};
 for(const table of ['positions','trades'])result[table]=(await pool.query(`SELECT to_jsonb(t)-'instrument_id'${table==='positions'?"-'price'":''} AS value FROM ${table} t WHERE username=$1 AND account_name=$2 ORDER BY id`,[username,name])).rows.map(r=>r.value);
 result.locked=(await pool.query("SELECT date::text,cash_cny::text,total_asset::text,nav::text,invested::text FROM nav_history WHERE username=$1 AND account_name=$2 AND is_locked ORDER BY date",[username,name])).rows;
 result.externalFlows=(await pool.query("SELECT id,date::text,amount::numeric(24,6)::text FROM cash_flows WHERE username=$1 AND account_name=$2 AND flow_type='external_transfer' ORDER BY id",[username,name])).rows;
 return hash(result);
}
function validate(bundle){
 if(bundle.username!=='daicunzai'||bundle.targetDate!=='2026-10-10'||bundle.anchorDate!=='2026-08-16')throw new Error('授权范围不匹配');
 if(bundle.accounts.length!==2||bundle.accounts.map(a=>a.name).sort().join('|')!=='华泰账户|招商证券账户')throw new Error('账户范围不匹配');
 if(bundle.documents.length!==75||bundle.coverages.length!==38||bundle.rates.length!==34)throw new Error('事实范围不完整');
 for(const d of bundle.documents)if(!d.payload.text||!d.payload.announcement||hashText(d.payload.text)!==d.contentHash||!['hkex','sse','szse'].includes(d.sourceCode))throw new Error('原文哈希或官方来源不匹配');
 return bundle;
}
const hashText=text=>crypto.createHash('sha256').update(text).digest('hex');
async function apply(bundle){
 validate(bundle);
 const {resolveInstrument}=require('../services/securityIdentity');
 const identities=new Map();
 for(const c of bundle.coverages){const i=await resolveInstrument({canonicalCode:c.canonicalCode});if(!i)throw new Error('统一身份缺失：'+c.canonicalCode);identities.set(c.code,i);}
 for(const a of bundle.accounts)if(await accountFingerprint(bundle.username,a.name)!==a.fingerprint)throw new Error('生产账本与待同步基线不同，停止：'+a.name);
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  for(const d of bundle.documents){
   const source=(await client.query('SELECT source_id FROM ops.data_sources WHERE source_code=$1',[d.sourceCode])).rows[0];
   const identity=identities.get(d.code);if(!source||!identity)throw new Error('来源或身份未匹配');
   const payload={announcement:d.payload.announcement,text:d.payload.text,cashDividend:{instrumentId:identity.instrument_id,quality:'pending',parserVersion:'evidence-import-unparsed'}};
   const raw=(await client.query("INSERT INTO ops.raw_records(source_id,dataset_code,source_key,payload,payload_hash) VALUES($1,'stock_cash_dividend_facts',$2,$3,$4) ON CONFLICT(source_id,dataset_code,source_key,payload_hash) DO UPDATE SET ingested_at=now() RETURNING raw_record_id",[source.source_id,d.sourceKey,payload,hash(payload)])).rows[0];
   await client.query("INSERT INTO event.documents(document_type,title,announced_at,url,source_id,content_hash,raw_record_id,raw_payload) VALUES('cash_dividend_announcement',$1,$2,$3,$4,$5,$6,$7) ON CONFLICT(source_id,url,content_hash) DO NOTHING",[d.title,d.announcedAt,d.url,source.source_id,d.contentHash,raw.raw_record_id,payload]);
  }
  for(const c of bundle.coverages){
   const identity=identities.get(c.code);
   // 搬运已核验发现窗口和原队列；标准事实须由当前生产身份重解析后才发布。
   await client.query("INSERT INTO ops.sync_cursors(instrument_id,scope_key,dataset_code,cursor_payload,last_attempt_at,last_error) VALUES($1,$2,'stock_cash_dividend_facts',$3,now(),'授权原文待本地重解析') ON CONFLICT(scope_key,dataset_code) DO UPDATE SET cursor_payload=ops.sync_cursors.cursor_payload||EXCLUDED.cursor_payload,last_attempt_at=now()",[identity.instrument_id,'cash_dividend:'+identity.instrument_id,{...c.payload,complete:false,parserVersion:'evidence-import-unparsed',remainingDocuments:bundle.documents.filter(d=>d.code===c.code).map(d=>d.url)}]);
  }
  for(const a of bundle.accounts){
   const account=(await client.query('SELECT id,cash_income_policy FROM accounts WHERE username=$1 AND account_name=$2 FOR UPDATE',[bundle.username,a.name])).rows[0];
   const exemptions=a.policy.cnDividendExemptions.map(p=>({...p,eventKey:'dividend:'+identities.get(p.code).instrument_id+':'+p.eventKey.split(':').slice(-2).join(':')}));
   const policy={...account.cash_income_policy,...a.policy,cnDividendExemptions:exemptions,authorizedBy:bundle.username,enabled:true,productionSyncAuthorization:'2026-10-10：部署并执行上述限定同步、补算'};
   await client.query('UPDATE accounts SET cash_income_policy=$2 WHERE id=$1',[account.id,policy]);
   await client.query('UPDATE account_data SET version=version+1 WHERE username=$1 AND account_name=$2',[bundle.username,a.name]);
  }
  const source=(await client.query("SELECT source_id FROM ops.data_sources WHERE source_code='sse'")).rows[0];
  const sample=bundle.officialSample;
  await client.query("INSERT INTO ops.raw_records(source_id,dataset_code,source_key,payload,payload_hash) VALUES($1,'repo_daily_admission','official:204001.SH:2026-10-09',$2,$3) ON CONFLICT(source_id,dataset_code,source_key,payload_hash) DO NOTHING",[source.source_id,sample,sample.contentHash]);
  await client.query('COMMIT');
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 const facts=await require('../services/cashDividendFacts').syncCashDividends({targetDate:bundle.targetDate,startDate:bundle.anchorDate,targetCodes:bundle.coverages.map(c=>c.code),localOnly:true});
 if(!facts.ok)throw new Error('公告重解析未完成：'+JSON.stringify({remaining:facts.remainingCodes,failures:facts.failures}));
 // 生产权限通过原Guard探测一次区间；源准入不得直接复用本机权限结论。
 const repo=await require('../services/repoDailyRates').syncRepoDailyRates({targetDate:'2026-10-09',startDate:'2026-08-17',probe:true});
 if(!repo.ok||repo.samples.length!==34)throw new Error('生产回购权限/34日完整性未通过');
 for(const expected of bundle.rates){const actual=repo.samples.find(r=>String(r.trade_date).replace(/-/g,'')===expected.trade_date.replace(/-/g,''));if(!actual||Number(actual.weight)!==Number(expected.weight)||Number(actual.close)!==Number(expected.close))throw new Error('生产日利率与已核验样本不一致：'+expected.trade_date);}
 const admission=require('../services/repoSourceAdmission');
 const proof=await admission.record(admission.assess({rows:repo.samples,expectedDates:require('../services/repoDailyRates').tradingDates('2026-08-17','2026-10-09'),targetDate:'2026-10-09',officialSamples:[bundle.officialSample],fetchedAt:new Date().toISOString(),permissionVerified:true}),pool.query.bind(pool));
 if(proof.status!=='admitted')throw new Error('生产来源未准入');
 const accounts=[];
 for(const a of bundle.accounts){
  const state=await require('../services/cashIncome').settleCashIncome(bundle.username,a.name,{targetDate:bundle.targetDate});
  const after=await require('../db/accounts').loadAccountData(bundle.username,a.name);
  const retry=await require('../services/cashIncome').settleCashIncome(bundle.username,a.name,{targetDate:bundle.targetDate});
  if(state.pending.length||retry.changed||retry.navUpdated)throw new Error('收益缺口或重复重算异常');
  if(after.cash!==a.expected.cash||after.authoritativeInvested!==a.expected.invested)throw new Error('生产与本地现金/本金不一致：'+a.name);
  if(await accountFingerprint(bundle.username,a.name)!==a.fingerprint)throw new Error('原始账本或锁定快照发生变化');
  accounts.push({name:a.name,cash:after.cash,invested:after.authoritativeInvested,dividend:state.dividendCalculated,repoNet:state.repoNetCalculated,pending:state.pending.length,retryChanged:retry.changed});
 }
 return {facts:{objects:facts.codes.length,documents:facts.documents.length,remaining:facts.remainingCount},sourceAdmission:proof.status,accounts};
}
async function readBundle(stream){const chunks=[];for await(const chunk of stream)chunks.push(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk));return validate(JSON.parse(Buffer.concat(chunks).toString('utf8')));}
if(require.main===module){
 (async()=>{const bundle=await readBundle(process.stdin);if(!process.argv.includes('--apply'))throw new Error('必须显式--apply且获得限定同步授权');console.log(JSON.stringify(await apply(bundle),null,2));})().catch(e=>{console.error(e.message);process.exitCode=1}).finally(()=>pool.end());
}
module.exports={validate,accountFingerprint,readBundle};

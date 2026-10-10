const crypto=require('crypto');
const {pool}=require('../db/connection');
const keyOf=row=>crypto.createHash('sha256').update(JSON.stringify([row.code||'',row.eventKey||row.actionId||'',row.reason])).digest('hex');
const canonical=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
async function syncPending(client,accountId,rows,inputVersion,actor,resolutions=[]) {
  const old=(await client.query('SELECT * FROM account_cash_income_pending WHERE account_id=$1 FOR UPDATE',[accountId])).rows;
  const keys=new Set();
  for(const row of rows) {
    const previous=old.find(r=>r.pending_key===keyOf(row))||old.find(r=>row.eventKey&&r.event_key===row.eventKey&&r.reason===row.reason&&r.code===row.code);
    const key=previous?.pending_key||keyOf(row);keys.add(key);
    const state=previous?.state==='excluded_by_user'?'excluded_by_user':row.sourceBlocked===true?'source_blocked':'pending';
    const next={...row,pending_key:key,state,inputVersion};
    await client.query(`INSERT INTO account_cash_income_pending(account_id,pending_key,code,event_key,reason,state,input_version,evidence,next_attempt_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+interval '1 day') ON CONFLICT(account_id,pending_key)
      DO UPDATE SET state=EXCLUDED.state,input_version=EXCLUDED.input_version,evidence=EXCLUDED.evidence,last_attempt_at=now(),
      next_attempt_at=CASE WHEN EXCLUDED.state='excluded_by_user' THEN NULL ELSE EXCLUDED.next_attempt_at END,resolved_at=NULL`,[accountId,key,row.code||null,row.eventKey||null,row.reason,state,inputVersion,row]);
    if(!previous||previous.state!==state||canonical(previous.evidence)!==canonical(row)) await client.query(`INSERT INTO account_cash_income_pending_audit(account_id,pending_key,before_value,after_value,actor) VALUES($1,$2,$3,$4,$5)`,[accountId,key,previous||null,next,actor]);
  }
  for(const row of old.filter(r=>!keys.has(r.pending_key)&&['pending','source_blocked'].includes(r.state))) {
    const proof=resolutions.find(p=>p.code===row.code && (row.event_key?p.eventKey===row.event_key:p.reason===row.reason));
    if(!proof)continue; // 空查询、用户隐藏和普通重算成功不是恢复证据。
    const state=proof.excludedByUser===true?'excluded_by_user':'resolved';
    const next={...row,state,resolution:proof,inputVersion};
    await client.query("UPDATE account_cash_income_pending SET state=$4,resolved_at=now(),next_attempt_at=NULL,input_version=$3,user_reason=COALESCE($5,user_reason) WHERE account_id=$1 AND pending_key=$2",[accountId,row.pending_key,inputVersion,state,proof.excludedByUser===true?proof.proof?.reason:null]);
    await client.query(`INSERT INTO account_cash_income_pending_audit(account_id,pending_key,before_value,after_value,actor) VALUES($1,$2,$3,$4,$5)`,[accountId,row.pending_key,row,next,actor]);
  }
  return (await client.query('SELECT p.*,p.first_seen_at::text,p.last_attempt_at::text FROM account_cash_income_pending p WHERE account_id=$1 ORDER BY p.first_seen_at,p.pending_key',[accountId])).rows;
}
async function changePending(username,accountName,key,{exclude,reason,version}={}) {
  if(typeof exclude!=='boolean'||!String(reason||'').trim()) throw Object.assign(new Error('必须指定排除/重新打开及原因'),{status:400});
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const account=(await client.query('SELECT id FROM accounts WHERE username=$1 AND account_name=$2 FOR UPDATE',[username,accountName])).rows[0];
    if(!account) throw Object.assign(new Error('账户不存在'),{status:404});
    await require('./tradeLedger').checkVersionInTxn(client,username,accountName,version);
    const old=(await client.query('SELECT * FROM account_cash_income_pending WHERE account_id=$1 AND pending_key=$2 FOR UPDATE',[account.id,key])).rows[0];
    if(!old) throw Object.assign(new Error('待核验事件不存在'),{status:404});
    if(exclude&&!old.event_key) throw Object.assign(new Error('来源或覆盖缺口不能作为单个收益事件排除'),{status:400});
    const next={...old,state:exclude?'excluded_by_user':'pending',user_reason:String(reason).trim()};
    await client.query('UPDATE account_cash_income_pending SET state=$3,user_reason=$4,next_attempt_at=CASE WHEN $3=\'pending\' THEN now() ELSE NULL END WHERE account_id=$1 AND pending_key=$2',[account.id,key,next.state,next.user_reason]);
    await client.query('INSERT INTO account_cash_income_pending_audit(account_id,pending_key,before_value,after_value,actor) VALUES($1,$2,$3,$4,$5)',[account.id,key,old,next,username]);
    await client.query('UPDATE account_data SET version=version+1 WHERE username=$1 AND account_name=$2',[username,accountName]);
    await client.query('COMMIT');return next;
  } catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
module.exports={syncPending,changePending,keyOf};

const crypto=require('crypto');
const {pool}=require('../db/connection');
const txControl = require('../repositories/transactionControl');
const pendingRepository = require('../repositories/cashIncomePendingRepository');
const keyOf=row=>crypto.createHash('sha256').update(JSON.stringify([row.code||'',row.eventKey||row.actionId||'',row.reason])).digest('hex');
const canonical=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
async function syncPending(client,accountId,rows,inputVersion,actor,resolutions=[]) {
  const old=await pendingRepository.lockPendingEvents(accountId,client);
  const keys=new Set();
  for(const row of rows) {
    const previous=old.find(r=>r.pending_key===keyOf(row))||old.find(r=>row.eventKey&&r.event_key===row.eventKey&&r.reason===row.reason&&r.code===row.code);
    const key=previous?.pending_key||keyOf(row);keys.add(key);
    const state=previous?.state==='excluded_by_user'?'excluded_by_user':row.sourceBlocked===true?'source_blocked':'pending';
    const next={...row,pending_key:key,state,inputVersion};
    await pendingRepository.upsertPendingEvent({accountId,pendingKey:key,code:row.code||null,eventKey:row.eventKey||null,reason:row.reason,state,inputVersion,row},client);
    if(!previous||previous.state!==state||canonical(previous.evidence)!==canonical(row)) await pendingRepository.insertPendingAudit({accountId,pendingKey:key,before:previous||null,after:next,actor},client);
  }
  for(const row of old.filter(r=>!keys.has(r.pending_key)&&['pending','source_blocked'].includes(r.state))) {
    const proof=resolutions.find(p=>p.code===row.code && (row.event_key?p.eventKey===row.event_key:p.reason===row.reason));
    if(!proof)continue; // 空查询、用户隐藏和普通重算成功不是恢复证据。
    const state=proof.excludedByUser===true?'excluded_by_user':'resolved';
    const next={...row,state,resolution:proof,inputVersion};
    await pendingRepository.markPendingResolved({accountId,pendingKey:row.pending_key,inputVersion,state,userReason:proof.excludedByUser===true?proof.proof?.reason:null},client);
    await pendingRepository.insertPendingAudit({accountId,pendingKey:row.pending_key,before:row,after:next,actor},client);
  }
  return pendingRepository.listPendingEvents(accountId,client);
}
async function changePending(username,accountName,key,{exclude,reason,version}={}) {
  if(typeof exclude!=='boolean'||!String(reason||'').trim()) throw Object.assign(new Error('必须指定排除/重新打开及原因'),{status:400});
  const client=await pool.connect();
  try {
    await txControl.begin(client);
    const account=await pendingRepository.lockAccount(username,accountName,client);
    if(!account) throw Object.assign(new Error('账户不存在'),{status:404});
    await require('./tradeLedger').checkVersionInTxn(client,username,accountName,version);
    const old=await pendingRepository.lockPendingEvent(account.id,key,client);
    if(!old) throw Object.assign(new Error('待核验事件不存在'),{status:404});
    if(exclude&&!old.event_key) throw Object.assign(new Error('来源或覆盖缺口不能作为单个收益事件排除'),{status:400});
    const next={...old,state:exclude?'excluded_by_user':'pending',user_reason:String(reason).trim()};
    await pendingRepository.updatePendingState({accountId:account.id,pendingKey:key,state:next.state,userReason:next.user_reason},client);
    await pendingRepository.insertPendingAudit({accountId:account.id,pendingKey:key,before:old,after:next,actor:username},client);
    await pendingRepository.bumpAccountDataVersion(username,accountName,client);
    await txControl.commit(client);return next;
  } catch(e){await txControl.rollback(client);throw e;}finally{client.release();}
}
module.exports={syncPending,changePending,keyOf};

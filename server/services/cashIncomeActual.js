// 券商实际流水批量补录/更正入口，按事件替换估算；普通账户保存不能修改这些来源。
const {pool}=require('../db/connection');
const crypto=require('crypto');
const CoreDate=require('../../public/shared/core-date');
const bad=message=>Object.assign(new Error(message),{status:400});
function validate(records) {
  if(!Array.isArray(records)||!records.length) throw Object.assign(new Error('缺少实际收益记录'),{status:400});
  const seen=new Set();
  return records.map(r=>{
    if(!r||typeof r!=='object'||Array.isArray(r)) throw bad('实际记录格式无效');
    if(!CoreDate.normalizeBusinessDate(r.date)||r.date>CoreDate.todayInZone('Asia/Shanghai')||!['dividend','dividend_tax','repo_interest','repo_fee'].includes(r.flow_type)
      || typeof r.amountCny!=='string'||!/^[-+]?\d+(\.\d{1,6})?$/.test(r.amountCny)||!Number.isFinite(Number(r.amountCny))
      || !String(r.eventKey||'').trim()||!String(r.sourceRef||'').trim()) throw Object.assign(new Error('实际记录须含事件键、到账日、人民币金额文本及券商原始凭证引用'),{status:400});
    if((r.flow_type==='dividend_tax'||r.flow_type==='repo_fee')&&Number(r.amountCny)>0 || ['dividend','repo_interest'].includes(r.flow_type)&&Number(r.amountCny)<0) throw bad('收益/费用方向不正确');
    const repo=r.eventKey.match(/^repo:204001\.SH:(\d{4}-\d{2}-\d{2})$/);
    const dividend=r.eventKey.match(/^dividend:([1-9]\d*):(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})(?::tax:([A-Za-z0-9_-]+))?$/);
    if(!repo&&!dividend || repo&&!CoreDate.normalizeBusinessDate(repo[1]) || dividend&&(!CoreDate.normalizeBusinessDate(dividend[2])||!CoreDate.normalizeBusinessDate(dividend[3])||dividend[3]<dividend[2])) throw bad('事件键格式或业务日期无效');
    if(r.status!=null&&!['confirmed','revoked'].includes(r.status)) throw bad('实际记录状态无效');
    if(dividend?.[4]&&r.flow_type!=='dividend_tax')throw bad('卖出扣税事件只能记录递延税');
    if(r.settlement?.amountBasis==='gross'){
      let calculated;
      try{calculated=require('./cashDividendSettlement').calculateHkNet({...r.settlement,originalAmount:r.originalAmount,currency:r.currency||'CNY',settlementDate:r.date,sourceRef:r.sourceRef});}catch(e){throw bad(e.message);}
      if(Number(calculated.amountCny)!==Number(r.amountCny))throw bad('分层扣税/结算汇率与人民币金额不一致，请核对凭证');
      r={...r,settlement:{...r.settlement,calculation:calculated}};
    }else if(r.settlement?.amountBasis==='net'&&r.settlement?.layers?.length)throw bad('实收净额不得再扣税');
    const currency=r.currency||'CNY',originalAmount=r.originalAmount??(currency==='CNY'?r.amountCny:null);
    if(!['CNY','HKD','USD'].includes(currency)||typeof originalAmount!=='string'||!/^[-+]?\d+(\.\d{1,6})?$/.test(originalAmount)||!Number.isFinite(Number(originalAmount))) throw bad('原币和原币金额文本必须完整');
    if(currency==='CNY'&&Number(originalAmount)!==Number(r.amountCny)) throw bad('人民币原币金额与结算金额不一致');
    if(r.settledAt && (!Number.isFinite(Date.parse(r.settledAt))||!/(Z|[+-]\d{2}:\d{2})$/.test(r.settledAt)||CoreDate.dateInZone(new Date(r.settledAt),'Asia/Shanghai')!==r.date)) throw bad('到账时刻须含时区且与到账业务日一致');
    const key=r.eventKey+'|'+r.flow_type;
    if(!((r.eventKey.startsWith('repo:')&&r.flow_type.startsWith('repo_'))||(r.eventKey.startsWith('dividend:')&&r.flow_type.startsWith('dividend')))) throw Object.assign(new Error('事件键与收益类型不匹配'),{status:400});
    if(seen.has(key)) throw Object.assign(new Error('同一批存在重复事件类型'),{status:400});seen.add(key);
    return {...r,currency,originalAmount,status:r.status||'confirmed',eventKey:String(r.eventKey),sourceRef:String(r.sourceRef).trim()};
  });
}
async function importActual(username,accountName,records,version) {
  const normalized=validate(records),client=await pool.connect();
  try {
    await client.query('BEGIN');
    const account=(await client.query('SELECT id FROM accounts WHERE username=$1 AND account_name=$2 FOR UPDATE',[username,accountName])).rows[0];
    if(!account) throw Object.assign(new Error('账户不存在'),{status:404});
    await require('./tradeLedger').checkVersionInTxn(client,username,accountName,version);
    const {loadCashInputs}=require('./accountCash');
    const anchor=require('../../public/shared/nav-math').selectCashAnchor((await loadCashInputs(username,accountName,client)).navHistory,CoreDate.todayInZone('Asia/Shanghai'));
    if(!anchor) throw Object.assign(new Error('缺少导入现金基准'),{status:400});
    let changed=0;
    for(const r of normalized) {
      const old=(await client.query('SELECT *,date::text FROM cash_flows WHERE account_id=$1 AND event_key=$2 AND flow_type=$3 FOR UPDATE',[account.id,r.eventKey,r.flow_type])).rows[0];
      const known=old||(await client.query('SELECT 1 FROM cash_flows WHERE account_id=$1 AND event_key=$2 UNION ALL SELECT 1 FROM account_cash_income_pending WHERE account_id=$1 AND event_key=$2 LIMIT 1',[account.id,r.eventKey])).rows[0];
      if(!known) throw bad('事件不属于本账户已有收益或待核验范围');
      if(r.eventKey.includes(':tax:')){
        const obligation=(await client.query('SELECT evidence FROM account_cash_income_pending WHERE account_id=$1 AND event_key=$2',[account.id,r.eventKey])).rows[0];
        const notBefore=obligation?.evidence?.notBefore;
        if(notBefore&&r.date<notBefore)throw bad('递延税实际扣款日不能早于对应卖出及分红发放日');
      }
      const identityId=r.eventKey.match(/^dividend:(\d+):/)?.[1];
      if(identityId&&r.flow_type==='dividend'){
        const identity=await require('./securityIdentity').resolveInstrument({instrumentId:identityId},client.query.bind(client));
        if(identity?.market==='HK'&&!['net','gross'].includes(r.settlement?.amountBasis))throw bad('港股实收必须明确原币为净额或附完整分层扣税证据');
      }
      if(r.status==='revoked'&&!old) throw bad('没有可撤销的实际流水');
      if(old?.origin==='manual') throw Object.assign(new Error('不能替换手工外部资金流水'),{status:409});
      const evidence={brokerVerified:true,sourceRef:r.sourceRef,originalCurrency:r.currency,originalAmount:r.originalAmount,settledAt:r.settledAt||null,settlement:r.settlement||{},importedBy:username};
      const ordered=value=>Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,ordered(value[k])])):value;
      const canonical=value=>JSON.stringify(ordered(value));
      if(old?.status===r.status&&old.date===r.date&&Number(old.amount)===Number(r.amountCny)&&canonical(old.evidence)===canonical(evidence)) continue;
      const id=old?.id||'income_'+crypto.createHash('sha256').update(JSON.stringify([account.id,r.eventKey,r.flow_type])).digest('hex').slice(0,28);
      const revision=(old?.revision||0)+1;
      const next={id,date:r.date,amount:r.amountCny,flow_type:r.flow_type,event_key:r.eventKey,status:r.status,evidence};
      await client.query('INSERT INTO cash_flow_revisions(account_id,flow_id,event_key,revision,before_value,after_value,reason,actor) VALUES($1,$2,$3,$4,$5,$6,\'broker_actual_import\',$7)',[account.id,id,r.eventKey,revision,old||null,next,username]);
      await client.query(`INSERT INTO cash_flows(id,username,account_name,account_id,date,amount,amount_cny,flow_type,origin,status,event_key,anchor_date,quality_status,calculation_version,evidence,source_ref,revision,note,currency,original_amount,settled_at)
        VALUES($1,$2,$3,$4,$5,$6,$6,$7,'system',$13,$8,$9,'broker_confirmed','cash-income-v1',$10,$11,$12,'券商实际收益补录',$14,$15,$16)
        ON CONFLICT(username,account_name,id) DO UPDATE SET date=EXCLUDED.date,amount=EXCLUDED.amount,amount_cny=EXCLUDED.amount_cny,status=EXCLUDED.status,quality_status='broker_confirmed',evidence=EXCLUDED.evidence,source_ref=EXCLUDED.source_ref,revision=EXCLUDED.revision,currency=EXCLUDED.currency,original_amount=EXCLUDED.original_amount,settled_at=EXCLUDED.settled_at`,
        [id,username,accountName,account.id,r.date,r.amountCny,r.flow_type,r.eventKey,anchor.date,evidence,{reference:r.sourceRef},revision,r.status,r.currency,r.originalAmount,r.settledAt||null]);
      await require('./tradeLedger').markNavDirty(client,username,accountName,old?.date<r.date?old.date:r.date,'cashflow');changed++;
    }
    await client.query('COMMIT');return {ok:true,changed,records:normalized.length};
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
module.exports={validate,importActual};

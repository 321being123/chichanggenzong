// STOCK-SWAP-SETTLE-067: 真实 PostgreSQL 事务、并发和回滚回归。
const assert = require('assert');
const { pool } = require('../db/connection');
const repo = require('../repositories/stockSwapSettlementRepository');
const svc = require('../services/stockSwapSettlement');
const U='stock_swap_atomic_test', A='原子换股测试', ID='stock_swap_atomic_test_id';
let caseId, acqCaseId, evidenceId;
async function cleanup(){
  if(caseId) await pool.query('DELETE FROM event.arbitrage_cases WHERE case_id=$1',[caseId]);
  if(acqCaseId) await pool.query('DELETE FROM event.arbitrage_cases WHERE case_id=$1',[acqCaseId]);
  if(evidenceId) await pool.query('DELETE FROM event.documents WHERE document_id=$1',[evidenceId]);
  for(const table of ['positions','trades','nav_history','cash_flows','nav_position_snapshots','account_data','accounts']) await pool.query(`DELETE FROM ${table} WHERE username=$1`,[U]);
  await pool.query('DELETE FROM users WHERE username=$1',[U]);
}
(async()=>{
 try {
  await cleanup();
  await pool.query("INSERT INTO users(username,password,accounts,status,auth_version) VALUES($1,'x',$2,'active',1)",[U,JSON.stringify([A])]);
  await pool.query('INSERT INTO accounts(id,username,account_name,cash_base,hk_rate) VALUES($1,$2,$3,0,1)',[ID,U,A]);
  await pool.query("INSERT INTO account_data(username,account_name,data,version,pos_version,trade_version) VALUES($1,$2,'{}',0,0,0)",[U,A]);
  const src=(await pool.query("SELECT instrument_id FROM core.instruments WHERE canonical_code='601198.SH'")).rows[0];
  const dst=(await pool.query("SELECT instrument_id FROM core.instruments WHERE canonical_code='601995.SH'")).rows[0];
  assert(src&&dst,'测试库需要两只证券主档');
  const c=await pool.query("INSERT INTO event.arbitrage_cases(market,strategy_type,source_id,source_key,swap_ratio,target_instrument_id,reference_instrument_id) SELECT 'CN','a_share_swap',source_id,$1,0.5,$2,$3 FROM ops.data_sources ORDER BY source_id LIMIT 1 RETURNING case_id",['atomic-test-'+Date.now(),src.instrument_id,dst.instrument_id]);caseId=c.rows[0].case_id;
  const caseRow={case_id:caseId,source_instrument_id:src.instrument_id,target_instrument_id:dst.instrument_id,source_code:'601198.SH',target_code:'601995.SH',source_name:'东兴证券',target_name:'中金公司',swap_ratio:'0.5',evidence_announced_at:'2026-10-16T00:00:00+08:00'};
  await pool.query("INSERT INTO positions(id,username,account_name,account_id,code,name,price,quantity,cost,type,subtype,instrument_id) VALUES ('atomic_src',$1,$2,$3,'601198','东兴证券',0,100,10,'股权','沪市',$4),('atomic_dst',$1,$2,$3,'601995','中金公司',0,20,20,'股权','沪市',$5)",[U,A,ID,src.instrument_id,dst.instrument_id]);
  const plan=svc.buildPlan(caseRow,{username:U,account_name:A,account_id:ID,quantity:100,cost_total:1000,type:'股权',subtype:'沪市'},{quantity:20,costTotal:400,type:'股权',subtype:'沪市'});
  const acq=await pool.query("INSERT INTO event.arbitrage_cases(market,strategy_type,source_id,source_key,swap_ratio,target_instrument_id,reference_instrument_id) SELECT 'CN','a_share_swap',source_id,$1,0.5,$2,$2 FROM ops.data_sources ORDER BY source_id LIMIT 1 RETURNING case_id",['atomic-acq-'+Date.now(),dst.instrument_id]);acqCaseId=acq.rows[0].case_id;
  const doc=await pool.query("INSERT INTO event.documents(document_type,title,announced_at,url,source_id) SELECT 'announcement','中金公司换股吸收合并东兴证券之A股换股实施结果公告','2026-10-27',$1,source_id FROM ops.data_sources WHERE source_code='sse' RETURNING document_id",['atomic-doc-'+Date.now()]);assert(doc.rows.length,'测试库需 sse 来源');evidenceId=doc.rows[0].document_id;
  await pool.query('INSERT INTO event.arbitrage_case_documents(case_id,document_id) VALUES($1,$2)',[acqCaseId,evidenceId]);
  let missing=await repo.selectUnlinkedImplementationCandidates('2026-10-26');assert(!missing.some(x=>String(x.case_id)===String(caseId)),'未来公告不得进入历史目标日');
  missing=await repo.selectUnlinkedImplementationCandidates('2026-10-27');assert(missing.some(x=>String(x.case_id)===String(caseId)),'合并方案件有完成公告但被合并方案件未关联时须报告缺口');
  await pool.query('INSERT INTO event.arbitrage_case_documents(case_id,document_id) VALUES($1,$2)',[caseId,evidenceId]);
  missing=await repo.selectUnlinkedImplementationCandidates('2026-10-27');assert(!missing.some(x=>String(x.case_id)===String(caseId)),'已关联完成公告不得继续报告缺口');
  // 生产存在合并方持仓和一条方向反转的历史案件；只在生命周期证据明确时排除。
  const reverseClient=await pool.connect();
  try {
    await reverseClient.query('BEGIN');
    await reverseClient.query("UPDATE core.instruments SET status='listed',delist_date=NULL WHERE instrument_id=$1",[dst.instrument_id]);
    await reverseClient.query("UPDATE core.instruments SET status='delisted',delist_date=NULL WHERE instrument_id=$1",[src.instrument_id]);
    const reverse=await reverseClient.query("INSERT INTO event.arbitrage_cases(market,strategy_type,source_id,source_key,swap_ratio,target_instrument_id,reference_instrument_id) SELECT 'CN','a_share_swap',source_id,$1,2,$2,$3 FROM ops.data_sources ORDER BY source_id LIMIT 1 RETURNING case_id",['atomic-reverse-'+Date.now(),dst.instrument_id,src.instrument_id]);
    const reverseId=String(reverse.rows[0].case_id);
    missing=await repo.selectUnlinkedImplementationCandidates('2026-10-27',reverseClient);
    assert(missing.some(x=>String(x.case_id)===reverseId),'退市日期未知时不得排除待核查案件');
    await reverseClient.query("UPDATE core.instruments SET delist_date='2026-10-19' WHERE instrument_id=$1",[src.instrument_id]);
    missing=await repo.selectUnlinkedImplementationCandidates('2026-10-27',reverseClient);
    assert(!missing.some(x=>String(x.case_id)===reverseId),'在市合并方与已退市参考对象的反向案件不得告警');
  } finally { await reverseClient.query('ROLLBACK'); reverseClient.release(); }
  const patterns=svc.IMPLEMENTATION_TITLE_PATTERNS.map(x=>'%'+x+'%');
  let completed=await repo.selectImplementedSwapCases(patterns,'2026-10-26');assert(!completed.some(x=>String(x.case_id)===String(caseId)),'未披露的完成公告不得用于历史目标日');
  completed=await repo.selectImplementedSwapCases(patterns,'2026-10-27');assert(completed.some(x=>String(x.case_id)===String(caseId)),'有效完成公告应被识别');
  await pool.query('DELETE FROM event.arbitrage_case_documents WHERE case_id=$1 AND document_id=$2',[caseId,evidenceId]);

  const original=repo.updateSettlementStatus; repo.updateSettlementStatus=async()=>{throw Error('injected status failure')};
  const failed=await svc.settleOne(caseRow,plan,{});repo.updateSettlementStatus=original;
  assert.equal(failed.status,'failed');assert.match(failed.error,/injected/);
  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM trades WHERE username=$1',[U])).rows[0].n),0,'账本与结算状态必须整体回滚');
  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM event.stock_swap_settlements WHERE case_id=$1',[caseId])).rows[0].n),0,'失败不留半成品结算单');
  const originalQuantity=repo.selectCurrentSourceQuantity;repo.selectCurrentSourceQuantity=async()=>({quantity:1});
  const mismatch=await svc.settleOne(caseRow,plan,{});repo.selectCurrentSourceQuantity=originalQuantity;
  assert.equal(mismatch.status,'failed');assert.match(mismatch.error,/账本重放后的持仓/);
  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM trades WHERE username=$1',[U])).rows[0].n),0,'重放后数量不符必须回滚账本');
  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM event.stock_swap_settlements WHERE case_id=$1',[caseId])).rows[0].n),0,'重放后数量不符不得留下结算单');
  const originalTarget=repo.selectExistingTargetHolding;let targetCalls=0;
  repo.selectExistingTargetHolding=async(...args)=>{const r=await originalTarget(...args);targetCalls++;return targetCalls===2?{...r,cost_total:Number(r.cost_total)+500}:r};
  const costMismatch=await svc.settleOne(caseRow,plan,{});repo.selectExistingTargetHolding=originalTarget;
  assert.equal(costMismatch.status,'failed');assert.match(costMismatch.error,/持仓成本/);
  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM trades WHERE username=$1',[U])).rows[0].n),0,'重放后成本不符必须回滚账本');
  const lock=await pool.connect();await lock.query('BEGIN');await lock.query('SELECT version FROM account_data WHERE username=$1 AND account_name=$2 FOR UPDATE',[U,A]);
  const pending=svc.settleOne(caseRow,plan,{});
  await lock.query("UPDATE positions SET quantity=200 WHERE username=$1 AND account_name=$2 AND code='601198'",[U,A]);
  await lock.query('COMMIT');lock.release();
  const done=await pending;assert.equal(done.status,'applied',JSON.stringify(done));assert.equal(done.source_quantity,200,'必须按锁内最新持仓重算');assert.equal(done.target_quantity,100);
  const rows=(await pool.query('SELECT code,quantity FROM positions WHERE username=$1 AND account_name=$2 ORDER BY code',[U,A])).rows;
  assert.deepEqual(rows.map(r=>[r.code,Number(r.quantity)]),[['601995',120]],'合并方原持仓必须保留');
  const settlement=(await pool.query('SELECT status,applied_trade_ids FROM event.stock_swap_settlements WHERE case_id=$1',[caseId])).rows[0];assert.equal(settlement.status,'applied');assert.equal(settlement.applied_trade_ids.length,2);
  const again=await svc.settleOne(caseRow,plan,{});assert.equal(again.status,'skipped');assert.equal(Number((await pool.query('SELECT count(*) AS n FROM trades WHERE username=$1',[U])).rows[0].n),2,'重试不得重复写入');
  // 快照导入也必须在改持仓前等待同一版本锁。
  const importLock=await pool.connect();await importLock.query('BEGIN');
  const version=Number((await importLock.query('SELECT version FROM account_data WHERE username=$1 AND account_name=$2 FOR UPDATE',[U,A])).rows[0].version);
  let importFinished=false;
  const importing=require('../db/accounts').saveAccountData(U,A,{positions:[{id:'snap1',code:'601995',name:'中金公司',price:1,quantity:7,cost:2,type:'股权',subtype:'沪市'}],trades:[],navHistory:[],cashFlows:[],cash:0,hkRate:1,totalAsset:7,feeSettings:{}},version,null,null).then(v=>{importFinished=true;return v});
  await new Promise(r=>setTimeout(r,150));
  assert.equal(importFinished,false,'快照导入必须等待账户版本锁');
  assert.equal(Number((await pool.query("SELECT quantity FROM positions WHERE username=$1 AND code='601995'",[U])).rows[0].quantity),120,'等待时不得提前改写持仓');
  await importLock.query('COMMIT');importLock.release();await importing;
  assert.equal(Number((await pool.query("SELECT quantity FROM positions WHERE username=$1 AND code='601995'",[U])).rows[0].quantity),7,'锁释放后快照导入可继续');
  console.log('换股结算：账户锁内重算、并发变更、失败回滚、幂等及快照导入串行通过');
 } finally {await cleanup();await pool.end();}
})().catch(e=>{console.error(e);process.exitCode=1});

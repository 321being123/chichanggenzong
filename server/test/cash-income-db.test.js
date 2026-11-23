// 现金收益 PG 数据库集成测试合并文件（合并原 cash-income-db / actual / bond-interest / identity / migration / queue / cash-dividend-reprocess-contract）。
(async () => {

  // --- [1] cash-income-db.test.js ---
  await (async () => {
const assert = require('assert');
const { testSession } = require('./helpers/session-subject');
const express = require('express');
const { pool } = require('../db/connection');
const { loadAccountData, loadAccountSummary, saveAccountData } = require('../db/accounts');
const { loadCashState } = require('../services/accountCash');
const { addCashFlow, deleteCashFlow, recomputeCash } = require('../services/tradeLedger');
const router = require('../routes/accounts');
const U='cash_income_contract_test', A='现金收益回归', ID='cash_income_contract_test_id';
const tables=['positions','trades','nav_history','cash_flows','nav_position_snapshots','account_data','accounts'];
async function cleanup() {
  await pool.query("DELETE FROM fundamental.corporate_actions WHERE source_key LIKE 'cash_preserve_test_%'");
  for(const t of tables) await pool.query(`DELETE FROM ${t} WHERE username=$1`,[U]);
  await pool.query('DELETE FROM users WHERE username=$1',[U]);
}
return (async () =>{
  let server,hkCoverageScope,hkCoverageBackup;
  try {
    await cleanup();
    await pool.query("INSERT INTO users(username,password,accounts,status,auth_version) VALUES($1,'x',$2,'active',1)",[U,JSON.stringify([A])]);
    await pool.query("INSERT INTO accounts(id,username,account_name,cash_base,hk_rate) VALUES($1,$2,$3,100,1)",[ID,U,A]);
    await pool.query("INSERT INTO account_data(username,account_name,data,version) VALUES($1,$2,'{}',0)",[U,A]);
    await pool.query(`INSERT INTO nav_history(username,account_name,account_id,date,nav,total_asset,invested,cash_cny,
      market_value_cny,system_market_value_at_snapshot,snapshot_source,is_locked,source_priority)
      VALUES($1,$2,$3,'2026-09-01',1,1000,1000,1000,0,0,'imported',true,100)`,[U,A,ID]);
    await pool.query(`INSERT INTO cash_flows(id,username,account_name,account_id,date,amount,origin,flow_type,status,event_key,anchor_date)
      VALUES('system',$1,$2,$3,'2026-09-02',3,'system','repo_interest','estimated','repo:2026-09-01','2026-09-01'),
      ('imported',$1,$2,$3,'2026-09-02',10,'imported','external_transfer','confirmed',NULL,NULL)`,[U,A,ID]);
    const d = await loadAccountData(U,A), s=await loadAccountSummary(U,A);
    assert.strictEqual(d.cash,1013); assert.strictEqual(s.cash,d.cash);
    assert.strictEqual(d.authoritativeInvested,1010);
    assert.strictEqual(d.cashConfirmed,1010); assert.strictEqual(s.cashEstimatedDelta,3);
    assert.strictEqual(await recomputeCash(pool,U,A),1013);
    assert.strictEqual((await loadCashState(U,A,pool,'2026-08-31')).value,100);
    assert.strictEqual((await loadCashState(U,A,pool,'2026-09-01')).value,1000);
    assert.strictEqual(d.cashFlows[0].date,'2026-09-02','PG DATE必须在SQL边界序列化为文本');
    assert.strictEqual((await pool.query("SELECT data_type FROM information_schema.columns WHERE table_name='cash_flows' AND column_name='date'")).rows[0].data_type,'date');
    // 旧页面未带自动行，与完整响应回传两个分支。
    await saveAccountData(U,A,{cashBase:100,cashFlows:[]},0,null,['cashFlows']);
    assert.strictEqual((await loadAccountData(U,A)).cash,1013);
    let current=await loadAccountData(U,A);
    await saveAccountData(U,A,{...current,cashFlows:current.cashFlows.map(f=>({...f,amount:999}))},current.version,null,['cashFlows']);
    assert.strictEqual((await loadAccountData(U,A)).cash,1013);
    current=await loadAccountData(U,A);
    await assert.rejects(()=>saveAccountData(U,A,{...current,cashFlows:[{id:'system',date:'2026-09-02',amount:999}]},current.version,null,['cashFlows']),/不能.*流水/);
    await assert.rejects(()=>saveAccountData(U,A,{...current,cashFlows:[{id:'fake',date:'2026-09-02',amount:999,origin:'system'}]},current.version,null,['cashFlows']),/伪造/);
    await assert.rejects(()=>deleteCashFlow(U,A,'system',current.version),/不存在/);
    await assert.rejects(()=>deleteCashFlow(U,A,'imported',current.version),/不存在/);
    await assert.rejects(()=>addCashFlow(U,A,{id:'system',date:'2026-09-02',amount:1},current.version),/不能覆盖/);
    await assert.rejects(()=>addCashFlow(U,A,{date:'2026-02-30',amount:1},current.version),/日期/);
    await assert.rejects(()=>addCashFlow(U,A,{date:'2026-09-02',amount:Infinity},current.version),/金额/);
    const add = await addCashFlow(U,A,{id:'manual',date:'2026-09-02',amount:20},current.version);
    assert.strictEqual(add.cash,1033);
    const retry=await addCashFlow(U,A,{id:'manual',date:'2026-09-02',amount:20},current.version);
    assert.strictEqual(retry.skipped,'duplicate');
    current=await loadAccountData(U,A);
    await deleteCashFlow(U,A,'manual',current.version);
    assert.strictEqual((await loadAccountData(U,A)).cash,1013);
    const app=express(); app.use(express.json());
    app.use(async (req,res,next)=>{ try { req.session = await testSession(U); next(); } catch (e) { next(e); } }); app.use('/api',router);
    server=await new Promise(resolve=>{const x=app.listen(0,'127.0.0.1',()=>resolve(x));});
    const base='http://127.0.0.1:'+server.address().port;
    const ok=await fetch(base+'/api/accounts/'+encodeURIComponent(A)+'/cash-income/coverage');
    assert.strictEqual(ok.status,200); assert.strictEqual((await ok.json()).cashAnchorDate,'2026-09-01');
    const denied=await fetch(base+'/api/accounts/'+encodeURIComponent('他人账户')+'/cash-income/coverage');
    assert.strictEqual(denied.status,403);
    await pool.query('DELETE FROM cash_flows WHERE username=$1 AND origin=\'system\'',[U]);
    const {settleCashIncome}=require('../services/cashIncome');
    const first=await settleCashIncome(U,A,{targetDate:'2026-09-04',enable:true});
    assert(first.changed>0);
    await require('../db/accounts').upsertNav(U,A,{date:'2026-09-03',nav:1.0001,totalAsset:1011,invested:1010});
    const saved=(await pool.query("SELECT diagnostics FROM nav_history WHERE username=$1 AND date='2026-09-03'",[U])).rows[0];
    assert.strictEqual(saved.diagnostics.cashIncomeVersion,'cash-income-v1');
    await settleCashIncome(U,A,{targetDate:'2026-09-04'});
    assert.strictEqual(Number((await pool.query("SELECT total_asset FROM nav_history WHERE username=$1 AND date='2026-09-03'",[U])).rows[0].total_asset),1011);
    assert.strictEqual(Number((await pool.query("SELECT nav FROM nav_history WHERE username=$1 AND date='2026-09-03'",[U])).rows[0].nav),1.0001,'缺首页历史基准时现金收益不得用旧资产伪造新NAV');
    const after=await loadAccountData(U,A);
    assert.strictEqual(after.authoritativeInvested,1010);
    const retryIncome=await settleCashIncome(U,A,{targetDate:'2026-09-04'});
    assert.strictEqual(retryIncome.changed,0);
    assert.strictEqual(retryIncome.navUpdated,0);
    assert.strictEqual((await loadAccountData(U,A)).cash,after.cash);
    await assert.rejects(()=>settleCashIncome(U,A,{targetDate:'2026-09-04',expectedVersion:0}),/已修改/);
    const active=(await pool.query("SELECT id FROM cash_flows WHERE username=$1 AND flow_type='repo_interest' ORDER BY date LIMIT 1",[U])).rows[0];
    await pool.query("UPDATE cash_flows SET status='confirmed',amount=1.23,amount_cny=1.23,quality_status='broker_settlement' WHERE username=$1 AND id=$2",[U,active.id]);
    await settleCashIncome(U,A,{targetDate:'2026-09-04'});
    assert.strictEqual(Number((await pool.query('SELECT amount FROM cash_flows WHERE username=$1 AND id=$2',[U,active.id])).rows[0].amount),1.23);
    assert.strictEqual((await pool.query('SELECT count(*)::int AS n FROM cash_flows WHERE username=$1 AND id=$2',[U,active.id])).rows[0].n,1);
    await pool.query(`INSERT INTO nav_history(username,account_name,account_id,date,nav,total_asset,invested,cash_cny,snapshot_source,is_locked,source_priority)
      VALUES($1,$2,$3,'2026-09-04',1,2000,1010,2000,'imported',true,100)`,[U,A,ID]);
    await settleCashIncome(U,A,{targetDate:'2026-09-04'});
    assert.strictEqual((await loadAccountData(U,A)).cash,2000);
    // 新官方版本缺净额不能抹掉同一事件的上一份有效估算；补齐后替换而非叠加。
    // 测试库可能来自空快照（如 CI），所需证券身份在测试内补齐，不依赖业务库存量。
    await pool.query(`INSERT INTO core.instruments(canonical_code,name,market,exchange_code,currency_code,asset_class)
      VALUES ('000001.SZ','平安银行','CN','SZSE','CNY','stock') ON CONFLICT(canonical_code) DO NOTHING`);
    const instrument=(await pool.query("SELECT instrument_id,canonical_code FROM core.instruments WHERE canonical_code='000001.SZ'")).rows[0];
    assert(instrument,'隔离库须有标准证券身份');
    const code=instrument.canonical_code;
    await pool.query(`INSERT INTO positions(id,username,account_name,code,instrument_id,quantity,type,subtype) VALUES('cash_preserve_position',$1,$2,$3,$4,100,'股权','A股')`,[U,A,code,instrument.instrument_id]);
    await pool.query(`INSERT INTO trades(id,username,account_name,date,trade_date,direction,code,quantity,amount) VALUES('cash_preserve_trade',$1,$2,'2026-09-01','2026-09-01','open',$3,100,0)`,[U,A,code]);
    const source=(await pool.query('SELECT source_id FROM ops.data_sources ORDER BY source_id LIMIT 1')).rows[0].source_id;
    await pool.query(`INSERT INTO fundamental.corporate_actions(instrument_id,action_type,record_date,pay_date,status,cash_per_share_after_tax,source_id,source_key) VALUES($1,'dividend','2026-09-07','2026-09-08','实施',1,$2,'cash_preserve_test_old')`,[instrument.instrument_id,source]);
    await settleCashIncome(U,A,{targetDate:'2026-09-09'});
    const eventKey='dividend:'+instrument.instrument_id+':2026-09-07:2026-09-08';
    const amount=async()=>Number((await pool.query("SELECT amount FROM cash_flows WHERE username=$1 AND event_key=$2 AND status<>'revoked'",[U,eventKey])).rows[0]?.amount);
    assert.strictEqual(await amount(),100);
    await pool.query(`INSERT INTO fundamental.corporate_actions(instrument_id,action_type,record_date,pay_date,status,source_id,source_key,raw_payload) VALUES($1,'dividend','2026-09-07','2026-09-08','实施',$2,'cash_preserve_test_new','{"documentId":123}')`,[instrument.instrument_id,source]);
    const incomplete=await settleCashIncome(U,A,{targetDate:'2026-09-09'});assert(incomplete.pending.some(p=>p.eventKey===eventKey&&p.reason==='missing_net_amount'));
    assert.strictEqual(await amount(),100,'缺净额保留旧有效金额');
    await pool.query("UPDATE fundamental.corporate_actions SET cash_per_share_after_tax=0.9 WHERE source_key='cash_preserve_test_new'");
    await settleCashIncome(U,A,{targetDate:'2026-09-09'});assert.strictEqual(await amount(),90);
    assert.strictEqual((await settleCashIncome(U,A,{targetDate:'2026-09-09'})).changed,0);
    await pool.query(`UPDATE fundamental.corporate_actions SET cash_per_share_after_tax=NULL,cash_per_share_pre_tax=0.8,raw_payload='{"documentId":123,"taxTreatment":{"kind":"CN_personal_deferred_2015","sourceExcerpt":"自然人股东暂不扣缴个人所得税"}}' WHERE source_key='cash_preserve_test_new'`);
    await settleCashIncome(U,A,{targetDate:'2026-09-09'});assert.strictEqual(await amount(),80,'本事件明确递延政策允许按毛额发放初始股息，不预扣卖出税');
    await pool.query("UPDATE trades SET direction='buy' WHERE id='cash_preserve_trade' AND username=$1",[U]);
    await pool.query("INSERT INTO trades(id,username,account_name,date,trade_date,direction,code,quantity,amount) VALUES('cash_tax_sale',$1,$2,'2026-09-09','2026-09-09','sell',$3,50,0)",[U,A,code]);
    await pool.query('UPDATE positions SET quantity=50 WHERE username=$1 AND code=$2',[U,code]);
    const taxResult=await settleCashIncome(U,A,{targetDate:'2026-09-10'});
    assert.strictEqual(taxResult.deferredTaxCalculated,-8,'已授权公告/交易计算补税进入系统现金，不要求券商凭证');
    const taxFlow=(await pool.query("SELECT *,date::text FROM cash_flows WHERE username=$1 AND flow_type='dividend_tax' AND status='estimated'",[U])).rows[0];assert(taxFlow);assert.strictEqual(Number(taxFlow.amount),-8);assert.strictEqual(taxFlow.evidence.brokerVerified,false);
    assert.strictEqual((await settleCashIncome(U,A,{targetDate:'2026-09-10'})).changed,0);
    const version=(await loadAccountData(U,A)).version;
    await require('../services/cashIncomeActual').importActual(U,A,[{eventKey:taxFlow.event_key,date:'2026-09-10',flow_type:'dividend_tax',amountCny:'-7.50',sourceRef:'optional-actual-fixture'}],version);
    await settleCashIncome(U,A,{targetDate:'2026-09-10'});
    const replaced=(await pool.query("SELECT amount::text,status FROM cash_flows WHERE username=$1 AND event_key=$2 AND flow_type='dividend_tax'",[U,taxFlow.event_key])).rows;assert.strictEqual(replaced.length,1);assert.strictEqual(Number(replaced[0].amount),-7.5);assert.strictEqual(replaced[0].status,'confirmed');
    await pool.query(`INSERT INTO core.instruments(canonical_code,name,market,exchange_code,currency_code,asset_class)
      VALUES ('00941.HK','中国移动','HK','HKEX','HKD','stock') ON CONFLICT(canonical_code) DO NOTHING`);
    const hk=(await pool.query("SELECT instrument_id,canonical_code FROM core.instruments WHERE canonical_code='00941.HK'")).rows[0];assert(hk);
    await pool.query("INSERT INTO positions(id,username,account_name,code,instrument_id,quantity,type,subtype) VALUES('cash_hk_position',$1,$2,$3,$4,100,'股权','港股')",[U,A,hk.canonical_code,hk.instrument_id]);
    await pool.query("INSERT INTO trades(id,username,account_name,date,trade_date,direction,code,quantity,amount) VALUES('cash_hk_buy',$1,$2,'2026-09-01','2026-09-01','buy',$3,100,0)",[U,A,hk.canonical_code]);
    for(const [suffix,perShare,nature] of [['normal','1','普通股息'],['special','0.1','特別股息']]){
      const raw={documentId:456,contentHash:'a'.repeat(64),period:'2026-06-30',dividendType:'中期',dividendNature:nature,taxTreatment:require('../services/cashDividendSettlement').parseHkTaxTreatment('股息所涉及的代扣所得稅不適用')};
      await pool.query("INSERT INTO fundamental.corporate_actions(instrument_id,action_type,record_date,pay_date,status,cash_per_share_pre_tax,currency_code,source_id,source_key,raw_payload) VALUES($1,'dividend','2026-09-07','2026-09-08','实施',$2,'CNY',$3,$4,$5)",[hk.instrument_id,perShare,source,'cash_preserve_test_hk_'+suffix,raw]);
    }
    const hkKey='dividend:'+hk.instrument_id+':2026-09-07:2026-09-08';
    const unknownChannel=await settleCashIncome(U,A,{targetDate:'2026-09-10'});assert(unknownChannel.pending.some(p=>p.eventKey===hkKey&&p.reason==='missing_stock_connect_channel'),'不把其他用户港股默认当港股通');
    await pool.query("UPDATE accounts SET cash_income_policy=cash_income_policy||'{\"stockConnectChannel\":\"stock_connect\"}'::jsonb WHERE id=$1",[ID]);
    await pool.query("INSERT INTO cash_flows(id,username,account_name,account_id,date,anchor_date,amount,flow_type,origin,status,event_key,calculation_version,quality_status,evidence) VALUES('legacy_hk_t0',$1,$2,$3,'2026-09-08','2026-09-04',88,'dividend','system','estimated',$4,'cash-income-v1','authorized_dividend_calculation','{\"authorizedPolicy\":\"cash-income-v1\"}')",[U,A,ID,hkKey]);
    const beforeHkReceipt=await settleCashIncome(U,A,{targetDate:'2026-09-10'});
    assert(beforeHkReceipt.upcomingDividends.some(r=>r.eventKey===hkKey&&r.receiptDate==='2026-09-11'));
    assert.strictEqual((await pool.query("SELECT count(*)::int AS n FROM cash_flows WHERE username=$1 AND event_key=$2 AND status='estimated'",[U,hkKey])).rows[0].n,0,'T+3之前不得计入可用现金');
    assert.strictEqual((await pool.query("SELECT status FROM cash_flows WHERE id='legacy_hk_t0'")).rows[0].status,'revoked','旧T+0估算撤销并保留修订');
    await settleCashIncome(U,A,{targetDate:'2026-09-11'});
    const hkRows=(await pool.query("SELECT amount::text,date::text,evidence FROM cash_flows WHERE username=$1 AND event_key=$2 AND flow_type='dividend'",[U,hkKey])).rows;
    assert.strictEqual(hkRows.length,1);assert.strictEqual(Number(hkRows[0].amount),88,'港股普通及特别公告股息无需券商流水即可计算入账');assert.strictEqual(hkRows[0].evidence.components.length,2);
    assert.strictEqual(hkRows[0].date,'2026-09-11');assert.strictEqual((await settleCashIncome(U,A,{targetDate:'2026-09-11'})).changed,0,'T+3重复重算幂等');
    hkCoverageScope='cash_dividend:'+hk.instrument_id;
    hkCoverageBackup=(await pool.query("SELECT * FROM ops.sync_cursors WHERE scope_key=$1 AND dataset_code='stock_cash_dividend_facts'",[hkCoverageScope])).rows[0];
    const coverage={fromDate:'2026-09-01',complete:true,parserVersion:require('../services/cashDividendFacts').PARSER};
    await pool.query("INSERT INTO account_cash_income_pending(account_id,pending_key,code,reason,state) VALUES($1,'coverage_with_action',$2,'missing_hk_dividend_facts','pending')",[ID,hk.canonical_code]);
    await pool.query("INSERT INTO ops.sync_cursors(instrument_id,scope_key,dataset_code,last_success_date,cursor_payload) VALUES($1,$2,'stock_cash_dividend_facts','2026-09-10',$3) ON CONFLICT(scope_key,dataset_code) DO UPDATE SET last_success_date=EXCLUDED.last_success_date,cursor_payload=EXCLUDED.cursor_payload",[hk.instrument_id,hkCoverageScope,coverage]);
    await settleCashIncome(U,A,{targetDate:'2026-09-11'});
    assert.strictEqual((await pool.query("SELECT state FROM account_cash_income_pending WHERE account_id=$1 AND pending_key='coverage_with_action'",[ID])).rows[0].state,'pending','旧日期覆盖不能关闭待办');
    await pool.query("UPDATE ops.sync_cursors SET last_success_date='2026-09-11' WHERE scope_key=$1 AND dataset_code='stock_cash_dividend_facts'",[hkCoverageScope]);
    await settleCashIncome(U,A,{targetDate:'2026-09-11'});
    assert.strictEqual((await pool.query("SELECT state FROM account_cash_income_pending WHERE account_id=$1 AND pending_key='coverage_with_action'",[ID])).rows[0].state,'resolved','有实施行动的证券仍按本作用域覆盖证据恢复');
    const hkVersion=(await loadAccountData(U,A)).version;
    await require('../services/cashIncomeActual').importActual(U,A,[{eventKey:hkKey,date:'2026-09-10',flow_type:'dividend',amountCny:'87',originalAmount:'87',currency:'CNY',sourceRef:'optional-hk-net-fixture',settlement:{amountBasis:'net'}}],hkVersion);
    await settleCashIncome(U,A,{targetDate:'2026-09-10'});assert.strictEqual(Number((await pool.query("SELECT amount FROM cash_flows WHERE username=$1 AND event_key=$2 AND flow_type='dividend'",[U,hkKey])).rows[0].amount),87,'实收只替换估算');
    await pool.query(`INSERT INTO cash_flows(id,username,account_name,date,amount,flow_type,origin,status) VALUES('cash_precision',$1,$2,'2026-09-10',0.000001,'external_transfer','manual','confirmed')`,[U,A]);
    const precise=await loadAccountData(U,A);assert.strictEqual(await recomputeCash(pool,U,A),precise.cash,'账本现金保留六位精度，与完整和摘要一致');assert.strictEqual((await loadAccountSummary(U,A)).cash,precise.cash);
    const detail=await fetch(base+'/api/accounts/'+encodeURIComponent(A)+'/cash-income');
    assert.strictEqual(detail.status,200);
    // 用户确认只影响本账户、本次事件和原资格股数；不改交易日期或官方公告。
    await pool.query("UPDATE fundamental.corporate_actions SET cash_per_share_pre_tax=1.2,cash_per_share_after_tax=NULL,currency_code='CNY',raw_payload='{\"documentId\":123}' WHERE source_key='cash_preserve_test_new'");
    const entitlement=require('../services/cashIncome').holdingAt((await pool.query('SELECT * FROM trades WHERE username=$1',[U])).rows,code,'2026-09-07',(await pool.query('SELECT * FROM positions WHERE username=$1',[U])).rows).quantity;
    const proof={eventKey,code,confirmedBy:U,holdingPeriod:'over_one_year',allEntitledShares:true,quantity:entitlement};
    await pool.query("UPDATE accounts SET cash_income_policy=cash_income_policy||$2::jsonb WHERE id=$1",[ID,JSON.stringify({cnDividendExemptions:[proof],dividendScopeExclusions:[{code:'404002',confirmedBy:U,outsideStockDividendScope:true,reason:'退市转债排除'}]})]);
    await pool.query("INSERT INTO trades(id,username,account_name,date,trade_date,direction,code,quantity,amount) VALUES('scope_exclusion',$1,$2,'2026-09-01','2026-09-01','open','404002',1,0)",[U,A]);
    await pool.query("INSERT INTO account_cash_income_pending(account_id,pending_key,code,reason,state) VALUES($1,'user_scope_exclusion','404002','missing_or_ambiguous_identity','pending')",[ID]);
    const exemptResult=await settleCashIncome(U,A,{targetDate:'2026-09-11'});
    assert(!exemptResult.pending.some(p=>p.eventKey===eventKey&&p.reason==='missing_net_amount'));
    const exemptFlow=(await pool.query("SELECT amount,evidence FROM cash_flows WHERE username=$1 AND event_key=$2 AND flow_type='dividend'",[U,eventKey])).rows[0];
    assert.strictEqual(Number(exemptFlow.amount),Math.round(entitlement*1.2*100)/100);
    assert.deepStrictEqual(exemptFlow.evidence.userTaxExemption,proof);
    assert.strictEqual((await pool.query("SELECT state FROM account_cash_income_pending WHERE account_id=$1 AND pending_key='user_scope_exclusion'",[ID])).rows[0].state,'excluded_by_user');
    assert.strictEqual((await settleCashIncome(U,A,{targetDate:'2026-09-11'})).changed,0);
    const {accountFingerprint}=require('../scripts/importCashIncomeEvidence');
    const immutableFingerprint=await accountFingerprint(U,A);
    await pool.query('UPDATE positions SET price=COALESCE(price,0)+0.01 WHERE username=$1',[U]);
    assert.strictEqual(await accountFingerprint(U,A),immutableFingerprint,'同步指纹检查股数/交易/锁定净值，不阻止生产行情正常更新');
    console.log('cash income DB: anchor consistency, DATE, source protection, retries and ownership passed');
  } finally { if(server) await new Promise(r=>server.close(r));if(hkCoverageScope){if(hkCoverageBackup)await pool.query("UPDATE ops.sync_cursors SET last_success_date=$2,cursor_payload=$3,last_attempt_at=$4,last_error=$5 WHERE scope_key=$1 AND dataset_code='stock_cash_dividend_facts'",[hkCoverageScope,hkCoverageBackup.last_success_date,hkCoverageBackup.cursor_payload,hkCoverageBackup.last_attempt_at,hkCoverageBackup.last_error]);else await pool.query("DELETE FROM ops.sync_cursors WHERE scope_key=$1 AND dataset_code='stock_cash_dividend_facts'",[hkCoverageScope]);} await cleanup();  }
})();
  })();

  // --- [2] cash-income-actual.test.js ---
  await (async () => {
const assert=require('assert');
require('dotenv').config();delete process.env.DATABASE_URL;process.env.PGDATABASE=process.env.PGTESTDATABASE||'portfolio_test';
const {pool}=require('../db/connection');
const {validate,importActual}=require('../services/cashIncomeActual');
const {syncPending,changePending,keyOf}=require('../services/cashIncomePending');
const {loadAccountData}=require('../db/accounts');
const U='cash_actual_test',A='本账户',ID='cash_actual_test_id',key='repo:204001.SH:2026-09-02';
const record={eventKey:key,date:'2026-09-03',flow_type:'repo_interest',amountCny:'1.23',sourceRef:'fixture-voucher',settlement:{tax:{amount:'0.00',basis:'actual'}}};
async function cleanup(){await pool.query('DELETE FROM accounts WHERE username=$1',[U]);for(const t of ['cash_flows','nav_history','account_data'])await pool.query(`DELETE FROM ${t} WHERE username=$1`,[U]);await pool.query('DELETE FROM users WHERE username=$1',[U]);}
return (async () =>{try{
  for(const r of [null,{...record,amountCny:1.23},{...record,amountCny:'-1'},{...record,date:'2026-02-30'},{...record,eventKey:'repo:204001.SH:bad'},{...record,currency:'HKD'},{...record,originalAmount:'2'},{...record,settledAt:'2026-09-02T23:00:00+08:00'}])assert.throws(()=>validate([r]));
  // R2-008：字段类型与结构必须先于内容判断——对象事件键原来会走到 .match 抛 TypeError（不是 400），
  // sourceRef 对象会被 String() 成 "[object Object]" 落库，settlement 传数组还能绕过形状校验。
  for(const bad of [
    {...record,eventKey:{a:1}},
    {...record,eventKey:123},
    {...record,eventKey:['repo:204001.SH:2026-09-02']},
    {...record,sourceRef:{}},
    {...record,sourceRef:123},
    {...record,settlement:[]},
    {...record,settlement:'gross'},
    {...record,settlement:{amountBasis:'net',layers:'not-array'}},
    {...record,settlement:{amountBasis:'weird'}},
  ]) {
    let thrown=null;
    try{validate([bad]);}catch(e){thrown=e;}
    assert.ok(thrown,'非法类型/结构必须被拒绝：'+JSON.stringify(bad));
    assert.strictEqual(thrown.status,400,'必须是约定的 400，不能抛 TypeError：'+JSON.stringify(bad));
  }
  assert.strictEqual(validate([{...record,sourceRef:'  v-1  '}])[0].sourceRef,'v-1','合法文本凭证引用要去掉首尾空白后保留原值');
  assert.throws(()=>validate([record,record]),/重复/);
  assert.strictEqual(validate([{...record,currency:'HKD',originalAmount:'1.40',settledAt:'2026-09-02T17:00:00Z'}])[0].currency,'HKD');
  await cleanup();await pool.query("INSERT INTO users(username,password,accounts,status,auth_version) VALUES($1,'x',$2,'active',1)",[U,JSON.stringify([A])]);
  await pool.query('INSERT INTO accounts(id,username,account_name,cash_base,hk_rate) VALUES($1,$2,$3,0,1)',[ID,U,A]);
  await pool.query("INSERT INTO account_data(username,account_name,data,version) VALUES($1,$2,'{}',0)",[U,A]);
  await pool.query(`INSERT INTO nav_history(username,account_name,account_id,date,nav,total_asset,invested,cash_cny,market_value_cny,system_market_value_at_snapshot,snapshot_source,is_locked,source_priority) VALUES($1,$2,$3,'2026-09-01',1,10000,10000,10000,0,0,'imported',true,100)`,[U,A,ID]);
  await pool.query(`INSERT INTO cash_flows(id,username,account_name,account_id,date,amount,flow_type,origin,status,event_key,anchor_date) VALUES('actual-test',$1,$2,$3,'2026-09-03',3,'repo_interest','system','estimated',$4,'2026-09-01')`,[U,A,ID,key]);
  assert.strictEqual((await importActual(U,A,[record],0)).changed,1);
  let d=await loadAccountData(U,A);assert.strictEqual(d.cash,10001.23);assert.strictEqual(d.authoritativeInvested,10000);
  assert.strictEqual((await importActual(U,A,[{...record,settlement:{tax:{basis:'actual',amount:'0.00'}}}],d.version)).changed,0,'嵌套键顺序不制造修订');
  assert.strictEqual((await importActual(U,A,[{...record,settlement:{tax:{amount:'0.01',basis:'actual'}}}],d.version)).changed,1,'嵌套证据变化必须产生修订');
  d=await loadAccountData(U,A);await assert.rejects(()=>importActual(U,A,[record],0),/版本|修改/);
  await assert.rejects(()=>importActual('other',A,[record],d.version),/不存在/);
  await assert.rejects(()=>importActual(U,A,[{...record,eventKey:'repo:204001.SH:2026-09-04'}],d.version),/不属于/);
  await importActual(U,A,[{...record,currency:'HKD',originalAmount:'1.40',settledAt:'2026-09-03T10:00:00+08:00'}],d.version);
  const saved=(await pool.query("SELECT currency,original_amount::text,settled_at FROM cash_flows WHERE id='actual-test'")).rows[0];assert.strictEqual(saved.currency,'HKD');assert.strictEqual(saved.original_amount,'1.400000');assert(saved.settled_at);
  d=await loadAccountData(U,A);await importActual(U,A,[{...record,status:'revoked'}],d.version);assert.strictEqual((await loadAccountData(U,A)).cash,10000);
  const pending={code:'204001.SH',eventKey:key,reason:'missing_repo_daily_rate'};
  await syncPending(pool,ID,[pending],1,U);await syncPending(pool,ID,[],2,U);
  assert.strictEqual((await pool.query('SELECT state FROM account_cash_income_pending WHERE account_id=$1',[ID])).rows[0].state,'pending','空结果不恢复');
  await syncPending(pool,ID,[],2,U,[{code:pending.code,eventKey:key,rawRecordId:123,reason:'verified_rate'}]);
  assert.strictEqual((await pool.query('SELECT state FROM account_cash_income_pending WHERE account_id=$1',[ID])).rows[0].state,'resolved');
  d=await loadAccountData(U,A);await changePending(U,A,keyOf(pending),{exclude:true,reason:'用户测试排除',version:d.version});
  await syncPending(pool,ID,[pending],3,U);assert.strictEqual((await pool.query('SELECT state FROM account_cash_income_pending WHERE account_id=$1',[ID])).rows[0].state,'excluded_by_user');
  // 测试库可能来自空快照（如 CI），港股身份在测试内补齐，不依赖业务库存量。
  await pool.query(`INSERT INTO core.instruments(canonical_code,name,market,exchange_code,currency_code,asset_class) VALUES ('00941.HK','中国移动','HK','HKEX','HKD','stock') ON CONFLICT(canonical_code) DO NOTHING`);
  const hk=(await pool.query("SELECT instrument_id,canonical_code FROM core.instruments WHERE canonical_code='00941.HK'")).rows[0];assert(hk);
  const hkEvent='dividend:'+hk.instrument_id+':2026-09-01:2026-09-02';
  await syncPending(pool,ID,[{code:hk.canonical_code,eventKey:hkEvent,reason:'missing_stock_connect_net_cny_settlement'}],4,U);
  const hkActual={eventKey:hkEvent,date:'2026-09-08',flow_type:'dividend',currency:'HKD',originalAmount:'72.00',amountCny:'64.80',sourceRef:'fixture-HK-net-voucher',settlement:{amountBasis:'net'}};
  d=await loadAccountData(U,A);await assert.rejects(()=>importActual(U,A,[{...hkActual,settlement:{}}],d.version),/港股实收必须明确/);
  await importActual(U,A,[hkActual],d.version);assert.strictEqual((await loadAccountData(U,A)).cash,10064.8,'人民币实收优先，不重复按20%扣税');
  d=await loadAccountData(U,A);assert.strictEqual((await importActual(U,A,[hkActual],d.version)).changed,0);
  const taxEvent=require('../services/cashDividendSettlement').taxEvent('dividend:1:2026-09-01:2026-09-02','sale-fixture');
  await syncPending(pool,ID,[{code:'600000',eventKey:taxEvent,reason:'deferred_tax_actual_deduction_pending',notBefore:'2026-09-08',expectedTax:'1.23'}],5,U);
  const taxActual={eventKey:taxEvent,date:'2026-09-08',flow_type:'dividend_tax',amountCny:'-1.23',sourceRef:'fixture-tax-deduction'};
  await assert.rejects(()=>importActual(U,A,[{...taxActual,date:'2026-09-07'}],d.version),/不能早于/);
  await importActual(U,A,[taxActual],d.version);assert.strictEqual((await loadAccountData(U,A)).cash,10063.57);
  d=await loadAccountData(U,A);await importActual(U,A,[{...taxActual,amountCny:'-1.00'}],d.version);assert.strictEqual((await loadAccountData(U,A)).cash,10063.8,'逐卖出事件更正不叠加扣税');
  console.log('cash income actual: ownership, precision, replacement, nested idempotence, revocation and evidence recovery passed');
}finally{await cleanup();}})();
  })();

  // --- [3] cash-income-bond-interest.test.js ---
  await (async () => {
const assert=require('assert');
const {pool}=require('../db/connection');
const {parseDividend}=require('../services/cashDividendFacts');
const {calculateBondInterest,settleCashIncome,holdingAt}=require('../services/cashIncome');
const NavMath=require('../../public/shared/nav-math');
const identity={canonical_code:'110998.SH',asset_class:'convertible_bond',market:'CN'};
const text='债券代码：110998 债权登记日：2026年9月3日；付息日：2026年9月4日；每10张本期债券（面值1000元）派发利息为人民币18.00元（含税）。个人投资者税率20%。';
const fact=parseDividend(text,identity);
const variant='转债代码：110998；付息债权登记日：2026年9月3日；可转债兑息日：2026年9月4日；每张面值100元人民币可转债派息金额为人民币1.80元（含税）。';
assert.strictEqual(parseDividend(variant,identity).amount,1.8);
assert.strictEqual(parseDividend(variant,identity).payDate,'2026-09-04');
const interestNotices = [
  {
    code: '110085',
    dates: '债权登记日：2026年2月13日；兑息日：2026年2月24日；',
    terms: '面利率为1.50%（含税），即每张面值100 元可转债兑息金额为1.50 元（含税）。',
    amount: 1.5,
  },
  {
    code: '118020',
    dates: '债权登记日：2026年9月22日；兑息日：2026年9月23日；',
    terms: '每张面值100 元人民币\n可转债兑息金额为2.60 元人民币（含税）。',
    amount: 2.6,
  },
];
for (const {code, dates, terms, amount} of interestNotices) {
  const bond = {...identity, canonical_code: `${code}.SH`};
  const notice = `转债代码：${code}；${dates}${terms}`;
  assert.strictEqual(parseDividend(notice,bond).amount,amount);
  assert.strictEqual(parseDividend(notice+'每张兑息金额为99元（含税）。',bond).reason,'incomplete_bond_interest_terms');
}
const other='债券代码：110998；一、本期债券基本情况1.发行人：测试公司2.债券名称：另一债券3.债券代码：102583523二、付息办法';
assert.strictEqual(parseDividend(other,identity).classification,'excluded_other_bond_interest');
assert.strictEqual(parseDividend(other.replace('102583523二','102583523\n5.发行总额：5亿元\n二'),identity).classification,'excluded_other_bond_interest');
assert.strictEqual(parseDividend('债券代码：110998123',identity).reason,'document_security_not_verified');
assert.strictEqual(parseDividend('债券代码：110998；债券代码：110997；'+variant,identity).reason,'document_security_not_verified');
assert.strictEqual(fact.amount,1.8);
assert.strictEqual(fact.recordDate,'2026-09-03');
assert.strictEqual(fact.payDate,'2026-09-04');
assert.strictEqual(parseDividend(text.replace('110998','110997'),identity).reason,'document_security_not_verified');
assert.strictEqual(parseDividend(text.replace('（含税）','（税后）'),identity).reason,'incomplete_bond_interest_terms');
assert.strictEqual(parseDividend(text.replace('债权登记日：2026年9月3日；',''),identity).reason,'incomplete_bond_interest_terms');
assert.strictEqual(parseDividend(text+'每10张派发利息为10元（含税）。',identity).reason,'incomplete_bond_interest_terms');
const action={record_date:fact.recordDate,pay_date:fact.payDate,cash_per_share_pre_tax:fact.amount,currency_code:'CNY',raw_payload:{...fact,documentId:123}};
assert.deepStrictEqual(calculateBondInterest(action,{quantity:200}),{grossPerBond:1.8,gross:360,taxRate:0.2,tax:72,net:288});
assert.strictEqual(calculateBondInterest({...action,raw_payload:{}},{quantity:200}).reason,'incomplete_bond_interest_terms');
const trades=[{id:'open',code:'110998.SH',direction:'open',trade_date:'2026-09-01',quantity:200},{id:'sell',code:'110998.SH',direction:'sell',trade_date:'2026-09-03',quantity:50}];
assert.strictEqual(calculateBondInterest(action,holdingAt(trades,identity.canonical_code,fact.recordDate,[{code:identity.canonical_code,quantity:150}])).net,216);
const U='bond_interest_test',A='转债付息回归',ID='bond_interest_test_account';
async function cleanup(){
  for(const table of ['positions','trades','nav_history','cash_flows','nav_position_snapshots','account_data','accounts'])await pool.query(`DELETE FROM ${table} WHERE username=$1`,[U]);
  await pool.query('DELETE FROM users WHERE username=$1',[U]);
  await pool.query("DELETE FROM fundamental.corporate_actions WHERE source_key='bond_interest_test'");
  await pool.query("DELETE FROM core.instruments WHERE canonical_code='110998.SH'");
}
return (async () =>{
  try{
    await cleanup();
    const instrument=(await pool.query("INSERT INTO core.instruments(canonical_code,name,asset_class,market,exchange_code,currency_code) VALUES('110998.SH','回归转债','convertible_bond','CN','SSE','CNY') RETURNING instrument_id")).rows[0].instrument_id;
    await pool.query("INSERT INTO users(username,password,accounts,status,auth_version) VALUES($1,'x',$2,'active',1)",[U,JSON.stringify([A])]);
    await pool.query("INSERT INTO accounts(id,username,account_name,cash_base,hk_rate,cash_income_policy) VALUES($1,$2,$3,0,1,$4)",[ID,U,A,{dividendScopeExclusions:[{code:identity.canonical_code,confirmedBy:U,reason:'旧股票分红范围排除',outsideStockDividendScope:true}]}]);
    await pool.query("INSERT INTO account_data(username,account_name,data,version) VALUES($1,$2,'{}',0)",[U,A]);
    await pool.query("INSERT INTO nav_history(username,account_name,account_id,date,nav,total_asset,invested,cash_cny,snapshot_source,is_locked,source_priority) VALUES($1,$2,$3,'2026-09-01',1,20000,20000,0,'imported',true,100)",[U,A,ID]);
    await pool.query("INSERT INTO positions(id,username,account_name,code,instrument_id,quantity,type,subtype) VALUES('bond_position',$1,$2,$3,$4,200,'债权','可转债')",[U,A,identity.canonical_code,instrument]);
    await pool.query("INSERT INTO trades(id,username,account_name,date,trade_date,direction,code,quantity,amount) VALUES('bond_open',$1,$2,'2026-09-01','2026-09-01','open',$3,200,0)",[U,A,identity.canonical_code]);
    const source=(await pool.query('SELECT source_id FROM ops.data_sources ORDER BY source_id LIMIT 1')).rows[0].source_id;
    await pool.query("INSERT INTO fundamental.corporate_actions(instrument_id,action_type,record_date,pay_date,status,cash_per_share_pre_tax,currency_code,source_id,source_key,raw_payload) VALUES($1,'dividend',$2,$3,'实施',1.8,'CNY',$4,'bond_interest_test',$5)",[instrument,fact.recordDate,fact.payDate,source,action.raw_payload]);
    await settleCashIncome(U,A,{targetDate:'2026-09-03',enable:true});
    assert((await require('../services/cashDividendFacts').cohort()).some(i=>String(i.instrument_id)===String(instrument)&&i.asset_class==='convertible_bond'),'原公告采集范围必须纳入已启用账户的可转债');
    assert.strictEqual((await pool.query("SELECT count(*)::int n FROM cash_flows WHERE username=$1 AND flow_type='dividend'",[U])).rows[0].n,0,'付息日前不入账');
    await settleCashIncome(U,A,{targetDate:'2026-09-04'});
    let flows=(await pool.query("SELECT *,date::text FROM cash_flows WHERE username=$1 AND flow_type='dividend'",[U])).rows;
    assert.strictEqual(flows.length,1);assert.strictEqual(Number(flows[0].amount),288);
    assert.strictEqual(flows[0].evidence.tax,72);assert.strictEqual(flows[0].evidence.incomeKind,'bond_interest');
    assert.strictEqual(NavMath.isEffectiveFlow(flows[0]),true);
    assert.strictEqual((await pool.query("SELECT count(*)::int n FROM cash_flows WHERE username=$1 AND flow_type='dividend_tax'",[U])).rows[0].n,0,'不再套用股票递延税');
    assert.strictEqual((await settleCashIncome(U,A,{targetDate:'2026-09-04'})).changed,0,'重复计算不叠加');
    const data=await require('../db/accounts').loadAccountData(U,A);
    assert.strictEqual(data.cash,288,'税后利息进入持仓现金');
    assert.strictEqual(NavMath.investedAt(data.navHistory,data.cashFlows,data.cashBase,'2026-09-04'),20000,'利息不计作新增投入本金');
    await require('../services/cashIncomeActual').importActual(U,A,[{date:'2026-09-04',flow_type:'dividend',amountCny:'287.99',eventKey:flows[0].event_key,sourceRef:'test_bond_receipt'}],data.version);
    assert.strictEqual((await pool.query("SELECT evidence FROM cash_flows WHERE username=$1 AND flow_type='dividend'",[U])).rows[0].evidence.incomeKind,'bond_interest','实收替换保留转债利息身份');
    await settleCashIncome(U,A,{targetDate:'2026-09-04'});
    assert.strictEqual(Number((await pool.query("SELECT amount FROM cash_flows WHERE username=$1 AND flow_type='dividend'",[U])).rows[0].amount),287.99,'券商实收优先且不再扣税');
    console.log('可转债付息：公告、登记日资格、20%税、现金本金隔离、幂等和实收保护通过');
  }finally{await cleanup();}
})();
  })();

  // --- [4] cash-income-identity.test.js ---
  await (async () => {
delete require.cache[require.resolve('../services/securityIdentity')];
delete require.cache[require.resolve('../services/cashFlowIdentity')];
const assert = require('assert');
const { pool } = require('../db/connection');
const { identityReference, attachCashFlowIdentity } = require('../services/cashFlowIdentity');

async function main() {
  assert.deepStrictEqual(identityReference({flow_type:'dividend',instrument_id:'1'}), {instrumentId:'1'});
  assert.deepStrictEqual(identityReference({flow_type:'dividend_tax',event_key:'dividend:1:2026-01-01:2026-01-02:tax:sale'}), {instrumentId:'1'});
  assert.strictEqual(identityReference({flow_type:'dividend',instrument_id:'2',event_key:'dividend:1:2026-01-01'}), null);
  assert.strictEqual(identityReference({flow_type:'external_transfer',instrument_id:'1'}), null);
  assert.strictEqual(identityReference({flow_type:'repo_fee',event_key:'repo:204001.SH:2026-01-01:unexpected'}), null);
  assert.deepStrictEqual(identityReference({flow_type:'repo_interest',event_key:'repo:131810.SZ:2026-01-01'}), {canonicalCode:'131810.SZ'});
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 测试库可能来自较早快照，所需三种身份在隔离事务内补齐，结束即回滚。
    await client.query(`INSERT INTO core.instruments(canonical_code,name,market,exchange_code,currency_code,asset_class)
      VALUES ('204001.SH','GC001','CN','SSE','CNY','repo'),
             ('000001.SZ','平安银行','CN','SZSE','CNY','stock'),
             ('00941.HK','中国移动','HK','HKEX','HKD','stock')
      ON CONFLICT(canonical_code) DO NOTHING`);
    const identities = (await client.query("SELECT instrument_id,canonical_code,name FROM core.instruments WHERE canonical_code IN ('204001.SH','000001.SZ','00941.HK')")).rows;
    assert.strictEqual(identities.length,3,'测试主档须覆盖回购、A股与港股');
    const order = ['204001.SH','000001.SZ','00941.HK'];
    identities.sort((a,b)=>order.indexOf(a.canonical_code)-order.indexOf(b.canonical_code));
    const flows = identities.flatMap(i => i.canonical_code==='204001.SH'
      ? ['repo_interest','repo_fee'].map(flow_type=>({flow_type,event_key:'repo:204001.SH:2026-01-01',amount:10}))
      : ['dividend','dividend_tax'].map(flow_type=>({flow_type,event_key:`dividend:${i.instrument_id}:2026-01-01:2026-01-02`,amount:10})));
    flows.push({flow_type:'dividend',instrument_id:'9007199254740991',amount:10});
    await attachCashFlowIdentity(flows,client.query.bind(client));
    assert.deepStrictEqual(flows.map(f=>f.code),['204001','204001','000001','000001','00941','00941',undefined]);
    for (const flow of flows.slice(0,-1)) assert.ok(identities.some(i=>i.name===flow.name));
    assert.ok(flows.every(f=>f.amount===10),'展示装载不得修改金额');
    await client.query('ROLLBACK');
  } finally { client.release(); }
  console.log('cash-income identity: reference guards and PostgreSQL master mapping passed');
}
return main();
  })();

  // --- [5] cash-income-migration.test.js ---
  await (async () => {
// 真实 PG 隔离 schema：异常日期不能被迁移静默修正，失败必须整体回滚。
const assert = require('assert');
const { pool } = require('../db/connection');
const { migrateCashFlowDatePrecision } = require('../db/cashIncomeMigration');
return (async () =>{
  const client=await pool.connect();
  const schema='cash_income_migration_test';
  const adapter={connect:async()=>({query:client.query.bind(client),release(){}})};
  try {
    // 上一次运行被中断时隔离 schema 会残留，导致下一次 CREATE SCHEMA 直接失败；
    // 这里先无条件清理，保证用例可重复执行（只影响本用例独占的 schema）。
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await client.query("CREATE TABLE cash_flows(id text,username text,account_name text,date text DEFAULT '',amount numeric(20,2))");
    await client.query("INSERT INTO cash_flows VALUES('bad','u','a','2026-02-30',12.34)");
    await assert.rejects(()=>migrateCashFlowDatePrecision(adapter),/无效日期/);
    assert.strictEqual((await client.query('SELECT date FROM cash_flows')).rows[0].date,'2026-02-30');
    assert.strictEqual((await client.query('SELECT data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name=$3',[schema,'cash_flows','date'])).rows[0].data_type,'text');
    await client.query("UPDATE cash_flows SET date='2026-02-28'");
    await migrateCashFlowDatePrecision(adapter);
    assert.deepStrictEqual((await client.query('SELECT date::text,amount::text FROM cash_flows')).rows[0],{date:'2026-02-28',amount:'12.340000'});
    await migrateCashFlowDatePrecision(adapter);
    assert.strictEqual((await client.query('SELECT count(*)::int AS n FROM cash_flows')).rows[0].n,1);
    console.log('cash income migration: invalid dates rollback, precision and idempotence passed');
  } finally { await client.query('SET search_path TO public'); await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); client.release();  }
})();
  })();

  // --- [6] cash-income-queue.test.js ---
  await (async () => {
const assert=require('assert');require('dotenv').config();delete process.env.DATABASE_URL;process.env.PGDATABASE=process.env.PGTESTDATABASE||'portfolio_test';
const {pool}=require('../db/connection'),queue=require('../services/cashIncomeQueue');
const {resolveDatasetScope,areJobDatasetsPublished}=require('../services/datasetPartitionRegistry');
const U='cash_queue_test',A='分批:账户',ID='cash_queue_test_id',targetDate='2026-07-09',context={username:U,accountName:A,targetDate,enabled:true,mode:'cash_income'};
async function cleanup(){await pool.query("DELETE FROM job_runs WHERE slot_id IN (SELECT slot_id FROM ops.job_schedule_slots WHERE request_payload->>'username'=$1)",[U]);await pool.query("DELETE FROM ops.job_schedule_slots WHERE request_payload->>'username'=$1",[U]);await pool.query('DELETE FROM ops.dataset_partitions WHERE scope_key=$1',[resolveDatasetScope('account_cash_income',context)]);await pool.query('DELETE FROM accounts WHERE username=$1',[U]);for(const t of ['nav_history','account_data'])await pool.query(`DELETE FROM ${t} WHERE username=$1`,[U]);await pool.query('DELETE FROM users WHERE username=$1',[U]);}
return (async () =>{try{
await cleanup();assert.strictEqual(resolveDatasetScope('account_cash_income',{}),null);assert.strictEqual(resolveDatasetScope('account_cash_income',context),'account:cash_queue_test:%E5%88%86%E6%89%B9%3A%E8%B4%A6%E6%88%B7');
await assert.rejects(()=>queue.enqueue(U,A,{targetDate:'2026-02-30',version:0}),/目标日/);
await pool.query("INSERT INTO users(username,password,accounts,status,auth_version) VALUES($1,'x',$2,'active',1)",[U,JSON.stringify([A])]);
await pool.query('INSERT INTO accounts(id,username,account_name,cash_base,hk_rate) VALUES($1,$2,$3,0,1)',[ID,U,A]);await pool.query("INSERT INTO account_data(username,account_name,data,version) VALUES($1,$2,'{}',0)",[U,A]);
await pool.query(`INSERT INTO nav_history(username,account_name,account_id,date,nav,total_asset,invested,cash_cny,market_value_cny,system_market_value_at_snapshot,snapshot_source,is_locked,source_priority) VALUES($1,$2,$3,'2026-05-01',1,100000,100000,100000,0,0,'imported',true,100)`,[U,A,ID]);
const queued=await queue.enqueue(U,A,{targetDate,enabled:true,version:0}),duplicate=await queue.enqueue(U,A,{targetDate,enabled:true,version:0});assert.strictEqual(queued.slotId,duplicate.slotId);
assert.strictEqual((await pool.query('SELECT business_date::text FROM ops.job_schedule_slots WHERE slot_id=$1',[queued.slotId])).rows[0].business_date,targetDate);
const slot=(await pool.query('SELECT *,business_date::text FROM ops.job_schedule_slots WHERE slot_id=$1',[queued.slotId])).rows[0];
const execution=await require('../services/jobOrchestrator').runSlot(slot,'manual-cash-income-test');const first=execution.result||execution;assert(first.continuationRequired,JSON.stringify(execution));assert.strictEqual(first.stageComplete,false);assert(first.remainingCount>0);
assert.strictEqual(await areJobDatasetsPublished('nav_snapshot',targetDate,['account_cash_income'],context),false,'第一批不能发布最终分区');
const state=(await pool.query('SELECT cash_income_state FROM accounts WHERE id=$1',[ID])).rows[0].cash_income_state;assert.strictEqual(state.recalculation.processedThrough,'2026-05-31');assert(state.recalculation.nextAttemptAt);
const second=await queue.run(context);assert(second.continuationRequired);assert(second.remainingCount<first.remainingCount);
const final=await queue.run(context);assert(final.ok);assert(final.stageComplete);assert.strictEqual(await areJobDatasetsPublished('nav_snapshot',targetDate,['account_cash_income'],context),true);
assert.strictEqual(await areJobDatasetsPublished('nav_snapshot',targetDate,['account_cash_income'],{...context,accountName:'其他账户'}),false,'其他账户不能复用成功分区');
assert.strictEqual((await queue.run(context)).changed,0,'重跑不得重复入账');
console.log('cash income queue: atomic slot dedupe, target date, persisted batches, remaining progress and account partition isolation passed');
}finally{await cleanup();}})();
  })();

  // --- [7] cash-dividend-reprocess-contract.test.js ---
  await (async () => {
// 只重解析已登记的单份官方公告，不碰全局分区或覆盖游标。
const assert=require('assert');
const {reprocessKnownDividendDocument}=require('../services/cashDividendFacts');
const {pool}=require('../db/connection');
return (async () =>{let instrumentId,documentId,sourceId;const url='https://sse.com.cn/disclosure/cash-reprocess-fixture-699990.pdf';try{
 const identity={code:'601766',canonical_code:'601766.SH',instrument_id:'15',asset_class:'stock',market:'CN',exchange_code:'SSE'};
 const doc={document_id:'42',title:'中国中车2026年半年度权益分派实施公告',url:'https://big5.sse.com.cn/disclosure/601766.pdf',announced_at:'2026-10-09',source_id:14,source_code:'sse',raw_payload:{SECURITY_CODE:'601766'}};
 let stored=0;const deps={cohort:async()=>[identity],findDocument:async()=>({rows:[doc]}),storeDocument:async(i,a,s)=>{stored++;assert.strictEqual(i.instrument_id,'15');assert.strictEqual(a.url,doc.url);assert.strictEqual(s,14);return{ok:true};}};
 assert.deepStrictEqual(await reprocessKnownDividendDocument({documentId:42,code:'601766'},deps),{ok:true});assert.strictEqual(stored,1);
 const wrong=async patch=>{await assert.rejects(()=>reprocessKnownDividendDocument({documentId:42,code:'601766'},{...deps,findDocument:async()=>({rows:[{...doc,...patch}]})}));};
 await wrong({source_code:'tushare'});await wrong({url:'https://sse.com.cn.attacker.invalid/601766.pdf'});await wrong({raw_payload:{SECURITY_CODE:'601995'}});await wrong({title:'中国中车普通公告'});await wrong({announced_at:'2099-01-01'});
 await assert.rejects(()=>reprocessKnownDividendDocument({documentId:42,code:'601766'},{...deps,cohort:async()=>[]}));assert.strictEqual(stored,1);
 const db=(await pool.query('SELECT current_database() AS name')).rows[0].name;assert(/test/.test(db));
 sourceId=(await pool.query("SELECT source_id FROM ops.data_sources WHERE source_code='sse'")).rows[0].source_id;
 instrumentId=(await pool.query(`INSERT INTO core.instruments(canonical_code,name,asset_class,market,exchange_code,status) VALUES('699990.SH','定向公告测试','stock','CN','SSE','listed') RETURNING instrument_id`)).rows[0].instrument_id;
 documentId=(await pool.query(`INSERT INTO event.documents(document_type,title,announced_at,url,source_id,raw_payload) VALUES('announcement','定向公告测试权益分派实施公告','2026-10-09',$1,$2,'{"SECURITY_CODE":"699990"}') RETURNING document_id`,[url,sourceId])).rows[0].document_id;
 const bridge=require('../services/arbitrageDocumentSource'),old=bridge.runPythonExtraction;let extractions=0;
 bridge.runPythonExtraction=async()=>{extractions++;return{text:'证券代码：699990\n股份类别 股权登记日 除权（息）日 现金红利发放日 A股 2026/10/14 2026/10/15 2026/10/15\n每股派发现金红利0.11元（含税）\n个人股东和证券投资基金根据财税〔2015〕101号规定，公司派发股息红利时暂不扣缴个人所得税'};};
 try{
  const before=(await pool.query("SELECT count(*)::int AS n FROM ops.dataset_partitions WHERE dataset_code='stock_cash_dividend_facts'")).rows[0].n;
  const fixture={...identity,code:'699990',canonical_code:'699990.SH',instrument_id:instrumentId};
  const apply=()=>reprocessKnownDividendDocument({documentId,code:'699990'},{cohort:async()=>[fixture]});
  const first=await apply();assert.strictEqual(first.ok,true,JSON.stringify(first));
  const action=(await pool.query(`SELECT cash_per_share_pre_tax::float8 AS amount,raw_payload FROM fundamental.corporate_actions WHERE instrument_id=$1 AND source_key=$2`,[instrumentId,url])).rows[0];
  assert.strictEqual(action.amount,0.11);assert(action.raw_payload.documentId);assert(action.raw_payload.taxTreatment,'公告税务条款必须随事实保存');
  assert.strictEqual((await apply()).ok,true);assert.strictEqual(extractions,1,'重复解析必须复用已通过的官方事实');
  assert.strictEqual((await pool.query("SELECT count(*)::int AS n FROM ops.dataset_partitions WHERE dataset_code='stock_cash_dividend_facts'")).rows[0].n,before,'局部重解析不得修改全局分区');
 }finally{bridge.runPythonExtraction=old;}
 console.log('CASH-DIVIDEND-REPROCESS-001: source, identity, URL, date and target isolation passed');
}finally{if(instrumentId)await pool.query('DELETE FROM fundamental.corporate_actions WHERE instrument_id=$1',[instrumentId]).catch(()=>{});if(sourceId)await pool.query('DELETE FROM event.documents WHERE source_id=$1 AND url=$2',[sourceId,url]).catch(()=>{});if(sourceId)await pool.query('DELETE FROM ops.raw_records WHERE source_id=$1 AND source_key=$2',[sourceId,url]).catch(()=>{});if(instrumentId)await pool.query('DELETE FROM core.instruments WHERE instrument_id=$1',[instrumentId]).catch(()=>{});}})();
  })();

  await require('../db/connection').pool.end().catch(() => {});
})().catch(e => { console.error(e && e.stack ? e.stack : e); process.exitCode = 1; });

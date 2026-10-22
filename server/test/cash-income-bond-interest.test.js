const assert=require('assert');
const {pool}=require('../db/connection');
const {parseDividend}=require('../services/cashDividendFacts');
const {calculateBondInterest,settleCashIncome,holdingAt}=require('../services/cashIncome');
const NavMath=require('../../public/shared/nav-math');
const identity={canonical_code:'110998.SH',asset_class:'convertible_bond',market:'CN'};
const text='债券代码：110998 债权登记日：2026年9月3日；付息日：2026年9月4日；每10张本期债券（面值1000元）派发利息为人民币18.00元（含税）。个人投资者税率20%。';
const fact=parseDividend(text,identity);
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
(async()=>{
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
  }finally{await cleanup();await pool.end();}
})().catch(e=>{console.error(e);process.exitCode=1;});

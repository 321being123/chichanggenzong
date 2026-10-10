const assert=require('assert');
const {calculateRepo,calendarFor,holdingAt}=require('../services/cashIncome');
const M=require('../../public/shared/nav-math');
const anchor={date:'2026-09-09',cashCny:100000,snapshotSource:'imported',isLocked:true,invested:100000};
const input={cashBase:0,cashFlows:[],trades:[],navHistory:[anchor]};
const calendar=calendarFor({'2026':[]});
const result=calculateRepo(input,anchor,'2026-09-14',calendar);
assert.strictEqual(result.trades[0].tradeDate,'2026-09-10');
assert.strictEqual(result.trades[0].interestDays,3);
assert.strictEqual(result.trades[0].availableDate,'2026-09-11');
assert.strictEqual(result.trades[0].interestEndExclusive,'2026-09-14');
assert.strictEqual(result.trades[0].principal,99000); // 整千本金之外须留出费用，不能透支。
assert.strictEqual(result.trades[0].gross,10.58);
assert.strictEqual(result.trades[0].fee,0.10);
assert.deepStrictEqual(result.trades.map(r=>r.tradeDate),['2026-09-10','2026-09-11','2026-09-14']);
assert.strictEqual(result.flows.filter(f=>f.flow_type==='repo_interest').length,2); // 下一日未到账不入账
assert.strictEqual(M.investedAt([anchor],result.flows,0,'2026-09-14'),100000);
const noFuture=calculateRepo({...input,cashFlows:[{date:'2026-09-10',amount:2000}]}, {...anchor,cashCny:0},'2026-09-11',calendar);
// 日终入金不能提前投入；这里覆盖现金基准与真实数据不一致的情况，重新使用零基准。
const zero={...input,navHistory:[{...anchor,cashCny:0}],cashFlows:[{date:'2026-09-10',amount:2000}]};
const funded=calculateRepo(zero,zero.navHistory[0],'2026-09-11',calendar);
assert.deepStrictEqual(funded.trades.map(r=>r.tradeDate),['2026-09-11']);
const holiday=calculateRepo(input,anchor,'2026-09-10',calendarFor({'2026':['2026-09-11']}));
assert.strictEqual(holiday.trades[0].availableDate,'2026-09-14');
assert.strictEqual(holiday.trades[0].interestDays,1);
assert.throws(()=>calendarFor({})('2026-09-10'),/缺少/);
const trades=[{id:'1',code:'x',direction:'open',date:'2026-09-01',quantity:1000},
  {id:'2',code:'x',direction:'sell',date:'2026-09-08',quantity:400}];
assert.strictEqual(holdingAt(trades,'x','2026-09-07',[{code:'x',quantity:600}]).quantity,1000);
assert.strictEqual(holdingAt(trades,'x','2026-09-09',[{code:'x',quantity:600}]).quantity,600);
assert.strictEqual(holdingAt(trades,'x','2026-09-07',[{code:'x',quantity:500}]).reason,'position_history_does_not_reconcile');
assert.strictEqual(holdingAt([], 'x','2026-09-07',[]).reason,'missing_position_history');
const authorized={date:'2026-09-10',amount:100,flow_type:'dividend',status:'estimated',quality_status:'authorized_dividend_calculation',evidence:{authorizedPolicy:'cash-income-v1'}};
const hkFuture={...authorized,date:'2026-09-11',amount:5000};
const delayed=calculateRepo(input,anchor,'2026-09-14',calendar,[hkFuture]);
assert.strictEqual(delayed.trades[0].principal,result.trades[0].principal,'港股T+3到账前不提前投入回购');
assert.strictEqual(delayed.trades[1].principal,result.trades[1].principal,'港股到账日仍按前日现金投入');
assert(delayed.trades[2].principal>result.trades[2].principal,'港股到账后的下一交易日参与回购');
assert.strictEqual(M.cashAt({...input,cashFlows:[authorized]},'2026-09-10').cashEstimatedDelta,100);
assert.strictEqual(M.isEffectiveFlow({...authorized,evidence:{}}),false);
const octoberAnchor={...anchor,date:'2026-10-09'},octoberInput={...input,navHistory:[octoberAnchor]};
const missing=calculateRepo(octoberInput,octoberAnchor,'2026-10-14',calendar);
assert.strictEqual(missing.pending[0].date,'2026-10-12');assert.strictEqual(missing.processedThrough,'2026-10-11');assert.strictEqual(missing.trades.length,0);
const market=calculateRepo(octoberInput,octoberAnchor,'2026-10-12',calendar,[],{rates:{'2026-10-12':{annualRate:0.01,rawRecordId:1}}});
assert.strictEqual(market.trades[0].annualRate,0.01);assert.strictEqual(market.flows[0].status,'estimated');
for(const status of ['rejected','pending_evidence']){
  const blocked=calculateRepo(octoberInput,octoberAnchor,'2026-10-12',calendar,[],{rates:{'2026-10-12':{annualRate:0.01}},sourceAdmission:{status}});
  assert.strictEqual(blocked.trades.length,0,'未准入即使字段存在也不能使用市场利率');assert.strictEqual(blocked.pending[0].reason,'repo_source_admission_pending');
}
assert.strictEqual(calculateRepo(octoberInput,octoberAnchor,'2026-10-12',calendar,[],{rates:{'2026-10-12':{annualRate:0.01}},sourceAdmission:{status:'admitted'}}).trades.length,1);
const excludedRepo=calculateRepo(input,anchor,'2026-09-10',calendar,[],{excludedEvents:['repo:204001.SH:2026-09-10']});assert.strictEqual(excludedRepo.trades.length,0);
console.log('cash income calculation: settlement weekends/holidays, next-day funds, no future credit, eligibility and estimate authorization passed');
require('../db/connection').pool.end();

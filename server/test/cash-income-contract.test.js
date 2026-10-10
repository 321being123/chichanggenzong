const assert = require('assert');
const { spawnSync } = require('child_process');
const M = require('../../public/shared/nav-math');

function pure() {
  const anchor = { date:'2026-10-01',snapshotSource:'imported',isLocked:true,cashCny:1000,invested:2000 };
  const future = { ...anchor,date:'2026-11-01',cashCny:99999,invested:99999 };
  const flows = [
    {date:'2026-10-01',amount:100}, // 同日已吸收
    {date:'2026-10-02',amount:200}, // 旧行兼容外部资金
    {date:'2026-10-02',amount:10,flow_type:'dividend'},
    {date:'2026-10-02',amount:-2,flow_type:'dividend_tax'},
    {date:'2026-10-02',amount:3,flow_type:'repo_interest',status:'estimated'},
    {date:'2026-10-02',amount:-0.1,flow_type:'repo_fee',status:'estimated'},
    {date:'2026-10-02',amount:888,flow_type:'dividend',status:'estimated'},
    {date:'2026-10-02',amount:999,flow_type:'repo_interest',status:'revoked'},
    {date:'2026-12-01',amount:90000}
  ];
  const data = { cashBase:100,navHistory:[future,anchor],cashFlows:flows,trades:[
    {date:'2026-10-02',direction:'buy',amount:100,commission:1,created_at:'2026-10-10 09:00:00'},
    {date:'2026-10-02',direction:'open',amount:888},
    {date:'2026-10-02',direction:'adjust',amount:888},
    {date:'2026-11-02',direction:'sell',amount:888}
  ]};
  const state = M.cashAt(data,'2026-10-02');
  assert.strictEqual(state.value,1109.9);
  assert.strictEqual(state.cashConfirmed,1107);
  assert.strictEqual(state.cashEstimatedDelta,2.9);
  assert.strictEqual(state.cashIncludesEstimates,true);
  assert.strictEqual(state.incomplete,false);
  assert.strictEqual(M.investedAt(data.navHistory,flows,100,'2026-10-02'),2200);
  assert.strictEqual(M.investedAt(data.navHistory,flows,100,'2026-09-30'),100);
  assert.strictEqual(M.investedAt([],flows,100,'2026-10-02'),400);
  assert.strictEqual(M.cashAt({cashBase:1,navHistory:[{...anchor,cashCny:null}]},'2026-10-02').value,1);
  assert.strictEqual(M.cashAt({cashFlows:[{date:'2026-10-01',amount:0.1},{date:'2026-10-01',amount:0.2}]},'2026-10-02').value,0.3);
  assert.strictEqual(M.cashAt({...data,navHistory:[{...anchor,date:'2026-10-03'}]},'2026-10-02').anchor,null);
  assert.strictEqual(M.cashAt({...data,trades:[{date:'2026-10-02',direction:'buy',quote_currency:'HKD',amount:100}]},'2026-10-02').incomplete,true);
  assert.strictEqual(M.cashAt({...data,cashFlows:[{date:'2026-10-02',amount:1,flow_type:'unknown'}]},'2026-10-02').incomplete,true);
  assert.strictEqual(M.isExternalTransfer({flow_type:'unknown'}),false);
  assert.throws(()=>M.cashAt(data,'2026-02-30'));
  const timed = {cashBase:0,cashFlows:[{date:'2026-10-02',amount:10,created_at:'2026-10-09 09:00:00'},
    {date:'2026-10-02',amount:20,settled_at:'2026-10-02T18:00:00+08:00'}]};
  assert.strictEqual(M.cashAt(timed,'2026-10-02','2026-10-02T17:00:00+08:00').value,10,'补录创建时间不影响历史生效日，真实到账时刻仍受截止保护');
}
if (process.argv.includes('--tz-child')) { pure(); process.exit(0); }
pure();
for (const TZ of ['UTC','Asia/Shanghai','America/New_York']) {
  const r = spawnSync(process.execPath,[__filename,'--tz-child'],{env:{...process.env,TZ},encoding:'utf8'});
  assert.strictEqual(r.status,0,r.stderr);
}
console.log('cash income contract: dates, origins, precision, capital and estimates passed in 3 timezones');

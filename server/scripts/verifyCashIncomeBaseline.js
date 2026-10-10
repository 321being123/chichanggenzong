const fs = require('fs');
const path = require('path');
const M = require('../../public/shared/nav-math');
const { pool } = require('../db/connection');
const { loadAccountData,loadAccountSummary } = require('../db/accounts');
const { recomputeCash } = require('../services/tradeLedger');

function oldCash(data,date,anchored) {
  const navs=data.navHistory.filter(n=>n.snapshotSource==='imported' && n.isLocked!==false && n.date<=date &&
    Number.isFinite(Number(n.cashCny)) && Number(n.cashCny)>=0).sort((a,b)=>a.date.localeCompare(b.date));
  const anchor=anchored && navs.length ? navs[navs.length-1] : null;
  let value=anchor ? Number(anchor.cashCny) : Number(data.cashBase)||0;
  for(const f of data.cashFlows) if(f.date<=date && (!anchor || f.date>anchor.date)) value+=Number(f.amount)||0;
  for(const t of data.trades) {
    const d=String(t.trade_date||t.date).slice(0,10);
    if(d>date || (anchor && d<=anchor.date) || ['open','adjust'].includes(t.direction)) continue;
    const amount=t.amount_cny != null ? Number(t.amount_cny) : (String(t.quote_currency)==='HKD' ? null : Number(t.amount)||0);
    if(amount==null) continue;
    const fee=['commission','stamp_tax','transfer_fee','other_fee'].reduce((s,k)=>s+(Number(t[k])||0),0);
    value+=(t.direction==='buy' ? -amount : amount)-fee;
  }
  return value;
}
async function verify() {
  const baseline=JSON.parse(fs.readFileSync(path.resolve('_probe/cash-income-p0-baseline.json'),'utf8'));
  const report={algorithm:'cash-income-p0-v1',accounts:baseline.accounts.length, dates:0, checks:0, unchanged:0, expectedCorrections:0, unknownDifferences:0, corrections:[], unknown:[]};
  function compare(a,date,entry,before,after,reason) {
    report.checks++;
    if(Math.abs(before-after)<0.000001) { report.unchanged++; return; }
    const row={account:a.account_name,date,entry,before,after,reason};
    if(reason) { report.expectedCorrections++;report.corrections.push(row); }
    else {report.unknownDifferences++;report.unknown.push(row);}
  }
  for(const a of baseline.accounts) {
    const data=await loadAccountData(a.username,a.account_name);
    const summary=await loadAccountSummary(a.username,a.account_name);
    const currentAnchor=M.selectCashAnchor(a.data.navHistory,baseline.targetDate);
    compare(a,baseline.targetDate,'full',a.current.full,data.cash,null);
    compare(a,baseline.targetDate,'summary',a.current.summary,summary.cash,currentAnchor ? 'summary_ignored_import_anchor' : null);
    compare(a,baseline.targetDate,'ledger',a.current.ledger,await recomputeCash(pool,a.username,a.account_name),currentAnchor ? 'ledger_ignored_import_anchor' : null);
    if(Math.abs(data.cash-summary.cash)>0.000001) throw new Error('摘要/完整账户现金不一致');
    // 对实际当前数据只读比对，日期迁移及新来源列不得改变原行金额/业务日。
    if(a.data.cashFlows.length!==data.cashFlows.length || a.data.cashFlows.some(f=>!data.cashFlows.some(r=>r.id===f.id && r.date===f.date && r.amount===f.amount))) throw new Error('原现金流水发生意外变化');
    for(const row of a.dates) {
      report.dates++;
      const date=row.date, state=M.cashAt(a.data,date), anchor=M.selectCashAnchor(a.data.navHistory,date);
      compare(a,date,'snapshot_and_attribution',oldCash(a.data,date,true),state.value,null);
      compare(a,date,'historical_replay',oldCash(a.data,date,false),state.value,anchor ? 'replay_ignored_import_anchor' : null);
      const invested=M.investedAt(a.data.navHistory,a.data.cashFlows,a.data.cashBase,date);
      const previous=a.data.navHistory.filter(n=>n.invested!=null && n.invested!=='' && n.date<=date).sort((a,b)=>a.date.localeCompare(b.date)).pop();
      const hasPostFlows=previous && a.data.cashFlows.some(f=>f.date>previous.date && f.date<=date && M.isExternalTransfer(f));
      compare(a,date,'invested',row.invested,invested,hasPostFlows ? 'historical_capital_ignored_post_anchor_transfers' : null);
    }
  }
  const output=path.resolve('_probe/cash-income-p0-verification.json');
  fs.writeFileSync(output,JSON.stringify(report,null,2));
  console.log(JSON.stringify({output,...Object.fromEntries(Object.entries(report).filter(([k])=>!['corrections','unknown'].includes(k)))}));
  if(report.unknownDifferences) throw new Error('存在未知现金/本金差异，禁止完成P0a');
}
if(require.main===module)verify().catch(e=>{console.error(e.message);process.exitCode=1}).finally(()=>pool.end());
module.exports={verify};

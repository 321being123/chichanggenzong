// 明确指定用户；沿用本地服务，不采集、不部署、不触碰其他用户。
const fs=require('fs');
const path=require('path');
const {pool}=require('../db/connection');
const {settleCashIncome}=require('../services/cashIncome');
const CoreDate=require('../../public/shared/core-date');
async function main(){
  const username=process.argv.find(a=>a.startsWith('--username='))?.slice(11);
  if(!username) throw new Error('必须提供 --username=账户所有者');
  const targetDate=process.argv.find(a=>a.startsWith('--target-date='))?.slice(14)||CoreDate.todayInZone('Asia/Shanghai');
  const accounts=(await pool.query(`SELECT DISTINCT a.account_name FROM accounts a JOIN nav_history n
    ON n.username=a.username AND n.account_name=a.account_name WHERE a.username=$1
    AND a.cash_income_policy->>'enabled'='true' AND n.snapshot_source='imported' AND n.is_locked AND n.cash_cny IS NOT NULL AND n.date<=$2`,[username,targetDate])).rows;
  const result=[];
  for(const account of accounts) result.push({accountName:account.account_name,...await settleCashIncome(username,account.account_name,{targetDate})});
  const destination=path.resolve('_probe/cash-income-calculation.json');
  fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,JSON.stringify(result,null,2));
  console.log(JSON.stringify(result.map(r=>({accountName:r.accountName,anchorDate:r.anchorDate,changed:r.changed,repoTrades:r.repoTrades,pending:r.pending?.length,status:r.status})),null,2));
}
main().catch(e=>{console.error(e.message);process.exitCode=1}).finally(()=>pool.end());

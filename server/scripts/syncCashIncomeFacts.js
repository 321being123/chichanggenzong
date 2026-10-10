const {pool}=require('../db/connection');
const option=name=>process.argv.find(a=>a.startsWith('--'+name+'='))?.split('=').slice(1).join('=');
async function main(){
  const targetDate=option('target-date')||require('../../public/shared/core-date').todayInZone('Asia/Shanghai');
  const result=await require('../services/jobRunners').runJobByCode('arbitrage_sync','manual-cash-dividend',targetDate,{mode:'cash_dividends',targetDate,targetCodes:option('codes')?.split(','),deadlineAt:Date.now()+180000});
  console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1;
}
main().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>pool.end());

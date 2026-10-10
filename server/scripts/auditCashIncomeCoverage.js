const fs = require('fs');
const path = require('path');
const { pool } = require('../db/connection');
const { auditCashIncomeCoverage } = require('../services/cashIncomeCoverage');

async function auditAll() {
  const accounts = (await pool.query('SELECT username,account_name FROM accounts ORDER BY username,account_name')).rows;
  const reports = [];
  for (const a of accounts) reports.push(await auditCashIncomeCoverage(a.username,a.account_name));
  const totals = reports.reduce((s,r)=>{
    for (const k of Object.keys(r.summary)) s[k]=(s[k]||0)+r.summary[k];
    return s;
  },{});
  const output = path.resolve('_probe/cash-income-coverage.json');
  fs.mkdirSync(path.dirname(output),{recursive:true});
  fs.writeFileSync(output,JSON.stringify({ generatedAt:new Date().toISOString(), reports, totals },null,2));
  console.log(JSON.stringify({output,accounts:reports.length, cashAnchors:reports.filter(r=>r.cashAnchorDate).length, ...totals}));
}
if (require.main === module) auditAll().catch(e=>{console.error(e.message);process.exitCode=1}).finally(()=>pool.end());
module.exports={auditAll};

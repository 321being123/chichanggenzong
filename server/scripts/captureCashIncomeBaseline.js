// P0a 只读基线：业务数据仅保存在本机 _probe，不进入 Git。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pool } = require('../db/connection');
const { loadAccountData, loadAccountSummary } = require('../db/accounts');
const { recomputeCash } = require('../services/tradeLedger');
const { investedAt } = require('../../public/shared/nav-math');
const CoreDate = require('../../public/shared/core-date');

async function capture() {
  const accounts = (await pool.query('SELECT username,account_name FROM accounts ORDER BY username,account_name')).rows;
  const report = { capturedAt: new Date().toISOString(), targetDate: CoreDate.todayInZone('Asia/Shanghai'), algorithm: 'legacy-before-cash-income-p0', accounts: [] };
  for (const a of accounts) {
    const data = await loadAccountData(a.username, a.account_name);
    const summary = await loadAccountSummary(a.username, a.account_name);
    const ledger = await recomputeCash(pool, a.username, a.account_name);
    const dates = new Set([report.targetDate]);
    for (const row of [...data.trades, ...data.cashFlows, ...data.navHistory]) {
      const date = CoreDate.normalizeBusinessDate(String(row.trade_date || row.date).slice(0, 10));
      if (date && date <= report.targetDate) dates.add(date);
    }
    for (const row of data.navHistory.filter(n => n.snapshotSource === 'imported')) {
      const date = CoreDate.normalizeBusinessDate(row.date);
      if (!date) continue;
      // 明确 UTC 日历运算：纯业务日相邻边界，无时区转换。
      for (const delta of [-1, 1]) {
        const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + delta);
        const key = d.toISOString().slice(0, 10);
        if (key <= report.targetDate) dates.add(key);
      }
    }
    report.accounts.push({ ...a, data, inputHash: crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex'),
      current: { full: data.cash, summary: summary.cash, ledger, invested: data.authoritativeInvested },
      dates: [...dates].sort().map(date => ({ date, invested: investedAt(data.navHistory, data.cashFlows, data.cashBase, date) })) });
  }
  const output = path.resolve('_probe/cash-income-p0-baseline.json');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  if (fs.existsSync(output)) throw new Error('基线已存在，禁止覆盖修改前证据');
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, accounts: report.accounts.length, dates: report.accounts.reduce((n,a)=>n+a.dates.length,0), currentDifferences: report.accounts.filter(a=>Math.abs(a.current.full-a.current.summary)>0.005).length }));
}
if (require.main === module) capture().catch(e => { console.error(e.message); process.exitCode = 1; }).finally(() => pool.end());
module.exports = { capture };

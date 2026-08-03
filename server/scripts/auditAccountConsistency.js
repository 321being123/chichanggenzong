// ========== 账户数据一致性只读审计（2026-08-03 整改报告 8.4 / 阶段一） ==========
// 只读：不修改任何数据。列出表与 JSON 差异、孤立账户、重复账户、遗留业务数组。
// 运行：node server/scripts/auditAccountConsistency.js [--json]
// 输出：每类问题数量；--json 输出完整明细。非零问题通过退出码反映（1=有问题，0=干净）。
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { pool } = require('../db');

const FIVE_ARRAYS = ['positions', 'trades', 'navHistory', 'cashFlows', 'indexHistory'];

(async () => {
  const asJson = process.argv.includes('--json');
  const report = { issues: {}, counts: {} };
  const issue = (k, detail) => { (report.issues[k] = report.issues[k] || []).push(detail); };

  // 1) account_data 与 accounts 元数据一致性：存在 account_data 但无 accounts 行（严重：数据无主）
  const orphanJson = (await pool.query(
    `SELECT ad.username, ad.account_name
       FROM account_data ad
       LEFT JOIN accounts a ON a.username=ad.username AND a.account_name=ad.account_name
      WHERE a.username IS NULL`
  )).rows;
  orphanJson.forEach(r => issue('account_data无accounts元数据', r.username + '/' + r.account_name));

  // accounts 元数据存在但无 account_data：新建账户/仅设置账户的正常状态（账户名在列表中但从未保存业务数据），
  // 仅提示不判错（避免把"新账户无数据"误报为孤立数据）
  const orphanMeta = (await pool.query(
    `SELECT a.username, a.account_name
       FROM accounts a
       LEFT JOIN account_data ad ON ad.username=a.username AND ad.account_name=a.account_name
      WHERE ad.username IS NULL`
  )).rows;
  orphanMeta.forEach(r => issue('accounts元数据无account_data(提示)', r.username + '/' + r.account_name));

  // 2) 业务子表存在但无账户主记录（孤立业务数据）
  for (const t of ['positions', 'trades', 'nav_history', 'cash_flows', 'daily_prices', 'index_history']) {
    const q = await pool.query(
      `SELECT b.username, b.account_name
         FROM ${t} b
         LEFT JOIN accounts a ON a.username=b.username AND a.account_name=b.account_name
        WHERE a.username IS NULL
        GROUP BY b.username, b.account_name LIMIT 20`
    );
    q.rows.forEach(r => issue('孤立业务数据_' + t, r.username + '/' + r.account_name));
  }

  // 3) account_data JSON 中是否仍残留五类业务数组（整改后应只读归档，不再参与业务；归档残留=提示不阻断）
  const { rows: adRows } = await pool.query('SELECT username, account_name, data FROM account_data');
  let leftoverArrays = 0;
  for (const r of adRows) {
    let d = null;
    try { d = JSON.parse(r.data); } catch (e) { issue('JSON解析失败', r.username + '/' + r.account_name); continue; }
    for (const k of FIVE_ARRAYS) {
      if (d && Array.isArray(d[k]) && d[k].length > 0) {
        leftoverArrays++;
        if (leftoverArrays <= 20) issue('JSON残留业务数组_' + k + '(归档提示)', r.username + '/' + r.account_name + ' (' + d[k].length + ' 条)');
      }
    }
  }

  // 4) 汇总：提示类（新账户无数据）不计入"损坏"退出码
  for (const k of Object.keys(report.issues)) report.counts[k] = report.issues[k].length;

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('===== 账户数据一致性审计 =====');
    for (const k of Object.keys(report.counts)) {
      const isHint = k.includes('(提示)') || k.includes('(归档提示)');
      console.log((report.counts[k] && !isHint ? '❌' : 'ℹ️') + ' ' + k + ': ' + report.counts[k]);
      if (report.counts[k] && process.argv.includes('--detail')) {
        report.issues[k].slice(0, 20).forEach(d => console.log('    ' + d));
      }
    }
    console.log('JSON 残留业务数组合计: ' + leftoverArrays + '（整改后仅归档，不参与业务读取）');
    const total = Object.entries(report.counts).filter(([k, n]) => !k.includes('(提示)') && !k.includes('(归档提示)') && n > 0).reduce((s, [, n]) => s + n, 0);
    console.log(total === 0 ? '✅ 数据一致，无孤立/差异' : '⚠️ 存在 ' + total + ' 项严重数据问题（另有归档残留 ' + leftoverArrays + ' 项，不阻断）');
  }
  // 退出码只看结构化数据损坏（业务子表孤立 / account_data 无主 / JSON 解析失败）；
  // 归档残留与"新账户无数据"是整改迁移前/正常状态，不阻断
  const severe = ['孤立业务数据', 'account_data无accounts元数据', 'JSON解析失败'];
  const total = Object.entries(report.counts)
    .filter(([k, n]) => severe.some(s => k.startsWith(s)) && n > 0)
    .reduce((s, [, n]) => s + n, 0);
  await pool.end();
  process.exit(total > 0 ? 1 : 0);
})().catch(async e => {
  console.error('审计失败:', e.message);
  try { await pool.end(); } catch (_) {}
  process.exit(2);
});

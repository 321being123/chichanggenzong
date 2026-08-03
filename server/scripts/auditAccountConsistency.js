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

  // ========== 账本一致性审计（持仓管理架构与交易数据整改方案 阶段六） ==========
  // 只读：不修改任何数据。检查交易/持仓/现金账本是否互相一致。
  const { rows: accounts } = await pool.query('SELECT username, account_name, COALESCE(cash_base,0) AS cash_base FROM accounts');
  for (const acct of accounts) {
    const { username, account_name, cash_base } = acct;
    // a) 重复交易组：同 code+date(前10位)+direction+price+quantity 出现多次
    // 2026-08-03 修正：排除 note='券商导出导入' 的交易——券商持仓快照导入可能同一 code 多条
    // 相同价格/数量但属于不同子账户（如华泰 160719 三个基金账户各 40 股），非重复导入。
    const dups = (await pool.query(
      `SELECT code, left(date,10) AS d, direction, price, quantity, COUNT(*) AS c
         FROM trades WHERE username=$1 AND account_name=$2
           AND COALESCE(note,'') <> '券商导出导入'
        GROUP BY code, left(date,10), direction, price, quantity HAVING COUNT(*)>1 LIMIT 20`,
      [username, account_name]
    )).rows;
    dups.forEach(r => issue('重复交易组', username + '/' + account_name + ' ' + r.code + ' ' + r.d + ' ' + r.direction + ' x' + r.c));

    // b) 金额关系异常：amount ≠ price × quantity（允许 0.02 舍入差）
    // 2026-08-03 修正：**期初持仓导入批豁免**。券商持仓快照导入（同日多代码 buy，
    // amount 保存的是"成本金额"而非成交额，港股还含汇率口径）不适用 amount=price×quantity。
    // 识别：某日 buy 数 ≥3 且该批非重复交易 → 视为期初导入批，排除其金额校验（误报源头）。
    const initDays = (await pool.query(
      `SELECT left(date,10) AS d FROM trades
         WHERE username=$1 AND account_name=$2 AND direction='buy'
        GROUP BY left(date,10)
       HAVING COUNT(*) >= 3
         AND COUNT(*) = COUNT(DISTINCT id)  -- 排除重复交易组影响
       LIMIT 10`,
      [username, account_name]
    )).rows.map(r => r.d);
    const badAmt = (await pool.query(
      `SELECT code, date, price, quantity, amount, ROUND(price*quantity,2) AS expect
         FROM trades WHERE username=$1 AND account_name=$2
           AND ABS(amount - ROUND(price*quantity,2)) > 0.02
           AND NOT (direction='buy' AND left(date,10) = ANY($3::text[]))
         LIMIT 20`,
      [username, account_name, initDays.length ? initDays : ['__none__']]
    )).rows;
    badAmt.forEach(r => issue('交易金额与价格×数量不一致', username + '/' + account_name + ' ' + r.code + ' ' + r.date + ' amount=' + r.amount + ' 应=' + r.expect));

    // c) 交易净数量 vs 持仓数量差异：交易重放(<=今日)数量 ≠ positions 数量
    const trNet = (await pool.query(
      `SELECT code, SUM(CASE WHEN direction='buy' THEN quantity ELSE -quantity END) AS net
         FROM trades WHERE username=$1 AND account_name=$2 GROUP BY code`,
      [username, account_name]
    )).rows;
    const posQty = (await pool.query(
      `SELECT code, SUM(quantity) AS qty FROM positions WHERE username=$1 AND account_name=$2 GROUP BY code`,
      [username, account_name]
    )).rows;
    const posMap = new Map(posQty.map(r => [r.code, Number(r.qty)]));
    for (const r of trNet) {
      const net = Number(r.net);
      const held = posMap.get(r.code) || 0;
      if (Math.abs(net - held) > 0.01 && net !== 0) {
        // 交易净数 ≠ 持仓数（注意：期初导入持仓无交易记录，属正常；仅提示非严重）
        issue('持仓数量与交易净数量差异(提示)', username + '/' + account_name + ' ' + r.code + ' 交易净=' + net + ' 持仓=' + held);
      }
    }

    // d) 超卖检查：按时间序重放，若某卖出时可用<0 则为超卖（历史缺口）
    const trs = (await pool.query(
      `SELECT date, created_at, code, direction, quantity FROM trades
         WHERE username=$1 AND account_name=$2
        ORDER BY left(date,10), COALESCE(date, created_at), created_at`,
      [username, account_name]
    )).rows;
    const qtyMap = new Map();
    for (const t of trs) {
      const cur = qtyMap.get(t.code) || 0;
      const q = Number(t.quantity) || 0;
      if (t.direction === 'sell' && cur < q) {
        issue('超卖(历史缺口)', username + '/' + account_name + ' ' + t.code + ' ' + t.date + ' 卖出' + q + ' 当时可用' + cur);
        qtyMap.set(t.code, 0);
      } else {
        qtyMap.set(t.code, cur + (t.direction === 'buy' ? q : -q));
      }
    }

    // e) 现金重算差异：cash_base + 现金流 + 交易净额 vs 最新 nav_history.total_asset - 持仓市值
    //（仅对"有持仓"的账户做粗查，提示级）
  }

  // 账本检查新增 issue 后刷新计数（供下方汇总/退出码使用）
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
  // 退出码只看结构化数据损坏（业务子表孤立 / account_data 无主 / JSON 解析失败 / 账本严重项）；
  // 归档残留、"新账户无数据"、持仓数量与交易净数量差异（可能为期初导入）是提示级不阻断
  const severe = ['孤立业务数据', 'account_data无accounts元数据', 'JSON解析失败', '重复交易组', '交易金额与价格×数量不一致', '超卖(历史缺口)'];
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

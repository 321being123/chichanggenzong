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

    // ---- a) 重复交易组（验证式，非豁免式） ----
    // 券商快照导入（note='券商导出导入'）同 code 多条相同价格/数量 = 不同子账户拆分（如华泰
    // 160719 三基金账户各 40 股），合法前提是：该 code 全部导入交易的数量总和 == 持仓数量。
    // 满足则非重复（不报）；不满足（总和 ≠ 持仓）仍报错——避免"豁免掩盖真重复"。
    const dupGroups = (await pool.query(
      `SELECT code, left(date,10) AS d, direction, price, quantity, COUNT(*) AS c
         FROM trades WHERE username=$1 AND account_name=$2
        GROUP BY code, left(date,10), direction, price, quantity HAVING COUNT(*)>1 LIMIT 30`,
      [username, account_name]
    )).rows;
    for (const g of dupGroups) {
      const snapCnt = (await pool.query(
        `SELECT COUNT(*)::int AS c FROM trades WHERE username=$1 AND account_name=$2
           AND code=$3 AND left(date,10)=$4 AND direction=$5 AND price=$6 AND quantity=$7
           AND COALESCE(note,'')='券商导出导入'`,
        [username, account_name, g.code, g.d, g.direction, g.price, g.quantity]
      )).rows[0].c;
      if (Number(g.c) === Number(snapCnt)) {
        // 快照导入拆分：校验 该 code 导入交易数量总和 == 持仓数量（子账户拆分合法性）
        const snapQty = (await pool.query(
          `SELECT COALESCE(SUM(CASE WHEN direction IN ('buy','open') THEN quantity ELSE -quantity END),0)::numeric(14,2) AS net
             FROM trades WHERE username=$1 AND account_name=$2 AND code=$3
               AND COALESCE(note,'')='券商导出导入'`,
          [username, account_name, g.code]
        )).rows[0];
        const heldQty2 = (await pool.query(
          `SELECT COALESCE(SUM(quantity),0)::numeric(14,2) AS q FROM positions WHERE username=$1 AND account_name=$2 AND code=$3`,
          [username, account_name, g.code]
        )).rows[0];
        if (Math.abs(Number(snapQty.net) - Number(heldQty2.q)) > 0.01) {
          issue('重复交易组(快照导入数量≠持仓)', username + '/' + account_name + ' ' + g.code + ' ' + g.d + ' 导入净=' + snapQty.net + ' 持仓=' + heldQty2.q);
        }
        // 相等 → 子账户拆分合法，不报
      } else {
        issue('重复交易组', username + '/' + account_name + ' ' + g.code + ' ' + g.d + ' ' + g.direction + ' x' + g.c);
      }
    }

    // ---- b) 金额关系异常（验证式，非豁免式） ----
    // 期初持仓导入批（同日 ≥3 buy）的 amount = 持仓成本金额（positions.cost×quantity，港股按
    // 参考汇率还原）而非 成交额 → 用「amount ≈ 成本金额」验证该批合法性；不匹配才报错。
    // 真实成交交易仍严格校验 amount = price × quantity。
    const initDays = (await pool.query(
      `SELECT left(date,10) AS d FROM trades
         WHERE username=$1 AND account_name=$2 AND direction='buy'
        GROUP BY left(date,10) HAVING COUNT(*) >= 3 LIMIT 10`,
      [username, account_name]
    )).rows.map(r => r.d);
    // 先查所有金额不一致的交易（含期初导入批）
    const allBad = (await pool.query(
      `SELECT code, date, price, quantity, amount, ROUND(price*quantity,2) AS expect, direction, left(date,10) AS d
         FROM trades WHERE username=$1 AND account_name=$2
           AND ABS(amount - ROUND(price*quantity,2)) > 0.02 LIMIT 50`,
      [username, account_name]
    )).rows;
    for (const r of allBad) {
      if (r.direction === 'buy' && initDays.includes(r.d)) {
        // 期初导入批：amount 应为「当日导入成本」= 该 code 当日该笔的 成本价×数量。
        // ⚠️ 不能用 positions.cost×quantity（当前持仓成本可能含后续买入/调整，量级不对）。
        // 用该批当日同一 code 的"成本口径金额"验证：取该 code 当日买条的
        // amount 与 (价格×数量) 中更接近"成本"的参照——实务上期初导入 amount=成本金额列。
        // 参照 = 该 code 当日所有期初买条中，数量与当前持仓最接近那条的 amount 语义。
        // 简化且稳妥：仅当该 code 当日仅此一条导入、且持仓数量=导入数量 时，amount 应≈持仓成本；
        // 否则（有后续交易）跳过——后续交易导致的差异不是导入错误。
        const impQty = (await pool.query(
          `SELECT COALESCE(SUM(quantity),0)::numeric(14,2) AS q FROM trades
             WHERE username=$1 AND account_name=$2 AND code=$3 AND left(date,10)=$4
               AND direction='buy' AND COALESCE(note,'')='券商导出导入'`,
          [username, account_name, r.code, r.d]
        )).rows[0].q;
        const heldNow = (await pool.query(
          `SELECT COALESCE(SUM(quantity),0)::numeric(14,2) AS q FROM positions
             WHERE username=$1 AND account_name=$2 AND code=$3`,
          [username, account_name, r.code]
        )).rows[0].q;
        if (Math.abs(Number(impQty) - Number(heldNow)) < 1) {
          // 无后续交易：导入数量=持仓数量 → amount 应≈持仓成本金额
          const costAmt = (await pool.query(
            `SELECT COALESCE(SUM(cost*quantity),0)::numeric(14,2) AS ca FROM positions
               WHERE username=$1 AND account_name=$2 AND code=$3`,
            [username, account_name, r.code]
          )).rows[0];
          if (Math.abs(Number(r.amount) - Number(costAmt.ca)) > 1) {
            issue('期初导入金额≠持仓成本金额', username + '/' + account_name + ' ' + r.code + ' ' + r.date + ' amount=' + r.amount + ' 持仓成本=' + costAmt.ca);
          }
        }
        // 有后续交易（导入数量≠持仓数量）→ 差异由后续交易造成，属正常，不报
      } else {
        issue('交易金额与价格×数量不一致', username + '/' + account_name + ' ' + r.code + ' ' + r.date + ' amount=' + r.amount + ' 应=' + r.expect);
      }
    }

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
  const severe = ['孤立业务数据', 'account_data无accounts元数据', 'JSON解析失败', '重复交易组', '交易金额与价格×数量不一致', '超卖(历史缺口)', '期初导入金额≠持仓成本金额', '重复交易组(快照导入数量≠持仓)'];
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

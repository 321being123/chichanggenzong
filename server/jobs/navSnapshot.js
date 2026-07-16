// ========== 每日净值/总资产快照（收盘后自动生成 nav_history） ==========
// 背景：收盘任务只把各持仓收盘价写进 daily_prices，没有再往前一步把
//   「收盘价 → 总资产/净值」算出来写进 nav_history，导致没打开网页那天
//   总资产与投资收益都断档。本任务补上这一步。
// 原则（与 replayNav 一致）：
//   - 只「填补缺失」的交易日，已有的 nav 记录一律不覆盖（用作续链锚点）。
//   - 不在用户首条净值记录之前凭空捏造历史（无净值时才从首个可估值日以 1.0 起链）。
//   - 某交易日有持仓却缺收盘价 → 跳过那天，不近似。
const { pool, loadAccountData, upsertNav, tryClaimJob, releaseJob, startJobRun, finishJobRun } = require('../db');
const { isCnHoliday } = require('../config/holidays');
const { investedAt, chainNav } = require('../../public/shared/nav-math.js');

// 东八区日期 YYYY-MM-DD
function cnDate(d) {
  const x = new Date(d);
  const cn = new Date(x.getTime() + (x.getTimezoneOffset() + 480) * 60000);
  const p = n => String(n).padStart(2, '0');
  return cn.getUTCFullYear() + '-' + p(cn.getUTCMonth() + 1) + '-' + p(cn.getUTCDate());
}

// 为单个账户填补缺失交易日的净值快照（幂等：已有记录跳过、只新增缺失日）
async function recordNavSnapshots(username, accountName) {
  const data = await loadAccountData(username, accountName);
  const navs = (data.navHistory || []).slice().sort(function (a, b) { return a.date.localeCompare(b.date); });
  const hkRate = Number(data.hkRate) || 0.868;
  const cashBase = Number(data.cashBase) || 0;
  const trades = (data.trades || []).slice().sort(function (a, b) {
    return (a.date + (a.created_at || '')).localeCompare(b.date + (b.created_at || ''));
  });
  const cfs = (data.cashFlows || []).slice().sort(function (a, b) { return a.date.localeCompare(b.date); });

  // daily_prices → map "code|date" → price；同时收集「有收盘价的交易日」
  const { rows: dpRows } = await pool.query(
    'SELECT date, code, price::float8 AS price FROM daily_prices WHERE username=$1 AND account_name=$2',
    [username, accountName]
  );
  const dpMap = new Map();
  const priceDates = new Set();
  dpRows.forEach(function (r) { dpMap.set(r.code + '|' + r.date, r.price); priceDates.add(r.date); });
  if (priceDates.size === 0) return { ok: true, days: 0 };
  // 前向填充：返回某 code 在目标日及之前最近一个交易日的有价收盘价（缺价持仓兜底，保证快照连续）
  function recentPrice(code, d) {
    let best = null;
    for (const [k, v] of dpMap) {
      const idx = k.indexOf('|');
      const c = k.slice(0, idx); const dt = k.slice(idx + 1);
      if (c === code && dt <= d) { if (best === null || dt > best.dt) best = { dt: dt, price: v }; }
    }
    return best ? best.price : null;
  }

  const navByDate = new Map();
  navs.forEach(function (n) { navByDate.set(n.date, n); });

  // 投入本金 investedAt() 已收口到 public/shared/nav-math.js（前后端共用）
  // 持仓-as-of 某日
  function heldQty(date) {
    const m = new Map();
    trades.forEach(function (t) {
      if (t.date > date) return;
      const cur = m.get(t.code) || { qty: 0, subtype: t.subtype };
      cur.qty += (t.direction === 'buy' ? 1 : -1) * (t.quantity || 0);
      cur.subtype = t.subtype || cur.subtype;
      m.set(t.code, cur);
    });
    return m;
  }
  // 现金-as-of 某日
  function cashAsOf(date) {
    let c = cashBase;
    cfs.forEach(function (f) { if (f.date <= date) c += (f.amount || 0); });
    trades.forEach(function (t) {
      if (t.date > date) return;
      const fee = (t.commission || 0) + (t.stamp_tax || 0) + (t.transfer_fee || 0) + (t.other_fee || 0);
      c += (t.direction === 'buy') ? -(t.amount || 0) - fee : (t.amount || 0) - fee;
    });
    return c;
  }

  const today = cnDate(new Date());
  let allDates = Array.from(priceDates).filter(function (d) { return /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= today; });
  // 不在首条净值记录之前捏造历史：有净值时只填 >= 首条净值日的空档
  if (navs.length > 0) allDates = allDates.filter(function (d) { return d >= navs[0].date; });
  allDates.sort();
  if (allDates.length === 0) return { ok: true, days: 0 };

  // 锚点：allDates[0] 之前最近的一条 nav（续链基准）
  let prev = null;
  for (const n of navs) {
    if (n.date < allDates[0]) prev = { date: n.date, nav: n.nav, totalAsset: (n.totalAsset != null ? n.totalAsset : 0) };
  }

  let affected = 0;
  for (const d of allDates) {
    const existing = navByDate.get(d);
    if (existing) {
      // 已有记录：保留不动，仅作续链锚点
      prev = { date: d, nav: existing.nav, totalAsset: (existing.totalAsset != null ? existing.totalAsset : (prev ? prev.totalAsset : 0)) };
      continue;
    }
    // 缺失日 → 用当日收盘价估值
    const held = heldQty(d);
    let incomplete = false;
    const mvs = [];
    for (const [code, info] of held) {
      if (info.qty === 0) continue;
      let price = code ? dpMap.get(code + '|' + d) : null;
      if (price == null) price = recentPrice(code, d); // 当日缺价 → 前向填充最近交易日收盘价（兜底，保证连续）
      if (price == null) { incomplete = true; break; }
      mvs.push(price * info.qty * (info.subtype === '港股' ? hkRate : 1));
    }
    if (incomplete) continue; // 仍无任何可用价 → 跳过那天

    const totalAsset = cashAsOf(d) + mvs.reduce(function (s, v) { return s + v; }, 0);
    const invested = investedAt(navs, cfs, cashBase, d);

    if (!prev) {
      await upsertNav(username, accountName, { date: d, nav: 1.0, totalAsset: totalAsset, invested: invested });
      prev = { date: d, nav: 1.0, totalAsset: totalAsset }; affected++; continue;
    }
    let pcf = 0;
    cfs.forEach(function (f) { if (f.date > prev.date && f.date <= d) pcf += (f.amount || 0); });
    const baseAsset = prev.totalAsset + pcf;
    if (baseAsset <= 0) continue; // 无法续链，跳过
    const nav = chainNav(prev.nav, prev.totalAsset, totalAsset, pcf);
    await upsertNav(username, accountName, { date: d, nav: nav, totalAsset: totalAsset, invested: invested });
    prev = { date: d, nav: nav, totalAsset: totalAsset }; affected++;
  }
  return { ok: true, days: affected };
}

// 为所有账户填补缺失快照（带幂等锁与执行留痕，供告警/多实例单跑）
async function runNavSnapshotJob() {
  if (!(await tryClaimJob('nav_snapshot'))) return; // 其他实例已在跑
  const runId = await startJobRun('nav_snapshot');
  let total = 0, accounts = 0;
  try {
    const { rows: users } = await pool.query('SELECT username, accounts FROM users');
    for (const user of users) {
      const accs = typeof user.accounts === 'string' ? JSON.parse(user.accounts) : (user.accounts || []);
      for (const accountName of accs) {
        try {
          const r = await recordNavSnapshots(user.username, accountName);
          if (r && r.days > 0) { total += r.days; accounts++; }
        } catch (e) {
          console.warn('[nav_snapshot] ' + user.username + '/' + accountName + ' 失败:', e.message);
        }
      }
    }
    await finishJobRun(runId, true, '补' + total + '条 / ' + accounts + '账户');
  } catch (e) {
    await finishJobRun(runId, false, e.message || String(e));
    console.error('[nav_snapshot] 失败:', e.message || e);
  } finally {
    await releaseJob('nav_snapshot');
  }
}

module.exports = { recordNavSnapshots, runNavSnapshotJob, cnDate };

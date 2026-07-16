// ========== 晚录入交易 → 历史净值精确回填（replay 引擎） ==========
// 设计：复刻前端 recordNav() 的链式净值公式 + investedAt()，
// 用 daily_prices（部署后已逐日攒齐的持仓收盘价）重放 trades 得到各日持仓与市值，
// 对「晚录入股票在交易日至录入日前」缺价的几天，用 Tushare 历史收盘回补 daily_prices。
// Tushare 拉不到的缺口日 → 跳过那天（保留原快照），不近似。
const { pool, loadAccountData, saveDailyPrices, upsertNav } = require('../db');
const { tushareQuery, tsRows, toTsCode, normDate } = require('../services/market');
const { isCnHoliday } = require('../config/holidays');
const { investedAt, chainNav } = require('../../public/shared/nav-math.js');

// 东八区日期 YYYY-MM-DD
function cnDate(d) {
  const x = new Date(d);
  const cn = new Date(x.getTime() + (x.getTimezoneOffset() + 480) * 60000);
  const p = n => String(n).padStart(2, '0');
  return cn.getUTCFullYear() + '-' + p(cn.getUTCMonth() + 1) + '-' + p(cn.getUTCDate());
}
// 交易日：周一至五 且 非法定节假日
function isTradingDay(d) {
  const day = (d || new Date()).getDay();
  if (day < 1 || day > 5) return false;
  return !isCnHoliday(cnDate(d || new Date()));
}

// 用 Tushare 拉一只代码在 [start, end] 的历史收盘，按日期 upsert 进 daily_prices。
// 成功返回 true（至少写回一条）；失败/无数据返回 false。
async function backfillDailyPrices(username, accountName, code, start, end) {
  const tsCode = toTsCode(code);
  const api = tsCode.endsWith('.HK') ? 'hk_daily' : 'daily';
  const sd = String(start).replace(/-/g, '');
  const ed = String(end).replace(/-/g, '');
  let data = null;
  try {
    data = await tushareQuery(api, { ts_code: tsCode, start_date: sd, end_date: ed }, 'trade_date,close');
  } catch (e) { return false; }
  const rows = tsRows(data);
  if (!rows.length) return false;
  // 按日期分组（saveDailyPrices 按单日期批量写）
  const byDate = {};
  for (const r of rows) {
    const d = normDate(r.trade_date);
    const c = parseFloat(r.close);
    if (!d || isNaN(c) || c <= 0) continue;
    (byDate[d] = byDate[d] || []).push({ code, name: '', price: c });
  }
  let any = false;
  for (const d of Object.keys(byDate)) {
    try { await saveDailyPrices(username, accountName, d, byDate[d]); any = true; } catch (e) {}
  }
  return any;
}

// 主入口：从 fromDate 起重算该账户历史净值（幂等 upsert）
async function recomputeNav(username, accountName, fromDate) {
  if (!fromDate || !/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) {
    return { ok: false, error: 'fromDate 格式应为 YYYY-MM-DD' };
  }
  const data = await loadAccountData(username, accountName);
  const navs = (data.navHistory || []).slice().sort(function (a, b) { return a.date.localeCompare(b.date); });
  if (navs.length === 0) return { ok: true, days: 0, note: 'no_nav' };
  const hkRate = Number(data.hkRate) || 0.868;
  const cashBase = Number(data.cashBase) || 0;
  const trades = (data.trades || []).slice().sort(function (a, b) {
    return (a.date + (a.created_at || '')).localeCompare(b.date + (b.created_at || ''));
  });
  const cfs = (data.cashFlows || []).slice().sort(function (a, b) { return a.date.localeCompare(b.date); });

  // daily_prices → map "code|date" → price
  const { rows: dpRows } = await pool.query(
    'SELECT date, code, price::float8 AS price FROM daily_prices WHERE username=$1 AND account_name=$2',
    [username, accountName]
  );
  const dpMap = new Map();
  dpRows.forEach(function (r) { dpMap.set(r.code + '|' + r.date, r.price); });
  const backfilled = new Set(); // 本run已回填过的代码，避免重复拉 Tushare

  // 复刻 investedAt(date)（与前端 core-earnings.js:116 一致）—— 已收口到 public/shared/nav-math.js

  // 持仓-as-of 某日：重放 date<=d 的 trades（买加/卖减）
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
  // 现金-as-of 某日：cashBase + 现金流(<=d) + 交易净额(<=d)
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

  // 锚点：fromDate 之前最近的一条 nav 记录（续链基准）
  let idx0 = navs.findIndex(function (n) { return n.date >= fromDate; });
  if (idx0 < 0) idx0 = navs.length; // fromDate 晚于所有 nav → 无需回填
  let prev = null;
  if (idx0 > 0) {
    const p = navs[idx0 - 1];
    prev = { date: p.date, nav: p.nav, totalAsset: (p.totalAsset != null ? p.totalAsset : 0) };
  }

  const today = cnDate(new Date());
  let affected = 0;

  for (let i = idx0; i < navs.length; i++) {
    const d = navs[i].date;

    const held = heldQty(d);
    let missing = false;
    const mvList = [];
    for (const [code, info] of held) {
      if (info.qty === 0) continue;
      let price = dpMap.get(code + '|' + d);
      if (price == null) {
        // 缺价 → 尝试 Tushare 历史回补（本run每代码一次）；回补后从库重载该代码价格
        if (!backfilled.has(code)) {
          backfilled.add(code);
          const ok = await backfillDailyPrices(username, accountName, code, fromDate, today);
          if (ok) {
            const { rows } = await pool.query(
              'SELECT date, price::float8 AS price FROM daily_prices WHERE username=$1 AND account_name=$2 AND code=$3',
              [username, accountName, code]
            );
            rows.forEach(function (r) { dpMap.set(code + '|' + r.date, r.price); });
          }
        }
        price = dpMap.get(code + '|' + d);
        if (price == null) { missing = true; continue; }
      }
      const mv = price * info.qty * (info.subtype === '港股' ? hkRate : 1);
      mvList.push(mv);
    }
    if (missing) {
      // 该日无法精确计算 → 保留原快照，prev 用原值续链
      const orig = navs[i];
      prev = { date: d, nav: orig.nav, totalAsset: (orig.totalAsset != null ? orig.totalAsset : (prev ? prev.totalAsset : 0)) };
      continue;
    }

    const totalAsset = cashAsOf(d) + mvList.reduce(function (s, v) { return s + v; }, 0);
    const invested = investedAt(navs, cfs, cashBase, d);

    if (i === 0 && idx0 === 0 && !prev) {
      // 整体首条：nav 固定 1.0（与 recordNav 一致）
      await upsertNav(username, accountName, { date: d, nav: 1.0, totalAsset: totalAsset, invested: invested });
      prev = { date: d, nav: 1.0, totalAsset: totalAsset };
      affected++;
      continue;
    }
    if (!prev) { prev = { date: d, nav: navs[i].nav, totalAsset: totalAsset }; continue; }

    // periodCashFlow：prev.date(不含) → d(含) 的累计净现金流
    let pcf = 0;
    cfs.forEach(function (f) { if (f.date > prev.date && f.date <= d) pcf += (f.amount || 0); });
    const baseAsset = prev.totalAsset + pcf;
    if (baseAsset <= 0) {
      const orig = navs[i];
      prev = { date: d, nav: orig.nav, totalAsset: (orig.totalAsset != null ? orig.totalAsset : prev.totalAsset) };
      continue;
    }
    const nav = chainNav(prev.nav, prev.totalAsset, totalAsset, pcf);
    await upsertNav(username, accountName, { date: d, nav: nav, totalAsset: totalAsset, invested: invested });
    prev = { date: d, nav: nav, totalAsset: totalAsset };
    affected++;
  }

  return { ok: true, days: affected };
}

module.exports = { recomputeNav, backfillDailyPrices, isTradingDay, cnDate };

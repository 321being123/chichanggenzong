// ========== 晚录入交易 → 历史净值精确回填（replay 引擎） ==========
// 设计：复刻前端 recordNav() 的链式净值公式 + investedAt()，
// 用 daily_prices（部署后已逐日攒齐的持仓收盘价）重放 trades 得到各日持仓与市值，
// 对「晚录入股票在交易日至录入日前」缺价的几天，用 Tushare 历史收盘回补 daily_prices。
// Tushare 拉不到的缺口日 → 跳过那天（保留原快照），不近似。
const { pool, loadAccountData, saveDailyPrices, upsertNav } = require('../db');
const { tushareQuery, tsRows, toTsCode, normDate } = require('../services/market');
const classifyCode = require('../../public/js/code-classify');
const { isCnHoliday } = require('../config/holidays');
const { investedAt, chainNav } = require('../../public/shared/nav-math.js');
const { getCurrentFxRate } = require('../services/fxRate');

// 东八区日期 YYYY-MM-DD
function cnDate(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(d));
}
// 交易日：周一至五 且 非法定节假日
function isTradingDay(d) {
  const day = (d || new Date()).getDay();
  if (day < 1 || day > 5) return false;
  return !isCnHoliday(cnDate(d || new Date()));
}

function historicalApiFor(code, position = {}) {
  const rawCode = String(code || '').trim().toUpperCase();
  const info = classifyCode(rawCode, position.name || '');
  const subtype = String(position.subtype || (info && info.subtype) || '');
  const type = String(position.type || (info && info.type) || '');
  if (subtype === '港股' || /^\d{5}$/.test(rawCode)) return 'hk_daily';
  if (subtype === '可转债' || type === '债权' || /债/.test(String(position.name || '')) || /^(11|12)\d{4}$/.test(rawCode)) return 'cb_daily';
  if (subtype.indexOf('基金') >= 0 || subtype.indexOf('ETF') >= 0 || type === '基金') return 'fund_daily';
  return 'daily';
}

// 用对应证券类型的 Tushare 历史接口拉取 [start, end] 收盘，按日期 upsert 进 daily_prices。
// 成功返回 true（至少写回一条）；失败/无数据返回 false。
async function backfillDailyPrices(username, accountName, code, start, end, position = {}) {
  const tsCode = toTsCode(code);
  const api = historicalApiFor(code, position);
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
  const cashBase = Number(data.cashBase) || 0;
  const trades = (data.trades || []).slice().sort(function (a, b) {
    // 方案 3.6 修复：按交易日(trade_date)+成交时间(executed_at)排序，避免带时间 date 与纯日期比较错位
    const ad = a.trade_date || (a.date || '').slice(0, 10);
    const bd = b.trade_date || (b.date || '').slice(0, 10);
    const at = a.executed_at || a.date || a.created_at || '';
    const bt = b.executed_at || b.date || b.created_at || '';
    return (ad + at).localeCompare(bd + bt);
  });
  const cfs = (data.cashFlows || []).slice().sort(function (a, b) { return a.date.localeCompare(b.date); });

  // 交易日字段（trade_date 优先，兼容旧数据回退 date 前 10 位）
  const tradeDay = function (t) { return t.trade_date || (t.date || '').slice(0, 10); };
  const unresolvedHkdDays = trades
    .filter(function (t) {
      const rawAmountCny = t.amountCny != null && t.amountCny !== '' ? t.amountCny :
        (t.amount_cny != null && t.amount_cny !== '' ? t.amount_cny : null);
      return String(t.quote_currency || '').toUpperCase() === 'HKD' && rawAmountCny == null;
    })
    .map(tradeDay);

  // daily_prices → map "code|date" → price
  const { rows: dpRows } = await pool.query(
    'SELECT date, code, price::float8 AS price FROM daily_prices WHERE username=$1 AND account_name=$2',
    [username, accountName]
  );
  const dpMap = new Map();
  dpRows.forEach(function (r) { dpMap.set(r.code + '|' + r.date, r.price); });
  const backfilled = new Set(); // 本run已回填过的代码，避免重复拉 Tushare

  // 复刻 investedAt(date)（与前端 core-earnings.js:116 一致）—— 已收口到 public/shared/nav-math.js

  // 持仓-as-of 某日：重放 tradeDay<=d 的事件（纯日期比较，修复当日带时间交易漏算）
  // 方向语义：buy/open 累加数量；sell 减数量；adjust 数量=调整后目标数量（绝对设置，P0-2）
  function heldQty(date) {
    const m = new Map();
    trades.forEach(function (t) {
      if (tradeDay(t) > date) return;
      const cur = m.get(t.code) || { qty: 0, subtype: t.subtype };
      if (t.direction === 'sell') {
        cur.qty -= (t.quantity || 0);
      } else if (t.direction === 'adjust') {
        cur.qty = Math.max(0, (t.quantity || 0)); // 目标数量绝对设置
      } else {
        cur.qty += (t.quantity || 0); // buy / open 累加
      }
      cur.subtype = t.subtype || cur.subtype;
      m.set(t.code, cur);
    });
    return m;
  }
  // 现金-as-of 某日：cashBase + 现金流(<=d) + 交易净额(tradeDay<=d)
  // open（期初建仓）/ adjust（持仓调整）不产生现金变动（P0-2）
  function cashAsOf(date) {
    let c = cashBase;
    cfs.forEach(function (f) { if (f.date <= date) c += (f.amount || 0); });
    trades.forEach(function (t) {
      if (tradeDay(t) > date) return;
      if (t.direction === 'open' || t.direction === 'adjust') return;
      const fee = (t.commission || 0) + (t.stamp_tax || 0) + (t.transfer_fee || 0) + (t.other_fee || 0);
      const rawAmountCny = t.amountCny != null && t.amountCny !== '' ? t.amountCny :
        (t.amount_cny != null && t.amount_cny !== '' ? t.amount_cny : null);
      const amountCny = rawAmountCny != null && Number.isFinite(Number(rawAmountCny)) ? Number(rawAmountCny) : null;
      if (amountCny == null && String(t.quote_currency || '').toUpperCase() === 'HKD') return;
      const settled = amountCny == null ? (Number(t.amount) || 0) : amountCny;
      c += (t.direction === 'buy') ? -settled - fee : settled - fee;
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
  const { rows: fxRows } = await pool.query(
    `SELECT rate_date, rate::float8 AS rate FROM market.fx_rates
      WHERE base_currency='HKD' AND quote_currency='CNY' AND rate_date <= $1`,
    [today]
  );
  const fxByDate = new Map(fxRows.map(r => [cnDate(r.rate_date), Number(r.rate)]));
  const currentFxRate = fxByDate.get(today) || await getCurrentFxRate();
  let affected = 0;

  for (let i = idx0; i < navs.length; i++) {
    const d = navs[i].date;

    const held = heldQty(d);
    const hkRate = fxByDate.get(d) || (d === today ? currentFxRate : null);
    // 未解决港股结算金额会使现金重建不可信；对应日期保留原快照，不允许自动覆盖。
    let missing = unresolvedHkdDays.some(function (td) { return td <= d; });
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
      if (info.subtype === '港股' && !(hkRate > 0)) { missing = true; continue; }
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
      await upsertNav(username, accountName, { date: d, nav: 1.0, totalAsset: totalAsset, invested: invested, hkRate: hkRate });
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
    await upsertNav(username, accountName, { date: d, nav: nav, totalAsset: totalAsset, invested: invested, hkRate: hkRate });
    prev = { date: d, nav: nav, totalAsset: totalAsset };
    affected++;
  }

  if (affected > 0) {
    await pool.query('UPDATE account_data SET nav_dirty_from=NULL WHERE username=$1 AND account_name=$2', [username, accountName]);
  }
  return { ok: true, days: affected };
}

module.exports = { recomputeNav, backfillDailyPrices, historicalApiFor, isTradingDay, cnDate };

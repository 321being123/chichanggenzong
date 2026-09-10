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
const { getCurrentFxRate } = require('../services/fxRate');
const classifyCode = require('../../public/js/code-classify');

// 东八区日期 YYYY-MM-DD
function cnDate(d) {
  const x = new Date(d);
  const cn = new Date(x.getTime() + (x.getTimezoneOffset() + 480) * 60000);
  const p = n => String(n).padStart(2, '0');
  return cn.getUTCFullYear() + '-' + p(cn.getUTCMonth() + 1) + '-' + p(cn.getUTCDate());
}

function dateText(value) {
  return value instanceof Date ? cnDate(value) : String(value || '').slice(0, 10);
}

// 为单个账户填补缺失交易日的净值快照（幂等：已有记录跳过、只新增缺失日）
async function recordNavSnapshots(username, accountName, hkRateOverride = null) {
  const data = await loadAccountData(username, accountName);
  const positionNames = new Map((data.positions || []).map(position => [position.code, position.name || '']));
  const navs = (data.navHistory || []).slice().sort(function (a, b) { return dateText(a.date).localeCompare(dateText(b.date)); });
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
  dpRows.forEach(function (r) {
    const d = dateText(r.date);
    dpMap.set(r.code + '|' + d, r.price);
    priceDates.add(d);
  });
  if (priceDates.size === 0) return { ok: true, days: 0 };
  const navByDate = new Map();
  navs.forEach(function (n) { navByDate.set(dateText(n.date), n); });

  // 投入本金 investedAt() 已收口到 public/shared/nav-math.js（前后端共用）
  // 统一证券代码，兼容历史导入把港股 00152 写成 000152 的旧数据。
  // 正式数据修正仍需回写数据库；这里保留受控兜底，避免一条历史脏交易阻断整户补链。
  function holdingCode(code, name) {
    return classifyCode.normalizeCode(code, name) || String(code || '');
  }
  function tradeDay(t) { return String(t.trade_date || (t.date || '')).slice(0, 10); }

  // 券商导入/人工校准快照是指定时点的持仓事实，优先于旧交易历史；
  // 只重放快照之后的交易，避免把快照前的交易再次累加。
  function latestPositionAnchor(date) {
    const snapshots = (data.positionSnapshots || []).filter(s => {
      const d = dateText(s.snapshotDate || s.date);
      return d && d <= date;
    });
    const manualDates = snapshots
      .filter(s => String(s.source || '') === 'manual_reconciliation')
      .map(s => dateText(s.snapshotDate || s.date));
    if (manualDates.length) {
      const anchorDate = manualDates.reduce((max, d) => d > max ? d : max, '');
      return {
        anchorDate,
        rows: snapshots.filter(s => String(s.source || '') === 'manual_reconciliation' &&
          dateText(s.snapshotDate || s.date) === anchorDate)
      };
    }
    const imports = (data.navHistory || []).filter(n => n.snapshotSource === 'imported' && n.isLocked !== false &&
      dateText(n.date) <= date)
      .sort((a, b) => dateText(a.date).localeCompare(dateText(b.date)) ||
        String(a.snapshot_at || '').localeCompare(String(b.snapshot_at || '')));
    const imported = imports.length ? imports[imports.length - 1] : null;
    if (!imported) return null;
    let rows = imported.importBatchId
      ? snapshots.filter(s => String(s.snapshotId || '') === String(imported.importBatchId))
      : [];
    if (!rows.length) {
      const importedDate = dateText(imported.date);
      rows = snapshots.filter(s => dateText(s.snapshotDate || s.date) === importedDate);
    }
    return rows.length ? { anchorDate: rows.reduce((max, s) => {
      const d = dateText(s.snapshotDate || s.date);
      return d > max ? d : max;
    }, ''), rows } : null;
  }

  // 持仓-as-of 某日（与券商/人工快照锚定规则一致；adjust = 目标数量绝对设置）
  function heldQty(date, anchorOverride = undefined) {
    const m = new Map();
    const anchor = anchorOverride === undefined ? latestPositionAnchor(date) : anchorOverride;
    if (anchor) {
      for (const s of anchor.rows) {
        const code = holdingCode(s.code || s.instrumentCode, s.name);
        if (!code) continue;
        const info = classifyCode(code, s.name) || {};
        const subtype = String(s.quoteCurrency || '').toUpperCase() === 'HKD' ? '港股' : info.subtype || '';
        const cur = m.get(code) || { qty: 0, subtype, name: positionNames.get(code) || s.name || '' };
        cur.qty += Number(s.quantity) || 0;
        cur.subtype = subtype || cur.subtype;
        cur.name = positionNames.get(code) || s.name || cur.name;
        m.set(code, cur);
      }
    }
    trades.forEach(function (t) {
      if (tradeDay(t) > date || (anchor && tradeDay(t) <= anchor.anchorDate)) return;
      const code = holdingCode(t.code, t.name);
      const info = classifyCode(code, t.name) || {};
      const cur = m.get(code) || { qty: 0, subtype: t.subtype || info.subtype, name: positionNames.get(code) || t.name || '' };
      const q = Number(t.quantity) || 0;
      if (t.direction === 'sell') cur.qty -= q;
      else if (t.direction === 'adjust') cur.qty = Math.max(0, q); // 目标数量绝对设置（0=清仓）
      else cur.qty += q; // buy / open 均累加
      cur.subtype = t.subtype || info.subtype || cur.subtype;
      cur.name = positionNames.get(code) || t.name || cur.name;
      m.set(code, cur);
    });
    return m;
  }
  // 现金-as-of 某日（open/adjust 不产生现金）
  function cashAsOf(date) {
    const cashAnchors = navs.filter(n => n.snapshotSource === 'imported' && n.isLocked !== false &&
      dateText(n.date) <= date && Number.isFinite(Number(n.cashCny)) && Number(n.cashCny) >= 0)
      .sort((a, b) => dateText(a.date).localeCompare(dateText(b.date)));
    const cashAnchor = cashAnchors.length ? cashAnchors[cashAnchors.length - 1] : null;
    const anchorDate = cashAnchor ? dateText(cashAnchor.date) : '';
    let c = cashAnchor ? Number(cashAnchor.cashCny) : cashBase;
    let incomplete = false;
    cfs.forEach(function (f) {
      const fd = dateText(f.date);
      if ((!anchorDate || fd > anchorDate) && fd <= date) c += (f.amount || 0);
    });
    trades.forEach(function (t) {
      if (tradeDay(t) > date || (anchorDate && tradeDay(t) <= anchorDate)) return;
      if (t.direction === 'open' || t.direction === 'adjust') return;
      const fee = (t.commission || 0) + (t.stamp_tax || 0) + (t.transfer_fee || 0) + (t.other_fee || 0);
      const rawAmountCny = t.amountCny != null && t.amountCny !== '' ? t.amountCny :
        (t.amount_cny != null && t.amount_cny !== '' ? t.amount_cny : null);
      const amountCny = rawAmountCny != null && Number.isFinite(Number(rawAmountCny)) ? Number(rawAmountCny) : null;
      if (amountCny == null && String(t.quote_currency || '').toUpperCase() === 'HKD') {
        incomplete = true;
        return;
      }
      const settled = amountCny == null ? (Number(t.amount) || 0) : amountCny;
      c += (t.direction === 'buy') ? -settled - fee : settled - fee;
    });
    return { value: c, incomplete };
  }

  const today = cnDate(new Date());
  const { rows: fxRows } = await pool.query(
    `SELECT rate_date, rate::float8 AS rate FROM market.fx_rates
      WHERE base_currency='HKD' AND quote_currency='CNY' AND rate_date <= $1`,
    [today]
  );
  const fxByDate = new Map(fxRows.map(r => [r.rate_date instanceof Date ? cnDate(r.rate_date) : String(r.rate_date).slice(0, 10), Number(r.rate)]));
  const currentFxRate = Number(hkRateOverride) > 0 ? Number(hkRateOverride) : (fxByDate.get(today) || await getCurrentFxRate());
  let allDates = Array.from(priceDates).filter(function (d) { return /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= today; });
  // 不在首条净值记录之前捏造历史：有净值时只填 >= 首条净值日的空档
  if (navs.length > 0) allDates = allDates.filter(function (d) { return d >= dateText(navs[0].date); });
  allDates.sort();
  if (allDates.length === 0) return { ok: true, days: 0 };

  // 锚点：allDates[0] 之前最近的一条 nav（续链基准）
  let prev = null;
  for (const n of navs) {
    if (dateText(n.date) < allDates[0]) prev = { date: dateText(n.date), nav: n.nav, totalAsset: (n.totalAsset != null ? n.totalAsset : 0) };
  }

  let affected = 0;
  const incompleteDates = [];
  for (const d of allDates) {
    const existing = navByDate.get(d);
    if (existing) {
      // 已有记录：保留不动，仅作续链锚点
      prev = { date: d, nav: existing.nav, totalAsset: (existing.totalAsset != null ? existing.totalAsset : (prev ? prev.totalAsset : 0)) };
      continue;
    }
    // 缺失日 → 用当日收盘价估值
    const anchor = latestPositionAnchor(d);
    // 有持仓/交易数据时，必须先找到券商导入或人工校准快照；禁止退回到“从第一笔交易重算”的旧逻辑。
    const hasActivity = (data.positions || []).length > 0 || trades.some(t => tradeDay(t) <= d);
    if (!anchor && hasActivity) {
      incompleteDates.push({ date: d, missingCodes: ['持仓基准快照'] });
      continue;
    }
    const held = heldQty(d, anchor);
    const hkRate = fxByDate.get(d) || (d === today ? currentFxRate : null);
    let incomplete = false;
    const missingCodes = [];
    const mvs = [];
    for (const [code, info] of held) {
      if (info.qty === 0) continue;
      const price = code ? dpMap.get(code + '|' + d) : null;
      if (price == null) { incomplete = true; missingCodes.push(code); continue; }
      if (info.subtype === '港股' && !(hkRate > 0)) { incomplete = true; missingCodes.push(code + ':HKD汇率'); continue; }
      mvs.push(price * info.qty * (info.subtype === '港股' ? hkRate : 1));
    }
    if (incomplete) {
      incompleteDates.push({ date: d, missingCodes: missingCodes.slice(0, 50) });
      continue; // 缺任一基准持仓数据时不近似，交由统一任务重试/告警
    }

    const cash = cashAsOf(d);
    if (cash.incomplete) {
      incompleteDates.push({ date: d, missingCodes: ['HKD交易人民币结算额'] });
      continue;
    }
    const totalAsset = cash.value + mvs.reduce(function (s, v) { return s + v; }, 0);
    const invested = investedAt(navs, cfs, cashBase, d);

    if (!prev) {
      await upsertNav(username, accountName, { date: d, nav: 1.0, totalAsset: totalAsset, invested: invested, hkRate: hkRate });
      prev = { date: d, nav: 1.0, totalAsset: totalAsset }; affected++; continue;
    }
    let pcf = 0;
    cfs.forEach(function (f) { if (f.date > prev.date && f.date <= d) pcf += (f.amount || 0); });
    const baseAsset = prev.totalAsset + pcf;
    if (baseAsset <= 0) continue; // 无法续链，跳过
    const nav = chainNav(prev.nav, prev.totalAsset, totalAsset, pcf);
    await upsertNav(username, accountName, { date: d, nav: nav, totalAsset: totalAsset, invested: invested, hkRate: hkRate });
    prev = { date: d, nav: nav, totalAsset: totalAsset }; affected++;
  }
  return {
    ok: incompleteDates.length === 0,
    status: incompleteDates.length ? 'partial' : 'succeeded',
    days: affected,
    missingDates: incompleteDates.map(item => item.date),
    missingCodes: [...new Set(incompleteDates.flatMap(item => item.missingCodes))],
    diagnostics: incompleteDates,
    ...(incompleteDates.length ? {
      error: '账户净值快照存在缺失行情或汇率：' + incompleteDates.map(item => item.date + '（' + item.missingCodes.join('、') + '）').join('；'),
      errorType: 'data_quality',
      failedDatasets: ['nav_snapshot'],
    } : {}),
  };
}

// 为所有账户填补缺失快照（带幂等锁与执行留痕，供告警/多实例单跑）
async function runNavSnapshotJob() {
  if (!(await tryClaimJob('nav_snapshot'))) return { ok: false, skipped: true, reason: 'already_running' }; // 其他实例已在跑
  const runId = await startJobRun('nav_snapshot');
  let total = 0, accountCount = 0;
  const failedAccounts = [];
  try {
    const hkRate = await getCurrentFxRate();
    const { rows: accountRows } = await pool.query('SELECT username, account_name FROM accounts ORDER BY username, created_at');
    for (const account of accountRows) {
      const accountName = account.account_name;
      try {
        const r = await recordNavSnapshots(account.username, accountName, hkRate);
        if (r && r.days > 0) { total += r.days; accountCount++; }
        if (r && r.ok === false) {
          failedAccounts.push({ accountName, missingDates: r.missingDates || [], missingCodes: r.missingCodes || [], diagnostics: r.diagnostics || [] });
        }
      } catch (e) {
        console.warn('[nav_snapshot] ' + account.username + '/' + accountName + ' 失败:', e.message);
        failedAccounts.push({ accountName, error: e.message || String(e) });
      }
    }
    const result = {
      ok: failedAccounts.length === 0,
      status: failedAccounts.length ? 'partial' : 'succeeded',
      days: total,
      accountCount,
      failedAccounts,
      missingDates: [...new Set(failedAccounts.flatMap(item => item.missingDates || []))],
      failedDatasets: failedAccounts.length ? ['nav_snapshot'] : [],
      ...(failedAccounts.length ? { error: '部分账户净值快照未完成', errorType: 'data_quality' } : {}),
    };
    await finishJobRun(runId, result.ok, result.ok ? ('补' + total + '条 / ' + accountCount + '账户') : JSON.stringify(result));
    return result;
  } catch (e) {
    await finishJobRun(runId, false, e.message || String(e));
    console.error('[nav_snapshot] 失败:', e.message || e);
    return { ok: false, status: 'failed', error: e.message || String(e), errorType: 'internal' };
  } finally {
    await releaseJob('nav_snapshot');
  }
}

module.exports = { recordNavSnapshots, runNavSnapshotJob, cnDate };

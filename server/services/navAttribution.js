// 净值涨跌归因的唯一后端实现。
// 前端只展示结果，不再自行拼接价格、汇率和账本公式。
const { pool } = require('../db/connection');

function dateKey(value) {
  if (!value) return '';
  if (value instanceof Date) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(value);
  }
  return String(value).slice(0, 10);
}

function timestamp(value) {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

function eventTimestamp(row) {
  return timestamp(row.executed_at || row.created_at);
}

function eventInInterval(row, eventDate, startDate, endDate, startAt, endAt) {
  const eventAt = eventTimestamp(row);
  if (eventAt != null && startAt != null && endAt != null) {
    return eventAt > startAt && eventAt <= endAt;
  }
  return eventDate > startDate && eventDate <= endDate;
}

function eventAtOrBefore(row, eventDate, snapshotDate, snapshotAt) {
  if (eventDate < snapshotDate) return true;
  if (eventDate > snapshotDate) return false;
  const eventAt = eventTimestamp(row);
  const cutoffAt = timestamp(snapshotAt);
  return eventAt == null || cutoffAt == null || eventAt <= cutoffAt;
}

function cashAtSnapshot(data, snapshotDate, snapshotAt) {
  const imports = (data.navHistory || []).filter((n) => n.snapshotSource === 'imported' && n.isLocked !== false &&
    dateKey(n.date) <= snapshotDate && Number.isFinite(Number(n.cashCny)) && Number(n.cashCny) >= 0)
    .sort((a, b) => dateKey(a.date).localeCompare(dateKey(b.date)));
  const anchor = imports.length ? imports[imports.length - 1] : null;
  const anchorDate = anchor ? dateKey(anchor.date) : null;
  const result = { value: anchor ? Number(anchor.cashCny) : (Number(data.cashBase) || 0), incomplete: false };
  for (const f of (data.cashFlows || [])) {
    const d = dateKey(f.date);
    if (anchorDate && d <= anchorDate) continue;
    if (eventAtOrBefore(f, d, snapshotDate, snapshotAt)) result.value += Number(f.amount) || 0;
  }
  for (const t of (data.trades || [])) {
    const d = dateKey(t.trade_date || t.date);
    if (anchorDate && d <= anchorDate) continue;
    if (!eventAtOrBefore(t, d, snapshotDate, snapshotAt) || t.direction === 'open' || t.direction === 'adjust') continue;
    const fee = (Number(t.commission) || 0) + (Number(t.stamp_tax) || 0) + (Number(t.transfer_fee) || 0) + (Number(t.other_fee) || 0);
    const rawAmountCny = t.amountCny != null && t.amountCny !== '' ? t.amountCny :
      (t.amount_cny != null && t.amount_cny !== '' ? t.amount_cny : null);
    const amountCny = rawAmountCny != null && Number.isFinite(Number(rawAmountCny)) ? Number(rawAmountCny) : null;
    if (amountCny == null && String(t.quote_currency || '').toUpperCase() === 'HKD') {
      result.incomplete = true;
      continue;
    }
    const settled = amountCny == null ? (Number(t.amount) || 0) : amountCny;
    result.value += t.direction === 'buy' ? -settled - fee : settled - fee;
  }
  return result;
}

function latestImportedPositionAnchor(data, date) {
  const imports = (data.navHistory || []).filter((n) => n.snapshotSource === 'imported' && n.isLocked !== false &&
    dateKey(n.date) <= date)
    .sort((a, b) => dateKey(a.date).localeCompare(dateKey(b.date)) ||
      (timestamp(a.snapshot_at) || 0) - (timestamp(b.snapshot_at) || 0));
  const imported = imports.length ? imports[imports.length - 1] : null;
  const snapshots = (data.positionSnapshots || []).filter((s) => dateKey(s.snapshotDate || s.date) <= date);
  if (!snapshots.length) return null;

  let rows = imported && imported.importBatchId
    ? snapshots.filter((s) => String(s.snapshotId) === String(imported.importBatchId))
    : [];
  if (!rows.length) {
    const latestDate = imported ? dateKey(imported.date) : snapshots.reduce((max, s) => {
      const d = dateKey(s.snapshotDate || s.date);
      return d > max ? d : max;
    }, '');
    rows = snapshots.filter((s) => dateKey(s.snapshotDate || s.date) === latestDate);
  }
  if (!rows.length) return null;
  const anchorDate = rows.reduce((max, s) => {
    const d = dateKey(s.snapshotDate || s.date);
    return d > max ? d : max;
  }, '');
  return { anchorDate, rows };
}

function quantityAsOf(data, date, snapshotAt) {
  const map = new Map();
  const trades = (data.trades || []).slice().sort((a, b) => {
    const ad = String(a.trade_date || a.date || '').slice(0, 10);
    const bd = String(b.trade_date || b.date || '').slice(0, 10);
    return ad.localeCompare(bd) || String(a.executed_at || a.date || '').localeCompare(String(b.executed_at || b.date || ''));
  });
  // 券商导入快照是该时点的持仓事实；历史交易可能包含旧导入重复行，
  // 因此只能从快照之后重放交易，不能把快照之前的账本再次累加。
  const importedAnchor = latestImportedPositionAnchor(data, date);
  if (importedAnchor) {
    for (const s of importedAnchor.rows) {
      const code = String(s.code || s.instrumentCode || '');
      if (!code) continue;
      map.set(code, { quantity: Number(s.quantity) || 0, subtype: String(s.quoteCurrency || '').toUpperCase() === 'HKD' ? '港股' : '' });
    }
  }
  if (trades.length) {
    for (const t of trades) {
      const td = String(t.trade_date || t.date || '').slice(0, 10);
      if (importedAnchor && td <= importedAnchor.anchorDate) continue;
      if (!eventAtOrBefore(t, td, date, snapshotAt)) continue;
      const code = String(t.code || '');
      if (!code) continue;
      const row = map.get(code) || { quantity: 0, subtype: t.subtype || '' };
      if (t.direction === 'sell') row.quantity -= Number(t.quantity) || 0;
      else if (t.direction === 'adjust') row.quantity = Math.max(0, Number(t.quantity) || 0);
      else row.quantity += Number(t.quantity) || 0;
      row.subtype = t.subtype || row.subtype;
      map.set(code, row);
    }
  }
  // 没有完整交易历史的持仓，按当前持仓补入，避免把券商导入的“持仓仍由本系统维护”误判为零。
  for (const p of (data.positions || [])) {
    const code = String(p.code || '');
    if (code && !map.has(code)) map.set(code, { quantity: Number(p.quantity) || 0, subtype: p.subtype || '' });
  }
  // 导入快照是历史锚点；若锚点之后到基准日没有交易，而当前持仓已被校正，
  // 以当前持仓现状为准，避免旧快照数量把合法的子账户拆分重复误判为重复交易。
  if (importedAnchor) {
    for (const p of (data.positions || [])) {
      const code = String(p.code || '');
      if (!code) continue;
      const changedAfter = trades.some((t) => String(t.trade_date || t.date || '').slice(0, 10) > date && String(t.code || '') === code);
      if (changedAfter) continue;
      const currentQuantity = Number(p.quantity) || 0;
      const row = map.get(code);
      if (!row || Math.abs((Number(row.quantity) || 0) - currentQuantity) > 0.0001) {
        map.set(code, { quantity: currentQuantity, subtype: p.subtype || (row && row.subtype) || '' });
      }
    }
  }
  // 当前持仓表是现状权威：若某证券当前已不存在，且基准日之后没有交易，
  // 交易历史中的残余数量不能被继续当成基准日持仓（典型是券商数量单位修正后留下的 1 股尾差）。
  const currentCodes = new Set((data.positions || []).map((p) => String(p.code || '')).filter(Boolean));
  for (const code of [...map.keys()]) {
    if (currentCodes.has(code)) continue;
    const changedAfter = trades.some((t) => String(t.trade_date || t.date || '').slice(0, 10) > date && String(t.code || '') === code);
    if (!changedAfter) map.delete(code);
  }
  return map;
}

async function computeNavAttribution(username, accountName, data, currentTotal) {
  const navs = (data.navHistory || []).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (navs.length < 2) return { complete: false, reason: 'not_enough_snapshots' };
  const last = navs[navs.length - 1];
  const historicalPrevious = navs[navs.length - 2];
  const storedLastDate = dateKey(last.date);
  const todayDate = dateKey(new Date());
  // 页面有当前系统总资产时，最后一条已保存快照就是当前计算的基准。
  // 这样周二会按“周一快照 → 周二当前行情”计算，不会重复把周日/更早区间算进来。
  const liveEnd = currentTotal != null && storedLastDate <= todayDate;
  const previous = liveEnd && storedLastDate < todayDate ? last : historicalPrevious;
  const prevDate = dateKey(previous.date);
  const currentDate = liveEnd ? todayDate : storedLastDate;
  const { rows: prices } = await pool.query(
    `SELECT date, code, price::float8 AS price FROM daily_prices
      WHERE username=$1 AND account_name=$2 AND date IN ($3,$4)`,
    [username, accountName, prevDate, currentDate]
  );
  const priceMap = new Map(prices.map(r => [dateKey(r.date) + '|' + String(r.code), Number(r.price)]));
  const { rows: fxRows } = await pool.query(
    `SELECT DISTINCT ON (rate_date) rate_date, rate::float8 AS rate FROM market.fx_rates
      WHERE base_currency='HKD' AND quote_currency='CNY' AND rate_date <= $1
      ORDER BY rate_date ASC, fetched_at DESC, source_id DESC`, [currentDate]
  );
  const fxByDate = new Map(fxRows.map(r => [dateKey(r.rate_date), Number(r.rate)]));
  const fallbackCurrent = Number(data.hkRate) > 0 ? Number(data.hkRate) : null;
  // 已保存快照中的汇率是历史事实，行情表只能作为缺失时的明确回退，不能静默覆盖。
  const rateAt = (date, nav) => Number(nav && nav.hkRate) > 0 ? Number(nav.hkRate) :
    (Number(fxByDate.get(date)) > 0 ? Number(fxByDate.get(date)) : fallbackCurrent);
  const prevRate = rateAt(prevDate, previous);
  const lastRate = liveEnd && Number(data.hkRate) > 0 ? Number(data.hkRate) : rateAt(currentDate, last);
  const currentByCode = new Map((data.positions || []).map(p => [String(p.code), p]));
  const prevAt = timestamp(previous.snapshot_at);
  const lastAt = liveEnd ? Date.now() : timestamp(last.snapshot_at);
  const prevQty = quantityAsOf(data, prevDate, previous.snapshot_at);
  const priceImpact = { value: 0 };
  const fxImpact = { value: 0 };
  const previousMarketValue = { value: 0, complete: true };
  const missing = [];
  const codes = new Set([...prevQty.keys(), ...currentByCode.keys()]);
  for (const code of codes) {
    const q = prevQty.get(code) || { quantity: 0, subtype: (currentByCode.get(code) || {}).subtype || '' };
    const qty = Number(q.quantity) || 0;
    if (qty === 0) continue;
    const p = currentByCode.get(code);
    const prevPrice = priceMap.get(prevDate + '|' + code);
    const lastPrice = liveEnd && p ? Number(p.price) : priceMap.get(currentDate + '|' + code);
    const isHk = q.subtype === '港股' || (p && p.subtype === '港股');
    if (!(prevPrice > 0) || !(lastPrice > 0) || (isHk && !(prevRate > 0 && lastRate > 0))) {
      missing.push(code);
      previousMarketValue.complete = false;
      continue;
    }
    const baseFx = isHk ? prevRate : 1;
    previousMarketValue.value += prevPrice * qty * baseFx;
    priceImpact.value += (lastPrice - prevPrice) * qty * baseFx;
    if (isHk) fxImpact.value += lastPrice * qty * (lastRate - prevRate);
  }
  const ledgerChange = { value: 0 };
  let currencyIncomplete = false;
  for (const f of (data.cashFlows || [])) {
    const d = dateKey(f.date);
    if (eventInInterval(f, d, prevDate, currentDate, prevAt, lastAt)) ledgerChange.value += Number(f.amount) || 0;
  }
  for (const t of (data.trades || [])) {
    const d = dateKey(t.trade_date || t.date);
    if (!eventInInterval(t, d, prevDate, currentDate, prevAt, lastAt) || t.direction === 'open' || t.direction === 'adjust') continue;
    const fee = (Number(t.commission) || 0) + (Number(t.stamp_tax) || 0) + (Number(t.transfer_fee) || 0) + (Number(t.other_fee) || 0);
    const rawAmountCny = t.amountCny != null && t.amountCny !== '' ? t.amountCny :
      (t.amount_cny != null && t.amount_cny !== '' ? t.amount_cny : null);
    const amountCny = rawAmountCny != null && Number.isFinite(Number(rawAmountCny)) ? Number(rawAmountCny) : null;
    if (amountCny == null && String(t.quote_currency || '').toUpperCase() === 'HKD') {
      currencyIncomplete = true;
      continue;
    }
    const settled = amountCny == null ? (Number(t.amount) || 0) : amountCny;
    ledgerChange.value += t.direction === 'buy' ? -settled - fee : settled - fee;
  }
  const lastTotal = liveEnd ? Number(currentTotal) : Number(last.totalAsset) || 0;
  // legacy/system 快照的 totalAsset 可能记录于实时价，之后 daily_prices 又被正式收盘价覆盖。
  // 用同一基准日的持仓收盘价、数量和现金重建期初总资产，避免把行情源切换误算成涨跌。
  let previousTotal = Number(previous.totalAsset) || 0;
  if (previous.snapshotSource !== 'imported' && previousMarketValue.complete) {
    const previousCash = cashAtSnapshot(data, prevDate, previous.snapshot_at);
    if (!previousCash.incomplete) previousTotal = previousCash.value + previousMarketValue.value;
  }
  const totalChange = lastTotal - previousTotal;
  const complete = missing.length === 0 && !currencyIncomplete;
  // 仅在“券商导入日 → 首个系统计算日”展示一次口径切换差异。
  // 正数表示系统导入时点持仓估值高于券商持仓总值，负数反之；后续不再保留此差额。
  const importBasisAdjustment = previous.snapshotSource === 'imported' && (liveEnd || last.snapshotSource !== 'imported') && currentDate > prevDate &&
    Number.isFinite(Number(previous.systemMarketValueAtSnapshot)) && Number.isFinite(Number(previous.marketValueCny))
    ? Number(previous.systemMarketValueAtSnapshot) - Number(previous.marketValueCny)
    : null;
  const drift = complete ? totalChange - priceImpact.value - fxImpact.value - ledgerChange.value - (importBasisAdjustment || 0) : null;
  return {
    complete,
    reason: complete ? null : (currencyIncomplete ? 'missing_trade_currency_settlement' : 'missing_exact_price_or_fx'),
    missingCodes: [...new Set(missing)],
    previousDate: prevDate,
    currentDate,
    previousTotalAsset: previousTotal,
    totalChange,
    priceImpact: priceImpact.value,
    fxImpact: fxImpact.value,
    ledgerChange: ledgerChange.value,
    importBasisAdjustment,
    snapshotDrift: drift,
    authorityMode: data.authoritativeTotalAsset != null,
  };
}

module.exports = { computeNavAttribution, dateKey };

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

  // 人工校准快照是对旧导入锚点的明确修订；同一账户存在更晚的校准快照时，
  // 必须优先使用它，否则旧批次会遮蔽修复后的基准数量。
  const importedDate = imported ? dateKey(imported.date) : '';
  const manualDates = snapshots
    .filter((s) => String(s.source || '') === 'manual_reconciliation')
    .map((s) => dateKey(s.snapshotDate || s.date))
    .filter((d) => d > importedDate);
  const latestManualDate = manualDates.length ? manualDates.reduce((max, d) => d > max ? d : max, '') : '';
  let rows = latestManualDate
    ? snapshots.filter((s) => String(s.source || '') === 'manual_reconciliation' &&
        dateKey(s.snapshotDate || s.date) === latestManualDate)
    : (imported && imported.importBatchId
      ? snapshots.filter((s) => String(s.snapshotId) === String(imported.importBatchId))
      : []);
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
  // 没有完整交易历史的持仓，按当前持仓补入；但基准日之后已经发生过交易的代码
  // 不能这样补入，否则会把“基准日后的新买入”错误地算成基准日已有持仓。
  for (const p of (data.positions || [])) {
    const code = String(p.code || '');
    if (!code || map.has(code)) continue;
    const hasFutureTrade = trades.some((t) => String(t.code || '') === code &&
      String(t.trade_date || t.date || '').slice(0, 10) > date);
    if (!hasFutureTrade) map.set(code, { quantity: Number(p.quantity) || 0, subtype: p.subtype || '' });
  }
  // 导入快照是历史锚点；若锚点之后到基准日没有交易，而当前持仓已被校正，
  // 以当前持仓现状为准，避免旧快照数量把合法的子账户拆分重复误判为重复交易。
  if (importedAnchor) {
    // 同一证券可能因分批持仓/导入拆分而有多行，必须先合并数量，
    // 不能逐行覆盖基准数量（否则最后一行会丢掉前面批次）。
    const currentByCode = aggregateCurrentPositions(data.positions);
    for (const [code, p] of currentByCode) {
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

function aggregateCurrentPositions(positions) {
  const map = new Map();
  for (const p of (positions || [])) {
    const code = String(p.code || '');
    if (!code) continue;
    const current = map.get(code);
    if (!current) {
      map.set(code, { ...p, code, quantity: Number(p.quantity) || 0 });
      continue;
    }
    current.quantity += Number(p.quantity) || 0;
    if (!current.price && Number(p.price) > 0) current.price = Number(p.price);
    if (!current.subtype && p.subtype) current.subtype = p.subtype;
    if (!current.name && p.name) current.name = p.name;
  }
  return map;
}

function tradePriceAtEnd(data, code, startDate, endDate, startAt, endAt) {
  const rows = (data.trades || []).filter((t) => String(t.code || '') === code &&
    t.direction === 'sell' && eventInInterval(t, dateKey(t.trade_date || t.date), startDate, endDate, startAt, endAt) &&
    Number(t.price) > 0).sort((a, b) => (eventTimestamp(a) || 0) - (eventTimestamp(b) || 0));
  return rows.length ? Number(rows[rows.length - 1].price) : null;
}

function priceAt(priceMap, date, code, isHk) {
  const variants = [code];
  // 历史导入可能把港股五位代码补成六位；只对已确认港股做兼容，避免误合并 A 股代码。
  if (isHk && /^\d{5}$/.test(code)) variants.push(code.padStart(6, '0'));
  for (const variant of variants) {
    const value = priceMap.get(date + '|' + variant);
    if (value != null) return value;
  }
  return null;
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
  // 已保存快照中的汇率是历史事实，行情表只能作为缺失时的明确回退，不能静默使用当前汇率。
  const rateAt = (date, nav) => Number(nav && nav.hkRate) > 0 ? Number(nav.hkRate) :
    (Number(fxByDate.get(date)) > 0 ? Number(fxByDate.get(date)) : null);
  const prevRate = rateAt(prevDate, previous);
  const lastRate = liveEnd && Number(data.hkRate) > 0 ? Number(data.hkRate) : rateAt(currentDate, last);
  const currentByCode = aggregateCurrentPositions(data.positions);
  const prevAt = timestamp(previous.snapshot_at);
  const lastAt = liveEnd ? Date.now() : timestamp(last.snapshot_at);
  const prevQty = quantityAsOf(data, prevDate, previous.snapshot_at);
  const priceImpact = { value: 0 };
  const fxImpact = { value: 0 };
  const quantityImpact = { value: 0 };
  const previousMarketValue = { value: 0, complete: true };
  const missing = [];
  const codes = new Set([...prevQty.keys(), ...currentByCode.keys()]);
  for (const code of codes) {
    const q = prevQty.get(code) || { quantity: 0, subtype: (currentByCode.get(code) || {}).subtype || '' };
    const qty = Number(q.quantity) || 0;
    const p = currentByCode.get(code);
    const isHk = q.subtype === '港股' || (p && p.subtype === '港股');
    const prevPrice = priceAt(priceMap, prevDate, code, isHk);
    const tradePrice = tradePriceAtEnd(data, code, prevDate, currentDate, prevAt, lastAt);
    const lastPrice = liveEnd && p ? Number(p.price) : priceAt(priceMap, currentDate, code, isHk);
    const endPrice = lastPrice > 0 ? lastPrice : tradePrice;
    const currentQty = p ? Number(p.quantity) || 0 : 0;
    if ((qty > 0 && (!(prevPrice > 0) || !(endPrice > 0))) || (currentQty > 0 && !(endPrice > 0)) ||
      ((qty > 0 || currentQty > 0) && isHk && !(prevRate > 0 && lastRate > 0))) {
      missing.push(code);
      previousMarketValue.complete = false;
      continue;
    }
    const baseFx = isHk ? prevRate : 1;
    const endFx = isHk ? lastRate : 1;
    if (qty > 0) {
      previousMarketValue.value += prevPrice * qty * baseFx;
      priceImpact.value += (endPrice - prevPrice) * qty * baseFx;
      if (isHk) fxImpact.value += endPrice * qty * (lastRate - prevRate);
    }
    // 数量变化归入交易/数量影响：新买入不要求基准日价格，清仓也不要求当前行情。
    quantityImpact.value += (currentQty - qty) * endPrice * endFx;
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
  const tradeImpact = ledgerChange.value + quantityImpact.value;
  const drift = complete ? totalChange - priceImpact.value - fxImpact.value - tradeImpact - (importBasisAdjustment || 0) : null;
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
    quantityImpact: quantityImpact.value,
    tradeImpact,
    importBasisAdjustment,
    snapshotDrift: drift,
    authorityMode: data.authoritativeTotalAsset != null,
  };
}

module.exports = { computeNavAttribution, dateKey };

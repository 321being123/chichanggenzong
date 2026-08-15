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

function quantityAsOf(data, date, snapshotAt) {
  const map = new Map();
  const trades = (data.trades || []).slice().sort((a, b) => {
    const ad = String(a.trade_date || a.date || '').slice(0, 10);
    const bd = String(b.trade_date || b.date || '').slice(0, 10);
    return ad.localeCompare(bd) || String(a.executed_at || a.date || '').localeCompare(String(b.executed_at || b.date || ''));
  });
  if (trades.length) {
    for (const t of trades) {
      const td = String(t.trade_date || t.date || '').slice(0, 10);
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
  const previous = navs[navs.length - 2];
  const prevDate = dateKey(previous.date);
  const lastDate = dateKey(last.date);
  const { rows: prices } = await pool.query(
    `SELECT date, code, price::float8 AS price FROM daily_prices
      WHERE username=$1 AND account_name=$2 AND date IN ($3,$4)`,
    [username, accountName, prevDate, lastDate]
  );
  const priceMap = new Map(prices.map(r => [dateKey(r.date) + '|' + String(r.code), Number(r.price)]));
  const { rows: fxRows } = await pool.query(
    `SELECT DISTINCT ON (rate_date) rate_date, rate::float8 AS rate FROM market.fx_rates
      WHERE base_currency='HKD' AND quote_currency='CNY' AND rate_date <= $1
      ORDER BY rate_date ASC, fetched_at DESC, source_id DESC`, [lastDate]
  );
  const fxByDate = new Map(fxRows.map(r => [dateKey(r.rate_date), Number(r.rate)]));
  const fallbackCurrent = Number(data.hkRate) > 0 ? Number(data.hkRate) : null;
  // 已保存快照中的汇率是历史事实，行情表只能作为缺失时的明确回退，不能静默覆盖。
  const rateAt = (date, nav) => Number(nav && nav.hkRate) > 0 ? Number(nav.hkRate) :
    (Number(fxByDate.get(date)) > 0 ? Number(fxByDate.get(date)) : fallbackCurrent);
  const prevRate = rateAt(prevDate, previous);
  const lastRate = rateAt(lastDate, last);
  const currentByCode = new Map((data.positions || []).map(p => [String(p.code), p]));
  const prevAt = timestamp(previous.snapshot_at);
  const liveEnd = lastDate === dateKey(new Date()) && currentTotal != null;
  const lastAt = liveEnd ? Date.now() : timestamp(last.snapshot_at);
  const prevQty = quantityAsOf(data, prevDate, previous.snapshot_at);
  const priceImpact = { value: 0 };
  const fxImpact = { value: 0 };
  const missing = [];
  const codes = new Set([...prevQty.keys(), ...currentByCode.keys()]);
  for (const code of codes) {
    const q = prevQty.get(code) || { quantity: 0, subtype: (currentByCode.get(code) || {}).subtype || '' };
    const qty = Number(q.quantity) || 0;
    if (qty === 0) continue;
    const p = currentByCode.get(code);
    const prevPrice = priceMap.get(prevDate + '|' + code);
    const lastPrice = lastDate === dateKey(new Date()) && p ? Number(p.price) : priceMap.get(lastDate + '|' + code);
    const isHk = q.subtype === '港股' || (p && p.subtype === '港股');
    if (!(prevPrice > 0) || !(lastPrice > 0) || (isHk && !(prevRate > 0 && lastRate > 0))) {
      missing.push(code);
      continue;
    }
    const baseFx = isHk ? prevRate : 1;
    priceImpact.value += (lastPrice - prevPrice) * qty * baseFx;
    if (isHk) fxImpact.value += lastPrice * qty * (lastRate - prevRate);
  }
  const ledgerChange = { value: 0 };
  let currencyIncomplete = false;
  for (const f of (data.cashFlows || [])) {
    const d = dateKey(f.date);
    if (eventInInterval(f, d, prevDate, lastDate, prevAt, lastAt)) ledgerChange.value += Number(f.amount) || 0;
  }
  for (const t of (data.trades || [])) {
    const d = dateKey(t.trade_date || t.date);
    if (!eventInInterval(t, d, prevDate, lastDate, prevAt, lastAt) || t.direction === 'open' || t.direction === 'adjust') continue;
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
  const lastTotal = lastDate === dateKey(new Date()) && currentTotal != null ? Number(currentTotal) : Number(last.totalAsset) || 0;
  const totalChange = lastTotal - (Number(previous.totalAsset) || 0);
  const complete = missing.length === 0 && !currencyIncomplete;
  const drift = complete ? totalChange - priceImpact.value - fxImpact.value - ledgerChange.value : null;
  return {
    complete,
    reason: complete ? null : (currencyIncomplete ? 'missing_trade_currency_settlement' : 'missing_exact_price_or_fx'),
    missingCodes: [...new Set(missing)],
    previousDate: prevDate,
    currentDate: lastDate,
    totalChange,
    priceImpact: priceImpact.value,
    fxImpact: fxImpact.value,
    ledgerChange: ledgerChange.value,
    snapshotDrift: drift,
    authorityMode: data.authoritativeTotalAsset != null,
  };
}

module.exports = { computeNavAttribution, dateKey };

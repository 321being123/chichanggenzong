const { pool } = require('../db/connection');
const txControl = require('../repositories/transactionControl');
const { getLatestCallState, getLatestCallStateBySecurityCodes, getLatestCallStateMap } = require('../repositories/convertibleBondRedemptionServiceRepository.js');
const repository = require('../repositories/convertibleBondRedemptionServiceRepository.js');

const FORMULA_VERSION = 'call-v1';

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function dateText(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const cn = new Date(value.getTime() + 8 * 60 * 60 * 1000);
    return `${cn.getUTCFullYear()}-${String(cn.getUTCMonth() + 1).padStart(2, '0')}-${String(cn.getUTCDate()).padStart(2, '0')}`;
  }
  return String(value).slice(0, 10);
}

function effectiveConversionPrice(currentPrice, changes, date) {
  let fallback = numberOrNull(currentPrice);
  for (const change of changes || []) {
    const changeDate = dateText(change.change_date);
    if (!changeDate) continue;
    if (date >= changeDate) return numberOrNull(change.price_after) ?? fallback;
    const before = numberOrNull(change.price_before);
    if (before != null) fallback = before;
  }
  return fallback;
}

function classifyProgress({ matchedDays, requiredDays, observationDays, expectedObservationDays = observationDays, bars = [], triggerPrice, closePrice, missingDates = [], suspendedDates = [], locked = false, notActive = false }) {
  if (locked || notActive) return { status: 'not_active', dataStatus: 'complete', distance: null };
  const unresolvedMissingDates = missingDates.filter(date => !suspendedDates.includes(date));
  if (!(requiredDays > 0) || !(observationDays > 0) || !(expectedObservationDays > 0) || !(triggerPrice > 0)
      || bars.length < expectedObservationDays || unresolvedMissingDates.length) {
    return { status: 'unknown', dataStatus: 'incomplete' };
  }
  return {
    status: matchedDays >= requiredDays ? 'met' : 'tracking',
    dataStatus: 'complete',
    distance: closePrice != null ? closePrice / triggerPrice - 1 : null,
  };
}

async function loadOpenTradeDates(targetDate, lookback = 180) {
  const { rows } = await repository.select_market_trade_calendar([targetDate, lookback]);
  return rows.map(row => dateText(row.trade_date)).filter(Boolean);
}

async function latestTradeDate() {
  const { rows } = await repository.select_market_convertible_bond_daily_metrics();
  return dateText(rows[0] && rows[0].trade_date);
}

async function calculateConvertibleBondCallStatus(tradeDate = null) {
  const targetDate = dateText(tradeDate) || await latestTradeDate();
  if (!targetDate) return { ok: false, status: 'no_data', tradeDate: null, count: 0, complete: 0, incomplete: 0 };

  const { rows: bonds } = await repository.select_core_instruments([targetDate]);
  const stockIds = [...new Set(bonds.map(row => row.stock_instrument_id).filter(Boolean))];
  const instrumentIds = bonds.map(row => row.instrument_id);
  const [barResult, changeResult] = await Promise.all([
    stockIds.length ? repository.select_market_daily_bars([stockIds, targetDate]) : { rows: [] },
    instrumentIds.length ? repository.select_fundamental_convertible_bond_price_changes([instrumentIds, targetDate]) : { rows: [] },
  ]);
  const barsByStock = new Map();
  for (const row of barResult.rows) {
    if (!barsByStock.has(row.instrument_id)) barsByStock.set(row.instrument_id, []);
    barsByStock.get(row.instrument_id).push({ trade_date: dateText(row.trade_date), close: numberOrNull(row.close) });
  }
  const changesByBond = new Map();
  for (const row of changeResult.rows) {
    if (!changesByBond.has(row.instrument_id)) changesByBond.set(row.instrument_id, []);
    changesByBond.get(row.instrument_id).push(row);
  }

  const openDates = await loadOpenTradeDates(targetDate, 180);
  if (!openDates.length) {
    throw new Error(`交易日历缺失：${targetDate}，请先同步 trade_cal`);
  }
  const suspensionResult = stockIds.length ? await repository.select_market_stock_suspend_calendar([stockIds, openDates]) : { rows: [] };
  const suspensionsByStock = new Map();
  for (const row of suspensionResult.rows) {
    if (!suspensionsByStock.has(row.instrument_id)) suspensionsByStock.set(row.instrument_id, new Set());
    suspensionsByStock.get(row.instrument_id).add(dateText(row.trade_date));
  }
  const results = [];
  for (const bond of bonds) {
    const observationDays = numberOrNull(bond.observation_days);
    const requiredDays = numberOrNull(bond.required_days);
    const ratio = numberOrNull(bond.trigger_ratio);
    const noCallUntil = dateText(bond.no_call_until) || (bond.validity_basis === 'through_maturity' ? dateText(bond.maturity_date) : null);
    const locked = bond.latest_event_type === 'waive' && (!noCallUntil || targetDate <= noCallUntil);
    const conversionStartDate = dateText(bond.conv_start_date);
    const preConversion = Boolean(conversionStartDate && targetDate < conversionStartDate);
    const eligibleDates = (locked || preConversion) ? [] : openDates
      .filter(date => (!conversionStartDate || date >= conversionStartDate) && (!noCallUntil || date > noCallUntil))
      .slice(0, observationDays);
    const stockBars = new Map((barsByStock.get(bond.stock_instrument_id) || []).map(row => [row.trade_date, row]));
    const missingDates = eligibleDates.filter(date => !stockBars.has(date));
    const suspendedDates = eligibleDates.filter(date => suspensionsByStock.get(bond.stock_instrument_id)?.has(date));
    const expectedObservationDays = eligibleDates.length - suspendedDates.length;
    const rows = eligibleDates.map(date => stockBars.get(date)).filter(Boolean);
    const changes = changesByBond.get(bond.instrument_id) || [];
    const prices = rows.map(row => ({
      ...row,
      conversion_price: effectiveConversionPrice(bond.current_conv_price, changes, row.trade_date),
    }));
    const matchedDays = (locked || preConversion) ? null : ratio != null
      ? prices.filter(row => row.conversion_price > 0 && row.close >= row.conversion_price * ratio).length
      : null;
    const currentConversionPrice = effectiveConversionPrice(bond.current_conv_price, changes, targetDate);
    const triggerPrice = ratio != null && currentConversionPrice > 0 ? currentConversionPrice * ratio : null;
    const closePrice = prices[0] ? prices[0].close : null;
    const calendarStatus = noCallUntil ? (openDates.some(date => date > noCallUntil) ? 'covered' : 'not_covered') : 'not_applicable';
    const derivedNextCountStartDate = noCallUntil ? openDates.filter(date => date > noCallUntil).sort()[0] || null : null;
    const explicitNextCountStartDate = dateText(bond.event_details && bond.event_details.next_count_start_date);
    const nextCountStartDate = explicitNextCountStartDate && noCallUntil && explicitNextCountStartDate > noCallUntil
      ? explicitNextCountStartDate : derivedNextCountStartDate;
    const classified = classifyProgress({ matchedDays, requiredDays, observationDays,
      expectedObservationDays, bars: prices, triggerPrice, closePrice, missingDates, suspendedDates, locked, notActive: preConversion });
    results.push({
      instrumentId: bond.instrument_id,
      tradeDate: targetDate,
      triggerPrice,
      closePrice,
      matchedDays,
      requiredDays,
      observationDays,
      status: classified.status,
      dataStatus: classified.dataStatus,
      diagnostics: {
        formula: FORMULA_VERSION,
        term_id: bond.term_id || null,
        stock_instrument_id: bond.stock_instrument_id || null,
        stock_bar_count: prices.length,
        expected_dates: eligibleDates,
        missing_dates: missingDates.filter(date => !suspendedDates.includes(date)),
        suspended_dates: suspendedDates,
        expected_observation_days: expectedObservationDays,
        eligible_from: eligibleDates.length ? eligibleDates[eligibleDates.length - 1] : null,
        conversion_start_date: conversionStartDate,
        pre_conversion: preConversion,
        no_call_until: noCallUntil,
        decision_date: dateText(bond.decision_date),
        lock_start_date: dateText(bond.lock_start_date),
        validity_basis: bond.validity_basis || null,
        lock_active: locked,
        calendar_status: calendarStatus,
        next_count_start_date: nextCountStartDate,
        data_quality_reason: preConversion ? '尚未进入转股期'
          : bond.event_details?.quality_reason || (calendarStatus === 'not_covered' && !locked ? '截止日后的交易日历尚未覆盖' : null),
        announcement_parse_status: bond.announcement_parse_status || null,
        conversion_change_count: changes.length,
        conversion_price_source: changes.length ? 'price_changes_plus_profile' : 'profile_current',
        distance_to_trigger_pct: classified.distance == null ? null : Number(classified.distance.toFixed(8)),
      },
    });
  }

  const client = await pool.connect();
  try {
    await txControl.begin(client);
    for (const row of results) {
      await repository.insert_analytics_convertible_bond_trigger_daily([row.instrumentId,row.tradeDate,row.triggerPrice,row.closePrice,row.matchedDays,row.requiredDays,
          row.observationDays,row.status,FORMULA_VERSION,JSON.stringify(row.diagnostics),row.dataStatus], client);
    }
    await txControl.commit(client);
  } catch (error) {
    await txControl.rollback(client);
    throw error;
  } finally {
    client.release();
  }
  return {
    ok: true,
    status: 'succeeded',
    tradeDate: targetDate,
    count: results.length,
    complete: results.filter(row => row.dataStatus === 'complete').length,
    incomplete: results.filter(row => row.dataStatus !== 'complete').length,
  };
}

function buildCallWhere({ status, query, date }) {
  const marketAsOf = `(SELECT COALESCE(MAX(trade_date), CURRENT_DATE) FROM market.convertible_bond_daily_metrics)`;
  const clauses = [
    `u.status='listed'`,
    `(u.issue_type IS NULL OR u.issue_type NOT IN ('定向','私募'))`,
    `(u.delist_date IS NULL OR u.delist_date > ${marketAsOf})`,
    `(u.maturity_date IS NULL OR u.maturity_date >= ${marketAsOf})`,
    `(u.conv_end_date IS NULL OR u.conv_end_date >= ${marketAsOf})`,
    `(u.conv_stop_date IS NULL OR u.conv_stop_date > ${marketAsOf})`,
  ];
  const values = [];
  if (status) { values.push(status); clauses.push(`c.business_status=$${values.length}`); }
  if (query) {
    values.push(`%${query}%`);
    const p = `$${values.length}`;
    clauses.push(`(c.security_code ILIKE ${p} OR c.ts_code ILIKE ${p} OR c.bond_name ILIKE ${p} OR c.stock_code ILIKE ${p} OR c.stock_name ILIKE ${p})`);
  }
  if (date) { values.push(date); clauses.push(`c.trade_date=$${values.length}::date`); }
  return { clauses, values };
}

async function getBondRedemptionOverview({ status = '', query = '', date = '', limit = 1000 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 1000, 1), 2000);
  const filter = buildCallWhere({ status: String(status || '').trim(), query: String(query || '').trim().slice(0, 50), date: dateText(date) });
  const base = `
    FROM analytics.convertible_bond_call_latest c
    JOIN public.bond_unified u ON u.instrument_id=c.instrument_id
    JOIN LATERAL (
      SELECT close,conversion_value,conversion_premium_pct,trade_date AS market_trade_date
       FROM market.convertible_bond_daily_metrics m
       WHERE m.instrument_id=c.instrument_id
         AND m.trade_date=(SELECT MAX(trade_date) FROM market.convertible_bond_daily_metrics)
       ORDER BY m.trade_date DESC LIMIT 1
    ) m ON true
   WHERE ${filter.clauses.join(' AND ')}`;
  const [rowsResult, summaryResult, marketDateResult, stateDateResult, expectedDateResult] = await Promise.all([
    pool.query(
      `SELECT c.instrument_id,c.ts_code,c.security_code,c.bond_name,c.stock_code,c.stock_name,
              m.close AS bond_close,m.market_trade_date,c.stock_close,c.current_conv_price,c.trigger_ratio,c.trigger_price,
              c.distance_to_trigger_pct,c.trade_date,c.matched_days,c.required_days,c.observation_days,
              c.remaining_days,c.calculated_status,c.official_status,c.business_status,c.data_status,c.diagnostics,
              c.announced_at,c.decision_date,c.lock_start_date,c.no_call_until,c.validity_basis,
              c.next_count_start_date,c.calendar_status,c.data_quality_reason,c.redemption_record_date,c.last_trade_date,
              c.last_conversion_date,c.redemption_price,c.source_url,c.announcement_title,
              c.announcement_parse_status,c.remain_size,c.maturity_date,c.conv_start_date,c.conv_end_date,
              c.calculated_at
         ${base}
        ORDER BY CASE c.business_status WHEN 'announced' THEN 1 WHEN 'maturity_redeem' THEN 2 WHEN 'maturity_near' THEN 3
                                       WHEN 'redemption_unconfirmed' THEN 4 WHEN 'met_pending' THEN 5
                                       WHEN 'near' THEN 6 WHEN 'tracking' THEN 7 WHEN 'waived' THEN 8 WHEN 'not_active' THEN 9 ELSE 10 END,
                 COALESCE(c.remaining_days,9999),c.security_code
        LIMIT $${filter.values.length + 1}`,
      [...filter.values, safeLimit]
    ),
    pool.query(
      `SELECT c.business_status,count(*)::int AS count
         ${base}
        GROUP BY c.business_status`, filter.values
    ),
    repository.select_market_convertible_bond_daily_metrics_1(),
    repository.select_analytics_convertible_bond_trigger_daily([FORMULA_VERSION]),
    repository.select_market_trade_calendar_1(),
  ]);
  const summary = { announced: 0, maturity_redeem: 0, redemption_unconfirmed: 0, met_pending: 0, near: 0, maturity_near: 0, tracking: 0, waived: 0, completed: 0, not_active: 0, incomplete: 0 };
  for (const row of summaryResult.rows) {
    if (Object.prototype.hasOwnProperty.call(summary, row.business_status)) summary[row.business_status] = row.count;
    else summary.incomplete += row.count;
  }
  const latestStateDate = dateText(stateDateResult.rows[0] && stateDateResult.rows[0].trade_date);
  const latestMarketDate = dateText(marketDateResult.rows[0] && marketDateResult.rows[0].trade_date);
  const expectedMarketDate = dateText(expectedDateResult.rows[0] && expectedDateResult.rows[0].trade_date);
  return {
    trade_date: latestStateDate || latestMarketDate,
    market_trade_date: latestMarketDate,
    stale: !latestMarketDate || !latestStateDate || latestStateDate < latestMarketDate
      || Boolean(expectedMarketDate && (!latestMarketDate || latestMarketDate < expectedMarketDate)),
    summary,
    data: rowsResult.rows.map(row => Object.assign({}, row, {
      business_status: row.business_status,
      trade_date: dateText(row.trade_date),
      market_trade_date: dateText(row.market_trade_date),
      no_call_until: dateText(row.no_call_until),
      decision_date: dateText(row.decision_date),
      lock_start_date: dateText(row.lock_start_date),
      next_count_start_date: dateText(row.next_count_start_date),
      redemption_record_date: dateText(row.redemption_record_date),
      last_trade_date: dateText(row.last_trade_date),
      last_conversion_date: dateText(row.last_conversion_date),
      maturity_date: dateText(row.maturity_date),
      conv_start_date: dateText(row.conv_start_date),
      conv_end_date: dateText(row.conv_end_date),
      calculated_at: row.calculated_at,
      remain_size: numberOrNull(row.remain_size) == null ? null : numberOrNull(row.remain_size) / 100000000,
    })),
  };
}

/* getLatestCallState 已迁入 server/repositories/convertibleBondRedemptionServiceRepository.js */

/* getLatestCallStateMap 已迁入 server/repositories/convertibleBondRedemptionServiceRepository.js */

/* getLatestCallStateBySecurityCodes 已迁入 server/repositories/convertibleBondRedemptionServiceRepository.js */

module.exports = {
  FORMULA_VERSION,
  effectiveConversionPrice,
  classifyProgress,
  calculateConvertibleBondCallStatus,
  getBondRedemptionOverview,
  getLatestCallState,
  getLatestCallStateMap,
  getLatestCallStateBySecurityCodes,
};

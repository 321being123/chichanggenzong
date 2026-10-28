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

const { buildCallWhere } = repository;

async function getBondRedemptionOverview({ status = '', query = '', date = '', limit = 1000 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 1000, 1), 2000);
  const filter = buildCallWhere({ status: String(status || '').trim(), query: String(query || '').trim().slice(0, 50), date: dateText(date) });
  const [rowsResult, summaryResult, marketDateResult, stateDateResult, expectedDateResult] = await Promise.all([
    repository.listCallOverviewRows({ filter, safeLimit }),
    repository.listCallOverviewSummary({ filter }),
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

const { pool } = require('../db/connection');

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

function classifyProgress({ matchedDays, requiredDays, observationDays, expectedObservationDays = observationDays, bars, triggerPrice, closePrice, missingDates = [], suspendedDates = [] }) {
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
  const { rows } = await pool.query(
    `SELECT trade_date::text
       FROM market.trade_calendar
      WHERE exchange='SSE' AND is_open AND trade_date <= $1::date
      ORDER BY trade_date DESC LIMIT $2`, [targetDate, lookback]
  );
  return rows.map(row => dateText(row.trade_date)).filter(Boolean);
}

async function latestTradeDate() {
  const { rows } = await pool.query(
    `SELECT MAX(trade_date)::text AS trade_date
       FROM market.convertible_bond_daily_metrics`
  );
  return dateText(rows[0] && rows[0].trade_date);
}

async function calculateConvertibleBondCallStatus(tradeDate = null) {
  const targetDate = dateText(tradeDate) || await latestTradeDate();
  if (!targetDate) return { ok: false, status: 'no_data', tradeDate: null, count: 0, complete: 0, incomplete: 0 };

  const { rows: bonds } = await pool.query(
    `SELECT i.instrument_id,i.canonical_code,p.stock_instrument_id,p.current_conv_price,
            p.remain_size,p.maturity_date,p.conv_start_date,p.conv_end_date,p.conv_stop_date,
            term.trigger_ratio,term.observation_days,term.required_days,term.term_id,
            latest_event.event_type AS latest_event_type,latest_event.no_call_until
       FROM core.instruments i
       JOIN fundamental.convertible_bond_profiles p ON p.instrument_id=i.instrument_id
       JOIN public.bond_unified u ON u.instrument_id=i.instrument_id
       JOIN market.convertible_bond_daily_metrics dm
         ON dm.instrument_id=i.instrument_id AND dm.trade_date=$1::date
       LEFT JOIN LATERAL (
         SELECT term_id,trigger_ratio,observation_days,required_days
           FROM fundamental.convertible_bond_terms
          WHERE instrument_id=i.instrument_id AND term_type='call'
            AND effective_from <= $1::date
            AND (effective_to IS NULL OR effective_to > $1::date)
          ORDER BY effective_from DESC,term_id DESC LIMIT 1
       ) term ON true
       LEFT JOIN LATERAL (
         SELECT event_type,no_call_until
           FROM event.convertible_bond_call_events
          WHERE instrument_id=i.instrument_id
          ORDER BY announced_at DESC,event_id DESC LIMIT 1
       ) latest_event ON true
      WHERE i.asset_class='convertible_bond'
        AND i.status='listed'
        AND u.status='listed'
        AND (i.list_date IS NULL OR i.list_date <= $1::date)
        AND (i.delist_date IS NULL OR i.delist_date > $1::date)
        AND (u.maturity_date IS NULL OR u.maturity_date >= $1::date)
        AND (u.conv_end_date IS NULL OR u.conv_end_date >= $1::date)
        AND (u.conv_stop_date IS NULL OR u.conv_stop_date > $1::date)`,
    [targetDate]
  );
  const stockIds = [...new Set(bonds.map(row => row.stock_instrument_id).filter(Boolean))];
  const instrumentIds = bonds.map(row => row.instrument_id);
  const [barResult, changeResult] = await Promise.all([
    stockIds.length ? pool.query(
    `SELECT instrument_id,trade_date::text,close
         FROM (
           SELECT instrument_id,trade_date,close,
                  ROW_NUMBER() OVER (PARTITION BY instrument_id ORDER BY trade_date DESC) AS rn
             FROM (
               SELECT instrument_id,trade_date,close,
                      ROW_NUMBER() OVER (PARTITION BY instrument_id,trade_date ORDER BY source_id DESC) AS source_rn
                 FROM market.daily_bars
                WHERE instrument_id=ANY($1::bigint[])
                  AND trade_date <= $2::date
                  AND trade_date >= ($2::date - INTERVAL '365 days')
                  AND close > 0
             ) daily
            WHERE source_rn=1
         ) x
        WHERE rn <= 180
        ORDER BY instrument_id,trade_date DESC`, [stockIds, targetDate]
    ) : { rows: [] },
    instrumentIds.length ? pool.query(
      `SELECT instrument_id,change_date::text,price_before,price_after
         FROM fundamental.convertible_bond_price_changes
        WHERE instrument_id=ANY($1::bigint[]) AND change_date <= $2::date
        ORDER BY instrument_id,change_date DESC`, [instrumentIds, targetDate]
    ) : { rows: [] },
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
  const suspensionResult = stockIds.length ? await pool.query(
    `SELECT instrument_id,trade_date::text,suspend_type
       FROM market.stock_suspend_calendar
      WHERE instrument_id=ANY($1::bigint[])
        AND trade_date=ANY($2::date[])
        AND suspend_type='S'`, [stockIds, openDates]
  ) : { rows: [] };
  const suspensionsByStock = new Map();
  for (const row of suspensionResult.rows) {
    if (!suspensionsByStock.has(row.instrument_id)) suspensionsByStock.set(row.instrument_id, new Set());
    suspensionsByStock.get(row.instrument_id).add(dateText(row.trade_date));
  }
  const results = [];
  for (const bond of bonds) {
    const observationDays = numberOrNull(bond.observation_days) || 30;
    const requiredDays = numberOrNull(bond.required_days) || 15;
    const ratio = numberOrNull(bond.trigger_ratio);
    const noCallUntil = dateText(bond.no_call_until);
    const eligibleDates = openDates
      .filter(date => !noCallUntil || date > noCallUntil)
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
    const matchedDays = ratio != null
      ? prices.filter(row => row.conversion_price > 0 && row.close >= row.conversion_price * ratio).length
      : null;
    const currentConversionPrice = effectiveConversionPrice(bond.current_conv_price, changes, targetDate);
    const triggerPrice = ratio != null && currentConversionPrice > 0 ? currentConversionPrice * ratio : null;
    const closePrice = prices[0] ? prices[0].close : null;
    const classified = classifyProgress({ matchedDays, requiredDays, observationDays,
      expectedObservationDays, bars: prices, triggerPrice, closePrice, missingDates, suspendedDates });
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
        no_call_until: noCallUntil,
        conversion_change_count: changes.length,
        conversion_price_source: changes.length ? 'price_changes_plus_profile' : 'profile_current',
        distance_to_trigger_pct: classified.distance == null ? null : Number(classified.distance.toFixed(8)),
      },
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const row of results) {
      await client.query(
        `INSERT INTO analytics.convertible_bond_trigger_daily
           (instrument_id,trade_date,trigger_type,trigger_price,close_price,matched_days,required_days,observation_days,status,formula_version,diagnostics,data_status)
         VALUES($1,$2,'call',$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)
         ON CONFLICT(instrument_id,trade_date,trigger_type,formula_version) DO UPDATE SET
           trigger_price=EXCLUDED.trigger_price,close_price=EXCLUDED.close_price,
           matched_days=EXCLUDED.matched_days,required_days=EXCLUDED.required_days,
           observation_days=EXCLUDED.observation_days,status=EXCLUDED.status,
           diagnostics=EXCLUDED.diagnostics,data_status=EXCLUDED.data_status,calculated_at=now()`,
        [row.instrumentId,row.tradeDate,row.triggerPrice,row.closePrice,row.matchedDays,row.requiredDays,
          row.observationDays,row.status,FORMULA_VERSION,JSON.stringify(row.diagnostics),row.dataStatus]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
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
              c.remaining_days,c.calculated_status,c.official_status,c.business_status,c.data_status,
              c.announced_at,c.no_call_until,c.redemption_record_date,c.last_trade_date,
              c.last_conversion_date,c.redemption_price,c.source_url,c.announcement_title,
              c.announcement_parse_status,c.remain_size,c.maturity_date,c.conv_start_date,c.conv_end_date,
              c.calculated_at
         ${base}
        ORDER BY CASE c.business_status WHEN 'announced' THEN 1 WHEN 'maturity_near' THEN 2 WHEN 'met_pending' THEN 3
                                       WHEN 'near' THEN 4 WHEN 'tracking' THEN 5 WHEN 'waived' THEN 6 ELSE 7 END,
                 COALESCE(c.remaining_days,9999),c.security_code
        LIMIT $${filter.values.length + 1}`,
      [...filter.values, safeLimit]
    ),
    pool.query(
      `SELECT c.business_status,count(*)::int AS count
         ${base}
        GROUP BY c.business_status`, filter.values
    ),
    pool.query(`SELECT MAX(trade_date)::text AS trade_date FROM market.convertible_bond_daily_metrics`),
    pool.query(`SELECT MAX(trade_date)::text AS trade_date
                  FROM analytics.convertible_bond_trigger_daily
                 WHERE trigger_type='call' AND formula_version=$1`, [FORMULA_VERSION]),
    pool.query(`SELECT MAX(trade_date)::text AS trade_date
                  FROM market.trade_calendar
                 WHERE exchange='SSE' AND is_open
                   AND trade_date <= (now() AT TIME ZONE 'Asia/Shanghai')::date`),
  ]);
  const summary = { announced: 0, met_pending: 0, near: 0, maturity_near: 0, tracking: 0, waived: 0, completed: 0, incomplete: 0 };
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

async function getLatestCallState(instrumentId) {
  const { rows } = await pool.query(
    `SELECT * FROM analytics.convertible_bond_call_latest WHERE instrument_id=$1 LIMIT 1`, [instrumentId]
  );
  return rows[0] || null;
}

async function getLatestCallStateMap(instrumentIds) {
  const ids = [...new Set((instrumentIds || []).map(Number).filter(Number.isInteger))];
  if (!ids.length) return new Map();
  const { rows } = await pool.query(
    `SELECT * FROM analytics.convertible_bond_call_latest WHERE instrument_id=ANY($1::bigint[])`, [ids]
  );
  return new Map(rows.map(row => [Number(row.instrument_id), row]));
}

async function getLatestCallStateBySecurityCodes(codes) {
  const normalized = [...new Set((codes || []).map(value => String(value || '').trim().toUpperCase().replace(/\.(SH|SZ|BJ|HK)$/, '')).filter(Boolean))];
  if (!normalized.length) return new Map();
  const { rows } = await pool.query(
    `SELECT * FROM analytics.convertible_bond_call_latest
      WHERE security_code=ANY($1::text[])`, [normalized]
  );
  return new Map(rows.map(row => [String(row.security_code || '').toUpperCase(), row]));
}

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

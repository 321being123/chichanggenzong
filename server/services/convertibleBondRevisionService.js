// 可转债下修监控：统一计算层与只读列表查询。
// 页面只读取 analytics.convertible_bond_revision_latest；公告、行情和计算均在后台任务中完成。
const { pool } = require('../db');

const FORMULA_VERSION = 'reset-v2';
const OVERLAP_DAYS = 3;
const NEAR_REMAINING_DAYS = 5;
const REVISION_SELECT_FIELDS = [
  'business_status','security_code','ts_code','bond_name','bond_close','remain_size','stock_instrument_id',
  'stock_name','stock_code','current_conv_price','conversion_value','conversion_premium_pct',
  'net_asset_floor_applicable','trigger_ratio','trigger_price','distance_to_trigger_pct','matched_days','required_days','remaining_days',
  'observation_days','no_revision_announced_at','no_revision_valid_until','next_eligible_date','official_announced_at',
  'meeting_date','price_after','effective_date','reached_floor','reset_clause','official_source_url','official_source_number',
  'official_title','official_summary','trade_date','maturity_date','conv_start_date','conv_end_date',
  'conv_stop_date','issue_type',
].map(field => `r.${field}`).join(',');

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
  const text = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function addDays(value, days) {
  const date = new Date(`${dateText(value)}T00:00:00+08:00`);
  date.setUTCDate(date.getUTCDate() + days);
  return dateText(date);
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

function isValidTerm(term) {
  return term && term.parse_status === 'complete'
    && numberOrNull(term.trigger_ratio) > 0
    && numberOrNull(term.observation_days) > 0
    && numberOrNull(term.required_days) > 0
    && Number(term.required_days) <= Number(term.observation_days)
    && (term.revision_direction || 'down') === 'down';
}

async function latestRevisionTradeDate() {
  const { rows } = await pool.query(
    `SELECT MAX(trade_date)::text AS trade_date FROM market.convertible_bond_daily_metrics`
  );
  return dateText(rows[0] && rows[0].trade_date);
}

async function loadOpenTradeDates(targetDate, limit = 180) {
  const { rows } = await pool.query(
    `SELECT trade_date::text FROM market.trade_calendar
      WHERE exchange='SSE' AND is_open AND trade_date <= $1::date
      ORDER BY trade_date DESC LIMIT $2`, [targetDate, limit]
  );
  return rows.map(row => dateText(row.trade_date)).filter(Boolean);
}

async function loadRevisionBonds(targetDate) {
  const { rows } = await pool.query(
    `SELECT i.instrument_id,i.canonical_code AS ts_code,p.stock_instrument_id,p.current_conv_price,
            p.remain_size,p.maturity_date,p.conv_start_date,p.conv_end_date,p.conv_stop_date,
            term.term_id,term.trigger_ratio,term.observation_days,term.required_days,term.effective_from,
            term.clause_text,term.revision_direction,term.comparison_operator,term.parse_status,term.parser_version,
            term.net_asset_floor_applicable,no_revision.announced_at AS no_revision_announced_at,
            no_revision.valid_until AS no_revision_valid_until,no_revision.next_eligible_date
       FROM core.instruments i
       JOIN fundamental.convertible_bond_profiles p ON p.instrument_id=i.instrument_id
       JOIN public.bond_unified u ON u.instrument_id=i.instrument_id
       LEFT JOIN fundamental.convertible_bond_issuance iss ON iss.instrument_id=i.instrument_id
       LEFT JOIN LATERAL (
         SELECT term_id,trigger_ratio,observation_days,required_days,effective_from,clause_text,
                revision_direction,comparison_operator,parse_status,parser_version,net_asset_floor_applicable
           FROM fundamental.convertible_bond_terms
          WHERE instrument_id=i.instrument_id AND term_type='reset'
            AND effective_from <= $1::date AND (effective_to IS NULL OR effective_to > $1::date)
          ORDER BY effective_from DESC,term_id DESC LIMIT 1
       ) term ON true
       LEFT JOIN LATERAL (
         SELECT announced_at,valid_until,next_eligible_date
           FROM fundamental.convertible_bond_no_revision_history
          WHERE instrument_id=i.instrument_id AND announced_at <= $1::date
          ORDER BY announced_at DESC,history_id DESC LIMIT 1
       ) no_revision ON true
      WHERE i.asset_class='convertible_bond' AND i.status='listed' AND u.status='listed'
        AND (u.issue_type IS NULL OR u.issue_type NOT IN ('定向','私募'))
        AND (iss.issue_type IS NULL OR iss.issue_type NOT IN ('定向','私募'))
        AND EXISTS (
          SELECT 1 FROM market.convertible_bond_daily_metrics active_dm
           WHERE active_dm.instrument_id=i.instrument_id AND active_dm.trade_date=$1::date
        )
        AND (i.list_date IS NULL OR i.list_date <= $1::date)
        AND (i.delist_date IS NULL OR i.delist_date > $1::date)
        AND (p.maturity_date IS NULL OR p.maturity_date >= $1::date)
        AND (p.conv_end_date IS NULL OR p.conv_end_date >= $1::date)
        AND (p.conv_stop_date IS NULL OR p.conv_stop_date > $1::date)
      ORDER BY i.canonical_code`, [targetDate]
  );
  return rows;
}

async function loadStockBars(stockIds, targetDate) {
  if (!stockIds.length) return new Map();
  const { rows } = await pool.query(
    `SELECT instrument_id,trade_date::text,close
       FROM (
         SELECT instrument_id,trade_date,close,
                ROW_NUMBER() OVER (PARTITION BY instrument_id ORDER BY trade_date DESC) AS rn
           FROM (
             SELECT instrument_id,trade_date,close,
                    ROW_NUMBER() OVER (PARTITION BY instrument_id,trade_date ORDER BY source_id DESC) AS source_rn
               FROM market.daily_bars
              WHERE instrument_id=ANY($1::bigint[]) AND trade_date <= $2::date
                AND trade_date >= ($2::date - INTERVAL '365 days') AND close > 0
           ) daily
          WHERE source_rn=1
       ) x
      WHERE rn <= 180 ORDER BY instrument_id,trade_date DESC`, [stockIds, targetDate]
  );
  const result = new Map();
  for (const row of rows) {
    if (!result.has(row.instrument_id)) result.set(row.instrument_id, []);
    result.get(row.instrument_id).push({ trade_date: dateText(row.trade_date), close: numberOrNull(row.close) });
  }
  return result;
}

async function loadPriceChanges(instrumentIds, targetDate) {
  if (!instrumentIds.length) return new Map();
  const { rows } = await pool.query(
    `SELECT instrument_id,change_date::text,price_before,price_after,
            raw_payload->>'revision_floor_price' AS revision_floor_price
       FROM fundamental.convertible_bond_price_changes
      WHERE instrument_id=ANY($1::bigint[]) AND change_date <= $2::date
      ORDER BY instrument_id,change_date DESC`, [instrumentIds, targetDate]
  );
  const result = new Map();
  for (const row of rows) {
    if (!result.has(row.instrument_id)) result.set(row.instrument_id, []);
    result.get(row.instrument_id).push(row);
  }
  return result;
}

async function loadLatestStockMetrics(stockIds, targetDate) {
  const ids = [...new Set((stockIds || []).map(Number).filter(Number.isSafeInteger))];
  if (!ids.length) return new Map();
  const [bars, valuations] = await Promise.all([
    pool.query(
      `SELECT DISTINCT ON (instrument_id) instrument_id,trade_date::text,close
         FROM market.daily_bars
        WHERE instrument_id=ANY($1::bigint[]) AND trade_date <= COALESCE($2::date,CURRENT_DATE) AND close > 0
        ORDER BY instrument_id,trade_date DESC,source_id DESC`, [ids, targetDate || null]
    ),
    pool.query(
      `SELECT DISTINCT ON (instrument_id) instrument_id,trade_date::text,pb
         FROM market.daily_valuations
        WHERE instrument_id=ANY($1::bigint[]) AND trade_date <= COALESCE($2::date,CURRENT_DATE)
        ORDER BY instrument_id,trade_date DESC,source_id DESC`, [ids, targetDate || null]
    ),
  ]);
  const result = new Map();
  for (const row of bars.rows) result.set(String(row.instrument_id), {
    stock_trade_date: dateText(row.trade_date), stock_close: numberOrNull(row.close),
  });
  for (const row of valuations.rows) {
    const key = String(row.instrument_id);
    if (!result.has(key)) result.set(key, {});
    result.get(key).stock_pb = numberOrNull(row.pb);
  }
  return result;
}

async function loadSuspensions(stockIds, openDates) {
  if (!stockIds.length || !openDates.length) return new Map();
  const { rows } = await pool.query(
    `SELECT instrument_id,trade_date::text FROM market.stock_suspend_calendar
      WHERE instrument_id=ANY($1::bigint[]) AND trade_date=ANY($2::date[]) AND suspend_type='S'`,
    [stockIds, openDates]
  );
  const result = new Map();
  for (const row of rows) {
    if (!result.has(row.instrument_id)) result.set(row.instrument_id, new Set());
    result.get(row.instrument_id).add(dateText(row.trade_date));
  }
  return result;
}

function buildResetResult(bond, stockBars, changes, openDates, suspensions) {
  const ratio = numberOrNull(bond.trigger_ratio);
  const observationDays = numberOrNull(bond.observation_days);
  const requiredDays = numberOrNull(bond.required_days);
  const currentPrice = effectiveConversionPrice(bond.current_conv_price, changes, openDates[0]);
  const triggerPrice = ratio != null && currentPrice > 0 ? currentPrice * ratio : null;
  const nextEligible = dateText(bond.next_eligible_date);
  const locked = nextEligible && openDates[0] < nextEligible;
  const startDate = [dateText(bond.effective_from), dateText(bond.conv_start_date)].filter(Boolean).sort().pop() || null;
  if (!isValidTerm(bond) || !bond.stock_instrument_id || !openDates.length) {
    return {
      instrumentId: bond.instrument_id, tradeDate: openDates[0], triggerPrice, closePrice: null,
      matchedDays: null, requiredDays, observationDays, status: 'unknown', dataStatus: 'incomplete',
      diagnostics: { formula: FORMULA_VERSION, reason: !isValidTerm(bond) ? 'invalid_reset_term' : 'missing_trade_calendar', term_id: bond.term_id || null },
    };
  }
  if (locked) {
    return {
      instrumentId: bond.instrument_id, tradeDate: openDates[0], triggerPrice, closePrice: null,
      matchedDays: 0, requiredDays, observationDays, status: 'not_active', dataStatus: 'complete',
      diagnostics: { formula: FORMULA_VERSION, term_id: bond.term_id || null, no_revision_until: bond.next_eligible_date,
        eligible_from: nextEligible, locked: true },
    };
  }
  if (startDate && openDates[0] < startDate) {
    return {
      instrumentId: bond.instrument_id, tradeDate: openDates[0], triggerPrice, closePrice: null,
      matchedDays: 0, requiredDays, observationDays, status: 'not_active', dataStatus: 'complete',
      diagnostics: { formula: FORMULA_VERSION, term_id: bond.term_id || null, eligible_from: startDate, not_started: true },
    };
  }

  const eligibleDates = openDates.filter(date => !startDate || date >= startDate).slice(0, observationDays);
  const suspendedSet = suspensions || new Set();
  const stockMap = new Map((stockBars || []).map(row => [row.trade_date, row]));
  const missingDates = eligibleDates.filter(date => !stockMap.has(date) && !suspendedSet.has(date));
  const suspendedDates = eligibleDates.filter(date => suspendedSet.has(date));
  const rows = eligibleDates.map(date => stockMap.get(date)).filter(Boolean).map(row => ({
    ...row,
    conversion_price: effectiveConversionPrice(bond.current_conv_price, changes, row.trade_date),
  }));
  const matchedDays = ratio != null
    ? rows.filter(row => row.conversion_price > 0 && row.close < row.conversion_price * ratio).length : null;
  const closePrice = rows[0] ? rows[0].close : null;
  const dataStatus = missingDates.length || rows.length < eligibleDates.length - suspendedDates.length ? 'incomplete' : 'complete';
  const status = dataStatus !== 'complete' ? 'unknown' : (matchedDays >= requiredDays ? 'met' : 'tracking');
  return {
    instrumentId: bond.instrument_id, tradeDate: openDates[0], triggerPrice, closePrice, matchedDays,
    requiredDays, observationDays, status, dataStatus,
    diagnostics: {
      formula: FORMULA_VERSION, term_id: bond.term_id || null, stock_instrument_id: bond.stock_instrument_id || null,
      expected_dates: eligibleDates, missing_dates: missingDates, suspended_dates: suspendedDates,
      stock_bar_count: rows.length, expected_observation_days: eligibleDates.length - suspendedDates.length,
      eligible_from: eligibleDates[eligibleDates.length - 1] || null, next_eligible_date: nextEligible,
      conversion_change_count: changes.length, conversion_price_source: changes.length ? 'price_changes_plus_profile' : 'profile_current',
      distance_to_trigger_pct: closePrice != null && triggerPrice > 0 ? Number((closePrice / triggerPrice - 1).toFixed(8)) : null,
    },
  };
}

async function calculateConvertibleBondRevisionStatus(tradeDate = null) {
  const targetDate = dateText(tradeDate) || await latestRevisionTradeDate();
  if (!targetDate) return { ok: false, status: 'no_data', tradeDate: null, count: 0, complete: 0, incomplete: 0 };
  const bonds = await loadRevisionBonds(targetDate);
  const stockIds = [...new Set(bonds.map(row => row.stock_instrument_id).filter(Boolean))];
  const instrumentIds = bonds.map(row => row.instrument_id);
  const [openDates, stockBars, changes] = await Promise.all([
    loadOpenTradeDates(targetDate), loadStockBars(stockIds, targetDate), loadPriceChanges(instrumentIds, targetDate),
  ]);
  if (!openDates.length) throw new Error(`交易日历缺失：${targetDate}，请先同步 trade_cal`);
  const suspensions = await loadSuspensions(stockIds, openDates);
  const results = bonds.map(bond => buildResetResult(
    bond, stockBars.get(bond.stock_instrument_id) || [], changes.get(bond.instrument_id) || [],
    openDates, suspensions.get(bond.stock_instrument_id) || new Set()
  ));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const row of results) {
      await client.query(
        `INSERT INTO analytics.convertible_bond_trigger_daily
         (instrument_id,trade_date,trigger_type,trigger_price,close_price,matched_days,required_days,observation_days,status,formula_version,diagnostics,data_status)
         VALUES($1,$2,'reset',$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)
         ON CONFLICT(instrument_id,trade_date,trigger_type,formula_version) DO UPDATE SET
           trigger_price=EXCLUDED.trigger_price,close_price=EXCLUDED.close_price,matched_days=EXCLUDED.matched_days,
           required_days=EXCLUDED.required_days,observation_days=EXCLUDED.observation_days,status=EXCLUDED.status,
           diagnostics=EXCLUDED.diagnostics,data_status=EXCLUDED.data_status,calculated_at=now()` ,
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
  return { ok: true, status: 'succeeded', tradeDate: targetDate, count: results.length,
    complete: results.filter(row => row.dataStatus === 'complete').length,
    incomplete: results.filter(row => row.dataStatus !== 'complete').length };
}

function buildRevisionWhere({ status = '', query = '', near = false } = {}) {
  const clauses = [
    `r.business_status IS NOT NULL`,
    `(r.issue_type IS NULL OR r.issue_type NOT IN ('定向','私募'))`,
  ];
  const values = [];
  if (status) { values.push(status); clauses.push(`r.business_status=$${values.length}`); }
  if (near) clauses.push(`r.business_status IN ('near','met_pending','proposed','meeting_pending','approved')`);
  if (query) {
    values.push(`%${query}%`);
    const p = `$${values.length}`;
    clauses.push(`(r.security_code ILIKE ${p} OR r.ts_code ILIKE ${p} OR r.bond_name ILIKE ${p} OR r.stock_code ILIKE ${p} OR r.stock_name ILIKE ${p})`);
  }
  return { clauses, values };
}

async function getBondRevisionOverview({ status = '', query = '', near = false, limit = 2000 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 2000, 1), 2000);
  const filter = buildRevisionWhere({ status: String(status || '').trim(), query: String(query || '').trim().slice(0, 50), near: Boolean(near) });
  const base = `FROM analytics.convertible_bond_revision_latest r WHERE ${filter.clauses.join(' AND ')}`;
  const [rowsResult, summaryResult, marketResult, stateResult] = await Promise.all([
    // 视图包含多组最新行情 CTE；在 PostgreSQL 端对视图排序会触发高成本重算。
    // 先按过滤条件取出公开范围，再在内存中排序和截断，避免接口超时。
    pool.query(`SELECT ${REVISION_SELECT_FIELDS} ${base}`, filter.values),
    pool.query(`SELECT r.business_status,count(*)::int AS count ${base} GROUP BY r.business_status`, filter.values),
    pool.query(`SELECT MAX(trade_date)::text AS trade_date FROM market.convertible_bond_daily_metrics`),
    pool.query(`SELECT MAX(trade_date)::text AS trade_date FROM analytics.convertible_bond_trigger_daily WHERE trigger_type='reset' AND formula_version=$1`, [FORMULA_VERSION]),
  ]);
  const summary = { implemented: 0, approved: 0, meeting_pending: 0, proposed: 0, terminated: 0,
    met_pending: 0, near: 0, locked: 0, tracking: 0, incomplete: 0 };
  for (const row of summaryResult.rows) {
    if (Object.prototype.hasOwnProperty.call(summary, row.business_status)) summary[row.business_status] = row.count;
    else summary.incomplete += row.count;
  }
  const marketDate = dateText(marketResult.rows[0] && marketResult.rows[0].trade_date);
  const stateDate = dateText(stateResult.rows[0] && stateResult.rows[0].trade_date);
  const stockMetrics = await loadLatestStockMetrics(rowsResult.rows.map(row => row.stock_instrument_id), marketDate);
  const statusOrder = { proposed: 1, meeting_pending: 2, approved: 3, met_pending: 4, near: 5,
    locked: 6, tracking: 7, implemented: 8 };
  const sortedRows = rowsResult.rows.slice().sort((a, b) =>
    (statusOrder[a.business_status] || 9) - (statusOrder[b.business_status] || 9)
      || (numberOrNull(a.remaining_days) ?? 9999) - (numberOrNull(b.remaining_days) ?? 9999)
      || String(a.security_code || '').localeCompare(String(b.security_code || ''))
  ).slice(0, safeLimit);
  return {
    trade_date: stateDate || marketDate, market_trade_date: marketDate,
    stale: Boolean(marketDate && (!stateDate || stateDate < marketDate)), summary,
    data: sortedRows.map(row => Object.assign({}, row, stockMetrics.get(String(row.stock_instrument_id)) || {}, {
      trade_date: dateText(row.trade_date), stock_trade_date: dateText(row.stock_trade_date),
      no_revision_announced_at: dateText(row.no_revision_announced_at), no_revision_valid_until: dateText(row.no_revision_valid_until),
      next_eligible_date: dateText(row.next_eligible_date), official_announced_at: dateText(row.official_announced_at),
      meeting_date: dateText(row.meeting_date), record_date: dateText(row.record_date), effective_date: dateText(row.effective_date),
      maturity_date: dateText(row.maturity_date), conv_start_date: dateText(row.conv_start_date),
      conv_end_date: dateText(row.conv_end_date), conv_stop_date: dateText(row.conv_stop_date),
      remain_size: numberOrNull(row.remain_size) == null ? null : numberOrNull(row.remain_size) / 100000000,
    })),
  };
}

module.exports = {
  FORMULA_VERSION, OVERLAP_DAYS, NEAR_REMAINING_DAYS,
  dateText, addDays, effectiveConversionPrice, isValidTerm, buildResetResult,
  calculateConvertibleBondRevisionStatus, getBondRevisionOverview,
};

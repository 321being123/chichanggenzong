// 可转债下修监控：统一计算层与只读列表查询。
// 页面只读取 analytics.convertible_bond_revision_latest；公告、行情和计算均在后台任务中完成。
const { pool } = require('../db');
const { MOTIVE_MODEL_VERSION } = require('./convertibleBondRevisionMotiveService');
const { getDatasetMetadata } = require('./datasetPartitions');

const FORMULA_VERSION = 'reset-v2';
const CALCULATION_LOGIC_VERSION = 'reset-logic-20260830-1';
const OVERLAP_DAYS = 3;
const NEAR_REMAINING_DAYS = 5;
const REVISION_SELECT_FIELDS = [
  'business_status','security_code','ts_code','bond_name','bond_close','remain_size','stock_instrument_id',
  'stock_name','stock_code','current_conv_price','conversion_value','conversion_premium_pct',
  'net_asset_floor_applicable','net_asset_floor_value','net_asset_floor_blocked','trigger_ratio','trigger_price','distance_to_trigger_pct','matched_days','required_days','remaining_days','rolling_remaining_days',
  'observation_days','minimum_future_days','no_revision_announced_at','no_revision_valid_until','next_eligible_date','official_announced_at',
  'meeting_date','price_after','effective_date','reached_floor','official_source_url','official_source_number',
  'official_title','official_summary','trade_date','maturity_date','conv_start_date','conv_end_date',
  'conv_stop_date','issue_type','official_event_type',
].map(field => `r.${field}`).join(',');
const MOTIVE_SELECT_FIELDS = `motive.motive_level,motive.trade_date AS motive_trade_date,motive.motive_score,
  motive.research_percentile,motive.model_version AS motive_model_version,motive.model_version AS model_version,
  motive.quality_status AS motive_quality_status,motive.executability_status AS motive_executability_status`;

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
  const ordered = (changes || []).filter(change => dateText(change.change_date))
    .slice().sort((a, b) => dateText(b.change_date).localeCompare(dateText(a.change_date)));
  // 最新主档转股价是当前交易日的权威值，可避免公告正文提取到中间价格后污染最新观察窗口。
  if (ordered.length && date >= dateText(ordered[0].change_date)) return fallback;
  for (const change of ordered) {
    const changeDate = dateText(change.change_date);
    if (date >= changeDate) return numberOrNull(change.price_after) ?? fallback;
    const before = numberOrNull(change.price_before);
    if (before != null) fallback = before;
  }
  return fallback;
}

function successfulRevisionStartDate(changes, targetDate) {
  return (changes || []).filter(change => {
    const changeDate = dateText(change.change_date);
    const reason = String(change.reason || '');
    return changeDate && changeDate <= targetDate
      && /(?:向下修正|下修)/.test(reason)
      && !/(?:不向下修正|不下修|预计|提示|提议|议案)/.test(reason);
  }).map(change => dateText(change.change_date)).sort().pop() || null;
}

function implicitSseNoRevisionRestartDate(bond, stockBars, changes, openDates, startDate, responses = []) {
  if (!/\.SH$/i.test(String(bond && bond.ts_code || '')) || !isValidTerm(bond) || !openDates.length) return null;
  const ratio = numberOrNull(bond.trigger_ratio);
  const observationDays = numberOrNull(bond.observation_days);
  const requiredDays = numberOrNull(bond.required_days);
  const targetDate = openDates[0];
  const orderedDates = openDates.slice().reverse().filter(date => !startDate || date >= startDate);
  const stockMap = new Map((stockBars || []).map(row => [dateText(row.trade_date), numberOrNull(row.close)]));
  const responseRows = (responses || []).map(row => ({
    event_type: String(row.event_type || ''), announced_at: dateText(row.announced_at),
  })).filter(row => row.announced_at);
  let cycleStart = startDate || orderedDates[0];
  let latestRestart = null;
  while (cycleStart && cycleStart <= targetDate) {
    const cycleDates = orderedDates.filter(date => date >= cycleStart);
    let triggerDate = null;
    for (let index = 0; index < cycleDates.length; index += 1) {
      const date = cycleDates[index];
      const windowStart = Math.max(0, index - observationDays + 1);
      const flags = cycleDates.slice(windowStart, index + 1).map(item => {
        const close = stockMap.get(item);
        const conversionPrice = effectiveConversionPrice(bond.current_conv_price, changes, item);
        return close != null && conversionPrice > 0 && close < conversionPrice * ratio;
      });
      if (flags.filter(Boolean).length >= requiredDays) {
        triggerDate = date;
        break;
      }
    }
    if (!triggerDate) break;
    const triggerIndex = orderedDates.indexOf(triggerDate);
    const nextDate = triggerIndex >= 0 && triggerIndex + 1 < orderedDates.length
      ? orderedDates[triggerIndex + 1] : null;
    // 触发发生在当前交易日，次一交易日尚未到达时不能提前视为“不修正”。
    if (!nextDate || nextDate > targetDate) break;
    const hasResponse = responseRows.some(row => row.announced_at >= triggerDate
      && row.announced_at <= nextDate && row.event_type !== 'trigger_notice');
    if (hasResponse) break;
    latestRestart = nextDate;
    cycleStart = nextDate;
  }
  return latestRestart;
}

async function loadRevisionResponseHistory(instrumentIds, targetDate) {
  const result = new Map();
  if (!instrumentIds.length) return result;
  const [events, noRevision] = await Promise.all([
    pool.query(
      `SELECT instrument_id,event_type,announced_at::text
         FROM event.convertible_bond_revision_events
        WHERE instrument_id=ANY($1::bigint[]) AND announced_at <= $2::date
        ORDER BY instrument_id,announced_at,event_id`, [instrumentIds, targetDate]
    ),
    pool.query(
      `SELECT instrument_id,'no_revision' AS event_type,announced_at::text
         FROM fundamental.convertible_bond_no_revision_history
        WHERE instrument_id=ANY($1::bigint[]) AND announced_at <= $2::date
        ORDER BY instrument_id,announced_at,history_id`, [instrumentIds, targetDate]
    ),
  ]);
  for (const row of [...events.rows, ...noRevision.rows]) {
    if (!result.has(row.instrument_id)) result.set(row.instrument_id, []);
    result.get(row.instrument_id).push(row);
  }
  return result;
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
    `SELECT i.instrument_id,i.canonical_code AS ts_code,i.list_date,p.stock_instrument_id,p.current_conv_price,
            p.remain_size,p.value_date,p.maturity_date,p.conv_start_date,p.conv_end_date,p.conv_stop_date,
            term.term_id,term.trigger_ratio,term.observation_days,term.required_days,term.effective_from,
            term.clause_text,term.revision_direction,term.comparison_operator,term.parse_status,term.parser_version,
            term.net_asset_floor_applicable,no_revision.announced_at AS no_revision_announced_at,
            no_revision.valid_until AS no_revision_valid_until,no_revision.next_eligible_date,
            no_revision.lock_declared AS no_revision_lock_declared
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
         SELECT announced_at,valid_until,
                COALESCE((SELECT MIN(tc.trade_date)
                            FROM market.trade_calendar tc
                           WHERE tc.exchange='SSE' AND tc.is_open
                             AND nr0.next_eligible_date >= (SELECT MIN(tc0.trade_date)
                                                             FROM market.trade_calendar tc0
                                                            WHERE tc0.exchange='SSE' AND tc0.is_open)
                             AND tc.trade_date >= nr0.next_eligible_date), nr0.next_eligible_date) AS next_eligible_date,
                COALESCE((raw_payload->>'lock_declared')::boolean,false) AS lock_declared
           FROM fundamental.convertible_bond_no_revision_history nr0
          WHERE nr0.instrument_id=i.instrument_id AND nr0.announced_at <= $1::date
          ORDER BY nr0.announced_at DESC,nr0.history_id DESC LIMIT 1
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
    `SELECT instrument_id,change_date::text,price_before,price_after,reason,
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
    const item = result.get(key);
    item.stock_pb = numberOrNull(row.pb);
    // Tushare daily_basic 的 PB 采用最近一期已披露净资产，收盘价 / PB
    // 可还原同一口径的每股净资产；必须与 PB 使用同一交易日，避免行情水位错位。
    const valuationTradeDate = dateText(row.trade_date);
    item.net_asset_floor_value = item.stock_trade_date === valuationTradeDate
      && item.stock_close > 0 && item.stock_pb > 0
      ? Number((item.stock_close / item.stock_pb).toFixed(8)) : null;
    item.net_asset_floor_trade_date = valuationTradeDate;
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
  const netAssetFloorApplicable = bond.net_asset_floor_applicable === true || String(bond.net_asset_floor_applicable || '').toLowerCase() === 'true';
  const netAssetFloorValue = numberOrNull(bond.net_asset_floor_value);
  // 募集说明书约定转股价不得低于每股净资产；当前转股价已经不高于
  // 净资产时，数学上虽可能满足触发条件，但实际没有可执行的下修空间。
  const netAssetFloorBlocked = netAssetFloorApplicable && currentPrice > 0
    && netAssetFloorValue != null && currentPrice <= netAssetFloorValue;
  const nextEligible = dateText(bond.next_eligible_date);
  const locked = nextEligible ? openDates[0] < nextEligible : Boolean(bond.no_revision_lock_declared);
  // 下修条款写的是“存续期间”，但上市前没有可交易的转债观察样本，不能把上市前
  // 正股行情计入窗口；起点取发行/条款生效日与上市日的较晚者。转股开始日仍不是门槛。
  // 现有历史数据把初始条款 effective_from 写成上市日，优先回到 value_date，再与 list_date 取较晚者。
  const termDate = dateText(bond.effective_from);
  const listDate = dateText(bond.list_date);
  const valueDate = dateText(bond.value_date);
  const baseStart = valueDate && (!termDate || termDate === listDate || termDate === '0001-01-01')
    ? valueDate : (termDate || valueDate || listDate);
  const revisionStart = successfulRevisionStartDate(changes, openDates[0]);
  const calculationStart = [baseStart, listDate, revisionStart, ...(locked ? [] : [nextEligible])]
    .filter(Boolean).sort().pop() || null;
  const implicitRestart = locked ? null
    : implicitSseNoRevisionRestartDate(bond, stockBars, changes, openDates, calculationStart, bond.revision_responses || []);
  // 不下修锁定只影响业务状态，不应把历史观察窗口清空。集思录仍展示锁定前的
  // 数学进度；只有已知的下一次可起算日且当前未锁定时，才从该日期重新起算。
  const startDate = [calculationStart, implicitRestart]
    .filter(Boolean).sort().pop() || null;
  if (!isValidTerm(bond) || !bond.stock_instrument_id || !openDates.length) {
    return {
      instrumentId: bond.instrument_id, tradeDate: openDates[0], triggerPrice, closePrice: null,
      matchedDays: null, requiredDays, observationDays, minimumFutureDays: null, status: 'unknown', dataStatus: 'incomplete',
      diagnostics: { formula: FORMULA_VERSION, calculation_logic_version: CALCULATION_LOGIC_VERSION, reason: !isValidTerm(bond) ? 'invalid_reset_term' : 'missing_trade_calendar', term_id: bond.term_id || null },
    };
  }
  if (startDate && openDates[0] < startDate) {
    return {
      instrumentId: bond.instrument_id, tradeDate: openDates[0], triggerPrice, closePrice: null,
      matchedDays: 0, requiredDays, observationDays, minimumFutureDays: null, status: 'not_active', dataStatus: 'complete',
      diagnostics: { formula: FORMULA_VERSION, calculation_logic_version: CALCULATION_LOGIC_VERSION, term_id: bond.term_id || null, eligible_from: startDate, not_started: true,
        start_date_source: valueDate && baseStart === valueDate ? 'value_date' : 'term_effective_from' },
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
  const status = locked ? 'not_active'
    : (dataStatus !== 'complete' ? 'unknown' : (netAssetFloorBlocked ? 'floor_blocked'
      : (matchedDays >= requiredDays ? 'met' : 'tracking')));
  let minimumFutureDays = null;
  if (dataStatus === 'complete' && ratio != null && requiredDays != null && observationDays != null) {
    const rowByDate = new Map(rows.map(row => [row.trade_date, row]));
    const suspended = new Set(suspendedDates);
    const currentFlags = eligibleDates.slice().reverse().map(date => {
      if (suspended.has(date)) return null;
      const row = rowByDate.get(date);
      return Boolean(row && row.conversion_price > 0 && row.close < row.conversion_price * ratio);
    });
    // 下修观察是滚动窗口：旧的达标日会在新交易日进入后退出窗口，不能简单用 required-matched。
    for (let futureDays = 0; futureDays <= observationDays + requiredDays + 1; futureDays += 1) {
      const flags = currentFlags.concat(Array(futureDays).fill(true)).slice(-observationDays);
      if (flags.filter(Boolean).length >= requiredDays) {
        minimumFutureDays = futureDays;
        break;
      }
    }
  }
  return {
    instrumentId: bond.instrument_id, tradeDate: openDates[0], triggerPrice, closePrice, matchedDays,
    requiredDays, observationDays, minimumFutureDays, status, dataStatus,
    diagnostics: {
      formula: FORMULA_VERSION, calculation_logic_version: CALCULATION_LOGIC_VERSION, minimum_future_days_algorithm: 'rolling-v1', term_id: bond.term_id || null, stock_instrument_id: bond.stock_instrument_id || null,
      expected_dates: eligibleDates, missing_dates: missingDates, suspended_dates: suspendedDates,
      stock_bar_count: rows.length, expected_observation_days: eligibleDates.length - suspendedDates.length,
      eligible_from: eligibleDates[eligibleDates.length - 1] || null, next_eligible_date: nextEligible,
      conversion_change_count: changes.length, conversion_price_source: changes.length ? 'price_changes_plus_profile' : 'profile_current',
      successful_revision_start_date: revisionStart,
      implicit_sse_no_revision_restart_date: implicitRestart,
      net_asset_floor_applicable: netAssetFloorApplicable,
      net_asset_floor_value: netAssetFloorValue,
      net_asset_floor_source: netAssetFloorValue != null ? 'stock_close_div_pb' : null,
      net_asset_floor_trade_date: bond.net_asset_floor_trade_date || null,
      net_asset_floor_blocked: netAssetFloorBlocked,
      locked: locked || undefined,
      no_revision_until: locked ? nextEligible : undefined,
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
  const [openDates, stockBars, changes, stockMetrics, responseHistory] = await Promise.all([
    loadOpenTradeDates(targetDate), loadStockBars(stockIds, targetDate), loadPriceChanges(instrumentIds, targetDate),
    loadLatestStockMetrics(stockIds, targetDate), loadRevisionResponseHistory(instrumentIds, targetDate),
  ]);
  if (!openDates.length) throw new Error(`交易日历缺失：${targetDate}，请先同步 trade_cal`);
  const suspensions = await loadSuspensions(stockIds, openDates);
  const results = bonds.map(bond => {
    const metrics = stockMetrics.get(String(bond.stock_instrument_id)) || {};
    return buildResetResult(
      { ...bond, ...metrics, revision_responses: responseHistory.get(bond.instrument_id) || [] },
      stockBars.get(bond.stock_instrument_id) || [], changes.get(bond.instrument_id) || [],
    openDates, suspensions.get(bond.stock_instrument_id) || new Set()
    );
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const row of results) {
      await client.query(
        `INSERT INTO analytics.convertible_bond_trigger_daily
         (instrument_id,trade_date,trigger_type,trigger_price,close_price,matched_days,required_days,observation_days,minimum_future_days,status,formula_version,diagnostics,data_status)
         VALUES($1,$2,'reset',$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
         ON CONFLICT(instrument_id,trade_date,trigger_type,formula_version) DO UPDATE SET
           trigger_price=EXCLUDED.trigger_price,close_price=EXCLUDED.close_price,matched_days=EXCLUDED.matched_days,
           required_days=EXCLUDED.required_days,observation_days=EXCLUDED.observation_days,minimum_future_days=EXCLUDED.minimum_future_days,status=EXCLUDED.status,
           diagnostics=EXCLUDED.diagnostics,data_status=EXCLUDED.data_status,calculated_at=now()` ,
        [row.instrumentId,row.tradeDate,row.triggerPrice,row.closePrice,row.matchedDays,row.requiredDays,
          row.observationDays,row.minimumFutureDays,row.status,FORMULA_VERSION,JSON.stringify(row.diagnostics),row.dataStatus]
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
  const base = `FROM analytics.convertible_bond_revision_latest r
    LEFT JOIN LATERAL (
      SELECT motive_level,trade_date,motive_score,model_version,quality_status,executability_status,
             (SELECT count(*) FILTER (WHERE peer.motive_score <= md.motive_score)::numeric / NULLIF(count(*),0)
                FROM analytics.convertible_bond_revision_motive_daily peer
               WHERE peer.trade_date=md.trade_date AND peer.model_version=md.model_version) AS research_percentile
        FROM analytics.convertible_bond_revision_motive_daily md
       WHERE md.instrument_id=r.instrument_id AND md.model_version='${MOTIVE_MODEL_VERSION}'
       ORDER BY md.trade_date DESC,md.calculated_at DESC LIMIT 1
    ) motive ON true
    WHERE ${filter.clauses.join(' AND ')}`;
  const order = `ORDER BY CASE r.business_status
      WHEN 'proposed' THEN 1 WHEN 'meeting_pending' THEN 2 WHEN 'approved' THEN 3
      WHEN 'met_pending' THEN 4 WHEN 'near' THEN 5 WHEN 'locked' THEN 6
      WHEN 'floor_blocked' THEN 7 WHEN 'tracking' THEN 8 WHEN 'implemented' THEN 9 ELSE 10 END,
    COALESCE(r.remaining_days,9999),r.security_code LIMIT $${filter.values.length + 1}`;
  const [rowsResult, summaryResult, marketResult, stateResult, expectedResult, qualityResult] = await Promise.all([
    // 视图已按当前交易日行情和单券索引取数，排序与截断交给数据库完成。
    pool.query(`SELECT ${REVISION_SELECT_FIELDS},${MOTIVE_SELECT_FIELDS} ${base} ${order}`, [...filter.values, safeLimit]),
    pool.query(`SELECT r.business_status,count(*)::int AS count ${base} GROUP BY r.business_status`, filter.values),
    pool.query(`SELECT MAX(trade_date)::text AS trade_date FROM market.convertible_bond_daily_metrics`),
    pool.query(`SELECT MAX(trade_date)::text AS trade_date FROM analytics.convertible_bond_trigger_daily WHERE trigger_type='reset' AND formula_version=$1`, [FORMULA_VERSION]),
    pool.query(`SELECT MAX(trade_date)::text AS trade_date
                  FROM market.trade_calendar
                 WHERE exchange='SSE' AND is_open
                   AND trade_date <= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date`),
    pool.query(`WITH latest_no_revision AS (
                  SELECT DISTINCT ON (instrument_id)
                         instrument_id,parser_version,next_eligible_date,raw_payload
                    FROM analytics.convertible_bond_announcement_history
                   WHERE fact_type='no_revision'
                   ORDER BY instrument_id,announced_at DESC,fact_id DESC
                )
                SELECT
                  (SELECT COUNT(*)::int FROM latest_no_revision
                    WHERE next_eligible_date IS NULL
                      AND (parser_version IS DISTINCT FROM '7'
                           OR NOT (COALESCE((raw_payload->>'no_revision_evidence')::boolean,false)
                                   OR COALESCE((raw_payload->>'lock_declared')::boolean,false)))
                      AND COALESCE(raw_payload->'reparse'->>'status','') <> 'failed') AS pending_no_revision_parse,
                  (SELECT COUNT(*)::int FROM latest_no_revision
                    WHERE next_eligible_date IS NULL
                      AND (parser_version IS DISTINCT FROM '7'
                           OR NOT (COALESCE((raw_payload->>'no_revision_evidence')::boolean,false)
                                   OR COALESCE((raw_payload->>'lock_declared')::boolean,false)))
                      AND COALESCE(raw_payload->'reparse'->>'status','') = 'failed') AS terminal_no_revision_parse,
                  (SELECT COUNT(*)::int FROM ops.sync_cursors
                    WHERE scope_key='convertible_bond_announcement_history'
                      AND dataset_code='official_announcements'
                      AND NULLIF(last_error,'') IS NOT NULL) AS announcement_errors`),
  ]);
  const summary = { implemented: 0, approved: 0, meeting_pending: 0, proposed: 0, terminated: 0,
    met_pending: 0, near: 0, locked: 0, floor_blocked: 0, tracking: 0, incomplete: 0 };
  for (const row of summaryResult.rows) {
    if (Object.prototype.hasOwnProperty.call(summary, row.business_status)) summary[row.business_status] = row.count;
    else summary.incomplete += row.count;
  }
  const marketDate = dateText(marketResult.rows[0] && marketResult.rows[0].trade_date);
  const stateDate = dateText(stateResult.rows[0] && stateResult.rows[0].trade_date);
  const expectedDate = dateText(expectedResult.rows[0] && expectedResult.rows[0].trade_date);
  const qualityRow = qualityResult.rows[0] || {};
  const quality = {
    status: (Number(qualityRow.pending_no_revision_parse || 0) > 0 || Number(qualityRow.announcement_errors || 0) > 0) ? 'degraded' : 'ok',
    pending_no_revision_parse: Number(qualityRow.pending_no_revision_parse || 0),
    terminal_no_revision_parse: Number(qualityRow.terminal_no_revision_parse || 0),
    announcement_errors: Number(qualityRow.announcement_errors || 0),
  };
  const stockMetrics = await loadLatestStockMetrics(rowsResult.rows.map(row => row.stock_instrument_id), marketDate);
  const partition = await getDatasetMetadata('bond_daily', 'CN');
  return {
    trade_date: stateDate || marketDate, market_trade_date: marketDate, expected_trade_date: expectedDate,
    data_as_of: partition.data_as_of || stateDate || marketDate,
    published_at: partition.published_at,
    is_stale: Boolean(partition.is_stale || quality.status === 'degraded' || (expectedDate && (!marketDate || marketDate < expectedDate || !stateDate || stateDate < marketDate))),
    stale_reason: partition.stale_reason || (quality.status === 'degraded' ? '质量检查未通过' : ''),
    stale: Boolean(partition.is_stale || quality.status === 'degraded' || (expectedDate && (!marketDate || marketDate < expectedDate || !stateDate || stateDate < marketDate))),
    quality, summary,
    data: rowsResult.rows.map(row => Object.assign({}, row, stockMetrics.get(String(row.stock_instrument_id)) || {}, {
      trade_date: dateText(row.trade_date), stock_trade_date: dateText(row.stock_trade_date),
      no_revision_announced_at: dateText(row.no_revision_announced_at), no_revision_valid_until: dateText(row.no_revision_valid_until),
      next_eligible_date: dateText(row.next_eligible_date), official_announced_at: dateText(row.official_announced_at),
      meeting_date: dateText(row.meeting_date), record_date: dateText(row.record_date), effective_date: dateText(row.effective_date),
      maturity_date: dateText(row.maturity_date), conv_start_date: dateText(row.conv_start_date),
      conv_end_date: dateText(row.conv_end_date), conv_stop_date: dateText(row.conv_stop_date),
      remain_size: numberOrNull(row.remain_size) == null ? null : numberOrNull(row.remain_size) / 100000000,
      research_percentile: numberOrNull(row.research_percentile),
      research_level: numberOrNull(row.motive_score) == null || numberOrNull(row.research_percentile) == null ? 'unavailable'
        : numberOrNull(row.research_percentile) >= 0.8 ? 'relative_high'
          : numberOrNull(row.research_percentile) >= 0.4 ? 'relative_medium' : 'relative_low',
    })),
  };
}

module.exports = {
  FORMULA_VERSION, CALCULATION_LOGIC_VERSION, OVERLAP_DAYS, NEAR_REMAINING_DAYS,
  dateText, addDays, effectiveConversionPrice, successfulRevisionStartDate, implicitSseNoRevisionRestartDate, isValidTerm, buildResetResult,
  calculateConvertibleBondRevisionStatus, getBondRevisionOverview,
};

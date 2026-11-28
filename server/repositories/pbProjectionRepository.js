// PB 两步按月投影仓储（2026-11-27）。
//
// 只做 SQL 与投影事实读写，不在这里做业务判断。选源口径必须与
// `stockSelectionRepository.loadPbWindow` 的原 SQL 逐字一致：
//   仅取 pb IS NOT NULL；ORDER BY CASE WHEN s.source_code LIKE 'lixinger%' THEN 0 ELSE 1 END, v.source_id
// 任何改动都会让投影与原始 daily_valuations 的 15 项证据出现差异，必须同时改等价测试。
'use strict';

const { pool } = require('../db/connection');

const MARKET_CONFIG = Object.freeze({
  CN: { calendarExchanges: ['SSE'] },
  HK: { calendarExchanges: ['HKEX'] },
});

function marketConfig(market) {
  const config = MARKET_CONFIG[String(market || '').toUpperCase()];
  if (!config) {
    const error = new Error('市场参数不合法');
    error.status = 400;
    throw error;
  }
  return config;
}

function executorOf(tx) {
  if (!tx) return (sql, params) => pool.query(sql, params);
  return (sql, params) => tx.query(sql, params);
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function monthLabel(year, month) {
  return `${year}-${pad2(month)}`;
}

/** 生成 [fromDate, toDate] 覆盖的自然月列表（含首尾，供整月重算）。 */
function monthsBetween(fromDate, toDate) {
  const start = String(fromDate || '').slice(0, 10);
  const end = String(toDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) return [];
  let year = Number(start.slice(0, 4));
  let month = Number(start.slice(5, 7));
  const endYear = Number(end.slice(0, 4));
  const endMonth = Number(end.slice(5, 7));
  const months = [];
  while (year < endYear || (year === endYear && month <= endMonth)) {
    months.push({ year, month });
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }
  return months;
}

function uniqueMonthList(months) {
  const seen = new Set();
  const list = [];
  for (const item of months || []) {
    const year = Number(item && item.year);
    const month = Number(item && item.month);
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) continue;
    const key = monthLabel(year, month);
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({ year, month });
  }
  return list.sort((a, b) => (a.year - b.year) || (a.month - b.month));
}

function monthRangeStart(months) {
  const list = uniqueMonthList(months);
  if (!list.length) return null;
  return `${monthLabel(list[0].year, list[0].month)}-01`;
}

function monthRangeEnd(months) {
  const list = uniqueMonthList(months);
  if (!list.length) return null;
  const last = list[list.length - 1];
  const date = new Date(Date.UTC(last.year, last.month, 0));
  return date.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// 投影重建
// ---------------------------------------------------------------------------

/**
 * 重建每日唯一选源。删除后重插而不是逐股加减，避免删除/改源留下幽灵行。
 * 只处理 market 下 asset_class='stock' 且排除腾讯基金 ETF 的证券，口径与 loadPbWindow 的 inst 一致。
 */
async function rebuildPickedRange({ market, fromDate, toDate, instrumentIds = null }, tx) {
  const config = marketConfig(market);
  const exec = executorOf(tx);
  const scoped = Array.isArray(instrumentIds) && instrumentIds.length
    ? Array.from(new Set(instrumentIds.map(id => Number(id)).filter(Number.isFinite)))
    : null;
  await exec(`
    DELETE FROM analytics.stock_daily_pb_picked p
     WHERE p.market = $1 AND p.trade_date >= $2::date AND p.trade_date <= $3::date
       AND ($4::bigint[] IS NULL OR p.instrument_id = ANY($4::bigint[]))`,
  [market, fromDate, toDate, scoped]);
  const inserted = await exec(`
    INSERT INTO analytics.stock_daily_pb_picked (instrument_id, trade_date, market, source_id, pb)
    SELECT DISTINCT ON (v.instrument_id, v.trade_date)
           v.instrument_id, v.trade_date, $1, v.source_id, v.pb
      FROM market.daily_valuations v
      JOIN core.instruments i ON i.instrument_id = v.instrument_id
      JOIN market.trade_calendar c ON c.trade_date = v.trade_date
      LEFT JOIN ops.data_sources s ON s.source_id = v.source_id
     WHERE i.market = $1 AND i.asset_class = 'stock'
       AND COALESCE(i.raw_data->>'identity_backfill', '') <> 'tencent_quote_fund_etf'
       AND v.trade_date >= $2::date AND v.trade_date <= $3::date
       AND v.pb IS NOT NULL
       AND c.exchange = ANY($5::text[]) AND COALESCE(c.is_open, true) = true
       AND ($4::bigint[] IS NULL OR v.instrument_id = ANY($4::bigint[]))
     ORDER BY v.instrument_id, v.trade_date,
              CASE WHEN s.source_code LIKE 'lixinger%' THEN 0 ELSE 1 END, v.source_id
    ON CONFLICT (instrument_id, trade_date) DO UPDATE SET
      market = EXCLUDED.market, source_id = EXCLUDED.source_id,
      pb = EXCLUDED.pb, picked_at = now()`,
  [market, fromDate, toDate, scoped, config.calendarExchanges]);
  return Number(inserted.rowCount || 0);
}

/**
 * 重建市场估值日。严格对齐原 marketDays 口径：基于 market.daily_valuations，
 * 只按证券 market 过滤，不滤 pb、不限制 asset_class、不看交易日历。
 */
async function rebuildMarketTradeDates({ market, fromDate, toDate }, tx) {
  const exec = executorOf(tx);
  await exec(`
    DELETE FROM analytics.market_pb_trade_dates d
     WHERE d.market = $1 AND d.trade_date >= $2::date AND d.trade_date <= $3::date`,
  [market, fromDate, toDate]);
  const inserted = await exec(`
    INSERT INTO analytics.market_pb_trade_dates (market, trade_date, instrument_count)
    SELECT $1, v.trade_date, COUNT(DISTINCT v.instrument_id)::int
      FROM market.daily_valuations v
      JOIN core.instruments i ON i.instrument_id = v.instrument_id
     WHERE i.market = $1 AND v.trade_date >= $2::date AND v.trade_date <= $3::date
     GROUP BY v.trade_date`,
  [market, fromDate, toDate]);
  return Number(inserted.rowCount || 0);
}

/**
 * 重建单个自然月的 15 项汇总。必须是「整月重算」：
 * listed_days 依赖交易日历与 list_date，exempt_days 依赖停牌日历与当日缺失的 PB，
 * 二者都不是静态常数，逐日加减会在日历/主档/停牌变更后永久漂移。
 */
async function rebuildMonthlySummaryMonth({ market, year, month, instrumentIds = null }, tx) {
  const config = marketConfig(market);
  const exec = executorOf(tx);
  const scoped = Array.isArray(instrumentIds) && instrumentIds.length
    ? Array.from(new Set(instrumentIds.map(id => Number(id)).filter(Number.isFinite)))
    : null;
  const monthStart = `${monthLabel(year, month)}-01`;
  // 先清掉本月已不属于本市场可评估集合的旧汇总（证券合并/市场迁移后的幽灵行）。
  await exec(`
    DELETE FROM analytics.instrument_pb_monthly_summary s
     WHERE s.market = $1 AND s.cal_year = $2::smallint AND s.cal_month = $3::smallint
       AND ($4::bigint[] IS NULL OR s.instrument_id = ANY($4::bigint[]))
       AND NOT EXISTS (
         SELECT 1 FROM core.instruments i
          WHERE i.instrument_id = s.instrument_id
            AND i.market = $1 AND i.asset_class = 'stock'
            AND COALESCE(i.raw_data->>'identity_backfill', '') <> 'tencent_quote_fund_etf'
            AND ($4::bigint[] IS NULL OR i.instrument_id = ANY($4::bigint[])))`,
  [market, year, month, scoped]);
  const result = await exec(`
    WITH inst AS (
      SELECT instrument_id, COALESCE(list_date, DATE '1900-01-01') AS list_date
        FROM core.instruments
       WHERE market = $1 AND asset_class = 'stock'
         AND COALESCE(raw_data->>'identity_backfill', '') <> 'tencent_quote_fund_etf'
         AND ($4::bigint[] IS NULL OR instrument_id = ANY($4::bigint[]))
    ),
    cal AS (
      SELECT trade_date FROM market.trade_calendar
       WHERE exchange = ANY($5::text[]) AND COALESCE(is_open, true) = true
         AND trade_date >= $6::date
         AND trade_date < ($6::date + INTERVAL '1 month')
    ),
    exempt AS (
      SELECT sc.instrument_id, COUNT(DISTINCT sc.trade_date)::int AS exempt_days
        FROM market.stock_suspend_calendar sc
        JOIN cal c ON c.trade_date = sc.trade_date
       WHERE sc.suspend_type = 'S'
         AND NOT EXISTS (
               SELECT 1 FROM analytics.stock_daily_pb_picked p
                WHERE p.instrument_id = sc.instrument_id AND p.trade_date = sc.trade_date)
       GROUP BY 1
    ),
    listed AS (
      SELECT i.instrument_id, COUNT(c.trade_date)::int AS listed_days
        FROM inst i LEFT JOIN cal c ON c.trade_date > i.list_date
       GROUP BY 1
    ),
    agg AS (
      SELECT p.instrument_id,
             COUNT(*) FILTER (WHERE p.pb > 0)::int AS covered_days,
             COUNT(*)::int AS observed_days,
             COUNT(*) FILTER (WHERE p.pb <= 0)::int AS non_positive_days,
             MAX(p.pb) AS max_pb,
             MAX(p.pb) FILTER (WHERE p.pb > 0) AS max_positive_pb,
             MIN(p.pb) FILTER (WHERE p.pb > 0) AS min_positive_pb,
             MIN(p.trade_date) FILTER (WHERE p.pb > 0) AS effective_start,
             (ARRAY_AGG(p.trade_date ORDER BY p.pb ASC, p.trade_date ASC)
               FILTER (WHERE p.pb > 0))[1] AS min_pb_date,
             (ARRAY_AGG(p.trade_date ORDER BY p.pb DESC, p.trade_date ASC)
               FILTER (WHERE p.pb > 0))[1] AS max_pb_date,
             SUM(('x' || substr(md5(p.trade_date::text || ':' || p.pb::text), 1, 8))::bit(32)::bigint) AS series_digest,
             COUNT(*)::int AS series_rows
        FROM analytics.stock_daily_pb_picked p
        JOIN inst i ON i.instrument_id = p.instrument_id
       WHERE p.trade_date >= $6::date
         AND p.trade_date < ($6::date + INTERVAL '1 month')
       GROUP BY 1
    )
    INSERT INTO analytics.instrument_pb_monthly_summary (
      instrument_id, market, cal_year, cal_month, listed_days, exempt_days, covered_days,
      observed_days, non_positive_days, invalid_days, max_pb, max_positive_pb, min_positive_pb,
      min_pb_date, max_pb_date, effective_start, series_digest, series_rows, picked_version, updated_at)
    SELECT i.instrument_id, $1, $2::smallint, $3::smallint,
           COALESCE(l.listed_days, 0), COALESCE(e.exempt_days, 0),
           COALESCE(a.covered_days, 0), COALESCE(a.observed_days, 0),
           COALESCE(a.non_positive_days, 0),
           COALESCE(a.observed_days, 0) - COALESCE(a.covered_days, 0) - COALESCE(a.non_positive_days, 0),
           a.max_pb, a.max_positive_pb, a.min_positive_pb, a.min_pb_date, a.max_pb_date,
           a.effective_start, COALESCE(a.series_digest, 0), COALESCE(a.series_rows, 0), 1, now()
      FROM inst i
      LEFT JOIN listed l ON l.instrument_id = i.instrument_id
      LEFT JOIN exempt e ON e.instrument_id = i.instrument_id
      LEFT JOIN agg a ON a.instrument_id = i.instrument_id
    ON CONFLICT (instrument_id, cal_year, cal_month) DO UPDATE SET
      market = EXCLUDED.market,
      listed_days = EXCLUDED.listed_days,
      exempt_days = EXCLUDED.exempt_days,
      covered_days = EXCLUDED.covered_days,
      observed_days = EXCLUDED.observed_days,
      non_positive_days = EXCLUDED.non_positive_days,
      invalid_days = EXCLUDED.invalid_days,
      max_pb = EXCLUDED.max_pb,
      max_positive_pb = EXCLUDED.max_positive_pb,
      min_positive_pb = EXCLUDED.min_positive_pb,
      min_pb_date = EXCLUDED.min_pb_date,
      max_pb_date = EXCLUDED.max_pb_date,
      effective_start = EXCLUDED.effective_start,
      series_digest = EXCLUDED.series_digest,
      series_rows = EXCLUDED.series_rows,
      picked_version = analytics.instrument_pb_monthly_summary.picked_version + 1,
      updated_at = now()`,
  [market, year, month, scoped, config.calendarExchanges, monthStart]);
  return Number(result.rowCount || 0);
}

/**
 * 批次重建入口：先重建 picked 与市场估值日，再逐月重建汇总。
 * `months` 必须覆盖本次所有受影响月份；头尾非完整月也要重算（完整月汇总只是中段读源）。
 */
async function rebuildProjectionRange({ market, fromDate, toDate, months = null, instrumentIds = null }, tx) {
  const list = uniqueMonthList(months && months.length ? months : monthsBetween(fromDate, toDate));
  const picked = await rebuildPickedRange({ market, fromDate, toDate, instrumentIds }, tx);
  const marketDates = await rebuildMarketTradeDates({ market, fromDate, toDate }, tx);
  let summaries = 0;
  for (const item of list) {
    summaries += await rebuildMonthlySummaryMonth({
      market, year: item.year, month: item.month, instrumentIds,
    }, tx);
  }
  return { picked, marketDates, summaries, months: list.length };
}

// ---------------------------------------------------------------------------
// 投影读取（三段混合查询）
// ---------------------------------------------------------------------------

function parseDateParts(value) {
  const date = value instanceof Date ? value.toISOString().slice(0, 10) : String(value || '').slice(0, 10);
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const monthStart = `${date.slice(0, 7)}-01`;
  const monthEnd = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return { date, year, month, monthStart, monthEnd };
}

async function loadMiddleAggregates({ market, windowStart, asOfDate, instrumentIds = null }, tx) {
  const start = parseDateParts(windowStart);
  const end = parseDateParts(asOfDate);
  if ((end.year - start.year) * 12 + (end.month - start.month) <= 1) return [];
  const exec = executorOf(tx);
  const scoped = Array.isArray(instrumentIds) && instrumentIds.length
    ? Array.from(new Set(instrumentIds.map(id => Number(id)).filter(Number.isFinite)))
    : null;
  const { rows } = await exec(`
    SELECT m.instrument_id,
           SUM(m.listed_days)::int AS listed_days,
           SUM(m.exempt_days)::int AS exempt_days,
           SUM(m.covered_days)::int AS covered_days,
           SUM(m.observed_days)::int AS observed_days,
           SUM(m.non_positive_days)::int AS non_positive_days,
           SUM(m.invalid_days)::int AS invalid_days,
           MAX(m.max_pb) AS max_pb,
           MAX(m.max_positive_pb) AS max_positive_pb,
           MIN(m.min_positive_pb) AS min_positive_pb,
           (ARRAY_AGG(m.min_pb_date ORDER BY m.min_positive_pb ASC, m.min_pb_date ASC)
             FILTER (WHERE m.min_positive_pb IS NOT NULL))[1]::text AS min_pb_date,
           (ARRAY_AGG(m.max_pb_date ORDER BY m.max_positive_pb DESC, m.max_pb_date ASC)
             FILTER (WHERE m.max_positive_pb IS NOT NULL))[1]::text AS max_pb_date,
           MIN(m.effective_start)::text AS effective_start,
           SUM(m.series_digest)::bigint AS series_digest,
           SUM(m.series_rows)::int AS series_rows
      FROM analytics.instrument_pb_monthly_summary m
      JOIN core.instruments i ON i.instrument_id = m.instrument_id
     WHERE m.market = $1
       AND i.market = $1 AND i.asset_class = 'stock'
       AND COALESCE(i.raw_data->>'identity_backfill', '') <> 'tencent_quote_fund_etf'
       AND ($2::bigint[] IS NULL OR m.instrument_id = ANY($2::bigint[]))
       AND (m.cal_year, m.cal_month) > ($3::smallint, $4::smallint)
       AND (m.cal_year, m.cal_month) < ($5::smallint, $6::smallint)
     GROUP BY m.instrument_id`,
  [market, scoped, start.year, start.month, end.year, end.month]);
  return rows.map(row => ({ ...row, segment: 'mid' }));
}

/**
 * 头尾非完整月：严格按精确日期边界查 picked，并现算 listed_days / exempt_days。
 * 禁止读当月/当年汇总行——那会把 asOfDate 之后的更极端 PB 泄漏进窗口。
 */
async function loadEdgeAggregates({ market, windowStart, asOfDate, instrumentIds = null }, tx) {
  const config = marketConfig(market);
  const exec = executorOf(tx);
  const start = parseDateParts(windowStart);
  const end = parseDateParts(asOfDate);
  const sameOrEmpty = start.date >= end.date || (start.year === end.year && start.month === end.month);
  const headEnd = sameOrEmpty ? end.date : start.monthEnd;
  const tailStart = sameOrEmpty ? '9999-12-31' : end.monthStart;
  const scoped = Array.isArray(instrumentIds) && instrumentIds.length
    ? Array.from(new Set(instrumentIds.map(id => Number(id)).filter(Number.isFinite)))
    : null;
  const { rows } = await exec(`
    WITH inst AS (
      SELECT instrument_id, COALESCE(list_date, DATE '1900-01-01') AS list_date
        FROM core.instruments
       WHERE market = $1 AND asset_class = 'stock'
         AND COALESCE(raw_data->>'identity_backfill', '') <> 'tencent_quote_fund_etf'
         AND ($4::bigint[] IS NULL OR instrument_id = ANY($4::bigint[]))
    ),
    edge_cal AS (
      SELECT trade_date FROM market.trade_calendar
       WHERE exchange = ANY($5::text[]) AND COALESCE(is_open, true) = true
         AND ((trade_date > $2::date AND trade_date <= $6::date)
           OR (trade_date >= $7::date AND trade_date <= $3::date))
    ),
    edge_picked AS (
      SELECT p.instrument_id, p.trade_date, p.pb
        FROM analytics.stock_daily_pb_picked p
        JOIN inst i ON i.instrument_id = p.instrument_id
       WHERE p.market = $1
         AND ((p.trade_date > $2::date AND p.trade_date <= $6::date)
           OR (p.trade_date >= $7::date AND p.trade_date <= $3::date))
    ),
    agg AS (
      SELECT p.instrument_id,
             COUNT(*) FILTER (WHERE p.pb > 0)::int AS covered_days,
             COUNT(*)::int AS observed_days,
             COUNT(*) FILTER (WHERE p.pb <= 0)::int AS non_positive_days,
             MAX(p.pb) AS max_pb,
             MAX(p.pb) FILTER (WHERE p.pb > 0) AS max_positive_pb,
             MIN(p.pb) FILTER (WHERE p.pb > 0) AS min_positive_pb,
             MIN(p.trade_date) FILTER (WHERE p.pb > 0) AS effective_start,
             (ARRAY_AGG(p.trade_date ORDER BY p.pb ASC, p.trade_date ASC)
               FILTER (WHERE p.pb > 0))[1] AS min_pb_date,
             (ARRAY_AGG(p.trade_date ORDER BY p.pb DESC, p.trade_date ASC)
               FILTER (WHERE p.pb > 0))[1] AS max_pb_date,
             SUM(('x' || substr(md5(p.trade_date::text || ':' || p.pb::text), 1, 8))::bit(32)::bigint) AS series_digest,
             COUNT(*)::int AS series_rows
        FROM edge_picked p
       GROUP BY 1
    ),
    exempt AS (
      SELECT sc.instrument_id, COUNT(DISTINCT sc.trade_date)::int AS exempt_days
        FROM market.stock_suspend_calendar sc
        JOIN edge_cal c ON c.trade_date = sc.trade_date
       WHERE sc.suspend_type = 'S'
         AND NOT EXISTS (
               SELECT 1 FROM analytics.stock_daily_pb_picked p
                WHERE p.instrument_id = sc.instrument_id AND p.trade_date = sc.trade_date)
       GROUP BY 1
    ),
    listed AS (
      SELECT i.instrument_id, COUNT(c.trade_date)::int AS listed_days
        FROM inst i LEFT JOIN edge_cal c ON c.trade_date > i.list_date
       GROUP BY 1
    )
    SELECT i.instrument_id, to_char(i.list_date, 'YYYY-MM-DD') AS list_date,
           COALESCE(l.listed_days, 0)::int AS listed_days,
           COALESCE(e.exempt_days, 0)::int AS exempt_days,
           COALESCE(a.covered_days, 0)::int AS covered_days,
           COALESCE(a.observed_days, 0)::int AS observed_days,
           COALESCE(a.non_positive_days, 0)::int AS non_positive_days,
           COALESCE(a.observed_days, 0) - COALESCE(a.covered_days, 0) - COALESCE(a.non_positive_days, 0) AS invalid_days,
           a.max_pb, a.max_positive_pb, a.min_positive_pb,
           a.min_pb_date::text AS min_pb_date, a.max_pb_date::text AS max_pb_date,
           a.effective_start::text AS effective_start,
           COALESCE(a.series_digest, 0)::bigint AS series_digest,
           COALESCE(a.series_rows, 0)::int AS series_rows
      FROM inst i
      LEFT JOIN listed l ON l.instrument_id = i.instrument_id
      LEFT JOIN exempt e ON e.instrument_id = i.instrument_id
      LEFT JOIN agg a ON a.instrument_id = i.instrument_id`,
  [market, windowStart, asOfDate, scoped, config.calendarExchanges, headEnd, tailStart]);
  return rows.map(row => ({ ...row, segment: 'edge' }));
}

function compareNumericText(a, b) {
  const left = Number(a);
  const right = Number(b);
  if (!Number.isFinite(left)) return 1;
  if (!Number.isFinite(right)) return -1;
  return left - right;
}

function minDate(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return a <= b ? a : b;
}

function mergeExtremes(current, row) {
  // 最小正 PB：值更小者胜；同值取更早日期（与原 SQL ORDER BY pb ASC, trade_date ASC 一致）。
  if (row.min_positive_pb !== null && row.min_positive_pb !== undefined) {
    if (current.min_positive_pb === null || current.min_positive_pb === undefined
      || compareNumericText(row.min_positive_pb, current.min_positive_pb) < 0) {
      current.min_positive_pb = row.min_positive_pb;
      current.min_pb_date = row.min_pb_date || null;
    } else if (compareNumericText(row.min_positive_pb, current.min_positive_pb) === 0) {
      current.min_pb_date = minDate(current.min_pb_date, row.min_pb_date);
    }
  }
  if (row.max_positive_pb !== null && row.max_positive_pb !== undefined) {
    if (current.max_positive_pb === null || current.max_positive_pb === undefined
      || compareNumericText(row.max_positive_pb, current.max_positive_pb) > 0) {
      current.max_positive_pb = row.max_positive_pb;
      current.max_pb_date = row.max_pb_date || null;
    } else if (compareNumericText(row.max_positive_pb, current.max_positive_pb) === 0) {
      current.max_pb_date = minDate(current.max_pb_date, row.max_pb_date);
    }
  }
  if (current.max_pb === null || current.max_pb === undefined
    || (row.max_pb !== null && row.max_pb !== undefined && compareNumericText(row.max_pb, current.max_pb) > 0)) {
    current.max_pb = row.max_pb === undefined ? current.max_pb : row.max_pb;
  }
  current.effective_start = minDate(current.effective_start, row.effective_start);
  return current;
}

function emptyAccumulator(row) {
  return {
    instrument_id: row.instrument_id,
    list_date: row.list_date || null,
    listed_days: 0,
    exempt_days: 0,
    covered_days: 0,
    observed_days: 0,
    non_positive_days: 0,
    invalid_days: 0,
    max_pb: null,
    max_positive_pb: null,
    min_positive_pb: null,
    min_pb_date: null,
    max_pb_date: null,
    effective_start: null,
    series_digest: 0n,
    series_rows: 0,
  };
}

function addRow(acc, row) {
  acc.listed_days += Number(row.listed_days || 0);
  acc.exempt_days += Number(row.exempt_days || 0);
  acc.covered_days += Number(row.covered_days || 0);
  acc.observed_days += Number(row.observed_days || 0);
  acc.non_positive_days += Number(row.non_positive_days || 0);
  acc.invalid_days += Number(row.invalid_days || 0);
  acc.series_rows += Number(row.series_rows || 0);
  acc.series_digest += BigInt(String(row.series_digest == null ? 0 : row.series_digest));
  if (row.list_date) acc.list_date = row.list_date;
  mergeExtremes(acc, row);
  return acc;
}

/**
 * 供 stockSelectionRepository 使用的投影窗口读取。
 * 返回与 legacy `loadPbWindow` 相同字段形状，便于上层零改动映射。
 */
async function loadProjectedPbWindow({ market, windowStart, asOfDate, instrumentIds = null }, tx) {
  const config = marketConfig(market);
  const exec = executorOf(tx);
  const scoped = Array.isArray(instrumentIds) && instrumentIds.length
    ? Array.from(new Set(instrumentIds.map(id => Number(id)).filter(Number.isFinite)))
    : null;
  const [middleRows, edgeRows] = await Promise.all([
    loadMiddleAggregates({ market, windowStart, asOfDate, instrumentIds: scoped }, tx),
    loadEdgeAggregates({ market, windowStart, asOfDate, instrumentIds: scoped }, tx),
  ]);
  const map = new Map();
  for (const row of edgeRows) {
    map.set(String(row.instrument_id), addRow(emptyAccumulator(row), row));
  }
  for (const row of middleRows) {
    if (!map.has(String(row.instrument_id))) {
      map.set(String(row.instrument_id), emptyAccumulator(row));
    }
    addRow(map.get(String(row.instrument_id)), row);
  }

  const calendarDays = await exec(`
    SELECT COUNT(*)::int AS calendar_days
      FROM market.trade_calendar
     WHERE exchange = ANY($1::text[]) AND trade_date > $2::date AND trade_date <= $3::date
       AND COALESCE(is_open, true) = true`,
  [config.calendarExchanges, windowStart, asOfDate]);
  const calendarCount = Number((calendarDays.rows[0] || {}).calendar_days || 0);

  let marketDayCount = calendarCount;
  if (!scoped) {
    const projected = await exec(`
      SELECT COUNT(*)::int AS market_days
        FROM analytics.market_pb_trade_dates
       WHERE market = $1 AND trade_date > $2::date AND trade_date <= $3::date`,
    [market, windowStart, asOfDate]);
    marketDayCount = Number((projected.rows[0] || {}).market_days || 0);
    // 投影未初始化时必须响亮失败，绝不静默返回 0 覆盖：否则选股会以为全市场没有估值日。
    if (marketDayCount === 0) {
      const raw = await exec(`
        SELECT EXISTS (
          SELECT 1 FROM market.daily_valuations v
            JOIN core.instruments i ON i.instrument_id = v.instrument_id
           WHERE i.market = $1 AND v.trade_date > $2::date AND v.trade_date <= $3::date
        ) AS has_raw`,
      [market, windowStart, asOfDate]);
      if ((raw.rows[0] || {}).has_raw) {
        const error = new Error('PB 投影未覆盖该窗口，请先运行 backfillPbProjection 回填或同步');
        error.code = 'PB_PROJECTION_NOT_READY';
        throw error;
      }
    }
  }

  const rows = [...map.values()].map(acc => {
    const expectedDays = Math.max(acc.listed_days - acc.exempt_days, 0);
    const invalidDays = Math.max(acc.observed_days - acc.covered_days - acc.non_positive_days, 0);
    return {
      instrument_id: acc.instrument_id,
      expected_days: expectedDays,
      exempt_days: acc.exempt_days,
      list_date: acc.list_date,
      covered_days: acc.covered_days,
      observed_days: acc.observed_days,
      non_positive_days: acc.non_positive_days,
      invalid_days: invalidDays,
      max_pb: acc.max_pb,
      max_positive_pb: acc.max_positive_pb,
      min_positive_pb: acc.min_positive_pb,
      effective_start: acc.effective_start,
      min_pb_date: acc.min_pb_date,
      max_pb_date: acc.max_pb_date,
      series_digest: acc.series_rows > 0 ? acc.series_digest.toString() : null,
      series_rows: acc.series_rows,
    };
  });

  // 收窄读同样不能静默零覆盖：本批证券若在窗口内确有 pb 非空原始行，而投影没有任何观测，
  // 说明投影未回填/同步失败，必须响亮失败而不是把整批判成“无 PB”。
  if (scoped && !rows.some(row => Number(row.observed_days) > 0)) {
    const raw = await exec(`
      SELECT EXISTS (
        SELECT 1 FROM market.daily_valuations v
         WHERE v.instrument_id = ANY($1::bigint[])
           AND v.trade_date > $2::date AND v.trade_date <= $3::date
           AND v.pb IS NOT NULL
      ) AS has_raw`, [scoped, windowStart, asOfDate]);
    if ((raw.rows[0] || {}).has_raw) {
      const error = new Error('PB 投影未覆盖本批证券窗口，请先运行 backfillPbProjection 回填或同步');
      error.code = 'PB_PROJECTION_NOT_READY';
      throw error;
    }
  }

  return { rows, marketDays: marketDayCount, calendarDays: calendarCount };
}

// ---------------------------------------------------------------------------
// 水位、来源指纹与回填范围
// ---------------------------------------------------------------------------

async function readSyncCursor({ scopeKey, datasetCode }, tx) {
  const exec = executorOf(tx);
  const { rows } = await exec(`
    SELECT cursor_id, last_success_date::text AS last_success_date,
           last_source_update::text AS last_source_update, updated_at::text AS updated_at,
           last_error, retry_count
      FROM ops.sync_cursors
     WHERE scope_key = $1 AND dataset_code = $2
     LIMIT 1`, [scopeKey, datasetCode]);
  return rows[0] || null;
}

/** 同一 scope_key 下用 dataset_code 承载短值（如来源指纹、待重建标记），避免新增表。 */
async function readLatestCursorValue({ scopeKey }, tx) {
  const exec = executorOf(tx);
  const { rows } = await exec(`
    SELECT dataset_code, updated_at::text AS updated_at
      FROM ops.sync_cursors
     WHERE scope_key = $1
     ORDER BY updated_at DESC
     LIMIT 1`, [scopeKey]);
  return rows[0] || null;
}

async function upsertCursorValue({ scopeKey, datasetCode }, tx) {
  const exec = executorOf(tx);
  await exec(`
    INSERT INTO ops.sync_cursors (scope_key, dataset_code, updated_at)
    VALUES ($1, $2, now())
    ON CONFLICT (scope_key, dataset_code) DO UPDATE SET updated_at = now()`,
  [scopeKey, datasetCode]);
}

async function deleteCursorValue({ scopeKey, datasetCode }, tx) {
  const exec = executorOf(tx);
  await exec(`
    DELETE FROM ops.sync_cursors WHERE scope_key = $1 AND dataset_code = $2`,
  [scopeKey, datasetCode]);
}

async function deleteCursorScope({ scopeKey }, tx) {
  const exec = executorOf(tx);
  await exec(`DELETE FROM ops.sync_cursors WHERE scope_key = $1`, [scopeKey]);
}

async function writeSyncCursor({ scopeKey, datasetCode, lastSuccessDate = null, lastSourceUpdate = null, lastError = '' }, tx) {
  const exec = executorOf(tx);
  // 游标只能单调前进（AGENTS.md §1.6）：历史补录的较小日期不得回退最新成功水位。
  await exec(`
    INSERT INTO ops.sync_cursors (scope_key, dataset_code, last_success_date, last_source_update, last_error, retry_count, updated_at)
    VALUES ($1, $2, $3::date, $4::timestamptz, $5, 0, now())
    ON CONFLICT (scope_key, dataset_code) DO UPDATE SET
      last_success_date = CASE
        WHEN ops.sync_cursors.last_success_date IS NULL THEN EXCLUDED.last_success_date
        WHEN EXCLUDED.last_success_date IS NULL THEN ops.sync_cursors.last_success_date
        ELSE GREATEST(ops.sync_cursors.last_success_date, EXCLUDED.last_success_date)
      END,
      last_source_update = COALESCE(EXCLUDED.last_source_update, ops.sync_cursors.last_source_update),
      last_error = EXCLUDED.last_error,
      retry_count = 0,
      updated_at = now()`,
  [scopeKey, datasetCode, lastSuccessDate, lastSourceUpdate, String(lastError || '')]);
}

/**
 * 对账前置：投影是否已完成首次回填。
 * summaryRows 为 0 或该市场没有 pb_projection 水位时，对账必须跳过，
 * 不能把"尚未回填"当成"整库都脏"并触发 120 个月全量重建。
 */
async function projectionInitialized({ market, instrumentIds = null }, tx) {
  const exec = executorOf(tx);
  const scoped = Array.isArray(instrumentIds) && instrumentIds.length
    ? Array.from(new Set(instrumentIds.map(id => Number(id)).filter(Number.isFinite)))
    : null;
  const summary = await exec(`
    SELECT COUNT(*)::int AS summary_rows
      FROM analytics.instrument_pb_monthly_summary s
     WHERE s.market = $1
       AND ($2::bigint[] IS NULL OR s.instrument_id = ANY($2::bigint[]))`,
  [market, scoped]);
  const cursor = await exec(`
    SELECT 1 AS present
      FROM ops.sync_cursors
     WHERE scope_key = $1 AND dataset_code = 'pb_projection'
     LIMIT 1`, [`pb_projection:${String(market || '').toUpperCase()}`]);
  return {
    summaryRows: Number((summary.rows[0] || {}).summary_rows || 0),
    hasCursor: cursor.rows.length > 0,
  };
}

/**
 * 数据源注册/口径变更指纹：选源依赖 source_code 与 source_id，任一变化都必须全量重建。
 * 指纹只记录在 ops.sync_cursors，不新增表。
 */
async function readDataSourceFingerprint(tx) {
  const exec = executorOf(tx);
  const { rows } = await exec(`
    SELECT md5(string_agg(source_id::text || ':' || COALESCE(source_code, ''), ',' ORDER BY source_id)) AS fingerprint,
           COUNT(*)::int AS source_count
      FROM ops.data_sources`);
  return { fingerprint: (rows[0] || {}).fingerprint || '', sourceCount: Number((rows[0] || {}).source_count || 0) };
}

async function getMarketValuationBounds({ market }, tx) {
  const exec = executorOf(tx);
  const { rows } = await exec(`
    SELECT MIN(v.trade_date)::text AS min_date, MAX(v.trade_date)::text AS max_date
      FROM market.daily_valuations v
      JOIN core.instruments i ON i.instrument_id = v.instrument_id
     WHERE i.market = $1`, [market]);
  return rows[0] || { min_date: null, max_date: null };
}

async function getInstrumentValuationBounds({ market, instrumentIds = null }, tx) {
  const exec = executorOf(tx);
  const scoped = Array.isArray(instrumentIds) && instrumentIds.length
    ? Array.from(new Set(instrumentIds.map(id => Number(id)).filter(Number.isFinite)))
    : null;
  const { rows } = await exec(`
    SELECT MIN(v.trade_date)::text AS min_date, MAX(v.trade_date)::text AS max_date,
           MIN(i.list_date)::text AS min_list_date
      FROM market.daily_valuations v
      JOIN core.instruments i ON i.instrument_id = v.instrument_id
     WHERE i.market = $1 AND ($2::bigint[] IS NULL OR i.instrument_id = ANY($2::bigint[]))`,
  [market, scoped]);
  return rows[0] || { min_date: null, max_date: null, min_list_date: null };
}

async function sampleInstrumentIds({ market, limit = 20, years = 10 }, tx) {
  const exec = executorOf(tx);
  const { rows } = await exec(`
    SELECT i.instrument_id
      FROM core.instruments i
     WHERE i.market = $1 AND i.asset_class = 'stock'
       AND COALESCE(i.raw_data->>'identity_backfill', '') <> 'tencent_quote_fund_etf'
       AND EXISTS (SELECT 1 FROM market.daily_valuations v WHERE v.instrument_id = i.instrument_id)
       AND EXISTS (SELECT 1 FROM market.trade_calendar c
                    WHERE c.trade_date >= (CURRENT_DATE - ($3::int * INTERVAL '1 year'))::date)
     ORDER BY i.instrument_id
     LIMIT $2`, [market, Math.max(Number(limit) || 20, 1), Math.max(Number(years) || 10, 1)]);
  return rows.map(row => Number(row.instrument_id));
}

async function latestCompleteMonth({ market }, tx) {
  const exec = executorOf(tx);
  const { rows } = await exec(`
    SELECT MAX(v.trade_date)::text AS max_date
      FROM market.daily_valuations v
      JOIN core.instruments i ON i.instrument_id = v.instrument_id
     WHERE i.market = $1`, [market]);
  const maxDate = (rows[0] || {}).max_date;
  if (!maxDate) return null;
  const date = new Date(`${maxDate}T00:00:00Z`);
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - 1);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
}

// ---------------------------------------------------------------------------
// 抽样对账：原始 daily_valuations 口径 vs 投影
// ---------------------------------------------------------------------------

/**
 * 只读原始口径的逐月 15 项聚合，用于对账。SQL 必须与 rebuildMonthlySummaryMonth
 * 的汇总口径同源，但数据来自 market.daily_valuations（不经投影表）。
 */
async function loadRawMonthlyAggregates({ market, months, instrumentIds = null }, tx) {
  const config = marketConfig(market);
  const exec = executorOf(tx);
  const list = uniqueMonthList(months);
  if (!list.length) return [];
  const scoped = Array.isArray(instrumentIds) && instrumentIds.length
    ? Array.from(new Set(instrumentIds.map(id => Number(id)).filter(Number.isFinite)))
    : null;
  const fromDate = monthRangeStart(list);
  const toDate = monthRangeEnd(list);
  const { rows } = await exec(`
    WITH inst AS (
      SELECT instrument_id, COALESCE(list_date, DATE '1900-01-01') AS list_date
        FROM core.instruments
       WHERE market = $1 AND asset_class = 'stock'
         AND COALESCE(raw_data->>'identity_backfill', '') <> 'tencent_quote_fund_etf'
         AND ($2::bigint[] IS NULL OR instrument_id = ANY($2::bigint[]))
    ),
    cal AS (
      SELECT trade_date FROM market.trade_calendar
       WHERE exchange = ANY($3::text[]) AND COALESCE(is_open, true) = true
         AND trade_date >= $4::date AND trade_date <= $5::date
    ),
    picked AS (
      SELECT DISTINCT ON (v.instrument_id, v.trade_date)
             v.instrument_id, v.trade_date, v.pb
        FROM market.daily_valuations v
        JOIN inst i ON i.instrument_id = v.instrument_id
        JOIN cal c ON c.trade_date = v.trade_date
        LEFT JOIN ops.data_sources s ON s.source_id = v.source_id
       WHERE v.trade_date >= $4::date AND v.trade_date <= $5::date
         AND v.pb IS NOT NULL
       ORDER BY v.instrument_id, v.trade_date,
                CASE WHEN s.source_code LIKE 'lixinger%' THEN 0 ELSE 1 END, v.source_id
    ),
    agg AS (
      SELECT p.instrument_id,
             EXTRACT(YEAR FROM p.trade_date)::int AS cal_year,
             EXTRACT(MONTH FROM p.trade_date)::int AS cal_month,
             COUNT(*) FILTER (WHERE p.pb > 0)::int AS covered_days,
             COUNT(*)::int AS observed_days,
             COUNT(*) FILTER (WHERE p.pb <= 0)::int AS non_positive_days,
             MAX(p.pb) AS max_pb,
             MAX(p.pb) FILTER (WHERE p.pb > 0) AS max_positive_pb,
             MIN(p.pb) FILTER (WHERE p.pb > 0) AS min_positive_pb,
             MIN(p.trade_date) FILTER (WHERE p.pb > 0) AS effective_start,
             (ARRAY_AGG(p.trade_date ORDER BY p.pb ASC, p.trade_date ASC)
               FILTER (WHERE p.pb > 0))[1] AS min_pb_date,
             (ARRAY_AGG(p.trade_date ORDER BY p.pb DESC, p.trade_date ASC)
               FILTER (WHERE p.pb > 0))[1] AS max_pb_date,
             SUM(('x' || substr(md5(p.trade_date::text || ':' || p.pb::text), 1, 8))::bit(32)::bigint) AS series_digest,
             COUNT(*)::int AS series_rows
        FROM picked p
       GROUP BY 1, 2, 3
    ),
    months AS (
      SELECT m.y::int AS cal_year, m.mo::int AS cal_month
        FROM unnest($6::int[], $7::int[]) AS m(y, mo)
    ),
    exempt AS (
      SELECT sc.instrument_id,
             EXTRACT(YEAR FROM sc.trade_date)::int AS cal_year,
             EXTRACT(MONTH FROM sc.trade_date)::int AS cal_month,
             COUNT(DISTINCT sc.trade_date)::int AS exempt_days
        FROM market.stock_suspend_calendar sc
        JOIN cal c ON c.trade_date = sc.trade_date
       WHERE sc.suspend_type = 'S'
         AND NOT EXISTS (SELECT 1 FROM picked p
                          WHERE p.instrument_id = sc.instrument_id AND p.trade_date = sc.trade_date)
       GROUP BY 1, 2, 3
    ),
    listed AS (
      SELECT i.instrument_id, m.cal_year, m.cal_month,
             COUNT(c.trade_date)::int AS listed_days
        FROM inst i
        CROSS JOIN months m
        LEFT JOIN cal c ON c.trade_date >= make_date(m.cal_year, m.cal_month, 1)
                       AND c.trade_date < (make_date(m.cal_year, m.cal_month, 1) + INTERVAL '1 month')
                       AND c.trade_date > i.list_date
       GROUP BY 1, 2, 3
    )
    SELECT i.instrument_id, m.cal_year, m.cal_month,
           COALESCE(l.listed_days, 0)::int AS listed_days,
           COALESCE(e.exempt_days, 0)::int AS exempt_days,
           COALESCE(a.covered_days, 0)::int AS covered_days,
           COALESCE(a.observed_days, 0)::int AS observed_days,
           COALESCE(a.non_positive_days, 0)::int AS non_positive_days,
           COALESCE(a.observed_days, 0) - COALESCE(a.covered_days, 0) - COALESCE(a.non_positive_days, 0) AS invalid_days,
           a.max_pb, a.max_positive_pb, a.min_positive_pb,
           a.min_pb_date::text AS min_pb_date, a.max_pb_date::text AS max_pb_date,
           a.effective_start::text AS effective_start,
           COALESCE(a.series_digest, 0)::bigint AS series_digest,
           COALESCE(a.series_rows, 0)::int AS series_rows
      FROM inst i
      CROSS JOIN months m
      LEFT JOIN listed l ON l.instrument_id = i.instrument_id
                        AND l.cal_year = m.cal_year AND l.cal_month = m.cal_month
      LEFT JOIN exempt e ON e.instrument_id = i.instrument_id
                        AND e.cal_year = m.cal_year AND e.cal_month = m.cal_month
      LEFT JOIN agg a ON a.instrument_id = i.instrument_id
                     AND a.cal_year = m.cal_year AND a.cal_month = m.cal_month
     ORDER BY i.instrument_id, m.cal_year, m.cal_month`,
  [market, scoped, config.calendarExchanges, fromDate, toDate,
    list.map(item => item.year), list.map(item => item.month)]);
  return rows;
}

async function loadProjectedMonthlyRows({ market, months, instrumentIds = null }, tx) {
  const exec = executorOf(tx);
  const list = uniqueMonthList(months);
  if (!list.length) return [];
  const scoped = Array.isArray(instrumentIds) && instrumentIds.length
    ? Array.from(new Set(instrumentIds.map(id => Number(id)).filter(Number.isFinite)))
    : null;
  const { rows } = await exec(`
    SELECT s.instrument_id, s.cal_year::int AS cal_year, s.cal_month::int AS cal_month,
           s.listed_days, s.exempt_days, s.covered_days, s.observed_days,
           s.non_positive_days, s.invalid_days, s.max_pb, s.max_positive_pb, s.min_positive_pb,
           s.min_pb_date::text AS min_pb_date, s.max_pb_date::text AS max_pb_date,
           s.effective_start::text AS effective_start, s.series_digest::bigint AS series_digest,
           s.series_rows, s.picked_version
      FROM analytics.instrument_pb_monthly_summary s
     WHERE s.market = $1
       AND ($2::bigint[] IS NULL OR s.instrument_id = ANY($2::bigint[]))
       AND (s.cal_year, s.cal_month) IN (
         SELECT y, mo FROM unnest($3::int[], $4::int[]) AS m(y, mo))
     ORDER BY s.instrument_id, s.cal_year, s.cal_month`,
  [market, scoped, list.map(item => item.year), list.map(item => item.month)]);
  return rows;
}

async function loadRawPickedRange({ market, fromDate, toDate, instrumentIds = null }, tx) {
  const config = marketConfig(market);
  const exec = executorOf(tx);
  const scoped = Array.isArray(instrumentIds) && instrumentIds.length
    ? Array.from(new Set(instrumentIds.map(id => Number(id)).filter(Number.isFinite)))
    : null;
  const { rows } = await exec(`
    SELECT DISTINCT ON (v.instrument_id, v.trade_date)
           v.instrument_id, v.trade_date::text AS trade_date, v.source_id, v.pb
      FROM market.daily_valuations v
      JOIN core.instruments i ON i.instrument_id = v.instrument_id
      JOIN market.trade_calendar c ON c.trade_date = v.trade_date
      LEFT JOIN ops.data_sources s ON s.source_id = v.source_id
     WHERE i.market = $1 AND i.asset_class = 'stock'
       AND COALESCE(i.raw_data->>'identity_backfill', '') <> 'tencent_quote_fund_etf'
       AND v.trade_date >= $2::date AND v.trade_date <= $3::date
       AND v.pb IS NOT NULL
       AND c.exchange = ANY($4::text[]) AND COALESCE(c.is_open, true) = true
       AND ($5::bigint[] IS NULL OR v.instrument_id = ANY($5::bigint[]))
     ORDER BY v.instrument_id, v.trade_date,
              CASE WHEN s.source_code LIKE 'lixinger%' THEN 0 ELSE 1 END, v.source_id`,
  [market, fromDate, toDate, config.calendarExchanges, scoped]);
  return rows;
}

async function loadProjectedPickedRange({ market, fromDate, toDate, instrumentIds = null }, tx) {
  const exec = executorOf(tx);
  const scoped = Array.isArray(instrumentIds) && instrumentIds.length
    ? Array.from(new Set(instrumentIds.map(id => Number(id)).filter(Number.isFinite)))
    : null;
  const { rows } = await exec(`
    SELECT p.instrument_id, p.trade_date::text AS trade_date, p.source_id, p.pb
      FROM analytics.stock_daily_pb_picked p
     WHERE p.market = $1 AND p.trade_date >= $2::date AND p.trade_date <= $3::date
       AND ($4::bigint[] IS NULL OR p.instrument_id = ANY($4::bigint[]))`,
  [market, fromDate, toDate, scoped]);
  return rows;
}

async function loadRawMarketDates({ market, fromDate, toDate }, tx) {
  const exec = executorOf(tx);
  const { rows } = await exec(`
    SELECT v.trade_date::text AS trade_date, COUNT(DISTINCT v.instrument_id)::int AS instrument_count
      FROM market.daily_valuations v
      JOIN core.instruments i ON i.instrument_id = v.instrument_id
     WHERE i.market = $1 AND v.trade_date >= $2::date AND v.trade_date <= $3::date
     GROUP BY v.trade_date ORDER BY v.trade_date`,
  [market, fromDate, toDate]);
  return rows;
}

async function loadProjectedMarketDates({ market, fromDate, toDate }, tx) {
  const exec = executorOf(tx);
  const { rows } = await exec(`
    SELECT d.trade_date::text AS trade_date, d.instrument_count
      FROM analytics.market_pb_trade_dates d
     WHERE d.market = $1 AND d.trade_date >= $2::date AND d.trade_date <= $3::date
     ORDER BY d.trade_date`,
  [market, fromDate, toDate]);
  return rows;
}

async function deleteProjectedMonth({ market, year, month }, tx) {
  const exec = executorOf(tx);
  await exec(`
    DELETE FROM analytics.instrument_pb_monthly_summary
     WHERE market = $1 AND cal_year = $2::smallint AND cal_month = $3::smallint`,
  [market, year, month]);
}

module.exports = {
  MARKET_CONFIG,
  monthsBetween,
  uniqueMonthList,
  monthRangeStart,
  monthRangeEnd,
  rebuildPickedRange,
  rebuildMarketTradeDates,
  rebuildMonthlySummaryMonth,
  rebuildProjectionRange,
  loadProjectedPbWindow,
  readSyncCursor,
  writeSyncCursor,
  projectionInitialized,
  readLatestCursorValue,
  upsertCursorValue,
  deleteCursorValue,
  deleteCursorScope,
  readDataSourceFingerprint,
  getMarketValuationBounds,
  getInstrumentValuationBounds,
  sampleInstrumentIds,
  latestCompleteMonth,
  loadRawMonthlyAggregates,
  loadProjectedMonthlyRows,
  loadRawPickedRange,
  loadProjectedPickedRange,
  loadRawMarketDates,
  loadProjectedMarketDates,
  deleteProjectedMonth,
};

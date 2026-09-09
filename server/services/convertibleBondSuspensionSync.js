const { pool } = require('../db/connection');
const { tushareQuery, tsRows } = require('./market');
const { publishDatasetPartition } = require('./datasetPartitions');

function compactDate(value) {
  const text = String(value || '').replace(/-/g, '').slice(0, 8);
  return /^\d{8}$/.test(text) ? text : null;
}

function isoDate(value) {
  const text = compactDate(value);
  return text ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}` : null;
}

function nextDate(value) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

// 按交易日顺序把缺失日合并成最小连续区间；周末和休市日可包含在区间内，避免拆成多次请求。
function mergeDateRanges(dates, openDates = dates) {
  const normalized = [...new Set((dates || []).map(isoDate).filter(Boolean))].sort();
  const openDatePositions = new Map(
    [...new Set((openDates || []).map(isoDate).filter(Boolean))].sort().map((date, index) => [date, index])
  );
  const ranges = [];
  for (const date of normalized) {
    const current = ranges[ranges.length - 1];
    const previousPosition = current && openDatePositions.get(current.endDate);
    const currentPosition = openDatePositions.get(date);
    const adjacentTradingDay = Number.isInteger(previousPosition)
      && Number.isInteger(currentPosition)
      && currentPosition === previousPosition + 1;
    if (!current || (nextDate(current.endDate) !== date && !adjacentTradingDay)) {
      ranges.push({ startDate: date, endDate: date, dates: [date] });
    } else {
      current.endDate = date;
      current.dates.push(date);
    }
  }
  return ranges;
}

async function tushareSourceId() {
  const { rows } = await pool.query("SELECT source_id FROM ops.data_sources WHERE source_code='tushare' LIMIT 1");
  return rows[0] && rows[0].source_id;
}

async function openDaysInRange(startDate, endDate) {
  const { rows } = await pool.query(
    `SELECT trade_date::text AS trade_date
       FROM market.trade_calendar
      WHERE exchange='SSE' AND is_open AND trade_date BETWEEN $1::date AND $2::date
      ORDER BY trade_date`, [isoDate(startDate), isoDate(endDate)]
  );
  return rows.map(row => isoDate(row.trade_date)).filter(Boolean);
}

/**
 * 增量同步强赎计算所需的正股停牌日。只保存可转债对应正股，避免每次计算重新访问接口。
 */
async function syncConvertibleBondSuspensions({ startDate, endDate } = {}) {
  const from = compactDate(startDate) || compactDate(endDate);
  const to = compactDate(endDate) || from;
  if (!from || !to || from > to) return { ok: false, status: 'invalid_range', count: 0 };

  const [{ rows: stocks }, sourceResult, data] = await Promise.all([
    pool.query(`
      SELECT DISTINCT s.instrument_id, s.canonical_code
        FROM fundamental.convertible_bond_profiles p
        LEFT JOIN fundamental.convertible_bond_issuance iss ON iss.instrument_id=p.instrument_id
        JOIN market.convertible_bond_daily_metrics bm ON bm.instrument_id=p.instrument_id
        JOIN core.instruments s ON s.instrument_id=p.stock_instrument_id
       WHERE p.stock_instrument_id IS NOT NULL
         AND bm.trade_date=(SELECT MAX(m.trade_date)
                              FROM market.convertible_bond_daily_metrics m
                             WHERE m.trade_date <= $1::date)
         AND (iss.issue_type IS NULL OR iss.issue_type NOT IN ('定向','私募'))`, [isoDate(to)]),
    pool.query(`SELECT source_id FROM ops.data_sources WHERE source_code='tushare' LIMIT 1`),
    tushareQuery('suspend_d', { start_date: from, end_date: to },
      'ts_code,trade_date,suspend_type,suspend_reason', { allowEmpty: true }),
  ]);
  const sourceId = sourceResult.rows[0] && sourceResult.rows[0].source_id;
  if (!sourceId) return { ok: false, status: 'source_missing', count: 0, queryStatus: 'not_run' };
  const instrumentMap = new Map(stocks.map(row => [row.canonical_code, row.instrument_id]));
  const rows = tsRows(data).map(row => ({
    instrument_id: instrumentMap.get(row.ts_code),
    trade_date: isoDate(row.trade_date),
    suspend_type: String(row.suspend_type || 'S'),
    suspend_reason: row.suspend_reason || null,
    raw_payload: row,
  })).filter(row => row.instrument_id && row.trade_date);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`
      INSERT INTO market.stock_suspend_calendar
        (instrument_id,trade_date,suspend_type,suspend_reason,source_id,raw_payload)
      SELECT x.instrument_id,x.trade_date,x.suspend_type,x.suspend_reason,$2,x.raw_payload
        FROM jsonb_to_recordset($1::jsonb) AS x(
          instrument_id bigint,trade_date date,suspend_type text,suspend_reason text,raw_payload jsonb)
      ON CONFLICT (instrument_id,trade_date,source_id) DO UPDATE SET
        suspend_type=EXCLUDED.suspend_type,
        suspend_reason=EXCLUDED.suspend_reason,
        raw_payload=EXCLUDED.raw_payload,
        ingested_at=now()`, [JSON.stringify(rows), sourceId]);
    await client.query('COMMIT');
    return {
      ok: true,
      status: 'succeeded',
      queryStatus: 'success',
      coverageStatus: result.rowCount ? 'suspensions_found' : 'verified_no_suspension',
      from: isoDate(from),
      to: isoDate(to),
      count: result.rowCount,
      sourceId,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// 查询“行情或已核实停牌”仍未覆盖的交易日。分区记录是停牌接口成功的独立证据，
// 因此即使某天没有停牌事实，也不会被误判成缺口。
async function findSuspensionCoverageGaps({ startDate, endDate, stockSourceId, suspensionSourceId } = {}) {
  const from = isoDate(startDate);
  const to = isoDate(endDate);
  if (!from || !to || from > to || !stockSourceId || !suspensionSourceId) return [];
  const { rows } = await pool.query(
    `WITH target_stocks AS (
       SELECT DISTINCT s.instrument_id
         FROM fundamental.convertible_bond_profiles p
         LEFT JOIN fundamental.convertible_bond_issuance iss ON iss.instrument_id=p.instrument_id
         JOIN market.convertible_bond_daily_metrics bm ON bm.instrument_id=p.instrument_id
         JOIN core.instruments s ON s.instrument_id=p.stock_instrument_id
        WHERE p.stock_instrument_id IS NOT NULL
          AND bm.trade_date=(SELECT MAX(m.trade_date)
                               FROM market.convertible_bond_daily_metrics m
                              WHERE m.trade_date <= $2::date)
          AND (iss.issue_type IS NULL OR iss.issue_type NOT IN ('定向','私募'))
     ), open_days AS (
       SELECT trade_date
         FROM market.trade_calendar
        WHERE exchange='SSE' AND is_open AND trade_date BETWEEN $1::date AND $2::date
     ), coverage AS (
       SELECT d.trade_date,
              COUNT(DISTINCT s.instrument_id)::int AS expected_count,
              COUNT(DISTINCT CASE WHEN b.instrument_id IS NOT NULL OR sc.instrument_id IS NOT NULL
                                  THEN s.instrument_id END)::int AS covered_count,
              MAX(dp.status) AS partition_status,
              BOOL_OR(COALESCE(dp.is_stale,false)) AS partition_is_stale
         FROM open_days d
         CROSS JOIN target_stocks s
         LEFT JOIN market.daily_bars b
           ON b.instrument_id=s.instrument_id AND b.trade_date=d.trade_date AND b.source_id=$3
         LEFT JOIN market.stock_suspend_calendar sc
           ON sc.instrument_id=s.instrument_id AND sc.trade_date=d.trade_date AND sc.source_id=$4
         LEFT JOIN ops.dataset_partitions dp
           ON dp.dataset_code='stock_suspend_calendar' AND dp.scope_key='CN' AND dp.partition_key=d.trade_date
        GROUP BY d.trade_date
     )
     SELECT trade_date::text,expected_count,covered_count,partition_status,partition_is_stale
       FROM coverage
      WHERE covered_count < expected_count
         OR partition_status IS DISTINCT FROM 'published'
         OR COALESCE(partition_is_stale,false)
      ORDER BY trade_date`, [from, to, stockSourceId, suspensionSourceId]
  );
  return rows.map(row => ({
    tradeDate: isoDate(row.trade_date),
    expectedCount: Number(row.expected_count || 0),
    coveredCount: Number(row.covered_count || 0),
    partitionStatus: row.partition_status || null,
    partitionIsStale: Boolean(row.partition_is_stale),
  })).filter(row => row.tradeDate);
}

async function publishSuspensionCoverage({ startDate, endDate, sourceId } = {}) {
  const from = isoDate(startDate);
  const to = isoDate(endDate);
  const resolvedSourceId = sourceId || await tushareSourceId();
  if (!from || !to || !resolvedSourceId) return { ok: false, status: 'invalid_range_or_source', count: 0 };
  const { rows } = await pool.query(
    `SELECT tc.trade_date::text AS trade_date,COUNT(DISTINCT sc.instrument_id)::int AS row_count
       FROM market.trade_calendar tc
       LEFT JOIN market.stock_suspend_calendar sc
         ON sc.trade_date=tc.trade_date AND sc.source_id=$3
      WHERE tc.exchange='SSE' AND tc.is_open AND tc.trade_date BETWEEN $1::date AND $2::date
      GROUP BY tc.trade_date ORDER BY tc.trade_date`, [from, to, resolvedSourceId]
  );
  for (const row of rows) {
    const tradeDate = isoDate(row.trade_date);
    const rowCount = Number(row.row_count || 0);
    await publishDatasetPartition('stock_suspend_calendar', 'CN', {
      partitionKey: tradeDate,
      dataAsOf: tradeDate,
      rowCount,
      sourceId: resolvedSourceId,
      diagnostics: {
        api_name: 'suspend_d',
        query_status: 'success',
        coverage_status: rowCount ? 'suspensions_found' : 'verified_no_suspension',
        range_start: from,
        range_end: to,
      },
    });
  }
  return { ok: true, status: 'published', count: rows.length, sourceId: resolvedSourceId };
}

async function markSuspensionCoverageStale({ startDate, endDate, sourceId, error } = {}) {
  const from = isoDate(startDate);
  const to = isoDate(endDate);
  const resolvedSourceId = sourceId || await tushareSourceId();
  if (!from || !to || !resolvedSourceId) return { ok: false, status: 'invalid_range_or_source' };
  const detail = {
    api_name: 'suspend_d',
    query_status: 'failed',
    coverage_status: 'unknown',
    range_start: from,
    range_end: to,
    error: String(error || '停牌接口失败').slice(0, 500),
  };
  await pool.query(
    `UPDATE ops.dataset_partitions
        SET status='stale',is_stale=true,stale_reason=$3,
            diagnostics=COALESCE(diagnostics,'{}'::jsonb)||$4::jsonb,updated_at=now()
      WHERE dataset_code='stock_suspend_calendar' AND scope_key='CN'
        AND partition_key BETWEEN $1::date AND $2::date`,
    [from, to, 'suspend_d 查询失败，停牌状态未知', JSON.stringify(detail)]
  );
  const openDays = await openDaysInRange(from, to);
  const { rows: existing } = await pool.query(
    `SELECT partition_key::text AS partition_key
       FROM ops.dataset_partitions
      WHERE dataset_code='stock_suspend_calendar' AND scope_key='CN'
        AND partition_key BETWEEN $1::date AND $2::date`, [from, to]
  );
  const existingDates = new Set(existing.map(row => isoDate(row.partition_key)));
  const coverageDates = openDays.length || from !== to ? openDays : [from];
  for (const tradeDate of coverageDates.filter(date => !existingDates.has(date))) {
    await publishDatasetPartition('stock_suspend_calendar', 'CN', {
      partitionKey: tradeDate,
      dataAsOf: tradeDate,
      rowCount: 0,
      sourceId: resolvedSourceId,
      status: 'stale',
      isStale: true,
      staleReason: 'suspend_d 查询失败，停牌状态未知',
      diagnostics: detail,
    });
  }
  return { ok: true, status: 'stale_marked', count: coverageDates.length };
}

async function syncSuspensionIntervals(ranges = []) {
  if (!ranges.length) return { ok: true, status: 'no_gap', count: 0, ranges: [] };
  const results = [];
  let count = 0;
  for (const range of ranges) {
    try {
      const result = await syncConvertibleBondSuspensions(range);
      if (!result.ok) throw Object.assign(new Error(result.status || '停牌数据同步失败'), { code: 'SUSPENSION_SYNC_FAILED' });
      await publishSuspensionCoverage({ ...range, sourceId: result.sourceId });
      results.push({ ...range, ...result });
      count += Number(result.count || 0);
    } catch (error) {
      await markSuspensionCoverageStale({ ...range, error: error.message }).catch(markError => {
        console.warn('[停牌水位] 失败状态登记失败：', markError.message);
      });
      return {
        ok: false,
        status: 'failed',
        error: error.message,
        errorCode: error.code || 'SUSPENSION_SYNC_FAILED',
        failedRange: range,
        count,
        ranges: results,
      };
    }
  }
  return { ok: true, status: 'succeeded', count, ranges: results };
}

module.exports = {
  syncConvertibleBondSuspensions,
  mergeDateRanges,
  findSuspensionCoverageGaps,
  publishSuspensionCoverage,
  markSuspensionCoverageStale,
  syncSuspensionIntervals,
};

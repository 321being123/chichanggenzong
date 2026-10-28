const { pool } = require('../db/connection');
const { tushareQuery, tsRows } = require('./market');
const { publishDatasetPartition } = require('./datasetPartitions');
const txControl = require('../repositories/transactionControl');
const { tushareSourceId } = require('../repositories/convertibleBondSuspensionSyncRepository.js');
const repository = require('../repositories/convertibleBondSuspensionSyncRepository.js');

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

/* tushareSourceId 已迁入 server/repositories/convertibleBondSuspensionSyncRepository.js */

async function openDaysInRange(startDate, endDate) {
  const { rows } = await repository.select_market_trade_calendar([isoDate(startDate), isoDate(endDate)]);
  return rows.map(row => isoDate(row.trade_date)).filter(Boolean);
}

/**
 * 增量保存转债正股及已跟踪股票的停牌证据，复用同一次全市场查询。
 */
async function syncConvertibleBondSuspensions({ startDate, endDate, targetCodes = [] } = {}) {
  const from = compactDate(startDate) || compactDate(endDate);
  const to = compactDate(endDate) || from;
  if (!from || !to || from > to) return { ok: false, status: 'invalid_range', count: 0 };

  const [{ rows: stocks }, sourceResult, data] = await Promise.all([
    repository.select_fundamental_convertible_bond_profiles(),
    repository.select_ops_data_sources(),
    tushareQuery('suspend_d', { start_date: from, end_date: to },
      'ts_code,trade_date,suspend_type,suspend_reason', { allowEmpty: true }),
  ]);
  const sourceId = sourceResult.rows[0] && sourceResult.rows[0].source_id;
  if (!sourceId) return { ok: false, status: 'source_missing', count: 0, queryStatus: 'not_run' };
  const targets = new Set(targetCodes.map(code => String(code).trim().toUpperCase()).filter(Boolean));
  const missingTargets = [...targets].filter(code => !stocks.some(row => row.canonical_code === code));
  if (missingTargets.length) return { ok: false, status: 'target_identity_missing', missingTargets, count: 0 };
  const instrumentMap = new Map(stocks.filter(row => !targets.size || targets.has(row.canonical_code))
    .map(row => [row.canonical_code, row.instrument_id]));
  // suspend_d 可能同日返回“复牌(R)”和“停牌(S)”两条记录；表的唯一键按证券+日期，
  // 先去重并优先保留停牌事实，避免 PostgreSQL ON CONFLICT 同一批次重复更新报错。
  const rowMap = new Map();
  for (const row of tsRows(data)) {
    const mapped = {
      instrument_id: instrumentMap.get(row.ts_code),
      trade_date: isoDate(row.trade_date),
      suspend_type: String(row.suspend_type || 'S'),
      suspend_reason: row.suspend_reason || null,
      raw_payload: row,
    };
    if (!mapped.instrument_id || !mapped.trade_date) continue;
    const key = `${mapped.instrument_id}:${mapped.trade_date}`;
    const previous = rowMap.get(key);
    if (!previous || (previous.suspend_type !== 'S' && mapped.suspend_type === 'S')) rowMap.set(key, mapped);
  }
  const rows = [...rowMap.values()];

  const client = await pool.connect();
  try {
    await txControl.begin(client);
    const result = await repository.insert_market_stock_suspend_calendar([JSON.stringify(rows), sourceId], client);
    await txControl.commit(client);
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
    await txControl.rollback(client);
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
  const { rows } = await repository.with_fundamental_convertible_bond_profiles([from, to, stockSourceId, suspensionSourceId]);
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
  const { rows } = await repository.select_market_trade_calendar_1([from, to, resolvedSourceId]);
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
  await repository.update_ops_dataset_partitions([from, to, 'suspend_d 查询失败，停牌状态未知', JSON.stringify(detail)]);
  const openDays = await openDaysInRange(from, to);
  const { rows: existing } = await repository.select_ops_dataset_partitions([from, to]);
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

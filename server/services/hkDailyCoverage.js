// 港股 IPO 上市首日/上市后五个交易日日线覆盖与标准层同步。
// 官方 Tushare 路径保留兼容；IPO enrichment 使用腾讯港股 K 线免 Token 补漏路径。
const crypto = require('crypto');
const { pool } = require('../db');
const { tushareQuery } = require('./tushare');
const { withExternalCallGuard } = require('./externalCallGuard');
const { requestTencentHkKline } = require('./tencentQuote');
const txControl = require('../repositories/transactionControl');
const { loadCandidates, sourceIdFor } = require('../repositories/hkDailyCoverageRepository.js');
const repository = require('../repositories/hkDailyCoverageRepository.js');

const HK_DAILY_FIELDS = 'ts_code,trade_date,open,high,low,close,pre_close,change,pct_chg,vol,amount';
const DEFAULT_FROM_DATE = '2025-08-04';

function isoDate(value) {
  const text = value instanceof Date ? value.toISOString().slice(0, 10) : String(value || '').replace(/-/g, '').slice(0, 8);
  if (!/^\d{8}$/.test(text) && !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  return /^\d{8}$/.test(text) ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}` : text;
}

function todayShanghai() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
}

function addDays(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function rowsFromTencentHkKline(payload, symbol) {
  const key = `hk${String(symbol || '').replace(/\.HK$/i, '').padStart(5, '0')}`.toLowerCase();
  const rows = payload && payload.data && payload.data[key] && payload.data[key].day;
  if (!Array.isArray(rows)) return [];
  return rows.map(item => ({
    ts_code: `${key.slice(2)}.HK`.toUpperCase(),
    trade_date: item[0], open: item[1], close: item[2], high: item[3], low: item[4], vol: item[5], amount: null,
  }));
}

async function fetchTencentHkDaily(candidate, toDate, fetchImpl) {
  const startDate = isoDate(candidate.list_date) || addDays(toDate, -30);
  const endDate = addDays(startDate, 35) < toDate ? addDays(startDate, 35) : toDate;
  try {
    const body = fetchImpl
      ? await fetchImpl(candidate.canonical_code, startDate, endDate)
      : await withExternalCallGuard('tencent', `hk_daily_history:${candidate.canonical_code}:${startDate}:${endDate}`, toDate,
        () => requestTencentHkKline(candidate.canonical_code, startDate, endDate));
    const rows = normalizeRows(rowsFromTencentHkKline(body, candidate.canonical_code), candidate.canonical_code);
    return { candidate, startDate, endDate, rows, coverage: coverageForCandidate(candidate, rows), source: 'tencent' };
  } catch (error) {
    return { candidate, startDate, endDate, rows: [], source: 'tencent', coverage: { ...coverageForCandidate(candidate, []), error: error.message || String(error) }, error };
  }
}

function rowsFromPayload(data) {
  if (Array.isArray(data)) return data;
  if (!data || !Array.isArray(data.items) || !Array.isArray(data.fields)) return [];
  return data.items.map(item => Object.fromEntries(data.fields.map((field, index) => [field, item[index]])));
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeRows(rows, code) {
  const expected = String(code || '').toUpperCase();
  return rows.map(row => ({
    ...row,
    ts_code: String(row.ts_code || '').toUpperCase(),
    trade_date: isoDate(row.trade_date),
    open: finite(row.open), high: finite(row.high), low: finite(row.low), close: finite(row.close),
    pre_close: finite(row.pre_close), change: finite(row.change), pct_chg: finite(row.pct_chg),
    vol: finite(row.vol), amount: finite(row.amount),
  })).filter(row => (!expected || row.ts_code === expected) && row.trade_date && row.close != null && row.close > 0)
    .sort((a, b) => a.trade_date.localeCompare(b.trade_date));
}

function coverageForCandidate(candidate, rows) {
  const listDate = isoDate(candidate.list_date);
  const eligible = rows.filter(row => !listDate || row.trade_date >= listDate);
  return {
    canonicalCode: candidate.canonical_code,
    instrumentId: candidate.instrument_id,
    listDate,
    observedDays: eligible.length,
    firstDayDate: eligible[0]?.trade_date || null,
    firstDay: Boolean(eligible[0]),
    fiveDay: eligible.length >= 5,
    dates: eligible.slice(0, 5).map(row => row.trade_date),
  };
}

/* sourceIdFor 已迁入 server/repositories/hkDailyCoverageRepository.js */

async function sourceId(executor = pool) {
  return sourceIdFor(executor, 'tushare');
}

/* loadCandidates 已迁入 server/repositories/hkDailyCoverageRepository.js */

async function fetchOne(candidate, fetchImpl, toDate) {
  const startDate = isoDate(candidate.list_date) || addDays(toDate, -30);
  const endDate = addDays(startDate, 35) < toDate ? addDays(startDate, 35) : toDate;
  try {
    const data = fetchImpl
      ? await fetchImpl(candidate.canonical_code, startDate, endDate)
      : await tushareQuery('hk_daily', { ts_code: candidate.canonical_code, start_date: startDate.replace(/-/g, ''), end_date: endDate.replace(/-/g, '') }, HK_DAILY_FIELDS, { allowEmpty: true });
    const rows = normalizeRows(rowsFromPayload(data), candidate.canonical_code);
    return { candidate, startDate, endDate, rows, coverage: coverageForCandidate(candidate, rows) };
  } catch (error) {
    return { candidate, startDate, endDate, rows: [], coverage: { ...coverageForCandidate(candidate, []), error: error.message || String(error) }, error };
  }
}

function groupCandidates(candidates, windowDays = 45, batchSize = 40) {
  const groups = [];
  let current = [];
  let firstDate = null;
  for (const candidate of candidates) {
    const date = isoDate(candidate.list_date);
    const distance = firstDate && date ? Math.floor((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${firstDate}T00:00:00Z`)) / 86400000) : 0;
    if (current.length && (current.length >= batchSize || distance >= windowDays)) {
      groups.push(current);
      current = [];
      firstDate = null;
    }
    if (!firstDate) firstDate = date;
    current.push(candidate);
  }
  if (current.length) groups.push(current);
  return groups;
}

async function fetchBatch(candidates, fetchImpl, toDate) {
  if (fetchImpl) return Promise.all(candidates.map(candidate => fetchOne(candidate, fetchImpl, toDate)));
  if (candidates.length !== 1) throw new Error('hk_daily 官方请求一次只允许一个 ts_code；请逐证券排队请求');
  const dates = candidates.map(candidate => isoDate(candidate.list_date)).filter(Boolean);
  const startDate = dates.sort()[0] || addDays(toDate, -30);
  const latestListing = dates.sort().at(-1) || startDate;
  const endDate = addDays(latestListing, 35) < toDate ? addDays(latestListing, 35) : toDate;
  try {
    const data = await tushareQuery('hk_daily', {
      ts_code: candidates[0].canonical_code,
      start_date: startDate.replace(/-/g, ''), end_date: endDate.replace(/-/g, ''),
    }, HK_DAILY_FIELDS, { allowEmpty: true });
    const grouped = new Map();
    for (const row of normalizeRows(rowsFromPayload(data), '') || []) {
      if (!grouped.has(row.ts_code)) grouped.set(row.ts_code, []);
      grouped.get(row.ts_code).push(row);
    }
    return candidates.map(candidate => {
      const rows = normalizeRows(grouped.get(candidate.canonical_code) || [], candidate.canonical_code);
      return { candidate, startDate, endDate, rows, coverage: coverageForCandidate(candidate, rows) };
    });
  } catch (error) {
    return candidates.map(candidate => ({ candidate, startDate, endDate, rows: [], coverage: { ...coverageForCandidate(candidate, []), error: error.message || String(error) }, error }));
  }
}

async function syncHkDailyCoverage({ fromDate = DEFAULT_FROM_DATE, toDate = todayShanghai(), limit = null, concurrency = 1, maxRequests = null, fetchImpl } = {}) {
  const client = await pool.connect();
  let runId = null;
  try {
    // 默认读取全部未覆盖对象；显式 limit 只供人工调试，不能由默认配置把剩余对象伪装成已完成。
    const candidateLimit = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : null;
    const candidates = await loadCandidates(client, fromDate, toDate, candidateLimit);
    const tushareSourceId = await sourceId(client);
    const run = await repository.insert_ops_ingestion_runs([tushareSourceId, JSON.stringify({ fromDate, toDate, limit: candidateLimit, candidateCount: candidates.length })], client);
    runId = run.rows[0].run_id;
    const batchSize = fetchImpl ? Number(process.env.HK_DAILY_BATCH_SIZE || 40) : 1;
    const groups = groupCandidates(candidates, Number(process.env.HK_DAILY_BATCH_WINDOW_DAYS || 45), batchSize);
    const results = [];
    let cursor = 0;
    async function worker() {
      while (cursor < groups.length) {
        const group = groups[cursor++];
        results.push(...await fetchBatch(group, fetchImpl, toDate));
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, groups.length || 1)) }, worker));
    const successful = results.filter(result => result.rows.length);
    const bars = successful.flatMap(result => result.rows.map(row => ({
      instrument_id: result.candidate.instrument_id, trade_date: row.trade_date,
      open: row.open, high: row.high, low: row.low, close: row.close,
      volume: row.vol, amount: row.amount,
    })));
    const rawRows = results.map(result => ({
      source_key: `${result.candidate.canonical_code}:${result.startDate}:${result.endDate}`,
      payload: { api_name: 'hk_daily', ts_code: result.candidate.canonical_code, start_date: result.startDate, end_date: result.endDate,
        row_count: result.rows.length, coverage: result.coverage, error: result.error ? result.error.message || String(result.error) : null },
    }));
    await txControl.begin(client);
    if (rawRows.length) {
      await repository.insert_ops_raw_records([runId, tushareSourceId, JSON.stringify(rawRows)], client);
    }
    if (bars.length) {
      await repository.insert_market_daily_bars([JSON.stringify(bars), tushareSourceId], client);
    }
    const latestDate = bars.map(row => row.trade_date).sort().at(-1) || null;
    const failures = results.filter(result => result.error || !result.rows.length);
    const errorText = failures.map(result => `${result.candidate.canonical_code}:${result.coverage.error || 'empty'}`).join('; ').slice(0, 2000);
    const status = !results.length || (successful.length && !failures.length) ? 'succeeded' : successful.length ? 'degraded' : 'failed';
    const limited = candidateLimit !== null && candidates.length >= candidateLimit;
    const finalStatus = limited && status === 'succeeded' ? 'degraded' : status;
    const finalErrorText = limited ? [errorText, '显式批次上限后仍有候选对象，等待后续续跑'].filter(Boolean).join('; ') : errorText;
    await repository.insert_ops_sync_cursors([latestDate, finalErrorText], client);
    await repository.update_ops_ingestion_runs([runId, finalStatus, bars.length, finalErrorText], client);
    await txControl.commit(client);
    const coverage = results.map(result => result.coverage);
    return {
      ok: finalStatus !== 'failed', status: finalStatus, runId, candidates: candidates.length, rows: bars.length,
      firstDayCoverage: coverage.length ? coverage.filter(item => item.firstDay).length / coverage.length : 0,
      fiveDayCoverage: coverage.length ? coverage.filter(item => item.fiveDay).length / coverage.length : 0,
      coverage, failures: failures.length, limited,
      dataAsOf: latestDate,
    };
  } catch (error) {
    await txControl.rollback(client).catch(() => {});
    if (runId) await repository.update_ops_ingestion_runs_1([runId, 'failed', error.message || String(error)], client).catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function syncTencentHkDailyCoverage({ fromDate = DEFAULT_FROM_DATE, toDate = todayShanghai(), limit = null, targetCodes = [], fetchImpl } = {}) {
  const client = await pool.connect();
  let runId = null;
  try {
    const candidateLimit = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : null;
    const candidates = await loadCandidates(client, fromDate, toDate, candidateLimit, targetCodes);
    const tencentSourceId = await sourceIdFor(client, 'tencent');
    const run = await repository.insert_ops_ingestion_runs([tencentSourceId, JSON.stringify({ fromDate, toDate, limit: candidateLimit, targetCodes, candidateCount: candidates.length, source: 'tencent_hk_kline' })], client);
    runId = run.rows[0].run_id;
    const results = [];
    // 腾讯历史 K 线接口是单证券接口，且 Guard 对 tencent 默认并发为 1，按顺序补漏。
    for (const candidate of candidates) results.push(await fetchTencentHkDaily(candidate, toDate, fetchImpl));
    const successful = results.filter(result => result.rows.length);
    const bars = successful.flatMap(result => result.rows.map(row => ({
      instrument_id: result.candidate.instrument_id, trade_date: row.trade_date,
      open: row.open, high: row.high, low: row.low, close: row.close,
      volume: row.vol, amount: row.amount,
    })));
    const rawRows = results.map(result => ({
      source_key: `tencent:${result.candidate.canonical_code}:${result.startDate}:${result.endDate}`,
      payload: { api_name: 'tencent_hk_kline', ts_code: result.candidate.canonical_code, start_date: result.startDate,
        end_date: result.endDate, row_count: result.rows.length, coverage: result.coverage,
        error: result.error ? result.error.message || String(result.error) : null },
    }));
    await txControl.begin(client);
    if (rawRows.length) {
      await repository.insert_ops_raw_records([runId, tencentSourceId, JSON.stringify(rawRows)], client);
    }
    if (bars.length) {
      await repository.insert_market_daily_bars([JSON.stringify(bars), tencentSourceId], client);
    }
    const latestDate = bars.map(row => row.trade_date).sort().at(-1) || null;
    const failures = results.filter(result => result.error || !result.rows.length);
    const errorText = failures.map(result => `${result.candidate.canonical_code}:${result.coverage.error || 'empty'}`).join('; ').slice(0, 2000);
    const status = !results.length || (successful.length && !failures.length) ? 'succeeded' : successful.length ? 'degraded' : 'failed';
    const limited = candidateLimit !== null && candidates.length >= candidateLimit;
    const finalStatus = limited && status === 'succeeded' ? 'degraded' : status;
    const finalErrorText = limited ? [errorText, '显式批次上限后仍有候选对象，等待后续续跑'].filter(Boolean).join('; ') : errorText;
    await repository.insert_ops_sync_cursors([latestDate, finalErrorText], client);
    await repository.update_ops_ingestion_runs([runId, finalStatus, bars.length, finalErrorText], client);
    await txControl.commit(client);
    const coverage = results.map(result => result.coverage);
    return { ok: finalStatus !== 'failed', status: finalStatus, source: 'tencent_hk_kline', runId, candidates: candidates.length, rows: bars.length,
      firstDayCoverage: coverage.length ? coverage.filter(item => item.firstDay).length / coverage.length : 0,
      fiveDayCoverage: coverage.length ? coverage.filter(item => item.fiveDay).length / coverage.length : 0,
      coverage, failures: failures.length, limited, dataAsOf: latestDate };
  } catch (error) {
    await txControl.rollback(client).catch(() => {});
    if (runId) await repository.update_ops_ingestion_runs_1([runId, 'failed', error.message || String(error)], client).catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { HK_DAILY_FIELDS, isoDate, rowsFromPayload, normalizeRows, coverageForCandidate, groupCandidates, fetchBatch,
  rowsFromTencentHkKline, fetchTencentHkDaily, loadCandidates, syncHkDailyCoverage, syncTencentHkDailyCoverage };

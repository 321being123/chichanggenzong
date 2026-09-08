// 港股 IPO 上市首日/上市后五个交易日日线覆盖与标准层同步。
// 首选 Tushare hk_daily；历史补漏允许使用已存在的腾讯港股 K 线源。两者都先落库审计，失败不推进游标。
const crypto = require('crypto');
const https = require('https');
const { pool } = require('../db');
const { tushareQuery } = require('./tushare');
const { withExternalCallGuard } = require('./externalCallGuard');

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

function requestTencentHkKline(symbol, startDate, endDate) {
  const code = String(symbol || '').replace(/\.HK$/i, '').padStart(5, '0');
  const url = `https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=${encodeURIComponent(`hk${code},day,${startDate},${endDate},500`)}`;
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://gu.qq.com/' },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        if (response.statusCode !== 200) {
          const error = new Error(`Tencent HK K 线 HTTP ${response.statusCode}`);
          error.code = response.statusCode === 429 ? 'RATE_LIMIT' : 'UPSTREAM_ERROR';
          return reject(error);
        }
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (payload.code !== 0) throw new Error(payload.msg || 'Tencent HK K 线返回错误');
          resolve(payload);
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Tencent HK K 线请求超时')));
    request.on('error', reject);
  });
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

async function sourceIdFor(executor = pool, sourceCode = 'tushare') {
  const { rows } = await executor.query('SELECT source_id FROM ops.data_sources WHERE source_code=$1 LIMIT 1', [sourceCode]);
  if (!rows[0]) throw new Error(`${sourceCode} 数据源未注册`);
  return rows[0].source_id;
}

async function sourceId(executor = pool) {
  return sourceIdFor(executor, 'tushare');
}

async function loadCandidates(client, fromDate, toDate, limit) {
  const { rows } = await client.query(
    `SELECT i.instrument_id,i.canonical_code,i.list_date::text AS list_date,i.status
       FROM core.instruments i
       LEFT JOIN LATERAL (
         SELECT COUNT(DISTINCT b.trade_date)::int AS observed_days
           FROM market.daily_bars b
          WHERE b.instrument_id=i.instrument_id
            AND b.trade_date >= i.list_date
            AND b.trade_date <= $2::date
       ) coverage ON true
      WHERE i.asset_class='stock' AND i.market='HK'
        AND i.canonical_code ~ '^\\d{5}\\.HK$'
        AND i.list_date::date BETWEEN $1::date AND $2::date
        AND COALESCE(coverage.observed_days,0) < 5
      ORDER BY i.list_date,i.canonical_code
      LIMIT $3`, [fromDate, toDate, limit]
  );
  return rows;
}

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

async function syncHkDailyCoverage({ fromDate = DEFAULT_FROM_DATE, toDate = todayShanghai(), limit = 200, concurrency = 1, maxRequests = Number(process.env.HK_DAILY_MAX_REQUESTS || 1), fetchImpl } = {}) {
  const client = await pool.connect();
  let runId = null;
  try {
    const requestLimit = Number.isFinite(Number(maxRequests)) ? Math.max(1, Number(maxRequests)) : 1;
    const candidates = await loadCandidates(client, fromDate, toDate, Math.min(limit, requestLimit));
    const tushareSourceId = await sourceId(client);
    const run = await client.query(
      `INSERT INTO ops.ingestion_runs(source_id,dataset_code,request_range,status)
       VALUES($1,'hk_daily',$2::jsonb,'running') RETURNING run_id`,
      [tushareSourceId, JSON.stringify({ fromDate, toDate, candidateCount: candidates.length })]
    );
    runId = run.rows[0].run_id;
    const groups = groupCandidates(candidates, Number(process.env.HK_DAILY_BATCH_WINDOW_DAYS || 45), Number(process.env.HK_DAILY_BATCH_SIZE || 40));
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
    await client.query('BEGIN');
    if (rawRows.length) {
      await client.query(
        `INSERT INTO ops.raw_records(run_id,source_id,dataset_code,source_key,source_updated_at,payload,payload_hash)
         SELECT $1,$2,'hk_daily',x.source_key,now(),x.payload,md5(x.payload::text)
           FROM jsonb_to_recordset($3::jsonb) AS x(source_key text,payload jsonb)
         ON CONFLICT(source_id,dataset_code,source_key,payload_hash) DO NOTHING`,
        [runId, tushareSourceId, JSON.stringify(rawRows)]
      );
    }
    if (bars.length) {
      await client.query(
        `INSERT INTO market.daily_bars(instrument_id,trade_date,source_id,open,high,low,close,volume,amount)
         SELECT x.instrument_id,x.trade_date,$2,x.open,x.high,x.low,x.close,x.volume,x.amount
           FROM jsonb_to_recordset($1::jsonb) AS x(instrument_id bigint,trade_date date,open numeric,high numeric,low numeric,close numeric,volume numeric,amount numeric)
         ON CONFLICT(instrument_id,trade_date,source_id) DO UPDATE SET open=EXCLUDED.open,high=EXCLUDED.high,low=EXCLUDED.low,
           close=EXCLUDED.close,volume=EXCLUDED.volume,amount=EXCLUDED.amount,ingested_at=now()`,
        [JSON.stringify(bars), tushareSourceId]
      );
    }
    const latestDate = bars.map(row => row.trade_date).sort().at(-1) || null;
    const failures = results.filter(result => result.error || !result.rows.length);
    const errorText = failures.map(result => `${result.candidate.canonical_code}:${result.coverage.error || 'empty'}`).join('; ').slice(0, 2000);
    const status = !results.length || (successful.length && !failures.length) ? 'succeeded' : successful.length ? 'degraded' : 'failed';
    await client.query(
      `INSERT INTO ops.sync_cursors(scope_key,dataset_code,last_success_date,last_attempt_at,last_error,retry_count,updated_at)
       VALUES('HK','hk_daily',$1,now(),$2,CASE WHEN $2='' THEN 0 ELSE 1 END,now())
       ON CONFLICT(scope_key,dataset_code) DO UPDATE SET
         last_success_date=CASE WHEN EXCLUDED.last_success_date IS NULL THEN ops.sync_cursors.last_success_date
           ELSE GREATEST(COALESCE(ops.sync_cursors.last_success_date,'1900-01-01'::date),EXCLUDED.last_success_date) END,
         last_attempt_at=now(),last_error=EXCLUDED.last_error,
         retry_count=CASE WHEN EXCLUDED.last_error='' THEN 0 ELSE ops.sync_cursors.retry_count+1 END,updated_at=now()`,
      [latestDate, errorText]
    );
    await client.query('UPDATE ops.ingestion_runs SET status=$2,row_count=$3,error_message=$4,finished_at=now() WHERE run_id=$1',
      [runId, status, bars.length, errorText]);
    await client.query('COMMIT');
    const coverage = results.map(result => result.coverage);
    return {
      ok: status !== 'failed', status, runId, candidates: candidates.length, rows: bars.length,
      firstDayCoverage: coverage.length ? coverage.filter(item => item.firstDay).length / coverage.length : 0,
      fiveDayCoverage: coverage.length ? coverage.filter(item => item.fiveDay).length / coverage.length : 0,
      coverage, failures: failures.length,
      dataAsOf: latestDate,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (runId) await client.query('UPDATE ops.ingestion_runs SET status=$2,error_message=$3,finished_at=now() WHERE run_id=$1', [runId, 'failed', error.message || String(error)]).catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function syncTencentHkDailyCoverage({ fromDate = DEFAULT_FROM_DATE, toDate = todayShanghai(), limit = 200, fetchImpl } = {}) {
  const client = await pool.connect();
  let runId = null;
  try {
    const candidates = await loadCandidates(client, fromDate, toDate, limit);
    const tencentSourceId = await sourceIdFor(client, 'tencent');
    const run = await client.query(
      `INSERT INTO ops.ingestion_runs(source_id,dataset_code,request_range,status)
       VALUES($1,'hk_daily',$2::jsonb,'running') RETURNING run_id`,
      [tencentSourceId, JSON.stringify({ fromDate, toDate, candidateCount: candidates.length, source: 'tencent_hk_kline' })]
    );
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
    await client.query('BEGIN');
    if (rawRows.length) {
      await client.query(
        `INSERT INTO ops.raw_records(run_id,source_id,dataset_code,source_key,source_updated_at,payload,payload_hash)
         SELECT $1,$2,'hk_daily',x.source_key,now(),x.payload,md5(x.payload::text)
           FROM jsonb_to_recordset($3::jsonb) AS x(source_key text,payload jsonb)
         ON CONFLICT(source_id,dataset_code,source_key,payload_hash) DO NOTHING`,
        [runId, tencentSourceId, JSON.stringify(rawRows)]
      );
    }
    if (bars.length) {
      await client.query(
        `INSERT INTO market.daily_bars(instrument_id,trade_date,source_id,open,high,low,close,volume,amount)
         SELECT x.instrument_id,x.trade_date,$2,x.open,x.high,x.low,x.close,x.volume,x.amount
           FROM jsonb_to_recordset($1::jsonb) AS x(instrument_id bigint,trade_date date,open numeric,high numeric,low numeric,close numeric,volume numeric,amount numeric)
         ON CONFLICT(instrument_id,trade_date,source_id) DO UPDATE SET open=EXCLUDED.open,high=EXCLUDED.high,low=EXCLUDED.low,
           close=EXCLUDED.close,volume=EXCLUDED.volume,amount=EXCLUDED.amount,ingested_at=now()` ,
        [JSON.stringify(bars), tencentSourceId]
      );
    }
    const latestDate = bars.map(row => row.trade_date).sort().at(-1) || null;
    const failures = results.filter(result => result.error || !result.rows.length);
    const errorText = failures.map(result => `${result.candidate.canonical_code}:${result.coverage.error || 'empty'}`).join('; ').slice(0, 2000);
    const status = !results.length || (successful.length && !failures.length) ? 'succeeded' : successful.length ? 'degraded' : 'failed';
    await client.query(
      `INSERT INTO ops.sync_cursors(scope_key,dataset_code,last_success_date,last_attempt_at,last_error,retry_count,updated_at)
       VALUES('HK','hk_daily',$1,now(),$2,CASE WHEN $2='' THEN 0 ELSE 1 END,now())
       ON CONFLICT(scope_key,dataset_code) DO UPDATE SET
         last_success_date=CASE WHEN EXCLUDED.last_success_date IS NULL THEN ops.sync_cursors.last_success_date
           ELSE GREATEST(COALESCE(ops.sync_cursors.last_success_date,'1900-01-01'::date),EXCLUDED.last_success_date) END,
         last_attempt_at=now(),last_error=EXCLUDED.last_error,
         retry_count=CASE WHEN EXCLUDED.last_error='' THEN 0 ELSE ops.sync_cursors.retry_count+1 END,updated_at=now()`,
      [latestDate, errorText]
    );
    await client.query('UPDATE ops.ingestion_runs SET status=$2,row_count=$3,error_message=$4,finished_at=now() WHERE run_id=$1',
      [runId, status, bars.length, errorText]);
    await client.query('COMMIT');
    const coverage = results.map(result => result.coverage);
    return { ok: status !== 'failed', status, source: 'tencent_hk_kline', runId, candidates: candidates.length, rows: bars.length,
      firstDayCoverage: coverage.length ? coverage.filter(item => item.firstDay).length / coverage.length : 0,
      fiveDayCoverage: coverage.length ? coverage.filter(item => item.fiveDay).length / coverage.length : 0,
      coverage, failures: failures.length, dataAsOf: latestDate };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (runId) await client.query('UPDATE ops.ingestion_runs SET status=$2,error_message=$3,finished_at=now() WHERE run_id=$1', [runId, 'failed', error.message || String(error)]).catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { HK_DAILY_FIELDS, isoDate, rowsFromPayload, normalizeRows, coverageForCandidate, groupCandidates, fetchBatch,
  rowsFromTencentHkKline, fetchTencentHkDaily, syncHkDailyCoverage, syncTencentHkDailyCoverage };

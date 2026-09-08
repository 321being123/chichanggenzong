const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { pool } = require('../db/connection');
const { tushareQuery, tsRows, tsDateStr } = require('./market');
const { ensureInstrumentIdentity, resolveCanonicalCode } = require('./securityIdentity');
const { childProcessEnv, mergeExternalCallStatsFromStderr } = require('./externalCallGuard');

const ISSUE_FIELDS = 'ts_code,ann_date,res_ann_date,issue_size,issue_price,issue_type,shd_ration_record_date,shd_ration_ratio,onl_date,onl_name,onl_size,onl_pch_num,offl_size,shd_ration_size';
const OVERLAP_DAYS = 3;
const PARSER = path.resolve(__dirname, '..', 'scripts', 'extractConvertibleBondLifecycle.py');
const LIFECYCLE_TITLE = /(?:可转换公司债券|可转债).*(?:发行公告|发行提示|上市公告书|上市交易公告)/;

function isoDate(value) {
  if (!value) return null;
  const match = String(value).replace(/\//g, '-').match(/(20\d{2})-?(\d{2})-?(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function addDays(value, days) {
  const date = new Date(`${isoDate(value)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date.toISOString().slice(0, 10);
}

function issueSize100m(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return number >= 10000 ? number / 100000000 : number;
}

function lifecycleSyncWindow(lastSuccessDate, today = tsDateStr(new Date())) {
  const endDate = isoDate(today);
  const cursorDate = isoDate(lastSuccessDate);
  return cursorDate
    ? { incremental: true, startDate: addDays(cursorDate, -OVERLAP_DAYS), endDate }
    : { incremental: false, startDate: null, endDate };
}

function officialEvent(item) {
  return {
    source: String(item.source || '').toLowerCase(),
    sourceKey: String(item.source_number || item.url || `${item.event_date || ''}:${item.title || ''}`),
    url: String(item.url || ''),
    title: String(item.title || '').replace(/\s+/g, ''),
    announcementDate: isoDate(item.event_date),
    stockCode: String(item.stock_code || '').slice(0, 6),
    raw: item.raw || item,
  };
}

function lifecycleCandidates(events) {
  return [...new Map((events || []).map(officialEvent)
    .filter(item => item.url && LIFECYCLE_TITLE.test(item.title))
    .map(item => [item.url, item])).values()];
}

function pythonCandidates() {
  const root = path.resolve(__dirname, '..', '..');
  return [process.env.IPO_PYTHON_PATH, path.join(root, 'venv', 'Scripts', 'python.exe'), 'python3'].filter(Boolean);
}

async function parseLifecycleDocuments(events) {
  const candidates = lifecycleCandidates(events);
  if (!candidates.length) return [];
  const executable = pythonCandidates().find(value => value === 'python3' || fs.existsSync(value)) || 'python3';
  const parsed = [];
  for (let index = 0; index < candidates.length; index += 20) {
    const batch = candidates.slice(index, index + 20);
    const result = await new Promise((resolve, reject) => {
      const child = spawn(executable, [PARSER, ...batch.map(item => item.url)], {
        cwd: path.resolve(__dirname, '..', '..'), env: childProcessEnv({ PYTHONUTF8: '1' }), windowsHide: true,
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', data => { stdout += data; });
      child.stderr.on('data', data => { stderr += data; });
      child.on('error', reject);
      child.on('close', code => {
        mergeExternalCallStatsFromStderr(stderr);
        if (code !== 0) return reject(new Error(stderr || `生命周期公告解析失败：${code}`));
        try { resolve(JSON.parse(stdout || '[]')); } catch (error) { reject(error); }
      });
    });
    const meta = new Map(batch.map(item => [item.url, item]));
    for (const row of result) parsed.push({ ...meta.get(row.source_url), ...row });
  }
  return parsed.filter(row => !row.error && row.bond_code && (row.online_date || row.listing_date || row.shareholder_record_date));
}

async function sourceIds(client) {
  const { rows } = await client.query("SELECT source_id,source_code FROM ops.data_sources WHERE source_code IN ('tushare','cninfo','sse','szse')");
  return Object.fromEntries(rows.map(row => [row.source_code, row.source_id]));
}

async function ensureMinimalProfile(client, row, sources) {
  const canonicalCode = await resolveCanonicalCode(row.ts_code || row.bond_code, 'convertible_bond', client.query.bind(client));
  const name = row.bond_name || row.onl_name || canonicalCode;
  const listDate = isoDate(row.listing_date);
  const subscriptionDate = isoDate(row.onl_date || row.online_date);
  const identity = await ensureInstrumentIdentity({
    canonicalCode, name, assetClass: 'convertible_bond', market: 'CN',
    exchangeCode: canonicalCode.endsWith('.SH') ? 'SSE' : 'SZSE', currencyCode: 'CNY', listDate,
    status: listDate ? (listDate > isoDate(tsDateStr(new Date())) ? 'pending_listing' : 'listed') : 'announced',
    rawData: { lifecycle_source: row.source || 'tushare', subscription_date: subscriptionDate },
  }, client.query.bind(client));
  await client.query(
    `INSERT INTO fundamental.convertible_bond_profiles
       (instrument_id,bond_full_name,bond_short_name,cb_type,issue_price,issue_size,source_id,raw_payload,source_updated_at)
     VALUES($1,$2,$2,'CB',$3,$4,$5,$6::jsonb,now())
     ON CONFLICT(instrument_id) DO UPDATE SET
       bond_full_name=CASE WHEN EXCLUDED.bond_full_name<>'' THEN EXCLUDED.bond_full_name ELSE fundamental.convertible_bond_profiles.bond_full_name END,
       bond_short_name=CASE WHEN EXCLUDED.bond_short_name<>'' THEN EXCLUDED.bond_short_name ELSE fundamental.convertible_bond_profiles.bond_short_name END,
       issue_price=COALESCE(fundamental.convertible_bond_profiles.issue_price,EXCLUDED.issue_price),
       issue_size=COALESCE(fundamental.convertible_bond_profiles.issue_size,EXCLUDED.issue_size),
       raw_payload=fundamental.convertible_bond_profiles.raw_payload || EXCLUDED.raw_payload,updated_at=now()`,
    [identity.instrumentId, name || '', row.issue_price || null, row.issue_size || row.issue_scale || null,
      sources[row.source] || sources.tushare, JSON.stringify(row)]
  );
  return { instrumentId: identity.instrumentId, canonicalCode };
}

async function upsertEvent(client, instrumentId, eventType, eventDate, sourceId, sourceKey, details, official = false) {
  const date = isoDate(eventDate);
  if (!date) return false;
  await client.query(
    `INSERT INTO event.instrument_events(instrument_id,event_type,event_date,source_id,source_key,details,source_updated_at)
     VALUES($1,$2,$3::date,$4,$5,$6::jsonb,now())
     ON CONFLICT(instrument_id,event_type,event_date) DO UPDATE SET
       source_id=CASE WHEN $7::boolean THEN EXCLUDED.source_id ELSE event.instrument_events.source_id END,
       source_key=CASE WHEN $7::boolean THEN EXCLUDED.source_key ELSE event.instrument_events.source_key END,
       details=event.instrument_events.details || EXCLUDED.details,source_updated_at=now(),updated_at=now()`,
    [instrumentId, eventType, date, sourceId, sourceKey, JSON.stringify(details || {}), official]
  );
  return true;
}

async function saveIssueRow(client, row, sources, runId) {
  const { instrumentId, canonicalCode } = await ensureMinimalProfile(client, row, sources);
  const payload = JSON.stringify(row);
  const hash = crypto.createHash('sha256').update(payload).digest('hex');
  await client.query(
    `INSERT INTO ops.raw_records(run_id,source_id,dataset_code,source_key,payload,payload_hash)
     VALUES($1,$2,'cb_issue',$3,$4::jsonb,$5)
     ON CONFLICT(source_id,dataset_code,source_key,payload_hash) DO NOTHING`,
    [runId, sources.tushare, `tushare:cb_issue:${canonicalCode}`, payload, hash]
  );
  await client.query(
    `INSERT INTO fundamental.convertible_bond_issuance
       (instrument_id,issue_type,issue_price_yuan,issue_size_100m_yuan,shareholder_allotment_ratio_yuan_per_share,
        online_size_100m_yuan,offline_size_100m_yuan,online_purchase_accounts_10k,shareholder_allotment_quantity,source_id,source_updated_at,raw_payload)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),$11::jsonb)
     ON CONFLICT(instrument_id) DO UPDATE SET
       issue_type=COALESCE(EXCLUDED.issue_type,fundamental.convertible_bond_issuance.issue_type),
       issue_price_yuan=COALESCE(EXCLUDED.issue_price_yuan,fundamental.convertible_bond_issuance.issue_price_yuan),
       issue_size_100m_yuan=COALESCE(EXCLUDED.issue_size_100m_yuan,fundamental.convertible_bond_issuance.issue_size_100m_yuan),
       shareholder_allotment_ratio_yuan_per_share=COALESCE(EXCLUDED.shareholder_allotment_ratio_yuan_per_share,fundamental.convertible_bond_issuance.shareholder_allotment_ratio_yuan_per_share),
       online_size_100m_yuan=COALESCE(EXCLUDED.online_size_100m_yuan,fundamental.convertible_bond_issuance.online_size_100m_yuan),
       offline_size_100m_yuan=COALESCE(EXCLUDED.offline_size_100m_yuan,fundamental.convertible_bond_issuance.offline_size_100m_yuan),
       online_purchase_accounts_10k=COALESCE(EXCLUDED.online_purchase_accounts_10k,fundamental.convertible_bond_issuance.online_purchase_accounts_10k),
       shareholder_allotment_quantity=COALESCE(EXCLUDED.shareholder_allotment_quantity,fundamental.convertible_bond_issuance.shareholder_allotment_quantity),
       raw_payload=fundamental.convertible_bond_issuance.raw_payload || EXCLUDED.raw_payload,source_updated_at=now(),updated_at=now()`,
    [instrumentId, row.issue_type || null, row.issue_price || null, issueSize100m(row.issue_size), row.shd_ration_ratio || null,
      row.onl_size == null ? null : Number(row.onl_size) / 1000000,
      row.offl_size == null ? null : Number(row.offl_size) / 1000000,
      row.onl_pch_num == null ? null : Number(row.onl_pch_num) / 10000,
      row.shd_ration_size || null, sources.tushare, payload]
  );
  for (const [type, date] of [['issue_announcement', row.ann_date], ['shareholder_record', row.shd_ration_record_date],
    ['online_subscription', row.onl_date], ['result_announcement', row.res_ann_date]]) {
    await upsertEvent(client, instrumentId, type, date, sources.tushare,
      `tushare:cb_issue:${canonicalCode}:${type}:${isoDate(date)}`, row, false);
  }
  return canonicalCode;
}

async function saveOfficialRow(client, row, sources) {
  const source = sources[row.source] ? row.source : 'cninfo';
  const normalized = { ...row, ts_code: row.bond_code, onl_date: row.online_date };
  const { instrumentId, canonicalCode } = await ensureMinimalProfile(client, normalized, sources);
  const sourceId = sources[source] || sources.cninfo;
  for (const [type, date] of [['shareholder_record', row.shareholder_record_date], ['online_subscription', row.online_date], ['listing', row.listing_date]]) {
    await upsertEvent(client, instrumentId, type, date, sourceId,
      `${source}:${row.sourceKey}:${type}:${isoDate(date)}`, row, true);
  }
  if (row.listing_date) {
    await client.query(
      `UPDATE core.instruments SET list_date=$2::date,status=CASE WHEN $2::date>CURRENT_DATE THEN 'pending_listing' ELSE 'listed' END,updated_at=now()
        WHERE instrument_id=$1 AND (list_date IS NULL OR list_date<>$2::date)`, [instrumentId, isoDate(row.listing_date)]);
  }
  return canonicalCode;
}

async function syncConvertibleBondLifecycleFacts({ toDate, officialEvents = [], includeTushare = true } = {}) {
  const endDate = isoDate(toDate) || tsDateStr(new Date());
  const cursor = includeTushare ? await pool.query(
    "SELECT last_success_date::text FROM ops.sync_cursors WHERE scope_key='convertible_bond_lifecycle' AND dataset_code='cb_issue'"
  ) : { rows: [] };
  const window = lifecycleSyncWindow(cursor.rows[0] && cursor.rows[0].last_success_date, endDate);
  const params = window.incremental ? { start_date: window.startDate.replace(/-/g, ''), end_date: window.endDate.replace(/-/g, '') } : {};
  const issueRows = includeTushare
    ? tsRows(await tushareQuery('cb_issue', params, ISSUE_FIELDS, { allowEmpty: window.incremental }))
    : [];
  const officialRows = await parseLifecycleDocuments(officialEvents);
  if (!includeTushare && !officialRows.length) {
    return { ok: true, skipped: true, reason: 'no_changes', fromDate: window.startDate, toDate: window.endDate, issueCount: 0, officialCount: 0 };
  }
  const client = await pool.connect();
  let runId = null;
  try {
    await client.query('BEGIN');
    const sources = await sourceIds(client);
    const run = await client.query(
      `INSERT INTO ops.ingestion_runs(source_id,dataset_code,request_range,status)
       VALUES($1,'bond_lifecycle',$2::jsonb,'running') RETURNING run_id`,
      [includeTushare ? sources.tushare : (sources.cninfo || sources.sse || sources.szse), JSON.stringify({ ...window, includeTushare })]
    );
    runId = run.rows[0].run_id;
    const persisted = new Set();
    const expectedEvents = [];
    for (const row of issueRows) {
      const code = await saveIssueRow(client, row, sources, runId);
      persisted.add(code);
      for (const [eventType, value] of [['issue_announcement', row.ann_date], ['shareholder_record', row.shd_ration_record_date],
        ['online_subscription', row.onl_date], ['result_announcement', row.res_ann_date]]) {
        if (isoDate(value)) expectedEvents.push({ code, event_type: eventType, event_date: isoDate(value) });
      }
    }
    for (const row of officialRows) {
      const code = await saveOfficialRow(client, row, sources);
      persisted.add(code);
      for (const [eventType, value] of [['shareholder_record', row.shareholder_record_date],
        ['online_subscription', row.online_date], ['listing', row.listing_date]]) {
        if (isoDate(value)) expectedEvents.push({ code, event_type: eventType, event_date: isoDate(value) });
      }
    }
    const uniqueExpected = [...new Map(expectedEvents.map(item => [`${item.code}:${item.event_type}:${item.event_date}`, item])).values()];
    if (uniqueExpected.length) {
      const missing = await client.query(
        `WITH expected AS (
           SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(code text,event_type text,event_date date)
         )
         SELECT x.code,x.event_type,x.event_date::text
           FROM expected x
           LEFT JOIN core.instruments i ON i.canonical_code=x.code
           LEFT JOIN event.instrument_events e ON e.instrument_id=i.instrument_id
             AND e.event_type=x.event_type AND e.event_date=x.event_date
          WHERE e.event_id IS NULL`, [JSON.stringify(uniqueExpected)]
      );
      if (missing.rows.length) {
        throw new Error(`可转债生命周期入库不完整：${missing.rows.slice(0, 10).map(row => `${row.code}/${row.event_type}/${row.event_date}`).join(',')}`);
      }
    }
    if (includeTushare) {
      await client.query(
        `INSERT INTO ops.sync_cursors(scope_key,dataset_code,last_success_date,last_source_update,last_attempt_at,last_error,retry_count)
         VALUES('convertible_bond_lifecycle','cb_issue',$1,now(),now(),'',0)
         ON CONFLICT(scope_key,dataset_code) DO UPDATE SET last_success_date=EXCLUDED.last_success_date,last_source_update=now(),
           last_attempt_at=now(),last_error='',retry_count=0,updated_at=now()`, [window.endDate]
      );
    }
    await client.query("UPDATE ops.ingestion_runs SET status='success',row_count=$2,finished_at=now() WHERE run_id=$1", [runId, persisted.size]);
    await client.query('COMMIT');
    return { ok: true, fromDate: window.startDate, toDate: window.endDate, issueCount: issueRows.length,
      officialCount: officialRows.length, eventCount: uniqueExpected.length,
      qualityStatus: 'passed', persistedCodes: [...persisted].filter(Boolean) };
  } catch (error) {
    await client.query('ROLLBACK');
    if (runId) await pool.query("UPDATE ops.ingestion_runs SET status='failed',error_message=$2,finished_at=now() WHERE run_id=$1", [runId, String(error.message || error).slice(0, 1000)]).catch(() => {});
    throw error;
  } finally { client.release(); }
}

module.exports = { OVERLAP_DAYS, LIFECYCLE_TITLE, lifecycleSyncWindow, lifecycleCandidates, issueSize100m, syncConvertibleBondLifecycleFacts };

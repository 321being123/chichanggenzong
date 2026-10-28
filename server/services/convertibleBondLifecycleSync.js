const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { pool } = require('../db/connection');
const { tushareQuery, tsRows, tsDateStr } = require('./market');
const { ensureInstrumentIdentity, resolveCanonicalCode } = require('./securityIdentity');
const { childProcessEnv, mergeExternalCallStatsFromStderr } = require('./externalCallGuard');
const txControl = require('../repositories/transactionControl');
const { sourceIds } = require('../repositories/convertibleBondLifecycleSyncRepository.js');
const repository = require('../repositories/convertibleBondLifecycleSyncRepository.js');

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

/* sourceIds 已迁入 server/repositories/convertibleBondLifecycleSyncRepository.js */

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
  await repository.insert_fundamental_convertible_bond_profiles([identity.instrumentId, name || '', row.issue_price || null, row.issue_size || row.issue_scale || null,
      sources[row.source] || sources.tushare, JSON.stringify(row)], client);
  return { instrumentId: identity.instrumentId, canonicalCode };
}

async function upsertEvent(client, instrumentId, eventType, eventDate, sourceId, sourceKey, details, official = false) {
  const date = isoDate(eventDate);
  if (!date) return false;
  await repository.insert_event_instrument_events([instrumentId, eventType, date, sourceId, sourceKey, JSON.stringify(details || {}), official], client);
  return true;
}

async function saveIssueRow(client, row, sources, runId) {
  const { instrumentId, canonicalCode } = await ensureMinimalProfile(client, row, sources);
  const payload = JSON.stringify(row);
  const hash = crypto.createHash('sha256').update(payload).digest('hex');
  await repository.insert_ops_raw_records([runId, sources.tushare, `tushare:cb_issue:${canonicalCode}`, payload, hash], client);
  await repository.insert_fundamental_convertible_bond_issuance([instrumentId, row.issue_type || null, row.issue_price || null, issueSize100m(row.issue_size), row.shd_ration_ratio || null,
      row.onl_size == null ? null : Number(row.onl_size) / 1000000,
      row.offl_size == null ? null : Number(row.offl_size) / 1000000,
      row.onl_pch_num == null ? null : Number(row.onl_pch_num) / 10000,
      row.shd_ration_size || null, sources.tushare, payload], client);
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
    await repository.update_core_instruments([instrumentId, isoDate(row.listing_date)], client);
  }
  return canonicalCode;
}

async function syncConvertibleBondLifecycleFacts({ toDate, officialEvents = [], includeTushare = true } = {}) {
  const endDate = isoDate(toDate) || tsDateStr(new Date());
  const cursor = includeTushare ? await repository.select_ops_sync_cursors() : { rows: [] };
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
    await txControl.begin(client);
    const sources = await sourceIds(client);
    const run = await repository.insert_ops_ingestion_runs([includeTushare ? sources.tushare : (sources.cninfo || sources.sse || sources.szse), JSON.stringify({ ...window, includeTushare })], client);
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
      const missing = await repository.with_jsonb_to_recordset([JSON.stringify(uniqueExpected)], client);
      if (missing.rows.length) {
        throw new Error(`可转债生命周期入库不完整：${missing.rows.slice(0, 10).map(row => `${row.code}/${row.event_type}/${row.event_date}`).join(',')}`);
      }
    }
    if (includeTushare) {
      await repository.insert_ops_sync_cursors([window.endDate], client);
    }
    await repository.update_ops_ingestion_runs([runId, persisted.size], client);
    await txControl.commit(client);
    return { ok: true, fromDate: window.startDate, toDate: window.endDate, issueCount: issueRows.length,
      officialCount: officialRows.length, eventCount: uniqueExpected.length,
      qualityStatus: 'passed', persistedCodes: [...persisted].filter(Boolean) };
  } catch (error) {
    await txControl.rollback(client);
    if (runId) await repository.update_ops_ingestion_runs_1([runId, String(error.message || error).slice(0, 1000)]).catch(() => {});
    throw error;
  } finally { client.release(); }
}

module.exports = { OVERLAP_DAYS, LIFECYCLE_TITLE, lifecycleSyncWindow, lifecycleCandidates, issueSize100m, syncConvertibleBondLifecycleFacts };

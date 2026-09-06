// Nginx 访问日志增量采集：复用 ops.sync_cursors 保存文件身份、轮转代数和字节偏移。
// 采集是后台辅助能力，文件不存在或单次解析失败都不能影响 Worker 健康检查。
const fs = require('fs');
const path = require('path');
const { pool } = require('../db/connection');
const { writeRuntimeRows, normalizedRoute } = require('./siteAnalytics');

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_LINES = 5000;
const SCOPE_KEY = 'site_analytics:nginx';
const DATASET_CODE = 'access_log';

function parseNginxLine(line) {
  const match = String(line || '').match(/^(\S+)\s+rid=\S+\s+"([A-Z]+)\s+([^\s"]+)[^\"]*"\s+status=(\d+)\s+request_time=([\d.]+)\s+[^\n]*?bytes=(\d+)/);
  if (!match) return null;
  const at = new Date(match[1]);
  if (!Number.isFinite(at.getTime())) return null;
  const requestUrl = match[3].split('?')[0];
  let routeKey = normalizedRoute(requestUrl);
  if (!routeKey && /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?|map)$/i.test(requestUrl)) routeKey = '__static__';
  if (!routeKey) return null;
  const durationMs = Math.max(Number(match[5]) * 1000, 0);
  const durationBuckets = { lt100: 0, ms100_499: 0, ms500_999: 0, gte1000: 0 };
  if (durationMs < 100) durationBuckets.lt100 = 1;
  else if (durationMs < 500) durationBuckets.ms100_499 = 1;
  else if (durationMs < 1000) durationBuckets.ms500_999 = 1;
  else durationBuckets.gte1000 = 1;
  const status = Number(match[4]);
  return {
    at, routeKey, requestKind: requestUrl.startsWith('/api/') ? 'api' : (routeKey === '__static__' ? 'static' : 'page'),
    status, durationBuckets, bytesSent: Number(match[6]) || 0,
  };
}

function fileIdentity(filePath, stat) {
  return `${path.resolve(filePath)}:${Number(stat.dev || 0)}:${Number(stat.ino || 0)}:${Number(stat.birthtimeMs || 0)}`;
}

function addRow(map, parsed) {
  const bucket = new Date(parsed.at);
  bucket.setUTCSeconds(0, 0);
  const key = bucket.toISOString() + ':' + parsed.routeKey;
  let row = map.get(key);
  if (!row) {
    row = { layer: 'nginx', bucketStart: bucket, routeKey: parsed.routeKey, requestKind: parsed.requestKind,
      requestCount: 0, status2xx: 0, status3xx: 0, status4xx: 0, status429: 0, status5xx: 0,
      durationBuckets: { lt100: 0, ms100_499: 0, ms500_999: 0, gte1000: 0 }, bytesSent: 0, errorCount: 0,
      sampleType: 'access_log', coverageStatus: 'complete' };
    map.set(key, row);
  }
  row.requestCount++;
  if (parsed.status >= 200 && parsed.status < 300) row.status2xx++;
  else if (parsed.status >= 300 && parsed.status < 400) row.status3xx++;
  else if (parsed.status === 429) { row.status4xx++; row.status429++; }
  else if (parsed.status >= 400 && parsed.status < 500) row.status4xx++;
  else if (parsed.status >= 500) { row.status5xx++; row.errorCount++; }
  Object.keys(row.durationBuckets).forEach(key => { row.durationBuckets[key] += parsed.durationBuckets[key]; });
  row.bytesSent += parsed.bytesSent;
}

function extractCompleteLines(text) {
  const value = String(text || '');
  const lastBreak = value.lastIndexOf('\n');
  if (lastBreak < 0) return { lineMatches: [], selectedText: '' };
  const complete = value.slice(0, lastBreak + 1);
  const lineMatches = complete.match(/.*?(?:\r\n|\n)/g) || [];
  return { lineMatches, selectedText: lineMatches.slice(0, MAX_LINES).join('') };
}

async function saveCursor(client, payload, lastError = '') {
  await client.query(`INSERT INTO ops.sync_cursors(scope_key,dataset_code,last_success_date,last_source_update,last_attempt_at,last_error,cursor_payload)
    VALUES ($1,$2,CURRENT_DATE,now(),now(),$3,$4::jsonb)
    ON CONFLICT(scope_key,dataset_code) DO UPDATE SET last_success_date=CURRENT_DATE,last_source_update=now(),last_attempt_at=now(),last_error=EXCLUDED.last_error,cursor_payload=EXCLUDED.cursor_payload,updated_at=now()`,
  [SCOPE_KEY, DATASET_CODE, lastError, JSON.stringify(payload)]);
}

async function collectNginxRuntime() {
  const filePath = String(process.env.NGINX_ACCESS_LOG_PATH || '').trim();
  if (!filePath) return { status: 'not_configured', processed: 0 };
  let stat;
  try { stat = fs.statSync(filePath); } catch (error) {
    console.warn('[site-analytics] Nginx 日志不可用:', error.message);
    return { status: 'unavailable', processed: 0, error: error.message };
  }
  const identity = fileIdentity(filePath, stat);
  const cursorResult = await pool.query(`SELECT cursor_payload FROM ops.sync_cursors WHERE scope_key=$1 AND dataset_code=$2 LIMIT 1`, [SCOPE_KEY, DATASET_CODE]);
  const previous = cursorResult.rows[0] && cursorResult.rows[0].cursor_payload || {};
  let offset = Number(previous.offset) || 0;
  let generation = Number(previous.generation) || 0;
  let cursorWarning = '';
  if (!previous.fileIdentity) {
    const client = await pool.connect();
    try { await client.query('BEGIN'); await saveCursor(client, { fileIdentity: identity, offset: stat.size, generation }); await client.query('COMMIT'); }
    catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
    return { status: 'initialized_at_tail', processed: 0, offset: stat.size };
  }
  if (previous.fileIdentity && previous.fileIdentity !== identity) { offset = 0; generation++; cursorWarning = '日志文件已轮转，旧文件尾部未核对'; }
  if (stat.size < offset) { offset = 0; generation++; cursorWarning = '日志文件被截断，已从新位置继续'; }
  if (stat.size === offset) {
    const client = await pool.connect();
    try { await client.query('BEGIN'); await saveCursor(client, { fileIdentity: identity, offset, generation }, cursorWarning); await client.query('COMMIT'); }
    catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
    return { status: 'ok', processed: 0, offset };
  }
  const readLength = Math.min(MAX_BYTES, stat.size - offset);
  const buffer = Buffer.alloc(readLength);
  const fd = fs.openSync(filePath, 'r');
  let bytesRead;
  try { bytesRead = fs.readSync(fd, buffer, 0, readLength, offset); } finally { fs.closeSync(fd); }
  const text = buffer.subarray(0, bytesRead).toString('utf8');
  const extracted = extractCompleteLines(text);
  if (!extracted.lineMatches.length) {
    const client = await pool.connect();
    try { await client.query('BEGIN'); await saveCursor(client, { fileIdentity: identity, offset, generation }, cursorWarning || '日志尚未形成完整行'); await client.query('COMMIT'); }
    catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
    return { status: 'waiting_for_line', processed: 0, offset };
  }
  const selectedText = extracted.selectedText;
  const selectedLines = selectedText.split(/\r?\n/).filter(Boolean);
  const consumed = Buffer.byteLength(selectedText, 'utf8');
  const endOffset = offset + consumed;
  const rows = new Map();
  let processed = 0;
  let parseFailures = 0;
  for (const line of selectedLines) {
    const parsed = parseNginxLine(line);
    if (parsed) { addRow(rows, parsed); processed++; }
    else parseFailures++;
  }
  if (parseFailures) rows.forEach(row => { row.coverageStatus = 'partial'; });
  if (parseFailures) cursorWarning = [cursorWarning, `有${parseFailures}行日志无法解析`].filter(Boolean).join('；');
  const payload = { fileIdentity: identity, offset: endOffset, generation, lastReadAt: new Date().toISOString() };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await writeRuntimeRows([...rows.values()].map(row => ({ ...row,
      batchId: `nginx:${generation}:${offset}-${endOffset}:${row.bucketStart.toISOString()}:${row.routeKey}`,
      processInstance: 'nginx-collector', sourceFile: path.basename(filePath),
    })), client);
    await saveCursor(client, payload, cursorWarning);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
  return { status: 'ok', processed, rows: rows.size, offset: endOffset };
}

module.exports = { parseNginxLine, collectNginxRuntime, extractCompleteLines };

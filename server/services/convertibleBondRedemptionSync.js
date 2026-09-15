const crypto = require('crypto');
const os = require('os');
const { pool } = require('../db/connection');
const { searchAnnouncements } = require('./cninfoAnnouncement');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { childProcessEnv, mergeExternalCallStatsFromStderr } = require('./externalCallGuard');

const SOURCE_CODE = 'convertible_bond_redemption_announcements';
const DATASET_CODE = 'bond_redemption_events';
const PARSER_VERSION = 'call-event-v3';
const PROJECTION_SCOPE = 'convertible_bond_call_projection:call-event-v3';

function isoDate(value) {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(value).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
    return parts.year && parts.month && parts.day ? `${parts.year}-${parts.month}-${parts.day}` : null;
  }
  const text = String(value).replace(/年|月/g, '-').replace(/日/g, '').replace(/\//g, '-').replace(/\./g, '-');
  const match = text.match(/(20\d{2})-(\d{1,2})-(\d{1,2})/);
  return match ? `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}` : null;
}

function dateFromUrl(url) {
  const match = String(url || '').match(/\/(20\d{2}-\d{2}-\d{2})\//);
  return match ? match[1] : null;
}

function announcementDate(item) {
  const payload = item && item.rawPayload && typeof item.rawPayload === 'object' ? item.rawPayload : item || {};
  const timestamp = Number(payload.announcementTime);
  if (Number.isFinite(timestamp) && timestamp > 0) {
    const millis = timestamp < 1e12 ? timestamp * 1000 : timestamp;
    const date = new Date(millis);
    if (!Number.isNaN(date.getTime())) {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
        .formatToParts(date).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
      return `${parts.year}-${parts.month}-${parts.day}`;
    }
  }
  return dateFromUrl(item && (item.fileLink || item.url)) || isoDate(item && item.announcedAt);
}

function dateFromTitle(title, patterns) {
  for (const pattern of patterns) {
    const match = String(title || '').match(pattern);
    const date = match && isoDate(match[1]);
    if (date) return date;
  }
  return null;
}

function classifyCallEvent(title) {
  const text = String(title || '');
  if (!/(赎回|转债|强赎|转股)/.test(text)) return null;
  // “现金管理到期赎回”等理财公告不属于可转债事件；只有同时出现明确转债证据时才继续分类。
  if (/(现金管理|理财产品|结构性存款|闲置自有资金|委托理财)/.test(text)
      && !/(可转债|转债|债券代码|最后交易日|最后转股日|赎回登记日|转股价|转股期)/.test(text)) return null;
  if (/不提前赎回|不行使.*赎回|不实施.*赎回|暂不赎回/.test(text)) return 'waive';
  if (/实施结果|赎回结果|完成赎回|赎回完成/.test(text)) return 'completion';
  if (/赎回实施|实施.*赎回|到期兑付|到期偿付|兑付暨摘牌|到期赎回|停止交易|最后交易日|最后转股日|赎回公告/.test(text)) return 'implementation';
  if (/可能触发|触发条件|强赎提示/.test(text)) return 'warning';
  if (/强赎|提前赎回|触发.*赎回|可能触发/.test(text)) return 'exercise';
  return null;
}

function eventDates(title, eventType) {
  const lastConversionDate = dateFromTitle(title, [
    /最后转股日(?:为|：|是)?\s*([0-9]{4}[年.-][0-9]{1,2}[月.-][0-9]{1,2}日?)/,
    /转股截止日(?:为|：|是)?\s*([0-9]{4}[年.-][0-9]{1,2}[月.-][0-9]{1,2}日?)/,
  ]);
  const lastTradeDate = dateFromTitle(title, [
    /最后交易日(?:为|：|是)?\s*([0-9]{4}[年.-][0-9]{1,2}[月.-][0-9]{1,2}日?)/,
  ]);
  const redemptionRecordDate = dateFromTitle(title, [
    /登记日(?:为|：|是)?\s*([0-9]{4}[年.-][0-9]{1,2}[月.-][0-9]{1,2}日?)/,
    /赎回登记日(?:为|：|是)?\s*([0-9]{4}[年.-][0-9]{1,2}[月.-][0-9]{1,2}日?)/,
  ]);
  const noCallUntil = dateFromTitle(title, [
    /不提前赎回[^0-9]{0,30}(?:至|到|截止|止)\s*([0-9]{4}[年.-][0-9]{1,2}[月.-][0-9]{1,2}日?)/,
    /不提前赎回[^0-9]{0,30}([0-9]{4}[年.-][0-9]{1,2}[月.-][0-9]{1,2}日?)[^0-9]{0,10}(?:起|止)/,
  ]);
  return { lastConversionDate, lastTradeDate, redemptionRecordDate, noCallUntil,
    parseStatus: eventType && (lastConversionDate || lastTradeDate || redemptionRecordDate || noCallUntil) ? 'complete' : 'partial' };
}

function pickInstrument(item, candidates) {
  if (!candidates.length) return null;
  const title = String(item.title || '').replace(/[“”‘’「」《》\s]/g, '');
  const nameMatches = candidates.filter(row => {
    const bondName = String(row.bond_name || '').replace(/[“”‘’「」《》\s]/g, '');
    const securityCode = String(row.security_code || '');
    return bondName && title.includes(bondName) || securityCode && title.includes(securityCode);
  });
  if (nameMatches.length === 1) return nameMatches[0].instrument_id;
  // 同一正股存在多只转债且公告无法唯一匹配时，进入待确认，不能默认取第一只。
  if (candidates.length === 1) return candidates[0].instrument_id;
  return null;
}

function parserVersionNumber(value) {
  const match = String(value || '').match(/(?:v|-)\.?(\d+)$/i) || String(value || '').match(/^(\d+)$/);
  return match ? Number(match[1]) : 0;
}

function parseQualityRank(value) {
  return { failed: 0, partial: 1, complete: 2 }[String(value || '')] ?? 0;
}

async function loadDocumentCache(urls) {
  if (!urls.length) return new Map();
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (url) document_id,url,content_hash,raw_payload
       FROM event.documents
      WHERE document_type='convertible_bond_call_announcement' AND url=ANY($1::text[])
      ORDER BY url,created_at DESC,document_id DESC`, [urls]
  );
  return new Map(rows.map(row => [row.url, row]));
}

async function parseOfficialDocuments(items, maxUrls = 50, { cachedOnly = false } = {}) {
  const uniqueUrls = [...new Set((items || []).map(item => item.fileLink).filter(Boolean))];
  const limit = Number.isFinite(Number(maxUrls)) && Number(maxUrls) > 0 ? Number(maxUrls) : uniqueUrls.length;
  const urls = uniqueUrls.slice(0, limit);
  const cache = await loadDocumentCache(urls);
  const cachedTexts = {};
  const metadata = {};
  const byUrl = new Map();
  const readyUrls = new Set();
  let cacheMisses = 0;
  for (const item of items || []) {
    if (!item.fileLink) continue;
    const cached = cache.get(item.fileLink);
    const extraction = cached && cached.raw_payload && cached.raw_payload.extraction;
    const text = cached && cached.raw_payload && cached.raw_payload.extracted_text;
    metadata[item.fileLink] = {
      title: item.title || '', event_type: classifyCallEvent(item.title),
      announced_at: announcementDate(item), content_hash: cached && cached.content_hash || '',
      ...(extraction || {}),
    };
    if (typeof text === 'string' && text.length > 0) {
      cachedTexts[item.fileLink] = text;
      readyUrls.add(item.fileLink);
    } else if (cachedOnly) {
      cacheMisses++;
      byUrl.set(item.fileLink, {
        source_url: item.fileLink, parser_version: PARSER_VERSION, parse_status: 'failed',
        extraction: { status: 'failed', error: 'DOCUMENT_CACHE_MISS' }, errors: ['DOCUMENT_CACHE_MISS']
      });
    }
  }
  const pendingUrls = cachedOnly ? Object.keys(cachedTexts) : urls;
  const root = path.join(__dirname, '..', '..');
  const script = path.join(root, 'server', 'scripts', 'extractConvertibleBondCallEvent.py');
  const candidates = [process.env.CALL_EVENT_PYTHON, path.join(root, 'venv', 'Scripts', 'python.exe'), 'python3'].filter(Boolean);
  const python = candidates.find(candidate => candidate === 'python3' || fs.existsSync(candidate)) || 'python3';
  let downloadFailed = 0;
  let extractFailed = 0;
  let parsePartial = 0;
  if (pendingUrls.length) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bond-call-v3-'));
    const textFile = path.join(tempDir, 'texts.json');
    const metadataFile = path.join(tempDir, 'metadata.json');
    try {
      fs.writeFileSync(textFile, JSON.stringify(cachedTexts), 'utf8');
      fs.writeFileSync(metadataFile, JSON.stringify(metadata), 'utf8');
      for (let index = 0; index < pendingUrls.length; index += 10) {
        const batch = pendingUrls.slice(index, index + 10);
        try {
          const output = await new Promise((resolve, reject) => {
            execFile(python, [script, '--text-json', textFile, '--metadata-json', metadataFile, ...batch], {
              cwd: root, env: childProcessEnv({ PYTHONUTF8: '1' }), timeout: 2 * 60 * 1000, maxBuffer: 8 * 1024 * 1024
            }, (error, stdout, stderr) => {
              mergeExternalCallStatsFromStderr(stderr);
              if (error) { error.detail = String(stderr || error.message); reject(error); return; }
              resolve(String(stdout || '[]'));
            });
          });
          for (const row of JSON.parse(output)) if (row && row.source_url) byUrl.set(row.source_url, row);
        } catch (error) {
          for (const url of batch) if (!byUrl.has(url)) byUrl.set(url, {
            source_url: url, parser_version: PARSER_VERSION, parse_status: 'failed',
            extraction: { status: 'failed', error: String(error.detail || error.message) }, errors: ['PARSER_PROCESS_FAILED']
          });
        }
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
  for (const url of urls) {
    const row = byUrl.get(url);
    if (!row) {
      byUrl.set(url, { source_url: url, parser_version: PARSER_VERSION, parse_status: 'failed',
        extraction: { status: 'failed', error: 'DOCUMENT_NOT_PARSED' }, errors: ['DOCUMENT_NOT_PARSED'] });
      extractFailed++;
    } else if (row.parse_status === 'failed') {
      const errorText = JSON.stringify(row.errors || row.extraction || '');
      if (/DOWNLOAD|官方|url|PARSER_PROCESS/.test(errorText)) downloadFailed++;
      else extractFailed++;
    } else if (row.parse_status !== 'complete') {
      parsePartial++;
    }
    if (row && row.parse_status !== 'failed' && row.extraction && row.extraction.status === 'complete') readyUrls.add(url);
  }
  return { byUrl, stats: { documents_ready: readyUrls.size, cache_miss: cacheMisses,
    download_failed: downloadFailed, extract_failed: extractFailed, parse_partial: parsePartial } };
}

function eventParseComplete(eventType, dates) {
  const value = dates || {};
  if (eventType === 'exercise') return Boolean(value.decisionDate);
  if (eventType === 'implementation') return Boolean(value.lastTradeDate && value.lastConversionDate);
  if (eventType === 'waive') return Boolean(value.noCallUntil || value.validityBasis === 'through_maturity');
  if (eventType === 'completion') return Boolean(value.redemptionRecordDate || value.redemptionPrice != null);
  return eventType === 'warning';
}

function callItemsFromOfficialEvents(events) {
  return (events || []).map(item => ({
    sourceKey: item.source_number || item.url || `${item.event_date || ''}:${item.stock_code || ''}:${item.title || ''}`,
    fileLink: item.url || '', title: item.title || '', announcedAt: announcementDate({ announcedAt: item.event_date,
      fileLink: item.url, rawPayload: item.raw || item }),
    stockCode: String(item.stock_code || '').slice(0, 6), exchange: String(item.source || '').toUpperCase(),
    instrumentId: item.instrument_id || item.instrumentId || null,
    rawPayload: item.raw || item,
  }));
}

async function saveDocument(client, item, parsed, sourceId, rawRecordId) {
  if (!item.fileLink || !parsed) return null;
  const payload = {
    parser_version: PARSER_VERSION,
    extracted_text: parsed.extracted_text || '',
    extraction: parsed.extraction || {},
    text_hash: parsed.text_hash || '',
    evidence: parsed.evidence || {}, errors: parsed.errors || [], parse_status: parsed.parse_status || 'failed'
  };
  const { rows } = await client.query(
    `INSERT INTO event.documents(company_id,document_type,title,announced_at,url,source_id,content_hash,raw_record_id,raw_payload)
     VALUES(NULL,'convertible_bond_call_announcement',$1,$2::date,$3,$4,$5,$6,$7::jsonb)
     ON CONFLICT(source_id,url,content_hash) DO UPDATE SET title=EXCLUDED.title,announced_at=EXCLUDED.announced_at,
       raw_record_id=COALESCE(EXCLUDED.raw_record_id,event.documents.raw_record_id),raw_payload=EXCLUDED.raw_payload
     RETURNING document_id`, [item.title || '', isoDate(item.announcedAt), item.fileLink, sourceId,
      parsed.content_hash || '', rawRecordId || null, JSON.stringify(payload)]
  );
  return rows[0] && rows[0].document_id;
}

async function recordCallQuality(client, item, instrumentId, issueType, details, severity = 'warning') {
  if (instrumentId) {
    await client.query(
      `INSERT INTO ops.data_quality_issues(instrument_id,dataset_code,field_code,issue_type,severity,details)
       VALUES($1,$2,'announcement',$3,$4,$5::jsonb)
       ON CONFLICT(instrument_id,dataset_code,field_code,issue_type,status)
       DO UPDATE SET severity=EXCLUDED.severity,details=EXCLUDED.details,detected_at=now(),resolved_at=NULL`,
      [instrumentId, DATASET_CODE, issueType, severity, JSON.stringify({ source_key: item.sourceKey, ...(details || {}) })]
    );
    return;
  }
  const payload = JSON.stringify({ source_key: item.sourceKey, ...(details || {}) });
  const existing = await client.query(
    `SELECT issue_id FROM ops.data_quality_issues
      WHERE instrument_id IS NULL AND dataset_code=$1 AND field_code='announcement' AND issue_type=$2
        AND status='open' AND details->>'source_key'=$3 LIMIT 1`, [DATASET_CODE, issueType, item.sourceKey]
  );
  if (existing.rows[0]) {
    await client.query(`UPDATE ops.data_quality_issues SET severity=$2,details=$3::jsonb,detected_at=now() WHERE issue_id=$1`,
      [existing.rows[0].issue_id, severity, payload]);
  } else {
    await client.query(
      `INSERT INTO ops.data_quality_issues(instrument_id,dataset_code,field_code,issue_type,severity,details)
       VALUES(NULL,$1,'announcement',$2,$3,$4::jsonb)`, [DATASET_CODE, issueType, severity, payload]
    );
  }
}

async function resolveCallQuality(client, item, instrumentId, issueType) {
  const scopes = [];
  if (instrumentId) scopes.push({
    where: `instrument_id=$1 AND dataset_code=$2 AND field_code='announcement' AND issue_type=$3`,
    params: [instrumentId, DATASET_CODE, issueType],
  });
  scopes.push({
    where: `instrument_id IS NULL AND dataset_code=$1 AND field_code='announcement' AND issue_type=$2 AND details->>'source_key'=$3`,
    params: [DATASET_CODE, issueType, item.sourceKey],
  });
  for (const scope of scopes) {
    const openRows = await client.query(
      `SELECT issue_id FROM ops.data_quality_issues WHERE ${scope.where} AND status='open' ORDER BY issue_id`, scope.params
    );
    if (!openRows.rows.length) continue;
    const resolved = await client.query(
      `SELECT issue_id FROM ops.data_quality_issues WHERE ${scope.where} AND status='resolved' LIMIT 1`, scope.params
    );
    if (resolved.rows.length) {
      await client.query('DELETE FROM ops.data_quality_issues WHERE issue_id=ANY($1::bigint[])', [openRows.rows.map(row => row.issue_id)]);
    } else {
      await client.query(
        `UPDATE ops.data_quality_issues SET status='resolved',resolved_at=now() WHERE issue_id=ANY($1::bigint[])`,
        [openRows.rows.map(row => row.issue_id)]
      );
    }
  }
}

async function reconcileCallQuality(client) {
  await client.query(
    `DELETE FROM ops.data_quality_issues q
      WHERE q.dataset_code=$1 AND q.field_code='announcement' AND q.issue_type='unmatched_security' AND q.status='open'
        AND EXISTS (
          SELECT 1 FROM ops.data_quality_issues resolved
           WHERE resolved.dataset_code=q.dataset_code AND resolved.field_code=q.field_code
             AND resolved.issue_type=q.issue_type AND resolved.status='resolved'
             AND resolved.instrument_id IS NULL AND resolved.details->>'source_key'=q.details->>'source_key'
        )`, [DATASET_CODE]
  );
  await client.query(
    `UPDATE ops.data_quality_issues q SET status='resolved',resolved_at=now()
      WHERE q.dataset_code=$1 AND q.field_code='announcement' AND q.issue_type='unmatched_security' AND q.status='open'
        AND EXISTS (
          SELECT 1 FROM event.convertible_bond_call_events e
           WHERE e.instrument_id IS NOT NULL
             AND (e.source_key=q.details->>'source_key' OR e.source_url=q.details->>'source_key')
        )`, [DATASET_CODE]
  );
  await client.query(
    `UPDATE ops.data_quality_issues q SET status='resolved',resolved_at=now()
      WHERE q.dataset_code=$1 AND q.field_code='announcement' AND q.issue_type='document_cache_miss' AND q.status='open'
        AND EXISTS (
          SELECT 1
            FROM event.convertible_bond_call_events e
            JOIN event.documents d ON d.document_id=e.document_id
           WHERE (e.source_key=q.details->>'source_key' OR e.source_url=q.details->>'source_key')
             AND d.document_type='convertible_bond_call_announcement'
             AND d.raw_payload->'extraction'->>'status'='complete'
        )`, [DATASET_CODE]
  );
}

async function syncConvertibleBondCallAnnouncements({ fromDate, toDate, exchanges = ['sse', 'szse'], stock = '', keywords = null,
  officialEvents = null, cachedOnly = false, retryFailed = false, limit = 2000 } = {}) {
  const end = isoDate(toDate) || new Date().toISOString().slice(0, 10);
  const start = isoDate(fromDate) || new Date(Date.now() - 31 * 86400000).toISOString().slice(0, 10);
  const sourceRows = await pool.query('SELECT source_id FROM ops.data_sources WHERE source_code=$1', [SOURCE_CODE]);
  if (!sourceRows.rows[0]) throw new Error('强赎公告数据源尚未完成数据库迁移');
  const sourceId = sourceRows.rows[0].source_id;
  const { rows: instruments } = await pool.query(
    `SELECT p.instrument_id,split_part(s.canonical_code,'.',1) AS stock_code,
            split_part(i.canonical_code,'.',1) AS security_code,i.name AS bond_name,p.bond_short_name,p.maturity_date
       FROM fundamental.convertible_bond_profiles p
       JOIN core.instruments i ON i.instrument_id=p.instrument_id
       LEFT JOIN fundamental.convertible_bond_issuance iss ON iss.instrument_id=p.instrument_id
       JOIN core.instruments s ON s.instrument_id=p.stock_instrument_id
      WHERE i.status='listed' AND (iss.issue_type IS NULL OR iss.issue_type NOT IN ('定向','私募'))`
  );
  const byStockCode = new Map();
  const hintedIds = [...new Set((officialEvents || [])
    .map(item => Number(item && (item.instrument_id || item.instrumentId)))
    .filter(Number.isInteger))];
  const hintedRows = hintedIds.length
    ? await pool.query('SELECT instrument_id FROM core.instruments WHERE instrument_id=ANY($1::bigint[])', [hintedIds])
    : { rows: [] };
  const byInstrumentId = new Map([...instruments, ...hintedRows.rows].map(row => [String(row.instrument_id), row]));
  for (const row of instruments) {
    const key = String(row.stock_code).slice(0, 6);
    if (!byStockCode.has(key)) byStockCode.set(key, []);
    byStockCode.get(key).push(row);
  }
  const stockCodes = String(stock || '').split(',').map(value => value.trim()).filter(value => /^\d{6}$/.test(value));
  let announcements;
  if (cachedOnly) {
    const pending = await pool.query(
      `SELECT e.instrument_id AS "instrumentId",e.source_key AS "sourceKey",e.source_url AS "fileLink",e.title,
              e.announced_at AS "announcedAt",split_part(s.canonical_code,'.',1) AS "stockCode",
              e.event_type AS "eventType",e.raw_payload AS "rawPayload"
         FROM event.convertible_bond_call_events e
         LEFT JOIN fundamental.convertible_bond_profiles p ON p.instrument_id=e.instrument_id
         LEFT JOIN core.instruments s ON s.instrument_id=p.stock_instrument_id
        WHERE e.announced_at BETWEEN $1::date AND $2::date
          AND e.source_url <> ''
          AND (e.parser_version IS DISTINCT FROM $3 OR e.parse_status <> 'complete'
            OR (e.event_type <> 'waive' AND e.no_call_until IS NOT NULL)
            OR (e.event_type = 'waive' AND e.no_call_until IS NOT NULL AND e.decision_date IS NOT NULL
                AND e.no_call_until <= e.decision_date)
            OR (e.event_type IN ('waive','exercise') AND NOT (COALESCE(e.details,'{}'::jsonb)->'evidence' ? 'decision_date'))
            OR CASE WHEN e.raw_payload->>'announcementTime' ~ '^[0-9]+$'
                    THEN e.announced_at IS DISTINCT FROM to_timestamp((e.raw_payload->>'announcementTime')::double precision / 1000)::date
                    ELSE false END
            OR (e.source_url ~ '/20[0-9]{2}-[0-9]{2}-[0-9]{2}/'
                AND e.announced_at IS DISTINCT FROM substring(e.source_url from '/(20[0-9]{2}-[0-9]{2}-[0-9]{2})/')::date))
          AND ($5::boolean OR e.parse_status <> 'failed')
        ORDER BY e.announced_at,e.event_id LIMIT $4`, [start, end, PARSER_VERSION, Math.max(1, Number(limit) || 2000), retryFailed]
    );
    announcements = pending.rows.map(row => ({ ...row, sourceKey: row.sourceKey, fileLink: row.fileLink,
      announcedAt: announcementDate({ announcedAt: row.announcedAt, fileLink: row.fileLink, rawPayload: row.rawPayload }),
      stockCode: String(row.stockCode || '').slice(0, 6), rawPayload: row.rawPayload }));
  } else {
    const raw = Array.isArray(officialEvents) ? callItemsFromOfficialEvents(officialEvents) : await searchAnnouncements({
      fromDate: start, toDate: end, stock: stockCodes.length ? '' : stock,
      keywords: keywords && keywords.length ? keywords : [
        '强赎', '提前赎回', '不提前赎回', '暂不赎回', '不行使赎回', '不实施赎回', '赎回实施', '实施赎回',
        '赎回结果', '到期兑付', '即将到期', '停止交易', '最后交易日'
      ], exchanges
    });
    announcements = stockCodes.length ? raw.filter(item => stockCodes.includes(String(item.stockCode || '').slice(0, 6))) : raw;
  }
  const classified = announcements.map(item => ({ ...item, eventType: item.eventType || classifyCallEvent(item.title) }))
    .filter(item => item.eventType);
  const parsedDocuments = await parseOfficialDocuments(classified, classified.length, { cachedOnly });
  const stats = {
    discovered: announcements.length, call_candidates: classified.length, classified: classified.length,
    matched: 0, documents_ready: parsedDocuments.stats.documents_ready, parse_complete: 0,
    parse_partial: 0, unmatched: 0,
    download_failed: parsedDocuments.stats.download_failed, extract_failed: parsedDocuments.stats.extract_failed,
    pending_old_parser: 0, cache_miss: parsedDocuments.stats.cache_miss
  };
  const client = await pool.connect();
  let runId = null;
  try {
    await client.query('BEGIN');
    const run = await client.query(
      `INSERT INTO ops.ingestion_runs(source_id,dataset_code,request_range,status)
       VALUES($1,$2,$3::jsonb,'running') RETURNING run_id`,
      [sourceId, DATASET_CODE, JSON.stringify({ fromDate: start, toDate: end, exchanges, cachedOnly, parserVersion: PARSER_VERSION })]
    );
    runId = run.rows[0].run_id;
    for (const item of classified) {
      const eventType = item.eventType;
      const titleDates = eventDates(item.title, eventType);
      const parsed = parsedDocuments.byUrl.get(item.fileLink) || {};
      const announcedDate = announcementDate(item) || start;
      const dates = {
        ...titleDates,
        decisionDate: isoDate(parsed.decision_date) || announcedDate,
        lockStartDate: isoDate(parsed.lock_start_date),
        nextCountStartDate: isoDate(parsed.next_count_start_date),
        validityBasis: parsed.validity_basis || null,
        noCallUntil: eventType === 'waive' ? (isoDate(parsed.no_call_until) || titleDates.noCallUntil) : null,
        lastTradeDate: isoDate(parsed.last_trade_date) || titleDates.lastTradeDate,
        lastConversionDate: isoDate(parsed.last_conversion_date) || titleDates.lastConversionDate,
        redemptionRecordDate: isoDate(parsed.redemption_record_date) || titleDates.redemptionRecordDate,
        redemptionPrice: parsed.redemption_price != null ? parsed.redemption_price : null,
      };
      const candidates = byStockCode.get(String(item.stockCode || '').slice(0, 6)) || [];
      const hintedInstrumentId = Number(item.instrumentId || item.instrument_id || 0);
      const instrumentId = hintedInstrumentId && (cachedOnly || byInstrumentId.has(String(hintedInstrumentId)))
        ? hintedInstrumentId : pickInstrument(item, candidates);
      const rawPayload = item.rawPayload || item;
      const raw = JSON.stringify(rawPayload);
      const hash = crypto.createHash('sha256').update(raw).digest('hex');
      const rawResult = await client.query(
        `INSERT INTO ops.raw_records(run_id,source_id,dataset_code,source_key,payload,payload_hash)
         VALUES($1,$2,$3,$4,$5::jsonb,$6)
         ON CONFLICT(source_id,dataset_code,source_key,payload_hash) DO UPDATE SET payload=EXCLUDED.payload
         RETURNING raw_record_id`, [runId, sourceId, DATASET_CODE, item.sourceKey, raw, hash]
      );
      const rawRecordId = rawResult.rows[0] && rawResult.rows[0].raw_record_id;
      const documentId = await saveDocument(client, item, parsed, sourceId, rawRecordId);
      if (eventType === 'waive' && dates.validityBasis === 'through_maturity') {
        const profile = candidates.find(row => row.instrument_id === instrumentId);
        dates.noCallUntil = dates.noCallUntil || (profile && isoDate(profile.maturity_date));
      }
      const parserErrors = Array.isArray(parsed.errors) ? parsed.errors : [];
      const parseStatus = eventParseComplete(eventType, dates) && parsed.parse_status !== 'failed' && !parserErrors.length ? 'complete' : 'partial';
      if (parseStatus === 'complete') stats.parse_complete++;
      else stats.parse_partial++;
      const details = {
        exchange: item.exchange || null, parser: 'official-pdf', parser_version: PARSER_VERSION,
        validity_basis: dates.validityBasis, decision_date: dates.decisionDate,
        lock_start_date: dates.lockStartDate || (eventType === 'waive' ? dates.decisionDate : null),
        next_count_start_date: dates.nextCountStartDate || null,
        evidence: parsed.evidence || {}, errors: parserErrors,
        quality_reason: parserErrors.length ? parserErrors.join(',') : null,
      };
      if (!instrumentId) {
        stats.unmatched++;
        await recordCallQuality(client, item, null, 'unmatched_security', { title: item.title, stock_code: item.stockCode }, 'critical');
      } else {
        const existing = await client.query(
          `SELECT parser_version,parse_status,details,document_id,event_type,decision_date,no_call_until
             FROM event.convertible_bond_call_events WHERE source_id=$1 AND source_key=$2`, [sourceId, item.sourceKey]
        );
        const old = existing.rows[0];
        const parserUpgraded = parserVersionNumber(PARSER_VERSION) > parserVersionNumber(old && old.parser_version);
        const invalidExistingFact = old && old.parse_status === 'complete' && old.event_type === 'waive'
          && old.no_call_until && old.decision_date && old.no_call_until <= old.decision_date;
        const shouldWrite = !old || invalidExistingFact || (parserUpgraded && (parseQualityRank(parseStatus) >= parseQualityRank(old.parse_status)
          || parseQualityRank(old.parse_status) < parseQualityRank('complete')))
          || (!parserUpgraded && parserVersionNumber(PARSER_VERSION) === parserVersionNumber(old.parser_version)
            && parseQualityRank(parseStatus) >= parseQualityRank(old.parse_status));
        if (shouldWrite) {
          await client.query(
            `INSERT INTO event.convertible_bond_call_events
               (instrument_id,event_type,announced_at,decision_date,lock_start_date,no_call_until,validity_basis,
                last_trade_date,last_conversion_date,redemption_record_date,redemption_price,source_id,document_id,source_key,
                source_url,title,parse_status,parser_version,details,raw_payload)
             VALUES($1,$2,$3::date,$4::date,$5::date,$6::date,$7,$8::date,$9::date,$10::date,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20::jsonb)
             ON CONFLICT(source_id,source_key) DO UPDATE SET
               instrument_id=EXCLUDED.instrument_id,event_type=EXCLUDED.event_type,announced_at=EXCLUDED.announced_at,
               decision_date=EXCLUDED.decision_date,lock_start_date=EXCLUDED.lock_start_date,no_call_until=EXCLUDED.no_call_until,
               validity_basis=EXCLUDED.validity_basis,last_trade_date=EXCLUDED.last_trade_date,last_conversion_date=EXCLUDED.last_conversion_date,
               redemption_record_date=EXCLUDED.redemption_record_date,redemption_price=EXCLUDED.redemption_price,
               document_id=EXCLUDED.document_id,source_url=EXCLUDED.source_url,title=EXCLUDED.title,parse_status=EXCLUDED.parse_status,
               parser_version=EXCLUDED.parser_version,details=EXCLUDED.details,raw_payload=EXCLUDED.raw_payload,updated_at=now()`,
            [instrumentId, eventType, announcedDate, dates.decisionDate, dates.lockStartDate || (eventType === 'waive' ? dates.decisionDate : null),
              dates.noCallUntil, dates.validityBasis, dates.lastTradeDate, dates.lastConversionDate, dates.redemptionRecordDate,
              dates.redemptionPrice, sourceId, documentId, item.sourceKey, item.fileLink || '', item.title || '', parseStatus,
              PARSER_VERSION, JSON.stringify(details), raw]
          );
          stats.matched++;
          await resolveCallQuality(client, item, instrumentId, 'unmatched_security');
          if (parseStatus === 'complete') await resolveCallQuality(client, item, instrumentId, 'event_parse_partial');
          else await recordCallQuality(client, item, instrumentId, 'event_parse_partial', { errors: parserErrors, title: item.title }, 'warning');
        } else if (parserUpgraded && parsed.parse_status !== 'failed') {
          const oldDetails = old.details && typeof old.details === 'object' ? old.details : {};
          const parseHistory = Array.isArray(oldDetails.parse_history) ? oldDetails.parse_history : [];
          const preservedDetails = {
            ...oldDetails,
            parse_history: [...parseHistory, {
              parser_version: old.parser_version,
              parse_status: old.parse_status,
              preserved_at: new Date().toISOString(),
              reason: 'new_parser_lower_quality',
            }].slice(-10),
            reparse: {
              parser_version: PARSER_VERSION,
              parse_status: parseStatus,
              attempted_at: new Date().toISOString(),
              preserved_previous_fact: true,
            },
          };
          await client.query(
            `UPDATE event.convertible_bond_call_events
                SET parser_version=$1,parse_status=$2,document_id=COALESCE($3,document_id),details=$4::jsonb,updated_at=now()
              WHERE source_id=$5 AND source_key=$6`,
            [PARSER_VERSION, parseStatus, documentId, JSON.stringify(preservedDetails), sourceId, item.sourceKey]
          );
          stats.matched++;
          await resolveCallQuality(client, item, instrumentId, 'unmatched_security');
          await recordCallQuality(client, item, instrumentId, 'event_parse_partial', { errors: parserErrors, title: item.title }, 'warning');
        }
      }
      if (parsed.parse_status === 'failed' || parsed.errors && parsed.errors.includes('DOCUMENT_CACHE_MISS')) {
        await recordCallQuality(client, item, instrumentId, 'document_cache_miss', { url: item.fileLink, errors: parsed.errors || [] }, 'warning');
      } else if (parsed.parse_status === 'complete') {
        await resolveCallQuality(client, item, instrumentId, 'document_cache_miss');
      }
    }
    await client.query(`
      UPDATE event.convertible_bond_call_events e
         SET no_call_until=v.max_no_call_until,updated_at=now()
        FROM (
          SELECT instrument_id,announced_at,MAX(no_call_until) AS max_no_call_until
            FROM event.convertible_bond_call_events
           WHERE event_type='waive' AND no_call_until IS NOT NULL GROUP BY instrument_id,announced_at
        ) v
       WHERE e.instrument_id=v.instrument_id AND e.announced_at=v.announced_at
         AND e.event_type='waive' AND e.no_call_until IS DISTINCT FROM v.max_no_call_until`);
    const pendingOld = await client.query(
      `SELECT COUNT(*) FILTER (WHERE parser_version IS DISTINCT FROM $1)::int AS old_count,
              COUNT(*) FILTER (WHERE parser_version=$1 AND parse_status <> 'complete')::int AS partial_count
         FROM event.convertible_bond_call_events`, [PARSER_VERSION]
    );
    stats.pending_old_parser = pendingOld.rows[0].old_count;
    stats.parse_partial = Math.max(stats.parse_partial, pendingOld.rows[0].partial_count);
    await reconcileCallQuality(client);
    const openQuality = await client.query(
      `SELECT COUNT(*) FILTER (WHERE issue_type='unmatched_security')::int AS unmatched,
              COUNT(*) FILTER (WHERE issue_type='document_cache_miss')::int AS document_failures
         FROM ops.data_quality_issues
        WHERE dataset_code=$1 AND status='open'`, [DATASET_CODE]
    );
    stats.unmatched = Math.max(stats.unmatched, openQuality.rows[0].unmatched);
    if (openQuality.rows[0].document_failures) stats.extract_failed = Math.max(stats.extract_failed, openQuality.rows[0].document_failures);
    const qualityStatus = stats.download_failed || stats.extract_failed ? 'failed'
      : stats.parse_partial || stats.unmatched || stats.pending_old_parser ? 'stale' : 'passed';
    const projectionComplete = qualityStatus === 'passed';
    if (projectionComplete) {
      await client.query(
        `INSERT INTO ops.sync_cursors(scope_key,dataset_code,last_success_date,last_source_update,last_attempt_at,last_error,retry_count,updated_at)
         VALUES($1,$2,$3::date,now(),now(),' ',0,now())
         ON CONFLICT(scope_key,dataset_code) DO UPDATE SET last_success_date=EXCLUDED.last_success_date,
           last_source_update=now(),last_attempt_at=now(),last_error='',retry_count=0,updated_at=now()`, [PROJECTION_SCOPE, DATASET_CODE, end]
      );
    } else {
      await client.query(
        `INSERT INTO ops.sync_cursors(scope_key,dataset_code,last_success_date,last_source_update,last_attempt_at,last_error,retry_count,updated_at)
         VALUES($1,$2,NULL,now(),now(),$3,1,now())
         ON CONFLICT(scope_key,dataset_code) DO UPDATE SET last_attempt_at=now(),last_error=EXCLUDED.last_error,
           retry_count=ops.sync_cursors.retry_count+1,updated_at=now()`,
        [PROJECTION_SCOPE, DATASET_CODE, JSON.stringify({ qualityStatus, stats }).slice(0, 500)]
      );
    }
    await client.query(`UPDATE ops.ingestion_runs SET status='succeeded',row_count=$2,finished_at=now() WHERE run_id=$1`, [runId, stats.matched]);
    await client.query('COMMIT');
    return { ok: true, fromDate: start, toDate: end, runId, ...stats,
      diagnostics: { quality_status: qualityStatus, parser_version: PARSER_VERSION, projection_scope: PROJECTION_SCOPE,
        projection_advanced: projectionComplete, projection_last_success_date: projectionComplete ? end : null } };
  } catch (error) {
    await client.query('ROLLBACK');
    if (runId) await pool.query(`UPDATE ops.ingestion_runs SET status='failed',error_message=$2,finished_at=now() WHERE run_id=$1`, [runId, String(error.message || error).slice(0, 1000)]).catch(() => {});
    throw error;
  } finally { client.release(); }
}

module.exports = { PARSER_VERSION, PROJECTION_SCOPE, classifyCallEvent, eventDates, eventParseComplete, pickInstrument,
  callItemsFromOfficialEvents, parseOfficialDocuments, syncConvertibleBondCallAnnouncements };

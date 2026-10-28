const crypto = require('crypto');
const os = require('os');
const { pool } = require('../db/connection');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { childProcessEnv, mergeExternalCallStatsFromStderr } = require('./externalCallGuard');
const txControl = require('../repositories/transactionControl');
const { loadDocumentCache, reconcileCallQuality, recordCallQuality, resolveCallQuality } = require('../repositories/convertibleBondRedemptionSyncRepository.js');
const repository = require('../repositories/convertibleBondRedemptionSyncRepository.js');

const SOURCE_CODE = 'convertible_bond_redemption_announcements';
const DATASET_CODE = 'bond_redemption_events';
const PARSER_VERSION = 'call-event-v4';
// 行为等价的旧版本：解析逻辑未变、结果可直接沿用，不计入"待回放"。
// 放进这里的前提是「解析规则与判定逻辑确实没改」，否则历史事实会沿用错误口径。
// 依据：0.8.4.42 只把 PARSER_VERSION 从 call-event-v3 改成 call-event-v4，
// Python 解析器、判定规则、字段口径全部未改动（该次提交对解析链路无其他改动）。
// 真正改了判定的升级不得登记为兼容，必须走 replayRequired 回放（入口见 /api/admin/jobs/convertible-bond-reparse）。
const PARSER_COMPATIBLE_VERSIONS = ['call-event-v3'];
const PROJECTION_SCOPE = 'convertible_bond_call_projection:call-event-v4';

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
  // “使用可转债闲置募集资金进行现金管理到期赎回”等理财公告，赎回对象是理财产品而非可转债。
  if (/(现金管理|理财产品|结构性存款|闲置(?:自有|募集)?资金|委托理财)/.test(text)) return null;
  // 转股价格向下修正属于下修监控，不得因“预计触发/转债”字样进入强赎投影。
  if (/(?:转股价格|转股价).*(?:下修|向下修正)|(?:下修|向下修正).*(?:转股价格|转股价)/.test(text)
      && !/(赎回|强赎|提前赎回)/.test(text)) return null;
  if (/不提前赎回|不行使.*赎回|不实施.*赎回|暂不赎回|(?:无法|不能)实施.*赎回/.test(text)) return 'waive';
  if (/实施结果|赎回结果|兑付结果|完成赎回|赎回完成/.test(text)) return 'completion';
  if (/赎回实施|实施.*赎回|到期兑付|到期偿付|兑付暨摘牌|到期赎回|停止交易|最后交易日|最后转股日|赎回公告/.test(text)) return 'implementation';
  if (/可能触发|预计触发|触发条件|强赎提示/.test(text)) return 'warning';
  if (/强赎|提前赎回|触发.*赎回|可能触发/.test(text)) return 'exercise';
  return null;
}

// 到期兑付 / 提前强赎 / 仅凭标题无法区分（未确认）三类语义，写入 details.call_kind，
// 供状态视图与页面提示区分“正常到期”和“已公告强赎”（2026-10-21 审查 P-6）。
function classifyCallKind(title, eventType) {
  if (!eventType || eventType === 'waive' || eventType === 'warning') return null;
  const text = String(title || '');
  const early = /(强赎|提前赎回|赎回实施|赎回暨摘牌|实施.{0,8}赎回|赎回结果|完成赎回|赎回完成)/.test(text);
  const maturity = /(到期兑付|到期偿付|兑付暨摘牌|到期赎回|即将到期|到期暨|到期及)/.test(text);
  if (maturity && !early) return 'maturity';
  if (early) return 'early';
  return 'unconfirmed';
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

/* loadDocumentCache 已迁入 server/repositories/convertibleBondRedemptionSyncRepository.js */

async function parseOfficialDocuments(items, maxUrls = null, { cachedOnly = false } = {}) {
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
  if (eventType === 'completion') return Boolean(value.decisionDate);
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
  const { rows } = await repository.insert_event_documents([item.title || '', isoDate(item.announcedAt), item.fileLink, sourceId,
      parsed.content_hash || '', rawRecordId || null, JSON.stringify(payload)], client);
  return rows[0] && rows[0].document_id;
}

/* recordCallQuality 已迁入 server/repositories/convertibleBondRedemptionSyncRepository.js */

/* resolveCallQuality 已迁入 server/repositories/convertibleBondRedemptionSyncRepository.js */

/* reconcileCallQuality 已迁入 server/repositories/convertibleBondRedemptionSyncRepository.js */

async function syncConvertibleBondCallAnnouncements({ fromDate, toDate, exchanges = ['sse', 'szse'], stock = '', keywords = null,
  officialEvents = null, cachedOnly = false, retryFailed = false, limit = null } = {}) {
  const end = isoDate(toDate) || new Date().toISOString().slice(0, 10);
  const start = isoDate(fromDate) || new Date(Date.now() - 31 * 86400000).toISOString().slice(0, 10);
  const sourceRows = await repository.select_ops_data_sources([SOURCE_CODE]);
  if (!sourceRows.rows[0]) throw new Error('强赎公告数据源尚未完成数据库迁移');
  const sourceId = sourceRows.rows[0].source_id;
  const configuredLimit = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : null;
  const { rows: instruments } = await repository.select_fundamental_convertible_bond_profiles();
  const byStockCode = new Map();
  const hintedIds = [...new Set((officialEvents || [])
    .map(item => Number(item && (item.instrument_id || item.instrumentId)))
    .filter(Number.isInteger))];
  const hintedRows = hintedIds.length
    ? await repository.select_core_instruments([hintedIds])
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
    const limitClause = configuredLimit ? ' LIMIT $4' : '';
    const retryPlaceholder = configuredLimit ? '$5' : '$4';
    const queryParams = configuredLimit
      ? [start, end, PARSER_VERSION, configuredLimit, retryFailed]
      : [start, end, PARSER_VERSION, retryFailed];
    const pending = await repository.listPendingCallEvents({ configuredLimit, queryParams });
    announcements = pending.rows.map(row => ({ ...row, sourceKey: row.sourceKey, fileLink: row.fileLink,
      announcedAt: announcementDate({ announcedAt: row.announcedAt, fileLink: row.fileLink, rawPayload: row.rawPayload }),
      stockCode: String(row.stockCode || '').slice(0, 6), rawPayload: row.rawPayload }));
  } else {
    if (!Array.isArray(officialEvents)) {
      throw new Error('强赎公告必须由统一交易所公告批次提供，禁止直接访问巨潮资讯');
    }
    const raw = callItemsFromOfficialEvents(officialEvents);
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
    await txControl.begin(client);
    const run = await repository.insert_ops_ingestion_runs([sourceId, DATASET_CODE, JSON.stringify({ fromDate: start, toDate: end, exchanges, cachedOnly, parserVersion: PARSER_VERSION })], client);
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
      const rawResult = await repository.insert_ops_raw_records([runId, sourceId, DATASET_CODE, item.sourceKey, raw, hash], client);
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
        call_kind: classifyCallKind(item.title, eventType),
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
        const existing = await repository.select_event_convertible_bond_call_events([sourceId, item.sourceKey], client);
        const old = existing.rows[0];
        const parserUpgraded = parserVersionNumber(PARSER_VERSION) > parserVersionNumber(old && old.parser_version);
        const invalidExistingFact = old && old.parse_status === 'complete' && old.event_type === 'waive'
          && old.no_call_until && old.decision_date && old.no_call_until <= old.decision_date;
        const shouldWrite = !old || invalidExistingFact || (parserUpgraded && (parseQualityRank(parseStatus) >= parseQualityRank(old.parse_status)
          || parseQualityRank(old.parse_status) < parseQualityRank('complete')))
          || (!parserUpgraded && parserVersionNumber(PARSER_VERSION) === parserVersionNumber(old.parser_version)
            && parseQualityRank(parseStatus) >= parseQualityRank(old.parse_status));
        if (shouldWrite) {
          await repository.insert_event_convertible_bond_call_events([instrumentId, eventType, announcedDate, dates.decisionDate, dates.lockStartDate || (eventType === 'waive' ? dates.decisionDate : null),
              dates.noCallUntil, dates.validityBasis, dates.lastTradeDate, dates.lastConversionDate, dates.redemptionRecordDate,
              dates.redemptionPrice, sourceId, documentId, item.sourceKey, item.fileLink || '', item.title || '', parseStatus,
              PARSER_VERSION, JSON.stringify(details), raw], client);
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
          await repository.update_event_convertible_bond_call_events([PARSER_VERSION, parseStatus, documentId, JSON.stringify(preservedDetails), sourceId, item.sourceKey], client);
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
    await repository.update_event_convertible_bond_call_events_1(client);
    const pendingOld = await repository.select_event_convertible_bond_call_events_1([PARSER_VERSION, PARSER_COMPATIBLE_VERSIONS], client);
    // pending_old_parser 只统计"必须回放"的旧版本；行为等价的兼容版本单独计数，不阻断当日任务。
    // 这样一次空版本号变更不会再让全库历史变成假缺口，而真正改了判定规则的升级仍然会被拦下。
    stats.pending_old_parser = pendingOld.rows[0].old_count;
    stats.compatible_parser_events = pendingOld.rows[0].compatible_count;
    stats.parse_partial = Math.max(stats.parse_partial, pendingOld.rows[0].partial_count);
    await reconcileCallQuality(client);
    const openQuality = await repository.select_ops_data_quality_issues([DATASET_CODE], client);
    stats.unmatched = Math.max(stats.unmatched, openQuality.rows[0].unmatched);
    if (openQuality.rows[0].document_failures) stats.extract_failed = Math.max(stats.extract_failed, openQuality.rows[0].document_failures);
    const limited = configuredLimit !== null;
    stats.limited = limited;
    const qualityStatus = stats.download_failed || stats.extract_failed ? 'failed'
      : limited ? 'stale'
      : stats.parse_partial || stats.unmatched || stats.pending_old_parser ? 'stale' : 'passed';
    const projectionComplete = qualityStatus === 'passed';
    if (projectionComplete) {
      await repository.insert_ops_sync_cursors([PROJECTION_SCOPE, DATASET_CODE, end], client);
    } else {
      await repository.insert_ops_sync_cursors_1([PROJECTION_SCOPE, DATASET_CODE, JSON.stringify({ qualityStatus, stats }).slice(0, 500)], client);
    }
    const runStatus = projectionComplete ? 'succeeded' : qualityStatus === 'stale' ? 'degraded' : 'failed';
    await repository.update_ops_ingestion_runs([runId, runStatus, stats.matched], client);
    await txControl.commit(client);
    return { ok: projectionComplete, status: runStatus, fromDate: start, toDate: end, runId, ...stats,
      diagnostics: { quality_status: qualityStatus, parser_version: PARSER_VERSION, projection_scope: PROJECTION_SCOPE,
        parser_compatible_versions: PARSER_COMPATIBLE_VERSIONS,
        replay_pending: Number(stats.pending_old_parser || 0),
        compatible_parser_events: Number(stats.compatible_parser_events || 0),
        projection_advanced: projectionComplete, projection_last_success_date: projectionComplete ? end : null } };
  } catch (error) {
    await txControl.rollback(client);
    if (runId) await repository.update_ops_ingestion_runs_1([runId, String(error.message || error).slice(0, 1000)]).catch(() => {});
    throw error;
  } finally { client.release(); }
}

module.exports = { PARSER_VERSION, PARSER_COMPATIBLE_VERSIONS, PROJECTION_SCOPE, classifyCallEvent, classifyCallKind, eventDates, eventParseComplete, pickInstrument,
  callItemsFromOfficialEvents, parseOfficialDocuments, syncConvertibleBondCallAnnouncements };

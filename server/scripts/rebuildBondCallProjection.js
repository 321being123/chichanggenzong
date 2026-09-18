require('dotenv').config();

const fs = require('fs');
const { pool } = require('../db/connection');
const { tushareQuery, tsRows } = require('../services/market');
const { publishDatasetSnapshot } = require('../services/datasetPartitionRegistry');
const { retryJobSlot } = require('../services/jobScheduleSlots');
const { collectConvertibleBondAnnouncementMarket } = require('../services/convertibleBondAnalysis');
const {
  PARSER_VERSION,
  PROJECTION_SCOPE,
  classifyCallEvent,
  pickInstrument,
  syncConvertibleBondCallAnnouncements,
} = require('../services/convertibleBondRedemptionSync');

const DATASET_CODE = 'bond_redemption_events';
const SOURCE_CODE = 'convertible_bond_redemption_announcements';
const HISTORICAL_IDENTITY_FIELDS = [
  'ts_code', 'bond_short_name', 'stk_code', 'list_date', 'delist_date', 'maturity_date',
  'conv_end_date', 'conv_stop_date',
].join(',');

function arg(name, fallback = '') {
  const prefix = `--${name}=`;
  const item = process.argv.slice(2).find(value => value.startsWith(prefix));
  return item ? item.slice(prefix.length) : fallback;
}

function isoDate(value) {
  const text = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function shiftDate(value, days) {
  const date = new Date(`${value}T12:00:00+08:00`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function eventKey(item) {
  return item.source_number || item.url || `${item.event_date || ''}:${item.stock_code || ''}:${item.title || ''}`;
}

function hasExplicitConvertibleEvidence(item) {
  return /(?:可转债|可转换公司债券|转债|转股|债券代码)/.test(String(item && item.title || ''));
}

function normalizedText(value) {
  return String(value || '').normalize('NFKC').replace(/[“”‘’「」『』\s]/g, '');
}

function compactDate(value) {
  const text = String(value || '').replace(/\D/g, '');
  return /^20\d{6}$/.test(text) ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6)}` : isoDate(value);
}

function addCalendarDays(value, days) {
  const date = compactDate(value);
  if (!date) return null;
  const parsed = new Date(`${date}T12:00:00+08:00`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function identityActiveForAnnouncement(row, eventDate) {
  const announced = compactDate(eventDate);
  const listed = compactDate(row.list_date);
  const delistedGraceEnd = addCalendarDays(row.delist_date, 45);
  return Boolean(announced && (!listed || listed <= announced) && (!delistedGraceEnd || announced <= delistedGraceEnd));
}

function pickAuthoritativeIdentity(event, candidates) {
  const title = normalizedText(event && event.title);
  const rows = Array.isArray(candidates) ? candidates : [];
  const codeMatches = rows.filter(row => {
    const code = String(row.ts_code || '').split('.')[0];
    return code && title.includes(code);
  });
  if (codeMatches.length === 1) return codeMatches[0];
  const nameMatches = rows.filter(row => {
    const name = normalizedText(row.bond_short_name);
    return name && title.includes(name);
  });
  const activeNameMatches = nameMatches.filter(row => identityActiveForAnnouncement(row, event && event.event_date));
  if (activeNameMatches.length === 1) return activeNameMatches[0];
  if (nameMatches.length === 1) return nameMatches[0];
  return null;
}

async function instrumentHints(events) {
  const sourceKeys = [...new Set(events.map(eventKey).filter(Boolean))];
  const existing = sourceKeys.length ? await pool.query(
    `SELECT e.source_key,e.instrument_id
       FROM event.convertible_bond_call_events e
       JOIN ops.data_sources s ON s.source_id=e.source_id
      WHERE s.source_code=$1 AND e.source_key=ANY($2::text[])`,
    [SOURCE_CODE, sourceKeys]
  ) : { rows: [] };
  const existingByKey = new Map(existing.rows.map(row => [row.source_key, row.instrument_id]));
  const { rows } = await pool.query(`
    SELECT p.instrument_id,split_part(s.canonical_code,'.',1) AS stock_code,
           split_part(i.canonical_code,'.',1) AS security_code,
           i.name AS bond_name,p.bond_short_name,p.maturity_date
      FROM fundamental.convertible_bond_profiles p
      JOIN core.instruments i ON i.instrument_id=p.instrument_id
      JOIN core.instruments s ON s.instrument_id=p.stock_instrument_id`);
  const byStock = new Map();
  for (const row of rows) {
    if (!byStock.has(row.stock_code)) byStock.set(row.stock_code, []);
    byStock.get(row.stock_code).push(row);
  }
  return events.map(event => {
    const existingInstrumentId = existingByKey.get(eventKey(event));
    if (existingInstrumentId) return { ...event, instrument_id: existingInstrumentId };
    const stockCode = String(event.stock_code || '').slice(0, 6);
    const candidates = byStock.get(stockCode) || [];
    const instrumentId = pickInstrument({ title: event.title || '' }, candidates);
    return instrumentId ? { ...event, instrument_id: instrumentId } : event;
  });
}

async function historicalIdentityHints(events) {
  if (!events.length) return { events: [], repairs: [] };
  const authoritative = tsRows(await tushareQuery('cb_basic', {}, HISTORICAL_IDENTITY_FIELDS));
  if (!authoritative.length) throw new Error('Tushare cb_basic 历史证券身份快照为空');
  const { rows: identities } = await pool.query(`
    SELECT i.instrument_id,i.canonical_code,x.identifier_value AS tushare_code
      FROM core.instruments i
      LEFT JOIN ops.data_sources s ON s.source_code='tushare'
      LEFT JOIN core.instrument_identifiers x ON x.instrument_id=i.instrument_id
        AND x.source_id=s.source_id AND x.identifier_type='ts_code'
     WHERE i.asset_class='convertible_bond'`);
  const byCode = new Map();
  for (const row of identities) {
    byCode.set(String(row.canonical_code || '').toUpperCase(), row);
    if (row.tushare_code) byCode.set(String(row.tushare_code).toUpperCase(), row);
  }
  const byStock = new Map();
  for (const row of authoritative) {
    const stockCode = String(row.stk_code || '').slice(0, 6);
    if (!stockCode) continue;
    if (!byStock.has(stockCode)) byStock.set(stockCode, []);
    byStock.get(stockCode).push(row);
  }
  const repairs = new Map();
  const hinted = events.map(event => {
    const stockCode = String(event.stock_code || '').slice(0, 6);
    const authoritativeRow = pickAuthoritativeIdentity(event, byStock.get(stockCode) || []);
    const identity = authoritativeRow && byCode.get(String(authoritativeRow.ts_code || '').toUpperCase());
    if (!identity) return event;
    const repair = { ...authoritativeRow, instrument_id: identity.instrument_id, canonical_code: identity.canonical_code };
    const existing = repairs.get(String(identity.instrument_id));
    if (existing && String(existing.ts_code) !== String(repair.ts_code)) {
      throw new Error(`历史证券身份冲突：instrument_id=${identity.instrument_id}`);
    }
    repairs.set(String(identity.instrument_id), repair);
    return { ...event, instrument_id: identity.instrument_id };
  });
  return { events: hinted, repairs: [...repairs.values()] };
}

async function applyHistoricalIdentityRepairs(client, repairs, asOfDate) {
  if (!repairs.length) return 0;
  const source = await client.query("SELECT source_id FROM ops.data_sources WHERE source_code='tushare'");
  if (!source.rows[0]) throw new Error('生产库缺少 Tushare 数据源');
  for (const row of repairs) {
    const listDate = compactDate(row.list_date);
    const delistDate = compactDate(row.delist_date);
    const status = delistDate && delistDate <= asOfDate ? 'delisted' : 'listed';
    await client.query(
      `UPDATE core.instruments
          SET name=$2,list_date=COALESCE($3::date,list_date),delist_date=COALESCE($4::date,delist_date),
              status=$5,updated_at=now()
        WHERE instrument_id=$1 AND asset_class='convertible_bond'`,
      [row.instrument_id, row.bond_short_name, listDate, delistDate, status]
    );
    await client.query(
      `UPDATE fundamental.convertible_bond_profiles
          SET bond_short_name=$2,list_date=COALESCE($3::date,list_date),maturity_date=COALESCE($4::date,maturity_date),
              conv_end_date=COALESCE($5::date,conv_end_date),conv_stop_date=COALESCE($6::date,conv_stop_date),
              raw_payload=COALESCE(raw_payload,'{}'::jsonb) || jsonb_build_object('cb_basic_identity',$7::jsonb),updated_at=now()
        WHERE instrument_id=$1`,
      [row.instrument_id, row.bond_short_name, listDate, compactDate(row.maturity_date),
        compactDate(row.conv_end_date), compactDate(row.conv_stop_date), JSON.stringify(row)]
    );
    await client.query(
      `INSERT INTO core.instrument_identifiers(instrument_id,source_id,identifier_type,identifier_value,valid_from)
       VALUES($1,$2,'ts_code',$3,COALESCE($4::date,'0001-01-01'::date))
       ON CONFLICT(source_id,identifier_type,identifier_value,valid_from) DO NOTHING`,
      [row.instrument_id, source.rows[0].source_id, row.ts_code, listDate]
    );
  }
  return repairs.length;
}

async function collectOfficialWindow(fromDate, toDate) {
  if (!fromDate || !toDate || fromDate > toDate) return [];
  const results = await Promise.all(['SH', 'SZ'].map(market =>
    collectConvertibleBondAnnouncementMarket(market, fromDate, toDate, { allowFallback: false, guardRetryAttempts: 6 })
      .then(result => ({ market, ...result }))
  ));
  const failures = results.filter(result => result.failed);
  if (failures.length) {
    throw new Error(`交易所历史公告未完整：${failures.map(item => `${item.market}:${item.messages.join('|')}`).join('; ')}`);
  }
  return results.flatMap(result => result.events || []);
}

async function importBaseline(client, rows, sourceId) {
  for (const row of rows) {
    const instrument = await client.query('SELECT instrument_id FROM core.instruments WHERE canonical_code=$1', [row.canonical_code]);
    if (!instrument.rows[0]) throw new Error(`生产库缺少证券主档 ${row.canonical_code}`);
    const document = await client.query(
      `INSERT INTO event.documents
         (company_id,document_type,title,announced_at,url,source_id,content_hash,raw_record_id,raw_payload)
       VALUES(NULL,$1,$2,$3::date,$4,$5,$6,NULL,$7::jsonb)
       ON CONFLICT(source_id,url,content_hash) DO UPDATE SET
         title=EXCLUDED.title,announced_at=EXCLUDED.announced_at,raw_payload=EXCLUDED.raw_payload
       RETURNING document_id`,
      [row.document_type, row.document_title, row.document_announced_at, row.document_url,
        sourceId, row.content_hash, JSON.stringify(row.document_raw_payload)]
    );
    await client.query(
      `INSERT INTO event.convertible_bond_call_events
         (instrument_id,event_type,announced_at,decision_date,lock_start_date,no_call_until,validity_basis,
          last_trade_date,last_conversion_date,redemption_record_date,redemption_price,source_id,document_id,
          source_key,source_url,title,parse_status,parser_version,details,raw_payload)
       VALUES($1,$2,$3::date,$4::date,$5::date,$6::date,$7,$8::date,$9::date,$10::date,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20::jsonb)
       ON CONFLICT(source_id,source_key) DO UPDATE SET
         instrument_id=EXCLUDED.instrument_id,event_type=EXCLUDED.event_type,announced_at=EXCLUDED.announced_at,
         decision_date=EXCLUDED.decision_date,lock_start_date=EXCLUDED.lock_start_date,no_call_until=EXCLUDED.no_call_until,
         validity_basis=EXCLUDED.validity_basis,last_trade_date=EXCLUDED.last_trade_date,
         last_conversion_date=EXCLUDED.last_conversion_date,redemption_record_date=EXCLUDED.redemption_record_date,
         redemption_price=EXCLUDED.redemption_price,document_id=EXCLUDED.document_id,source_url=EXCLUDED.source_url,
         title=EXCLUDED.title,parse_status=EXCLUDED.parse_status,parser_version=EXCLUDED.parser_version,
         details=EXCLUDED.details,raw_payload=EXCLUDED.raw_payload,updated_at=now()`,
      [instrument.rows[0].instrument_id, row.event_type, row.announced_at, row.decision_date,
        row.lock_start_date, row.no_call_until, row.validity_basis, row.last_trade_date,
        row.last_conversion_date, row.redemption_record_date, row.redemption_price, sourceId,
        document.rows[0].document_id, row.source_key, row.source_url, row.title, row.parse_status,
        row.parser_version, JSON.stringify(row.details || {}), JSON.stringify(row.raw_payload || {})]
    );
  }
}

async function rebuild() {
  if (!process.argv.includes('--apply') || !process.argv.includes('--confirm-production')) {
    throw new Error('拒绝执行：必须同时传入 --apply --confirm-production');
  }
  const baselinePath = arg('baseline-json');
  const historyStart = isoDate(arg('history-start'));
  const toDate = isoDate(arg('to-date'));
  if (!baselinePath || !historyStart || !toDate) throw new Error('缺少 baseline-json、history-start 或 to-date');
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  if (baseline.schemaVersion !== 1 || !Array.isArray(baseline.events) || baseline.events.length < 200) {
    throw new Error('本地验证基线无效或数量异常');
  }
  if (baseline.events.some(row => row.parser_version !== PARSER_VERSION || row.parse_status !== 'complete'
    || !row.document_raw_payload || row.document_raw_payload.extraction?.status !== 'complete'
    || !row.document_raw_payload.extracted_text)) {
    throw new Error('本地验证基线包含未完成解析或缺少正文的记录');
  }
  const baselineFrom = isoDate(baseline.baselineFrom);
  const baselineTo = isoDate(baseline.baselineTo);
  if (!baselineFrom || !baselineTo || historyStart > toDate || historyStart > baselineFrom || baselineTo > toDate
    || Number(baseline.count) !== baseline.events.length) {
    throw new Error('本地验证基线日期范围异常');
  }

  const officialRaw = [
    ...await collectOfficialWindow(historyStart, shiftDate(baselineFrom, -1)),
    ...await collectOfficialWindow(shiftDate(baselineTo, 1), toDate),
  ];
  const official = [...new Map(officialRaw.map(item => [eventKey(item), item])).values()];
  let hintedCandidates = await instrumentHints(official.filter(item => classifyCallEvent(item.title)));
  let unmatchedHints = hintedCandidates.filter(item => !item.instrument_id);
  let requiredUnmatched = unmatchedHints.filter(hasExplicitConvertibleEvidence);
  let identityRepairs = [];
  if (requiredUnmatched.length) {
    const governed = await historicalIdentityHints(requiredUnmatched);
    const governedByKey = new Map(governed.events.map(item => [eventKey(item), item]));
    hintedCandidates = hintedCandidates.map(item => governedByKey.get(eventKey(item)) || item);
    identityRepairs = governed.repairs;
    unmatchedHints = hintedCandidates.filter(item => !item.instrument_id);
    requiredUnmatched = unmatchedHints.filter(hasExplicitConvertibleEvidence);
  }
  if (requiredUnmatched.length) {
    const samples = requiredUnmatched.slice(0, 8).map(item => `${item.stock_code || '-'}:${item.title || '-'}`);
    throw new Error(`交易所可转债公告存在 ${requiredUnmatched.length} 条证券无法唯一匹配，已停止重建：${samples.join('；')}`);
  }
  const callCandidates = hintedCandidates.filter(item => item.instrument_id);
  const ignoredNonConvertibleCount = unmatchedHints.length - requiredUnmatched.length;
  if (callCandidates.length) {
    await syncConvertibleBondCallAnnouncements({
      fromDate: historyStart,
      toDate,
      officialEvents: callCandidates,
    });
  }

  const source = await pool.query('SELECT source_id FROM ops.data_sources WHERE source_code=$1', [SOURCE_CODE]);
  if (!source.rows[0]) throw new Error('生产库缺少强赎公告数据源');
  const sourceId = source.rows[0].source_id;
  const officialKeys = callCandidates.map(eventKey);
  if (officialKeys.length) {
    const verified = await pool.query(
      `SELECT e.source_key,e.parser_version,e.parse_status,d.raw_payload->'extraction'->>'status' AS extraction_status
         FROM event.convertible_bond_call_events e
         LEFT JOIN event.documents d ON d.document_id=e.document_id
        WHERE e.source_id=$1 AND e.source_key=ANY($2::text[])`,
      [sourceId, officialKeys]
    );
    const byKey = new Map(verified.rows.map(row => [row.source_key, row]));
    const incomplete = officialKeys.filter(key => {
      const row = byKey.get(key);
      return !row || row.parser_version !== PARSER_VERSION || row.parse_status !== 'complete' || row.extraction_status !== 'complete';
    });
    if (incomplete.length) throw new Error(`交易所公告仍有 ${incomplete.length} 条未完整解析，已停止清理历史记录`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const historicalIdentityRepairCount = await applyHistoricalIdentityRepairs(client, identityRepairs, toDate);
    await importBaseline(client, baseline.events, sourceId);
    const targetKeys = [...new Set([...baseline.events.map(row => row.source_key), ...officialKeys])];
    const removed = await client.query(
      `DELETE FROM event.convertible_bond_call_events
        WHERE source_id=$1 AND announced_at BETWEEN $2::date AND $3::date
          AND NOT (source_key=ANY($4::text[]))`,
      [sourceId, historyStart, toDate, targetKeys]
    );
    const quality = await client.query(
      `SELECT COUNT(*) FILTER (WHERE e.parser_version<>$1 OR e.parse_status<>'complete')::int AS incomplete,
              COUNT(*) FILTER (WHERE d.document_id IS NULL OR d.raw_payload->'extraction'->>'status' IS DISTINCT FROM 'complete')::int AS document_incomplete,
              COUNT(*)::int AS total
         FROM event.convertible_bond_call_events e
         LEFT JOIN event.documents d ON d.document_id=e.document_id
        WHERE e.source_id=$2 AND e.announced_at BETWEEN $3::date AND $4::date`,
      [PARSER_VERSION, sourceId, historyStart, toDate]
    );
    const evidence = quality.rows[0];
    if (Number(evidence.incomplete) || Number(evidence.document_incomplete)
      || Number(evidence.total) !== targetKeys.length) {
      throw new Error(`重建后质量校验失败：${JSON.stringify(evidence)}，目标 ${targetKeys.length}`);
    }
    await client.query(
      `UPDATE ops.data_quality_issues
          SET status='resolved',resolved_at=now(),
              details=details || jsonb_build_object('resolved_by','verified_projection_rebuild','resolved_at',now())
        WHERE dataset_code=$1 AND status='open'`,
      [DATASET_CODE]
    );
    await client.query(
      `INSERT INTO ops.sync_cursors
         (scope_key,dataset_code,last_success_date,last_source_update,last_attempt_at,last_error,retry_count,updated_at)
       VALUES($1,$2,$3::date,now(),now(),'',0,now())
       ON CONFLICT(scope_key,dataset_code) DO UPDATE SET
         last_success_date=EXCLUDED.last_success_date,last_source_update=now(),last_attempt_at=now(),
         last_error='',retry_count=0,updated_at=now()`,
      [PROJECTION_SCOPE, DATASET_CODE, toDate]
    );
    const publication = await publishDatasetSnapshot(DATASET_CODE, {
      partitionKey: toDate,
      dataAsOf: toDate,
      rowCount: Number(evidence.total),
      diagnostics: {
        quality_status: 'passed',
        parser_version: PARSER_VERSION,
        projection_scope: PROJECTION_SCOPE,
        projection_advanced: true,
        baseline_count: baseline.events.length,
        official_count: officialKeys.length,
        historical_identity_repair_count: historicalIdentityRepairCount,
        ignored_non_convertible_count: ignoredNonConvertibleCount,
        removed_superseded_count: removed.rowCount,
      },
      reason: 'verified_projection_rebuild',
    }, client.query.bind(client));
    if (!publication.published) throw new Error('强赎事件分区发布失败');
    await client.query('COMMIT');
    const failedSlots = await pool.query(
      `SELECT slot_id FROM ops.job_schedule_slots
        WHERE job_code='convertible_bond_announcement_history_sync'
          AND business_date=$1::date
          AND status IN ('failed','degraded','blocked','skipped','waiting_external')
        ORDER BY scheduled_for`,
      [toDate]
    );
    const retriedSlotIds = [];
    for (const row of failedSlots.rows) {
      if (await retryJobSlot(row.slot_id)) retriedSlotIds.push(Number(row.slot_id));
    }
    return {
      ok: true,
      historyStart,
      toDate,
      baselineCount: baseline.events.length,
      officialCount: officialKeys.length,
      historicalIdentityRepairCount,
      ignoredNonConvertibleCount,
      targetCount: targetKeys.length,
      removedSupersededCount: removed.rowCount,
      retriedSlotIds,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  rebuild()
    .then(result => console.log(`REBUILD_RESULT ${JSON.stringify(result)}`))
    .catch(error => { console.error(`REBUILD_FAILED ${error.stack || error}`); process.exitCode = 1; })
    .finally(() => pool.end().catch(() => {}));
}

module.exports = { compactDate, identityActiveForAnnouncement, pickAuthoritativeIdentity };

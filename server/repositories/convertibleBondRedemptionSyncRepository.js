const { pool } = require('../db/connection');

// 自 server/services/convertibleBondRedemptionSync.js 迁入的数据读写函数（只做标准事实读写，业务判定仍留在服务层）。

const DATASET_CODE = 'bond_redemption_events';

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

async function insert_event_documents(params, client = pool) {
  return client.query(`INSERT INTO event.documents(company_id,document_type,title,announced_at,url,source_id,content_hash,raw_record_id,raw_payload)
     VALUES(NULL,'convertible_bond_call_announcement',$1,$2::date,$3,$4,$5,$6,$7::jsonb)
     ON CONFLICT(source_id,url,content_hash) DO UPDATE SET title=EXCLUDED.title,announced_at=EXCLUDED.announced_at,
       raw_record_id=COALESCE(EXCLUDED.raw_record_id,event.documents.raw_record_id),raw_payload=EXCLUDED.raw_payload
     RETURNING document_id`, params);
}

async function select_ops_data_sources(params, client = pool) {
  return client.query(`SELECT source_id FROM ops.data_sources WHERE source_code=$1`, params);
}

async function select_fundamental_convertible_bond_profiles(params, client = pool) {
  return client.query(`SELECT p.instrument_id,split_part(s.canonical_code,'.',1) AS stock_code,
            split_part(i.canonical_code,'.',1) AS security_code,i.name AS bond_name,p.bond_short_name,p.maturity_date
       FROM fundamental.convertible_bond_profiles p
       JOIN core.instruments i ON i.instrument_id=p.instrument_id
       LEFT JOIN fundamental.convertible_bond_issuance iss ON iss.instrument_id=p.instrument_id
       JOIN core.instruments s ON s.instrument_id=p.stock_instrument_id
      WHERE i.status='listed' AND (iss.issue_type IS NULL OR iss.issue_type NOT IN ('定向','私募'))`);
}

async function select_core_instruments(params, client = pool) {
  return client.query(`SELECT instrument_id FROM core.instruments WHERE instrument_id=ANY($1::bigint[])`, params);
}

async function insert_ops_ingestion_runs(params, client = pool) {
  return client.query(`INSERT INTO ops.ingestion_runs(source_id,dataset_code,request_range,status)
       VALUES($1,$2,$3::jsonb,'running') RETURNING run_id`, params);
}

async function insert_ops_raw_records(params, client = pool) {
  return client.query(`INSERT INTO ops.raw_records(run_id,source_id,dataset_code,source_key,payload,payload_hash)
         VALUES($1,$2,$3,$4,$5::jsonb,$6)
         ON CONFLICT(source_id,dataset_code,source_key,payload_hash) DO UPDATE SET payload=EXCLUDED.payload
         RETURNING raw_record_id`, params);
}

async function select_event_convertible_bond_call_events(params, client = pool) {
  return client.query(`SELECT parser_version,parse_status,details,document_id,event_type,decision_date,no_call_until
             FROM event.convertible_bond_call_events WHERE source_id=$1 AND source_key=$2`, params);
}

async function insert_event_convertible_bond_call_events(params, client = pool) {
  return client.query(`INSERT INTO event.convertible_bond_call_events
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
               parser_version=EXCLUDED.parser_version,details=EXCLUDED.details,raw_payload=EXCLUDED.raw_payload,updated_at=now()`, params);
}

async function update_event_convertible_bond_call_events(params, client = pool) {
  return client.query(`UPDATE event.convertible_bond_call_events
                SET parser_version=$1,parse_status=$2,document_id=COALESCE($3,document_id),details=$4::jsonb,updated_at=now()
              WHERE source_id=$5 AND source_key=$6`, params);
}

async function update_event_convertible_bond_call_events_1(params, client = pool) {
  return client.query(`
      UPDATE event.convertible_bond_call_events e
         SET no_call_until=v.max_no_call_until,updated_at=now()
        FROM (
          SELECT instrument_id,announced_at,MAX(no_call_until) AS max_no_call_until
            FROM event.convertible_bond_call_events
           WHERE event_type='waive' AND no_call_until IS NOT NULL GROUP BY instrument_id,announced_at
        ) v
       WHERE e.instrument_id=v.instrument_id AND e.announced_at=v.announced_at
         AND e.event_type='waive' AND e.no_call_until IS DISTINCT FROM v.max_no_call_until`);
}

async function select_event_convertible_bond_call_events_1(params, client = pool) {
  return client.query(`SELECT COUNT(*) FILTER (WHERE COALESCE(parser_version,'') <> $1
                                AND COALESCE(parser_version,'') <> ALL($2::text[]))::int AS old_count,
              COUNT(*) FILTER (WHERE COALESCE(parser_version,'') = ANY($2::text[]))::int AS compatible_count,
              COUNT(*) FILTER (WHERE parser_version=$1 AND parse_status <> 'complete')::int AS partial_count
         FROM event.convertible_bond_call_events`, params);
}

async function select_ops_data_quality_issues(params, client = pool) {
  return client.query(`SELECT COUNT(*) FILTER (WHERE issue_type='unmatched_security')::int AS unmatched,
              COUNT(*) FILTER (WHERE issue_type='document_cache_miss')::int AS document_failures
         FROM ops.data_quality_issues
        WHERE dataset_code=$1 AND status='open'`, params);
}

async function insert_ops_sync_cursors(params, client = pool) {
  return client.query(`INSERT INTO ops.sync_cursors(scope_key,dataset_code,last_success_date,last_source_update,last_attempt_at,last_error,retry_count,updated_at)
         VALUES($1,$2,$3::date,now(),now(),' ',0,now())
         ON CONFLICT(scope_key,dataset_code) DO UPDATE SET last_success_date=EXCLUDED.last_success_date,
           last_source_update=now(),last_attempt_at=now(),last_error='',retry_count=0,updated_at=now()`, params);
}

async function insert_ops_sync_cursors_1(params, client = pool) {
  return client.query(`INSERT INTO ops.sync_cursors(scope_key,dataset_code,last_success_date,last_source_update,last_attempt_at,last_error,retry_count,updated_at)
         VALUES($1,$2,NULL,now(),now(),$3,1,now())
         ON CONFLICT(scope_key,dataset_code) DO UPDATE SET last_attempt_at=now(),last_error=EXCLUDED.last_error,
           retry_count=ops.sync_cursors.retry_count+1,updated_at=now()`, params);
}

async function update_ops_ingestion_runs(params, client = pool) {
  return client.query(`UPDATE ops.ingestion_runs SET status=$2,row_count=$3,finished_at=now() WHERE run_id=$1`, params);
}

async function update_ops_ingestion_runs_1(params, client = pool) {
  return client.query(`UPDATE ops.ingestion_runs SET status='failed',error_message=$2,finished_at=now() WHERE run_id=$1`, params);
}

// 待解析的强赎公告事件：版本/解析状态/锁定日/原文时间等条件全部进 WHERE
async function listPendingCallEvents(params, client = pool) {
  const limitClause = params.configuredLimit ? ' LIMIT $4' : '';
  const retryPlaceholder = params.configuredLimit ? '$5' : '$4';
  return client.query(
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
            OR CASE WHEN e.raw_payload->>'announcementTime' ~ '^[0-9]+'
                    THEN e.announced_at IS DISTINCT FROM to_timestamp((e.raw_payload->>'announcementTime')::double precision / 1000)::date
                    ELSE false END
            OR (e.source_url ~ '/20[0-9]{2}-[0-9]{2}-[0-9]{2}/'
                AND e.announced_at IS DISTINCT FROM substring(e.source_url from '/(20[0-9]{2}-[0-9]{2}-[0-9]{2})/')::date))
          AND (${retryPlaceholder}::boolean OR e.parse_status <> 'failed')
        ORDER BY e.announced_at,e.event_id${limitClause}`,
    params.queryParams,
  );
}

module.exports = {
  listPendingCallEvents,
  loadDocumentCache,
  reconcileCallQuality,
  recordCallQuality,
  resolveCallQuality,
  insert_event_documents,
  select_ops_data_sources,
  select_fundamental_convertible_bond_profiles,
  select_core_instruments,
  insert_ops_ingestion_runs,
  insert_ops_raw_records,
  select_event_convertible_bond_call_events,
  insert_event_convertible_bond_call_events,
  update_event_convertible_bond_call_events,
  update_event_convertible_bond_call_events_1,
  select_event_convertible_bond_call_events_1,
  select_ops_data_quality_issues,
  insert_ops_sync_cursors,
  insert_ops_sync_cursors_1,
  update_ops_ingestion_runs,
  update_ops_ingestion_runs_1,
};

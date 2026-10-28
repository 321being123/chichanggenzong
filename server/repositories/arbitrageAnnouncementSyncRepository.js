const { pool } = require('../db/connection');

// 自 server/services/arbitrageAnnouncementSync.js 迁入的数据读写函数（只做标准事实读写，业务判定仍留在服务层）。

async function createIngestionRun(sourceId, dataset, range) {
  const { rows } = await pool.query(
    `INSERT INTO ops.ingestion_runs(source_id, dataset_code, request_range, status) VALUES($1,$2,$3,'running') RETURNING run_id`,
    [sourceId, dataset, JSON.stringify(range)]
  );
  return rows[0].run_id;
}

async function findOpenCase(client, instrumentId, strategyType) {
  if (!instrumentId) return null;
  const { rows } = await client.query(`
    SELECT case_id, review_status FROM event.arbitrage_cases
    WHERE target_instrument_id=$1 AND strategy_type=$2
      AND event_status NOT IN ('completed','terminated','expired')
    ORDER BY created_at DESC LIMIT 1
  `, [instrumentId, strategyType]);
  return rows[0] || null;
}

async function finishIngestionRun(runId, rowCount, errorMessage) {
  await pool.query(
    `UPDATE ops.ingestion_runs SET status=$1, row_count=$2, error_message=$3, finished_at=now() WHERE run_id=$4`,
    [errorMessage ? 'failed' : 'completed', rowCount, errorMessage || '', runId]
  );
}

async function getCursor(scopeKey, dataset) {
  const { rows } = await pool.query(
    'SELECT last_success_date, last_source_update, last_error, retry_count FROM ops.sync_cursors WHERE scope_key=$1 AND dataset_code=$2',
    [scopeKey, dataset]
  );
  return rows.length ? rows[0] : null;
}

async function getSourceId(sourceCode) {
  const { rows } = await pool.query('SELECT source_id FROM ops.data_sources WHERE source_code=$1', [sourceCode]);
  if (!rows.length) throw new Error('Data source not found: ' + sourceCode);
  return rows[0].source_id;
}

async function ingestRawRecord(runId, sourceId, dataset, ann) {
  const sourceKey = ann.sourceKey;
  const payloadHash = require('crypto').createHash('sha256').update(JSON.stringify(ann.rawPayload)).digest('hex').slice(0, 32);
  const { rows } = await pool.query(`
    INSERT INTO ops.raw_records(run_id, source_id, dataset_code, source_key, source_updated_at, payload, payload_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT(source_id, dataset_code, source_key, payload_hash) DO UPDATE SET run_id=EXCLUDED.run_id, ingested_at=now()
    RETURNING raw_record_id
  `, [runId, sourceId, dataset, sourceKey, ann.announcedAt ? ann.announcedAt + 'T00:00:00Z' : null, JSON.stringify(ann.rawPayload), payloadHash]);
  return rows[0].raw_record_id;
}

async function upsertCursor(scopeKey, dataset, lastSuccessDate, lastSourceUpdate, error) {
  await pool.query(`
    INSERT INTO ops.sync_cursors(scope_key, dataset_code, last_success_date, last_source_update, last_attempt_at, last_error, retry_count, updated_at)
    VALUES($1,$2,$3,$4,now(),$5,0,now())
    ON CONFLICT(scope_key, dataset_code) DO UPDATE SET
      last_success_date = GREATEST(
        COALESCE(ops.sync_cursors.last_success_date, '1900-01-01'::date),
        COALESCE(EXCLUDED.last_success_date, '1900-01-01'::date)
      ),
      last_source_update = COALESCE(EXCLUDED.last_source_update, ops.sync_cursors.last_source_update),
      last_attempt_at = now(),
      last_error = EXCLUDED.last_error,
      retry_count = CASE WHEN EXCLUDED.last_error <> '' THEN ops.sync_cursors.retry_count + 1 ELSE 0 END,
      updated_at = now()
  `, [scopeKey, dataset, lastSuccessDate, lastSourceUpdate, error || '']);
}

async function select_ops_data_sources(params, client = pool) {
  return client.query(`SELECT source_id FROM ops.data_sources WHERE source_code=$1 LIMIT 1`, params);
}

async function insert_ops_source_endpoint_runtime(params, client = pool) {
  return client.query(`INSERT INTO ops.source_endpoint_runtime(source_id,api_name,credential_fingerprint,consecutive_fallback_count,last_fallback_at,last_primary_success_at)
     VALUES($1,'arbitrage','none',CASE WHEN $2::boolean THEN 1 ELSE 0 END,CASE WHEN $2::boolean THEN now() END,CASE WHEN $2::boolean THEN NULL ELSE now() END)
     ON CONFLICT(source_id,api_name,credential_fingerprint) DO UPDATE SET
       consecutive_fallback_count=CASE WHEN $2::boolean THEN ops.source_endpoint_runtime.consecutive_fallback_count+1 ELSE 0 END,
       last_fallback_at=CASE WHEN $2::boolean THEN now() ELSE ops.source_endpoint_runtime.last_fallback_at END,
       last_primary_success_at=CASE WHEN $2::boolean THEN ops.source_endpoint_runtime.last_primary_success_at ELSE now() END,
       updated_at=now()
     RETURNING consecutive_fallback_count,last_primary_success_at`, params);
}

async function select_event_arbitrage_case_documents(params, client = pool) {
  return client.query(`
    SELECT ac.case_id,ac.review_status,d.title,d.announced_at,i.canonical_code
    FROM event.arbitrage_case_documents acd
    JOIN event.arbitrage_cases ac ON ac.case_id=acd.case_id
    JOIN event.documents d ON d.document_id=acd.document_id
    JOIN ops.data_sources ds ON ds.source_id=d.source_id
    JOIN core.instruments i ON i.instrument_id=ac.target_instrument_id
    WHERE ac.target_instrument_id=$1
      AND d.announced_at::date=$2::date
      AND ds.source_code IN ('cninfo_announcements','sse','szse')
    ORDER BY ac.created_at ASC,ac.case_id ASC,d.document_id ASC
  `, params);
}

async function select_core_instruments(params, client = pool) {
  return client.query(`SELECT instrument_id FROM core.instruments WHERE canonical_code=$1`, params);
}

async function update_core_instruments(params, client = pool) {
  return client.query(`UPDATE core.instruments SET name=$1 WHERE instrument_id=$2 AND name IS DISTINCT FROM $1`, params);
}

async function insert_event_documents(params, client = pool) {
  return client.query(`
      INSERT INTO event.documents(company_id, document_type, title, announced_at, url, source_id, content_hash, raw_record_id, raw_payload)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT(source_id, url, content_hash) DO UPDATE SET title=EXCLUDED.title, announced_at=COALESCE(EXCLUDED.announced_at, event.documents.announced_at), raw_payload=EXCLUDED.raw_payload
      RETURNING document_id
    `, params);
}

async function select_event_arbitrage_cases(params, client = pool) {
  return client.query(`
        SELECT case_id
        FROM event.arbitrage_cases
        WHERE strategy_type IN ('a_cash_offer','a_share_swap')
          AND event_status NOT IN ('completed','terminated','expired')
          AND (target_instrument_id=$1 OR reference_instrument_id=$1)
        ORDER BY announced_at DESC NULLS LAST, created_at DESC
      `, params);
}

async function insert_event_arbitrage_case_documents(params, client = pool) {
  return client.query(`
          INSERT INTO event.arbitrage_case_documents(case_id, document_id, relation_type, announced_at, document_role)
          VALUES($1,$2,'risk_event',$3,'risk')
          ON CONFLICT(case_id, document_id) DO UPDATE
            SET relation_type='risk_event', document_role='risk', announced_at=EXCLUDED.announced_at
        `, params);
}

async function update_event_arbitrage_cases(params, client = pool) {
  return client.query(`UPDATE event.arbitrage_cases SET updated_at=now() WHERE case_id=$1`, params);
}

async function select_event_arbitrage_cases_1(params, client = pool) {
  return client.query(`
        SELECT case_id FROM event.arbitrage_cases
        WHERE target_instrument_id=$1 AND strategy_type=$2 AND event_status NOT IN ('completed','terminated','expired')
        ORDER BY created_at DESC LIMIT 1
      `, params);
}

async function insert_event_arbitrage_case_documents_1(params, client = pool) {
  return client.query(`
          INSERT INTO event.arbitrage_case_documents(case_id, document_id, relation_type, announced_at, document_role)
          VALUES($1,$2,'announcement',$3,$4)
          ON CONFLICT(case_id, document_id) DO UPDATE SET document_role=EXCLUDED.document_role
        `, params);
}

async function update_event_arbitrage_cases_1(params, client = pool) {
  return client.query(`UPDATE event.arbitrage_cases SET event_status=$1, terms_updated_at=now(), updated_at=now() WHERE case_id=$2`, params);
}

async function select_event_arbitrage_cases_2(params, client = pool) {
  return client.query(`
        SELECT case_id FROM event.arbitrage_cases
        WHERE target_instrument_id=$1 AND strategy_type=$2
        ORDER BY announced_at DESC NULLS LAST,created_at DESC LIMIT 1
      `, params);
}

async function insert_event_arbitrage_case_documents_2(params, client = pool) {
  return client.query(`
          INSERT INTO event.arbitrage_case_documents(case_id,document_id,relation_type,announced_at,document_role)
          VALUES($1,$2,'announcement',$3,$4)
          ON CONFLICT(case_id,document_id) DO UPDATE SET document_role=EXCLUDED.document_role
        `, params);
}

async function update_event_arbitrage_cases_2(params, client = pool) {
  return client.query(`UPDATE event.arbitrage_cases SET event_status=$1,updated_at=now() WHERE case_id=$2`, params);
}

async function select_event_arbitrage_cases_3(params, client = pool) {
  return client.query(`
        SELECT case_id FROM event.arbitrage_cases
        WHERE target_instrument_id=$1
          AND strategy_type IN ('a_cash_offer','a_share_swap')
          AND event_status NOT IN ('completed','terminated','expired')
        ORDER BY announced_at DESC NULLS LAST, created_at DESC
      `, params);
}

async function insert_event_arbitrage_case_documents_3(params, client = pool) {
  return client.query(`
          INSERT INTO event.arbitrage_case_documents(case_id, document_id, relation_type, announced_at, document_role)
          VALUES($1,$2,'announcement',$3,'terminal')
          ON CONFLICT(case_id, document_id) DO UPDATE SET document_role='terminal', announced_at=EXCLUDED.announced_at
        `, params);
}

async function update_event_arbitrage_cases_3(params, client = pool) {
  return client.query(`
          UPDATE event.arbitrage_cases
          SET event_status='terminated', terms_updated_at=COALESCE($1::date, terms_updated_at), updated_at=now()
          WHERE case_id=$2
        `, params);
}

async function select_event_documents(params, client = pool) {
  return client.query(`SELECT ac.case_id,ac.review_status
             FROM event.documents d
             JOIN event.arbitrage_case_documents acd ON acd.document_id=d.document_id
             JOIN event.arbitrage_cases ac ON ac.case_id=acd.case_id
            WHERE d.raw_payload->>'announcement_merge_key'=$1
            ORDER BY ac.created_at ASC,ac.case_id ASC LIMIT 1`, params);
}

async function select_event_arbitrage_cases_4(params, client = pool) {
  return client.query(`
          SELECT c.case_id,max(d.announced_at) AS terminal_date
          FROM event.arbitrage_cases c
          JOIN event.arbitrage_case_documents acd ON acd.case_id=c.case_id
          JOIN event.documents d ON d.document_id=acd.document_id
          WHERE c.target_instrument_id=$1 AND c.strategy_type=$2
            AND c.event_status IN ('completed','terminated','expired')
          GROUP BY c.case_id HAVING max(d.announced_at)>=$3::date
          ORDER BY terminal_date DESC LIMIT 1
        `, params);
}

async function select_event_arbitrage_cases_5(params, client = pool) {
  return client.query(`SELECT case_id, review_status FROM event.arbitrage_cases WHERE source_id=$1 AND source_key=$2`, params);
}

async function update_event_arbitrage_cases_4(params, client = pool) {
  return client.query(`UPDATE event.arbitrage_cases SET terms_updated_at=now(), updated_at=now() WHERE case_id=$1`, params);
}

async function insert_event_arbitrage_cases(params, client = pool) {
  return client.query(`
          INSERT INTO event.arbitrage_cases(market, strategy_type, source_id, source_key, target_instrument_id, primary_document_id,
            event_status, review_status, announced_at, terms_updated_at, raw_payload,event_key,parse_status)
          VALUES($1,$2,$3,$4,$5,$6,'proposed','pending',$7,now(),$8,$9,'unparsed')
          RETURNING case_id
        `, params);
}

async function select_event_arbitrage_case_documents_1(params, client = pool) {
  return client.query(`
    SELECT acd.case_id,acd.document_id,acd.document_role,d.url,i.canonical_code
    FROM event.arbitrage_case_documents acd
    JOIN event.arbitrage_cases c ON c.case_id=acd.case_id
    JOIN event.documents d ON d.document_id=acd.document_id
    JOIN core.instruments i ON i.instrument_id=c.target_instrument_id
    WHERE c.event_status NOT IN ('completed','terminated','expired')
      AND acd.document_role IN ('amendment','terms','summary','proposal')
      AND (
        (acd.parser_version IS DISTINCT FROM $1 AND COALESCE(acd.next_parse_attempt_at, now()) <= now())
        OR (acd.parse_status='failed' AND acd.parse_attempts < $2
            AND COALESCE(acd.next_parse_attempt_at, now()) <= now())
        OR (acd.parse_status <> 'failed' AND acd.parsed_payload IS NULL
            AND COALESCE(acd.next_parse_attempt_at, now()) <= now())
      )
      AND d.url ~* '\\.pdf($|\\?)'
    ORDER BY d.announced_at DESC,acd.document_id DESC
  `, params);
}

async function select_event_arbitrage_case_documents_2(params, client = pool) {
  return client.query(`
    SELECT
      COUNT(*) FILTER (WHERE
        ((acd.parser_version IS DISTINCT FROM $1
          OR (acd.parse_status='failed' AND acd.parse_attempts < $2)
          OR (acd.parse_status <> 'failed' AND acd.parsed_payload IS NULL))
         AND COALESCE(acd.next_parse_attempt_at, now()) <= now())
      )::int AS pending,
      COUNT(*) FILTER (WHERE
        ((acd.parser_version IS DISTINCT FROM $1
          OR (acd.parse_status='failed' AND acd.parse_attempts < $2)
          OR (acd.parse_status <> 'failed' AND acd.parsed_payload IS NULL))
         AND acd.next_parse_attempt_at > now())
      )::int AS pending_not_due,
      COUNT(*) FILTER (WHERE acd.parse_status='failed' AND acd.parser_version=$1 AND acd.parse_attempts >= $2)::int AS exhausted
    FROM event.arbitrage_case_documents acd
    JOIN event.arbitrage_cases c ON c.case_id=acd.case_id
    JOIN event.documents d ON d.document_id=acd.document_id
    WHERE c.event_status NOT IN ('completed','terminated','expired')
      AND acd.document_role IN ('amendment','terms','summary','proposal')
      AND d.url ~* '\\.pdf($|\\?)'
  `, params);
}

async function select_event_arbitrage_case_documents_3(params, client = pool) {
  return client.query(`
    SELECT acd.case_id,acd.document_id,
           legacy.title AS legacy_title,legacy.announced_at AS legacy_announced_at,
           official.title AS official_title,official.announced_at AS official_announced_at,
           i.canonical_code
    FROM event.arbitrage_case_documents acd
    JOIN event.arbitrage_cases c ON c.case_id=acd.case_id
    JOIN event.documents legacy ON legacy.document_id=acd.document_id
    JOIN ops.data_sources legacy_source ON legacy_source.source_id=legacy.source_id
    JOIN core.instruments i ON i.instrument_id=c.target_instrument_id
    JOIN event.arbitrage_case_documents official_link ON official_link.case_id=acd.case_id
    JOIN event.documents official ON official.document_id=official_link.document_id
    JOIN ops.data_sources official_source ON official_source.source_id=official.source_id
    WHERE c.event_status NOT IN ('completed','terminated','expired')
      AND acd.document_role = ANY($1::text[])
      AND legacy_source.source_code='cninfo_announcements'
      AND official_source.source_code = ANY($2::text[])
      AND legacy.announced_at::date=official.announced_at::date
      AND legacy.url ~* '\\.pdf($|\\?)'
      AND official.url ~* '\\.pdf($|\\?)'
  `, params);
}

async function update_event_arbitrage_case_documents(params, client = pool) {
  return client.query(`
      UPDATE event.arbitrage_case_documents
         SET document_role='superseded'
       WHERE case_id=$1 AND document_id=$2 AND document_role = ANY($3::text[])
    `, params);
}

module.exports = {
  createIngestionRun,
  findOpenCase,
  finishIngestionRun,
  getCursor,
  getSourceId,
  ingestRawRecord,
  upsertCursor,
  select_ops_data_sources,
  insert_ops_source_endpoint_runtime,
  select_event_arbitrage_case_documents,
  select_core_instruments,
  update_core_instruments,
  insert_event_documents,
  select_event_arbitrage_cases,
  insert_event_arbitrage_case_documents,
  update_event_arbitrage_cases,
  select_event_arbitrage_cases_1,
  insert_event_arbitrage_case_documents_1,
  update_event_arbitrage_cases_1,
  select_event_arbitrage_cases_2,
  insert_event_arbitrage_case_documents_2,
  update_event_arbitrage_cases_2,
  select_event_arbitrage_cases_3,
  insert_event_arbitrage_case_documents_3,
  update_event_arbitrage_cases_3,
  select_event_documents,
  select_event_arbitrage_cases_4,
  select_event_arbitrage_cases_5,
  update_event_arbitrage_cases_4,
  insert_event_arbitrage_cases,
  select_event_arbitrage_case_documents_1,
  select_event_arbitrage_case_documents_2,
  select_event_arbitrage_case_documents_3,
  update_event_arbitrage_case_documents,
};

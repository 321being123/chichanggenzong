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

module.exports = {
  createIngestionRun,
  findOpenCase,
  finishIngestionRun,
  getCursor,
  getSourceId,
  ingestRawRecord,
  upsertCursor,
};

const { pool } = require('../db/connection');

async function loadCursor(scopeKey, datasetCode) {
  return pool.query(`SELECT cursor_payload FROM ops.sync_cursors WHERE scope_key=$1 AND dataset_code=$2 LIMIT 1`, [scopeKey, datasetCode]);
}

async function saveCursor(client, scopeKey, datasetCode, payload, lastError = '') {
  await client.query(`INSERT INTO ops.sync_cursors(scope_key,dataset_code,last_success_date,last_source_update,last_attempt_at,last_error,cursor_payload)
    VALUES ($1,$2,CURRENT_DATE,now(),now(),$3,$4::jsonb)
    ON CONFLICT(scope_key,dataset_code) DO UPDATE SET last_success_date=CURRENT_DATE,last_source_update=now(),last_attempt_at=now(),last_error=EXCLUDED.last_error,cursor_payload=EXCLUDED.cursor_payload,updated_at=now()`,
  [scopeKey, datasetCode, lastError, JSON.stringify(payload)]);
}

module.exports = { loadCursor, saveCursor };

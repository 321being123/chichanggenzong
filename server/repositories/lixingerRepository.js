const { pool } = require('../db/connection');

async function findRecent(source, requestKey, ttlMs, tx) {
  return (tx || pool).query(`SELECT r.raw_record_id,r.payload,r.payload_hash
    FROM ops.raw_records r JOIN ops.data_sources s USING(source_id)
    WHERE s.source_code=$1 AND r.dataset_code='lixinger_response' AND r.source_key=$2
      AND r.ingested_at >= now()-($3::bigint * interval '1 millisecond')
    ORDER BY r.ingested_at DESC,r.raw_record_id DESC LIMIT 1`, [source, requestKey, ttlMs]);
}

async function saveResponse(source, requestKey, payloadJson, payloadHash, tx) {
  return (tx || pool).query(`INSERT INTO ops.raw_records(source_id,dataset_code,source_key,payload,payload_hash)
      SELECT source_id,'lixinger_response',$2,$3::jsonb,$4 FROM ops.data_sources WHERE source_code=$1
      ON CONFLICT(source_id,dataset_code,source_key,payload_hash) DO UPDATE SET ingested_at=now()
      RETURNING raw_record_id,payload,payload_hash`, [source, requestKey, payloadJson, payloadHash]);
}

module.exports = { findRecent, saveResponse };

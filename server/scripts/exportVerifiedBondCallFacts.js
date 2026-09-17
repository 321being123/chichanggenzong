require('dotenv').config();

const { pool } = require('../db/connection');

async function exportVerifiedBondCallFacts() {
  const { rows } = await pool.query(`
    SELECT i.canonical_code,
           e.event_type,e.announced_at::text,e.decision_date::text,e.lock_start_date::text,
           e.no_call_until::text,e.validity_basis,e.last_trade_date::text,
           e.last_conversion_date::text,e.redemption_record_date::text,e.redemption_price::text,
           es.source_code AS event_source_code,e.source_key,e.source_url,e.title,
           e.parse_status,e.parser_version,e.details,e.raw_payload,
           ds.source_code AS document_source_code,d.document_type,d.title AS document_title,
           d.announced_at::text AS document_announced_at,d.url AS document_url,
           d.content_hash,d.raw_payload AS document_raw_payload
      FROM event.convertible_bond_call_events e
      JOIN core.instruments i ON i.instrument_id=e.instrument_id
      JOIN ops.data_sources es ON es.source_id=e.source_id
      JOIN event.documents d ON d.document_id=e.document_id
      JOIN ops.data_sources ds ON ds.source_id=d.source_id
     WHERE e.parser_version='call-event-v3'
       AND e.parse_status='complete'
       AND d.document_type='convertible_bond_call_announcement'
       AND d.raw_payload->'extraction'->>'status'='complete'
       AND NULLIF(d.raw_payload->>'extracted_text','') IS NOT NULL
     ORDER BY e.announced_at,e.event_id`);
  if (!rows.length) throw new Error('本地没有可导出的强赎公告验证事实');
  if (rows.some(row => !row.canonical_code || !row.source_key || !row.document_url || !row.content_hash)) {
    throw new Error('本地强赎公告验证事实存在关键字段缺失');
  }
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    baselineFrom: rows[0].announced_at,
    baselineTo: rows[rows.length - 1].announced_at,
    count: rows.length,
    events: rows,
  };
}

if (require.main === module) {
  exportVerifiedBondCallFacts()
    .then(result => process.stdout.write(JSON.stringify(result)))
    .catch(error => { console.error(error.stack || error); process.exitCode = 1; })
    .finally(() => pool.end().catch(() => {}));
}

module.exports = { exportVerifiedBondCallFacts };

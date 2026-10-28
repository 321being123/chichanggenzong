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

module.exports = {
  loadDocumentCache,
  reconcileCallQuality,
  recordCallQuality,
  resolveCallQuality,
};

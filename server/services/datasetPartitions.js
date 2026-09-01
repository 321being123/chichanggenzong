const { pool } = require('../db/connection');

function dateText(value) {
  const text = String(value || '').replace(/-/g, '').slice(0, 8);
  return /^\d{8}$/.test(text) ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}` : null;
}

async function publishDatasetPartition(datasetCode, scopeKey, options = {}, executor = pool.query.bind(pool)) {
  const partitionKey = dateText(options.partitionKey || options.dataAsOf);
  const dataAsOf = dateText(options.dataAsOf || partitionKey) || partitionKey;
  if (!datasetCode || !partitionKey) throw new Error(`数据集分区缺少有效日期：${datasetCode}`);
  const status = options.status || 'published';
  const stale = status === 'stale' || Boolean(options.isStale);
  const result = await executor(
    `INSERT INTO ops.dataset_partitions
       (dataset_code,scope_key,partition_key,status,data_as_of,published_at,is_stale,stale_reason,row_count,source_id,diagnostics)
     VALUES($1,$2,$3,$4,$5,CASE WHEN $4='published' THEN now() ELSE NULL END,$6,$7,$8,$9,$10::jsonb)
     ON CONFLICT(dataset_code,scope_key,partition_key) DO UPDATE SET
       status=EXCLUDED.status,data_as_of=EXCLUDED.data_as_of,
       published_at=CASE WHEN EXCLUDED.status='published' THEN now() ELSE ops.dataset_partitions.published_at END,
       is_stale=EXCLUDED.is_stale,stale_reason=EXCLUDED.stale_reason,row_count=EXCLUDED.row_count,
       source_id=EXCLUDED.source_id,diagnostics=EXCLUDED.diagnostics,updated_at=now()
     RETURNING dataset_code,scope_key,partition_key,status,data_as_of,published_at,is_stale,stale_reason,row_count`,
    [String(datasetCode), String(scopeKey || ''), partitionKey, status, dataAsOf, stale,
      String(options.staleReason || ''), Number(options.rowCount || 0), options.sourceId || null,
      JSON.stringify(options.diagnostics || {})]
  );
  return result.rows[0] || null;
}

async function getLatestPublishedPartition(datasetCode, scopeKey = '') {
  const { rows } = await pool.query(
    `SELECT dataset_code,scope_key,partition_key::text,data_as_of::text,published_at,is_stale,stale_reason,row_count,diagnostics
       FROM ops.dataset_partitions
      WHERE dataset_code=$1 AND scope_key=$2 AND status='published'
      ORDER BY partition_key DESC LIMIT 1`, [datasetCode, String(scopeKey || '')]
  );
  return rows[0] || null;
}

async function getDatasetMetadata(datasetCode, scopeKey = '') {
  const published = await getLatestPublishedPartition(datasetCode, scopeKey);
  if (published) return {
    data_as_of: dateText(published.data_as_of || published.partition_key),
    published_at: published.published_at || null,
    is_stale: Boolean(published.is_stale),
    stale_reason: published.stale_reason || '',
    row_count: Number(published.row_count || 0),
    diagnostics: published.diagnostics || {},
  };
  return { data_as_of: null, published_at: null, is_stale: true, stale_reason: '尚无已发布数据分区', row_count: 0, diagnostics: {} };
}

module.exports = { dateText, publishDatasetPartition, getLatestPublishedPartition, getDatasetMetadata };

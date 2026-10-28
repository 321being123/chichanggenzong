const { pool } = require('../db/connection');
const crypto = require('crypto');

// 自 server/services/hkIpoMarketSignals.js 迁入的数据读写函数（只做标准事实读写，业务判定仍留在服务层）。

async function persistRaw(sourceCode, datasetCode, sourceKey, payload, executor = pool) {
  const source = await executor.query('SELECT source_id FROM ops.data_sources WHERE source_code=$1 LIMIT 1', [sourceCode]);
  if (!source.rows[0]) return;
  const text = JSON.stringify(payload || {});
  await executor.query(`
    INSERT INTO ops.raw_records(source_id,dataset_code,source_key,source_updated_at,payload,payload_hash)
    VALUES($1,$2,$3,now(),$4::jsonb,$5)
    ON CONFLICT(source_id,dataset_code,source_key,payload_hash) DO UPDATE SET ingested_at=now()
  `, [source.rows[0].source_id, datasetCode, sourceKey, text, crypto.createHash('sha256').update(text).digest('hex')]);
}

module.exports = {
  persistRaw,
};

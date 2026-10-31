// 理杏仁官方来源的原始记录与接口策略读取。
//
// 只做 SQL 执行，不做取舍判断：原始响应统一进 ops.raw_records（保留来源、接口、参数、
// 时间和哈希），接口权限状态读取 ops.source_endpoint_policies，不另建事实表或本地计数器。
const { pool } = require('../db/connection');

const DATASET_CODE = 'lixinger_response';

// 同一来源＋同一请求（接口＋参数哈希）在有效期内命中已落库原始响应，避免重复外采。
async function findRecentResponse(params, client = pool) {
  const { sourceCode, requestKey, ttlMs } = params;
  return client.query(
    `SELECT r.raw_record_id, r.payload, r.payload_hash, r.ingested_at
       FROM ops.raw_records r
       JOIN ops.data_sources s USING (source_id)
      WHERE s.source_code = $1
        AND r.dataset_code = $2
        AND r.source_key = $3
        AND r.ingested_at >= now() - ($4::bigint * interval '1 millisecond')
      ORDER BY r.ingested_at DESC, r.raw_record_id DESC
      LIMIT 1`,
    [sourceCode, DATASET_CODE, requestKey, ttlMs]
  );
}

// 原始响应先落库再交付消费者；重复哈希只刷新采集时间，不重复插入。
async function saveResponse(params, client = pool) {
  const { sourceCode, requestKey, payloadJson, payloadHash } = params;
  return client.query(
    `INSERT INTO ops.raw_records(source_id, dataset_code, source_key, payload, payload_hash)
     SELECT source_id, $2, $3, $4::jsonb, $5
       FROM ops.data_sources
      WHERE source_code = $1
     ON CONFLICT(source_id, dataset_code, source_key, payload_hash)
       DO UPDATE SET ingested_at = now()
     RETURNING raw_record_id, payload_hash`,
    [sourceCode, DATASET_CODE, requestKey, payloadJson, payloadHash]
  );
}

// 读取单接口的权限策略；凭据指纹不一致视为凭据已更换，旧结论不能继续拦新凭据。
async function selectPolicy(params, client = pool) {
  const { sourceCode, apiName, credentialProfile } = params;
  return client.query(
    `SELECT p.permission_status, p.enabled, p.credential_fingerprint
       FROM ops.source_endpoint_policies p
       JOIN ops.data_sources s USING (source_id)
      WHERE s.source_code = $1 AND p.api_name = $2 AND p.credential_profile = $3`,
    [sourceCode, apiName, credentialProfile]
  );
}

module.exports = {
  DATASET_CODE,
  findRecentResponse,
  saveResponse,
  selectPolicy,
};

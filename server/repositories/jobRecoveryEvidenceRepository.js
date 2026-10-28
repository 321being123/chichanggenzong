const { pool } = require('../db/connection');

// 恢复证据的数据读取：通用执行入口，供可注入查询器的默认实现使用。
async function runQuery(sql, params, client = pool) {
  return client.query(sql, params);
}

const SCOPE_PAYLOAD_KEYS = ['username', 'accountName', 'market', 'scopeKey', 'fromDate', 'throughDate'];

// 恢复范围条件：任务/业务日/阶段/账户区间与目标证券字段全部进 WHERE，由仓储构造
function recoveryScopeFilter(slot, startIndex) {
  const payload = (slot && slot.request_payload) || {};
  const first = Number(startIndex) || 5;
  const clauses = [`COALESCE(request_payload->>'mode','core')=$${first}`];
  const params = [String(payload.mode || 'core')];
  SCOPE_PAYLOAD_KEYS.forEach((key, index) => {
    clauses.push(`COALESCE(request_payload->>'${key}','')=$${first + index + 1}`);
    params.push(String(payload[key] ?? ''));
  });
  const codesIndex = first + SCOPE_PAYLOAD_KEYS.length + 1;
  const fieldsIndex = codesIndex + 1;
  clauses.push(`COALESCE(request_payload->'targetCodes','[]'::jsonb) @> $${codesIndex}::jsonb`);
  clauses.push(`$${codesIndex}::jsonb @> COALESCE(request_payload->'targetCodes','[]'::jsonb)`);
  clauses.push(`COALESCE(request_payload->'targetFields','[]'::jsonb) @> $${fieldsIndex}::jsonb`);
  clauses.push(`$${fieldsIndex}::jsonb @> COALESCE(request_payload->'targetFields','[]'::jsonb)`);
  params.push(JSON.stringify([...((payload.targetCodes || []))].map(String)));
  params.push(JSON.stringify([...((payload.targetFields || []))].map(String)));
  return { sql: clauses.join('\n          AND '), params, nextIndex: fieldsIndex + 1 };
}


function verifySlotRecoveryEvidenceLayerQuery1(executor, parts, ...args) { return executor(`SELECT id,slot_id,status,result_json,attempt_no,trigger_type
       FROM job_runs WHERE slot_id=$1 ORDER BY id DESC LIMIT 1`, ...args); }

function verifySlotRecoveryEvidenceLayerQuery2(executor, parts, ...args) { return executor(`SELECT dataset_code,scope_key,partition_key,status,is_stale,diagnostics
         FROM ops.dataset_partitions
        WHERE dataset_code=ANY($1::text[]) AND partition_key=$2::date`, ...args); }

module.exports = {
  verifySlotRecoveryEvidenceLayerQuery1, verifySlotRecoveryEvidenceLayerQuery2, recoveryScopeFilter, runQuery };

const { pool } = require('../db/connection');

// 恢复证据的数据读取：通用执行入口，供可注入查询器的默认实现使用。
async function runQuery(sql, params, client = pool) {
  return client.query(sql, params);
}

// 业务身份字段（F08）：只比 job + 业务日 + 模式，会把"同一任务名的另一件工作"当成续跑。
// batchId（通知群发按批次执行）、targetDate/targetTradeDate（补数按目标日）、quarter（选股按季度）
// 必须进 SQL 的 WHERE，否则分页取候选时前 N 条都是别的业务对象，真正的同范围成功永远找不到。
const SCOPE_PAYLOAD_KEYS = [
  'username', 'accountName', 'market', 'scopeKey', 'fromDate', 'throughDate',
  'batchId', 'targetDate', 'targetTradeDate', 'quarter',
];

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

// 阶段 3 旧任务码告警映射：旧告警只带 slot_id / job_code，阶段模式必须从原计划槽的
// request_payload 读取；映射证据（数据集分区 / 连续成功）都按该任务的目标日核对。
function loadLegacyAlertSlot(executor, parts, ...args) {
  return executor(`SELECT slot_id,job_code,business_date,scheduled_for,status,request_payload
       FROM ops.job_schedule_slots WHERE slot_id=$1`, ...args);
}

function loadLegacyAliasDatasetEvidence(executor, parts, ...args) {
  return executor(`SELECT dataset_code,scope_key,partition_key::text,status,is_stale,diagnostics
       FROM ops.dataset_partitions
      WHERE dataset_code=ANY($1::text[]) AND partition_key=$2::date`, ...args);
}

// 只取原告警之后的后续实例；最新一条失败就说明当前仍未恢复，不能被更早的成功掩盖。
function loadLegacySuccessorSuccesses(executor, parts, ...args) {
  return executor(`SELECT slot_id,job_code,business_date,scheduled_for,status,data_as_of,result_summary
       FROM ops.job_schedule_slots
      WHERE job_code=$1 AND scheduled_for > $2::timestamptz
        AND status IN ('succeeded','degraded','failed')
      ORDER BY scheduled_for DESC, slot_id DESC LIMIT $3`, ...args);
}

module.exports = {
  verifySlotRecoveryEvidenceLayerQuery1, verifySlotRecoveryEvidenceLayerQuery2, recoveryScopeFilter, runQuery,
  loadLegacyAlertSlot, loadLegacyAliasDatasetEvidence, loadLegacySuccessorSuccesses };

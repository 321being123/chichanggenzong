// 外部来源接口策略：只保存运行规则和不可逆凭据指纹，不保存任何明文密钥。
const { pool } = require('../db/connection');

const PROFILES = new Set(['primary', 'backup', 'anonymous']);
const PERMISSION_STATUSES = new Set([
  'unknown', 'available', 'permission_denied', 'rate_limited',
  'not_configured', 'empty_but_accepted', 'error',
]);

function numberOrNull(value, { min = 0, integer = true } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || (integer && !Number.isInteger(number)) || number < min) {
    throw new Error('策略数值非法');
  }
  return number;
}

function normalizePolicyInput(input = {}) {
  const apiName = String(input.api_name || input.apiName || '*').trim().slice(0, 64);
  if (!/^(?:\*|[A-Za-z0-9_.:-]{1,64})$/.test(apiName)) throw new Error('接口名非法');
  const credentialProfile = String(input.credential_profile || input.credentialProfile || 'anonymous').trim();
  if (!PROFILES.has(credentialProfile)) throw new Error('凭据角色非法');
  const permissionStatus = String(input.permission_status || input.permissionStatus || 'unknown').trim();
  if (!PERMISSION_STATUSES.has(permissionStatus)) throw new Error('权限状态非法');
  const retryPolicy = input.retry_policy && typeof input.retry_policy === 'object' ? input.retry_policy : {
    max_attempts: 1, backoff_ms: 0, jitter_ms: 0, retry_on: [],
  };
  const maxAttempts = numberOrNull(retryPolicy.max_attempts, { min: 1 });
  const backoffMs = numberOrNull(retryPolicy.backoff_ms, { min: 0 });
  const jitterMs = numberOrNull(retryPolicy.jitter_ms, { min: 0 });
  if (maxAttempts == null || maxAttempts > 10) throw new Error('重试次数必须在1到10之间');
  return {
    apiName,
    credentialProfile,
    credentialFingerprint: String(input.credential_fingerprint || input.credentialFingerprint || 'none').slice(0, 128),
    pointsRequired: numberOrNull(input.points_required ?? input.pointsRequired, { min: 0 }),
    permissionMode: String(input.permission_mode || input.permissionMode || 'unknown').slice(0, 64),
    permissionStatus,
    officialPerMinuteLimit: numberOrNull(input.official_per_minute_limit ?? input.officialPerMinuteLimit, { min: 1 }),
    officialDailyLimit: numberOrNull(input.official_daily_limit ?? input.officialDailyLimit, { min: 1 }),
    internalPerMinuteLimit: numberOrNull(input.internal_per_minute_limit ?? input.internalPerMinuteLimit, { min: 1 }),
    internalDailyLimit: numberOrNull(input.internal_daily_limit ?? input.internalDailyLimit, { min: 1 }),
    maxConcurrency: numberOrNull(input.max_concurrency ?? input.maxConcurrency ?? 1, { min: 1 }),
    minIntervalMs: numberOrNull(input.min_interval_ms ?? input.minIntervalMs ?? 0, { min: 0 }),
    rowLimit: numberOrNull(input.row_limit ?? input.rowLimit, { min: 1 }),
    timeoutMs: numberOrNull(input.timeout_ms ?? input.timeoutMs ?? 30000, { min: 1 }),
    emptyPolicy: String(input.empty_policy || input.emptyPolicy || 'preserve_last_success').slice(0, 64),
    retryPolicy: { max_attempts: maxAttempts, backoff_ms: backoffMs || 0, jitter_ms: jitterMs || 0,
      retry_on: Array.isArray(retryPolicy.retry_on) ? retryPolicy.retry_on.map(v => String(v).slice(0, 64)).slice(0, 20) : [] },
    officialDocUrl: input.official_doc_url || input.officialDocUrl ? String(input.official_doc_url || input.officialDocUrl).slice(0, 500) : null,
    enabled: input.enabled !== false,
    notes: input.notes == null ? null : String(input.notes).slice(0, 2000),
  };
}

async function listSourceEndpointPolicies(sourceCode = null) {
  const params = [];
  let where = '';
  if (sourceCode) { params.push(String(sourceCode)); where = 'WHERE ds.source_code=$1'; }
  const { rows } = await pool.query(
    `SELECT p.policy_id,p.source_id,ds.source_code,ds.source_name,p.api_name,
            p.credential_profile,p.credential_fingerprint,p.points_required,p.permission_mode,
            p.permission_status,p.official_per_minute_limit,p.official_daily_limit,
            p.internal_per_minute_limit,p.internal_daily_limit,p.max_concurrency,p.min_interval_ms,
            p.row_limit,p.timeout_ms,p.empty_policy,p.retry_policy,p.official_doc_url,p.enabled,
            p.last_verified_at,p.verification_message,p.notes,p.created_at,p.updated_at,
            COALESCE((SELECT SUM(b.call_count)::int FROM ops.external_call_budgets b
              WHERE b.source=ds.source_code
                AND (b.api_name=p.api_name OR (p.api_name='*' AND b.api_name<>'*'))
                AND b.credential_profile=p.credential_profile AND b.credential_fingerprint=p.credential_fingerprint
                AND b.window_type='day' AND b.window_key=to_char(now() AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD')),0) AS current_day_count,
            COALESCE((SELECT SUM(b.call_count)::int FROM ops.external_call_budgets b
              WHERE b.source=ds.source_code
                AND (b.api_name=p.api_name OR (p.api_name='*' AND b.api_name<>'*'))
                AND b.credential_profile=p.credential_profile AND b.credential_fingerprint=p.credential_fingerprint
                AND b.window_type='minute' AND b.window_key=floor(extract(epoch FROM now())/60)::bigint::text),0) AS current_minute_count
       FROM ops.source_endpoint_policies p
       JOIN ops.data_sources ds ON ds.source_id=p.source_id
       ${where}
      ORDER BY ds.source_code,p.credential_profile,CASE WHEN p.api_name='*' THEN 0 ELSE 1 END,p.api_name`, params
  );
  return rows;
}

async function upsertSourceEndpointPolicy(input = {}) {
  const value = normalizePolicyInput(input);
  const sourceCode = String(input.source_code || input.sourceCode || '').trim();
  if (!sourceCode) throw new Error('来源不能为空');
  const { rows } = await pool.query(
    `INSERT INTO ops.source_endpoint_policies
       (source_id,api_name,credential_profile,credential_fingerprint,points_required,permission_mode,
        permission_status,official_per_minute_limit,official_daily_limit,internal_per_minute_limit,
        internal_daily_limit,max_concurrency,min_interval_ms,row_limit,timeout_ms,empty_policy,
        retry_policy,official_doc_url,enabled,notes,updated_at)
     SELECT ds.source_id,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,now()
       FROM ops.data_sources ds WHERE ds.source_code=$1
     ON CONFLICT(source_id,api_name,credential_profile) DO UPDATE SET
       credential_fingerprint=EXCLUDED.credential_fingerprint,points_required=EXCLUDED.points_required,
       permission_mode=EXCLUDED.permission_mode,permission_status=EXCLUDED.permission_status,
       official_per_minute_limit=EXCLUDED.official_per_minute_limit,official_daily_limit=EXCLUDED.official_daily_limit,
       internal_per_minute_limit=EXCLUDED.internal_per_minute_limit,internal_daily_limit=EXCLUDED.internal_daily_limit,
       max_concurrency=EXCLUDED.max_concurrency,min_interval_ms=EXCLUDED.min_interval_ms,row_limit=EXCLUDED.row_limit,
       timeout_ms=EXCLUDED.timeout_ms,empty_policy=EXCLUDED.empty_policy,retry_policy=EXCLUDED.retry_policy,
       official_doc_url=EXCLUDED.official_doc_url,enabled=EXCLUDED.enabled,notes=EXCLUDED.notes,updated_at=now()
     RETURNING policy_id`,
    [sourceCode,value.apiName,value.credentialProfile,value.credentialFingerprint,value.pointsRequired,value.permissionMode,
      value.permissionStatus,value.officialPerMinuteLimit,value.officialDailyLimit,value.internalPerMinuteLimit,
      value.internalDailyLimit,value.maxConcurrency,value.minIntervalMs,value.rowLimit,value.timeoutMs,value.emptyPolicy,
      JSON.stringify(value.retryPolicy),value.officialDocUrl,value.enabled,value.notes]
  );
  if (!rows.length) throw new Error('来源不存在');
  return rows[0].policy_id;
}

async function syncCredentialFingerprint(sourceCode, credentialProfile, fingerprint, { resetPermission = true } = {}) {
  if (!sourceCode || !PROFILES.has(credentialProfile) || !fingerprint) return;
  await pool.query(
    `UPDATE ops.source_endpoint_policies
        SET credential_fingerprint=$3,
            permission_status=CASE WHEN $4 THEN 'unknown' ELSE permission_status END,
            last_verified_at=CASE WHEN $4 THEN NULL ELSE last_verified_at END,
            verification_message=CASE WHEN $4 THEN NULL ELSE verification_message END,
            enabled=CASE WHEN $4
                              AND credential_fingerprint IS DISTINCT FROM $3
                              AND permission_status IN ('permission_denied','not_configured')
                         THEN true ELSE enabled END,
            updated_at=now()
      WHERE source_id=(SELECT source_id FROM ops.data_sources WHERE source_code=$1)
        AND credential_profile=$2`, [sourceCode,credentialProfile,String(fingerprint),resetPermission]
  );
}

async function recordEndpointPermission(sourceCode, credentialProfile, apiName, fingerprint, result) {
  if (!sourceCode || !PROFILES.has(credentialProfile) || !apiName) return;
  const status = PERMISSION_STATUSES.has(String(result && result.status)) ? String(result.status) : (result && result.ok ? 'available' : 'error');
  await pool.query(
    `INSERT INTO ops.source_endpoint_policies
       (source_id,api_name,credential_profile,credential_fingerprint,permission_status,last_verified_at,verification_message,enabled)
     SELECT ds.source_id,$2,$3,$4,$5,now(),$6,
            CASE WHEN $5 IN ('permission_denied','not_configured') THEN false ELSE true END
       FROM ops.data_sources ds WHERE ds.source_code=$1
     ON CONFLICT(source_id,api_name,credential_profile) DO UPDATE SET
       credential_fingerprint=EXCLUDED.credential_fingerprint,permission_status=EXCLUDED.permission_status,
       last_verified_at=EXCLUDED.last_verified_at,verification_message=EXCLUDED.verification_message,
       enabled=CASE WHEN EXCLUDED.permission_status IN ('permission_denied','not_configured')
                    THEN false
                    WHEN EXCLUDED.permission_status IN ('available','empty_but_accepted')
                     AND ops.source_endpoint_policies.permission_status IN ('permission_denied','not_configured')
                    THEN true
                    ELSE ops.source_endpoint_policies.enabled END,
       updated_at=now()`,
    [sourceCode,String(apiName).slice(0,64),credentialProfile,String(fingerprint || 'none'),status,String(result && result.message || '').slice(0,240)]
  );
}

module.exports = {
  listSourceEndpointPolicies,
  upsertSourceEndpointPolicy,
  syncCredentialFingerprint,
  recordEndpointPermission,
  normalizePolicyInput,
};

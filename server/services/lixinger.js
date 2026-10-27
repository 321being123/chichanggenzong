// GeoScope 理杏仁：统一数据层入口。只开放已核验路径，响应先落库再交消费者。
const crypto = require('crypto');
const { pool } = require('../db/connection');
const { withExternalCallGuard, tokenFingerprint, openExternalCircuit } = require('./externalCallGuard');
const { recordEndpointPermission } = require('./sourceEndpointPolicy');

const SOURCE = 'geoscope_lixinger';
const BASE_URL = 'https://geoscopeapp.com/api/v1/data/lixinger/';
const ENDPOINTS = Object.freeze({
  'cn/company': { apiName: 'cn.company', ttlMs: 7 * 86400000 },
  'cn/company/fs/bank': { apiName: 'cn.company.fs.bank', ttlMs: 12 * 3600000 },
  'cn/company/fs/security': { apiName: 'cn.company.fs.security', ttlMs: 12 * 3600000 },
  'cn/company/fundamental/non_financial': { apiName: 'cn.company.fundamental.non_financial', ttlMs: 86400000 },
  'cn/company/industries': { apiName: 'cn.company.industries', ttlMs: 7 * 86400000 },
  'macro/gdp': { apiName: 'macro.gdp', ttlMs: 86400000 },
});
const inFlight = new Map();

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function sourceError(code, message) { return Object.assign(new Error(message), { code, source: SOURCE }); }

function validateRequest(endpoint, params) {
  if (!Object.hasOwn(ENDPOINTS, endpoint)) throw sourceError('ENDPOINT_NOT_ADMITTED', '理杏仁接口未准入或账号无权限');
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw sourceError('INVALID_REQUEST', '理杏仁请求参数必须为对象');
  const containsCredential = value => value && typeof value === 'object' && Object.entries(value)
    .some(([key, child]) => /token|secret|authorization|api.?key/i.test(key) || containsCredential(child));
  if (containsCredential(params)) {
    throw sourceError('INVALID_REQUEST', '理杏仁请求体禁止携带凭据');
  }
}

function unwrapResponse(payload) {
  const upstream = payload && payload.data && !Array.isArray(payload.data) ? payload.data : payload;
  for (const body of [payload, upstream]) {
    if (body && (body.error || body.success === false || (body.code != null && ![1, 'success', 'ok'].includes(body.code)))) {
      throw sourceError('UPSTREAM_ERROR', '理杏仁返回业务错误，保留旧数据');
    }
  }
  const rows = Array.isArray(upstream) ? upstream : upstream && upstream.data;
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
    throw sourceError('INVALID_RESPONSE', '理杏仁响应格式异常，保留旧数据');
  }
  return rows;
}

async function extractLixingerData(endpoint, params, options = {}) {
  validateRequest(endpoint, params);
  const requestJson = JSON.stringify(stable(params));
  const requestKey = `${endpoint}:${hash(requestJson)}`;
  if (inFlight.has(requestKey)) return inFlight.get(requestKey);
  const promise = extractOnce(endpoint, params, requestKey, options);
  inFlight.set(requestKey, promise);
  try { return await promise; } finally { inFlight.delete(requestKey); }
}

async function extractOnce(endpoint, params, requestKey, options) {
  const client = options.client || pool;
  const policy = ENDPOINTS[endpoint];
  const cached = await client.query(`SELECT r.raw_record_id,r.payload,r.payload_hash
    FROM ops.raw_records r JOIN ops.data_sources s USING(source_id)
    WHERE s.source_code=$1 AND r.dataset_code='lixinger_response' AND r.source_key=$2
      AND r.ingested_at >= now()-($3::bigint * interval '1 millisecond')
    ORDER BY r.ingested_at DESC,r.raw_record_id DESC LIMIT 1`, [SOURCE, requestKey, policy.ttlMs]);
  if (cached.rows[0]) return resultFromRecord(cached.rows[0], endpoint, true);
  const token = process.env.GEOSCOPE_API_KEY || '';
  if (!token) throw sourceError('NOT_CONFIGURED', '理杏仁备用源尚未配置 GEOSCOPE_API_KEY');
  const fingerprint = tokenFingerprint(token);
  const guardOptions = { apiName: policy.apiName, credentialProfile: 'primary', tokenFingerprint: fingerprint, circuitSource: SOURCE };
  const guard = options.guard || withExternalCallGuard;
  const fetcher = options.fetch || fetch;
  return guard(SOURCE, requestKey, options.targetDate || null, async () => {
    // 跨进程在 Guard 串行后再核对一次，避免等待期间已被另一进程采集。
    const recent = await client.query(`SELECT r.raw_record_id,r.payload,r.payload_hash
      FROM ops.raw_records r JOIN ops.data_sources s USING(source_id)
      WHERE s.source_code=$1 AND r.dataset_code='lixinger_response' AND r.source_key=$2
        AND r.ingested_at >= now()-($3::bigint * interval '1 millisecond')
      ORDER BY r.ingested_at DESC,r.raw_record_id DESC LIMIT 1`, [SOURCE, requestKey, policy.ttlMs]);
    if (recent.rows[0]) return resultFromRecord(recent.rows[0], endpoint, true);
    let response;
    try {
      response = await fetcher(BASE_URL + endpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(params),
      });
    } catch (_) { throw sourceError('NETWORK_ERROR', '理杏仁网络连接失败，保留旧数据'); }
    if (!response.ok) {
      const status = response.status;
      const code = status === 401 ? 'INVALID_CREDENTIAL' : status === 403 ? 'PERMISSION_DENIED' : status === 429 ? 'RATE_LIMIT' : 'UPSTREAM_ERROR';
      const message = `理杏仁接口请求失败（HTTP ${status}）`;
      if (status === 401 || status === 403) await recordEndpointPermission(SOURCE, 'primary', policy.apiName, fingerprint,
        { status: 'permission_denied', message });
      if (status === 429) await openExternalCircuit(SOURCE, message, { ...guardOptions, errorCode: code });
      throw sourceError(code, message);
    }
    let payload;
    try { payload = await response.json(); } catch (_) { throw sourceError('INVALID_RESPONSE', '理杏仁响应不是有效 JSON'); }
    const rows = unwrapResponse(payload);
    const record = { endpoint, params, response: payload };
    const payloadJson = JSON.stringify(record), payloadHash = hash(payloadJson);
    const saved = await client.query(`INSERT INTO ops.raw_records(source_id,dataset_code,source_key,payload,payload_hash)
      SELECT source_id,'lixinger_response',$2,$3::jsonb,$4 FROM ops.data_sources WHERE source_code=$1
      ON CONFLICT(source_id,dataset_code,source_key,payload_hash) DO UPDATE SET ingested_at=now()
      RETURNING raw_record_id,payload,payload_hash`, [SOURCE, requestKey, payloadJson, payloadHash]);
    if (!saved.rows[0]) throw sourceError('SOURCE_NOT_REGISTERED', '理杏仁数据源尚未登记，响应未交付');
    await recordEndpointPermission(SOURCE, 'primary', policy.apiName, fingerprint,
      { status: rows.length ? 'available' : 'empty_but_accepted', message: rows.length ? '采集成功，原始响应已落库' : '成功空结果已留证，不推进覆盖水位' });
    return resultFromRecord(saved.rows[0], endpoint, false);
  }, guardOptions);
}

function resultFromRecord(record, endpoint, cached) {
  const rows = unwrapResponse(record.payload.response);
  if (!rows.length) throw sourceError('EMPTY_DATA', '理杏仁接口返回空数据，保留旧数据');
  return { source: SOURCE, endpoint, rawRecordId: record.raw_record_id, payloadHash: record.payload_hash, cached, rows };
}

// 业务按原接口传入主源采集函数；有有效主源就不请求备用源。
// 各接口单独回退，任务止损、非法参数和系统错误不能借换源绕过。
async function extractWithLixingerBackup(primary, endpoint, params, options = {}) {
  validateRequest(endpoint, params);
  const valid = options.isUsable || (result => Array.isArray(result && result.rows) && result.rows.length > 0);
  let primaryError;
  try {
    const result = await primary();
    if (valid(result)) return result;
  } catch (error) {
    if (!['AUTH_ERROR', 'INVALID_CREDENTIAL', 'PERMISSION_DENIED', 'POLICY_DISABLED', 'POLICY_NOT_CONFIGURED',
      'RATE_LIMIT', 'QUOTA_EXHAUSTED', 'CIRCUIT_OPEN', 'EMPTY_DATA', 'NETWORK_ERROR', 'NETWORK_TIMEOUT',
      'UPSTREAM_ERROR', 'UPSTREAM_5XX', 'INVALID_RESPONSE', 'TIMEOUT'].includes(error.code)) throw error;
    primaryError = error;
  }
  try { return await extractLixingerData(endpoint, params, options); }
  catch (error) {
    if (primaryError) error.primaryCode = primaryError.code;
    throw error;
  }
}

async function fetchLixingerIndustry(canonicalCode, options = {}) {
  const { resolveProviderCode } = require('./securityIdentity');
  const stockCode = await resolveProviderCode({ canonicalCode, sourceCode: SOURCE, identifierType: 'stock_code' });
  if (!stockCode) throw sourceError('IDENTITY_NOT_FOUND', '理杏仁证券身份未匹配');
  const result = await extractLixingerData('cn/company/industries', { stockCode }, options);
  // 仅接申万2021；返回 stockCode 是行业代码，不能拿它当证券代码。
  const nodes = result.rows.filter(row => row.source === 'sw_2021' && row.areaCode === 'cn'
    && /^\d{6}$/.test(row.stockCode) && typeof row.name === 'string' && row.name.trim())
    .map(row => ({ ...row, level: row.stockCode.endsWith('0000') ? 1 : row.stockCode.endsWith('00') ? 2 : 3 }))
    .sort((a, b) => a.level - b.level);
  if (!nodes.length || new Set(nodes.map(row => row.level)).size !== nodes.length) {
    throw sourceError('AMBIGUOUS_INDUSTRY', '理杏仁行业分类缺失或存在歧义');
  }
  const deepest = nodes[nodes.length - 1];
  return { industry: deepest.name, industry_code: deepest.stockCode, industry_system: '申万2021',
    industry_level: `${deepest.level}级`, industry_path: nodes.map(row => row.name), industry_source: SOURCE,
    industry_raw_record_id: result.rawRecordId };
}

module.exports = { SOURCE, ENDPOINTS, extractLixingerData, extractWithLixingerBackup,
  fetchLixingerIndustry, unwrapResponse, validateRequest };

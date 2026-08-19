// 外部请求预算、接口熔断和数据集并发锁。
// 预算与熔断分表，且熔断绑定不可逆 Token 指纹，多个 Worker 共用同一状态。
const crypto = require('crypto');
let pool = null;
function getPool() {
  if (!pool) pool = require('../db/connection').pool;
  return pool;
}
const counters = new Map();

function limit(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function nowParts(now = Date.now()) {
  const date = new Date(now);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(item => [item.type, item.value]));
  return {
    minute: Math.floor(now / 60000),
    day: `${values.year}-${values.month}-${values.day}`,
  };
}

class ExternalCallGuardError extends Error {
  constructor(code, message, source, dataset, details = {}) {
    super(message);
    this.name = 'ExternalCallGuardError';
    this.code = code;
    this.errorType = code === 'RATE_LIMIT' || code === 'QUOTA_EXHAUSTED' ? 'rate_limit'
      : code === 'DATASET_LOCKED' ? 'in_progress' : 'circuit_open';
    this.source = source;
    this.dataset = dataset;
    this.apiName = details.apiName || '';
    this.tokenFingerprint = details.tokenFingerprint || '';
    this.recoverAt = details.recoverAt || null;
    this.retryable = false;
  }
}

function tokenFingerprint(token) {
  const value = String(token || '');
  return value ? crypto.createHash('sha256').update(value).digest('hex') : 'none';
}

function deriveApiName(source, circuitSource, dataset) {
  const value = String(circuitSource || source || '');
  const match = value.match(/^tushare(?:_backup)?:(.+)$/i);
  if (match && match[1]) return match[1].split(':')[0].slice(0, 64);
  if (/^tushare(?:_backup)?$/i.test(value)) {
    const datasetName = String(dataset || '').split(':')[0].trim();
    return datasetName || '*';
  }
  return '*';
}

function normalizeGuardOptions(source, circuitSource, options = {}, dataset = '') {
  const supplied = circuitSource && typeof circuitSource === 'object' ? circuitSource : options;
  const configuredSource = typeof circuitSource === 'string' ? circuitSource : supplied.circuitSource;
  return {
    circuitSource: sourceKey(configuredSource || source),
    apiName: String(supplied.apiName || deriveApiName(source, configuredSource, dataset) || '*').slice(0, 64),
    tokenFingerprint: String(supplied.tokenFingerprint || 'none').slice(0, 128),
  };
}

function sourceKey(source) {
  const key = String(source || 'unknown');
  return key;
}

function budgetLimits(key) {
  const envKey = key.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  return {
    minute: limit(`${envKey}_PER_MINUTE_BUDGET`, key === 'tushare' ? 120 : 60),
    day: limit(`${envKey}_DAILY_BUDGET`, key === 'tushare' ? 4000 : 2000),
  };
}

function nextMinuteAt() {
  return new Date((Math.floor(Date.now() / 60000) + 1) * 60000 + 1000);
}

function nextShanghaiDayAt() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(item => [item.type, item.value]));
  return new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day) + 1) - 8 * 3600 * 1000 + 1000);
}

function recoverAtFor(code) {
  if (code === 'RATE_LIMIT') return nextMinuteAt();
  if (code === 'QUOTA_EXHAUSTED') return nextShanghaiDayAt();
  return null;
}

function circuitApiName(apiName, code) {
  // 只有 Token 认证失效或调用方明确传入 '*' 时才扩大到整个 Token。
  // 上游接口自己的“当日次数耗尽”仍然只属于当前接口；本系统总预算在调用方传入 '*'。
  return code === 'AUTH_ERROR' ? '*' : String(apiName || '*').slice(0, 64);
}

async function upsertCircuit(client, source, apiName, fingerprint, code, errorType, detail, recoverAt) {
  await client.query(
    `INSERT INTO ops.external_circuits
       (source,api_name,token_fingerprint,state,recover_at,probe_in_flight,error_code,error_type,detail)
     VALUES($1,$2,$3,'open',$4,false,$5,$6,$7)
     ON CONFLICT(source,api_name,token_fingerprint) DO UPDATE SET
       state='open', recover_at=EXCLUDED.recover_at, probe_in_flight=false,
       error_code=EXCLUDED.error_code, error_type=EXCLUDED.error_type,
       detail=EXCLUDED.detail, opened_at=now(), updated_at=now()`,
    [sourceKey(source), circuitApiName(apiName, code), String(fingerprint || 'none'), recoverAt,
      String(code || 'CIRCUIT_OPEN').slice(0, 64), String(errorType || 'circuit_open').slice(0, 64), String(detail || '').slice(0, 1000)]
  );
}

async function assertCircuitAvailable(client, source, apiName, fingerprint, dataset) {
  const key = sourceKey(source);
  const names = apiName === '*' ? ['*'] : [apiName, '*'];
  const { rows } = await client.query(
    `SELECT api_name,recover_at,probe_in_flight,error_code,error_type,detail,
            (recover_at IS NOT NULL AND recover_at <= now()) AS probe_ready
       FROM ops.external_circuits
      WHERE source=$1 AND api_name=ANY($2::text[]) AND token_fingerprint=$3 AND state='open'
      ORDER BY CASE WHEN api_name='*' THEN 0 ELSE 1 END
      FOR UPDATE`, [key, names, String(fingerprint || 'none')]
  );
  const row = rows[0];
  if (!row) return;
  const recoverAt = row.recover_at || null;
  if (row.probe_ready && !row.probe_in_flight) {
    await client.query(
      `UPDATE ops.external_circuits SET probe_in_flight=true,updated_at=now()
        WHERE source=$1 AND api_name=$2 AND token_fingerprint=$3`,
      [key, row.api_name, String(fingerprint || 'none')]
    );
    return;
  }
  const scope = row.api_name === '*' ? 'Token' : `接口 ${row.api_name}`;
  throw new ExternalCallGuardError('CIRCUIT_OPEN', `${key} ${scope}已熔断，等待恢复探测`, key, dataset, {
    apiName: row.api_name === '*' ? apiName : row.api_name,
    tokenFingerprint: fingerprint,
    recoverAt,
  });
}

function localCount(key, day, minute) {
  let item = counters.get(key);
  if (!item || item.day !== day) item = { day, minute, minuteCount: 0, dayCount: 0 };
  if (item.minute !== minute) item.minuteCount = 0;
  item.minute = minute;
  item.minuteCount += 1;
  item.dayCount += 1;
  counters.set(key, item);
  return item;
}

async function consumeExternalCall(source, dataset = '', providedClient = null, circuitSource = source, options = {}) {
  const key = sourceKey(source);
  const guardOptions = normalizeGuardOptions(source, circuitSource, options, dataset);
  const { minute, day } = nowParts();
  const limits = budgetLimits(key);
  const client = providedClient || await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('external_budget:' || $1))", [key]);
    const dayKey = day;
    const minuteKey = `${day}:${minute}`;
    const { rows: dayRows } = await client.query(
      `SELECT call_count FROM ops.external_call_budgets
        WHERE source=$1 AND window_type='day' AND window_key=$2 FOR UPDATE`, [key, dayKey]
    );
    await assertCircuitAvailable(client, key, guardOptions.apiName, guardOptions.tokenFingerprint, dataset);
    const { rows: minuteRows } = await client.query(
      `SELECT call_count FROM ops.external_call_budgets
        WHERE source=$1 AND window_type='minute' AND window_key=$2 FOR UPDATE`, [key, minuteKey]
    );
    const dayCount = Number(dayRows[0]?.call_count || 0);
    const minuteCount = Number(minuteRows[0]?.call_count || 0);
    if (minuteCount >= limits.minute) {
      const recoverAt = recoverAtFor('RATE_LIMIT');
      await upsertCircuit(client, key, guardOptions.apiName, guardOptions.tokenFingerprint,
        'RATE_LIMIT', 'rate_limit', `${key} 已达到每分钟请求预算 ${limits.minute}`, recoverAt);
      await client.query('COMMIT');
      throw new ExternalCallGuardError('RATE_LIMIT', `${key} ${guardOptions.apiName} 已达到每分钟请求预算 ${limits.minute}`, key, dataset, {
        apiName: guardOptions.apiName, tokenFingerprint: guardOptions.tokenFingerprint, recoverAt,
      });
    }
    if (dayCount >= limits.day) {
      const recoverAt = recoverAtFor('QUOTA_EXHAUSTED');
      await upsertCircuit(client, key, '*', guardOptions.tokenFingerprint,
        'QUOTA_EXHAUSTED', 'rate_limit', `${key} 已达到当日请求预算 ${limits.day}`, recoverAt);
      await client.query('COMMIT');
      throw new ExternalCallGuardError('QUOTA_EXHAUSTED', `${key} 已达到当日请求预算 ${limits.day}`, key, dataset, {
        apiName: '*', tokenFingerprint: guardOptions.tokenFingerprint, recoverAt,
      });
    }
    await client.query(
      `INSERT INTO ops.external_call_budgets(source,window_type,window_key,call_count,budget_limit)
       VALUES($1,'day',$2,1,$3)
       ON CONFLICT(source,window_type,window_key) DO UPDATE SET call_count=ops.external_call_budgets.call_count+1,updated_at=now()`,
      [key, dayKey, limits.day]
    );
    await client.query(
      `INSERT INTO ops.external_call_budgets(source,window_type,window_key,call_count,budget_limit)
       VALUES($1,'minute',$2,1,$3)
       ON CONFLICT(source,window_type,window_key) DO UPDATE SET call_count=ops.external_call_budgets.call_count+1,updated_at=now()`,
      [key, minuteKey, limits.minute]
    );
    await client.query('COMMIT');
    const item = localCount(key, day, minute);
    return { source: key, dataset, minuteCount: item.minuteCount, dayCount: item.dayCount };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    if (!providedClient) client.release();
  }
}

async function acquireExternalDatasetLock(source, dataset, businessDate) {
  const key = `${sourceKey(source)}:${String(dataset || 'unknown')}:${String(businessDate || nowParts().day).slice(0, 10)}`;
  const client = await getPool().connect();
  try {
    const { rows } = await client.query(
      "SELECT pg_try_advisory_lock(hashtext('external_dataset:' || $1)) AS ok", [key]
    );
    if (!rows[0]?.ok) {
      client.release();
      throw new ExternalCallGuardError('DATASET_LOCKED', '同一数据集正在由其他 Worker 请求中', sourceKey(source), dataset);
    }
    return { client, key };
  } catch (error) {
    if (error.code !== 'DATASET_LOCKED') client.release();
    throw error;
  }
}

async function releaseExternalDatasetLock(lock) {
  if (!lock?.client) return;
  await lock.client.query("SELECT pg_advisory_unlock(hashtext('external_dataset:' || $1))", [lock.key]).catch(() => {});
  lock.client.release();
}

async function withExternalCallGuard(source, dataset, businessDate, fn, circuitSource = source) {
  const guardOptions = normalizeGuardOptions(source, circuitSource, {}, dataset);
  const lock = await acquireExternalDatasetLock(source, dataset, businessDate);
  try {
    await consumeExternalCall(source, dataset, lock.client, guardOptions.circuitSource, guardOptions);
    return await fn();
  } finally {
    await releaseExternalDatasetLock(lock);
  }
}

async function openExternalCircuit(source, detail = '', circuitSource = source, options = {}) {
  const key = sourceKey(source);
  const supplied = circuitSource && typeof circuitSource === 'object' ? circuitSource : options;
  const guardOptions = normalizeGuardOptions(source, circuitSource, supplied, '');
  const code = String(supplied && supplied.errorCode || '').toUpperCase() || 'CIRCUIT_OPEN';
  const errorType = supplied && supplied.errorType || '';
  const recoverAt = supplied && Object.prototype.hasOwnProperty.call(supplied, 'recoverAt')
    ? supplied.recoverAt : recoverAtFor(code);
  const client = await getPool().connect();
  try {
    await upsertCircuit(client, key, guardOptions.apiName, guardOptions.tokenFingerprint,
      code, errorType || (code === 'RATE_LIMIT' || code === 'QUOTA_EXHAUSTED' ? 'rate_limit' : 'circuit_open'), detail, recoverAt);
  } finally {
    client.release();
  }
  return { source: key, apiName: circuitApiName(guardOptions.apiName, code), recoverAt };
}

async function closeExternalCircuit(source, apiName, fingerprint = 'none') {
  const key = sourceKey(source);
  await getPool().query(
    `UPDATE ops.external_circuits
        SET state='closed',probe_in_flight=false,last_success_at=now(),updated_at=now()
      WHERE source=$1 AND api_name=ANY($2::text[]) AND token_fingerprint=$3`,
    [key, [String(apiName || '*').slice(0, 64), '*'], String(fingerprint || 'none')]
  );
}

async function releaseExternalCircuitProbe(source, apiName, fingerprint = 'none', retryMs = 5000) {
  const key = sourceKey(source);
  await getPool().query(
    `UPDATE ops.external_circuits
        SET probe_in_flight=false,
            recover_at=now() + ($4 * interval '1 millisecond'),
            updated_at=now()
      WHERE source=$1 AND api_name=ANY($2::text[]) AND token_fingerprint=$3
        AND state='open' AND probe_in_flight=true`,
    [key, [String(apiName || '*').slice(0, 64), '*'], String(fingerprint || 'none'), Math.max(Number(retryMs) || 5000, 1000)]
  );
}

async function invalidateExternalCircuits(source, fingerprint) {
  if (!fingerprint) return;
  await getPool().query(
    'DELETE FROM ops.external_circuits WHERE source=$1 AND token_fingerprint=$2',
    [sourceKey(source), String(fingerprint)]
  );
}

async function getExternalCircuitStatuses(source = 'tushare', tokens = {}) {
  const sourceKeyName = sourceKey(source);
  const roles = Object.entries(tokens || {}).filter(([, token]) => token).map(([role, token]) => ({
    role,
    source: sourceKeyName === 'tushare' && role === 'backup' ? 'tushare_backup' : sourceKeyName,
    fingerprint: tokenFingerprint(token),
  }));
  if (!roles.length) return [];
  const fingerprints = roles.map(item => item.fingerprint);
  const roleBySourceFingerprint = new Map(roles.map(item => [`${item.source}:${item.fingerprint}`, item.role]));
  const sources = [...new Set(roles.map(item => item.source))];
  const { rows } = await getPool().query(
    `SELECT source,api_name,token_fingerprint,state,recover_at,error_code,error_type,detail,updated_at
       FROM ops.external_circuits
      WHERE source=ANY($1::text[]) AND token_fingerprint=ANY($2::text[]) AND state='open'
      ORDER BY source,api_name`, [sources, fingerprints]
  );
  return rows.map(row => ({
    source_role: roleBySourceFingerprint.get(`${row.source}:${row.token_fingerprint}`) || 'unknown',
    source: row.source,
    api_name: row.api_name,
    status: row.recover_at && new Date(row.recover_at).getTime() <= Date.now() ? 'probe_ready' : 'open',
    recover_at: row.recover_at || null,
    error_code: row.error_code || null,
    error_type: row.error_type || null,
    detail: String(row.detail || '').slice(0, 240),
    updated_at: row.updated_at || null,
  }));
}

function resetExternalCallGuard() {
  counters.clear();
}

async function resetExternalCallGuardPersistence(source = null) {
  const { day } = nowParts();
  if (source) {
    await getPool().query(
      'DELETE FROM ops.external_call_budgets WHERE window_key=$1 AND (source=$2 OR source LIKE $2 || \':%\')',
      [day, source]
    );
    await getPool().query('DELETE FROM ops.external_circuits WHERE source=$1 OR source LIKE $1 || \':%\'', [source]);
    return;
  }
  await getPool().query('DELETE FROM ops.external_call_budgets WHERE window_key=$1', [day]);
  await getPool().query('DELETE FROM ops.external_circuits');
}

function getExternalCallStats() {
  let total = 0;
  const sources = {};
  for (const [source, item] of counters.entries()) {
    sources[source] = Number(item.dayCount || 0);
    total += sources[source];
  }
  return { total, sources };
}

module.exports = {
  ExternalCallGuardError,
  tokenFingerprint,
  consumeExternalCall,
  withExternalCallGuard,
  openExternalCircuit,
  closeExternalCircuit,
  releaseExternalCircuitProbe,
  invalidateExternalCircuits,
  getExternalCircuitStatuses,
  resetExternalCallGuard,
  resetExternalCallGuardPersistence,
  getExternalCallStats,
};

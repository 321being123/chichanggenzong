// 外部请求预算、接口熔断和数据集并发锁。
// 预算与熔断分表，且熔断绑定不可逆 Token 指纹，多个 Worker 共用同一状态。
const crypto = require('crypto');
const os = require('os');
let pool = null;
function getPool() {
  if (!pool) pool = require('../db/connection').pool;
  return pool;
}
const counters = new Map();
// 同一进程内先做一次快速抢占，避免第二个调用因等待数据库连接而在
// 第一个调用释放 PostgreSQL advisory lock 后又继续执行。
const localDatasetLocks = new Set();
const PROBE_LEASE_MS = 5 * 60 * 1000;
const PROBE_OWNER = `${os.hostname()}:${process.pid}:${crypto.randomUUID()}`;
let runCallCount = 0;

function limit(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// 这是系统内部保护线，不等同于上游官方配额。
// 主账号为 6000 积分：按官方 500 次/分钟保留 50 次余量；常规接口官方无每日总量，故不设内部日线。
// 备用账号为 2000 积分：按官方 200 次/分钟保留 20 次余量；官方单接口每日 100000 次，
// 以 90000 次作为跨接口凭据级止损线，防止异常循环耗尽账号额度。
const DEFAULT_EXTERNAL_BUDGETS = Object.freeze({
  tushare: { minute: 450, day: null },
  tushare_backup: { minute: 180, day: 90000 },
  // 巨潮曾发生熔断，保留既有来源级保护线，不用 Tushare 规则替代。
  cninfo: { minute: 20, day: 500 },
  // 腾讯当前没有触及内部预算，不设置本系统分钟/日限额；仍保留上游异常处理。
  tencent: { minute: null, day: null },
  default: { minute: 60, day: 2000 },
});

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
    this.errorType = code === 'RATE_LIMIT' || code === 'QUOTA_EXHAUSTED' || code === 'BUDGET_WAIT' ? 'rate_limit'
      : ['JOB_BUDGET_EXCEEDED', 'POLICY_NOT_CONFIGURED', 'POLICY_DISABLED'].includes(code) ? 'non_retryable'
      : code === 'DATASET_LOCKED' ? 'in_progress' : 'circuit_open';
    this.source = source;
    this.dataset = dataset;
    this.apiName = details.apiName || '';
    this.credentialProfile = details.credentialProfile || '';
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
    budgetSource: budgetSourceKey(source),
    credentialProfile: ['primary', 'backup', 'anonymous'].includes(String(supplied.credentialProfile || ''))
      ? String(supplied.credentialProfile) : defaultCredentialProfile(source),
    apiName: String(supplied.apiName || deriveApiName(source, configuredSource, dataset) || '*').slice(0, 64),
    tokenFingerprint: String(supplied.tokenFingerprint || 'none').slice(0, 128),
  };
}

function sourceKey(source) {
  const key = String(source || 'unknown');
  return key;
}

function budgetSourceKey(source) {
  const key = sourceKey(source);
  return key.toLowerCase() === 'tushare_backup' ? 'tushare' : key;
}

function defaultCredentialProfile(source) {
  const key = sourceKey(source).toLowerCase();
  return key === 'tushare_backup' ? 'backup' : key === 'tushare' ? 'primary' : 'anonymous';
}

function getExternalBudgetLimits(key) {
  const envKey = key.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  const defaults = DEFAULT_EXTERNAL_BUDGETS[key] || DEFAULT_EXTERNAL_BUDGETS.default;
  return {
    minute: limit(`${envKey}_PER_MINUTE_BUDGET`, defaults.minute),
    day: limit(`${envKey}_DAILY_BUDGET`, defaults.day),
  };
}

const budgetLimits = getExternalBudgetLimits;

function jobRunLimit() {
  if (process.env.JOB_EXTERNAL_CALL_LIMIT_ACTIVE !== '1') return null;
  const value = Number(process.env.JOB_EXTERNAL_CALL_LIMIT);
  return Number.isFinite(value) && value >= 0 ? value : null;
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

function recoverAtFor(code, windowType = null) {
  if (code === 'RATE_LIMIT' || (code === 'BUDGET_WAIT' && windowType !== 'day')) return nextMinuteAt();
  if (code === 'BUDGET_WAIT' && windowType === 'day') return nextShanghaiDayAt();
  if (code === 'QUOTA_EXHAUSTED') return nextShanghaiDayAt();
  return null;
}

function circuitApiName(apiName, code) {
  // 只有 Token 认证失效或调用方明确传入 '*' 时才扩大到整个 Token。
  // 上游接口自己的“当日次数耗尽”仍然只属于当前接口；本系统总预算在调用方传入 '*'。
  return code === 'AUTH_ERROR' ? '*' : String(apiName || '*').slice(0, 64);
}

function circuitScopeLabel(source, apiName) {
  if (apiName !== '*') return `接口 ${apiName}`;
  return /^tushare(?:_backup)?$/i.test(String(source || '')) ? 'Token' : '来源';
}

async function upsertCircuit(client, source, apiName, fingerprint, code, errorType, detail, recoverAt) {
  await client.query(
    `INSERT INTO ops.external_circuits
       (source,api_name,token_fingerprint,state,recover_at,probe_in_flight,probe_owner,probe_token,probe_lease_until,error_code,error_type,detail)
     VALUES($1,$2,$3,'open',$4,false,NULL,NULL,NULL,$5,$6,$7)
     ON CONFLICT(source,api_name,token_fingerprint) DO UPDATE SET
       state='open', recover_at=EXCLUDED.recover_at, probe_in_flight=false,
       probe_owner=NULL, probe_token=NULL, probe_lease_until=NULL,
       error_code=EXCLUDED.error_code, error_type=EXCLUDED.error_type,
       detail=EXCLUDED.detail, opened_at=now(), updated_at=now()`,
    [sourceKey(source), circuitApiName(apiName, code), String(fingerprint || 'none'), recoverAt,
      String(code || 'CIRCUIT_OPEN').slice(0, 64), String(errorType || 'circuit_open').slice(0, 64), String(detail || '').slice(0, 1000)]
  );
}

async function assertCircuitAvailable(client, source, apiName, fingerprint, dataset, probeOwner = PROBE_OWNER) {
  const key = sourceKey(source);
  const names = apiName === '*' ? ['*'] : [apiName, '*'];
  const { rows } = await client.query(
    `SELECT api_name,recover_at,probe_in_flight,probe_owner,probe_token,probe_lease_until,error_code,error_type,detail,updated_at,
            (recover_at IS NOT NULL AND recover_at <= now()) AS probe_ready,
            (probe_in_flight AND COALESCE(probe_lease_until, COALESCE(updated_at,opened_at) + interval '5 minutes') < now()) AS stale_probe
       FROM ops.external_circuits
      WHERE source=$1 AND api_name=ANY($2::text[]) AND token_fingerprint=$3 AND state='open'
      ORDER BY CASE WHEN api_name='*' THEN 0 ELSE 1 END
      FOR UPDATE`, [key, names, String(fingerprint || 'none')]
  );
  const row = rows[0];
  if (!row) return;
  const recoverAt = row.recover_at || null;
  // Worker 被强制终止时无法执行 finally，回收超过租期的探测占用，避免熔断永久卡死。
  if (row.probe_ready && (!row.probe_in_flight || row.stale_probe)) {
    const probeToken = crypto.randomUUID();
    await client.query(
      `UPDATE ops.external_circuits
          SET probe_in_flight=true, probe_owner=$4, probe_token=$5,
              probe_lease_until=now()+($6::integer * interval '1 millisecond'), updated_at=now()
        WHERE source=$1 AND api_name=$2 AND token_fingerprint=$3`,
      [key, row.api_name, String(fingerprint || 'none'), probeOwner, probeToken, PROBE_LEASE_MS]
    );
    return { probeToken, probeApiName: row.api_name };
  }
  const scope = circuitScopeLabel(key, row.api_name);
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
  const runLimit = jobRunLimit();
  if (runLimit != null && runCallCount >= runLimit) {
    throw new ExternalCallGuardError('JOB_BUDGET_EXCEEDED', `${key} 已达到本任务声明的外部请求上限 ${runLimit}`, key, dataset, {
      apiName: guardOptions.apiName, tokenFingerprint: guardOptions.tokenFingerprint,
    });
  }
  const client = providedClient || await getPool().connect();
  try {
    await client.query('BEGIN');
    const probe = await assertCircuitAvailable(client, key, guardOptions.apiName, guardOptions.tokenFingerprint, dataset);
    // 旧 ops.consume_external_call_budget 仅保留迁移兼容；实际限额由 reserve_external_call 读取策略。
    const { rows: budgetRows } = await client.query(
      'SELECT * FROM ops.reserve_external_call($1,$2,$3,$4)',
      [guardOptions.budgetSource, guardOptions.apiName, guardOptions.credentialProfile, guardOptions.tokenFingerprint]
    );
    const budget = budgetRows[0] || {};
    if (!budget.allowed) {
      const reason = String(budget.reason || 'policy_missing');
      if (reason === 'policy_missing' || reason === 'policy_disabled') {
        await client.query('COMMIT');
        throw new ExternalCallGuardError(reason === 'policy_disabled' ? 'POLICY_DISABLED' : 'POLICY_NOT_CONFIGURED',
          `${guardOptions.budgetSource} ${guardOptions.apiName} 未配置可用接口策略`, key, dataset, {
            apiName: guardOptions.apiName, credentialProfile: guardOptions.credentialProfile,
            tokenFingerprint: guardOptions.tokenFingerprint,
          });
      }
      if (reason === 'permission_denied') {
        await client.query('COMMIT');
        throw new ExternalCallGuardError('PERMISSION_DENIED', `${guardOptions.budgetSource} ${guardOptions.apiName} 权限策略禁止调用`, key, dataset, {
          apiName: guardOptions.apiName, credentialProfile: guardOptions.credentialProfile,
          tokenFingerprint: guardOptions.tokenFingerprint,
        });
      }
      const dayWait = reason === 'day' || reason === 'credential_day';
      const recoverAt = budget.wait_until || recoverAtFor('BUDGET_WAIT', dayWait ? 'day' : 'minute');
      await client.query('COMMIT');
      throw new ExternalCallGuardError('BUDGET_WAIT',
        `${guardOptions.budgetSource} ${guardOptions.apiName} 已达到${dayWait ? '日' : reason === 'concurrency' ? '并发或间隔' : '分钟'}保护线，等待恢复`,
        key, dataset, {
          apiName: guardOptions.apiName, credentialProfile: guardOptions.credentialProfile,
          tokenFingerprint: guardOptions.tokenFingerprint, recoverAt,
          budgetWindow: dayWait ? 'day' : reason,
        });
    }
    await client.query('COMMIT');
    runCallCount += 1;
    const parts = nowParts();
    const statKey = `${guardOptions.budgetSource}:${guardOptions.apiName}:${guardOptions.tokenFingerprint}`;
    const item = localCount(statKey, parts.day, parts.minute);
    const concurrencySlot = budget.concurrency_slot == null ? null : Number(budget.concurrency_slot);
    if (!providedClient && concurrencySlot != null) {
      await releaseExternalCallSlot(guardOptions.budgetSource, guardOptions.apiName,
        guardOptions.tokenFingerprint, concurrencySlot, client);
    }
    return {
      source: guardOptions.budgetSource, dataset, apiName: guardOptions.apiName,
      credentialProfile: guardOptions.credentialProfile, tokenFingerprint: guardOptions.tokenFingerprint,
      minuteCount: Number(budget.minute_count || item.minuteCount),
      dayCount: Number(budget.day_count || item.dayCount),
      concurrencySlot: providedClient ? concurrencySlot : null,
      timeoutMs: budget.timeout_ms == null ? 30000 : Number(budget.timeout_ms),
      retryPolicy: budget.retry_policy || {}, emptyPolicy: budget.empty_policy || 'preserve_last_success',
      ...(probe || {}),
    };
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

async function releaseExternalCallSlot(source, apiName, fingerprint = 'none', slot = null, providedClient = null) {
  if (slot == null || !Number.isFinite(Number(slot))) return;
  const queryable = providedClient || getPool();
  const lockKey = `external_slot:${budgetSourceKey(source)}:${String(apiName || '*').slice(0, 64)}:${String(fingerprint || 'none')}:${Math.floor(Number(slot))}`;
  await queryable.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [lockKey]).catch(() => {});
}

async function withExternalCallGuard(source, dataset, businessDate, fn, circuitSource = source) {
  const guardOptions = normalizeGuardOptions(source, circuitSource, {}, dataset);
  const localKey = `${guardOptions.budgetSource}:${String(dataset || 'unknown')}:${String(businessDate || nowParts().day).slice(0, 10)}`;
  if (localDatasetLocks.has(localKey)) {
    throw new ExternalCallGuardError('DATASET_LOCKED', '同一数据集正在由其他 Worker 请求中', sourceKey(source), dataset);
  }
  localDatasetLocks.add(localKey);
  try {
    const lock = await acquireExternalDatasetLock(guardOptions.budgetSource, dataset, businessDate);
    let guardResult = null;
    try {
      guardResult = await consumeExternalCall(source, dataset, lock.client, guardOptions.circuitSource, guardOptions);
      const result = await fn(lock.client, guardResult);
      // 恢复探测成功后立即关闭对应熔断；否则下一次同来源请求会继续被旧熔断拦截。
      if (guardResult && guardResult.probeToken) {
        await closeExternalCircuit(
          guardOptions.circuitSource, guardOptions.apiName, guardOptions.tokenFingerprint,
          lock.client, guardResult.probeToken
        );
      }
      return result;
    } catch (error) {
      // 所有使用统一 Guard 的来源都要释放探测租约；不能只依赖 Tushare 自己的 catch。
      // 这样 CNInfo、港交所等通用 HTTP 适配器在网络异常或响应格式错误时也不会留下占用。
      if (guardResult && guardResult.probeToken) {
        await releaseExternalCircuitProbe(
          guardOptions.circuitSource, guardOptions.apiName, guardOptions.tokenFingerprint,
          5000, guardResult.probeToken
        ).catch(() => {});
      }
      throw error;
    } finally {
      await releaseExternalCallSlot(guardOptions.budgetSource, guardOptions.apiName, guardOptions.tokenFingerprint,
        guardResult && guardResult.concurrencySlot, lock.client);
      await releaseExternalDatasetLock(lock);
    }
  } finally {
    localDatasetLocks.delete(localKey);
  }
}

async function openExternalCircuit(source, detail = '', circuitSource = source, options = {}, providedClient = null) {
  const key = sourceKey(source);
  const supplied = circuitSource && typeof circuitSource === 'object' ? circuitSource : options;
  const guardOptions = normalizeGuardOptions(source, circuitSource, supplied, '');
  const code = String(supplied && supplied.errorCode || '').toUpperCase() || 'CIRCUIT_OPEN';
  const errorType = supplied && supplied.errorType || '';
  const recoverAt = supplied && Object.prototype.hasOwnProperty.call(supplied, 'recoverAt')
    ? supplied.recoverAt : recoverAtFor(code);
  const client = providedClient || await getPool().connect();
  try {
    await upsertCircuit(client, key, guardOptions.apiName, guardOptions.tokenFingerprint,
      code, errorType || (code === 'RATE_LIMIT' || code === 'QUOTA_EXHAUSTED' || code === 'BUDGET_WAIT' ? 'rate_limit' : 'circuit_open'), detail, recoverAt);
  } finally {
    if (!providedClient) client.release();
  }
  return { source: key, apiName: circuitApiName(guardOptions.apiName, code), recoverAt };
}

async function closeExternalCircuit(source, apiName, fingerprint = 'none', providedClient = null, probeToken = null) {
  const key = sourceKey(source);
  const queryable = providedClient || getPool();
  await queryable.query(
    `UPDATE ops.external_circuits
        SET state='closed',probe_in_flight=false,probe_owner=NULL,probe_token=NULL,probe_lease_until=NULL,last_success_at=now(),updated_at=now()
      WHERE source=$1 AND api_name=ANY($2::text[]) AND token_fingerprint=$3
        AND ($4::text IS NULL OR probe_token=$4)`,
    [key, [String(apiName || '*').slice(0, 64), '*'], String(fingerprint || 'none'), probeToken]
  );
}

async function releaseExternalCircuitProbe(source, apiName, fingerprint = 'none', retryMs = 5000, probeToken = null) {
  const key = sourceKey(source);
  await getPool().query(
    `UPDATE ops.external_circuits
        SET probe_in_flight=false, probe_owner=NULL, probe_token=NULL, probe_lease_until=NULL,
            recover_at=now() + ($4 * interval '1 millisecond'),
            updated_at=now()
      WHERE source=$1 AND api_name=ANY($2::text[]) AND token_fingerprint=$3
        AND state='open' AND probe_in_flight=true
        AND ($5::text IS NULL OR probe_token=$5)`,
    [key, [String(apiName || '*').slice(0, 64), '*'], String(fingerprint || 'none'), Math.max(Number(retryMs) || 5000, 1000), probeToken]
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
  localDatasetLocks.clear();
  runCallCount = 0;
}

function setExternalCallCount(value) {
  const count = Number(value);
  runCallCount = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

// Python 子进程在退出时通过 stderr 回传累计调用数；父进程合并后，计划实例的
// external_call_count 与跨进程实际请求保持一致，后续子进程也会继承最新累计值。
function mergeExternalCallStats(stats = {}) {
  const total = Number(stats.total);
  if (Number.isFinite(total) && total >= 0) runCallCount = Math.max(runCallCount, Math.floor(total));
  const sourceCounts = stats.sources && typeof stats.sources === 'object' ? stats.sources : {};
  const parts = nowParts();
  Object.entries(sourceCounts).forEach(([source, value]) => {
    const count = Number(value);
    if (!Number.isFinite(count) || count <= 0) return;
    const key = `${source}:child`;
    const item = counters.get(key);
    if (!item || item.day !== parts.day || item.minute !== parts.minute) {
      counters.set(key, { day: parts.day, minute: parts.minute, minuteCount: count, dayCount: count });
      return;
    }
    item.minuteCount += count;
    item.dayCount += count;
  });
}

function mergeExternalCallStatsFromStderr(stderr) {
  const text = String(stderr || '');
  const matches = [...text.matchAll(/\[external-call-stats\]\s+(\{[^\r\n]+\})/g)];
  if (!matches.length) return null;
  try {
    const stats = JSON.parse(matches[matches.length - 1][1]);
    mergeExternalCallStats(stats);
    return stats;
  } catch (_) { return null; }
}

function childProcessEnv(extra = {}) {
  return Object.assign({}, process.env, extra, { JOB_EXTERNAL_CALL_USED: String(getExternalCallStats().total) });
}

async function resetExternalCallGuardPersistence(source = null) {
  const { day } = nowParts();
  if (source) {
    const sourceName = sourceKey(source);
    const budgetSource = budgetSourceKey(sourceName);
    if (sourceName.toLowerCase() === 'tushare_backup') {
      await getPool().query(
        "DELETE FROM ops.external_call_budgets WHERE window_key=$1 AND (source='tushare_backup' OR (source='tushare' AND credential_profile='backup'))",
        [day]
      );
      await getPool().query("DELETE FROM ops.external_circuits WHERE source='tushare_backup' OR source LIKE 'tushare_backup:%'", []);
    } else if (sourceName.toLowerCase() === 'tushare') {
      await getPool().query(
        "DELETE FROM ops.external_call_budgets WHERE window_key=$1 AND (source='tushare' AND credential_profile IN ('primary','legacy'))",
        [day]
      );
      await getPool().query("DELETE FROM ops.external_circuits WHERE source='tushare' OR source LIKE 'tushare:%'", []);
    } else {
      await getPool().query(
        'DELETE FROM ops.external_call_budgets WHERE window_key=$1 AND (source=$2 OR source LIKE $2 || \':%\')',
        [day, sourceName]
      );
      await getPool().query('DELETE FROM ops.external_circuits WHERE source=$1 OR source LIKE $1 || \':%\'', [sourceName]);
    }
    return;
  }
  await getPool().query('DELETE FROM ops.external_call_budgets WHERE window_key=$1', [day]);
  await getPool().query('DELETE FROM ops.external_circuits');
}

function getExternalCallStats() {
  let total = runCallCount;
  const sources = {};
  const endpoints = {};
  for (const [source, item] of counters.entries()) {
    const sourceName = String(source).split(':')[0];
    sources[sourceName] = Number(sources[sourceName] || 0) + Number(item.dayCount || 0);
    endpoints[source] = Number(item.dayCount || 0);
  }
  return { total, sources, endpoints };
}

module.exports = {
  ExternalCallGuardError,
  tokenFingerprint,
  consumeExternalCall,
  withExternalCallGuard,
  openExternalCircuit,
  closeExternalCircuit,
  releaseExternalCircuitProbe,
  releaseExternalCallSlot,
  invalidateExternalCircuits,
  getExternalCircuitStatuses,
  resetExternalCallGuard,
  resetExternalCallGuardPersistence,
  getExternalCallStats,
  setExternalCallCount,
  mergeExternalCallStats,
  mergeExternalCallStatsFromStderr,
  childProcessEnv,
  getExternalBudgetLimits,
  circuitScopeLabel,
};

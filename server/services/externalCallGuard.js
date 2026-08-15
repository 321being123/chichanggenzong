// 外部请求预算、熔断和数据集并发锁。
// 预算状态必须落 PostgreSQL，才能让多个 Worker 共享同一份额度。
let pool = null;
function getPool() {
  if (!pool) pool = require('../db/connection').pool;
  return pool;
}
const counters = new Map();
const circuits = new Map();

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
  constructor(code, message, source, dataset) {
    super(message);
    this.name = 'ExternalCallGuardError';
    this.code = code;
    this.errorType = code === 'RATE_LIMIT' || code === 'QUOTA_EXHAUSTED' ? 'rate_limit'
      : code === 'DATASET_LOCKED' ? 'in_progress' : 'circuit_open';
    this.source = source;
    this.dataset = dataset;
    this.retryable = false;
  }
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

async function consumeExternalCall(source, dataset = '', providedClient = null) {
  const key = sourceKey(source);
  const { minute, day } = nowParts();
  const limits = budgetLimits(key);
  const client = providedClient || await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('external_budget:' || $1))", [key]);
    const dayKey = day;
    const minuteKey = `${day}:${minute}`;
    const { rows: dayRows } = await client.query(
      `SELECT call_count,circuit_open FROM ops.external_call_budgets
        WHERE source=$1 AND window_type='day' AND window_key=$2 FOR UPDATE`, [key, dayKey]
    );
    if (dayRows[0] && dayRows[0].circuit_open) {
      throw new ExternalCallGuardError('CIRCUIT_OPEN', `${key} 数据源今日已熔断，停止自动请求`, key, dataset);
    }
    const { rows: minuteRows } = await client.query(
      `SELECT call_count FROM ops.external_call_budgets
        WHERE source=$1 AND window_type='minute' AND window_key=$2 FOR UPDATE`, [key, minuteKey]
    );
    const dayCount = Number(dayRows[0]?.call_count || 0);
    const minuteCount = Number(minuteRows[0]?.call_count || 0);
    if (minuteCount >= limits.minute) {
      throw new ExternalCallGuardError('RATE_LIMIT', `${key} 已达到每分钟请求预算 ${limits.minute}`, key, dataset);
    }
    if (dayCount >= limits.day) {
      await client.query(
        `INSERT INTO ops.external_call_budgets(source,window_type,window_key,call_count,budget_limit,circuit_open,last_error)
         VALUES($1,'day',$2,$3,$4,true,$5)
         ON CONFLICT(source,window_type,window_key) DO UPDATE SET circuit_open=true,last_error=EXCLUDED.last_error,updated_at=now()`,
        [key, dayKey, dayCount, limits.day, `达到当日请求预算 ${limits.day}`]
      );
      await client.query('COMMIT');
      throw new ExternalCallGuardError('QUOTA_EXHAUSTED', `${key} 已达到当日请求预算 ${limits.day}`, key, dataset);
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

async function withExternalCallGuard(source, dataset, businessDate, fn) {
  const lock = await acquireExternalDatasetLock(source, dataset, businessDate);
  try {
    await consumeExternalCall(source, dataset, lock.client);
    return await fn();
  } finally {
    await releaseExternalDatasetLock(lock);
  }
}

async function openExternalCircuit(source, detail = '') {
  const key = sourceKey(source);
  const { day } = nowParts();
  circuits.set(key, { day });
  const client = await getPool().connect();
  try {
    await client.query(
      `INSERT INTO ops.external_call_budgets(source,window_type,window_key,call_count,budget_limit,circuit_open,last_error)
       VALUES($1,'day',$2,0,$3,true,$4)
       ON CONFLICT(source,window_type,window_key) DO UPDATE SET circuit_open=true,last_error=EXCLUDED.last_error,updated_at=now()`,
      [key, day, budgetLimits(key).day, detail || '上游限流或配额错误']
    );
  } finally {
    client.release();
  }
}

function resetExternalCallGuard() {
  counters.clear();
  circuits.clear();
}

async function resetExternalCallGuardPersistence(source = null) {
  const { day } = nowParts();
  await getPool().query(
    'DELETE FROM ops.external_call_budgets WHERE window_key=$1 AND ($2::text IS NULL OR source=$2)',
    [day, source]
  );
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
  consumeExternalCall,
  withExternalCallGuard,
  openExternalCircuit,
  resetExternalCallGuard,
  resetExternalCallGuardPersistence,
  getExternalCallStats,
};

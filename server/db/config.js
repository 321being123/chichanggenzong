// 本文件由 server/db.js 物理拆分而来，函数体未改动，仅调整文件归属。
const { pool, crypto, fs, path, DATA_DIR, DEFAULT_FEE_SETTINGS } = require('./connection');
const { uid, round, bulkInsert, hashPwd, safeEqual, verifyPwd, hashString } = require('./util');
const { sanitizeJobError, sanitizeJobResult, isSensitiveKey } = require('../services/jobErrorSanitizer');

async function getConfig(key, def) {
  try {
    const { rows } = await pool.query('SELECT value FROM platform_config WHERE key=$1', [key]);
    if (rows.length) return rows[0].value;
  } catch (e) {}
  return def;
}
async function setConfig(key, value) {
  await pool.query(
    'INSERT INTO platform_config (key, value, updated_at) VALUES ($1,$2,now()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()',
    [key, value == null ? '' : String(value)]
  );
}

// ====== 后台：操作审计日志 ======
// 审计模块 → action 前缀（后台筛选用）
const AUDIT_MODULES = {
  user: 'user_',
  broker: 'broker_',
  job: 'job_',
  holiday: 'holiday_',
  model: 'model_',
  settings: 'settings_',
  knowledge: 'ks_',
  feedback: 'feedback_',
  bond: 'bond_',
  market: 'market_',
  benchmark: 'benchmark_',
};
// 参数摘要键名黑名单：任何疑似凭据的字段一律不落库（AUDIT-01 硬性要求）
// 结构化摘要只放开受限白名单：值可以是标量、只含标量的平表对象，或由二者组成的数组；
// 每层最多 20 项、标量统一脱敏并截断到 200 字，不允许任意深度的嵌套对象或整份上游响应。
// 键名黑名单在每一层递归生效，通用敏感信息过滤不因放开结构而失效。
const AUDIT_META_MAX_ITEMS = 20;
function sanitizeAuditScalar(value) {
  if (typeof value === 'string') return sanitizeJobError(value, 200);
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean') return value;
  return undefined;
}
function sanitizeAuditFlatObject(value) {
  const out = {};
  for (const key of Object.keys(value)) {
    if (Object.keys(out).length >= AUDIT_META_MAX_ITEMS) break;
    if (isSensitiveKey(key) || /^(?:cookie|session|set-cookie)$/i.test(key)) continue;
    const safe = sanitizeAuditScalar(value[key]);
    if (safe !== undefined) out[key] = safe;
  }
  return Object.keys(out).length ? out : undefined;
}
function sanitizeAuditValue(value) {
  if (value === null || value === undefined) return undefined;
  const scalar = sanitizeAuditScalar(value);
  if (scalar !== undefined) return scalar;
  if (Array.isArray(value)) {
    const items = [];
    for (const item of value.slice(0, AUDIT_META_MAX_ITEMS)) {
      const safe = sanitizeAuditScalar(item)
        ?? (item && typeof item === 'object' && !Array.isArray(item) ? sanitizeAuditFlatObject(item) : undefined);
      if (safe !== undefined) items.push(safe);
    }
    return items.length ? items : undefined;
  }
  if (typeof value === 'object') return sanitizeAuditFlatObject(value);
  return undefined;
}
function sanitizeAuditMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return {};
  const out = {};
  Object.keys(meta).forEach(function (k) {
    if (isSensitiveKey(k) || /^(?:cookie|session|set-cookie)$/i.test(k)) return;
    const safe = sanitizeAuditValue(meta[k]);
    if (safe !== undefined) out[k] = safe;
  });
  return out;
}

// 对象式审计入口：记录操作者、动作、目标、成功/失败、请求 ID、参数摘要与错误摘要。
// executor 可选：传入事务 client 时，审计与业务状态写入落在同一事务内。
async function auditEvent(evt, executor = null) {
  const e = evt || {};
  const run = typeof executor?.query === 'function'
    ? (sql, params) => executor.query(sql, params)
    : (sql, params) => pool.query(sql, params);
  try {
    await run(
      'INSERT INTO admin_audit_log (actor, action, target, detail, result, request_id, metadata, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,now())',
      [
        e.actor || '', e.action || '', e.target == null ? '' : String(e.target),
        sanitizeJobError(e.detail == null ? '' : e.detail, 500),
        e.result === 'failure' ? 'failure' : 'success',
        e.requestId || '',
        JSON.stringify(sanitizeAuditMeta(e.metadata)),
      ]
    );
  } catch (err) {}
}
// 旧签名保留兼容：等价于一条成功记录
async function auditLog(actor, action, target, detail) {
  return auditEvent({ actor: actor, action: action, target: target, detail: detail });
}
async function listAudit(limit, filter) {
  const lim = Math.min(parseInt(limit, 10) || 50, 200);
  const f = filter || {};
  const where = [];
  const params = [];
  if (f.actor) { params.push('%' + String(f.actor).trim() + '%'); where.push('actor ILIKE $' + params.length); }
  if (f.result === 'success' || f.result === 'failure') { params.push(f.result); where.push('result = $' + params.length); }
  if (f.module && AUDIT_MODULES[f.module]) { params.push(AUDIT_MODULES[f.module] + '%'); where.push('action LIKE $' + params.length); }
  params.push(lim);
  const { rows } = await pool.query(
    'SELECT id, actor, action, target, detail, result, request_id, metadata, ' +
    "to_char(created_at,'YYYY-MM-DD HH24:MI:SS') AS created_at FROM admin_audit_log " +
    (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') +
    'ORDER BY id DESC LIMIT $' + params.length,
    params
  );
  return rows.map(function (row) {
    return {
      ...row,
      detail: sanitizeJobError(row.detail || '', 500),
      metadata: sanitizeJobResult(row.metadata || {}),
    };
  });
}

// ====== 导出 ======
module.exports = {
  getConfig,
  setConfig,
  auditLog,
  auditEvent,
  listAudit,
  sanitizeAuditMeta,
  AUDIT_MODULES,
};

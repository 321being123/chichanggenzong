// 本文件由 server/db.js 物理拆分而来，函数体未改动，仅调整文件归属。
const { pool, crypto, fs, path, DATA_DIR, DEFAULT_FEE_SETTINGS } = require('./connection');
const { uid, round, bulkInsert, hashPwd, safeEqual, verifyPwd, hashString } = require('./util');

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
  bond: 'bond_',
  market: 'market_',
  benchmark: 'benchmark_',
};
// 参数摘要键名黑名单：任何疑似凭据的字段一律不落库（AUDIT-01 硬性要求）
const AUDIT_SENSITIVE_KEY = /pass|pwd|token|secret|api_?key|cookie|auth|code|credential/i;
function sanitizeAuditMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return {};
  const out = {};
  Object.keys(meta).forEach(function (k) {
    if (AUDIT_SENSITIVE_KEY.test(k)) return;
    const v = meta[k];
    if (v === null || v === undefined) return;
    if (typeof v === 'string') out[k] = v.slice(0, 200);
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    // 对象/数组等复杂值不落库，避免误写入完整外部响应或持仓明细
  });
  return out;
}

// 对象式审计入口：记录操作者、动作、目标、成功/失败、请求 ID、参数摘要与错误摘要
async function auditEvent(evt) {
  const e = evt || {};
  try {
    await pool.query(
      'INSERT INTO admin_audit_log (actor, action, target, detail, result, request_id, metadata, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,now())',
      [
        e.actor || '', e.action || '', e.target == null ? '' : String(e.target),
        String(e.detail == null ? '' : e.detail).slice(0, 500),
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
  return rows;
}

// ====== 导出 ======
module.exports = {
  getConfig,
  setConfig,
  auditLog,
  auditEvent,
  listAudit,
  AUDIT_MODULES,
};

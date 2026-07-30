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
async function auditLog(actor, action, target, detail) {
  try {
    await pool.query(
      'INSERT INTO admin_audit_log (actor, action, target, detail, created_at) VALUES ($1,$2,$3,$4,now())',
      [actor || '', action || '', target || '', detail || '']
    );
  } catch (e) {}
}
async function listAudit(limit) {
  const lim = Math.min(parseInt(limit, 10) || 50, 200);
  const { rows } = await pool.query('SELECT id, actor, action, target, detail, to_char(created_at,\'YYYY-MM-DD HH24:MI:SS\') AS created_at FROM admin_audit_log ORDER BY id DESC LIMIT $1', [lim]);
  return rows;
}

// ====== 导出 ======
module.exports = {
  getConfig,
  setConfig,
  auditLog,
  listAudit,
};

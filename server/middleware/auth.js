// ========== 鉴权与账户归属校验中间件 ==========
const asyncHandler = require('./async');
const { loadUser, pool } = require('../db');

function requireLogin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: '未登录' });
  next();
}

// ========== 防暴力破解 ==========
const failMap = new Map();
function checkLocked(key) {
  const f = failMap.get(key);
  if (!f) return false;
  if (f.lockedUntil && Date.now() < f.lockedUntil) return true;
  if (f.lockedUntil && Date.now() >= f.lockedUntil) failMap.delete(key);
  return false;
}
function recordFail(key) {
  const failure = failMap.get(key) || { count: 0, at: Date.now() };
  if (++failure.count >= 5) { failure.lockedUntil = Date.now() + 15 * 60 * 1000; failure.count = 0; }
  failMap.set(key, failure);
}
function clearFail(key) { failMap.delete(key); }
const regIpMap = new Map();
function checkRegLimit(ip) {
  const now = Date.now();
  const last = regIpMap.get(ip);
  if (last && now - last < 60000) return true;
  regIpMap.set(ip, now); return false;
}

// TTL 清理（P1-6）：登录失败 / 注册 IP 的限流 Map 长期不清理会无限增长，定期清除陈旧记录
const MAP_TTL_MS = 60 * 60 * 1000; // 1 小时
function sweepAuthMaps(now = Date.now()) {
  for (const [k, v] of failMap) if (!v.lockedUntil && now - (v.at || 0) > MAP_TTL_MS) failMap.delete(k);
  for (const [k, t] of regIpMap) if (now - t > MAP_TTL_MS) regIpMap.delete(k);
}
if (typeof setInterval === 'function') {
  const sweep = setInterval(sweepAuthMaps, 10 * 60 * 1000);
  if (sweep.unref) sweep.unref();
}

// ========== 账户归属校验：确保被访问的账户属于当前登录用户 ==========
// 所有数据接口都按 (username=会话用户, account_name) 隔离，跨用户读取在结构上已被挡住；
// 此中间件作纵深防御：校验账户名属于本人账户列表，并对历史遗留账户自动补登。
// 2026-08-03 整改（报告 8.3）：账户列表唯一权威来源 = accounts 表（users.accounts JSON 仅兜底，
// 因为 syncUserAccounts 已保证 accounts 表与列表同步；结构化表空≠无权限——新账户/主动清空都合法）。
async function assertOwnership(req, res, next) {
  const username = req.session.user;
  const name = (req.params.name ? decodeURIComponent(req.params.name) : (req.body && req.body.account)) || '';
  if (!name) return next();
  try {
    // 权威来源：accounts 表存在该账户即通过（列表/权限与业务数据同源）
    const acct = await pool.query('SELECT 1 FROM accounts WHERE username=$1 AND account_name=$2', [username, name]);
    if (acct.rowCount > 0) return next();
    // 兼容层：accounts 表尚无记录时（历史遗留），查 users.accounts JSON 列表
    const user = await loadUser(username);
    const accounts = (user && user.accounts) || [];
    if (accounts.includes(name)) return next();
    // 未登记且无账户主记录：拒绝越权访问（不再从 JSON 归档自动补登业务数据——表空是真实状态）
    return res.status(403).json({ error: '无权访问该账户' });
  } catch (e) { next(e); }
}

function isAdminIdentity(username, role) {
  if (!username) return false;
  const admins = (process.env.ADMIN_USERS || '').split(',').map(s => s.trim()).filter(Boolean);
  return role === 'admin' || admins.includes(username);
}

// ========== 管理员鉴权（升级：数据库 role=admin 或 ADMIN_USERS 白名单，兼容旧机制）==========
// 异步安全：所有异常均被吞掉并返回 403，永不向 Express 抛 reject。
async function requireAdmin(req, res, next) {
  const username = req.session && req.session.user;
  if (!username) return res.status(401).json({ error: '未登录' });
  try {
    const { rows } = await pool.query('SELECT role FROM users WHERE username=$1', [username]);
    if (isAdminIdentity(username, rows[0] && rows[0].role)) return next();
  } catch (e) {}
  return res.status(403).json({ error: '无权限：该操作仅限管理员执行' });
}

module.exports = { requireLogin, checkLocked, recordFail, clearFail, checkRegLimit, assertOwnership, requireAdmin, isAdminIdentity, sweepAuthMaps };

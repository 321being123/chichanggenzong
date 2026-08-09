// ========== 鉴权与账户归属校验中间件 ==========
const asyncHandler = require('./async');
const { loadUser, pool } = require('../db');

// 安全销毁会话：兼容测试中的桩 session（无 destroy 方法时不崩溃）
function destroySession(req) {
  try {
    if (req.session && typeof req.session.destroy === 'function') req.session.destroy(() => {});
    else if (req.session) req.session.user = null;
  } catch (e) { /* 忽略销毁异常 */ }
}

// ========== 登录态校验（AUTH-01：统一验证存在/状态/会话版本）==========
// 每次请求校验用户仍存在、状态为 active、会话版本与数据库一致；任一不满足即销毁会话并返回 401/403。
// 校验结果缓存到 req.authUser，供同请求内的 requireAdmin 复用，避免重复查询。
async function resolveSessionUser(req) {
  if (!req.session || !req.session.user) return { status: 401, error: '未登录' };
  const { rows } = await pool.query(
    'SELECT username, role, status, auth_version, permissions FROM users WHERE username=$1',
    [req.session.user]
  );
  const user = rows[0];
  if (!user) { destroySession(req); return { status: 401, error: '账号不存在或已失效' }; }
  if (user.status && user.status !== 'active') {
    destroySession(req);
    return { status: 403, error: '该账号已被禁用，请联系管理员' };
  }
  if (user.auth_version !== req.session.authVersion) {
    destroySession(req);
    return { status: 401, error: '登录态已失效，请重新登录' };
  }
  return { user };
}

async function requireLogin(req, res, next) {
  try {
    const result = await resolveSessionUser(req);
    if (!result.user) return res.status(result.status).json({ error: result.error });
    req.authUser = result.user;
    next();
  } catch (e) { next(e); }
}

// 公开路由可选登录：有效会话获得身份；失效会话被销毁并按游客继续。
async function optionalLogin(req, res, next) {
  if (!req.session || !req.session.user) return next();
  try {
    const result = await resolveSessionUser(req);
    if (result.user) req.authUser = result.user;
    next();
  } catch (e) { next(e); }
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

// ========== 管理员鉴权（升级：数据库 role=admin 或 ADMIN_USERS 白名单 + 状态/版本校验）==========
// 复用 requireLogin 的会话版本与状态校验；管理员账号禁用或降级后立即拒绝。
// 异常安全：所有异常均被吞掉并返回 403/401，永不向 Express 抛 reject。
async function requireAdmin(req, res, next) {
  const username = req.session && req.session.user;
  if (!username) return res.status(401).json({ error: '未登录' });
  try {
    const user = req.authUser
      || (await pool.query('SELECT role, status, auth_version FROM users WHERE username=$1', [username])).rows[0];
    if (!user) { destroySession(req); return res.status(403).json({ error: '无权限：该操作仅限管理员执行' }); }
    if (user.status && user.status !== 'active') { destroySession(req); return res.status(403).json({ error: '该账号已被禁用，请联系管理员' }); }
    if (user.auth_version !== req.session.authVersion) {
      destroySession(req);
      return res.status(401).json({ error: '登录态已失效，请重新登录' });
    }
    if (!isAdminIdentity(username, user.role)) return res.status(403).json({ error: '无权限：该操作仅限管理员执行' });
    req.authUser = user;
    next();
  } catch (e) { next(e); }
}

// ========== 轻量能力权限（PERM-01，P1）==========
// 能力白名单：后端按白名单过滤，绝不允许前端传入任意权限字符串绕过。
const CAPABILITY_WHITELIST = ['knowledge_write', 'content_manage', 'ops_manage', 'user_manage', 'benchmark_publish'];

// 判断用户是否拥有某项能力：管理员（role=admin 或 ADMIN_USERS）拥有全部；普通用户按 permissions 白名单判定。
function hasCapability(user, cap) {
  if (!user) return false;
  if (isAdminIdentity(user.username, user.role)) return true;
  if (CAPABILITY_WHITELIST.indexOf(cap) === -1) return false; // 未知能力一律拒绝
  const perms = (user.permissions && typeof user.permissions === 'object') ? user.permissions : {};
  return !!perms[cap];
}

// 能力校验中间件工厂：先走统一登录态校验，再判定能力。
function requireCapability(cap) {
  return function (req, res, next) {
    const proceed = function () {
      const user = req.authUser;
      if (!user) return res.status(401).json({ error: '未登录' });
      if (!hasCapability(user, cap)) return res.status(403).json({ error: '无权限：需要 ' + cap + ' 能力' });
      next();
    };
    // requireStaff / requireLogin 已设置 req.authUser 时直接复用，避免重复查库
    if (req.authUser) return proceed();
    requireLogin(req, res, proceed);
  };
}

// 后台员工入口：管理员或拥有任一后台能力者可进入后台（具体接口仍需逐项能力校验）。
function requireStaff(req, res, next) {
  requireLogin(req, res, function () {
    const user = req.authUser;
    if (!user) return res.status(401).json({ error: '未登录' });
    if (isAdminIdentity(user.username, user.role)) return next();
    const perms = (user.permissions && typeof user.permissions === 'object') ? user.permissions : {};
    const hasAny = CAPABILITY_WHITELIST.some(function (c) { return perms[c]; });
    if (!hasAny) return res.status(403).json({ error: '无权限：需要管理员或任一后台能力' });
    next();
  });
}

module.exports = { requireLogin, optionalLogin, checkLocked, recordFail, clearFail, checkRegLimit, assertOwnership, requireAdmin, isAdminIdentity, sweepAuthMaps, CAPABILITY_WHITELIST, hasCapability, requireCapability, requireStaff };

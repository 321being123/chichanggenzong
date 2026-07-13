// ========== 鉴权与账户归属校验中间件 ==========
const asyncHandler = require('./async');
const { loadUsers, saveUsers, loadAccountData, pool } = require('../db');

function requireLogin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: '未登录' });
  next();
}

// ========== 防暴力破解 ==========
const failMap = {};
function checkLocked(key) {
  const f = failMap[key];
  if (!f) return false;
  if (f.lockedUntil && Date.now() < f.lockedUntil) return true;
  if (f.lockedUntil && Date.now() >= f.lockedUntil) delete failMap[key];
  return false;
}
function recordFail(key) {
  if (!failMap[key]) failMap[key] = { count: 0 };
  if (++failMap[key].count >= 5) { failMap[key].lockedUntil = Date.now() + 15 * 60 * 1000; failMap[key].count = 0; }
}
function clearFail(key) { delete failMap[key]; }
const regIpMap = {};
function checkRegLimit(ip) {
  const now = Date.now();
  if (regIpMap[ip] && now - regIpMap[ip] < 60000) return true;
  regIpMap[ip] = now; return false;
}

// ========== 账户归属校验：确保被访问的账户属于当前登录用户 ==========
// 所有数据接口都按 (username=会话用户, account_name) 隔离，跨用户读取在结构上已被挡住；
// 此中间件作纵深防御：校验账户名属于本人账户列表，并对历史遗留账户自动补登。
async function assertOwnership(req, res, next) {
  const username = req.session.user;
  const name = (req.params.name ? decodeURIComponent(req.params.name) : (req.body && req.body.account)) || '';
  if (!name) return next();
  try {
    const users = await loadUsers();
    const user = users[username];
    const accounts = (user && user.accounts) || [];
    if (accounts.includes(name)) return next();
    // 未登记：若当前用户确有该账户数据，属历史遗留，自动补登；否则拒绝越权访问
    const data = await loadAccountData(username, name);
    const hasData = data && (
      (data.positions || []).length ||
      (data.trades || []).length ||
      (data.navHistory || []).length ||
      (data.cashFlows || []).length
    );
    if (!hasData) return res.status(403).json({ error: '无权访问该账户' });
    user.accounts.push(name);
    users[username] = user;
    await saveUsers(users);
    return next();
  } catch (e) { next(e); }
}

// ========== 管理员鉴权（升级：数据库 role=admin 或 ADMIN_USERS 白名单，兼容旧机制）==========
// 异步安全：所有异常均被吞掉并返回 403，永不向 Express 抛 reject。
async function requireAdmin(req, res, next) {
  const username = req.session && req.session.user;
  if (!username) return res.status(401).json({ error: '未登录' });
  try {
    const admins = (process.env.ADMIN_USERS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (admins.includes(username)) return next();
    const { rows } = await pool.query('SELECT role FROM users WHERE username=$1', [username]);
    if (rows[0] && rows[0].role === 'admin') return next();
  } catch (e) {}
  return res.status(403).json({ error: '无权限：该操作仅限管理员执行' });
}

module.exports = { requireLogin, checkLocked, recordFail, clearFail, checkRegLimit, assertOwnership, requireAdmin };

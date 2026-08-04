// 本文件由 server/db.js 物理拆分而来，函数体未改动，仅调整文件归属。
const { pool, crypto, fs, path, DATA_DIR, DEFAULT_FEE_SETTINGS } = require('./connection');
const { uid, round, bulkInsert, hashPwd, safeEqual, verifyPwd, hashString } = require('./util');

async function loadUsers() {
  const { rows } = await pool.query('SELECT username, password, accounts FROM users');
  const users = {};
  for (const r of rows) users[r.username] = { password: r.password, accounts: JSON.parse(r.accounts || '[]') };
  return users;
}

// 单用户读取（P1-2）：仅取指定用户，避免普通业务流程读取全量用户名+密码哈希
async function loadUser(username) {
  const { rows } = await pool.query('SELECT username, password, accounts FROM users WHERE username=$1', [username]);
  const r = rows[0];
  if (!r) return null;
  return { password: r.password, accounts: JSON.parse(r.accounts || '[]') };
}

// 原子注册（P1-2）：唯一键冲突即不插入；返回是否新插入（rowCount=1 成功，0 表示已存在）
// 用数据库唯一约束完成判重，并发注册不会互相覆盖快照。
async function registerUser(username, passwordHash, accounts) {
  const r = await pool.query(
    'INSERT INTO users (username, password, accounts) VALUES ($1,$2,$3) ON CONFLICT (username) DO NOTHING',
    [username, passwordHash, JSON.stringify(accounts || [])]
  );
  return r.rowCount === 1;
}

// 单用户账户列表更新（P1-2）：只更新当前用户一行，杜绝全表快照并发覆盖
async function updateUserAccounts(username, accountsList) {
  await pool.query('UPDATE users SET accounts=$2 WHERE username=$1', [username, JSON.stringify(accountsList || [])]);
}

// ====== 用户资料（头像/昵称/简介/邮箱/最后登录）=====

async function getUserProfile(username) {
  const { rows } = await pool.query(
    'SELECT username, nickname, bio, avatar, email, last_login, role, status, knowledge_enabled, permissions, accounts FROM users WHERE username=$1',
    [username]
  );
  const r = rows[0];
  if (!r) return null;
  return {
    username: r.username,
    nickname: r.nickname || '',
    bio: r.bio || '',
    avatar: r.avatar || '',
    email: r.email || '',
    last_login: r.last_login || null,
    role: r.role || 'user',
    status: r.status || 'active',
    knowledgeEnabled: r.knowledge_enabled || false,
    permissions: (r.permissions && typeof r.permissions === 'object') ? r.permissions : {},
    accounts: JSON.parse(r.accounts || '[]')
  };
}

// ====== 登录鉴权（精简记录，含密码/角色/状态/会话版本，避免 loadUsers 全表）======
async function getUserAuth(username) {
  const { rows } = await pool.query(
    'SELECT username, password, role, status, email, auth_version FROM users WHERE username=$1',
    [username]
  );
  return rows[0] || null;
}

async function getUserForPasswordReset(username, email) {
  const { rows } = await pool.query(
    'SELECT username, email, status FROM users WHERE username=$1 AND lower(email)=lower($2)',
    [username, email]
  );
  return rows[0] || null;
}

// ====== 平台管理后台：用户列表/详情/状态/角色/删除 ======
async function countUsers(search) {
  const { rows } = search
    ? await pool.query('SELECT COUNT(*)::int AS c FROM users WHERE username ILIKE $1', ['%' + search + '%'])
    : await pool.query('SELECT COUNT(*)::int AS c FROM users');
  return rows[0].c;
}

async function listUsers({ search, limit, offset }) {
  const params = [];
  let where = '';
  if (search) { params.push('%' + search + '%'); where = 'WHERE username ILIKE $1'; }
  let sql = `SELECT username, role, status, email, created_at, last_login, knowledge_enabled,
      (SELECT COUNT(*) FROM accounts a WHERE a.username = users.username) AS account_count
    FROM users ${where} ORDER BY created_at DESC, username`;
  params.push(limit, offset);
  sql += ` LIMIT $${params.length - 1} OFFSET $${params.length}`;
  const { rows } = await pool.query(sql, params);
  return rows;
}

async function setUserRole(username, role) {
  await pool.query('UPDATE users SET role=$2, auth_version = auth_version + 1 WHERE username=$1', [username, role]);
}
async function setUserStatus(username, status) {
  await pool.query('UPDATE users SET status=$2, auth_version = auth_version + 1 WHERE username=$1', [username, status]);
}
// 知识分享写权限开关
async function setKnowledgeEnabled(username, enabled) {
  await pool.query('UPDATE users SET knowledge_enabled=$2 WHERE username=$1', [username, !!enabled]);
}
async function adminSetPassword(username, newHash) {
  await pool.query('UPDATE users SET password=$2, auth_version = auth_version + 1 WHERE username=$1', [username, newHash]);
}
async function deleteUser(username) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM account_data WHERE username=$1', [username]);
    await client.query('DELETE FROM accounts WHERE username=$1', [username]);
    await client.query('DELETE FROM positions WHERE username=$1', [username]);
    await client.query('DELETE FROM trades WHERE username=$1', [username]);
    await client.query('DELETE FROM nav_history WHERE username=$1', [username]);
    await client.query('DELETE FROM cash_flows WHERE username=$1', [username]);
    await client.query('DELETE FROM daily_prices WHERE username=$1', [username]);
    await client.query('DELETE FROM index_history WHERE username=$1', [username]);
    await client.query('DELETE FROM users WHERE username=$1', [username]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}
async function getUserDetail(username) {
  const { rows: u } = await pool.query(
    'SELECT username, role, status, email, created_at, last_login, nickname, bio, avatar, knowledge_enabled FROM users WHERE username=$1',
    [username]
  );
  if (!u[0]) return null;
  const { rows: accts } = await pool.query(
    'SELECT account_name, broker, cash_base::float8 AS cash_base, hk_rate::float8 AS hk_rate FROM accounts WHERE username=$1 ORDER BY created_at',
    [username]
  );
  return { ...u[0], accounts: accts };
}

// 自动初始化管理员：读 .env 的 ADMIN_USERNAME/ADMIN_PASSWORD，无则跳过；
// 库内无该账号则创建（role=admin，无投资账户），已有则确保为 admin。幂等可重复执行。
async function ensureAdmin() {
  const uname = process.env.ADMIN_USERNAME;
  const pwd = process.env.ADMIN_PASSWORD;
  if (!uname || !pwd) return;
  try {
    const { rows } = await pool.query('SELECT username, role FROM users WHERE username=$1', [uname]);
    if (rows.length === 0) {
      await pool.query(
        "INSERT INTO users (username, password, accounts, role, status, created_at) VALUES ($1,$2,$3,'admin','active',now())",
        [uname, hashPwd(pwd), '[]']
      );
      console.log('[seed] 已创建管理员账号:', uname);
    } else if (rows[0].role !== 'admin') {
      await pool.query("UPDATE users SET role='admin' WHERE username=$1", [uname]);
      console.log('[seed] 已将账号提升为管理员:', uname);
    }
    // 管理员默认拥有知识分享写权限
    await pool.query('UPDATE users SET knowledge_enabled=true WHERE username=$1', [uname]);
    // 首次部署时默认分类早于管理员账号创建，补齐这些无归属的历史分类。
    await pool.query('UPDATE article_categories SET owner_username=$1 WHERE owner_username IS NULL', [uname]);
  } catch (e) { console.warn('[seed] 管理员初始化跳过:', e.message); }
}

async function updateUserProfile(username, fields) {
  const sets = [];
  const vals = [username];
  let i = 2;
  if (fields.nickname !== undefined) { sets.push('nickname=$' + (i++)); vals.push(fields.nickname); }
  if (fields.bio !== undefined) { sets.push('bio=$' + (i++)); vals.push(fields.bio); }
  if (fields.avatar !== undefined) { sets.push('avatar=$' + (i++)); vals.push(fields.avatar); }
  if (fields.email !== undefined) { sets.push('email=$' + (i++)); vals.push(fields.email); }
  if (sets.length === 0) return;
  await pool.query('UPDATE users SET ' + sets.join(', ') + ' WHERE username=$1', vals);
}

// 改密（本人修改 / 找回密码）：递增 auth_version，使其他设备的旧 Session 立即失效。
async function changePassword(username, newHash) {
  await pool.query('UPDATE users SET password=$2, auth_version = auth_version + 1 WHERE username=$1', [username, newHash]);
}
// 仅更新哈希、不递增 auth_version：用于登录时旧哈希格式的透明升级，
// 避免"刚登录成功的会话"因版本号变化被误判为过期（AUTH-01 第 8 条）。
async function upgradePasswordHash(username, newHash) {
  await pool.query('UPDATE users SET password=$2 WHERE username=$1', [username, newHash]);
}

async function updateLastLogin(username) {
  await pool.query('UPDATE users SET last_login=now() WHERE username=$1', [username]);
}

// ====== 密码 ======

module.exports = {
  loadUsers,
  loadUser,
  registerUser,
  updateUserAccounts,
  getUserProfile,
  getUserAuth,
  getUserForPasswordReset,
  countUsers,
  listUsers,
  setUserRole,
  setUserStatus,
  setKnowledgeEnabled,
  adminSetPassword,
  deleteUser,
  getUserDetail,
  ensureAdmin,
  updateUserProfile,
  changePassword,
  upgradePasswordHash,
  updateLastLogin,
};

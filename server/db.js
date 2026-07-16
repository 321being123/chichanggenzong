// ========== 数据库层 (PostgreSQL) ==========
require('dotenv').config();   // 部署时读取项目根 .env（DATABASE_URL / PG* 等）
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Pool } = require('pg');
// 平台费率默认值的单一真相源（与前端 core-fees.js 保持一致，后端 /api/fees 用其补全6组）
const { DEFAULT_FEE_SETTINGS } = require('../public/shared/core-fees');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// 连接配置：优先 DATABASE_URL，否则用 PG* 环境变量（默认值指向本地 Postgres）
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
    })
  : new Pool({
      host: process.env.PGHOST || 'localhost',
      port: parseInt(process.env.PGPORT || '5432', 10),
      user: process.env.PGUSER || 'postgres',
      password: process.env.PGPASSWORD || '',
      database: process.env.PGDATABASE || 'portfolio',
      max: 10,
    });

// 首次启动自动建表（PostgreSQL，ACID 天然保证；double precision 用于金额/净值字段）
async function migration001Init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      password TEXT NOT NULL,
      accounts TEXT NOT NULL DEFAULT '[]'
    );
    -- 用户资料列（头像/昵称/简介/邮箱/最后登录），幂等补齐，可重复执行
    ALTER TABLE users ADD COLUMN IF NOT EXISTS nickname text;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS bio text;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar text;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email text;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login timestamptz;
    -- 平台管理后台：用户角色/状态/注册时间（默认普通用户、正常状态）
    ALTER TABLE users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'user';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
    CREATE TABLE IF NOT EXISTS account_data (
      username TEXT NOT NULL,
      account_name TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
      PRIMARY KEY (username, account_name)
    );
    CREATE TABLE IF NOT EXISTS positions (
      id TEXT NOT NULL,
      username TEXT NOT NULL,
      account_name TEXT NOT NULL,
      code TEXT NOT NULL DEFAULT '',
      name TEXT DEFAULT '',
      price double precision DEFAULT 0,
      quantity double precision DEFAULT 0,
      cost double precision DEFAULT 0,
      type TEXT DEFAULT '',
      subtype TEXT DEFAULT '',
      note TEXT DEFAULT '',
      PRIMARY KEY (id, username, account_name)
    );
    CREATE TABLE IF NOT EXISTS trades (
      id TEXT NOT NULL,
      username TEXT NOT NULL,
      account_name TEXT NOT NULL,
      date TEXT DEFAULT '',
      created_at TEXT DEFAULT '',
      code TEXT DEFAULT '',
      name TEXT DEFAULT '',
      direction TEXT DEFAULT 'buy',
      price double precision DEFAULT 0,
      quantity double precision DEFAULT 0,
      amount double precision DEFAULT 0,
      type TEXT DEFAULT '',
      subtype TEXT DEFAULT '',
      note TEXT DEFAULT '',
      PRIMARY KEY (id, username, account_name)
    );
    CREATE TABLE IF NOT EXISTS nav_history (
      username TEXT NOT NULL,
      account_name TEXT NOT NULL,
      date TEXT NOT NULL,
      nav double precision DEFAULT 1.0,
      total_asset double precision DEFAULT 0,
      invested double precision DEFAULT NULL,
      PRIMARY KEY (username, account_name, date)
    );
    CREATE TABLE IF NOT EXISTS cash_flows (
      id TEXT NOT NULL,
      username TEXT NOT NULL,
      account_name TEXT NOT NULL,
      date TEXT DEFAULT '',
      created_at TEXT DEFAULT '',
      amount double precision DEFAULT 0,
      note TEXT DEFAULT '',
      PRIMARY KEY (id, username, account_name)
    );
    CREATE TABLE IF NOT EXISTS daily_prices (
      username TEXT NOT NULL,
      account_name TEXT NOT NULL,
      date TEXT NOT NULL,
      code TEXT NOT NULL,
      name TEXT DEFAULT '',
      price double precision DEFAULT 0,
      PRIMARY KEY (username, account_name, date, code)
    );
    CREATE TABLE IF NOT EXISTS index_history (
      username TEXT NOT NULL,
      account_name TEXT NOT NULL,
      date TEXT NOT NULL,
      name TEXT NOT NULL,
      close double precision DEFAULT 0,
      PRIMARY KEY (username, account_name, date, name)
    );
  `);
  // 旧库已存在 nav_history（无 invested 列）时补列；幂等，可重复执行
  await pool.query('ALTER TABLE nav_history ADD COLUMN IF NOT EXISTS invested double precision DEFAULT NULL');
  // 乐观锁版本号：每次整包保存自增；并发保存靠条件更新检测到冲突（默认 0，旧数据不受影响）
  await pool.query('ALTER TABLE account_data ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0');

  // ===== P2-4：金额/价格/净值由 double precision 改为 numeric(p,s)，消除浮点累计误差 =====
  // 旧列为 double，USING 表达式可无损转换；重复执行幂等（已是 numeric 则 no-op）
  const numericAlters = [
    'ALTER TABLE positions ALTER COLUMN price TYPE numeric(20,4) USING price::numeric(20,4)',
    'ALTER TABLE positions ALTER COLUMN quantity TYPE numeric(20,4) USING quantity::numeric(20,4)',
    'ALTER TABLE positions ALTER COLUMN cost TYPE numeric(20,4) USING cost::numeric(20,4)',
    'ALTER TABLE trades ALTER COLUMN price TYPE numeric(20,4) USING price::numeric(20,4)',
    'ALTER TABLE trades ALTER COLUMN quantity TYPE numeric(20,4) USING quantity::numeric(20,4)',
    'ALTER TABLE trades ALTER COLUMN amount TYPE numeric(20,4) USING amount::numeric(20,4)',
    'ALTER TABLE nav_history ALTER COLUMN nav TYPE numeric(30,6) USING nav::numeric(30,6)',
    'ALTER TABLE nav_history ALTER COLUMN total_asset TYPE numeric(20,2) USING total_asset::numeric(20,2)',
    'ALTER TABLE nav_history ALTER COLUMN invested TYPE numeric(20,2) USING invested::numeric(20,2)',
    'ALTER TABLE cash_flows ALTER COLUMN amount TYPE numeric(20,2) USING amount::numeric(20,2)',
    'ALTER TABLE daily_prices ALTER COLUMN price TYPE numeric(20,4) USING price::numeric(20,4)',
    'ALTER TABLE index_history ALTER COLUMN close TYPE numeric(20,4) USING close::numeric(20,4)'
  ];
  for (const sql of numericAlters) {
    try { await pool.query(sql); } catch (e) { console.warn('[schema] numeric 转换跳过:', e.message); }
  }

  // ===== 费用列：trades 增加 commission/stamp_tax/transfer_fee/other_fee =====
  const feeAlters = [
    'ALTER TABLE trades ADD COLUMN IF NOT EXISTS commission numeric(20,4) DEFAULT 0',
    'ALTER TABLE trades ADD COLUMN IF NOT EXISTS stamp_tax numeric(20,4) DEFAULT 0',
    'ALTER TABLE trades ADD COLUMN IF NOT EXISTS transfer_fee numeric(20,4) DEFAULT 0',
    'ALTER TABLE trades ADD COLUMN IF NOT EXISTS other_fee numeric(20,4) DEFAULT 0'
  ];
  for (const sql of feeAlters) {
    try { await pool.query(sql); } catch (e) { console.warn('[schema] 费用列跳过:', e.message); }
  }

  // ===== 券商字段：accounts 表补 broker 列（已存在则幂等跳过）=====
  try { await pool.query('ALTER TABLE accounts ADD COLUMN IF NOT EXISTS broker TEXT NOT NULL DEFAULT \'other\''); } catch (e) { console.warn('[schema] broker 列跳过:', e.message); }

  // ===== P2-3：账户元数据表（cash_base/hk_rate 结构化，FK 指向 users）=====
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL REFERENCES users(username),
      account_name TEXT NOT NULL,
      broker TEXT NOT NULL DEFAULT 'other',
      cash_base numeric(20,2) NOT NULL DEFAULT 0,
      hk_rate numeric(10,6) NOT NULL DEFAULT 0.868,
      version INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
      updated_at TEXT DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
      UNIQUE (username, account_name)
    );
  `);

  // ===== 券商字典表：A股/港股/美股券商清单（市场用 market 区分，方便日后扩展）=====
  await pool.query(`
    CREATE TABLE IF NOT EXISTS brokers (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      market TEXT NOT NULL DEFAULT 'A',
      sort_order INTEGER NOT NULL DEFAULT 0,
      import_unit TEXT NOT NULL DEFAULT 'sheet'
    );
  `);
  // 兼容已存在表：补齐 import_unit 列（导入持仓时数量按「手」还是「张」换算的依据）
  await pool.query("ALTER TABLE brokers ADD COLUMN IF NOT EXISTS import_unit TEXT NOT NULL DEFAULT 'sheet'");
  await seedBrokers();

  // ===== P2-5：任务执行记录表（worker 幂等锁 + 执行历史 + 告警依据）=====
  await pool.query(`
    CREATE TABLE IF NOT EXISTS job_runs (
      id SERIAL PRIMARY KEY,
      job TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      started_at TIMESTAMPTZ DEFAULT now(),
      finished_at TIMESTAMPTZ,
      detail TEXT DEFAULT ''
    );
  `);
  // 兼容早期残留表（缺 locked_until 列）：补齐，保证幂等可重复执行
  await pool.query('ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ');

  // ===== 后台：平台配置（注册开关/邀请码/邮箱验证等，DB 优先于 env）=====
  await pool.query(`
    CREATE TABLE IF NOT EXISTS platform_config (
      key TEXT PRIMARY KEY,
      value TEXT DEFAULT '',
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  // ===== 后台：平台公告 =====
  await pool.query(`
    CREATE TABLE IF NOT EXISTS announcements (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      content TEXT DEFAULT '',
      pinned BOOLEAN NOT NULL DEFAULT false,
      published_at TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  // ===== 后台：操作审计日志 =====
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id SERIAL PRIMARY KEY,
      actor TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL DEFAULT '',
      target TEXT NOT NULL DEFAULT '',
      detail TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  // 账户元数据表幂等迁移（从旧 users.accounts JSON + account_data JSON 填充，不覆盖已有）
  await migrateAccountsTable();
}

// ====== 版本化迁移机制（P2-3）======
// 记录已执行的升级步骤，避免每次启动重复跑大量 ALTER
async function ensureMigrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT now()
    );
  `);
}

// 执行单个迁移步骤；单步失败记录日志，下次启动会重试（SQL 均幂等可重跑）
async function runMigration(up, version) {
  try {
    await up();
    await pool.query('INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING', [version]);
  } catch (e) {
    console.warn('[migrate] 步骤', version, '执行失败，下次启动将重试:', e.message);
    throw e;
  }
}

// 已登记的升级步骤（按数组顺序执行；新增表/字段时追加 002、003… 步骤，勿往 001 堆 SQL）
const MIGRATIONS = [
  { version: '001_init', up: migration001Init },
];

// 版本化迁移执行器：只跑 schema_migrations 里没有记录过的步骤
async function runMigrations() {
  await ensureMigrationsTable();
  const { rows } = await pool.query('SELECT version FROM schema_migrations');
  const applied = new Set(rows.map(r => r.version));
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    console.log('[migrate] 执行升级步骤', m.version);
    await runMigration(m.up, m.version);
  }
}

// 兼容旧调用点（server/app.js、server/worker.js、test-integration.js）：语义不变，改走版本化迁移
async function initSchema() {
  await runMigrations();
}

// ====== 迁移（仅本地遗留 JSON 文件时触发；云上全新部署一般为空，不会执行） ======

async function migrateFromJson() {
  const usersPath = path.join(DATA_DIR, '__users__.json');
  if (!fs.existsSync(usersPath)) return;
  const { rows } = await pool.query('SELECT COUNT(*)::int AS cnt FROM users');
  if (rows[0].cnt > 0) return;
  try {
    const users = JSON.parse(fs.readFileSync(usersPath, 'utf-8'));
    for (const [u, v] of Object.entries(users)) {
      await pool.query(
        'INSERT INTO users (username, password, accounts) VALUES ($1,$2,$3) ON CONFLICT (username) DO NOTHING',
        [u, v.password, JSON.stringify(v.accounts || [])]
      );
      for (const acct of (v.accounts || [])) {
        const fp = path.join(DATA_DIR, `${u.replace(/[^a-zA-Z0-9@._-]/g, '_')}__${acct.replace(/[^a-zA-Z0-9一-龥_-]/g, '_')}.json`);
        try {
          const d = JSON.parse(fs.readFileSync(fp, 'utf-8'));
          await pool.query(
            'INSERT INTO account_data (username, account_name, data) VALUES ($1,$2,$3) ON CONFLICT (username, account_name) DO NOTHING',
            [u, acct, JSON.stringify(d)]
          );
        } catch (e) {}
      }
    }
    const bakDir = path.join(DATA_DIR, 'json_backup_' + Date.now());
    fs.mkdirSync(bakDir, { recursive: true });
    for (const f of fs.readdirSync(DATA_DIR)) {
      if (f.endsWith('.json') && f !== '__users__.json' && !f.startsWith('json_backup')) {
        try { fs.cpSync(path.join(DATA_DIR, f), path.join(bakDir, f)); } catch (e) {}
      }
    }
    console.log('已从 JSON 迁移到数据库');
  } catch (e) { console.error('JSON 迁移失败:', e.message); }
}

async function migrateToStructured() {
  const { rows } = await pool.query('SELECT username, account_name, data FROM account_data');
  if (rows.length === 0) return;
  for (const r of rows) {
    let d;
    try { d = JSON.parse(r.data); } catch (e) { continue; }
    try {
      for (const p of (d.positions || [])) {
        await pool.query(
          'INSERT INTO positions (id, username, account_name, code, name, price, quantity, cost, type, subtype, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id, username, account_name) DO NOTHING',
          [p.id, r.username, r.account_name, p.code || '', p.name || '', p.price || 0, p.quantity || 0, p.cost || 0, p.type || '', p.subtype || '', p.note || '']
        );
      }
      for (const t of (d.trades || [])) {
        await pool.query(
          'INSERT INTO trades (id, username, account_name, date, created_at, code, name, direction, price, quantity, amount, type, subtype, note, commission, stamp_tax, transfer_fee, other_fee) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) ON CONFLICT (id, username, account_name) DO NOTHING',
          [t.id, r.username, r.account_name, t.date || '', t.created_at || '', t.code || '', t.name || '', t.direction || 'buy', t.price || 0, t.quantity || 0, t.amount || 0, t.type || '', t.subtype || '', t.note || '', t.commission || 0, t.stamp_tax || 0, t.transfer_fee || 0, t.other_fee || 0]
        );
      }
      for (const n of (d.navHistory || [])) {
        await pool.query(
          'INSERT INTO nav_history (username, account_name, date, nav, total_asset, invested) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (username, account_name, date) DO NOTHING',
          [r.username, r.account_name, n.date || '', n.nav || 1.0, n.totalAsset || 0, (n.invested == null ? null : n.invested)]
        );
      }
      for (const c of (d.cashFlows || [])) {
        await pool.query(
          'INSERT INTO cash_flows (id, username, account_name, date, created_at, amount, note) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id, username, account_name) DO NOTHING',
          [c.id || uid(), r.username, r.account_name, c.date || '', c.created_at || '', c.amount || 0, c.note || '']
        );
      }
    } catch (e) { console.error('迁移账户失败 ' + r.username + '/' + r.account_name + ':', e.message); }
  }
  console.log('已按需合并 JSON → 结构化表（幂等，不覆盖已有记录）');
}

// ====== 用户 ======

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
    'SELECT username, nickname, bio, avatar, email, last_login, role, status, accounts FROM users WHERE username=$1',
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
    accounts: JSON.parse(r.accounts || '[]')
  };
}

// ====== 登录鉴权（精简记录，含密码/角色/状态，避免 loadUsers 全表）======
async function getUserAuth(username) {
  const { rows } = await pool.query(
    'SELECT username, password, role, status, email FROM users WHERE username=$1',
    [username]
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
  let sql = `SELECT username, role, status, email, created_at, last_login,
      (SELECT COUNT(*) FROM accounts a WHERE a.username = users.username) AS account_count
    FROM users ${where} ORDER BY created_at DESC, username`;
  params.push(limit, offset);
  sql += ` LIMIT $${params.length - 1} OFFSET $${params.length}`;
  const { rows } = await pool.query(sql, params);
  return rows;
}

async function setUserRole(username, role) {
  await pool.query('UPDATE users SET role=$2 WHERE username=$1', [username, role]);
}
async function setUserStatus(username, status) {
  await pool.query('UPDATE users SET status=$2 WHERE username=$1', [username, status]);
}
async function adminSetPassword(username, newHash) {
  await pool.query('UPDATE users SET password=$2 WHERE username=$1', [username, newHash]);
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
    'SELECT username, role, status, email, created_at, last_login, nickname, bio, avatar FROM users WHERE username=$1',
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

async function changePassword(username, newHash) {
  await pool.query('UPDATE users SET password=$2 WHERE username=$1', [username, newHash]);
}

async function updateLastLogin(username) {
  await pool.query('UPDATE users SET last_login=now() WHERE username=$1', [username]);
}

// ====== 密码 ======

function hashPwd(pwd) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.pbkdf2Sync(pwd, salt, 10000, 32, 'sha512').toString('hex');
}

// 时序安全比较：避免被计时攻击猜出哈希（P1-1）
function safeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function verifyPwd(pwd, stored) {
  if (!stored.includes(':')) return safeEqual(crypto.createHash('sha256').update(pwd).digest('hex').slice(0, 16), stored);
  const [salt, hash] = stored.split(':');
  const computed = crypto.pbkdf2Sync(pwd, salt, 10000, 32, 'sha512').toString('hex');
  return safeEqual(computed, hash);
}

// ====== 账户数据 ======

function uid() {
  return Date.now().toString(16) + Math.floor(Math.random() * 0x100000000).toString(16);
}

// 金额按精度四舍五入（P2-4：写入 numeric 前列，杜绝浮点尾差入库）
function round(x, d) {
  const n = Number(x);
  if (!isFinite(n)) return 0;
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

async function loadAccountData(username, accountName) {
  const { rows: positions } = await pool.query(
    'SELECT id, code, name, price::float8 AS price, quantity::float8 AS quantity, cost::float8 AS cost, type, subtype, note FROM positions WHERE username=$1 AND account_name=$2',
    [username, accountName]
  );
  const { rows: trades } = await pool.query(
    'SELECT id, date, created_at, code, name, direction, price::float8 AS price, quantity::float8 AS quantity, amount::float8 AS amount, type, subtype, note, commission::float8 AS commission, stamp_tax::float8 AS stamp_tax, transfer_fee::float8 AS transfer_fee, other_fee::float8 AS other_fee FROM trades WHERE username=$1 AND account_name=$2',
    [username, accountName]
  );
  const { rows: navHistory } = await pool.query(
    'SELECT date, nav::float8 AS nav, total_asset::float8 AS "totalAsset", invested::float8 AS invested FROM nav_history WHERE username=$1 AND account_name=$2 ORDER BY date',
    [username, accountName]
  );
  const { rows: cashFlows } = await pool.query(
    'SELECT id, date, created_at, amount::float8 AS amount, note FROM cash_flows WHERE username=$1 AND account_name=$2',
    [username, accountName]
  );
  var result = { positions, trades, navHistory, cashFlows, cash: 0, hkRate: 0.868, cashBase: 0 };
  // 从 account_data JSON 恢复 totalAsset / cashBase（cashBase=期初本金基准，cash 仅作兜底）
  let jsonData = null;
  try {
    const { rows } = await pool.query('SELECT data, version FROM account_data WHERE username=$1 AND account_name=$2', [username, accountName]);
    if (rows[0]) {
      const d = JSON.parse(rows[0].data);
      jsonData = d;
      if (d.totalAsset) result.totalAsset = d.totalAsset;
      if (typeof d.cashBase === 'number') result.cashBase = d.cashBase;
      if (typeof d.cash === 'number') result.cash = d.cash;
      if (Array.isArray(d.fundRecord)) result.fundRecord = d.fundRecord;
      if (typeof rows[0].version === 'number') result.version = rows[0].version;
    }
  } catch (e) {}
  // P2-3：账户元数据优先读结构化 accounts 表（cash_base/hk_rate），JSON 仅作兜底
  try {
    const { rows: am } = await pool.query(
      'SELECT cash_base::float8 AS cash_base, hk_rate::float8 AS hk_rate FROM accounts WHERE username=$1 AND account_name=$2',
      [username, accountName]
    );
    if (am[0]) {
      if (typeof am[0].cash_base === 'number') result.cashBase = am[0].cash_base;
      if (typeof am[0].hk_rate === 'number' && am[0].hk_rate > 0) result.hkRate = am[0].hk_rate;
    }
  } catch (e) {}
  // 指数历史：优先读独立表；表为空则用旧 JSON 快照并一次性迁移进表（消除 JSON 读写放大）
  const tableIndex = await loadIndexPoints(username, accountName);
  if (tableIndex.length > 0) {
    result.indexHistory = tableIndex;
  } else if (jsonData && Array.isArray(jsonData.indexHistory) && jsonData.indexHistory.length > 0) {
    result.indexHistory = jsonData.indexHistory;
    try { await upsertIndexPoints(username, accountName, jsonData.indexHistory); } catch (e) {}
  } else {
    result.indexHistory = [];
  }
  if (positions.length === 0 && trades.length === 0 && navHistory.length === 0 && cashFlows.length === 0) {
    const { rows } = await pool.query('SELECT data, version FROM account_data WHERE username=$1 AND account_name=$2', [username, accountName]);
    if (rows[0]) {
      try {
        const d = JSON.parse(rows[0].data);
        result = { ...d, positions: d.positions || [], trades: d.trades || [], navHistory: d.navHistory || [], cashFlows: d.cashFlows || [] };
        if (typeof rows[0].version === 'number') result.version = rows[0].version;
      } catch (e) {}
    }
  }
  // 现金自动重算：现金 = 期初本金(cashBase) + 现金流净额 + 交易净额(买入减/卖出加)
  const cfNet = (result.cashFlows || []).reduce((s, c) => s + (c.amount || 0), 0);
  // 交易净额：买入 -(成交额+费用)，卖出 +(成交额-费用)；费用从 trades 表读取
  const tradeNet = (result.trades || []).reduce((s, t) => {
    const fee = (t.commission || 0) + (t.stamp_tax || 0) + (t.transfer_fee || 0) + (t.other_fee || 0);
    return s + (t.direction === 'buy' ? -(t.amount || 0) - fee : (t.amount || 0) - fee);
  }, 0);
  result.cash = (result.cashBase || 0) + cfNet + tradeNet;
  return result;
}

// 单连接事务：DELETE+INSERT 全成功或全回滚，避免中途异常留下半成品数据
// expectedVersion：前端带回加载时的版本号（乐观锁）；为 null 时不强制（兼容旧客户端/测试）
async function saveAccountData(username, accountName, data, expectedVersion = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // positions
    await client.query('DELETE FROM positions WHERE username=$1 AND account_name=$2', [username, accountName]);
    for (const p of (data.positions || [])) {
      await client.query(
        'INSERT INTO positions (id, username, account_name, code, name, price, quantity, cost, type, subtype, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [p.id, username, accountName, p.code || '', p.name || '', round(p.price, 4), round(p.quantity, 4), round(p.cost, 4), p.type || '', p.subtype || '', p.note || '']
      );
    }
    // trades
    await client.query('DELETE FROM trades WHERE username=$1 AND account_name=$2', [username, accountName]);
    for (const t of (data.trades || [])) {
      await client.query(
        'INSERT INTO trades (id, username, account_name, date, created_at, code, name, direction, price, quantity, amount, type, subtype, note, commission, stamp_tax, transfer_fee, other_fee) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)',
        [t.id, username, accountName, t.date || '', t.created_at || '', t.code || '', t.name || '', t.direction || 'buy', round(t.price, 4), round(t.quantity, 4), round(t.amount, 4), t.type || '', t.subtype || '', t.note || '', round(t.commission, 4), round(t.stamp_tax, 4), round(t.transfer_fee, 4), round(t.other_fee, 4)]
      );
    }
    // nav_history
    await client.query('DELETE FROM nav_history WHERE username=$1 AND account_name=$2', [username, accountName]);
    for (const n of (data.navHistory || [])) {
      await client.query(
        'INSERT INTO nav_history (username, account_name, date, nav, total_asset, invested) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (username, account_name, date) DO UPDATE SET nav = EXCLUDED.nav, total_asset = EXCLUDED.total_asset, invested = EXCLUDED.invested',
        [username, accountName, n.date || '', round(n.nav, 6), round(n.totalAsset, 2), (n.invested == null ? null : round(n.invested, 2))]
      );
    }
    // cash_flows
    await client.query('DELETE FROM cash_flows WHERE username=$1 AND account_name=$2', [username, accountName]);
    for (const c of (data.cashFlows || [])) {
      await client.query(
        'INSERT INTO cash_flows (id, username, account_name, date, created_at, amount, note) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [c.id || uid(), username, accountName, c.date || '', c.created_at || '', round(c.amount, 2), c.note || '']
      );
    }
    // account_data：仅显式挑选允许的顶层字段写入（杜绝未知字段持久化，满足 schema 白名单）；
    // indexHistory 已独立成表、changes/version 为瞬时字段，均不写入 JSON。
    const { positions, trades, navHistory, cashFlows, cash, hkRate, cashBase, totalAsset, fundRecord } = data;
    const dataForJson = { positions, trades, navHistory, cashFlows, cash, hkRate, cashBase, totalAsset, fundRecord };
    const json = JSON.stringify(dataForJson);
    // 乐观锁（P1-3）：version 必填且已在路由层校验为整数；冲突（已被其他设备修改）抛 conflict 错误由路由返回 409。
    // 不再保留 expectedVersion==null 的绕过路径，杜绝乐观锁被静默跳过。
    const up = await client.query(
      'UPDATE account_data SET data=$3, updated_at=to_char(now(),\'YYYY-MM-DD HH24:MI:SS\'), version=version+1 WHERE username=$1 AND account_name=$2 AND version=$4',
      [username, accountName, json, expectedVersion]
    );
    if (up.rowCount === 0) {
      const ex = await client.query('SELECT 1 FROM account_data WHERE username=$1 AND account_name=$2', [username, accountName]);
      if (ex.rowCount > 0) throw Object.assign(new Error('数据已在其他位置被修改，请刷新页面后重试'), { conflict: true });
      // 新账户首次保存：行尚不存在，插入初版（前端首存带 version=0，UPDATE 命中 0 行后走此分支）
      await client.query(
        'INSERT INTO account_data (username, account_name, data, version, updated_at) VALUES ($1,$2,$3,1,to_char(now(),\'YYYY-MM-DD HH24:MI:SS\')) ON CONFLICT (username, account_name) DO UPDATE SET data=EXCLUDED.data, updated_at=EXCLUDED.updated_at, version=account_data.version+1',
        [username, accountName, json]
      );
    }
    // P2-3：账户元数据（cash_base/hk_rate）结构化落库，作为权威来源（JSON 仅兜底）
    const acctId = crypto.createHash('sha256').update(username + '\n' + accountName).digest('hex');
    await client.query(
      'INSERT INTO accounts (id, username, account_name, cash_base, hk_rate, version, updated_at) VALUES ($1,$2,$3,$4,$5,1,to_char(now(),\'YYYY-MM-DD HH24:MI:SS\')) ON CONFLICT (username, account_name) DO UPDATE SET cash_base=EXCLUDED.cash_base, hk_rate=EXCLUDED.hk_rate, version=accounts.version+1, updated_at=EXCLUDED.updated_at',
      [acctId, username, accountName, round(data.cashBase || 0, 2), round(data.hkRate || 0.868, 6)]
    );
    const { rows: vr } = await client.query('SELECT version FROM account_data WHERE username=$1 AND account_name=$2', [username, accountName]);
    await client.query('COMMIT');
    return vr[0] ? vr[0].version : 1; // 返回新版本号，供前端更新乐观锁基准
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ====== 每日收盘价 ======

async function saveDailyPrices(username, accountName, date, prices) {
  for (const p of prices) {
    await pool.query(
      'INSERT INTO daily_prices (username, account_name, date, code, name, price) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (username, account_name, date, code) DO UPDATE SET name = EXCLUDED.name, price = EXCLUDED.price',
      [username, accountName, date, p.code, p.name || '', round(p.price, 4)]
    );
  }
}

async function loadDailyPrices(username, accountName, date) {
  const { rows } = await pool.query(
    'SELECT code, name, price::float8 AS price FROM daily_prices WHERE username=$1 AND account_name=$2 AND date=$3',
    [username, accountName, date]
  );
  return rows;
}

// 幂等写入单条净值快照（回填/重算用）：冲突则覆盖 nav / total_asset / invested
async function upsertNav(username, accountName, rec) {
  await pool.query(
    'INSERT INTO nav_history (username, account_name, date, nav, total_asset, invested) VALUES ($1,$2,$3,$4,$5,$6) ' +
    'ON CONFLICT (username, account_name, date) DO UPDATE SET nav = EXCLUDED.nav, total_asset = EXCLUDED.total_asset, invested = EXCLUDED.invested',
    [username, accountName, rec.date, round(rec.nav, 6), round(rec.totalAsset, 2), (rec.invested == null ? null : round(rec.invested, 2))]
  );
}

// ====== 指数历史（独立表，增量 upsert，避免 JSON 读写放大） ======

async function upsertIndexPoints(username, accountName, points) {
  for (const p of (points || [])) {
    if (!p || !p.date || !p.name) continue;
    await pool.query(
      'INSERT INTO index_history (username, account_name, date, name, close) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (username, account_name, date, name) DO UPDATE SET close = EXCLUDED.close',
      [username, accountName, p.date, p.name, p.close || 0]
    );
  }
}

async function loadIndexPoints(username, accountName) {
  const { rows } = await pool.query(
    'SELECT date, name, close::float8 AS close FROM index_history WHERE username=$1 AND account_name=$2 ORDER BY date',
    [username, accountName]
  );
  // 转换为 [{ date, 沪深300: close, ... }] 形状，与旧 indexHistory 快照一致
  const byDate = {};
  rows.forEach(function (r) {
    if (!byDate[r.date]) byDate[r.date] = { date: r.date };
    byDate[r.date][r.name] = r.close;
  });
  return Object.keys(byDate).sort().map(function (d) { return byDate[d]; });
}

// ====== P2-3：账户元数据表迁移与读写 ======
// 幂等：从 users.accounts JSON + account_data JSON 补全 accounts 表；ON CONFLICT DO NOTHING 不覆盖已有
async function migrateAccountsTable() {
  try {
    const users = await loadUsers();
    for (const [username, u] of Object.entries(users)) {
      for (const name of (u.accounts || [])) {
        let cashBase = 0, hkRate = 0.868;
        try {
          const { rows } = await pool.query('SELECT data FROM account_data WHERE username=$1 AND account_name=$2', [username, name]);
          if (rows[0]) {
            const d = JSON.parse(rows[0].data);
            if (typeof d.cashBase === 'number') cashBase = d.cashBase;
            if (typeof d.hkRate === 'number' && d.hkRate > 0) hkRate = d.hkRate;
          }
        } catch (e) {}
        const acctId = crypto.createHash('sha256').update(username + '\n' + name).digest('hex');
        await pool.query(
          'INSERT INTO accounts (id, username, account_name, cash_base, hk_rate, version, updated_at) VALUES ($1,$2,$3,$4,$5,1,to_char(now(),\'YYYY-MM-DD HH24:MI:SS\')) ON CONFLICT (username, account_name) DO NOTHING',
          [acctId, username, name, round(cashBase, 2), round(hkRate, 6)]
        );
      }
    }
  } catch (e) { console.warn('[migrate] accounts 表迁移跳过:', e.message); }
}

// 读取账户元数据（结构化表优先；无则返回 null，由调用方回退 JSON）
async function getAccountMeta(username, accountName) {
  const { rows } = await pool.query(
    'SELECT cash_base::float8 AS cash_base, hk_rate::float8 AS hk_rate, version FROM accounts WHERE username=$1 AND account_name=$2',
    [username, accountName]
  );
  return rows[0] ? { cashBase: rows[0].cash_base, hkRate: rows[0].hk_rate, version: rows[0].version } : null;
}

// 券商字典种子（A股主流券商；code 与 inferBroker 保持一致：华泰=huatai、招商=cms）。
// 幂等：ON CONFLICT DO UPDATE 使名称/排序随代码更新为准，不会重复插入。
const BROKER_SEED = [
  ['other', '其他/未指定', 'A', 0],
  ['huatai', '华泰证券', 'A', 10],
  ['cms', '招商证券', 'A', 20],
  ['citic', '中信证券', 'A', 30],
  ['citics', '中信建投', 'A', 40],
  ['gtja', '国泰君安', 'A', 50],
  ['galaxy', '中国银河', 'A', 60],
  ['gf', '广发证券', 'A', 70],
  ['htsec', '海通证券', 'A', 80],
  ['swhy', '申万宏源', 'A', 90],
  ['guosen', '国信证券', 'A', 100],
  ['eastmoney', '东方财富证券', 'A', 110],
  ['cicc', '中金公司', 'A', 120],
  ['ebscn', '光大证券', 'A', 130],
  ['foundersc', '方正证券', 'A', 140],
  ['pingan', '平安证券', 'A', 150],
  ['cib', '兴业证券', 'A', 160],
  ['cjsc', '长江证券', 'A', 170],
  ['zts', '中泰证券', 'A', 180],
  ['gjzq', '国金证券', 'A', 190],
  ['dwzq', '东吴证券', 'A', 200],
  ['minsheng', '民生证券', 'A', 210],
  ['orient', '东方证券', 'A', 220],
  ['cszc', '浙商证券', 'A', 230],
  ['ctsec', '财通证券', 'A', 240],
  ['tfzq', '天风证券', 'A', 250],
  ['huaan', '华安证券', 'A', 260],
  ['swsc', '西南证券', 'A', 270],
  ['gyzq', '国元证券', 'A', 280],
  ['ccb', '中银证券', 'A', 290],
  ['huaxi', '华西证券', 'A', 300],
  ['gszq', '长城证券', 'A', 310],
  ['sxzq', '山西证券', 'A', 320],
  ['njzq', '南京证券', 'A', 330],
  ['sczq', '首创证券', 'A', 340],
  ['hongta', '红塔证券', 'A', 350],
  ['hlzq', '华林证券', 'A', 360],
  ['dbzq', '德邦证券', 'A', 370],
  ['gdzq', '粤开证券', 'A', 380],
  ['cindasc', '信达证券', 'A', 390],
  ['gxzq', '国海证券', 'A', 400],
  ['zyzq', '中原证券', 'A', 410],
  ['hczq', '华创证券', 'A', 420],
  ['xszq', '湘财证券', 'A', 430]
];
async function seedBrokers() {
  for (const [code, name, market, sortOrder] of BROKER_SEED) {
    // 华泰（上交所债券）以「手」为单位录入，1手=10张；其余券商默认「张」
    const importUnit = code === 'huatai' ? 'lot' : 'sheet';
    await pool.query(
      'INSERT INTO brokers (code, name, market, sort_order, import_unit) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name, market=EXCLUDED.market, sort_order=EXCLUDED.sort_order, import_unit=EXCLUDED.import_unit',
      [code, name, market, sortOrder, importUnit]
    );
  }
}

// 券商字典：按市场返回券商列表（供前端下拉），已按 sort_order 排序
async function loadBrokers(market) {
  const { rows } = market
    ? await pool.query('SELECT code, name, market, import_unit FROM brokers WHERE market=$1 ORDER BY sort_order, name', [market])
    : await pool.query('SELECT code, name, market, import_unit FROM brokers ORDER BY market, sort_order, name');
  return rows;
}

// 校验 broker code 是否为字典内合法值（防脏数据写入 accounts.broker）
async function isValidBroker(code) {
  const { rows } = await pool.query('SELECT 1 FROM brokers WHERE code=$1', [code]);
  return rows.length > 0;
}

// 返回某用户所有账户的当前券商映射 { 账户名: broker code }
async function getAccountBrokers(username) {
  const { rows } = await pool.query('SELECT account_name, broker FROM accounts WHERE username=$1', [username]);
  const map = {};
  for (const r of rows) map[r.account_name] = r.broker || 'other';
  return map;
}

// 更新单个账户的券商（用户在账户管理里显式选择）；返回受影响行数
async function updateAccountBroker(username, accountName, broker) {
  const { rowCount } = await pool.query(
    'UPDATE accounts SET broker=$3, updated_at=to_char(now(),\'YYYY-MM-DD HH24:MI:SS\') WHERE username=$1 AND account_name=$2',
    [username, accountName, broker]
  );
  return rowCount;
}

// 根据账户名推断券商（仅作默认值，用户可后续手动改）
function inferBroker(accountName) {
  const n = (accountName || '').toLowerCase();
  if (n.indexOf('华泰') >= 0) return 'huatai';
  if (n.indexOf('招商') >= 0) return 'cms';
  return 'other';
}

// ===== 券商字典管理（管理员后台用）=====
// 列表：支持按名称/代码模糊搜索 + 市场筛选，返回全字段含 sort_order
async function adminListBrokers({ search = '', market = '' } = {}) {
  const conds = [];
  const params = [];
  if (market) { params.push(market); conds.push('market=$' + params.length); }
  if (search) {
    params.push('%' + search + '%');
    conds.push('(name ILIKE $' + params.length + ' OR code ILIKE $' + params.length + ')');
  }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const { rows } = await pool.query(
    'SELECT code, name, market, sort_order, import_unit FROM brokers ' + where + ' ORDER BY market, sort_order, name',
    params
  );
  return rows;
}

async function createBroker({ code, name, market, sort_order, import_unit }) {
  await pool.query(
    'INSERT INTO brokers (code, name, market, sort_order, import_unit) VALUES ($1,$2,$3,$4,$5)',
    [code, name, market, sort_order || 0, import_unit || 'sheet']
  );
}

async function updateBroker(code, { name, market, sort_order, import_unit }) {
  await pool.query(
    'UPDATE brokers SET name=$2, market=$3, sort_order=$4, import_unit=$5 WHERE code=$1',
    [code, name, market, sort_order || 0, import_unit || 'sheet']
  );
}

async function deleteBroker(code) {
  await pool.query('DELETE FROM brokers WHERE code=$1', [code]);
}

// 同步账户列表到结构化 accounts 表：新增补行、删除已移除的行（仅元数据，不动 account_data）
async function syncUserAccounts(username, names) {
  if (!Array.isArray(names)) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const name of names) {
      const acctId = crypto.createHash('sha256').update(username + '\n' + name).digest('hex');
      const broker = inferBroker(name);
      await client.query(
        'INSERT INTO accounts (id, username, account_name, broker, cash_base, hk_rate, version, updated_at) VALUES ($1,$2,$3,$4,0,0.868,1,to_char(now(),\'YYYY-MM-DD HH24:MI:SS\')) ON CONFLICT (username, account_name) DO NOTHING',
        [acctId, username, name, broker]
      );
      // 已有行也补 broker（幂等：已有非 other 值不被覆盖）
      await client.query(
        "UPDATE accounts SET broker=$2 WHERE username=$1 AND account_name=$3 AND (broker IS NULL OR broker='other' OR broker='')",
        [username, broker, name]
      );
    }
    await client.query('DELETE FROM accounts WHERE username=$1 AND account_name <> ALL($2::text[])', [username, names]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

// ====== P2-5：任务幂等锁（跨实例单跑）+ 执行记录 ======
function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
// 咨询锁必须占住一条专用连接，否则连接归还连接池即释放。用 Map 持有直到 releaseJob。
const _jobClients = {};
// 抢占数据库级咨询锁：抢到返回 true（锁在该连接上一直持有，直到 releaseJob 才释放，
// 因此多实例/多 worker 同时只有一方能跑同一任务）
async function tryClaimJob(job) {
  const client = await pool.connect();
  const key = hashString(job);
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [key]);
    if (rows[0] && rows[0].ok) {
      _jobClients[job] = client;
      return true;
    }
  } catch (e) {}
  client.release();
  return false;
}
async function releaseJob(job) {
  const client = _jobClients[job];
  if (!client) return;
  const key = hashString(job);
  await client.query('SELECT pg_advisory_unlock($1)', [key]).catch(() => {});
  client.release();
  delete _jobClients[job];
}
async function startJobRun(job) {
  const { rows } = await pool.query(
    "INSERT INTO job_runs (job, status, started_at, locked_until) VALUES ($1, 'running', now(), now() + interval '1 hour') RETURNING id",
    [job]
  );
  return rows[0] ? rows[0].id : null;
}
async function finishJobRun(id, ok, detail) {
  if (!id) return;
  await pool.query(
    "UPDATE job_runs SET status=$2, finished_at=now(), detail=COALESCE($3,'') WHERE id=$1",
    [id, ok ? 'done' : 'failed', detail || '']
  );
}

// ====== 管理后台：定时任务执行记录（监控用）======
// 返回最近若干条执行记录 + 每个任务的最近一次状态汇总
async function adminJobRuns(limit = 50) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const recent = await pool.query(
    'SELECT id, job, status, started_at, finished_at, detail FROM job_runs ORDER BY id DESC LIMIT $1',
    [lim]
  );
  const summary = await pool.query(
    'SELECT DISTINCT ON (job) job, status, started_at, finished_at FROM job_runs ORDER BY job, id DESC'
  );
  return { recent: recent.rows, summary: summary.rows };
}

// ====== 管理后台：平台概览聚合（供后台仪表盘）======
async function adminOverview() {
  const [u, admin, dis, acct, today, asset] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS c FROM users'),
    pool.query("SELECT COUNT(*)::int AS c FROM users WHERE role='admin'"),
    pool.query("SELECT COUNT(*)::int AS c FROM users WHERE status<>'active'"),
    pool.query('SELECT COUNT(*)::int AS c FROM accounts'),
    pool.query('SELECT COUNT(*)::int AS c FROM users WHERE created_at::date = CURRENT_DATE'),
    pool.query(`SELECT COALESCE(SUM(total_asset),0)::float8 AS s FROM (
      SELECT total_asset, ROW_NUMBER() OVER (PARTITION BY username, account_name ORDER BY date DESC) rn
      FROM nav_history
    ) t WHERE rn=1`)
  ]);
  return {
    totalUsers: u.rows[0].c,
    adminUsers: admin.rows[0].c,
    disabledUsers: dis.rows[0].c,
    totalAccounts: acct.rows[0].c,
    todayNewUsers: today.rows[0].c,
    totalAsset: Number(asset.rows[0].s || 0)
  };
}

// ====== 后台：平台配置（key/value，DB 优先于 env）======
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

// ====== 后台：平台公告 ======
async function listAnnouncements() {
  const { rows } = await pool.query("SELECT id, title, content, pinned, published_at, to_char(created_at,'YYYY-MM-DD HH24:MI:SS') AS created_at FROM announcements ORDER BY pinned DESC, created_at DESC");
  return rows;
}
async function createAnnouncement(o) {
  const id = 'a_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
  await pool.query(
    'INSERT INTO announcements (id, title, content, pinned, published_at, created_at) VALUES ($1,$2,$3,$4,$5,now())',
    [id, o.title || '', o.content || '', o.pinned ? true : false, o.published_at || '']
  );
  return id;
}
async function updateAnnouncement(id, o) {
  await pool.query(
    'UPDATE announcements SET title=$2, content=$3, pinned=$4, published_at=$5 WHERE id=$1',
    [id, o.title || '', o.content || '', o.pinned ? true : false, o.published_at || '']
  );
}
async function deleteAnnouncement(id) {
  await pool.query('DELETE FROM announcements WHERE id=$1', [id]);
}

// ====== 后台：版本记录 changelog.json 读写（一天一条合并）======
function getChangelog() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'changelog.json'), 'utf8'));
  } catch (e) { return []; }
}
function addChangelogItem(date, item) {
  const list = getChangelog();
  let entry = list.find(function (x) { return x.date === date; });
  if (!entry) { entry = { date: date, items: [] }; list.unshift(entry); }
  else if (list.indexOf(entry) !== 0) { list.splice(list.indexOf(entry), 1); list.unshift(entry); }
  entry.items.push(item);
  fs.writeFileSync(path.join(__dirname, '..', 'public', 'changelog.json'), JSON.stringify(list, null, 2));
  return list;
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
module.exports = { pool, initSchema, migrateFromJson, migrateToStructured, migrateAccountsTable, getAccountMeta, syncUserAccounts, loadBrokers, isValidBroker, getAccountBrokers, updateAccountBroker, loadUsers, loadUser, registerUser, updateUserAccounts, hashPwd, verifyPwd, getUserProfile, getUserAuth, countUsers, listUsers, setUserRole, setUserStatus, adminSetPassword, deleteUser, getUserDetail, updateUserProfile, changePassword, updateLastLogin, ensureAdmin, adminOverview, adminJobRuns, adminListBrokers, createBroker, updateBroker, deleteBroker, getConfig, setConfig, listAnnouncements, createAnnouncement, updateAnnouncement, deleteAnnouncement, getChangelog, addChangelogItem, auditLog, listAudit, loadAccountData, saveAccountData, saveDailyPrices, loadDailyPrices, upsertNav, upsertIndexPoints, loadIndexPoints, tryClaimJob, releaseJob, startJobRun, finishJobRun, uid, DATA_DIR };

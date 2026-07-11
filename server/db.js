// ========== 数据库层 (PostgreSQL) ==========
require('dotenv').config();   // 部署时读取项目根 .env（DATABASE_URL / PG* 等）
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Pool } = require('pg');

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
async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      password TEXT NOT NULL,
      accounts TEXT NOT NULL DEFAULT '[]'
    );
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
          'INSERT INTO trades (id, username, account_name, date, created_at, code, name, direction, price, quantity, amount, type, subtype, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (id, username, account_name) DO NOTHING',
          [t.id, r.username, r.account_name, t.date || '', t.created_at || '', t.code || '', t.name || '', t.direction || 'buy', t.price || 0, t.quantity || 0, t.amount || 0, t.type || '', t.subtype || '', t.note || '']
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

async function saveUsers(users) {
  for (const [u, v] of Object.entries(users)) {
    await pool.query(
      'INSERT INTO users (username, password, accounts) VALUES ($1,$2,$3) ON CONFLICT (username) DO UPDATE SET password = EXCLUDED.password, accounts = EXCLUDED.accounts',
      [u, v.password, JSON.stringify(v.accounts || [])]
    );
  }
}

// ====== 密码 ======

function hashPwd(pwd) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.pbkdf2Sync(pwd, salt, 10000, 32, 'sha512').toString('hex');
}

function verifyPwd(pwd, stored) {
  if (!stored.includes(':')) return crypto.createHash('sha256').update(pwd).digest('hex').slice(0, 16) === stored;
  const [salt, hash] = stored.split(':');
  return crypto.pbkdf2Sync(pwd, salt, 10000, 32, 'sha512').toString('hex') === hash;
}

// ====== 账户数据 ======

function uid() {
  return Date.now().toString(16) + Math.floor(Math.random() * 0x100000000).toString(16);
}

async function loadAccountData(username, accountName) {
  const { rows: positions } = await pool.query(
    'SELECT id, code, name, price, quantity, cost, type, subtype, note FROM positions WHERE username=$1 AND account_name=$2',
    [username, accountName]
  );
  const { rows: trades } = await pool.query(
    'SELECT id, date, created_at, code, name, direction, price, quantity, amount, type, subtype, note FROM trades WHERE username=$1 AND account_name=$2',
    [username, accountName]
  );
  const { rows: navHistory } = await pool.query(
    'SELECT date, nav, total_asset AS "totalAsset", invested FROM nav_history WHERE username=$1 AND account_name=$2 ORDER BY date',
    [username, accountName]
  );
  const { rows: cashFlows } = await pool.query(
    'SELECT id, date, created_at, amount, note FROM cash_flows WHERE username=$1 AND account_name=$2',
    [username, accountName]
  );
  var result = { positions, trades, navHistory, cashFlows, cash: 0, hkRate: 0.868, cashBase: 0 };
  // 从 account_data JSON 恢复 totalAsset / cashBase（cashBase=期初本金基准，cash 仅作兜底）
  let jsonData = null;
  try {
    const { rows } = await pool.query('SELECT data FROM account_data WHERE username=$1 AND account_name=$2', [username, accountName]);
    if (rows[0]) {
      const d = JSON.parse(rows[0].data);
      jsonData = d;
      if (d.totalAsset) result.totalAsset = d.totalAsset;
      if (typeof d.cashBase === 'number') result.cashBase = d.cashBase;
      if (typeof d.cash === 'number') result.cash = d.cash;
      if (Array.isArray(d.fundRecord)) result.fundRecord = d.fundRecord;
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
    const { rows } = await pool.query('SELECT data FROM account_data WHERE username=$1 AND account_name=$2', [username, accountName]);
    if (rows[0]) {
      try {
        const d = JSON.parse(rows[0].data);
        result = { ...d, positions: d.positions || [], trades: d.trades || [], navHistory: d.navHistory || [], cashFlows: d.cashFlows || [] };
      } catch (e) {}
    }
  }
  // 现金自动重算：现金 = 期初本金(cashBase) + 现金流净额 + 交易净额(买入减/卖出加)
  const cfNet = (result.cashFlows || []).reduce((s, c) => s + (c.amount || 0), 0);
  const tradeNet = (result.trades || []).reduce((s, t) => s + (t.direction === 'buy' ? -(t.amount || 0) : (t.amount || 0)), 0);
  result.cash = (result.cashBase || 0) + cfNet + tradeNet;
  return result;
}

// 单连接事务：DELETE+INSERT 全成功或全回滚，避免中途异常留下半成品数据
async function saveAccountData(username, accountName, data) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // positions
    await client.query('DELETE FROM positions WHERE username=$1 AND account_name=$2', [username, accountName]);
    for (const p of (data.positions || [])) {
      await client.query(
        'INSERT INTO positions (id, username, account_name, code, name, price, quantity, cost, type, subtype, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [p.id, username, accountName, p.code || '', p.name || '', p.price || 0, p.quantity || 0, p.cost || 0, p.type || '', p.subtype || '', p.note || '']
      );
    }
    // trades
    await client.query('DELETE FROM trades WHERE username=$1 AND account_name=$2', [username, accountName]);
    for (const t of (data.trades || [])) {
      await client.query(
        'INSERT INTO trades (id, username, account_name, date, created_at, code, name, direction, price, quantity, amount, type, subtype, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
        [t.id, username, accountName, t.date || '', t.created_at || '', t.code || '', t.name || '', t.direction || 'buy', t.price || 0, t.quantity || 0, t.amount || 0, t.type || '', t.subtype || '', t.note || '']
      );
    }
    // nav_history
    await client.query('DELETE FROM nav_history WHERE username=$1 AND account_name=$2', [username, accountName]);
    for (const n of (data.navHistory || [])) {
      await client.query(
        'INSERT INTO nav_history (username, account_name, date, nav, total_asset, invested) VALUES ($1,$2,$3,$4,$5,$6)',
        [username, accountName, n.date || '', n.nav || 1.0, n.totalAsset || 0, (n.invested == null ? null : n.invested)]
      );
    }
    // cash_flows
    await client.query('DELETE FROM cash_flows WHERE username=$1 AND account_name=$2', [username, accountName]);
    for (const c of (data.cashFlows || [])) {
      await client.query(
        'INSERT INTO cash_flows (id, username, account_name, date, created_at, amount, note) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [c.id || uid(), username, accountName, c.date || '', c.created_at || '', c.amount || 0, c.note || '']
      );
    }
    // account_data（保留 totalAsset/cashBase 供现金重算兜底；indexHistory 已独立成表，不再写入 JSON 避免读写放大；updated_at 自动更新）
    const { indexHistory, ...dataForJson } = data;
    await client.query(
      'INSERT INTO account_data (username, account_name, data, updated_at) VALUES ($1,$2,$3, to_char(now(), \'YYYY-MM-DD HH24:MI:SS\')) ON CONFLICT (username, account_name) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at',
      [username, accountName, JSON.stringify(dataForJson)]
    );
    await client.query('COMMIT');
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
      [username, accountName, date, p.code, p.name || '', p.price || 0]
    );
  }
}

async function loadDailyPrices(username, accountName, date) {
  const { rows } = await pool.query(
    'SELECT code, name, price FROM daily_prices WHERE username=$1 AND account_name=$2 AND date=$3',
    [username, accountName, date]
  );
  return rows;
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
    'SELECT date, name, close FROM index_history WHERE username=$1 AND account_name=$2 ORDER BY date',
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

// ====== 导出 ======
module.exports = { pool, initSchema, migrateFromJson, migrateToStructured, loadUsers, saveUsers, hashPwd, verifyPwd, loadAccountData, saveAccountData, saveDailyPrices, loadDailyPrices, upsertIndexPoints, loadIndexPoints, uid, DATA_DIR };

// ========== 数据库层 ==========
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

// 初始化数据库
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'portfolio.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    password TEXT NOT NULL,
    accounts TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE IF NOT EXISTS account_data (
    username TEXT NOT NULL,
    account_name TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT DEFAULT (datetime('now','localtime')),
    PRIMARY KEY (username, account_name)
  );
  CREATE TABLE IF NOT EXISTS positions (
    id TEXT NOT NULL,
    username TEXT NOT NULL,
    account_name TEXT NOT NULL,
    code TEXT NOT NULL DEFAULT '',
    name TEXT DEFAULT '',
    price REAL DEFAULT 0,
    quantity REAL DEFAULT 0,
    cost REAL DEFAULT 0,
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
    code TEXT DEFAULT '',
    name TEXT DEFAULT '',
    direction TEXT DEFAULT 'buy',
    price REAL DEFAULT 0,
    quantity REAL DEFAULT 0,
    amount REAL DEFAULT 0,
    type TEXT DEFAULT '',
    subtype TEXT DEFAULT '',
    note TEXT DEFAULT '',
    PRIMARY KEY (id, username, account_name)
  );
  CREATE TABLE IF NOT EXISTS nav_history (
    username TEXT NOT NULL,
    account_name TEXT NOT NULL,
    date TEXT NOT NULL,
    nav REAL DEFAULT 1.0,
    total_asset REAL DEFAULT 0,
    PRIMARY KEY (username, account_name, date)
  );
  CREATE TABLE IF NOT EXISTS cash_flows (
    id TEXT NOT NULL,
    username TEXT NOT NULL,
    account_name TEXT NOT NULL,
    date TEXT DEFAULT '',
    amount REAL DEFAULT 0,
    note TEXT DEFAULT '',
    PRIMARY KEY (id, username, account_name)
  );
`);

// ====== 迁移 ======

function migrateFromJson() {
  const usersPath = path.join(DATA_DIR, '__users__.json');
  if (!fs.existsSync(usersPath)) return;
  const existing = db.prepare('SELECT COUNT(*) AS cnt FROM users').get();
  if (existing.cnt > 0) return;
  try {
    const users = JSON.parse(fs.readFileSync(usersPath, 'utf-8'));
    const insUser = db.prepare('INSERT OR IGNORE INTO users (username, password, accounts) VALUES (?, ?, ?)');
    const insData = db.prepare('INSERT OR IGNORE INTO account_data (username, account_name, data) VALUES (?, ?, ?)');
    db.transaction(() => {
      for (const [u, v] of Object.entries(users)) {
        insUser.run(u, v.password, JSON.stringify(v.accounts || []));
        for (const acct of (v.accounts || [])) {
          const fp = path.join(DATA_DIR, `${u.replace(/[^a-zA-Z0-9@._-]/g, '_')}__${acct.replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '_')}.json`);
          try { insData.run(u, acct, JSON.stringify(JSON.parse(fs.readFileSync(fp, 'utf-8')))); } catch(e) {}
        }
      }
    })();
    const bakDir = path.join(DATA_DIR, 'json_backup_' + Date.now());
    fs.mkdirSync(bakDir, { recursive: true });
    for (const f of fs.readdirSync(DATA_DIR)) {
      if (f.endsWith('.json') && f !== '__users__.json' && !f.startsWith('json_backup')) {
        try { fs.cpSync(path.join(DATA_DIR, f), path.join(bakDir, f)); } catch(e) {}
      }
    }
    console.log('已从 JSON 迁移到数据库');
  } catch(e) { console.error('JSON 迁移失败:', e.message); }
}

function migrateToStructured() {
  const rows = db.prepare('SELECT username, account_name, data FROM account_data').all();
  if (rows.length === 0) return;
  if (db.prepare('SELECT COUNT(*) AS cnt FROM positions').get().cnt > 0) return;
  const insPos = db.prepare('INSERT OR IGNORE INTO positions (id, username, account_name, code, name, price, quantity, cost, type, subtype, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insTrade = db.prepare('INSERT OR IGNORE INTO trades (id, username, account_name, date, code, name, direction, price, quantity, amount, type, subtype, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insNav = db.prepare('INSERT OR IGNORE INTO nav_history (username, account_name, date, nav, total_asset) VALUES (?, ?, ?, ?, ?)');
  const insCf = db.prepare('INSERT OR IGNORE INTO cash_flows (id, username, account_name, date, amount, note) VALUES (?, ?, ?, ?, ?, ?)');
  db.transaction(() => {
    for (const r of rows) {
      let d; try { d = JSON.parse(r.data); } catch(e) { continue; }
      for (const p of (d.positions || [])) insPos.run(p.id, r.username, r.account_name, p.code, p.name, p.price, p.quantity, p.cost, p.type, p.subtype, p.note || '');
      for (const t of (d.trades || [])) insTrade.run(t.id, r.username, r.account_name, t.date, t.code, t.name, t.direction, t.price, t.quantity, t.amount, t.type, t.subtype, t.note || '');
      for (const n of (d.navHistory || [])) insNav.run(r.username, r.account_name, n.date, n.nav, n.totalAsset);
      for (const c of (d.cashFlows || [])) insCf.run(c.id, r.username, r.account_name, c.date, c.amount, c.note || '');
    }
  })();
  console.log('已迁移到结构化表');
}

// ====== 用户 ======

function loadUsers() {
  const rows = db.prepare('SELECT username, password, accounts FROM users').all();
  const users = {};
  for (const r of rows) users[r.username] = { password: r.password, accounts: JSON.parse(r.accounts || '[]') };
  return users;
}

function saveUsers(users) {
  const upsert = db.prepare('INSERT OR REPLACE INTO users (username, password, accounts) VALUES (?, ?, ?)');
  db.transaction(() => {
    for (const [u, v] of Object.entries(users)) upsert.run(u, v.password, JSON.stringify(v.accounts || []));
  })();
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

function loadAccountData(username, accountName) {
  const positions = db.prepare('SELECT id, code, name, price, quantity, cost, type, subtype, note FROM positions WHERE username=? AND account_name=?').all(username, accountName);
  const trades = db.prepare('SELECT id, date, code, name, direction, price, quantity, amount, type, subtype, note FROM trades WHERE username=? AND account_name=?').all(username, accountName);
  const navHistory = db.prepare('SELECT date, nav, total_asset AS totalAsset FROM nav_history WHERE username=? AND account_name=? ORDER BY date').all(username, accountName);
  const cashFlows = db.prepare('SELECT id, date, amount, note FROM cash_flows WHERE username=? AND account_name=?').all(username, accountName);
  var result = { positions, trades, navHistory, cashFlows, cash: 0, hkRate: 0.868 };
  // 从 account_data JSON 恢复 totalAsset（用户通过编辑或脚本设置的总资产）
  try {
    const row = db.prepare('SELECT data FROM account_data WHERE username=? AND account_name=?').get(username, accountName);
    if (row) { const d = JSON.parse(row.data); if (d.totalAsset) result.totalAsset = d.totalAsset; if (d.cash) result.cash = d.cash; }
  } catch(e) {}
  if (positions.length === 0 && trades.length === 0 && navHistory.length === 0 && cashFlows.length === 0) {
    const row = db.prepare('SELECT data FROM account_data WHERE username=? AND account_name=?').get(username, accountName);
    if (row) { try { result = { ...JSON.parse(row.data), positions: JSON.parse(row.data).positions || [], trades: JSON.parse(row.data).trades || [], navHistory: JSON.parse(row.data).navHistory || [], cashFlows: JSON.parse(row.data).cashFlows || [] }; } catch(e) {} }
  }
  return result;
}

function saveAccountData(username, accountName, data) {
  db.transaction(() => {
    db.prepare('DELETE FROM positions WHERE username=? AND account_name=?').run(username, accountName);
    const insPos = db.prepare('INSERT INTO positions (id, username, account_name, code, name, price, quantity, cost, type, subtype, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const p of (data.positions || [])) insPos.run(p.id, username, accountName, p.code || '', p.name || '', p.price || 0, p.quantity || 0, p.cost || 0, p.type || '', p.subtype || '', p.note || '');

    db.prepare('DELETE FROM trades WHERE username=? AND account_name=?').run(username, accountName);
    const insTrade = db.prepare('INSERT INTO trades (id, username, account_name, date, code, name, direction, price, quantity, amount, type, subtype, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const t of (data.trades || [])) insTrade.run(t.id, username, accountName, t.date || '', t.code || '', t.name || '', t.direction || 'buy', t.price || 0, t.quantity || 0, t.amount || 0, t.type || '', t.subtype || '', t.note || '');

    db.prepare('DELETE FROM nav_history WHERE username=? AND account_name=?').run(username, accountName);
    const insNav = db.prepare('INSERT INTO nav_history (username, account_name, date, nav, total_asset) VALUES (?, ?, ?, ?, ?)');
    for (const n of (data.navHistory || [])) insNav.run(username, accountName, n.date || '', n.nav || 1.0, n.totalAsset || 0);

    db.prepare('DELETE FROM cash_flows WHERE username=? AND account_name=?').run(username, accountName);
    const insCf = db.prepare('INSERT INTO cash_flows (id, username, account_name, date, amount, note) VALUES (?, ?, ?, ?, ?, ?)');
    for (const c of (data.cashFlows || [])) insCf.run(c.id || uid(), username, accountName, c.date || '', c.amount || 0, c.note || '');

    db.prepare('INSERT OR REPLACE INTO account_data (username, account_name, data, updated_at) VALUES (?, ?, ?, datetime(\'now\',\'localtime\'))').run(username, accountName, JSON.stringify(data));
  })();
}

// ====== 导出 ======
module.exports = { db, migrateFromJson, migrateToStructured, loadUsers, saveUsers, hashPwd, verifyPwd, loadAccountData, saveAccountData, uid, DATA_DIR };

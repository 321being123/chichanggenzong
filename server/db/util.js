// 工具函数（由 server/db.js 物理拆分而来，函数体未改动）
const { pool, crypto, fs, path, DATA_DIR, DEFAULT_FEE_SETTINGS } = require('./connection');

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

// P2-4：批量写入——把多行用一条 INSERT 完成，大幅减少数据库往返；
// 超长自动分块（默认 500 行/批）避免超过 PostgreSQL 单次参数上限（默认 65535）。
async function bulkInsert(client, table, columns, rows, buildParams, conflictClause = '', chunkSize = 500) {
  if (!rows || !rows.length) return;
  const colList = columns.join(', ');
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const placeholders = [];
    const values = [];
    let idx = 1;
    for (const row of chunk) {
      const rp = buildParams(row);
      const ph = rp.map(() => '$' + (idx++)).join(', ');
      placeholders.push('(' + ph + ')');
      values.push(...rp);
    }
    const sql = `INSERT INTO ${table} (${colList}) VALUES ${placeholders.join(', ')} ${conflictClause}`;
    await client.query(sql, values);
  }
}


// ---- 以下来自原文件后部（hashString） ----
function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
// 抢占数据库级咨询锁：抢到返回 true（锁在该连接上一直持有，直到 releaseJob 才释放，
// 因此多实例/多 worker 同时只有一方能跑同一任务）
module.exports = {
  hashPwd,
  safeEqual,
  verifyPwd,
  uid,
  round,
  bulkInsert,
  hashString,
};

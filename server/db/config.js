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
module.exports = {
  getConfig,
  setConfig,
  listAnnouncements,
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
  getChangelog,
  addChangelogItem,
  auditLog,
  listAudit,
};

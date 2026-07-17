// 本文件由 server/db.js 物理拆分而来，函数体未改动，仅调整文件归属。
const { pool, crypto, fs, path, DATA_DIR, DEFAULT_FEE_SETTINGS } = require('./connection');
const { uid, round, bulkInsert, hashPwd, safeEqual, verifyPwd, hashString } = require('./util');

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
module.exports = {
  seedBrokers,
  loadBrokers,
  isValidBroker,
  getAccountBrokers,
  updateAccountBroker,
  inferBroker,
  adminListBrokers,
  createBroker,
  updateBroker,
  deleteBroker,
  syncUserAccounts,
};

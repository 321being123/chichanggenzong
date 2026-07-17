// 本文件由 server/db.js 物理拆分而来，函数体未改动，仅调整文件归属。
const { pool, crypto, fs, path, DATA_DIR, DEFAULT_FEE_SETTINGS } = require('./connection');
const { uid, round, bulkInsert, hashPwd, safeEqual, verifyPwd, hashString } = require('./util');

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

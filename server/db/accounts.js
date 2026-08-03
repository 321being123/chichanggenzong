// 本文件由 server/db.js 物理拆分而来，函数体未改动，仅调整文件归属。
const { pool, crypto, fs, path, DATA_DIR, DEFAULT_FEE_SETTINGS } = require('./connection');
const { uid, round, bulkInsert, hashPwd, safeEqual, verifyPwd, hashString } = require('./util');
const { loadUsers } = require('./users');

async function loadAccountData(username, accountName) {
  const { rows: positions } = await pool.query(
    'SELECT id, code, name, price::float8 AS price, quantity::float8 AS quantity, cost::float8 AS cost, type, subtype, note, instrument_id FROM positions WHERE username=$1 AND account_name=$2',
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
      if (d.feeSettings && typeof d.feeSettings === 'object') result.feeSettings = d.feeSettings;
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

// 按持仓 code 批量关联 core.instruments.instrument_id（仓位对比统一证券身份用）。
// 匹配规则与 bondDataService 一致：优先精确 code（如 600519 / 00700.HK / 113050.SH），
// 再尝试去掉交易所后缀的纯数字匹配；未匹配返回 null（由回填/同步补偿，不影响保存）。
async function buildInstrumentIdMap(codes) {
  const map = new Map();
  const unique = [...new Set((codes || []).filter(Boolean).map(c => String(c).trim()))];
  if (!unique.length) return map;
  try {
    const { rows } = await pool.query(
      `SELECT canonical_code, instrument_id FROM core.instruments
        WHERE canonical_code = ANY($1::text[])
           OR REGEXP_REPLACE(canonical_code, '\\D', '', 'g') = ANY($2::text[])`,
      [unique, unique.map(c => c.replace(/\D/g, ''))]
    );
    const byPlain = new Map();
    for (const r of rows) {
      const plain = String(r.canonical_code).replace(/\D/g, '');
      if (!byPlain.has(plain)) byPlain.set(plain, r.instrument_id);
    }
    for (const c of unique) {
      const exact = rows.find(r => r.canonical_code === c);
      map.set(c, exact ? exact.instrument_id : (byPlain.get(c.replace(/\D/g, '')) || null));
    }
  } catch (e) {
    // 映射失败不阻断保存（positions 仍可写 NULL），由每日回填补偿
  }
  return map;
}

// 单连接事务：DELETE+INSERT 全成功或全回滚，避免中途异常留下半成品数据
// expectedVersion：前端带回加载时的版本号（乐观锁）；为 null 时不强制（兼容旧客户端/测试）
async function saveAccountData(username, accountName, data, expectedVersion = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // positions（P2-4：批量写入，原单条 INSERT 循环改为一次性批量）
    await client.query('DELETE FROM positions WHERE username=$1 AND account_name=$2', [username, accountName]);
    const posRows = data.positions || [];
    // 仓位对比：保存时按 code 重新关联 instrument_id（避免 DELETE+重建把回填映射清空；未匹配写 NULL 不报错）
    const instIdMap = await buildInstrumentIdMap(posRows.map(p => p && p.code));
    await bulkInsert(client, 'positions',
      ['id', 'username', 'account_name', 'code', 'name', 'price', 'quantity', 'cost', 'type', 'subtype', 'note', 'instrument_id'],
      posRows,
      (p) => [p.id, username, accountName, p.code || '', p.name || '', round(p.price, 4), round(p.quantity, 4), round(p.cost, 4), p.type || '', p.subtype || '', p.note || '', instIdMap.get(String(p.code || '').trim()) || null]
    );
    // trades
    await client.query('DELETE FROM trades WHERE username=$1 AND account_name=$2', [username, accountName]);
    await bulkInsert(client, 'trades',
      ['id', 'username', 'account_name', 'date', 'created_at', 'code', 'name', 'direction', 'price', 'quantity', 'amount', 'type', 'subtype', 'note', 'commission', 'stamp_tax', 'transfer_fee', 'other_fee'],
      data.trades || [],
      (t) => [t.id, username, accountName, t.date || '', t.created_at || '', t.code || '', t.name || '', t.direction || 'buy', round(t.price, 4), round(t.quantity, 4), round(t.amount, 4), t.type || '', t.subtype || '', t.note || '', round(t.commission, 4), round(t.stamp_tax, 4), round(t.transfer_fee, 4), round(t.other_fee, 4)]
    );
    // nav_history
    await client.query('DELETE FROM nav_history WHERE username=$1 AND account_name=$2', [username, accountName]);
    await bulkInsert(client, 'nav_history',
      ['username', 'account_name', 'date', 'nav', 'total_asset', 'invested'],
      data.navHistory || [],
      (n) => [username, accountName, n.date || '', round(n.nav, 6), round(n.totalAsset, 2), (n.invested == null ? null : round(n.invested, 2))],
      'ON CONFLICT (username, account_name, date) DO UPDATE SET nav = EXCLUDED.nav, total_asset = EXCLUDED.total_asset, invested = EXCLUDED.invested'
    );
    // cash_flows
    await client.query('DELETE FROM cash_flows WHERE username=$1 AND account_name=$2', [username, accountName]);
    await bulkInsert(client, 'cash_flows',
      ['id', 'username', 'account_name', 'date', 'created_at', 'amount', 'note'],
      data.cashFlows || [],
      (c) => [c.id || uid(), username, accountName, c.date || '', c.created_at || '', round(c.amount, 2), c.note || '']
    );
    // account_data：仅显式挑选允许的顶层字段写入（杜绝未知字段持久化，满足 schema 白名单）；
    // indexHistory 已独立成表、changes/version 为瞬时字段，均不写入 JSON。
    const { positions, trades, navHistory, cashFlows, cash, hkRate, cashBase, totalAsset, fundRecord, feeSettings } = data;
    const dataForJson = { positions, trades, navHistory, cashFlows, cash, hkRate, cashBase, totalAsset, fundRecord, feeSettings };
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
    // hk_rate_updated_at：首次插入=now()；仅当 hk_rate 值变化时更新（用户手动改汇率也算真实变更，迁移 039）。
    // ⚠️ VALUES 子句不能引用目标表列（PostgreSQL 报"字段不存在"），首次值直接 now()，
    //    变化判断只放在 ON CONFLICT DO UPDATE 分支（EXCLUDED/accounts 表引用合法）。
    const acctId = crypto.createHash('sha256').update(username + '\n' + accountName).digest('hex');
    const newHkRate = round(data.hkRate || 0.868, 6);
    await client.query(
      'INSERT INTO accounts (id, username, account_name, cash_base, hk_rate, version, updated_at, hk_rate_updated_at) VALUES ($1,$2,$3,$4,$5,1,to_char(now(),\'YYYY-MM-DD HH24:MI:SS\'), now()) ON CONFLICT (username, account_name) DO UPDATE SET cash_base=EXCLUDED.cash_base, hk_rate=EXCLUDED.hk_rate, version=accounts.version+1, updated_at=EXCLUDED.updated_at, hk_rate_updated_at=CASE WHEN EXCLUDED.hk_rate IS DISTINCT FROM accounts.hk_rate THEN now() ELSE accounts.hk_rate_updated_at END',
      [acctId, username, accountName, round(data.cashBase || 0, 2), newHkRate]
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

// ====== 历史净值备份/还原/清理（操作真实 nav_history 表，与 loadAccountData 数据源一致） ======
// 2026-08-03 修复：此前误操作 account_data.data JSONB 字段，而页面实际读 nav_history 表，
// 导致"接口成功但刷新无变化"。以下均以 nav_history 表为唯一数据源。

// 备份：把 nav_history 表当前数据快照到 account_data.nav_history_backup
// 2026-08-03 修复：新账户可能还没有 account_data 行，UPDATE 命中 0 行导致备份丢失却返回成功
// → 改为 UPSERT 确保行存在；新行 version=0（与"从未保存"一致），避免破坏前端首存（expectedVersion=0）
async function backupNavHistory(username, accountName) {
  const { rows } = await pool.query(
    'SELECT date, nav::float8 AS nav, total_asset::float8 AS "totalAsset", invested::float8 AS invested FROM nav_history WHERE username=$1 AND account_name=$2 ORDER BY date',
    [username, accountName]
  );
  await pool.query(
    `INSERT INTO account_data (username, account_name, data, version, nav_history_backup, nav_history_backup_at)
     VALUES ($1,$2,'{}',0,$3::jsonb,now())
     ON CONFLICT (username, account_name)
     DO UPDATE SET nav_history_backup = EXCLUDED.nav_history_backup, nav_history_backup_at = now()`,
    [username, accountName, JSON.stringify(rows)]
  );
  return { ok: true, rows: rows.length };
}

// 还原：校验备份存在（NULL=从未备份）→ 写回 nav_history 表 → 提升 version（使其他页面的旧乐观锁失效）
// 2026-08-03 修复：备份过"0 条"（空数组）也是合法快照，应能还原为空历史，不能误判为"没有备份"
async function restoreNavHistory(username, accountName) {
  const { rows: bk } = await pool.query(
    'SELECT nav_history_backup, nav_history_backup_at FROM account_data WHERE username=$1 AND account_name=$2',
    [username, accountName]
  );
  const backup = bk[0] ? bk[0].nav_history_backup : null;
  if (backup === null || backup === undefined) {
    throw Object.assign(new Error('当前账户没有备份，无法还原'), { status: 404 });
  }
  const backupArr = Array.isArray(backup) ? backup : [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM nav_history WHERE username=$1 AND account_name=$2', [username, accountName]);
    for (const n of backupArr) {
      await client.query(
        'INSERT INTO nav_history (username, account_name, date, nav, total_asset, invested) VALUES ($1,$2,$3,$4,$5,$6) ' +
        'ON CONFLICT (username, account_name, date) DO UPDATE SET nav=EXCLUDED.nav, total_asset=EXCLUDED.total_asset, invested=EXCLUDED.invested',
        [username, accountName, n.date, round(n.nav, 6), round(n.totalAsset, 2), (n.invested == null ? null : round(n.invested, 2))]
      );
    }
    await client.query('UPDATE account_data SET version=version+1 WHERE username=$1 AND account_name=$2', [username, accountName]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
  return { ok: true, rows: backupArr.length, backupAt: bk[0] ? bk[0].nav_history_backup_at : null };
}

// 清理：invested-only 清空投入本金（置 NULL 由前端按现金流转公式回算）；before-date 删除指定日期前（含）；均提升 version
async function clearNavHistory(username, accountName, mode, beforeDate) {
  if (mode === 'invested-only') {
    const r = await pool.query('UPDATE nav_history SET invested=NULL WHERE username=$1 AND account_name=$2', [username, accountName]);
    await pool.query('UPDATE account_data SET version=version+1 WHERE username=$1 AND account_name=$2', [username, accountName]);
    return { ok: true, rows: r.rowCount };
  }
  if (mode === 'before-date' && beforeDate) {
    const r = await pool.query('DELETE FROM nav_history WHERE username=$1 AND account_name=$2 AND date<=$3', [username, accountName, beforeDate]);
    await pool.query('UPDATE account_data SET version=version+1 WHERE username=$1 AND account_name=$2', [username, accountName]);
    return { ok: true, rows: r.rowCount };
  }
  throw Object.assign(new Error('不支持的模式（invested-only / before-date）'), { status: 400 });
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

module.exports = {
  loadAccountData,
  saveAccountData,
  buildInstrumentIdMap,
  saveDailyPrices,
  loadDailyPrices,
  upsertNav,
  upsertIndexPoints,
  loadIndexPoints,
  migrateAccountsTable,
  getAccountMeta,
  backupNavHistory,
  restoreNavHistory,
  clearNavHistory,
};

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
  // 2026-08-03 架构整改（报告 3.1/3.3）：结构化表是唯一权威来源。
  // - 不再从 account_data JSON 恢复 totalAsset/cashBase/cash/fundRecord/feeSettings（JSON 退出日常读取）；
  // - 指数历史只读结构化表，表空即空，不再读旧 JSON 且读取接口绝不写库；
  // - 持仓/交易/净值/现金流四表同时为空时返回空（用户主动清空是真实结果，禁止 JSON 还魂）。
  var result = { positions, trades, navHistory, cashFlows, cash: 0, hkRate: 0.868, cashBase: 0, indexHistory: [], feeSettings: null };
  // 账户元数据（期初本金/汇率/税费设置/乐观锁版本）：唯一来源 accounts 表 + account_data.version
  try {
    const { rows: am } = await pool.query(
      'SELECT cash_base::float8 AS cash_base, hk_rate::float8 AS hk_rate, fee_settings FROM accounts WHERE username=$1 AND account_name=$2',
      [username, accountName]
    );
    if (am[0]) {
      if (typeof am[0].cash_base === 'number') result.cashBase = am[0].cash_base;
      if (typeof am[0].hk_rate === 'number' && am[0].hk_rate > 0) result.hkRate = am[0].hk_rate;
      if (am[0].fee_settings && typeof am[0].fee_settings === 'object') result.feeSettings = am[0].fee_settings;
    }
  } catch (e) { console.warn('[loadAccountData] accounts 元数据读取失败:', e.message); }
  try {
    const { rows: v } = await pool.query('SELECT version, pos_version, trade_version, nav_version, cashflow_version FROM account_data WHERE username=$1 AND account_name=$2', [username, accountName]);
    if (v[0]) {
      if (typeof v[0].version === 'number') result.version = v[0].version;
      // 数据集级版本号：前端保存时带回来做逐数据集校验（8.2 并发验收）
      result.posVersion = v[0].pos_version || 0;
      result.tradeVersion = v[0].trade_version || 0;
      result.navVersion = v[0].nav_version || 0;
      result.cashflowVersion = v[0].cashflow_version || 0;
    }
  } catch (e) { console.warn('[loadAccountData] 版本号读取失败:', e.message); }
  // 指数历史：只读结构化表（读取接口不产生任何写库副作用）
  result.indexHistory = await loadIndexPoints(username, accountName);
  // 总资产快照：结构化来源（nav_history 最近一条的 total_asset），不再从 JSON 恢复（报告 5 矩阵：
  // 总资产不作为第二份业务事实长期保存；前端行情刷新后会按持仓现值重算 TOTAL_ASSET 覆盖）
  if (navHistory.length > 0 && navHistory[navHistory.length - 1].totalAsset != null) {
    result.totalAsset = navHistory[navHistory.length - 1].totalAsset;
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
// 2026-08-03 架构整改（报告 3.5/8.2）：数据集级版本控制，替代"整包无条件覆盖"。
// - 前端保存时带回加载时的各数据集版本（datasetVersions）；服务端只写入版本一致的数据集，
//   版本落后（被后台任务/其他浏览器改过）的数据集跳过写入，保留库中较新数据 → 旧浏览器
//   保存持仓不会覆盖后台新净值；两个浏览器改不同数据集互不覆盖。
// - 未指定某数据集版本（旧客户端/测试）→ 允许写入该数据集（向后兼容）。
// - expectedVersion：账户级乐观锁（任何一次保存都要求与加载时一致，防整包并发互踩）。
async function saveAccountData(username, accountName, data, expectedVersion = null, datasetVersions = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 读取当前各数据集版本
    const { rows: vrows } = await client.query(
      `SELECT COALESCE(pos_version,0) AS pv, COALESCE(trade_version,0) AS tv,
              COALESCE(nav_version,0) AS nv, COALESCE(cashflow_version,0) AS cv
         FROM account_data WHERE username=$1 AND account_name=$2`,
      [username, accountName]
    );
    const base = vrows[0] || { pv: 0, tv: 0, nv: 0, cv: 0 };
    const req = datasetVersions || {};
    const asNum = function (x) { return (typeof x === 'number') ? x : (x == null ? null : Number(x)); };
    // 版本语义：undefined/null = 客户端未提供（兼容纯数据层调用/测试，允许写入）；
    // 提供了但落后于库中版本 = 该数据集被后台任务/其他浏览器更新过 → 跳过写入保留库中较新数据。
    const match = function (reqV, curV) { return reqV === undefined || reqV === null || asNum(reqV) === curV; };
    const allow = {
      positions: match(req.positions, base.pv),
      trades: match(req.trades, base.tv),
      navHistory: match(req.navHistory, base.nv),
      cashFlows: match(req.cashFlows, base.cv),
    };
    const skipped = [];
    for (const k of ['positions', 'trades', 'navHistory', 'cashFlows']) if (!allow[k]) skipped.push(k);

    // positions（P2-4：批量写入，原单条 INSERT 循环改为一次性批量）
    if (allow.positions) {
      await client.query('DELETE FROM positions WHERE username=$1 AND account_name=$2', [username, accountName]);
      const posRows = data.positions || [];
      // 仓位对比：保存时按 code 重新关联 instrument_id（避免 DELETE+重建把回填映射清空；未匹配写 NULL 不报错）
      const instIdMap = await buildInstrumentIdMap(posRows.map(p => p && p.code));
      await bulkInsert(client, 'positions',
        ['id', 'username', 'account_name', 'code', 'name', 'price', 'quantity', 'cost', 'type', 'subtype', 'note', 'instrument_id'],
        posRows,
        (p) => [p.id, username, accountName, p.code || '', p.name || '', round(p.price, 4), round(p.quantity, 4), round(p.cost, 4), p.type || '', p.subtype || '', p.note || '', instIdMap.get(String(p.code || '').trim()) || null]
      );
    }
    // trades
    if (allow.trades) {
      await client.query('DELETE FROM trades WHERE username=$1 AND account_name=$2', [username, accountName]);
      await bulkInsert(client, 'trades',
        ['id', 'username', 'account_name', 'date', 'created_at', 'code', 'name', 'direction', 'price', 'quantity', 'amount', 'type', 'subtype', 'note', 'commission', 'stamp_tax', 'transfer_fee', 'other_fee'],
        data.trades || [],
        (t) => [t.id, username, accountName, t.date || '', t.created_at || '', t.code || '', t.name || '', t.direction || 'buy', round(t.price, 4), round(t.quantity, 4), round(t.amount, 4), t.type || '', t.subtype || '', t.note || '', round(t.commission, 4), round(t.stamp_tax, 4), round(t.transfer_fee, 4), round(t.other_fee, 4)]
      );
    }
    // nav_history
    if (allow.navHistory) {
      await client.query('DELETE FROM nav_history WHERE username=$1 AND account_name=$2', [username, accountName]);
      await bulkInsert(client, 'nav_history',
        ['username', 'account_name', 'date', 'nav', 'total_asset', 'invested'],
        data.navHistory || [],
        (n) => [username, accountName, n.date || '', round(n.nav, 6), round(n.totalAsset, 2), (n.invested == null ? null : round(n.invested, 2))],
        'ON CONFLICT (username, account_name, date) DO UPDATE SET nav = EXCLUDED.nav, total_asset = EXCLUDED.total_asset, invested = EXCLUDED.invested'
      );
    }
    // cash_flows
    if (allow.cashFlows) {
      await client.query('DELETE FROM cash_flows WHERE username=$1 AND account_name=$2', [username, accountName]);
      await bulkInsert(client, 'cash_flows',
        ['id', 'username', 'account_name', 'date', 'created_at', 'amount', 'note'],
        data.cashFlows || [],
        (c) => [c.id || uid(), username, accountName, c.date || '', c.created_at || '', round(c.amount, 2), c.note || '']
      );
    }
    // account_data：业务数组已退出 JSON（整改后 JSON 仅作只读归档，不再参与业务读取/写入），
    // 仅维护版本号列（账户级 + 数据集级）与 updated_at。
    // 乐观锁（P1-3）：version 必填且已在路由层校验为整数；冲突抛 conflict 由路由返回 409。
    // 被跳过写入的数据集版本保持不变（保留库中较新数据），写入成功的数据集版本 +1。
    const up = await client.query(
      `UPDATE account_data
          SET updated_at=to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
              version=version+1,
              pos_version = CASE WHEN $3 THEN pos_version+1 ELSE pos_version END,
              trade_version = CASE WHEN $4 THEN trade_version+1 ELSE trade_version END,
              nav_version = CASE WHEN $5 THEN nav_version+1 ELSE nav_version END,
              cashflow_version = CASE WHEN $6 THEN cashflow_version+1 ELSE cashflow_version END
        WHERE username=$1 AND account_name=$2 AND version=$7`,
      [username, accountName, !!allow.positions, !!allow.trades, !!allow.navHistory, !!allow.cashFlows, expectedVersion]
    );
    if (up.rowCount === 0) {
      const ex = await client.query('SELECT 1 FROM account_data WHERE username=$1 AND account_name=$2', [username, accountName]);
      if (ex.rowCount > 0) throw Object.assign(new Error('数据已在其他位置被修改，请刷新页面后重试'), { conflict: true });
      // 新账户首次保存：行尚不存在，插入初版（前端首存带 version=0，UPDATE 命中 0 行后走此分支）
      await client.query(
        `INSERT INTO account_data (username, account_name, data, version, updated_at,
            pos_version, trade_version, nav_version, cashflow_version)
         VALUES ($1,$2,'{}',1,to_char(now(),'YYYY-MM-DD HH24:MI:SS'),
            CASE WHEN $3 THEN 1 ELSE 0 END, CASE WHEN $4 THEN 1 ELSE 0 END,
            CASE WHEN $5 THEN 1 ELSE 0 END, CASE WHEN $6 THEN 1 ELSE 0 END)
         ON CONFLICT (username, account_name) DO UPDATE
           SET updated_at=EXCLUDED.updated_at, version=account_data.version+1,
               pos_version = CASE WHEN $3 THEN account_data.pos_version+1 ELSE account_data.pos_version END,
               trade_version = CASE WHEN $4 THEN account_data.trade_version+1 ELSE account_data.trade_version END,
               nav_version = CASE WHEN $5 THEN account_data.nav_version+1 ELSE account_data.nav_version END,
               cashflow_version = CASE WHEN $6 THEN account_data.cashflow_version+1 ELSE account_data.cashflow_version END`,
        [username, accountName, !!allow.positions, !!allow.trades, !!allow.navHistory, !!allow.cashFlows]
      );
    }
    // P2-3：账户元数据（cash_base/hk_rate/fee_settings）结构化落库，作为唯一权威来源（JSON 不再兜底）
    // hk_rate_updated_at：首次插入=now()；仅当 hk_rate 值变化时更新（用户手动改汇率也算真实变更，迁移 039）。
    const acctId = crypto.createHash('sha256').update(username + '\n' + accountName).digest('hex');
    const newHkRate = round(data.hkRate || 0.868, 6);
    const feeSettingsJson = (data.feeSettings && typeof data.feeSettings === 'object') ? JSON.stringify(data.feeSettings) : null;
    await client.query(
      'INSERT INTO accounts (id, username, account_name, cash_base, hk_rate, fee_settings, version, updated_at, hk_rate_updated_at) VALUES ($1,$2,$3,$4,$5,$6,1,to_char(now(),\'YYYY-MM-DD HH24:MI:SS\'), now()) ON CONFLICT (username, account_name) DO UPDATE SET cash_base=EXCLUDED.cash_base, hk_rate=EXCLUDED.hk_rate, fee_settings=COALESCE(EXCLUDED.fee_settings, accounts.fee_settings), version=accounts.version+1, updated_at=EXCLUDED.updated_at, hk_rate_updated_at=CASE WHEN EXCLUDED.hk_rate IS DISTINCT FROM accounts.hk_rate THEN now() ELSE accounts.hk_rate_updated_at END',
      [acctId, username, accountName, round(data.cashBase || 0, 2), newHkRate, feeSettingsJson]
    );
    const { rows: vr } = await client.query(
      'SELECT version, pos_version, trade_version, nav_version, cashflow_version FROM account_data WHERE username=$1 AND account_name=$2',
      [username, accountName]
    );
    await client.query('COMMIT');
    // 返回账户新版本 + 四个数据集新版本号（前端保存成功后同步更新，避免二次保存误报冲突 P0-1）
    const v = vr[0] || {};
    return {
      version: v.version || 1,
      posVersion: v.pos_version || 0,
      tradeVersion: v.trade_version || 0,
      navVersion: v.nav_version || 0,
      cashflowVersion: v.cashflow_version || 0,
      skipped: skipped // 被跳过（保留库中较新）的数据集
    };
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

// 幂等写入单条净值快照（回填/重算/后台快照用）：冲突则覆盖 nav / total_asset / invested
// 2026-08-03 整改：写入后提升 nav_version（后台任务与前端保存共用同一版本机制，
// 后台新增净值后，旧浏览器保存持仓时 nav_version 不匹配 → 该数据集被跳过，不再覆盖后台新净值）
// 2026-08-03 阻断修复：写 nav_history 与 nav_version+1 必须在**同一事务**内，
// 否则第一步成功第二步失败时净值已写入但版本未涨 → 旧客户端保存仍可覆盖后台数据（版本失真）。
async function upsertNav(username, accountName, rec) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO nav_history (username, account_name, date, nav, total_asset, invested) VALUES ($1,$2,$3,$4,$5,$6) ' +
      'ON CONFLICT (username, account_name, date) DO UPDATE SET nav = EXCLUDED.nav, total_asset = EXCLUDED.total_asset, invested = EXCLUDED.invested',
      [username, accountName, rec.date, round(rec.nav, 6), round(rec.totalAsset, 2), (rec.invested == null ? null : round(rec.invested, 2))]
    );
    await client.query(
      `INSERT INTO account_data (username, account_name, data, version, nav_version)
       VALUES ($1,$2,'{}',0,1)
       ON CONFLICT (username, account_name)
       DO UPDATE SET nav_version = account_data.nav_version + 1`,
      [username, accountName]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ====== 历史净值备份/还原/清理（2026-08-03 架构整改：只写 nav_history 表，不再双写 JSON） ======
// 整改前（0.4.3.0）曾做"表 + JSONB 双写"以防页面从 JSON 兜底读回旧数据；本次 loadAccountData
// 已彻底移除 JSON 兜底（结构化表=唯一权威），JSON 双写不再必要，反而制造第二份业务事实（报告 3.2）。
// 所有净值写入统一提升 nav_version（后台任务/导入/还原/清理与前端保存共用同一版本机制，8.2 验收）。

// 读取当前实际生效的 navHistory（只读结构化表；表空即空，绝不读 JSON 归档）
async function readEffectiveNavHistory(username, accountName) {
  const { rows } = await pool.query(
    'SELECT date, nav::float8 AS nav, total_asset::float8 AS "totalAsset", invested::float8 AS invested FROM nav_history WHERE username=$1 AND account_name=$2 ORDER BY date',
    [username, accountName]
  );
  return rows;
}

// 事务内：写 nav_history 表（DELETE+INSERT）+ 提升 nav_version（使其他页面的旧快照不再覆盖）
async function writeNavHistoryBoth(client, username, accountName, navs) {
  await client.query('DELETE FROM nav_history WHERE username=$1 AND account_name=$2', [username, accountName]);
  for (const n of navs) {
    await client.query(
      'INSERT INTO nav_history (username, account_name, date, nav, total_asset, invested) VALUES ($1,$2,$3,$4,$5,$6) ' +
      'ON CONFLICT (username, account_name, date) DO UPDATE SET nav=EXCLUDED.nav, total_asset=EXCLUDED.total_asset, invested=EXCLUDED.invested',
      [username, accountName, n.date, round(n.nav, 6), round(n.totalAsset, 2), (n.invested == null ? null : round(n.invested, 2))]
    );
  }
  await client.query(
    `UPDATE account_data SET nav_version = nav_version + 1
      WHERE username=$1 AND account_name=$2`,
    [username, accountName]
  );
}

// 备份：把当前实际生效的 navHistory 快照到 nav_history_backup
// UPSERT 确保新账户（无 account_data 行）也能存；新行 version=0（不破坏前端首存 expectedVersion=0）
async function backupNavHistory(username, accountName) {
  const rows = await readEffectiveNavHistory(username, accountName);
  await pool.query(
    `INSERT INTO account_data (username, account_name, data, version, nav_history_backup, nav_history_backup_at)
     VALUES ($1,$2,'{}',0,$3::jsonb,now())
     ON CONFLICT (username, account_name)
     DO UPDATE SET nav_history_backup = EXCLUDED.nav_history_backup, nav_history_backup_at = now()`,
    [username, accountName, JSON.stringify(rows)]
  );
  return { ok: true, rows: rows.length };
}

// 还原：校验备份存在（NULL=从未备份）→ 写回 nav_history 表 → 提升 nav_version
// 空快照（0 条）是合法快照，应能还原为空历史，不误判为"没有备份"
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
    await writeNavHistoryBoth(client, username, accountName, backupArr);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
  return { ok: true, rows: backupArr.length, backupAt: bk[0] ? bk[0].nav_history_backup_at : null };
}

// 清理：keep-latest 删除除最近一天外全部记录；invested-only 清空投入本金（置 NULL）；
//       before-date 删除指定日期前（含）；均只操作 nav_history 表并提升 nav_version
async function clearNavHistory(username, accountName, mode, beforeDate) {
  const current = await readEffectiveNavHistory(username, accountName);
  let keep = current;
  if (mode === 'keep-latest') {
    const maxDate = current.reduce((m, n) => (n.date > m ? n.date : m), '');
    keep = maxDate ? current.filter(n => n.date === maxDate) : [];
  } else if (mode === 'invested-only') {
    keep = current.map(n => ({ ...n, invested: null }));
  } else if (mode === 'before-date' && beforeDate) {
    keep = current.filter(n => n.date > beforeDate);
  } else {
    throw Object.assign(new Error('不支持的模式（keep-latest / invested-only / before-date）'), { status: 400 });
  }
  const deleted = current.length - keep.length;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await writeNavHistoryBoth(client, username, accountName, keep);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
  return { ok: true, rows: deleted };
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
// 2026-08-03 整改：只对 data_source_version<2 的账户补全（已归档账户不再从 JSON 读取元数据），
// 并补 fee_settings（税费设置结构化落库，JSON 退出运行时读取）。
async function migrateAccountsTable() {
  try {
    const users = await loadUsers();
    for (const [username, u] of Object.entries(users)) {
      for (const name of (u.accounts || [])) {
        let cashBase = 0, hkRate = 0.868, feeSettings = null;
        try {
          const { rows } = await pool.query(
            'SELECT data, data_source_version FROM account_data WHERE username=$1 AND account_name=$2',
            [username, name]
          );
          if (rows[0] && (rows[0].data_source_version == null || rows[0].data_source_version < 2)) {
            const d = JSON.parse(rows[0].data);
            if (typeof d.cashBase === 'number') cashBase = d.cashBase;
            if (typeof d.hkRate === 'number' && d.hkRate > 0) hkRate = d.hkRate;
            if (d.feeSettings && typeof d.feeSettings === 'object') feeSettings = JSON.stringify(d.feeSettings);
          }
        } catch (e) {}
        const acctId = crypto.createHash('sha256').update(username + '\n' + name).digest('hex');
        await pool.query(
          'INSERT INTO accounts (id, username, account_name, cash_base, hk_rate, fee_settings, version, updated_at) VALUES ($1,$2,$3,$4,$5,$6,1,to_char(now(),\'YYYY-MM-DD HH24:MI:SS\')) ON CONFLICT (username, account_name) DO NOTHING',
          [acctId, username, name, round(cashBase, 2), round(hkRate, 6), feeSettings]
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

// ====== 账户生命周期（2026-08-03 整改，报告 3.6/3.7/阶段四） ======
// 删除/重命名抽成 db 层函数（路由与测试共用真实事务，覆盖业务表 + 兼容 JSON + users.accounts 列表同步）。
// 之前删除只改列表、重命名靠"读旧存新"，均非原子且留孤立业务数据（重名账户复活）。

// 删除账户：单事务删除该账户全部业务数据 + 账户元数据 + 兼容 JSON + users.accounts 列表项
async function deleteAccountData(username, accountName) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tables = ['positions', 'trades', 'nav_history', 'cash_flows', 'daily_prices', 'index_history', 'account_data', 'accounts'];
    for (const t of tables) {
      await client.query(`DELETE FROM ${t} WHERE username=$1 AND account_name=$2`, [username, accountName]);
    }
    // 同步 users.accounts 列表（移除被删账户名）
    const u = await loadUsers();
    if (u[username] && Array.isArray(u[username].accounts)) {
      const rest = u[username].accounts.filter(function (a) { return a !== accountName; });
      await client.query('UPDATE users SET accounts=$2 WHERE username=$1', [username, JSON.stringify(rest)]);
    }
    await client.query('COMMIT');
    return { ok: true };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}

// 重命名账户：单事务内把所有业务表 + 账户元数据 + 兼容 JSON + users.accounts 列表改为新名
// （只改 account_name，不搬运/复制任何数据；失败整体回滚）。
// ⚠️ accounts.id = sha256(username+accountName) 是确定性哈希主键（业务表不引用它），
//    重命名时必须同步更新为新名的哈希，否则旧名重建账户会主键冲突（报告 3.7 重命名缺陷）。
async function renameAccountData(username, oldName, newName) {
  const dup = await pool.query('SELECT 1 FROM accounts WHERE username=$1 AND account_name=$2', [username, newName]);
  if (dup.rowCount > 0) return { ok: false, conflict: '该名称已被使用' };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tables = ['positions', 'trades', 'nav_history', 'cash_flows', 'daily_prices', 'index_history', 'account_data'];
    for (const t of tables) {
      await client.query(`UPDATE ${t} SET account_name=$3 WHERE username=$1 AND account_name=$2`, [username, oldName, newName]);
    }
    // accounts 表：id 与新名哈希保持一致（sha256 确定性主键，业务表不引用 id，可安全更新）
    const newId = crypto.createHash('sha256').update(username + '\n' + newName).digest('hex');
    await client.query('UPDATE accounts SET id=$3, account_name=$4, updated_at=to_char(now(),\'YYYY-MM-DD HH24:MI:SS\') WHERE username=$1 AND account_name=$2', [username, oldName, newId, newName]);
    // 同步 users.accounts 列表
    const u = await loadUsers();
    if (u[username] && Array.isArray(u[username].accounts)) {
      const mapped = u[username].accounts.map(function (a) { return a === oldName ? newName : a; });
      await client.query('UPDATE users SET accounts=$2 WHERE username=$1', [username, JSON.stringify(mapped)]);
    }
    await client.query('COMMIT');
    return { ok: true };
  } catch (e) {
    await client.query('ROLLBACK');
    if (e && e.code === '23505') return { ok: false, conflict: '该名称已被使用' };
    throw e;
  } finally { client.release(); }
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
  deleteAccountData,
  renameAccountData,
  backupNavHistory,
  restoreNavHistory,
  clearNavHistory,
};

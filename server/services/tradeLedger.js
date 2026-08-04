// ===================== 账户账本服务（统一交易事务） =====================
// 持仓管理架构与交易数据整改方案（2026-08-03）阶段二：
// 交易、持仓、现金的关联修改必须在服务端同一事务完成；前端不再自行实现持仓/现金计算规则。
//
// 职责：
//  1. applyTrade   —— 新增/修改交易：校验 → 可卖数量校验 → 写交易 → 重算持仓数量与移动加权成本 → 重算现金 → 标记净值重算
//  2. deleteTrade  —— 删除交易：从该交易日起重放该证券持仓与账户现金（无后续交易时可反向撤销）
//  3. clearTrades  —— 清空交易：仅清空交易流水（持仓/现金按当前持仓快照保留，历史净值由用户另行处理）
//
// 关键设计（方案 4.1/4.2）：
//  - positions.price = 当前行情价（只由行情刷新更新）；positions.cost = 移动加权成本（本服务维护）
//  - 交易录入永不修改 positions.price（禁止交易覆盖当前价）
//  - amount 由服务端统一 = price × quantity（与导入值不一致时拒绝）
//  - 卖出校验：不存在持仓或卖出数量 > 持仓数量 → 拒绝
//  - 同日现金流与净值边界：写交易/现金流时记录 nav_cash_cutoff，供前端同日更新净值判断
const { pool } = require('../db/connection');
const { round } = require('../db/util');
const { todayCN } = require('../services/market');

// 业务错误（带 status，路由按 400/409 返回）
function bizError(msg, status = 400) {
  return Object.assign(new Error(msg), { status });
}

// 交易日期规范化：date 可为 "YYYY-MM-DD" 或 "YYYY-MM-DD HH:MM(:SS)"；返回 { tradeDate, executedAt }
function splitTradeDateTime(date, createdAt) {
  const d = String(date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(d)) throw bizError('交易日期格式错误');
  const tradeDate = d.slice(0, 10);
  let executedAt = d.length > 10 ? d : (createdAt || d);
  return { tradeDate, executedAt };
}

// 校验单笔交易字段（与 saveAccountData 的 validate 一致但更严格：amount=price×quantity）
// direction: buy/sell=真实成交；open=期初建仓（等效买入）；adjust=持仓调整（数量可正可负，仅校正数量/成本，无现金变动）
function validateTrade(t) {
  if (!t) throw bizError('交易数据缺失');
  const DIRS = ['buy', 'sell', 'open', 'adjust'];
  if (DIRS.indexOf(t.direction) === -1) throw bizError('交易方向非法');
  const price = Number(t.price);
  const quantity = Number(t.quantity);
  if (t.direction === 'adjust') {
    // 持仓调整：数量 = 调整后目标数量（绝对设置，可为 0=清仓；负数非法）
    if (!isFinite(quantity) || quantity < 0) throw bizError('调整数量不能为负数');
  } else {
    if (!isFinite(price) || price <= 0) throw bizError('交易价格必须为正数');
    if (!isFinite(quantity) || quantity <= 0) throw bizError('交易数量必须为正数');
  }
  // amount 服务端统一计算（四舍五入到分）；期初/调整事件不产生现金，不校验金额
  const expectAmount = Math.round(price * quantity * 100) / 100;
  const provided = t.amount == null ? null : Number(t.amount);
  if (t.direction === 'buy' || t.direction === 'sell') {
    if (provided != null && isFinite(provided) && Math.abs(provided - expectAmount) > 0.02) {
      throw bizError('成交金额与 价格×数量 不一致（' + provided + ' ≠ ' + expectAmount + '），请核对后重试');
    }
  }
  // 费用非负（期初/调整事件费用应为 0）
  for (const f of ['commission', 'stamp_tax', 'transfer_fee', 'other_fee']) {
    const v = Number(t[f] || 0);
    if (!isFinite(v) || v < 0) throw bizError('费用不能为负数');
  }
  if (!t.code) throw bizError('证券代码缺失');
  return { price, quantity, amount: expectAmount };
}

// 读取当前持仓数量（按 code 聚合，含多 id 同一 code 的情况）
async function heldQuantity(client, username, accountName, code) {
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(quantity), 0) AS qty FROM positions
      WHERE username=$1 AND account_name=$2 AND code=$3`,
    [username, accountName, code]
  );
  return Number(rows[0] ? rows[0].qty : 0);
}

// 移动加权成本重算：按时间顺序重放该证券全部事件（buy/open 累加数量与成本；sell/adjust 增减数量）
// 返回 { quantity, cost }（cost=移动加权单位成本；无持仓时 cost 保留最后买入价）
// ⚠️ cost 允许为负数（用户确认 2026-08-03）：反复做 T（高抛低吸摊薄）会把持仓成本摊到负数，
//    这是正常现象，绝不强制 cost>=0（仅 price/amount/费用约束非负）。
// ⚠️ strict 模式下若出现"卖出超过可卖数量"（重放遇历史超卖），抛错——避免超卖被静默截断掩盖账本错误
async function recomputeSecurity(client, username, accountName, code, strict = false) {
  const { rows: trs } = await client.query(
    `SELECT id, direction, price, quantity, amount, commission, stamp_tax, transfer_fee, other_fee, trade_date, executed_at, date, created_at
       FROM trades WHERE username=$1 AND account_name=$2 AND code=$3
      ORDER BY COALESCE(trade_date, left(date,10)) ASC, COALESCE(executed_at, date, created_at) ASC, created_at ASC, id ASC`,
    [username, accountName, code]
  );
  let qty = 0;
  let cost = 0; // 移动加权单位成本（买入/期初参与加权）
  for (const t of trs) {
    const q = Number(t.quantity) || 0;
    const p = Number(t.price) || 0;
    if (t.direction === 'buy' || t.direction === 'open') {
      const oldTotal = cost * qty;
      const newTotal = oldTotal + p * q;
      qty += q;
      cost = qty > 0 ? newTotal / qty : 0;
    } else if (t.direction === 'adjust') {
      // 持仓调整：quantity = 调整后目标数量（绝对设置）；成本保持单位成本（若给了新成本则按新成本）
      const unitCost = p > 0 ? p : (qty > 0 ? cost : 0);
      qty = Math.max(0, q);
      cost = qty > 0 ? unitCost : 0;
    } else {
      // sell：只减数量，单位成本不变（移动加权法）
      if (strict && qty < q) {
        throw bizError('无法安全重放：' + t.date + ' 卖出 ' + q + ' 超过当时可卖 ' + qty + '（历史交易存在缺口或超卖，请用冲正交易处理）');
      }
      qty = Math.max(0, qty - q);
    }
  }
  return { quantity: qty, cost: qty > 0 ? round(cost, 4) : 0 };
}

// 交易净额（买入减/卖出加，含费用）—— 与 loadAccountData 现金公式一致
// open（期初建仓）/ adjust（持仓调整）不产生现金变动，净额为 0
function tradeNetDelta(t) {
  if (t.direction === 'open' || t.direction === 'adjust') return 0;
  const fee = (Number(t.commission) || 0) + (Number(t.stamp_tax) || 0) + (Number(t.transfer_fee) || 0) + (Number(t.other_fee) || 0);
  return (t.direction === 'buy') ? -(Number(t.amount) || 0) - fee : (Number(t.amount) || 0) - fee;
}

// 重算账户现金 = cash_base + 现金流净额 + 交易净额（与 loadAccountData 一致，写入 accounts.cash_base 之外的派生）
async function recomputeCash(client, username, accountName) {
  const { rows: am } = await client.query(
    'SELECT COALESCE(cash_base,0) AS cb FROM accounts WHERE username=$1 AND account_name=$2',
    [username, accountName]
  );
  const cashBase = Number(am[0] ? am[0].cb : 0);
  const { rows: cf } = await client.query(
    'SELECT COALESCE(SUM(amount),0) AS s FROM cash_flows WHERE username=$1 AND account_name=$2',
    [username, accountName]
  );
  const cfNet = Number(cf[0] ? cf[0].s : 0);
  const { rows: tr } = await client.query(
    `SELECT direction, amount, commission, stamp_tax, transfer_fee, other_fee
       FROM trades WHERE username=$1 AND account_name=$2`,
    [username, accountName]
  );
  let tradeNet = 0;
  for (const t of tr) tradeNet += tradeNetDelta(t);
  return round(cashBase + cfNet + tradeNet, 2);
}

// 标记受影响日期之后的净值需要重算 + 同步提升 account_data 版本（P0-1 验收修复）：
// 账本写操作必须在同一事务内提升 account_data 总版本与相关数据集版本，否则旧页面全量保存
// 仍以旧 version 校验通过，删除重建把账本新写入覆盖掉。
// dataset: 'trade' | 'position' | 'cashflow' | 'nav'（决定提升哪个数据集版本）
async function markNavDirty(client, username, accountName, fromDate, dataset) {
  const col = dataset === 'position' ? 'pos_version' :
    dataset === 'cashflow' ? 'cashflow_version' :
    dataset === 'nav' ? 'nav_version' : 'trade_version';
  // account_data 行可能不存在（账本首笔写入前）→ INSERT 兜底建行再提升
  await client.query(
    `INSERT INTO account_data (username, account_name, data, version, ${col}, nav_cash_cutoff)
     VALUES ($1,$2,'{}',0,0,$3)
     ON CONFLICT (username, account_name) DO NOTHING`,
    [username, accountName, fromDate || todayCN()]
  );
  await client.query(
    `UPDATE account_data
        SET nav_cash_cutoff=$3,
            version=COALESCE(version,0)+1,
            ${col}=COALESCE(${col},0)+1
      WHERE username=$1 AND account_name=$2`,
    [username, accountName, fromDate || todayCN()]
  );
}

// 返回服务端最新账户结果（供前端直接刷新内存，方案阶段二第 8 条）
async function loadLedgerResult(username, accountName) {
  const { loadAccountData } = require('../db/accounts');
  return await loadAccountData(username, accountName);
}

// 乐观锁版本校验（2026-08-04 并发验收）：在事务内比较 account_data.version。
// expectedVersion 为空/非法 → 跳过（兼容纯数据层调用/测试）；不一致 → 409 拒绝，防多窗口后写覆盖先写。
// FOR UPDATE 行锁：两个请求真正同时到达时，第一个锁行，第二个阻塞到第一个提交后
// 再读到新版本 → 409，杜绝"都读到旧版本同时通过"的竞态（2026-08-04 第二轮修复）。
async function checkVersionInTxn(client, username, accountName, expectedVersion) {
  if (expectedVersion == null || expectedVersion === '') return;
  const ev = Number(expectedVersion);
  if (!Number.isFinite(ev)) return;
  const { rows } = await client.query(
    'SELECT COALESCE(version,0) AS v FROM account_data WHERE username=$1 AND account_name=$2 FOR UPDATE',
    [username, accountName]
  );
  const cur = rows[0] ? Number(rows[0].v) : 0;
  if (cur !== ev) throw bizError('数据已在其他窗口被修改，请刷新页面后重试', 409);
}

// ========== 主入口：新增交易（事务） ==========
// trade 字段：{ id?, code, name?, direction, price, quantity, amount?, commission?, stamp_tax?,
//              transfer_fee?, other_fee?, type?, subtype?, note?, date, created_at?, import_batch_id? }
// opts: { replaceId? } 替换已存在交易（修改场景）
// externalClient: 外部传入的 client（批量导入时由调用方开大事务，本函数不自行 BEGIN/COMMIT/RELEASE）
// expectedVersion: 乐观锁版本（事务内校验 account_data.version，不一致 409）
async function applyTrade(username, accountName, trade, externalClient = null, expectedVersion = null) {
  const t = Object.assign({}, trade);
  const { price, quantity, amount } = validateTrade(t);
  const { tradeDate, executedAt } = splitTradeDateTime(t.date, t.created_at);
  const client = externalClient || await pool.connect();
  const ownTxn = !externalClient;
  try {
    if (ownTxn) await client.query('BEGIN');
    // 幂等预检（2026-08-04）：event.id 已存在 → 直接返回成功，不校验版本。
    // 放在版本校验之前：双击/网络重试的第二个请求携带同一 id 与同一旧版本号，
    // 若先校验版本会因第一个请求已 +1 而 409，与"幂等不新增"的语义矛盾。
    if (t.id) {
      const idDup = await client.query(
        'SELECT id FROM trades WHERE id=$1 AND username=$2 AND account_name=$3',
        [t.id, username, accountName]
      );
      if (idDup.rows[0]) {
        if (ownTxn) await client.query('COMMIT');
        return { ok: true, id: t.id, skipped: 'duplicate', cash: null, tradeDate: tradeDate };
      }
    }
    // 乐观锁：独立事务时校验版本（外部事务由调用方统一校验一次）
    if (ownTxn) await checkVersionInTxn(client, username, accountName, expectedVersion);
    // P0-4（验收修复）：账户级并发锁——同账户的交易写入串行化。
    // 若账户行不存在（新账户首笔交易），INSERT ... ON CONFLICT 兜底建行并锁住；
    // 用 pg_advisory_xact_lock 按 (username,account_name) 哈希串行，保证两笔并发卖出不会同时通过校验。
    const { rows: lockRows } = await client.query(
      `SELECT id FROM accounts WHERE username=$1 AND account_name=$2 FOR UPDATE`,
      [username, accountName]
    );
    let accountId = lockRows.length ? lockRows[0].id : null;
    if (lockRows.length === 0) {
      const acctId = require('crypto').createHash('sha256').update(username + '\n' + accountName).digest('hex');
      await client.query(
        `INSERT INTO accounts (id, username, account_name, cash_base, hk_rate, version, updated_at)
         VALUES ($1,$2,$3,0,0.868,0,to_char(now(),'YYYY-MM-DD HH24:MI:SS'))
         ON CONFLICT (username, account_name) DO NOTHING`,
        [acctId, username, accountName]
      );
      const re = await client.query(`SELECT id FROM accounts WHERE username=$1 AND account_name=$2 FOR UPDATE`, [username, accountName]);
      accountId = re.rows[0].id;
    }
    // 卖出校验：可卖数量 = 当前持仓 + 本笔卖出自身数量（若为替换已有卖出，则 + 被替换卖出量）
    if (t.direction === 'sell') {
      const held = await heldQuantity(client, username, accountName, t.code);
      let avail = held;
      if (t.id) {
        const old = await client.query(
          'SELECT direction, quantity FROM trades WHERE username=$1 AND account_name=$2 AND id=$3',
          [username, accountName, t.id]
        );
        if (old.rows[0]) {
          const o = old.rows[0];
          if (o.direction === 'sell') avail += Number(o.quantity) || 0; // 被替换的旧卖出不算占用
          else avail -= Number(o.quantity) || 0; // 旧买入先回滚再重放
        }
      }
      if (avail < quantity) {
        throw bizError('卖出数量超过当前可用持仓（可卖 ' + Math.max(0, avail) + '，卖出 ' + quantity + '）');
      }
    }
    // 写交易（替换走 UPDATE，新增走 INSERT；ON CONFLICT 兜底幂等）
    const tradeId = t.id || require('crypto').randomBytes(8).toString('hex');
    // P1-4 服务端导入幂等：同账户+同批次+代码+交易日+方向+价格+数量 视为重复导入，跳过（不新增、不重算）
    // 验收修复：查重必须限定 username/account_name，防相同批次号跨账户互相冲突
    if (t.import_batch_id) {
      const dup = await client.query(
        `SELECT id FROM trades WHERE username=$1 AND account_name=$2 AND import_batch_id=$3
           AND code=$4 AND trade_date=$5 AND direction=$6 AND price=$7 AND quantity=$8 LIMIT 1`,
        [username, accountName, t.import_batch_id, t.code, tradeDate, t.direction, price, quantity]
      );
      if (dup.rows[0]) {
        if (ownTxn) await client.query('COMMIT');
        return { ok: true, id: dup.rows[0].id, skipped: 'duplicate', cash: null, tradeDate: tradeDate };
      }
    }
    await client.query(
      `INSERT INTO trades (id, username, account_name, account_id, date, created_at, trade_date, executed_at, import_batch_id,
                           code, name, direction, price, quantity, amount,
                           commission, stamp_tax, transfer_fee, other_fee, type, subtype, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
       ON CONFLICT (id, username, account_name) DO UPDATE SET
         date=EXCLUDED.date, created_at=EXCLUDED.created_at, trade_date=EXCLUDED.trade_date,
         executed_at=EXCLUDED.executed_at, import_batch_id=EXCLUDED.import_batch_id,
         code=EXCLUDED.code, name=EXCLUDED.name, direction=EXCLUDED.direction,
         price=EXCLUDED.price, quantity=EXCLUDED.quantity, amount=EXCLUDED.amount,
         commission=EXCLUDED.commission, stamp_tax=EXCLUDED.stamp_tax, transfer_fee=EXCLUDED.transfer_fee,
         other_fee=EXCLUDED.other_fee, type=EXCLUDED.type, subtype=EXCLUDED.subtype, note=EXCLUDED.note`,
      [tradeId, username, accountName, accountId, t.date || '', t.created_at || nowStr(), tradeDate, executedAt,
       t.import_batch_id || null,
       t.code, t.name || '', t.direction, price, quantity, amount,
       round(Number(t.commission) || 0, 4), round(Number(t.stamp_tax) || 0, 4),
       round(Number(t.transfer_fee) || 0, 4), round(Number(t.other_fee) || 0, 4),
       t.type || '', t.subtype || '', t.note || '']
    );
    // 重算该证券持仓：数量 + 移动加权成本（写 cost，不写 price）
    const sec = await recomputeSecurity(client, username, accountName, t.code);
    // 更新或新建持仓行（保持现有行的 price=当前行情价不动；仅更新 quantity/cost）
    const pos = await client.query(
      'SELECT id FROM positions WHERE username=$1 AND account_name=$2 AND code=$3 LIMIT 1',
      [username, accountName, t.code]
    );
    if (pos.rows[0]) {
      if (sec.quantity > 0) {
        // 2026-08-04 阻断修复：adjust 时同步名称/类型/细类/备注（非空才更新，防覆盖已有值），
        // 否则服务器返回后会把页面上刚改的元数据恢复成旧值
        await client.query(
          `UPDATE positions SET quantity=$4, cost=$5,
             name=CASE WHEN $6<>'' THEN $6 ELSE name END,
             type=CASE WHEN $7<>'' THEN $7 ELSE type END,
             subtype=CASE WHEN $8<>'' THEN $8 ELSE subtype END,
             note=CASE WHEN $9<>'' THEN $9 ELSE note END
           WHERE username=$1 AND account_name=$2 AND code=$3`,
          [username, accountName, t.code, sec.quantity, sec.cost,
           t.name || '', t.type || '', t.subtype || '', t.note || '']
        );
      } else {
        // 全部卖出 → 持仓归零删除
        await client.query(
          `DELETE FROM positions WHERE username=$1 AND account_name=$2 AND code=$3`,
          [username, accountName, t.code]
        );
      }
      // 多余同 code 行（历史重复）合并删除：保留一行，其余删除
      await client.query(
        `DELETE FROM positions WHERE username=$1 AND account_name=$2 AND code=$3
           AND id <> (SELECT id FROM positions WHERE username=$1 AND account_name=$2 AND code=$3 LIMIT 1)`,
        [username, accountName, t.code]
      );
    } else if (sec.quantity > 0) {
      // 首次建仓：cost=移动加权成本；price 用成交价作为初始行情价（后续行情刷新覆盖）
      const posId = require('crypto').randomBytes(8).toString('hex');
      await client.query(
        `INSERT INTO positions (id, username, account_name, account_id, code, name, price, quantity, cost, type, subtype, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'')`,
        [posId, username, accountName, accountId, t.code, t.name || '', price, sec.quantity, sec.cost, t.type || '股权', t.subtype || '']
      );
    }
    // 标记净值边界 + 同步提升 account_data 总版本/交易版本（P0-1：防旧页面全量保存覆盖）
    await markNavDirty(client, username, accountName, tradeDate, 'trade');
    // 账户修订号（accounts 表版本，与 account_data 版本各自独立语义）
    await client.query(
      `UPDATE accounts SET version=COALESCE(version,0)+1, updated_at=to_char(now(),'YYYY-MM-DD HH24:MI:SS')
        WHERE username=$1 AND account_name=$2`,
      [username, accountName]
    );
    const cash = await recomputeCash(client, username, accountName);
    if (ownTxn) await client.query('COMMIT');
    return { ok: true, id: tradeId, cash: cash, tradeDate: tradeDate };
  } catch (e) {
    if (ownTxn) await client.query('ROLLBACK');
    throw e;
  } finally {
    if (ownTxn) client.release();
  }
}

// ========== 批量期初建仓/调整（单事务，2026-08-04 阻断修复） ==========
// 原实现循环调用 applyTrade 各自开事务，中间一条失败 → 前面已入库，出现"提示失败但导入了一部分"。
// 改为外部传入同一 client，所有事件在同一个事务内执行：任一条失败 → 整体 ROLLBACK。
// expectedVersion：批量开始时校验一次 account_data.version（乐观锁）。
async function applyTradesBatch(username, accountName, events, expectedVersion = null) {
  const client = await pool.connect();
  const ids = [];
  try {
    await client.query('BEGIN');
    await checkVersionInTxn(client, username, accountName, expectedVersion);
    for (const event of events) {
      const r = await applyTrade(username, accountName, event, client);
      ids.push(r.id);
    }
    await client.query('COMMIT');
    return { ok: true, ids, added: ids.length };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ========== 删除交易（事务） ==========
// 策略（方案阶段二）：从被删交易日起重放该证券持仓与账户现金；被删交易不是最后一条时，
// 由重放逻辑自然处理（删除后剩余交易按序重算数量/成本/现金）。
// expectedVersion：乐观锁版本（2026-08-04 第三轮修复：删除也必须在同一事务内校验版本，
// 否则旧窗口仍能删除新窗口正在处理的数据）
async function deleteTrade(username, accountName, tradeId, expectedVersion = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await checkVersionInTxn(client, username, accountName, expectedVersion);
    // 账户级并发锁（与 applyTrade 同锁，防删除与新增并发交错）
    await client.query(`SELECT id FROM accounts WHERE username=$1 AND account_name=$2 FOR UPDATE`, [username, accountName]);
    const del = await client.query(
      'DELETE FROM trades WHERE username=$1 AND account_name=$2 AND id=$3 RETURNING code, date, trade_date',
      [username, accountName, tradeId]
    );
    if (del.rowCount === 0) throw bizError('交易不存在', 404);
    const code = del.rows[0].code;
    // 重放该证券：剩余交易若出现超卖（历史缺口/后续依赖）→ strict 抛错拒绝删除，改用冲正交易
    const sec = await recomputeSecurity(client, username, accountName, code, true);
    const pos = await client.query(
      'SELECT id FROM positions WHERE username=$1 AND account_name=$2 AND code=$3 LIMIT 1',
      [username, accountName, code]
    );
    if (pos.rows[0]) {
      if (sec.quantity > 0) {
        await client.query(
          `UPDATE positions SET quantity=$4, cost=$5 WHERE username=$1 AND account_name=$2 AND code=$3`,
          [username, accountName, code, sec.quantity, sec.cost]
        );
      } else {
        await client.query(
          `DELETE FROM positions WHERE username=$1 AND account_name=$2 AND code=$3`,
          [username, accountName, code]
        );
      }
    }
    // 重算现金 + 修订号
    const fromDate = del.rows[0].trade_date || todayCN();
    await markNavDirty(client, username, accountName, fromDate, 'trade');
    await client.query(
      `UPDATE accounts SET version=COALESCE(version,0)+1, updated_at=to_char(now(),'YYYY-MM-DD HH24:MI:SS')
        WHERE username=$1 AND account_name=$2`,
      [username, accountName]
    );
    const cash = await recomputeCash(client, username, accountName);
    await client.query('COMMIT');
    return { ok: true, cash: cash, fromDate: fromDate };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// 清空全部交易（P1-1 验收修复）：清空交易会立即制造账实不一致（持仓还在、交易依据消失、现金跳变）。
// 整改：禁止直接清空——返回业务错误，提示用户逐笔删除或用期初事件重建。
async function clearTrades(username, accountName) {
  throw bizError('不支持直接清空全部交易：清空会破坏持仓与现金的一致性。请逐笔删除交易，或用期初/调整事件重建持仓。');
}

// 删除单条现金流（方案阶段一第 5 条：删除后立即重算现金并返回最新结果）
// expectedVersion：乐观锁版本（2026-08-04 第三轮修复：删除也须事务内校验版本）
async function deleteCashFlow(username, accountName, flowId, expectedVersion = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await checkVersionInTxn(client, username, accountName, expectedVersion);
    // 读取被删现金流原日期（验收修复：历史净值须从该日期起重算，而非仅今天）
    const del = await client.query(
      'DELETE FROM cash_flows WHERE username=$1 AND account_name=$2 AND id=$3 RETURNING id, date',
      [username, accountName, flowId]
    );
    if (del.rowCount === 0) throw bizError('现金流记录不存在', 404);
    const fromDate = (del.rows[0].date || '').slice(0, 10) || todayCN();
    // 现金流变更 → 提升 account_data 总版本 + cashflow_version（P0-1）
    await markNavDirty(client, username, accountName, fromDate, 'cashflow');
    await client.query(
      `UPDATE accounts SET version=COALESCE(version,0)+1, updated_at=to_char(now(),'YYYY-MM-DD HH24:MI:SS')
        WHERE username=$1 AND account_name=$2`,
      [username, accountName]
    );
    const cash = await recomputeCash(client, username, accountName);
    await client.query('COMMIT');
    return { ok: true, cash: cash, fromDate: fromDate };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// 当前时间字符串 YYYY-MM-DD HH:MM:SS
function nowStr() {
  const d = new Date();
  const cn = new Date(d.getTime() + (d.getTimezoneOffset() + 480) * 60000);
  const p = n => String(n).padStart(2, '0');
  return cn.getUTCFullYear() + '-' + p(cn.getUTCMonth() + 1) + '-' + p(cn.getUTCDate()) + ' ' +
    p(cn.getUTCHours()) + ':' + p(cn.getUTCMinutes()) + ':' + p(cn.getUTCSeconds());
}

// 新增现金流（方案阶段二-2：局部接口替代 saveData 全量保存）
// cf.id 由前端生成（幂等键）：同一 id 重复提交 → ON CONFLICT DO NOTHING，不新增第二条（2026-08-04 修复）
// expectedVersion：乐观锁版本（事务内校验 account_data.version，不一致 409）
async function addCashFlow(username, accountName, cf, expectedVersion = null) {
  if (!cf || typeof cf.amount !== 'number' || isNaN(cf.amount)) throw bizError('请填写有效的金额');
  const date = (cf.date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw bizError('日期格式错误');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 幂等预检（2026-08-04）：同一 cf.id 已存在 → 直接返回成功，不校验版本
    // （双击/网络重试的第二个请求带同一 id 与同一旧版本号，若先校验版本会 409）
    if (cf.id) {
      const idDup = await client.query(
        'SELECT id FROM cash_flows WHERE id=$1 AND username=$2 AND account_name=$3',
        [cf.id, username, accountName]
      );
      if (idDup.rows[0]) {
        await client.query('COMMIT');
        const result = await loadLedgerResult(username, accountName);
        return { ok: true, id: cf.id, cash: null, data: result, skipped: 'duplicate' };
      }
    }
    await checkVersionInTxn(client, username, accountName, expectedVersion);
    const { rows: aRows } = await client.query(
      'SELECT id FROM accounts WHERE username=$1 AND account_name=$2 FOR UPDATE',
      [username, accountName]
    );
    const accountId = aRows.length ? aRows[0].id : null;
    const flowId = cf.id || require('crypto').randomBytes(8).toString('hex');
    const createdAt = cf.created_at || nowStr();
    const ins = await client.query(
      `INSERT INTO cash_flows (id, username, account_name, account_id, date, created_at, amount, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id, username, account_name) DO NOTHING`,
      [flowId, username, accountName, accountId, date, createdAt, round(cf.amount, 2), cf.note || '']
    );
    if (ins.rowCount === 0) {
      // 幂等命中：同一 id 已存在，不重复新增
      await client.query('COMMIT');
      const result = await loadLedgerResult(username, accountName);
      return { ok: true, id: flowId, cash: null, data: result, skipped: 'duplicate' };
    }
    await markNavDirty(client, username, accountName, date, 'cashflow');
    await client.query(
      `UPDATE accounts SET version=COALESCE(version,0)+1, updated_at=to_char(now(),'YYYY-MM-DD HH24:MI:SS')
        WHERE username=$1 AND account_name=$2`,
      [username, accountName]
    );
    const cash = await recomputeCash(client, username, accountName);
    await client.query('COMMIT');
    const result = await loadLedgerResult(username, accountName);
    return { ok: true, id: flowId, cash, data: result };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = {
  applyTrade,
  applyTradesBatch,
  checkVersionInTxn,
  loadLedgerResult,
  deleteTrade,
  clearTrades,
  addCashFlow,
  deleteCashFlow,
  recomputeSecurity,
  recomputeCash,
  validateTrade,
  splitTradeDateTime,
  bizError,
  tradeNetDelta,
};

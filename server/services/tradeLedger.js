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
function validateTrade(t) {
  if (!t) throw bizError('交易数据缺失');
  if (t.direction !== 'buy' && t.direction !== 'sell') throw bizError('交易方向非法');
  const price = Number(t.price);
  const quantity = Number(t.quantity);
  if (!isFinite(price) || price <= 0) throw bizError('交易价格必须为正数');
  if (!isFinite(quantity) || quantity <= 0) throw bizError('交易数量必须为正数');
  // amount 服务端统一计算（四舍五入到分），与前端显示口径一致；导入值不一致拒绝（方案阶段一第 4 条）
  const expectAmount = Math.round(price * quantity * 100) / 100;
  const provided = t.amount == null ? null : Number(t.amount);
  if (provided != null && isFinite(provided) && Math.abs(provided - expectAmount) > 0.02) {
    throw bizError('成交金额与 价格×数量 不一致（' + provided + ' ≠ ' + expectAmount + '），请核对后重试');
  }
  // 费用非负
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

// 移动加权成本重算：按时间顺序重放该证券全部交易（仅 buy/sell 影响数量与成本）
// 返回 { quantity, cost }（cost=移动加权单位成本；无持仓时 cost 保留最后买入价）
// ⚠️ strict 模式下若出现"卖出超过可卖数量"（重放遇历史超卖），抛错——避免超卖被静默截断掩盖账本错误
async function recomputeSecurity(client, username, accountName, code, strict = false) {
  const { rows: trs } = await client.query(
    `SELECT id, direction, price, quantity, amount, commission, stamp_tax, transfer_fee, other_fee, trade_date, executed_at, date, created_at
       FROM trades WHERE username=$1 AND account_name=$2 AND code=$3
      ORDER BY COALESCE(trade_date, left(date,10)) ASC, COALESCE(executed_at, date, created_at) ASC, created_at ASC, id ASC`,
    [username, accountName, code]
  );
  let qty = 0;
  let cost = 0; // 移动加权单位成本（仅买入参与加权）
  for (const t of trs) {
    const q = Number(t.quantity) || 0;
    const p = Number(t.price) || 0;
    if (t.direction === 'buy') {
      const oldTotal = cost * qty;
      const newTotal = oldTotal + p * q;
      qty += q;
      cost = qty > 0 ? newTotal / qty : 0;
    } else {
      // 卖出只减数量，单位成本不变（移动加权法）
      if (strict && qty < q) {
        throw bizError('无法安全重放：' + t.date + ' 卖出 ' + q + ' 超过当时可卖 ' + qty + '（历史交易存在缺口或超卖，请用冲正交易处理）');
      }
      qty = Math.max(0, qty - q);
    }
  }
  return { quantity: qty, cost: qty > 0 ? round(cost, 4) : 0 };
}

// 交易净额（买入减/卖出加，含费用）—— 与 loadAccountData 现金公式一致
function tradeNetDelta(t) {
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

// 标记受影响日期之后的净值需要重算（在 account_data 记录 dirty 标记；实际重算由前端 recompute-nav 触发）
async function markNavDirty(client, username, accountName, fromDate) {
  await client.query(
    `UPDATE account_data SET nav_cash_cutoff=$3
      WHERE username=$1 AND account_name=$2`,
    [username, accountName, fromDate || todayCN()]
  );
}

// 返回服务端最新账户结果（供前端直接刷新内存，方案阶段二第 8 条）
async function loadLedgerResult(username, accountName) {
  const { loadAccountData } = require('../db/accounts');
  return await loadAccountData(username, accountName);
}

// ========== 主入口：新增交易（事务） ==========
// trade 字段：{ id?, code, name?, direction, price, quantity, amount?, commission?, stamp_tax?,
//              transfer_fee?, other_fee?, type?, subtype?, note?, date, created_at?, import_batch_id? }
// opts: { replaceId? } 替换已存在交易（修改场景）
async function applyTrade(username, accountName, trade) {
  const t = Object.assign({}, trade);
  const { price, quantity, amount } = validateTrade(t);
  const { tradeDate, executedAt } = splitTradeDateTime(t.date, t.created_at);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
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
    await client.query(
      `INSERT INTO trades (id, username, account_name, date, created_at, trade_date, executed_at, import_batch_id,
                           code, name, direction, price, quantity, amount,
                           commission, stamp_tax, transfer_fee, other_fee, type, subtype, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       ON CONFLICT (id, username, account_name) DO UPDATE SET
         date=EXCLUDED.date, created_at=EXCLUDED.created_at, trade_date=EXCLUDED.trade_date,
         executed_at=EXCLUDED.executed_at, import_batch_id=EXCLUDED.import_batch_id,
         code=EXCLUDED.code, name=EXCLUDED.name, direction=EXCLUDED.direction,
         price=EXCLUDED.price, quantity=EXCLUDED.quantity, amount=EXCLUDED.amount,
         commission=EXCLUDED.commission, stamp_tax=EXCLUDED.stamp_tax, transfer_fee=EXCLUDED.transfer_fee,
         other_fee=EXCLUDED.other_fee, type=EXCLUDED.type, subtype=EXCLUDED.subtype, note=EXCLUDED.note`,
      [tradeId, username, accountName, t.date || '', t.created_at || nowStr(), tradeDate, executedAt,
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
        await client.query(
          `UPDATE positions SET quantity=$4, cost=$5 WHERE username=$1 AND account_name=$2 AND code=$3`,
          [username, accountName, t.code, sec.quantity, sec.cost]
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
        `INSERT INTO positions (id, username, account_name, code, name, price, quantity, cost, type, subtype, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'')`,
        [posId, username, accountName, t.code, t.name || '', price, sec.quantity, sec.cost, t.type || '股权', t.subtype || '']
      );
    }
    // 更新账户修订号 + 现金派生（accounts 表不存现金，仅提升修订号）
    await client.query(
      `UPDATE accounts SET version=COALESCE(version,0)+1, updated_at=to_char(now(),'YYYY-MM-DD HH24:MI:SS')
        WHERE username=$1 AND account_name=$2`,
      [username, accountName]
    );
    // 标记净值边界（同日现金流/交易 → 需要重算当天及之后净值）
    await markNavDirty(client, username, accountName, tradeDate);
    const cash = await recomputeCash(client, username, accountName);
    await client.query('COMMIT');
    return { ok: true, id: tradeId, cash: cash, tradeDate: tradeDate };
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
async function deleteTrade(username, accountName, tradeId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
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
    await client.query(
      `UPDATE accounts SET version=COALESCE(version,0)+1, updated_at=to_char(now(),'YYYY-MM-DD HH24:MI:SS')
        WHERE username=$1 AND account_name=$2`,
      [username, accountName]
    );
    await markNavDirty(client, username, accountName, del.rows[0].trade_date || todayCN());
    const cash = await recomputeCash(client, username, accountName);
    await client.query('COMMIT');
    return { ok: true, cash: cash };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// 清空全部交易：清空交易流水（不动持仓；现金重算 = cashBase + 现金流）
async function clearTrades(username, accountName) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM trades WHERE username=$1 AND account_name=$2', [username, accountName]);
    await client.query(
      `UPDATE accounts SET version=COALESCE(version,0)+1, updated_at=to_char(now(),'YYYY-MM-DD HH24:MI:SS')
        WHERE username=$1 AND account_name=$2`,
      [username, accountName]
    );
    const cash = await recomputeCash(client, username, accountName);
    await client.query('COMMIT');
    return { ok: true, cash: cash };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// 删除单条现金流（方案阶段一第 5 条：删除后立即重算现金并返回最新结果）
async function deleteCashFlow(username, accountName, flowId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const del = await client.query(
      'DELETE FROM cash_flows WHERE username=$1 AND account_name=$2 AND id=$3 RETURNING id',
      [username, accountName, flowId]
    );
    if (del.rowCount === 0) throw bizError('现金流记录不存在', 404);
    await client.query(
      `UPDATE accounts SET version=COALESCE(version,0)+1, updated_at=to_char(now(),'YYYY-MM-DD HH24:MI:SS')
        WHERE username=$1 AND account_name=$2`,
      [username, accountName]
    );
    const cash = await recomputeCash(client, username, accountName);
    await client.query('COMMIT');
    return { ok: true, cash: cash };
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

module.exports = {
  applyTrade,
  deleteTrade,
  clearTrades,
  deleteCashFlow,
  recomputeSecurity,
  recomputeCash,
  validateTrade,
  splitTradeDateTime,
  bizError,
  tradeNetDelta,
};

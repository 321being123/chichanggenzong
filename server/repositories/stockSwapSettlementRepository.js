const { pool } = require('../db/connection');

// 套利换股结算的数据访问：案件/持仓读取与结算单读写全部集中在此。
// 业务判定（标题筛选口径、比例校验、取整、幂等对账）仍在 stockSwapSettlement 服务内。

// 挂着「换股实施/登记类」公告的换股案件（含证据公告信息）。
async function selectImplementedSwapCases(patterns, client = pool) {
  const { rows } = await client.query(
    `SELECT c.case_id,
            c.event_status,
            c.target_instrument_id,
            c.reference_instrument_id,
            c.swap_ratio,
            c.target_swap_price,
            c.reference_swap_price,
            si.canonical_code AS source_code,
            si.name           AS source_name,
            si.status         AS source_status,
            si.delist_date::text AS source_delist_date,
            ev.document_id    AS evidence_document_id,
            ev.title          AS evidence_title,
            ev.announced_at   AS evidence_announced_at
       FROM event.arbitrage_cases c
       JOIN core.instruments si ON si.instrument_id = c.target_instrument_id
       JOIN LATERAL (
         SELECT doc.document_id, doc.title, doc.announced_at
           FROM event.arbitrage_case_documents ad
           JOIN event.documents doc ON doc.document_id = ad.document_id
          WHERE ad.case_id = c.case_id
            AND doc.title LIKE ANY($1::text[])
          ORDER BY doc.announced_at ASC, doc.document_id ASC
          LIMIT 1
       ) ev ON TRUE
      WHERE c.strategy_type = 'a_share_swap'
        AND COALESCE(c.swap_ratio, 0) > 0
        AND c.target_instrument_id IS NOT NULL
      ORDER BY ev.announced_at ASC, c.case_id ASC`,
    [patterns]
  );
  return rows;
}

// 带有效合并方（reference 与 target 不同）的换股案件，用于补齐 reference 为空的实施案。
async function selectSwapPairs(client = pool) {
  const { rows } = await client.query(
    `SELECT c.case_id,
            c.target_instrument_id,
            c.reference_instrument_id,
            c.swap_ratio,
            ri.canonical_code AS reference_code,
            ri.name           AS reference_name,
            ri.status         AS reference_status,
            ri.delist_date::text AS reference_delist_date
       FROM event.arbitrage_cases c
       JOIN core.instruments ri ON ri.instrument_id = c.reference_instrument_id
      WHERE c.strategy_type = 'a_share_swap'
        AND c.reference_instrument_id IS NOT NULL
        AND c.reference_instrument_id <> c.target_instrument_id
        AND COALESCE(c.swap_ratio, 0) > 0
      ORDER BY c.case_id`
  );
  return rows;
}

// 仍持有被合并方证券的账户持仓（按账户汇总数量与成本总额）。
async function selectSourceHoldings(sourceInstrumentId, code, client = pool) {
  const { rows } = await client.query(
    `SELECT username,
            account_name,
            MAX(account_id)              AS account_id,
            MAX(type)                    AS type,
            MAX(subtype)                 AS subtype,
            SUM(quantity)                AS quantity,
            SUM(quantity * cost)         AS cost_total
       FROM positions
      WHERE quantity > 0
        AND (instrument_id = $1 OR code = $2)
      GROUP BY username, account_name
      ORDER BY username, account_name`,
    [sourceInstrumentId, code]
  );
  return rows;
}

// 与账本及快照导入共享账户版本行锁，读持仓之前取得，缺失时失败关闭。
async function lockAccountVersion(username, accountName, client) {
  const { rows } = await client.query(
    'SELECT version FROM account_data WHERE username=$1 AND account_name=$2 FOR UPDATE',
    [username, accountName]
  );
  return rows[0] || null;
}

async function selectAccountSourceHolding(username, accountName, sourceInstrumentId, code, client) {
  const { rows } = await client.query(
    `SELECT MAX(account_id) AS account_id, MAX(type) AS type, MAX(subtype) AS subtype,
            COALESCE(SUM(quantity),0) AS quantity, COALESCE(SUM(quantity*cost),0) AS cost_total
       FROM positions WHERE username=$1 AND account_name=$2 AND quantity>0
        AND (instrument_id=$3 OR code=$4)`,
    [username, accountName, sourceInstrumentId, code]
  );
  return rows[0] || null;
}

// 当前剩余的被合并方持仓数量（用于幂等对账）。
async function selectCurrentSourceQuantity(username, accountName, sourceInstrumentId, code, client = pool) {
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(quantity), 0) AS quantity
       FROM positions
      WHERE username = $1 AND account_name = $2
        AND (instrument_id = $3 OR code = $4)`,
    [username, accountName, sourceInstrumentId, code]
  );
  return rows[0] || null;
}

// 账户原本已持有的合并方持仓（换股所得要与之合并）。
async function selectExistingTargetHolding(username, accountName, targetInstrumentId, code, client = pool) {
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(quantity), 0)            AS quantity,
            COALESCE(SUM(quantity * cost), 0)     AS cost_total,
            MAX(type)                             AS type,
            MAX(subtype)                          AS subtype
       FROM positions
      WHERE username = $1 AND account_name = $2
        AND (instrument_id = $3 OR code = $4)`,
    [username, accountName, targetInstrumentId, code]
  );
  return rows[0] || null;
}

// 结算单写入（唯一键冲突时不覆盖已执行结果）。
async function insertSettlement(plan, client = pool) {
  const { rows } = await client.query(
    `INSERT INTO event.stock_swap_settlements
       (case_id, username, account_name, account_id, source_instrument_id, target_instrument_id,
        settlement_date, ratio_applied, source_quantity, target_quantity, existing_target_quantity,
        cost_total_before, cost_unit_after, status, evidence_document_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending',$14)
     ON CONFLICT (case_id, username, account_name, source_instrument_id) DO NOTHING
     RETURNING *`,
    [plan.case_id, plan.username, plan.account_name, plan.account_id,
     plan.source_instrument_id, plan.target_instrument_id, plan.settlement_date,
     plan.ratio_applied, plan.source_quantity, plan.target_quantity, plan.existing_target_quantity,
     plan.cost_total_before, plan.cost_unit_after, plan.evidence_document_id]
  );
  return rows[0] || null;
}

// 按唯一键范围读取既有结算单。
async function selectSettlementByScope(caseId, username, accountName, sourceInstrumentId, client = pool) {
  const { rows } = await client.query(
    `SELECT * FROM event.stock_swap_settlements
      WHERE case_id=$1 AND username=$2 AND account_name=$3 AND source_instrument_id=$4`,
    [caseId, username, accountName, sourceInstrumentId]
  );
  return rows[0] || null;
}

// 更新结算状态与执行结果。
async function updateSettlementStatus(settlementId, status, patch = {}, client = pool) {
  await client.query(
    `UPDATE event.stock_swap_settlements
        SET status = $2,
            applied_trade_ids = COALESCE($3::jsonb, applied_trade_ids),
            error_message = $4,
            applied_at = CASE WHEN $2 = 'applied' THEN now() ELSE applied_at END,
            updated_at = now()
      WHERE settlement_id = $1`,
    [settlementId, status,
     patch.tradeIds ? JSON.stringify(patch.tradeIds) : null,
     patch.error ? String(patch.error).slice(0, 1000) : null]
  );
}

module.exports = {
  selectImplementedSwapCases,
  selectSwapPairs,
  selectSourceHoldings,
  selectCurrentSourceQuantity,
  lockAccountVersion,
  selectAccountSourceHolding,
  selectExistingTargetHolding,
  insertSettlement,
  selectSettlementByScope,
  updateSettlementStatus,
};

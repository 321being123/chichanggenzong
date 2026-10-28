const { pool } = require('../db/connection');

// 自 server/services/cashIncomeActual.js 抽取的 SQL 执行函数：语句原样搬迁，返回 pg 原始结果（rows/rowCount），调用方零改动。
async function select_accounts(params, client = pool) {
  return client.query(`SELECT id FROM accounts WHERE username=$1 AND account_name=$2 FOR UPDATE`, params);
}

async function select_cash_flows(params, client = pool) {
  return client.query(`SELECT *,date::text FROM cash_flows WHERE account_id=$1 AND event_key=$2 AND flow_type=$3 FOR UPDATE`, params);
}

async function select_cash_flows_1(params, client = pool) {
  return client.query(`SELECT 1 FROM cash_flows WHERE account_id=$1 AND event_key=$2 UNION ALL SELECT 1 FROM account_cash_income_pending WHERE account_id=$1 AND event_key=$2 LIMIT 1`, params);
}

async function select_account_cash_income_pending(params, client = pool) {
  return client.query(`SELECT evidence FROM account_cash_income_pending WHERE account_id=$1 AND event_key=$2`, params);
}

async function insert_cash_flow_revisions(params, client = pool) {
  return client.query(`INSERT INTO cash_flow_revisions(account_id,flow_id,event_key,revision,before_value,after_value,reason,actor) VALUES($1,$2,$3,$4,$5,$6,'broker_actual_import',$7)`, params);
}

async function insert_cash_flows(params, client = pool) {
  return client.query(`INSERT INTO cash_flows(id,username,account_name,account_id,date,amount,amount_cny,flow_type,origin,status,event_key,anchor_date,quality_status,calculation_version,evidence,source_ref,revision,note,currency,original_amount,settled_at)
        VALUES($1,$2,$3,$4,$5,$6,$6,$7,'system',$13,$8,$9,'broker_confirmed','cash-income-v1',$10,$11,$12,'券商实际收益补录',$14,$15,$16)
        ON CONFLICT(username,account_name,id) DO UPDATE SET date=EXCLUDED.date,amount=EXCLUDED.amount,amount_cny=EXCLUDED.amount_cny,status=EXCLUDED.status,quality_status='broker_confirmed',evidence=EXCLUDED.evidence,source_ref=EXCLUDED.source_ref,revision=EXCLUDED.revision,currency=EXCLUDED.currency,original_amount=EXCLUDED.original_amount,settled_at=EXCLUDED.settled_at`, params);
}

module.exports = {
  select_accounts,
  select_cash_flows,
  select_cash_flows_1,
  select_account_cash_income_pending,
  insert_cash_flow_revisions,
  insert_cash_flows,
};

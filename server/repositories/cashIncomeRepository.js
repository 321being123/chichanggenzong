const { pool } = require('../db/connection');

// 自 server/services/cashIncome.js 抽取的 SQL 执行函数：语句原样搬迁，返回 pg 原始结果（rows/rowCount），调用方零改动。
async function select_accounts(params, client = pool) {
  return client.query(`SELECT id,cash_income_policy,cash_income_state FROM accounts WHERE username=$1 AND account_name=$2`, params);
}

async function select_trades(params, client = pool) {
  return client.query(`SELECT * FROM trades WHERE username=$1 AND account_name=$2 ORDER BY id`, params);
}

async function select_cash_flows(params, client = pool) {
  return client.query(`SELECT *,date::text,anchor_date::text FROM cash_flows WHERE username=$1 AND account_name=$2 ORDER BY id`, params);
}

async function select_positions(params, client = pool) {
  return client.query(`SELECT code,instrument_id,quantity,type,subtype FROM positions WHERE username=$1 AND account_name=$2 ORDER BY id`, params);
}

async function select_fundamental_corporate_actions(params, client = pool) {
  return client.query(`SELECT *,record_date::text,pay_date::text,ex_date::text FROM fundamental.corporate_actions
    WHERE action_type='dividend' AND instrument_id=ANY($1::bigint[]) AND pay_date <= $2::date ORDER BY action_id`, params);
}

async function select_account_cash_income_pending(params, client = pool) {
  return client.query(`SELECT event_key FROM account_cash_income_pending WHERE account_id=$1 AND state='excluded_by_user' AND event_key IS NOT NULL`, params);
}

async function select_ops_sync_cursors(params, client = pool) {
  return client.query(`SELECT scope_key,last_success_date::text,cursor_payload FROM ops.sync_cursors WHERE dataset_code='stock_cash_dividend_facts' AND scope_key=ANY($1::text[])`, params);
}

async function select_market_fx_rates(params, client = pool) {
  return client.query(`SELECT base_currency,quote_currency,rate_date::text,rate::text,source_id FROM market.fx_rates WHERE quote_currency='CNY' AND rate_date <= $1 ORDER BY rate_date,source_id`, params);
}

async function select_market_trade_calendar(params, client = pool) {
  return client.query(`SELECT trade_date::text,is_open,source_code,raw_payload FROM market.trade_calendar WHERE exchange='HKEX'`);
}

async function select_account_data(params, client = pool) {
  return client.query(`SELECT version FROM account_data WHERE username=$1 AND account_name=$2`, params);
}

async function select_accounts_1(params, client = pool) {
  return client.query(`SELECT id FROM accounts WHERE id=$1 FOR UPDATE`, params);
}

async function select_account_data_1(params, client = pool) {
  return client.query(`SELECT version FROM account_data WHERE username=$1 AND account_name=$2 FOR UPDATE`, params);
}

async function insert_cash_flow_revisions(params, client = pool) {
  return client.query(`INSERT INTO cash_flow_revisions(account_id,flow_id,event_key,revision,before_value,after_value,reason,actor)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, params);
}

async function insert_cash_flows(params, client = pool) {
  return client.query(`INSERT INTO cash_flows(id,username,account_name,account_id,date,amount,amount_cny,flow_type,origin,status,event_key,
        anchor_date,instrument_id,quality_status,calculation_version,evidence,note,revision,created_at)
        VALUES($1,$2,$3,$4,$5::date,$6,$6,$7,'system',$8,$9,$10::date,$11,$12,$13,$14,$15,$16,to_char(now(),'YYYY-MM-DD HH24:MI:SS'))
        ON CONFLICT(username,account_name,id) DO UPDATE SET date=EXCLUDED.date,amount=EXCLUDED.amount,amount_cny=EXCLUDED.amount_cny,
          status=EXCLUDED.status,anchor_date=EXCLUDED.anchor_date,quality_status=EXCLUDED.quality_status,evidence=EXCLUDED.evidence,
          revision=EXCLUDED.revision,calculation_version=EXCLUDED.calculation_version,note=EXCLUDED.note`, params);
}

async function update_cash_flows(params, client = pool) {
  return client.query(`UPDATE cash_flows SET status='revoked',revision=$2 WHERE username=$3 AND account_name=$4 AND id=$1`, params);
}

async function update_accounts(params, client = pool) {
  return client.query(`UPDATE accounts SET cash_income_policy=$2,cash_income_state=$3 WHERE id=$1`, params);
}

async function select_cash_flows_1(params, client = pool) {
  return client.query(`SELECT *,date::text FROM cash_flows WHERE account_id=$1`, params);
}

async function select_nav_history(params, client = pool) {
  return client.query(`SELECT *,date::text FROM nav_history WHERE username=$1 AND account_name=$2
      AND date >= $3 ORDER BY date FOR UPDATE`, params);
}

async function update_nav_history(params, client = pool) {
  return client.query(`UPDATE nav_history SET total_asset=$4,nav=$5,calc_status='estimated',diagnostics=$6,
          snapshot_at=CASE WHEN $7::boolean THEN $8 ELSE snapshot_at END
          WHERE username=$1 AND account_name=$2 AND date=$3`, params);
}

async function update_accounts_1(params, client = pool) {
  return client.query(`UPDATE accounts SET cash_income_state=$2 WHERE id=$1`, params);
}

async function update_account_data(params, client = pool) {
  return client.query(`UPDATE account_data SET nav_version=COALESCE(nav_version,0)+1,
      version=COALESCE(version,0)+1 WHERE username=$1 AND account_name=$2`, params);
}

module.exports = {
  select_accounts,
  select_trades,
  select_cash_flows,
  select_positions,
  select_fundamental_corporate_actions,
  select_account_cash_income_pending,
  select_ops_sync_cursors,
  select_market_fx_rates,
  select_market_trade_calendar,
  select_account_data,
  select_accounts_1,
  select_account_data_1,
  insert_cash_flow_revisions,
  insert_cash_flows,
  update_cash_flows,
  update_accounts,
  select_cash_flows_1,
  select_nav_history,
  update_nav_history,
  update_accounts_1,
  update_account_data,
};

const { pool } = require('../db/connection');

// 自 server/services/cashIncomeCoverage.js 抽取的 SQL 执行函数：语句原样搬迁，返回 pg 原始结果（rows/rowCount），调用方零改动。
async function select_accounts(params, client = pool) {
  return client.query(`SELECT id,cash_income_policy,cash_income_state FROM accounts WHERE username=$1 AND account_name=$2`, params);
}

async function select_positions(params, client = pool) {
  return client.query(`SELECT code,name,type,subtype,instrument_id,'position' AS origin FROM positions WHERE username=$1 AND account_name=$2
      UNION ALL SELECT code,name,type,subtype,NULL,'trade' FROM trades WHERE username=$1 AND account_name=$2 AND COALESCE(trade_date,left(date,10)) <= $3
      UNION ALL SELECT instrument_code,'','','',NULL,'snapshot' FROM nav_position_snapshots WHERE username=$1 AND account_name=$2 AND snapshot_date <= $3::date`, params);
}

async function select_nav_position_snapshots(params, client = pool) {
  return client.query(`SELECT snapshot_date::text,source FROM nav_position_snapshots
        WHERE username=$1 AND account_name=$2 AND instrument_code=$3 AND snapshot_date <= $4::date`, params);
}

async function select_fundamental_corporate_actions(params, client = pool) {
  return client.query(`SELECT count(*)::int AS count FROM fundamental.corporate_actions
        WHERE instrument_id=$1 AND action_type='dividend'`, params);
}

module.exports = {
  select_accounts,
  select_positions,
  select_nav_position_snapshots,
  select_fundamental_corporate_actions,
};

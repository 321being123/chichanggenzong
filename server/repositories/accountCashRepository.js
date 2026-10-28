const { pool } = require('../db/connection');

async function loadCashInputs(username, accountName, client = pool) {
  const args = [username, accountName];
  const account = await client.query('SELECT cash_base::text FROM accounts WHERE username=$1 AND account_name=$2', args);
  const flows = await client.query(`SELECT id,date::text,amount::text,amount_cny::text,flow_type,origin,status,quality_status,evidence,settled_at,created_at,note
    FROM cash_flows WHERE username=$1 AND account_name=$2`, args);
  const trades = await client.query(`SELECT date,trade_date,executed_at,created_at,direction,amount::text,amount_cny::text,
    quote_currency,subtype,commission::text,stamp_tax::text,transfer_fee::text,other_fee::text
    FROM trades WHERE username=$1 AND account_name=$2`, args);
  const navs = await client.query(`SELECT date,cash_cny::text AS "cashCny",invested::text,
    market_value_cny::text AS "marketValueCny",system_market_value_at_snapshot::text AS "systemMarketValueAtSnapshot",
    snapshot_source AS "snapshotSource",is_locked AS "isLocked",snapshot_at
    FROM nav_history WHERE username=$1 AND account_name=$2`, args);
  return { cashBase: account.rows[0]?.cash_base || '0', cashFlows: flows.rows, trades: trades.rows, navHistory: navs.rows };
}
module.exports = { loadCashInputs };

// 所有数据库现金入口共用此装载器，调用方可传入已持账户锁的事务连接。
const { pool } = require('../db/connection');
const NavMath = require('../../public/shared/nav-math');
const CoreDate = require('../../public/shared/core-date');

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
async function loadCashState(username, accountName, client = pool, targetDate = CoreDate.todayInZone('Asia/Shanghai')) {
  if (client === pool) {
    const session = await pool.connect();
    try {
      await session.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const result = await loadCashState(username, accountName, session, targetDate);
      await session.query('COMMIT');
      return result;
    } catch(e) { await session.query('ROLLBACK'); throw e; }
    finally { session.release(); }
  }
  const data = await loadCashInputs(username, accountName, client);
  return { ...NavMath.cashAt(data, targetDate), invested: NavMath.investedAt(data.navHistory,data.cashFlows,data.cashBase,targetDate) };
}
module.exports = { loadCashInputs, loadCashState };

// 所有数据库现金入口共用此装载器，调用方可传入已持账户锁的事务连接。
const { pool } = require('../db/connection');
const { loadCashInputs } = require('../repositories/accountCashRepository');
const NavMath = require('../../public/shared/nav-math');
const CoreDate = require('../../public/shared/core-date');

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

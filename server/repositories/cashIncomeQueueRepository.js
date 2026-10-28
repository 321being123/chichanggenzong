const { pool } = require('../db/connection');

// 现金收益重算队列的读写：只做标准事实读写，目标日校验与批次推进留在服务层。

async function mergeCashIncomeStateById(accountId, payload, client = pool) {
  await client.query(
    'UPDATE accounts SET cash_income_state=cash_income_state||$2::jsonb WHERE id=$1',
    [accountId, JSON.stringify(payload)],
  );
}

async function mergeCashIncomeStateByName(username, accountName, payload, client = pool) {
  await client.query(
    'UPDATE accounts SET cash_income_state=cash_income_state||$3::jsonb WHERE username=$1 AND account_name=$2',
    [username, accountName, JSON.stringify(payload)],
  );
}

async function readRecalculationState(username, accountName, client = pool) {
  const { rows } = await client.query(
    'SELECT cash_income_state FROM accounts WHERE username=$1 AND account_name=$2',
    [username, accountName],
  );
  const state = rows[0] && rows[0].cash_income_state;
  return state ? state.recalculation : undefined;
}

async function moveSlotBusinessDate(slotId, targetDate, client = pool) {
  await client.query(
    'UPDATE ops.job_schedule_slots SET business_date=$2::date WHERE slot_id=$1',
    [slotId, targetDate],
  );
}

module.exports = {
  mergeCashIncomeStateById,
  mergeCashIncomeStateByName,
  moveSlotBusinessDate,
  readRecalculationState,
};

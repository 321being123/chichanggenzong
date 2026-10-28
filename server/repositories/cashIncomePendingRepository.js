const { pool } = require('../db/connection');

// 现金收益待核验事件的读写：只做标准事实读写，状态判定与恢复证据留在服务层。

async function lockAccount(username, accountName, client = pool) {
  const { rows } = await client.query(
    'SELECT id FROM accounts WHERE username=$1 AND account_name=$2 FOR UPDATE',
    [username, accountName],
  );
  return rows[0] || null;
}

async function lockPendingEvents(accountId, client = pool) {
  const { rows } = await client.query(
    'SELECT * FROM account_cash_income_pending WHERE account_id=$1 FOR UPDATE',
    [accountId],
  );
  return rows;
}

async function lockPendingEvent(accountId, pendingKey, client = pool) {
  const { rows } = await client.query(
    'SELECT * FROM account_cash_income_pending WHERE account_id=$1 AND pending_key=$2 FOR UPDATE',
    [accountId, pendingKey],
  );
  return rows[0] || null;
}

async function upsertPendingEvent(params, client = pool) {
  await client.query(`INSERT INTO account_cash_income_pending(account_id,pending_key,code,event_key,reason,state,input_version,evidence,next_attempt_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+interval '1 day') ON CONFLICT(account_id,pending_key)
      DO UPDATE SET state=EXCLUDED.state,input_version=EXCLUDED.input_version,evidence=EXCLUDED.evidence,last_attempt_at=now(),
      next_attempt_at=CASE WHEN EXCLUDED.state='excluded_by_user' THEN NULL ELSE EXCLUDED.next_attempt_at END,resolved_at=NULL`,
  [params.accountId, params.pendingKey, params.code, params.eventKey, params.reason,
    params.state, params.inputVersion, params.row]);
}

async function insertPendingAudit(params, client = pool) {
  await client.query(
    'INSERT INTO account_cash_income_pending_audit(account_id,pending_key,before_value,after_value,actor) VALUES($1,$2,$3,$4,$5)',
    [params.accountId, params.pendingKey, params.before, params.after, params.actor]);
}

async function markPendingResolved(params, client = pool) {
  await client.query(
    "UPDATE account_cash_income_pending SET state=$4,resolved_at=now(),next_attempt_at=NULL,input_version=$3,user_reason=COALESCE($5,user_reason) WHERE account_id=$1 AND pending_key=$2",
    [params.accountId, params.pendingKey, params.inputVersion, params.state, params.userReason],
  );
}

async function updatePendingState(params, client = pool) {
  await client.query(
    "UPDATE account_cash_income_pending SET state=$3,user_reason=$4,next_attempt_at=CASE WHEN $3='pending' THEN now() ELSE NULL END WHERE account_id=$1 AND pending_key=$2",
    [params.accountId, params.pendingKey, params.state, params.userReason],
  );
}

async function listPendingEvents(accountId, client = pool) {
  const { rows } = await client.query(
    'SELECT p.*,p.first_seen_at::text,p.last_attempt_at::text FROM account_cash_income_pending p WHERE account_id=$1 ORDER BY p.first_seen_at,p.pending_key',
    [accountId],
  );
  return rows;
}

async function bumpAccountDataVersion(username, accountName, client = pool) {
  await client.query(
    'UPDATE account_data SET version=version+1 WHERE username=$1 AND account_name=$2',
    [username, accountName],
  );
}

module.exports = {
  bumpAccountDataVersion,
  insertPendingAudit,
  listPendingEvents,
  lockAccount,
  lockPendingEvent,
  lockPendingEvents,
  markPendingResolved,
  updatePendingState,
  upsertPendingEvent,
};

const { pool } = require('../db/connection');



// 自 server/services/notificationBatchService.js 迁入的数据读写函数（只做标准事实读写，业务判定仍留在服务层）。

async function lockRequest(db, actorUsername, operation, clientRequestId) {
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [
    'notification_op:' + String(actorUsername || '') + ':' + operation + ':' + clientRequestId,
  ]);
}

async function select_public_users(params, client = pool) {
  return client.query(`SELECT username, role, status FROM public.users WHERE username=$1`, params);
}

async function select_ops_job_schedule_slots(params, client = pool) {
  return client.query(`SELECT slot_id, status FROM ops.job_schedule_slots WHERE slot_id=$1`, params);
}

module.exports = {
  lockRequest,
  select_public_users,
  select_ops_job_schedule_slots,
};

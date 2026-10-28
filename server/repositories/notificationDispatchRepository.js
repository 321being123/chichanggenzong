const { pool } = require('../db/connection');

// 自 server/jobs/notificationDispatch.js 迁入的数据读写函数（只做标准事实读写，业务判定仍留在服务层）。

async function loadBatch(batchId) {
  const { rows } = await pool.query(
    `SELECT id::text AS id, notification_id::text AS "notificationId", status,
            dispatch_generation, scan_round, cursor, dispatch_slot_id
       FROM public.notification_batches WHERE id=$1`,
    [batchId]
  );
  return rows[0] || null;
}

async function verifyExecution(client, opts) {
  if (!opts.executionToken) return { ok: false, reason: 'missing_execution_token' };
  const slot = await client.query(
    `SELECT slot_id, status, execution_token, lease_until,
            -- 实际时钟：now() 在事务内固定为事务开始时刻，会让「页内跨过到期」逃过校验
            (lease_until IS NOT NULL AND lease_until > clock_timestamp()) AS lease_ok
       FROM ops.job_schedule_slots WHERE slot_id=$1 FOR UPDATE`,
    [opts.slotId]
  );
  const row = slot.rows[0];
  if (!row) return { ok: false, reason: 'slot_missing' };
  if (row.status !== 'running') return { ok: false, reason: 'slot_not_running' };
  if (String(row.execution_token || '') !== String(opts.executionToken)) {
    return { ok: false, reason: 'execution_token_mismatch' };
  }
  if (!row.lease_ok) return { ok: false, reason: 'lease_expired' };
  const batch = await client.query(
    'SELECT dispatch_generation, status FROM public.notification_batches WHERE id=$1 FOR UPDATE',
    [opts.batchId]
  );
  const b = batch.rows[0];
  if (!b) return { ok: false, reason: 'batch_missing' };
  if (['cancelled', 'completed'].includes(b.status)) return { ok: false, reason: 'batch_not_running' };
  if (Number(b.dispatch_generation) !== Number(opts.generation)) {
    return { ok: false, reason: 'dispatch_generation_changed' };
  }
  return { ok: true };
}

module.exports = {
  loadBatch,
  verifyExecution,
};

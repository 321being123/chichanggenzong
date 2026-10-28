const { pool } = require('../db/connection');
const txControl = require('./transactionControl');

// 自 server/services/jobAlertMailer.js 迁入的数据读写函数（只做标准事实读写，业务判定仍留在服务层）。

const DELIVERY_RETRY_MINUTES = [1, 5, 15];
const MAX_DELIVERY_ATTEMPTS = DELIVERY_RETRY_MINUTES.length + 1;
const MAX_RECOVERY_SUMMARY_ATTEMPTS = 3;

async function claimAlertDelivery(alertId) {
  const { rows } = await pool.query(
    `UPDATE ops.alert_notifications
        SET status='sending', send_attempts=send_attempts+1, next_send_at=NULL, sending_started_at=now(), updated_at=now()
      WHERE alert_id=$1
        AND status IN ('pending','send_failed','sent','suppressed')
        AND send_attempts < $2
        AND (next_send_at IS NULL OR next_send_at <= now())
      RETURNING *`, [alertId, MAX_DELIVERY_ATTEMPTS]
  );
  return rows[0] || null;
}

async function claimRecoverySummaryAlerts() {
  const client = await pool.connect();
  try {
    const { rows: lockRows } = await client.query(
      `SELECT pg_try_advisory_lock(hashtext('ops.alert_notifications.recovery_summary')) AS locked`
    );
    if (!lockRows[0] || !lockRows[0].locked) {
      client.release();
      return null;
    }
    await txControl.begin(client);
    const { rows: triggerRows } = await client.query(
      `SELECT alert_id
         FROM ops.alert_notifications
        WHERE status='send_failed'
          AND (send_attempts > 0 OR recovery_attempts > 0)
          AND recovery_attempts < $1
          AND (next_send_at IS NULL OR next_send_at <= now())
        ORDER BY alert_id ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED`, [MAX_RECOVERY_SUMMARY_ATTEMPTS]
    );
    if (!triggerRows.length) {
      await txControl.commit(client);
      return { client, ids: [] };
    }
    const { rows } = await client.query(
      `SELECT alert_id
         FROM ops.alert_notifications
        WHERE status IN ('pending','send_failed')
          AND recovery_attempts < $1
          AND (next_send_at IS NULL OR next_send_at <= now())
        ORDER BY alert_id ASC
        FOR UPDATE SKIP LOCKED`, [MAX_RECOVERY_SUMMARY_ATTEMPTS]
    );
    if (!rows.length) {
      await txControl.commit(client);
      return { client, ids: [] };
    }
    const ids = rows.map(row => row.alert_id);
    await client.query(
      `UPDATE ops.alert_notifications
          SET status='sending', recovery_attempts=recovery_attempts+1,
              next_send_at=NULL, sending_started_at=now(), updated_at=now()
        WHERE alert_id=ANY($1::bigint[])`, [ids]
    );
    await txControl.commit(client);
    return { client, ids };
  } catch (error) {
    await txControl.rollback(client).catch(() => {});
    await client.query(`SELECT pg_advisory_unlock(hashtext('ops.alert_notifications.recovery_summary'))`).catch(() => {});
    client.release();
    throw error;
  }
}

async function loadResolutionCandidates(where, params) {
  const { rows } = await pool.query(
    `SELECT * FROM ops.alert_notifications
       WHERE status NOT IN ('resolved','acknowledged')
         AND alert_type NOT IN ('recovery','worker_recovered','job_overdue_recovered','external_api_switch','external_api_interface_failover')
         AND (${where})`, params
  );
  return rows;
}

module.exports = {
  claimAlertDelivery,
  claimRecoverySummaryAlerts,
  loadResolutionCandidates,
};

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

async function insert_ops_alert_notifications(params, client = pool) {
  return client.query(`INSERT INTO ops.alert_notifications(alert_key,alert_type,severity,job_code,slot_id,scope_type,scope_key,subject,summary,next_send_at,next_check_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),now())
     ON CONFLICT(alert_key) DO UPDATE SET
       summary=EXCLUDED.summary, subject=EXCLUDED.subject,
       scope_type=COALESCE(EXCLUDED.scope_type,ops.alert_notifications.scope_type),
       scope_key=COALESCE(EXCLUDED.scope_key,ops.alert_notifications.scope_key), last_seen_at=now(),
       occurrence_count=ops.alert_notifications.occurrence_count+1,
       status=CASE WHEN ops.alert_notifications.status IN ('acknowledged','resolved') THEN 'pending' ELSE ops.alert_notifications.status END,
       resolved_at=CASE WHEN ops.alert_notifications.status IN ('acknowledged','resolved') THEN NULL ELSE ops.alert_notifications.resolved_at END,
       acknowledged_at=CASE WHEN ops.alert_notifications.status IN ('acknowledged','resolved') THEN NULL ELSE ops.alert_notifications.acknowledged_at END,
       send_attempts=CASE WHEN ops.alert_notifications.status IN ('acknowledged','resolved') THEN 0 ELSE ops.alert_notifications.send_attempts END,
       recovery_attempts=CASE WHEN ops.alert_notifications.status IN ('acknowledged','resolved') THEN 0 ELSE ops.alert_notifications.recovery_attempts END,
       last_send_error=CASE WHEN ops.alert_notifications.status IN ('acknowledged','resolved') THEN NULL ELSE ops.alert_notifications.last_send_error END,
       sending_started_at=CASE WHEN ops.alert_notifications.status IN ('acknowledged','resolved') THEN NULL ELSE ops.alert_notifications.sending_started_at END,
       last_sent_at=CASE WHEN ops.alert_notifications.status IN ('acknowledged','resolved') THEN NULL ELSE ops.alert_notifications.last_sent_at END,
       next_send_at=CASE WHEN ops.alert_notifications.status IN ('acknowledged','resolved') THEN now() ELSE ops.alert_notifications.next_send_at END,
       next_check_at=now(),
       updated_at=now()
     RETURNING *`, params);
}

async function update_ops_alert_notifications(params, client = pool) {
  return client.query(`UPDATE ops.alert_notifications
          SET status='suppressed', send_attempts=0, recovery_attempts=0,
              next_send_at=NULL, last_send_error=NULL, sending_started_at=NULL, updated_at=now()
        WHERE alert_id=$1`, params);
}

async function update_ops_alert_notifications_1(params, client = pool) {
  return client.query(`UPDATE ops.alert_notifications
          SET status='send_failed', last_send_error=$2,
              recovery_attempts=0,
              next_send_at=CASE WHEN send_attempts < $3 THEN now()+($4 || ' minutes')::interval ELSE NULL END,
              sending_started_at=NULL,
              updated_at=now()
        WHERE alert_id=$1 AND status='sending'`, params);
}

async function update_ops_alert_notifications_2(params, client = pool) {
  return client.query(`UPDATE ops.alert_notifications
          SET status='sent', send_attempts=0, recovery_attempts=0, last_sent_at=now(),
              next_send_at=now()+interval '6 hours', last_send_error=NULL,
              sending_started_at=NULL, updated_at=now()
        WHERE alert_id=$1 AND status='sending'`, params);
}

async function update_ops_alert_notifications_3(params, client = pool) {
  return client.query(`UPDATE ops.alert_notifications
          SET status='pending',next_send_at=NULL,next_check_at=now(),sending_started_at=NULL,updated_at=now()
        WHERE alert_id=$1 AND status <> 'sending'`, params);
}

async function update_ops_alert_notifications_4(params, client = pool) {
  return client.query(`UPDATE ops.alert_notifications
          SET status='pending', send_attempts=0, next_send_at=now(), last_send_error=NULL,
              recovery_attempts=0, sending_started_at=NULL, updated_at=now()
        WHERE alert_id=$1 AND status <> 'sending'
        RETURNING *`, params);
}

async function update_ops_alert_notifications_5(params, client = pool) {
  return client.query(`UPDATE ops.alert_notifications
          SET status='pending', next_send_at=now()+interval '1 minute', sending_started_at=NULL, updated_at=now()
        WHERE alert_id=$1 AND status <> 'sending'`, params);
}

async function update_ops_alert_notifications_6(params, client = pool) {
  return client.query(`UPDATE ops.alert_notifications SET status='suppressed', next_send_at=now()+interval '6 hours', sending_started_at=NULL, updated_at=now() WHERE alert_id=$1 AND status <> 'sending'`, params);
}

async function update_ops_alert_notifications_7(params, client = pool) {
  return client.query(`UPDATE ops.alert_notifications
        SET status=CASE WHEN recovery_attempts > 0 OR send_attempts >= $1 THEN 'send_failed' ELSE 'pending' END,
            next_send_at=now(), sending_started_at=NULL, updated_at=now()
      WHERE status='sending'
        AND COALESCE(sending_started_at, updated_at) < now()-interval '2 minutes'`, params);
}

async function select_ops_alert_notifications(params, client = pool) {
  return client.query(`SELECT * FROM ops.alert_notifications
      WHERE status IN ('pending','send_failed')
        AND send_attempts < $1
        AND recovery_attempts=0
        AND next_send_at IS NOT NULL AND next_send_at <= now()
      ORDER BY next_send_at ASC, alert_id ASC LIMIT $2`, params);
}

async function select_data(params, client = pool) {
  return client.query(`SELECT pg_advisory_unlock(hashtext('ops.alert_notifications.recovery_summary'))`);
}

async function select_ops_alert_notifications_1(params, client = pool) {
  return client.query(`SELECT alert_id
       FROM ops.alert_notifications
      WHERE status='send_failed'
        AND (send_attempts > 0 OR recovery_attempts > 0)
        AND recovery_attempts < $1
        AND (next_send_at IS NULL OR next_send_at <= now())
      LIMIT 1`, params);
}

async function select_ops_alert_notifications_2(params, client = pool) {
  return client.query(`SELECT alert_id,job_code,subject,summary,occurrence_count,last_send_error
       FROM ops.alert_notifications
      WHERE alert_id=ANY($1::bigint[])
      ORDER BY alert_id ASC`, params);
}

async function update_ops_alert_notifications_8(params, client = pool) {
  return client.query(`UPDATE ops.alert_notifications
          SET status='sent', send_attempts=0, recovery_attempts=0, last_sent_at=now(),
              next_send_at=now()+interval '6 hours', last_send_error=NULL,
              sending_started_at=NULL, updated_at=now()
        WHERE alert_id=ANY($1::bigint[]) AND status='sending'`, params);
}

async function update_ops_alert_notifications_9(params, client = pool) {
  return client.query(`UPDATE ops.alert_notifications
          SET status='send_failed', send_attempts=$2,
              next_send_at=CASE WHEN recovery_attempts < $3
                THEN now()+($4 || ' minutes')::interval ELSE NULL END,
              last_send_error=$5, sending_started_at=NULL, updated_at=now()
        WHERE alert_id=ANY($1::bigint[]) AND status='sending'`, params);
}

async function update_ops_alert_notifications_10(params, client = pool) {
  return client.query(`UPDATE ops.alert_notifications
          SET status='resolved',resolved_at=now(),sending_started_at=NULL,updated_at=now()
        WHERE alert_id=$1 AND status NOT IN ('resolved','acknowledged')
          AND alert_type NOT IN ('recovery','worker_recovered','job_overdue_recovered','external_api_switch','external_api_interface_failover')
        RETURNING *`, params);
}

async function select_ops_alert_notifications_3(params, client = pool) {
  return client.query(`SELECT * FROM ops.alert_notifications
        WHERE scope_type='source_endpoint'
          AND status NOT IN ('resolved','acknowledged')
          AND alert_type NOT IN ('recovery','worker_recovered','job_overdue_recovered','external_api_switch','external_api_interface_failover')
        ORDER BY last_seen_at ASC, alert_id ASC LIMIT $1`, params);
}

async function update_ops_alert_notifications_11(params, client = pool) {
  return client.query(`UPDATE ops.alert_notifications
            SET status='resolved',resolved_at=now(),sending_started_at=NULL,updated_at=now()
          WHERE alert_id=$1 AND status NOT IN ('resolved','acknowledged')
          RETURNING *`, params);
}

async function select_ops_alert_notifications_4(params, client = pool) {
  return client.query(`SELECT * FROM ops.alert_notifications
      WHERE status NOT IN ('resolved','acknowledged')
        AND alert_type NOT IN ('recovery','worker_recovered','job_overdue_recovered','external_api_switch','external_api_interface_failover')
        AND (last_checked_at IS NULL OR next_check_at IS NULL OR next_check_at <= now())
      ORDER BY CASE WHEN last_checked_at IS NULL THEN 0 ELSE 1 END,
               next_check_at ASC NULLS FIRST,last_checked_at ASC NULLS FIRST,last_seen_at ASC,alert_id ASC
      LIMIT $1`, params);
}

async function update_ops_alert_notifications_12(params, client = pool) {
  return client.query(`UPDATE ops.alert_notifications
            SET status='resolved',resolved_at=now(),last_checked_at=now(),next_check_at=NULL,sending_started_at=NULL,updated_at=now()
          WHERE alert_id=$1 AND status NOT IN ('resolved','acknowledged') RETURNING alert_id`, params);
}

async function update_ops_alert_notifications_13(params, client = pool) {
  return client.query(`UPDATE ops.alert_notifications
            SET last_checked_at=now(),next_check_at=now()+($2 || ' minutes')::interval,updated_at=now()
          WHERE alert_id=$1 AND status NOT IN ('resolved','acknowledged')`, params);
}

async function select_ops_dataset_partitions(params, client = pool) {
  return client.query(`SELECT dataset_code,scope_key,partition_key::text,diagnostics
       FROM ops.dataset_partitions
      WHERE status='partial_published' AND partition_key <= (CURRENT_DATE - INTERVAL '2 days')::date
      ORDER BY partition_key ASC,dataset_code ASC LIMIT $1`, params);
}

async function select_ops_worker_heartbeats(params, client = pool) {
  return client.query(`SELECT worker_id FROM ops.worker_heartbeats
        WHERE role='worker' AND status='running' AND last_seen_at >= now()-interval '2 minutes'
        ORDER BY last_seen_at DESC LIMIT 1`);
}

async function update_ops_alert_notifications_14(params, client = pool) {
  return client.query(`UPDATE ops.alert_notifications
          SET status='resolved',resolved_at=now(),sending_started_at=NULL,updated_at=now()
        WHERE alert_id=$1 AND status NOT IN ('resolved','acknowledged')
        RETURNING *`, params);
}

async function select_ops_alert_notifications_5(params, client = pool) {
  return client.query(`SELECT * FROM ops.alert_notifications WHERE alert_id=$1`, params);
}

async function update_ops_alert_notifications_15(params, client = pool) {
  return client.query(`UPDATE ops.alert_notifications
        SET status='pending', send_attempts=0, recovery_attempts=0,
            next_send_at=now(), last_send_error=NULL, updated_at=now()
      WHERE alert_id=$1 AND status <> 'sending'
      RETURNING *`, params);
}

async function update_ops_alert_notifications_16(params, client = pool) {
  return client.query(`UPDATE ops.alert_notifications SET status='acknowledged',acknowledged_at=now(),updated_at=now() WHERE alert_id=$1 RETURNING *`, params);
}

const ACTIVE_ALERT_WHERE = `status NOT IN ('resolved','acknowledged')
        AND NOT (alert_type IN ('recovery','worker_recovered','job_overdue_recovered','external_api_switch','external_api_interface_failover')
          AND status IN ('sent','suppressed'))
        AND NOT (alert_type='failure_warning' AND EXISTS (
          SELECT 1 FROM ops.alert_notifications newer
           WHERE newer.slot_id=ops.alert_notifications.slot_id
             AND newer.alert_type='failure'
             AND newer.status NOT IN ('resolved','acknowledged')
        ))
        AND NOT (alert_type='late' AND EXISTS (
          SELECT 1 FROM ops.alert_notifications blocker
           WHERE blocker.slot_id=ops.alert_notifications.slot_id
             AND blocker.alert_type='dependency_blocked'
             AND blocker.status NOT IN ('resolved','acknowledged')
        ))`;

// 告警列表分页：待处理/历史两种口径，活动告警口径由 ACTIVE_ALERT_WHERE 定义
async function listAlertPage(params, client = pool) {
  return client.query(
    `SELECT * FROM ops.alert_notifications
      WHERE ($1::boolean = false OR (${ACTIVE_ALERT_WHERE}))
        AND ($2::text IS NULL OR status=$2)
        AND ($3::boolean = false OR status IN ('resolved','acknowledged'))
      ORDER BY last_seen_at DESC LIMIT $4`,
    [params.open, params.exact, params.history, params.limit],
  );
}

// 通用语句执行入口：供「可注入查询器」的默认实现使用，连接与执行留在数据层
async function runQuery(sql, params, client = pool) {
  return client.query(sql, params);
}

module.exports = {
  runQuery,
  ACTIVE_ALERT_WHERE,
  listAlertPage,
  claimAlertDelivery,
  claimRecoverySummaryAlerts,
  loadResolutionCandidates,
  insert_ops_alert_notifications,
  update_ops_alert_notifications,
  update_ops_alert_notifications_1,
  update_ops_alert_notifications_2,
  update_ops_alert_notifications_3,
  update_ops_alert_notifications_4,
  update_ops_alert_notifications_5,
  update_ops_alert_notifications_6,
  update_ops_alert_notifications_7,
  select_ops_alert_notifications,
  select_data,
  select_ops_alert_notifications_1,
  select_ops_alert_notifications_2,
  update_ops_alert_notifications_8,
  update_ops_alert_notifications_9,
  update_ops_alert_notifications_10,
  select_ops_alert_notifications_3,
  update_ops_alert_notifications_11,
  select_ops_alert_notifications_4,
  update_ops_alert_notifications_12,
  update_ops_alert_notifications_13,
  select_ops_dataset_partitions,
  select_ops_worker_heartbeats,
  update_ops_alert_notifications_14,
  select_ops_alert_notifications_5,
  update_ops_alert_notifications_15,
  update_ops_alert_notifications_16,
};

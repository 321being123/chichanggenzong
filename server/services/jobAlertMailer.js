const { pool } = require('../db/connection');
const { mailer } = require('../config');
const { sanitizeJobError } = require('./jobErrorSanitizer');

const DELIVERY_RETRY_MINUTES = [1, 5, 15];
const MAX_DELIVERY_ATTEMPTS = DELIVERY_RETRY_MINUTES.length + 1;
const RECOVERY_SUMMARY_RETRY_MINUTES = 15;
const MAX_RECOVERY_SUMMARY_ATTEMPTS = 3;
// 故障告警在人工确认或任务恢复前保持待处理；一次性通知发送后不再算待处理。
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

function productionAlertsEnabled() {
  return process.env.NODE_ENV === 'production';
}

function recipients() {
  return String(process.env.ALERT_EMAIL_TO || '')
    .split(',').map(item => item.trim()).filter(Boolean);
}

function formatAlertDate(value) {
  if (!value) return '未提供';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString().slice(0, 10);
}

function alertKeyFor({ alertKey, jobCode, slotId, alertType = 'failure' }) {
  if (alertKey) return String(alertKey);
  return `${jobCode || 'unknown'}:${slotId || 'legacy'}:${alertType}`;
}

function sanitizeAlertRecord(alert) {
  if (!alert) return null;
  return {
    ...alert,
    subject: sanitizeJobError(alert.subject || '', 500),
    summary: sanitizeJobError(alert.summary || '', 4000),
    last_send_error: alert.last_send_error ? sanitizeJobError(alert.last_send_error, 1000) : null,
  };
}

async function upsertAlert(input) {
  const key = alertKeyFor(input);
  const { rows } = await pool.query(
    `INSERT INTO ops.alert_notifications(alert_key,alert_type,severity,job_code,slot_id,subject,summary,next_send_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,now())
     ON CONFLICT(alert_key) DO UPDATE SET
       summary=EXCLUDED.summary, subject=EXCLUDED.subject, last_seen_at=now(),
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
       updated_at=now()
     RETURNING *`,
    [key, input.alertType || 'failure', input.severity || 'critical', input.jobCode || null, input.slotId || null,
      sanitizeJobError(input.subject || `后台任务异常：${input.jobCode || '未知任务'}`, 500), sanitizeJobError(input.summary || '', 4000)]
  );
  return rows[0];
}

async function deliverAlert(alert) {
  // 最终邮件出口再做一次生产环境校验，防止测试或本地开发误加载真实 SMTP 后向真实收件人发信。
  if (!productionAlertsEnabled()) {
    await pool.query(
      `UPDATE ops.alert_notifications
          SET status='suppressed', send_attempts=0, recovery_attempts=0,
              next_send_at=NULL, last_send_error=NULL, sending_started_at=NULL, updated_at=now()
        WHERE alert_id=$1`, [alert.alert_id]
    );
    return { ok: true, suppressed: true, alertId: alert.alert_id, reason: 'non_production_environment' };
  }
  const claimed = await claimAlertDelivery(alert.alert_id);
  if (!claimed) return { ok: true, suppressed: true, alertId: alert.alert_id };
  const to = recipients();
  const attempt = Number(claimed.send_attempts || 0);
  const delay = DELIVERY_RETRY_MINUTES[Math.min(attempt - 1, DELIVERY_RETRY_MINUTES.length - 1)];
  if (attempt > MAX_DELIVERY_ATTEMPTS) return { ok: false, alertId: alert.alert_id, exhausted: true };

  if (!mailer || !to.length) {
    await pool.query(
      `UPDATE ops.alert_notifications
          SET status='send_failed', last_send_error=$2,
              recovery_attempts=0,
              next_send_at=CASE WHEN send_attempts < $3 THEN now()+($4 || ' minutes')::interval ELSE NULL END,
              sending_started_at=NULL,
              updated_at=now()
        WHERE alert_id=$1 AND status='sending'`,
      [alert.alert_id, '未配置 SMTP 或 ALERT_EMAIL_TO', MAX_DELIVERY_ATTEMPTS, String(delay)]
    );
    return { ok: false, alertId: alert.alert_id, error: '未配置 SMTP 或 ALERT_EMAIL_TO' };
  }

  try {
    await mailer.sendMail({
      from: process.env.ALERT_EMAIL_FROM || `存在小站任务告警 <${process.env.SMTP_USER}>`,
      to,
      subject: `[${process.env.ALERT_ENVIRONMENT || process.env.NODE_ENV || 'development'}] ${sanitizeJobError(alert.subject || '', 500)}`,
      text: `${sanitizeJobError(alert.summary || '', 4000)}\n\n任务：${alert.job_code || '-'}\n告警时间：${new Date().toISOString()}`,
    });
    await pool.query(
      `UPDATE ops.alert_notifications
          SET status='sent', send_attempts=0, recovery_attempts=0, last_sent_at=now(),
              next_send_at=now()+interval '6 hours', last_send_error=NULL,
              sending_started_at=NULL, updated_at=now()
        WHERE alert_id=$1 AND status='sending'`, [alert.alert_id]
    );
    return { ok: true, alertId: alert.alert_id };
  } catch (error) {
    await pool.query(
      `UPDATE ops.alert_notifications
          SET status='send_failed', last_send_error=$2,
              recovery_attempts=0,
              next_send_at=CASE WHEN send_attempts < $3 THEN now()+($4 || ' minutes')::interval ELSE NULL END,
              sending_started_at=NULL,
              updated_at=now()
        WHERE alert_id=$1 AND status='sending'`,
      [alert.alert_id, sanitizeJobError(error.message || error, 1000), MAX_DELIVERY_ATTEMPTS, String(delay)]
    );
    return { ok: false, alertId: alert.alert_id, error: sanitizeJobError(error.message || error) };
  }
}

async function sendAlert(input, options = {}) {
  // 非生产环境不创建任务告警记录，也不触碰共享告警状态。
  if (!productionAlertsEnabled()) {
    return { ok: true, suppressed: true, reason: 'non_production_environment' };
  }
  let alert = await upsertAlert(input);
  const repeatWindowMs = 6 * 60 * 60 * 1000;
  const force = Boolean(options.force || input.force);
  const manual = Boolean(options.manual || input.manual);
  const minOccurrences = Number(options.minOccurrences || input.minOccurrences || 1);
  if (force) {
    const { rows } = await pool.query(
      `UPDATE ops.alert_notifications
          SET status='pending', send_attempts=0, next_send_at=now(), last_send_error=NULL,
              recovery_attempts=0, sending_started_at=NULL, updated_at=now()
        WHERE alert_id=$1 AND status <> 'sending'
        RETURNING *`, [alert.alert_id]
    );
    if (rows[0]) alert = rows[0];
  }
  if (!force && Number(alert.occurrence_count || 0) < minOccurrences) {
    await pool.query(
      `UPDATE ops.alert_notifications
          SET status='pending', next_send_at=now()+interval '1 minute', sending_started_at=NULL, updated_at=now()
        WHERE alert_id=$1 AND status <> 'sending'`, [alert.alert_id]
    );
    return { ok: true, deferred: true, alertId: alert.alert_id };
  }
  if (!force && alert.next_send_at && new Date(alert.next_send_at).getTime() > Date.now()) {
    return { ok: true, suppressed: true, alertId: alert.alert_id };
  }
  if (!force && !manual && alert.last_sent_at && Date.now() - new Date(alert.last_sent_at).getTime() < repeatWindowMs) {
    await pool.query(
      `UPDATE ops.alert_notifications SET status='suppressed', next_send_at=now()+interval '6 hours', sending_started_at=NULL, updated_at=now() WHERE alert_id=$1 AND status <> 'sending'`,
      [alert.alert_id]
    );
    return { ok: true, suppressed: true, alertId: alert.alert_id };
  }
  return deliverAlert(alert);
}

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

async function sendDueAlerts(limit = 20) {
  if (!productionAlertsEnabled()) {
    return { ok: true, suppressed: true, count: 0, results: [], reason: 'non_production_environment' };
  }
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  await pool.query(
    `UPDATE ops.alert_notifications
        SET status=CASE WHEN recovery_attempts > 0 OR send_attempts >= $1 THEN 'send_failed' ELSE 'pending' END,
            next_send_at=now(), sending_started_at=NULL, updated_at=now()
      WHERE status='sending'
        AND COALESCE(sending_started_at, updated_at) < now()-interval '2 minutes'`
    , [MAX_DELIVERY_ATTEMPTS]
  );
  const results = [];
  const recovery = await sendRecoverySummary();
  if (recovery) results.push(recovery);
  const { rows } = await pool.query(
    `SELECT * FROM ops.alert_notifications
      WHERE status IN ('pending','send_failed')
        AND send_attempts < $1
        AND recovery_attempts=0
        AND next_send_at IS NOT NULL AND next_send_at <= now()
      ORDER BY next_send_at ASC, alert_id ASC LIMIT $2`,
    [MAX_DELIVERY_ATTEMPTS, safeLimit]
  );
  for (const alert of rows) results.push(await deliverAlert(alert));
  return { ok: results.every(item => item.ok), count: results.length, results };
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
    await client.query('BEGIN');
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
      await client.query('COMMIT');
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
      await client.query('COMMIT');
      return { client, ids: [] };
    }
    const ids = rows.map(row => row.alert_id);
    await client.query(
      `UPDATE ops.alert_notifications
          SET status='sending', recovery_attempts=recovery_attempts+1,
              next_send_at=NULL, sending_started_at=now(), updated_at=now()
        WHERE alert_id=ANY($1::bigint[])`, [ids]
    );
    await client.query('COMMIT');
    return { client, ids };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    await client.query(`SELECT pg_advisory_unlock(hashtext('ops.alert_notifications.recovery_summary'))`).catch(() => {});
    client.release();
    throw error;
  }
}

async function releaseRecoverySummaryClaim(claim) {
  if (!claim || !claim.client) return;
  await claim.client.query(`SELECT pg_advisory_unlock(hashtext('ops.alert_notifications.recovery_summary'))`).catch(() => {});
  claim.client.release();
}

async function sendRecoverySummary() {
  if (!productionAlertsEnabled()) return null;
  const to = recipients();
  if (!mailer || !to.length) return null;
  const { rows: dueFailures } = await pool.query(
    `SELECT alert_id
       FROM ops.alert_notifications
      WHERE status='send_failed'
        AND (send_attempts > 0 OR recovery_attempts > 0)
        AND recovery_attempts < $1
        AND (next_send_at IS NULL OR next_send_at <= now())
      LIMIT 1`
  , [MAX_RECOVERY_SUMMARY_ATTEMPTS]);
  if (!dueFailures.length) return null;
  try {
    await mailer.verify();
  } catch (_) {
    return null;
  }
  const claim = await claimRecoverySummaryAlerts();
  if (!claim) return null;
  const ids = claim.ids;
  if (!ids.length) {
    await releaseRecoverySummaryClaim(claim);
    return null;
  }
  try {
    const { rows } = await claim.client.query(
    `SELECT alert_id,job_code,subject,summary,occurrence_count,last_send_error
       FROM ops.alert_notifications
      WHERE alert_id=ANY($1::bigint[])
      ORDER BY alert_id ASC`, [ids]
  );
    const detailRows = rows.slice(0, 100);
    const lines = detailRows.map(row => `- ${row.job_code || '未知任务'}：${sanitizeJobError(row.subject, 500)}；累计 ${row.occurrence_count || 1} 次；${sanitizeJobError(row.summary, 1000)}`).join('\n');
    const omitted = rows.length > detailRows.length ? `\n- 另有 ${rows.length - detailRows.length} 条告警已合并处理` : '';
    await mailer.sendMail({
      from: process.env.ALERT_EMAIL_FROM || `存在小站任务告警 <${process.env.SMTP_USER}>`,
      to,
      subject: `[${process.env.ALERT_ENVIRONMENT || process.env.NODE_ENV || 'development'}] 后台告警投递已恢复`,
      text: `SMTP 恢复后，系统合并补发 ${rows.length} 条历史告警：\n\n${lines}${omitted}`,
    });
    await claim.client.query(
      `UPDATE ops.alert_notifications
          SET status='sent', send_attempts=0, recovery_attempts=0, last_sent_at=now(),
              next_send_at=now()+interval '6 hours', last_send_error=NULL,
              sending_started_at=NULL, updated_at=now()
        WHERE alert_id=ANY($1::bigint[]) AND status='sending'`, [ids]
    );
    return { ok: true, summary: true, count: rows.length };
  } catch (error) {
    await claim.client.query(
      `UPDATE ops.alert_notifications
          SET status='send_failed', send_attempts=$2,
              next_send_at=CASE WHEN recovery_attempts < $3
                THEN now()+($4 || ' minutes')::interval ELSE NULL END,
              last_send_error=$5, sending_started_at=NULL, updated_at=now()
        WHERE alert_id=ANY($1::bigint[]) AND status='sending'`,
      [ids, MAX_DELIVERY_ATTEMPTS, MAX_RECOVERY_SUMMARY_ATTEMPTS,
        String(RECOVERY_SUMMARY_RETRY_MINUTES), sanitizeJobError(error.message || error, 1000)]
    );
    return { ok: false, summary: true, count: rows.length, error: sanitizeJobError(error.message || error) };
  } finally {
    await releaseRecoverySummaryClaim(claim);
  }
}

async function notifyJobFailure(input) {
  const force = Boolean(input.force);
  return sendAlert(
    { ...input, alertType: input.alertType || 'failure', severity: input.severity || 'critical' },
    { force, minOccurrences: input.minOccurrences || 1 }
  );
}

async function sendTestEmail() {
  if (!productionAlertsEnabled()) {
    return { ok: false, suppressed: true, error: '非生产环境已禁止任务告警邮件' };
  }
  const to = recipients();
  if (!mailer || !to.length) return { ok: false, error: '未配置 SMTP 或 ALERT_EMAIL_TO' };
  await mailer.sendMail({
    from: process.env.ALERT_EMAIL_FROM || `存在小站任务告警 <${process.env.SMTP_USER}>`,
    to,
    subject: `[${process.env.ALERT_ENVIRONMENT || process.env.NODE_ENV || 'development'}] 后台任务邮件测试`,
    text: `后台任务邮件告警测试成功。\n时间：${new Date().toISOString()}`,
  });
  return { ok: true, recipients: to.length };
}

async function sendRecoveryAlert(input) {
  return sendAlert(
    { ...input, alertType: input.alertType || 'recovery', severity: input.severity || 'info' },
    { force: true }
  );
}

async function resolveJobSlotAlerts(slot) {
  if (!productionAlertsEnabled()) return 0;
  const { rows } = await pool.query(
      `UPDATE ops.alert_notifications
        SET status='resolved', resolved_at=now(), sending_started_at=NULL, updated_at=now()
      WHERE slot_id=$1 AND status <> 'resolved' AND alert_type <> 'recovery'
      RETURNING *`, [slot.slot_id]
  );
  if (rows.length) await sendRecoveryAlert({
    alertKey: `slot:${slot.slot_id}:recovered`,
    alertType: 'recovery',
    severity: 'info',
    jobCode: rows[0].job_code,
    slotId: slot.slot_id,
    subject: `后台任务已恢复：${rows[0].job_code || slot.job_code}`,
    summary: `计划实例 ${slot.slot_id} 已恢复成功，已关闭 ${rows.length} 条相关告警，数据日期：${formatAlertDate(slot.data_as_of)}`,
  });
  return rows.length;
}

async function listAlerts(options = {}) {
  const limit = Math.min(Math.max(parseInt(options.limit, 10) || 50, 1), 200);
  const status = String(options.status || '').toLowerCase();
  const open = status === 'open' || status === 'unresolved';
  const allowed = ['pending', 'sending', 'sent', 'suppressed', 'send_failed', 'resolved', 'acknowledged'];
  const exact = allowed.includes(status) ? status : null;
  const { rows } = await pool.query(
    `SELECT * FROM ops.alert_notifications
      WHERE ($1::boolean = false OR (${ACTIVE_ALERT_WHERE}))
        AND ($2::text IS NULL OR status=$2)
      ORDER BY last_seen_at DESC LIMIT $3`, [open, exact, limit]
  );
  return rows.map(sanitizeAlertRecord);
}

async function resendAlert(alertId) {
  if (!productionAlertsEnabled()) {
    return { ok: true, suppressed: true, alertId, reason: 'non_production_environment' };
  }
  const { rows } = await pool.query('SELECT * FROM ops.alert_notifications WHERE alert_id=$1', [alertId]);
  if (!rows[0]) return null;
  const { rows: resetRows } = await pool.query(
    `UPDATE ops.alert_notifications
        SET status='pending', send_attempts=0, recovery_attempts=0,
            next_send_at=now(), last_send_error=NULL, updated_at=now()
      WHERE alert_id=$1 AND status <> 'sending'
      RETURNING *`, [alertId]
  );
  if (!resetRows[0]) return { ok: true, suppressed: true, alertId };
  const alert = resetRows[0];
  return sendAlert({
    alertKey: alert.alert_key,
    alertType: alert.alert_type,
    severity: alert.severity,
    jobCode: alert.job_code,
    slotId: alert.slot_id,
    subject: alert.subject,
    summary: alert.summary,
  }, { force: true, manual: true });
}

async function acknowledgeAlert(alertId) {
  const { rows } = await pool.query(
    `UPDATE ops.alert_notifications SET status='acknowledged',acknowledged_at=now(),updated_at=now() WHERE alert_id=$1 RETURNING *`,
    [alertId]
  );
  return sanitizeAlertRecord(rows[0]);
}

module.exports = {
  sendAlert, sendDueAlerts, sendRecoveryAlert, resolveJobSlotAlerts,
  notifyJobFailure, sendTestEmail, listAlerts, resendAlert, acknowledgeAlert,
  ACTIVE_ALERT_WHERE,
};

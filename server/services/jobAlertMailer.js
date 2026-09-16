const { pool } = require('../db/connection');
const { auditEvent } = require('../db');
const { mailer } = require('../config');
const { sanitizeJobError } = require('./jobErrorSanitizer');
const { verifySlotRecoveryEvidence } = require('./jobRecoveryEvidence');

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

function alertScope(input = {}) {
  if (input.scopeType && input.scopeKey) return { type: String(input.scopeType), key: String(input.scopeKey) };
  if (input.slotId != null) return { type: 'slot', key: String(input.slotId) };
  if (input.jobCode) return { type: 'job', key: String(input.jobCode) };
  return { type: null, key: null };
}

const DATA_BOUND_ALERT_TYPES = new Set(['data_quality', 'dependency_blocked']);

function parseAlertScope(alert = {}) {
  const type = String(alert.scope_type || '').trim();
  const key = String(alert.scope_key || '').trim();
  if (!type || !key) {
    if (alert.slot_id != null) return { type: 'slot', key: String(alert.slot_id) };
    if (alert.job_code) return { type: 'job', key: String(alert.job_code) };
  }
  return { type, key };
}

function allCircuitsClosed(rows) {
  return Array.isArray(rows) && rows.length > 0 && rows.every(row => row.state === 'closed');
}

function slotMode(row) {
  return String(row && row.request_payload && row.request_payload.mode || 'core');
}

function laterSlotLimit(historical) {
  return historical ? 3 : 1;
}

// 运行时自动收敛和历史告警调和共用这一个证据入口；historical 只表示历史槽位额外需要连续三次成功。
async function verifyAlertScope(alert, query = (sql, params) => pool.query(sql, params), options = {}) {
  const scope = parseAlertScope(alert);
  const historical = Boolean(options.historical);
  const alertType = String(alert.alert_type || '');
  if (scope.type === 'slot') {
    const { rows } = await query(
      `SELECT slot_id,job_code,business_date,status,scheduled_for,updated_at,request_payload,result_summary
         FROM ops.job_schedule_slots WHERE slot_id=$1`, [scope.key]
    );
    const row = rows[0];
    if (alertType === 'dependency_blocked' && row && row.status === 'succeeded') {
      return { recovered: true, evidence: { mode: 'dependency_recovered_by_slot_success', original: row } };
    }
    if (DATA_BOUND_ALERT_TYPES.has(alertType)) {
      return { recovered: false, evidence: row || null, reason: 'data_bound_alert_requires_dataset_evidence' };
    }
    if (row && row.status === 'succeeded') {
      return verifySlotRecoveryEvidence(row, query, { alertType });
    }
    if (!row || !row.job_code || !row.scheduled_for) {
      return { recovered: false, evidence: row || null, reason: row ? 'original_slot_not_recovered' : 'slot_not_found' };
    }
    const limit = laterSlotLimit(historical);
    const { rows: later } = await query(
      `SELECT slot_id,status,business_date,scheduled_for,request_payload,result_summary
         FROM ops.job_schedule_slots
        WHERE job_code=$1 AND business_date=$2::date AND scheduled_for>$3::timestamptz
          AND COALESCE(request_payload->>'mode','core')=$4
        ORDER BY scheduled_for ASC,slot_id ASC LIMIT $5`,
      [row.job_code, row.business_date, row.scheduled_for, slotMode(row), limit]
    );
    const recovered = later.length === limit && later.every(item => item.status === 'succeeded');
    return {
      recovered,
      evidence: { mode: historical ? 'three_later_job_successes' : 'later_comparable_slot_success', original: row, later },
      ...(recovered ? {} : { reason: 'insufficient_later_successes' }),
    };
  }
  if (scope.type === 'job') {
    if (DATA_BOUND_ALERT_TYPES.has(alertType)) {
      return { recovered: false, evidence: null, reason: 'data_bound_alert_requires_dataset_evidence' };
    }
    const { rows } = await query(
      `SELECT slot_id,status,business_date,scheduled_for,request_payload,result_summary
         FROM ops.job_schedule_slots WHERE job_code=$1
        ORDER BY scheduled_for DESC,slot_id DESC LIMIT 3`, [scope.key]
    );
    const recovered = rows.length === 3 && rows.every(row => row.status === 'succeeded');
    return { recovered, evidence: rows, ...(recovered ? {} : { reason: 'insufficient_later_successes' }) };
  }
  if (scope.type === 'dataset') {
    const parts = scope.key.split(':');
    const datasetCode = parts.shift();
    const partitionKey = parts.pop();
    const datasetScope = parts.join(':');
    if (!datasetCode || !partitionKey || !/^\d{4}-\d{2}-\d{2}$/.test(partitionKey)) {
      return { recovered: false, evidence: null, reason: 'invalid_dataset_scope' };
    }
    const { rows } = await query(
      `SELECT dataset_code,scope_key,partition_key::text,status,is_stale,diagnostics,published_at,updated_at
         FROM ops.dataset_partitions
        WHERE dataset_code=$1 AND scope_key=$2 AND partition_key=$3::date
        ORDER BY updated_at DESC LIMIT 1`, [datasetCode, datasetScope, partitionKey]
    );
    const row = rows[0];
    const quality = row && row.diagnostics && row.diagnostics.quality_status;
    const recovered = Boolean(row && row.status === 'published' && !row.is_stale && (!quality || quality === 'passed'));
    return { recovered, evidence: row || null, ...(recovered ? {} : { reason: 'dataset_not_published_or_quality_failed' }) };
  }
  if (scope.type === 'source_endpoint') {
    const separator = scope.key.indexOf(':');
    const source = separator >= 0 ? scope.key.slice(0, separator) : scope.key;
    const apiName = separator >= 0 ? scope.key.slice(separator + 1) : '*';
    const params = apiName === '*'
      ? [source]
      : [source, [apiName, '*']];
    const sql = apiName === '*'
      ? `SELECT source,api_name,state,recover_at,last_success_at,updated_at
           FROM ops.external_circuits WHERE source=$1 ORDER BY updated_at DESC`
      : `SELECT source,api_name,state,recover_at,last_success_at,updated_at
           FROM ops.external_circuits WHERE source=$1 AND api_name=ANY($2::text[]) ORDER BY updated_at DESC`;
    const { rows } = await query(sql, params);
    const lastSeen = alert.last_seen_at ? new Date(alert.last_seen_at).getTime() : NaN;
    const hasNewProbeSuccess = rows.some(row => {
      const successAt = row.last_success_at && new Date(row.last_success_at).getTime();
      return Number.isFinite(successAt) && (!Number.isFinite(lastSeen) || successAt > lastSeen);
    });
    const recovered = allCircuitsClosed(rows) && hasNewProbeSuccess;
    return {
      recovered,
      evidence: rows,
      ...(!rows.length ? { reason: 'circuit_evidence_missing' } : !hasNewProbeSuccess ? { reason: 'probe_success_evidence_missing' } : {}),
    };
  }
  return { recovered: false, evidence: null, reason: 'unknown_scope' };
}

async function recordResolutionFailure(error, context = {}) {
  await auditEvent({
    actor: 'system:worker', action: 'job_alert_resolution_failed',
    target: context.alertId || context.scopeKey || '',
    detail: error && error.message ? error.message : String(error), result: 'failure',
    metadata: { scopeType: context.scopeType, scopeKey: context.scopeKey, caller: context.caller },
  });
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
  const scope = alertScope(input);
  const { rows } = await pool.query(
    `INSERT INTO ops.alert_notifications(alert_key,alert_type,severity,job_code,slot_id,scope_type,scope_key,subject,summary,next_send_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
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
       updated_at=now()
     RETURNING *`,
    [key, input.alertType || 'failure', input.severity || 'critical', input.jobCode || null, input.slotId || null,
      scope.type, scope.key,
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
  const oneShotRecovery = ['recovery', 'worker_recovered', 'job_overdue_recovered', 'external_api_switch', 'external_api_interface_failover']
    .includes(String(input.alertType || ''));
  const repeatWindowMs = 6 * 60 * 60 * 1000;
  const force = Boolean(options.force || input.force);
  const manual = Boolean(options.manual || input.manual);
  const minOccurrences = Number(options.minOccurrences || input.minOccurrences || 1);
  if (oneShotRecovery && !manual && alert.last_sent_at) {
    return { ok: true, suppressed: true, alertId: alert.alert_id, reason: 'recovery_already_sent' };
  }
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
    { force: false, manual: false }
  );
}

async function resolveAlertsByCandidates(candidates, caller) {
  const resolvedRows = [];
  for (const alert of candidates) {
    const verification = await verifyAlertScope(alert);
    if (!verification.recovered) continue;
    const { rows } = await pool.query(
      `UPDATE ops.alert_notifications
          SET status='resolved',resolved_at=now(),sending_started_at=NULL,updated_at=now()
        WHERE alert_id=$1 AND status NOT IN ('resolved','acknowledged')
          AND alert_type NOT IN ('recovery','worker_recovered','job_overdue_recovered','external_api_switch','external_api_interface_failover')
        RETURNING *`, [alert.alert_id]
    );
    if (rows[0]) resolvedRows.push({ ...rows[0], verification });
  }
  if (resolvedRows.length) {
    const first = resolvedRows[0];
    await sendRecoveryAlert({
      alertKey: `slot:${first.slot_id || caller.slotId || 'job'}:recovered`,
      alertType: 'recovery', severity: 'info', jobCode: first.job_code || caller.jobCode, slotId: caller.slotId,
      subject: `后台任务已恢复：${first.job_code || caller.jobCode || '未知任务'}`,
      summary: `计划实例 ${caller.slotId || '-'} 已恢复成功，已按证据关闭 ${resolvedRows.length} 条相关告警，数据日期：${formatAlertDate(caller.data_as_of)}`,
    });
  }
  return resolvedRows.length;
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

async function resolveJobSlotAlerts(slot) {
  if (!productionAlertsEnabled()) return 0;
  try {
    const candidates = await loadResolutionCandidates(
      `((scope_type='slot' AND scope_key=$1::text)
          OR (scope_type IS NULL AND slot_id=$2::bigint)
          OR (scope_type='job' AND scope_key=$3::text)
          OR (slot_id=$2::bigint AND scope_type IN ('dataset','source_endpoint')))`
      , [String(slot.slot_id), slot.slot_id, slot.job_code || '']
    );
    return resolveAlertsByCandidates(candidates, slot);
  } catch (error) {
    await recordResolutionFailure(error, { caller: 'resolveJobSlotAlerts', slotId: slot.slot_id, scopeType: 'slot', scopeKey: String(slot.slot_id) });
    throw error;
  }
}

async function resolveDatasetAlerts(datasetCode, scopeKey, partitionKey) {
  if (!productionAlertsEnabled()) return 0;
  const key = `${datasetCode}:${scopeKey || ''}:${String(partitionKey).slice(0, 10)}`;
  try {
    const candidates = await loadResolutionCandidates(`scope_type='dataset' AND scope_key=$1::text`, [key]);
    return resolveAlertsByCandidates(candidates, { scopeType: 'dataset', scopeKey: key });
  } catch (error) {
    await recordResolutionFailure(error, { caller: 'resolveDatasetAlerts', scopeType: 'dataset', scopeKey: key });
    throw error;
  }
}

async function resolveSourceEndpointAlerts(source, apiName) {
  if (!productionAlertsEnabled()) return 0;
  const key = `${source}:${apiName || '*'}`;
  try {
    const candidates = await loadResolutionCandidates(`scope_type='source_endpoint' AND scope_key=$1::text`, [key]);
    return resolveAlertsByCandidates(candidates, { scopeType: 'source_endpoint', scopeKey: key });
  } catch (error) {
    await recordResolutionFailure(error, { caller: 'resolveSourceEndpointAlerts', scopeType: 'source_endpoint', scopeKey: key });
    throw error;
  }
}

// Python 任务的探测成功不会经过 Node 请求链路；健康检查周期性补做一次同样的
// 来源证据核对，确保“熔断已关闭 + last_success_at 晚于告警”后才收敛告警。
async function reconcileRecoveredSourceAlerts(limit = 100) {
  if (!productionAlertsEnabled()) return 0;
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 200);
  try {
    const { rows: candidates } = await pool.query(
      `SELECT * FROM ops.alert_notifications
        WHERE scope_type='source_endpoint'
          AND status NOT IN ('resolved','acknowledged')
          AND alert_type NOT IN ('recovery','worker_recovered','job_overdue_recovered','external_api_switch','external_api_interface_failover')
        ORDER BY last_seen_at ASC, alert_id ASC LIMIT $1`, [safeLimit]
    );
    let resolved = 0;
    for (const alert of candidates) {
      const verification = await verifyAlertScope(alert);
      if (!verification.recovered) continue;
      const { rows } = await pool.query(
        `UPDATE ops.alert_notifications
            SET status='resolved',resolved_at=now(),sending_started_at=NULL,updated_at=now()
          WHERE alert_id=$1 AND status NOT IN ('resolved','acknowledged')
          RETURNING *`, [alert.alert_id]
      );
      if (!rows[0]) continue;
      resolved += 1;
      const scope = parseAlertScope(rows[0]);
      await sendRecoveryAlert({
        alertKey: `source:${scope.key}:recovered`, alertType: 'recovery', severity: 'info',
        jobCode: rows[0].job_code || null, slotId: rows[0].slot_id || null,
        subject: `外部来源已恢复：${scope.key}`,
        summary: `来源 ${scope.key} 的全部相关熔断已关闭，且已记录新的探测成功时间；告警已按证据自动关闭。`,
      });
    }
    return resolved;
  } catch (error) {
    await recordResolutionFailure(error, { caller: 'reconcileRecoveredSourceAlerts', scopeType: 'source_endpoint' });
    throw error;
  }
}

async function resolveWorkerOfflineAlert(alertId) {
  if (!productionAlertsEnabled()) return 0;
  try {
    const { rows: workers } = await pool.query(
      `SELECT worker_id FROM ops.worker_heartbeats
        WHERE role='worker' AND status='running' AND last_seen_at >= now()-interval '2 minutes'
        ORDER BY last_seen_at DESC LIMIT 1`
    );
    if (!workers.length) return 0;
    const { rows } = await pool.query(
      `UPDATE ops.alert_notifications
          SET status='resolved',resolved_at=now(),sending_started_at=NULL,updated_at=now()
        WHERE alert_id=$1 AND status NOT IN ('resolved','acknowledged')
        RETURNING *`, [alertId]
    );
    if (rows[0]) {
      await sendRecoveryAlert({
        alertKey: `worker:recovered:${rows[0].alert_id}`, alertType: 'worker_recovered', severity: 'info',
        subject: '后台 Worker 已恢复', summary: '已重新收到 Worker 心跳，后台定时任务恢复运行。',
      });
    }
    return rows.length;
  } catch (error) {
    await recordResolutionFailure(error, { caller: 'resolveWorkerOfflineAlert', alertId, scopeType: 'worker', scopeKey: 'worker:offline' });
    throw error;
  }
}

async function listAlerts(options = {}) {
  const limit = Math.min(Math.max(parseInt(options.limit, 10) || 50, 1), 200);
  const status = String(options.status || '').toLowerCase();
  const open = status === 'open' || status === 'unresolved';
  const history = status === 'history';
  const allowed = ['pending', 'sending', 'sent', 'suppressed', 'send_failed', 'resolved', 'acknowledged'];
  const exact = allowed.includes(status) ? status : null;
  const { rows } = await pool.query(
    `SELECT * FROM ops.alert_notifications
      WHERE ($1::boolean = false OR (${ACTIVE_ALERT_WHERE}))
        AND ($2::text IS NULL OR status=$2)
        AND ($3::boolean = false OR status IN ('resolved','acknowledged'))
      ORDER BY last_seen_at DESC LIMIT $4`, [open, exact, history, limit]
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
  resolveDatasetAlerts, resolveSourceEndpointAlerts,
  reconcileRecoveredSourceAlerts, resolveWorkerOfflineAlert, notifyJobFailure, sendTestEmail, listAlerts, resendAlert, acknowledgeAlert,
  ACTIVE_ALERT_WHERE, parseAlertScope, allCircuitsClosed, verifyAlertScope,
};

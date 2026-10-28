const { pool } = require('../db/connection');
const { auditEvent } = require('../db');
const { mailer } = require('../config');
const { sanitizeJobError } = require('./jobErrorSanitizer');
const { getRegisteredJobDefinition } = require('./jobDefinitions');
const { verifySlotRecoveryEvidence, sameSlotRecoveryScope, slotWaitingState, recoveryScopeFilter } = require('./jobRecoveryEvidence');
const txControl = require('../repositories/transactionControl');
const { claimAlertDelivery, claimRecoverySummaryAlerts, loadResolutionCandidates } = require('../repositories/jobAlertMailerRepository.js');
const repository = require('../repositories/jobAlertMailerRepository.js');
const { ACTIVE_ALERT_WHERE } = repository;

const DELIVERY_RETRY_MINUTES = [1, 5, 15];
const MAX_DELIVERY_ATTEMPTS = DELIVERY_RETRY_MINUTES.length + 1;
const RECOVERY_SUMMARY_RETRY_MINUTES = 15;
const MAX_RECOVERY_SUMMARY_ATTEMPTS = 3;
const RECONCILIATION_COOLDOWN_MINUTES = [60, 360, 1440];
// 活动告警口径（SQL 片段）已下沉到数据层，由仓储导出共用。

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
const NOTIFICATION_ONLY_ALERT_TYPES = new Set([
  'recovery', 'worker_recovered', 'job_overdue_recovered', 'external_api_switch', 'external_api_interface_failover',
]);

// 故障告警的收敛策略注册表。未知类型允许写入和展示，但默认禁止自动关闭。
const ALERT_EVIDENCE_POLICIES = Object.freeze({
  failure: { autoResolve: true, verifier: 'slot_or_source', evidenceVersion: 1, scopes: ['slot', 'job', 'source_endpoint'] },
  failure_warning: { autoResolve: true, verifier: 'slot_or_source', evidenceVersion: 1, scopes: ['slot', 'job', 'source_endpoint'] },
  late: { autoResolve: true, verifier: 'slot', evidenceVersion: 1, scopes: ['slot', 'job'] },
  degraded: { autoResolve: true, verifier: 'slot', evidenceVersion: 1, scopes: ['slot', 'job'] },
  dependency_blocked: { autoResolve: true, verifier: 'slot_recovery_evidence', evidenceVersion: 1, scopes: ['slot', 'job'] },
  data_quality: { autoResolve: true, verifier: 'dataset_partition', evidenceVersion: 1, scopes: ['dataset', 'slot', 'job'] },
  source_fallback_degraded: { autoResolve: true, verifier: 'source_and_runtime', evidenceVersion: 1, scopes: ['source_endpoint'] },
  duplicate_success: { autoResolve: false, verifier: 'manual', evidenceVersion: 1, scopes: ['slot', 'job'] },
  worker_offline: { autoResolve: false, verifier: 'manual_worker_health', evidenceVersion: 1, scopes: ['job'] },
  ...Object.fromEntries([...NOTIFICATION_ONLY_ALERT_TYPES].map(type => [type, { autoResolve: false, verifier: 'notification', evidenceVersion: 1, notificationOnly: true, scopes: [] }])),
});

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

function laterSlotLimit(historical) {
  return historical ? 3 : 1;
}

// 恢复证据只看已经产生结果的后续实例：pending/running/blocked/waiting_external 还没有结论，
// skipped 只是“被接管”的归档标记，二者都不能参与最近恢复序列。
const RECOVERY_SEQUENCE_STATUSES = Object.freeze(['succeeded', 'degraded', 'failed']);

// 最近恢复序列：同任务、同业务日、同阶段、同范围的后续实例，按计划时间从新到旧取 N 条
// （自动 1 条、历史 3 条），每一条都必须通过严格证据。
// 不能取最早的 N 条——最早那条旧失败会永久占据查询前缀，之后的连续成功永远收敛不了告警；
// 也不能把失败过滤掉只留成功——那会把“最新一次又失败”伪造成已恢复。
async function loadRecentRecoverySequence(row, limit, query) {
  const recoveryScope = recoveryScopeFilter(row, 4);
  const statusIndex = recoveryScope.nextIndex;
  const limitIndex = statusIndex + 1;
  const { rows } = await query(
    `SELECT slot_id,job_code,status,business_date,scheduled_for,request_payload,result_summary,data_as_of
       FROM ops.job_schedule_slots
      WHERE job_code=$1 AND business_date=$2::date AND scheduled_for>$3::timestamptz
        AND status = ANY($${statusIndex}::text[])
        AND ${recoveryScope.sql}
      ORDER BY scheduled_for DESC,slot_id DESC LIMIT $${limitIndex}`,
    [row.job_code, row.business_date, row.scheduled_for, ...recoveryScope.params,
      RECOVERY_SEQUENCE_STATUSES, limit]
  );
  return rows;
}

// 审计与历史对账需要记录“用哪一版证据策略关的告警”，版本号与验证器都来自注册表。
function alertEvidencePolicy(alertType) {
  const policy = ALERT_EVIDENCE_POLICIES[String(alertType || '')];
  if (!policy) return null;
  return {
    verifier: policy.verifier || null,
    evidenceVersion: policy.evidenceVersion == null ? null : policy.evidenceVersion,
    autoResolve: policy.autoResolve !== false,
    notificationOnly: policy.notificationOnly === true,
  };
}

// 历史告警处置分类：恢复、正常等待、任务下线、人工处置和证据不足必须分开记录，
// 不能把“不满足自动恢复门槛”一律当成当前故障，也不能把“已确认”直接写成“已恢复”。
const ALERT_DISPOSITION_LABELS = Object.freeze({
  true_recovery: '真实恢复',
  normal_waiting: '正常等待',
  task_retired: '任务下线',
  manual_disposition: '历史人工处置',
  insufficient_evidence: '证据不足',
  not_a_fault: '通知型记录',
});

function classifyAlertDisposition(alert = {}, verification = {}) {
  const alertType = String(alert.alert_type || '');
  const policy = ALERT_EVIDENCE_POLICIES[alertType];
  if (policy && policy.notificationOnly) return { disposition: 'not_a_fault', reason: 'notification_only_alert' };
  if (!policy) return { disposition: 'manual_disposition', reason: 'unknown_alert_type_requires_manual_review' };
  if (policy.autoResolve === false) return { disposition: 'manual_disposition', reason: verification.reason || 'alert_type_not_auto_resolvable' };
  if (verification.recovered) return { disposition: 'true_recovery', reason: null };
  const reason = String(verification.reason || '');
  if (reason === 'waiting_evidence_not_due') return { disposition: 'normal_waiting', reason };
  const jobCode = String(alert.job_code || verification?.evidence?.slot?.job_code || '');
  const definition = jobCode ? getRegisteredJobDefinition(jobCode) : null;
  if (jobCode && (!definition || definition.disabled)) return { disposition: 'task_retired', reason: reason || 'job_not_registered_or_disabled' };
  if (['unknown_alert_type_requires_manual_review', 'alert_type_not_auto_resolvable'].includes(reason)) {
    return { disposition: 'manual_disposition', reason };
  }
  return { disposition: 'insufficient_evidence', reason: reason || 'evidence_insufficient' };
}

// 运行时自动收敛和历史告警调和共用这一个证据入口；historical 只表示历史槽位额外需要连续三次成功。
async function verifyAlertScope(alert, query = (sql, params) => repository.runQuery(sql, params), options = {}) {
  const scope = parseAlertScope(alert);
  const historical = Boolean(options.historical);
  const alertType = String(alert.alert_type || '');
  const policy = ALERT_EVIDENCE_POLICIES[alertType];
  if (!policy) {
    return { recovered: false, evidence: null, reason: 'unknown_alert_type_requires_manual_review' };
  }
  if (policy.notificationOnly || policy.autoResolve === false) {
    return { recovered: false, evidence: null, reason: policy.notificationOnly ? 'notification_only_alert' : 'alert_type_not_auto_resolvable' };
  }
  if (scope.type === 'slot') {
    const { rows } = await query(
      `SELECT slot_id,job_code,business_date,status,scheduled_for,updated_at,updated_at::text AS updated_at_exact,
              request_payload,result_summary,data_as_of
         FROM ops.job_schedule_slots WHERE slot_id=$1`, [scope.key]
    );
    const row = rows[0];
    // dependency_blocked 允许复用同槽位成功运行 + 发布分区的严格证据；
    // data_quality 仍必须使用 dataset 作用域，不能被单次任务成功掩盖。
    if (DATA_BOUND_ALERT_TYPES.has(alertType) && alertType !== 'dependency_blocked') {
      return { recovered: false, evidence: row || null, reason: 'data_bound_alert_requires_dataset_evidence' };
    }
    if (row && row.status === 'succeeded') {
      const original = await verifySlotRecoveryEvidence(row, query, { alertType });
      if (original.recovered || row.job_code !== 'nav_snapshot' || original.reason !== 'watermark_evidence_missing') return original;
      // 旧成功记录缺日期时保留原审计，只接受同日同账户范围的后续完整复验。
      // 走同一条“最近恢复序列”：完整范围条件在 SQL 里筛完，按最新计划时间取数。
      const required = laterSlotLimit(historical);
      const later = await loadRecentRecoverySequence(row, required, query);
      if (later.length !== required) return original;
      const verifications = [];
      for (const candidate of later) {
        if (!sameSlotRecoveryScope(row, candidate)) {
          return { recovered: false, reason: 'nav_requested_range_mismatch', evidence: { original: row, candidate } };
        }
        const verified = await verifySlotRecoveryEvidence(candidate, query, { alertType });
        if (!verified.recovered) return verified;
        verifications.push(verified.evidence);
      }
      return { recovered: true, evidence: { mode: 'later_verified_same_date_scope', original: row, verifications } };
    }
    if (!row || !row.job_code || !row.scheduled_for) {
      return { recovered: false, evidence: row || null, reason: row ? 'original_slot_not_recovered' : 'slot_not_found' };
    }
    // 有效等待不是故障：官方尚未披露、字段复查冷却和正常续批按 next_attempt_at 保留，
    // 到期后仍未执行或出现新错误才重新成为可处理异常。
    const waitingState = slotWaitingState(row);
    if (waitingState.waiting) {
      return { recovered: false, evidence: { slot: row, waiting: waitingState }, reason: 'waiting_evidence_not_due' };
    }
    const limit = laterSlotLimit(historical);
    const later = await loadRecentRecoverySequence(row, limit, query);
    // 后续成功必须与原告警同任务、同业务日、同阶段，且账户/市场、区间、证券和字段范围一致，
    // 并通过运行、阶段完整性和分区发布质量证据。不同任务或不同阶段不能互相抵消。
    // 序列按最新计划时间取，最后一条失败就说明最新状态仍是故障，不能被更早的成功掩盖。
    let recovered = later.length === limit;
    const verifications = [];
    for (const candidate of later) {
      if (!recovered) break;
      if (!sameSlotRecoveryScope(row, candidate)) { recovered = false; break; }
      const verified = await verifySlotRecoveryEvidence(
        { ...candidate, job_code: row.job_code, business_date: row.business_date }, query, { alertType }
      );
      if (!verified.recovered) { recovered = false; break; }
      verifications.push(verified.evidence);
    }
    return {
      recovered,
      evidence: {
        mode: historical ? 'three_later_job_successes' : 'later_comparable_slot_success',
        sequenceOrder: 'scheduled_for_desc', requiredCount: limit,
        original: row, later, verifications,
      },
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
      : [source, apiName];
    const sql = apiName === '*'
      ? `SELECT source,api_name,state,recover_at,last_success_at,updated_at
           FROM ops.external_circuits WHERE source=$1 ORDER BY updated_at DESC`
      : `SELECT source,api_name,state,recover_at,last_success_at,updated_at
           FROM ops.external_circuits WHERE source=$1 AND api_name=$2 ORDER BY updated_at DESC`;
    const { rows: queriedRows } = await query(sql, params);
    // 查询和证据都做一次精确作用域过滤，避免错误 SQL、历史兼容层或测试替身把 source:* 混入具体接口。
    const rows = apiName === '*'
      ? queriedRows
      : queriedRows.filter(row => String(row.api_name || '') === apiName);
    const lastSeen = alert.last_seen_at ? new Date(alert.last_seen_at).getTime() : NaN;
    const hasNewProbeSuccess = rows.some(row => {
      const successAt = row.last_success_at && new Date(row.last_success_at).getTime();
      return Number.isFinite(successAt) && (!Number.isFinite(lastSeen) || successAt > lastSeen);
    });
    const recovered = allCircuitsClosed(rows) && hasNewProbeSuccess;
    if (alertType === 'source_fallback_degraded') {
      const runtimeApi = apiName === '*' ? 'arbitrage' : apiName;
      const { rows: runtime } = await query(
        `SELECT r.consecutive_fallback_count,r.last_primary_success_at
           FROM ops.source_endpoint_runtime r
           JOIN ops.data_sources ds ON ds.source_id=r.source_id
          WHERE ds.source_code=$1 AND r.api_name=$2`, [source, runtimeApi]
      );
      const runtimeRecovered = runtime.some(item => Number(item.consecutive_fallback_count || 0) === 0
        && item.last_primary_success_at
        && (!Number.isFinite(lastSeen) || new Date(item.last_primary_success_at).getTime() > lastSeen));
      return {
        recovered: allCircuitsClosed(rows) && runtimeRecovered,
        evidence: { circuits: rows, runtime },
        ...(!rows.length ? { reason: 'circuit_evidence_missing' } : !runtimeRecovered ? { reason: 'primary_source_recovery_evidence_missing' } : {}),
      };
    }
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
  const { rows } = await repository.insert_ops_alert_notifications([key, input.alertType || 'failure', input.severity || 'critical', input.jobCode || null, input.slotId || null,
      scope.type, scope.key,
      sanitizeJobError(input.subject || `后台任务异常：${input.jobCode || '未知任务'}`, 500), sanitizeJobError(input.summary || '', 4000)]);
  return rows[0];
}

async function deliverAlert(alert) {
  // 最终邮件出口再做一次生产环境校验，防止测试或本地开发误加载真实 SMTP 后向真实收件人发信。
  if (!productionAlertsEnabled()) {
    await repository.update_ops_alert_notifications([alert.alert_id]);
    return { ok: true, suppressed: true, alertId: alert.alert_id, reason: 'non_production_environment' };
  }
  const claimed = await claimAlertDelivery(alert.alert_id);
  if (!claimed) return { ok: true, suppressed: true, alertId: alert.alert_id };
  const to = recipients();
  const attempt = Number(claimed.send_attempts || 0);
  const delay = DELIVERY_RETRY_MINUTES[Math.min(attempt - 1, DELIVERY_RETRY_MINUTES.length - 1)];
  if (attempt > MAX_DELIVERY_ATTEMPTS) return { ok: false, alertId: alert.alert_id, exhausted: true };

  if (!mailer || !to.length) {
    await repository.update_ops_alert_notifications_1([alert.alert_id, '未配置 SMTP 或 ALERT_EMAIL_TO', MAX_DELIVERY_ATTEMPTS, String(delay)]);
    return { ok: false, alertId: alert.alert_id, error: '未配置 SMTP 或 ALERT_EMAIL_TO' };
  }

  try {
    await mailer.sendMail({
      from: process.env.ALERT_EMAIL_FROM || `存在小站任务告警 <${process.env.SMTP_USER}>`,
      to,
      subject: `[${process.env.ALERT_ENVIRONMENT || process.env.NODE_ENV || 'development'}] ${sanitizeJobError(alert.subject || '', 500)}`,
      text: `${sanitizeJobError(alert.summary || '', 4000)}\n\n任务：${alert.job_code || '-'}\n告警时间：${new Date().toISOString()}`,
    });
    await repository.update_ops_alert_notifications_2([alert.alert_id]);
    return { ok: true, alertId: alert.alert_id };
  } catch (error) {
    await repository.update_ops_alert_notifications_1([alert.alert_id, sanitizeJobError(error.message || error, 1000), MAX_DELIVERY_ATTEMPTS, String(delay)]);
    return { ok: false, alertId: alert.alert_id, error: sanitizeJobError(error.message || error) };
  }
}

async function sendAlert(input, options = {}) {
  // 非生产环境不创建任务告警记录，也不触碰共享告警状态。
  if (!productionAlertsEnabled()) {
    return { ok: true, suppressed: true, reason: 'non_production_environment' };
  }
  let alert = await upsertAlert(input);
  const warning = String(input.severity || alert.severity || '').toLowerCase() === 'warning';
  const oneShotRecovery = ['recovery', 'worker_recovered', 'job_overdue_recovered', 'external_api_switch', 'external_api_interface_failover']
    .includes(String(input.alertType || ''));
  const repeatWindowMs = 6 * 60 * 60 * 1000;
  const force = Boolean(options.force || input.force);
  const manual = Boolean(options.manual || input.manual);
  const minOccurrences = Number(options.minOccurrences || input.minOccurrences || 1);
  if (oneShotRecovery && !manual && alert.last_sent_at) {
    return { ok: true, suppressed: true, alertId: alert.alert_id, reason: 'recovery_already_sent' };
  }
  // warning 首次只落库并进入每日摘要，不在故障现场即时发邮件；人工重发仍可显式发送。
  if (warning && !manual && !force) {
    await repository.update_ops_alert_notifications_3([alert.alert_id]);
    return { ok: true, deferred: true, alertId: alert.alert_id, reason: 'warning_daily_summary' };
  }
  if (force) {
    const { rows } = await repository.update_ops_alert_notifications_4([alert.alert_id]);
    if (rows[0]) alert = rows[0];
  }
  if (!force && Number(alert.occurrence_count || 0) < minOccurrences) {
    await repository.update_ops_alert_notifications_5([alert.alert_id]);
    return { ok: true, deferred: true, alertId: alert.alert_id };
  }
  if (!force && alert.next_send_at && new Date(alert.next_send_at).getTime() > Date.now()) {
    return { ok: true, suppressed: true, alertId: alert.alert_id };
  }
  if (!force && !manual && alert.last_sent_at && Date.now() - new Date(alert.last_sent_at).getTime() < repeatWindowMs) {
    await repository.update_ops_alert_notifications_6([alert.alert_id]);
    return { ok: true, suppressed: true, alertId: alert.alert_id };
  }
  return deliverAlert(alert);
}

/* claimAlertDelivery 已迁入 server/repositories/jobAlertMailerRepository.js */

async function sendDueAlerts(limit = 20) {
  if (!productionAlertsEnabled()) {
    return { ok: true, suppressed: true, count: 0, results: [], reason: 'non_production_environment' };
  }
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  await repository.update_ops_alert_notifications_7([MAX_DELIVERY_ATTEMPTS]);
  const results = [];
  const recovery = await sendRecoverySummary();
  if (recovery) results.push(recovery);
  const { rows } = await repository.select_ops_alert_notifications([MAX_DELIVERY_ATTEMPTS, safeLimit]);
  for (const alert of rows) results.push(await deliverAlert(alert));
  return { ok: results.every(item => item.ok), count: results.length, results };
}

/* claimRecoverySummaryAlerts 已迁入 server/repositories/jobAlertMailerRepository.js */

async function releaseRecoverySummaryClaim(claim) {
  if (!claim || !claim.client) return;
  await repository.select_data(claim.client).catch(() => {});
  claim.client.release();
}

async function sendRecoverySummary() {
  if (!productionAlertsEnabled()) return null;
  const to = recipients();
  if (!mailer || !to.length) return null;
  const { rows: dueFailures } = await repository.select_ops_alert_notifications_1([MAX_RECOVERY_SUMMARY_ATTEMPTS]);
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
    const { rows } = await repository.select_ops_alert_notifications_2([ids], claim.client);
    const detailRows = rows.slice(0, 100);
    const lines = detailRows.map(row => `- ${row.job_code || '未知任务'}：${sanitizeJobError(row.subject, 500)}；累计 ${row.occurrence_count || 1} 次；${sanitizeJobError(row.summary, 1000)}`).join('\n');
    const omitted = rows.length > detailRows.length ? `\n- 另有 ${rows.length - detailRows.length} 条告警已合并处理` : '';
    await mailer.sendMail({
      from: process.env.ALERT_EMAIL_FROM || `存在小站任务告警 <${process.env.SMTP_USER}>`,
      to,
      subject: `[${process.env.ALERT_ENVIRONMENT || process.env.NODE_ENV || 'development'}] 后台告警投递已恢复`,
      text: `SMTP 恢复后，系统合并补发 ${rows.length} 条历史告警：\n\n${lines}${omitted}`,
    });
    await repository.update_ops_alert_notifications_8([ids], claim.client);
    return { ok: true, summary: true, count: rows.length };
  } catch (error) {
    await repository.update_ops_alert_notifications_9([ids, MAX_DELIVERY_ATTEMPTS, MAX_RECOVERY_SUMMARY_ATTEMPTS,
        String(RECOVERY_SUMMARY_RETRY_MINUTES), sanitizeJobError(error.message || error, 1000)], claim.client);
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
    const { rows } = await repository.update_ops_alert_notifications_10([alert.alert_id]);
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

/* loadResolutionCandidates 已迁入 server/repositories/jobAlertMailerRepository.js */

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
    const { rows: candidates } = await repository.select_ops_alert_notifications_3([safeLimit]);
    let resolved = 0;
    for (const alert of candidates) {
      const verification = await verifyAlertScope(alert);
      if (!verification.recovered) continue;
      const { rows } = await repository.update_ops_alert_notifications_11([alert.alert_id]);
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

function reconciliationCooldownMinutes(alert) {
  const occurrences = Math.max(1, Number(alert && alert.occurrence_count || 1));
  return RECONCILIATION_COOLDOWN_MINUTES[Math.min(RECONCILIATION_COOLDOWN_MINUTES.length - 1, occurrences - 1)];
}

// 健康检查使用的历史告警公平扫描：新告警优先，其余按到期时间轮转，并保留无证据告警。
async function reconcileHistoricalAlerts(limit = 100) {
  if (!productionAlertsEnabled()) return { checked: 0, resolved: 0, skipped: true };
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 100);
  const { rows: candidates } = await repository.select_ops_alert_notifications_4([safeLimit]);
  let resolved = 0;
  for (const alert of candidates) {
    let verification;
    try {
      verification = await verifyAlertScope(alert, undefined, { historical: true });
    } catch (error) {
      await recordResolutionFailure(error, { caller: 'reconcileHistoricalAlerts', alertId: alert.alert_id, scopeType: alert.scope_type, scopeKey: alert.scope_key });
      continue;
    }
    if (verification.recovered) {
      const { rows } = await repository.update_ops_alert_notifications_12([alert.alert_id]);
      resolved += rows.length;
    } else {
      const cooldown = reconciliationCooldownMinutes(alert);
      await repository.update_ops_alert_notifications_13([alert.alert_id, String(cooldown)]);
    }
  }
  return { checked: candidates.length, resolved };
}

async function reconcilePartialDataAlerts(limit = 100) {
  if (!productionAlertsEnabled()) return { checked: 0, created: 0, skipped: true };
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 100);
  const { rows } = await repository.select_ops_dataset_partitions([safeLimit]);
  let created = 0;
  for (const row of rows) {
    const result = await sendAlert({
      alertKey: `partial_published:${row.dataset_code}:${row.scope_key}:${row.partition_key}`,
      alertType: 'data_quality', severity: 'warning', scopeType: 'dataset',
      scopeKey: `${row.dataset_code}:${row.scope_key}:${row.partition_key}`,
      subject: `数据集分区长期部分发布：${row.dataset_code}`,
      summary: `分区 ${row.dataset_code}/${row.scope_key}/${row.partition_key} 已超过 2 个日历日仍未完整，继续保留部分事实和缺口证据。`,
    });
    if (result && result.alertId) created += 1;
  }
  return { checked: rows.length, created };
}

async function resolveWorkerOfflineAlert(alertId) {
  if (!productionAlertsEnabled()) return 0;
  try {
    const { rows: workers } = await repository.select_ops_worker_heartbeats();
    if (!workers.length) return 0;
    const { rows } = await repository.update_ops_alert_notifications_14([alertId]);
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
  const { rows } = await repository.listAlertPage({ open, exact, history, limit });
  return rows.map(sanitizeAlertRecord);
}

async function resendAlert(alertId) {
  if (!productionAlertsEnabled()) {
    return { ok: true, suppressed: true, alertId, reason: 'non_production_environment' };
  }
  const { rows } = await repository.select_ops_alert_notifications_5([alertId]);
  if (!rows[0]) return null;
  const { rows: resetRows } = await repository.update_ops_alert_notifications_15([alertId]);
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
  const { rows } = await repository.update_ops_alert_notifications_16([alertId]);
  return sanitizeAlertRecord(rows[0]);
}

module.exports = {
  sendAlert, sendDueAlerts, sendRecoveryAlert, resolveJobSlotAlerts,
  resolveDatasetAlerts, resolveSourceEndpointAlerts,
  reconcileRecoveredSourceAlerts, reconcileHistoricalAlerts, reconcilePartialDataAlerts, resolveWorkerOfflineAlert, notifyJobFailure, sendTestEmail, listAlerts, resendAlert, acknowledgeAlert,
  ACTIVE_ALERT_WHERE, parseAlertScope, allCircuitsClosed, verifyAlertScope, ALERT_EVIDENCE_POLICIES,
  classifyAlertDisposition, ALERT_DISPOSITION_LABELS, alertEvidencePolicy, RECOVERY_SEQUENCE_STATUSES,
};

// 告警服务挂载到数据集发布钩子：数据层不反向依赖本模块，加载时自动接线。
require('./datasetPartitions').setDatasetPublishedHook(resolveDatasetAlerts);

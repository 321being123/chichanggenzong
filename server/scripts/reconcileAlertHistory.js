#!/usr/bin/env node
// 历史后台告警收敛核查：默认只读预览；--apply 仅关闭已验证恢复且显式列出的告警。
// 该脚本不自动发送恢复邮件，也不替用户确认线上数据修复。
// 逐 ID 复核会同时输出处置分类（真实恢复/正常等待/任务下线/人工处置/证据不足），
// 不把“不满足自动恢复门槛”直接当成当前故障，也不把“已确认”改写成“已恢复”。
require('dotenv').config();

const { pool } = require('../db/connection');
const { auditEvent } = require('../db');
const {
  parseAlertScope, allCircuitsClosed, verifyAlertScope, classifyAlertDisposition, ALERT_DISPOSITION_LABELS,
  alertEvidencePolicy,
} = require('../services/jobAlertMailer');
const { businessDateText, slotVersionText } = require('../services/jobRecoveryEvidence');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const CONFIRM = process.env.CONFIRM_ALERT_RECONCILIATION === '1';
// 已确认记录表达人工已知的正常等待/任务退役，默认不参与自动转换；
// 只有显式加 --include-acknowledged 才允许在通过证据后转换，并保留原确认审计。
const INCLUDE_ACKNOWLEDGED = argv.includes('--include-acknowledged');
const LIMIT = Math.min(Math.max(Number(valueOf('--limit', '200')) || 200, 1), 1000);

function valueOf(flag, fallback = '') {
  const index = argv.indexOf(flag);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

function selectedIds() {
  return String(valueOf('--alert-ids', '')).split(',').map(item => Number(item.trim()))
    .filter(item => Number.isInteger(item) && item > 0);
}

// 兼容历史脚本和既有测试；判断规则统一由 jobAlertMailer 提供。
const parseScope = parseAlertScope;
async function verifyScope(alert, query = (sql, params) => pool.query(sql, params)) {
  return verifyAlertScope(alert, query, { historical: true });
}

// 审计里保留可追溯的槽位、运行、分区和证据版本，便于事后复核“为什么关”。
// 运行 ID、分区日期/范围和证据策略版本都要真正落库（受限结构白名单见 sanitizeAuditMeta），
// 不能只在内存对象里构造好、写库时又被通用过滤丢掉。
function evidenceTrace(verification = {}, alert = {}) {
  const evidence = verification.evidence || {};
  const original = evidence.original || evidence.slot || null;
  const runs = [];
  const partitions = [];
  const partitionDates = new Set();
  for (const item of [evidence, evidence.waiting, ...(evidence.verifications || [])]) {
    if (!item) continue;
    const run = item.run;
    if (run && run.id != null) runs.push({ id: Number(run.id), status: run.status || null, attemptNo: run.attempt_no ?? null });
    const itemDate = item.partitionKey ? businessDateText(item.partitionKey) : null;
    if (itemDate) partitionDates.add(itemDate);
    for (const dataset of item.datasets || []) {
      if (!dataset || !dataset.dataset_code) continue;
      const date = dataset.partition_key ? businessDateText(dataset.partition_key) : itemDate;
      if (date) partitionDates.add(date);
      partitions.push({
        code: String(dataset.dataset_code),
        scope: String(dataset.scope_key ?? ''),
        partitionKey: date || null,
        status: dataset.status || null,
      });
    }
  }
  const policy = alertEvidencePolicy(alert.alert_type);
  return {
    evidenceMode: evidence.mode || null,
    evidenceReason: verification.reason || null,
    // 证据版本来自告警证据策略注册表：事后能判断这次关闭依据的是哪一版验证规则。
    evidenceVersion: policy ? policy.evidenceVersion : null,
    evidenceVerifier: policy ? policy.verifier : null,
    originalSlotId: original && original.slot_id != null ? Number(original.slot_id) : null,
    originalStatus: original && original.status ? original.status : null,
    originalScheduledFor: original && original.scheduled_for ? new Date(original.scheduled_for).toISOString() : null,
    slotVersion: original ? slotVersionText(original) : null,
    runIds: [...new Set(runs.map(item => item.id))].slice(0, 6),
    runs: runs.slice(0, 6),
    partitions: partitions.slice(0, 6),
    partitionDates: [...partitionDates].slice(0, 6),
  };
}

// 实际关闭入口：逐 ID 行锁 + 用同一事务连接重新取证。预览到写入之间证据失效、
// 状态被改、或原运行/分区质量退化时一律拒绝，不能凭预览结果批量 UPDATE。
async function applyReconciliation(alertIds, options = {}) {
  const includeAcknowledged = Boolean(options.includeAcknowledged);
  const ids = (alertIds || []).map(Number).filter(item => Number.isInteger(item) && item > 0);
  const closed = [];
  const refused = [];
  if (!ids.length) return { closed, refused };
  const client = options.client || await pool.connect();
  const ownsClient = !options.client;
  try {
    if (ownsClient) await client.query('BEGIN');
    for (const alertId of ids) {
      const { rows: lockedRows } = await client.query(
        `SELECT * FROM ops.alert_notifications
          WHERE alert_id=$1 AND status <> 'resolved'
          FOR UPDATE`, [alertId]
      );
      const locked = lockedRows[0];
      if (!locked) {
        refused.push({ alertId, reason: 'alert_status_changed' });
        continue;
      }
      if (!includeAcknowledged && locked.status === 'acknowledged') {
        refused.push({ alertId, reason: 'acknowledged_requires_explicit_flag' });
        continue;
      }
      const verification = await verifyAlertScope(locked, (sql, params) => client.query(sql, params), { historical: true });
      if (!verification.recovered) {
        refused.push({ alertId, reason: verification.reason || 'evidence_invalidated', previousStatus: locked.status });
        continue;
      }
      const disposition = classifyAlertDisposition(locked, verification);
      if (disposition.disposition !== 'true_recovery') {
        refused.push({ alertId, reason: `disposition_${disposition.disposition}`, previousStatus: locked.status });
        continue;
      }
      const { rows: updatedRows } = await client.query(
        `UPDATE ops.alert_notifications
            SET status='resolved',resolved_at=now(),sending_started_at=NULL,updated_at=now()
          WHERE alert_id=$1 AND status=$2
          RETURNING alert_id`, [alertId, locked.status]
      );
      if (!updatedRows[0]) {
        refused.push({ alertId, reason: 'concurrent_status_change' });
        continue;
      }
      closed.push(alertId);
      // 状态写入与审计同事务：保留原处置分类、证据版本和可追溯的槽位/运行/分区。
      await auditEvent({
        actor: 'system:reconcileAlertHistory',
        action: 'job_alert_history_reconciled',
        target: String(alertId),
        detail: `历史告警按证据转为已恢复：${ALERT_DISPOSITION_LABELS[disposition.disposition] || disposition.disposition}`,
        result: 'success',
        metadata: {
          alertId, alertKey: locked.alert_key, previousStatus: locked.status,
          disposition: disposition.disposition, dispositionReason: disposition.reason,
          scope: parseScope(locked), includeAcknowledged,
          ...evidenceTrace(verification, locked),
        },
      }, client);
    }
    if (ownsClient) await client.query('COMMIT');
  } catch (error) {
    if (ownsClient) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    if (ownsClient) client.release();
  }
  return { closed, refused };
}

async function main() {
  if (APPLY && process.env.NODE_ENV === 'production' && !CONFIRM) {
    throw new Error('生产告警收敛必须设置 CONFIRM_ALERT_RECONCILIATION=1');
  }
  const ids = selectedIds();
  if (APPLY && !ids.length) throw new Error('--apply 必须同时传入 --alert-ids 1,2,...');
  // 逐 ID 复核历史处置时必须能读到已解决记录，否则无法解释当时的关闭依据。
  const where = ids.length
    ? 'alert_id = ANY($1::bigint[])'
    : INCLUDE_ACKNOWLEDGED ? "status <> 'resolved'" : "status NOT IN ('resolved','acknowledged')";
  const { rows: alerts } = await pool.query(
    `SELECT alert_id,alert_key,alert_type,status,job_code,slot_id,scope_type,scope_key,last_seen_at,acknowledged_at
       FROM ops.alert_notifications
      WHERE ${where}
      ORDER BY last_seen_at DESC${ids.length ? '' : ' LIMIT $1'}`,
    ids.length ? [ids] : [LIMIT]
  );
  const candidates = [];
  const unresolved = [];
  const summary = Object.fromEntries(Object.keys(ALERT_DISPOSITION_LABELS).map(key => [key, 0]));
  for (const alert of alerts) {
    const verification = await verifyScope(alert);
    const disposition = classifyAlertDisposition(alert, verification);
    summary[disposition.disposition] = (summary[disposition.disposition] || 0) + 1;
    const item = {
      alertId: Number(alert.alert_id), alertKey: alert.alert_key, scope: parseScope(alert), status: alert.status,
      disposition: disposition.disposition, dispositionLabel: ALERT_DISPOSITION_LABELS[disposition.disposition] || disposition.disposition,
      dispositionReason: disposition.reason, ...verification,
    };
    if (verification.recovered) candidates.push(item);
    else unresolved.push(item);
  }
  const selected = candidates.filter(item => ids.includes(item.alertId));
  const applicable = selected.filter(item => INCLUDE_ACKNOWLEDGED || item.status !== 'acknowledged');
  const skippedAcknowledged = selected.length - applicable.length;
  // 预览只用于展示；实际写入走 applyReconciliation，在事务内逐 ID 重新取证。
  const applied = APPLY && applicable.length
    ? await applyReconciliation(applicable.map(item => item.alertId), { includeAcknowledged: INCLUDE_ACKNOWLEDGED })
    : { closed: [], refused: [] };
  console.log(JSON.stringify({ mode: APPLY ? 'apply' : 'dry-run', scanned: alerts.length,
    candidateCount: candidates.length, selectedCount: selected.length, appliedCount: applicable.length,
    skippedAcknowledged, closed: applied.closed, refused: applied.refused, dispositionSummary: summary,
    candidates: applicable, skipped: unresolved }, null, 2));
}

if (require.main === module) {
  main().catch(error => {
    console.error(`历史告警收敛核查失败：${error.message}`);
    process.exitCode = 1;
  }).finally(() => pool.end());
}

module.exports = { allCircuitsClosed, parseScope, verifyScope, applyReconciliation, evidenceTrace };

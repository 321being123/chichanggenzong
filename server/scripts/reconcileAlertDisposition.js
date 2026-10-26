#!/usr/bin/env node
// 历史告警处置分类修订：把被批量改成 resolved 的已确认告警，按逐条证据重新分类，
// 不能证明真实恢复的一律退回 acknowledged（人工已知但未证实恢复），不重开成待处理故障、
// 不删除记录、不改 acknowledged_at。默认只读预览；--apply 必须显式列 ID 并设置
// CONFIRM_ALERT_DISPOSITION=1。resolved 只表示验证通过的恢复，所以这里只做单向退回；
// 需要重新确认真实恢复时仍走 reconcileAlertHistory --include-acknowledged。
require('dotenv').config();

const fs = require('fs');
const { pool } = require('../db/connection');
const { auditEvent } = require('../db');
const {
  parseAlertScope, verifyAlertScope, classifyAlertDisposition, ALERT_DISPOSITION_LABELS, alertEvidencePolicy,
} = require('../services/jobAlertMailer');
const { businessDateText, slotVersionText } = require('../services/jobRecoveryEvidence');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const CONFIRM = process.env.CONFIRM_ALERT_DISPOSITION === '1';
const OUT = String(valueOf('--out', ''));
const SINCE = String(valueOf('--since', ''));
const BATCH = String(valueOf('--batch', 'batch_close'));
const OPERATOR = String(valueOf('--operator', 'reconcile-alert-disposition'));

function valueOf(flag, fallback = '') {
  const index = argv.indexOf(flag);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

function selectedIds() {
  return String(valueOf('--alert-ids', '')).split(',').map(item => Number(item.trim()))
    .filter(item => Number.isInteger(item) && item > 0);
}

// 修订对象只允许“曾经人工确认过、后来被改成已恢复”的记录：acknowledged_at 非空是硬条件，
// 否则会误伤本来就没有人工确认依据的历史记录。
async function loadTargets(ids, query) {
  if (ids.length) {
    const { rows } = await query(
      `SELECT * FROM ops.alert_notifications WHERE alert_id = ANY($1::bigint[]) ORDER BY alert_id`, [ids]
    );
    return rows;
  }
  if (!SINCE) throw new Error('未提供 --alert-ids 时必须指定 --since YYYY-MM-DD');
  const { rows } = await query(
    `SELECT * FROM ops.alert_notifications
      WHERE acknowledged_at IS NOT NULL AND status='resolved' AND updated_at::date=$1::date
      ORDER BY alert_id`, [SINCE]
  );
  return rows;
}

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
  const policy = alertEvidencePolicy(alert.alert_type) || {};
  return {
    evidenceMode: evidence.mode || null,
    evidenceVersion: policy.evidenceVersion == null ? null : policy.evidenceVersion,
    evidenceVerifier: policy.verifier || null,
    originalSlotId: original && original.slot_id != null ? Number(original.slot_id) : null,
    originalStatus: original && original.status ? original.status : null,
    slotVersion: original ? slotVersionText(original) : null,
    runIds: [...new Set(runs.map(item => item.id))].slice(0, 6),
    runs: runs.slice(0, 6),
    partitions: partitions.slice(0, 6),
    partitionDates: [...partitionDates].slice(0, 6),
  };
}

// 单条决策：只有验证通过且分类为真实恢复才保留 resolved；其余一律退回 acknowledged。
function decide(alert, verification) {
  const disposition = classifyAlertDisposition(alert, verification);
  const keepResolved = verification.recovered === true && disposition.disposition === 'true_recovery';
  return {
    disposition: disposition.disposition,
    dispositionLabel: ALERT_DISPOSITION_LABELS[disposition.disposition] || disposition.disposition,
    dispositionReason: disposition.reason,
    recovered: verification.recovered === true,
    verifyReason: verification.reason || null,
    nextStatus: keepResolved ? 'resolved' : 'acknowledged',
    dataRecovered: keepResolved,
  };
}

async function preview(targets, query) {
  const items = [];
  const summary = {};
  for (const alert of targets) {
    const verification = await verifyAlertScope(alert, query, { historical: true })
      .catch(error => ({ recovered: false, reason: `verify_failed:${error.message}`, evidence: null }));
    const decision = decide(alert, verification);
    summary[decision.disposition] = (summary[decision.disposition] || 0) + 1;
    items.push({
      alertId: Number(alert.alert_id),
      alertKey: alert.alert_key,
      alertType: alert.alert_type,
      jobCode: alert.job_code,
      slotId: alert.slot_id == null ? null : Number(alert.slot_id),
      scope: parseAlertScope(alert),
      previousStatus: alert.status,
      acknowledgedAt: alert.acknowledged_at,
      nextStatus: decision.nextStatus,
      ...decision,
      evidence: evidenceTrace(verification, alert),
    });
  }
  return { items, summary };
}

// 实际写入：逐 ID 行锁 + 事务内重新取证，预览到写入之间证据或状态变化一律拒绝，
// 不按预览结果批量 UPDATE。审计与状态写入同事务。
async function applyCorrection(items, options = {}) {
  const closed = [];
  const refused = [];
  const client = options.client || await pool.connect();
  const ownsClient = !options.client;
  try {
    if (ownsClient) await client.query('BEGIN');
    for (const item of items) {
      const { rows: lockedRows } = await client.query(
        `SELECT * FROM ops.alert_notifications
          WHERE alert_id=$1 AND status='resolved' AND acknowledged_at IS NOT NULL
          FOR UPDATE`, [item.alertId]
      );
      const locked = lockedRows[0];
      if (!locked) {
        refused.push({ alertId: item.alertId, reason: 'alert_not_resolved_or_not_acknowledged' });
        continue;
      }
      const verification = await verifyAlertScope(locked, (sql, params) => client.query(sql, params), { historical: true })
        .catch(error => ({ recovered: false, reason: `verify_failed:${error.message}`, evidence: null }));
      const decision = decide(locked, verification);
      if (decision.nextStatus !== 'acknowledged') {
        refused.push({ alertId: item.alertId, reason: `still_${decision.disposition}`, disposition: decision.disposition });
        continue;
      }
      const trace = evidenceTrace(verification, locked);
      const { rows: updatedRows } = await client.query(
        `UPDATE ops.alert_notifications
            SET status='acknowledged', resolved_at=NULL, sending_started_at=NULL,
                last_send_error=NULL, updated_at=now()
          WHERE alert_id=$1 AND status='resolved'
          RETURNING alert_id, status`, [item.alertId]
      );
      if (!updatedRows[0]) {
        refused.push({ alertId: item.alertId, reason: 'concurrent_status_change' });
        continue;
      }
      await auditEvent({
        actor: OPERATOR,
        action: 'alert_disposition_correct',
        target: String(item.alertId),
        result: 'success',
        metadata: {
          batch: BATCH,
          disposition: decision.disposition,
          dispositionReason: decision.dispositionReason,
          verifyReason: decision.verifyReason,
          previousStatus: 'resolved',
          newStatus: 'acknowledged',
          dataRecovered: decision.dataRecovered,
          alertType: locked.alert_type,
          jobCode: locked.job_code || null,
          slotId: locked.slot_id == null ? null : Number(locked.slot_id),
          evidenceVersion: trace.evidenceVersion,
          evidenceVerifier: trace.evidenceVerifier,
          slotVersion: trace.slotVersion,
          runIds: trace.runIds,
          partitionDates: trace.partitionDates,
          rollback: 'resolved',
        },
      }, client);
      closed.push({ alertId: item.alertId, disposition: decision.disposition, newStatus: 'acknowledged' });
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
  if (APPLY && !CONFIRM) throw new Error('生产告警处置修订必须设置 CONFIRM_ALERT_DISPOSITION=1');
  const ids = selectedIds();
  if (APPLY && !ids.length) throw new Error('--apply 必须同时传入 --alert-ids 1,2,...');
  const targets = await loadTargets(ids, (sql, params) => pool.query(sql, params));
  const { items, summary } = await preview(targets, (sql, params) => pool.query(sql, params));
  const pending = items.filter(item => item.nextStatus === 'acknowledged');
  const result = {
    mode: APPLY ? 'apply' : 'dry-run',
    scanned: targets.length,
    revertCount: pending.length,
    keepResolvedCount: items.length - pending.length,
    dispositionSummary: summary,
    closed: [],
    refused: [],
    items,
  };
  if (APPLY) {
    const applied = await applyCorrection(pending);
    result.closed = applied.closed;
    result.refused = applied.refused;
  }
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
  console.log(JSON.stringify({
    mode: result.mode,
    scanned: result.scanned,
    revertCount: result.revertCount,
    keepResolvedCount: result.keepResolvedCount,
    dispositionSummary: result.dispositionSummary,
    appliedCount: result.closed.length,
    refused: result.refused,
    out: OUT || null,
  }, null, 1));
  await pool.end();
}

module.exports = { preview, applyCorrection, decide, loadTargets, evidenceTrace };

if (require.main === module) {
  main().catch(error => { console.error('处置分类修订失败:', error.message); process.exit(1); });
}

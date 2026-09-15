#!/usr/bin/env node
// 历史后台告警收敛核查：默认只读预览；--apply 仅关闭已验证恢复且显式列出的告警。
// 该脚本不自动发送恢复邮件，也不替用户确认线上数据修复。
require('dotenv').config();

const { pool } = require('../db/connection');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const CONFIRM = process.env.CONFIRM_ALERT_RECONCILIATION === '1';
const LIMIT = Math.min(Math.max(Number(valueOf('--limit', '200')) || 200, 1), 1000);

function valueOf(flag, fallback = '') {
  const index = argv.indexOf(flag);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

function selectedIds() {
  return String(valueOf('--alert-ids', '')).split(',').map(item => Number(item.trim()))
    .filter(item => Number.isInteger(item) && item > 0);
}

function parseScope(alert) {
  const type = String(alert.scope_type || '').trim();
  const key = String(alert.scope_key || '').trim();
  if (!type || !key) {
    if (alert.slot_id != null) return { type: 'slot', key: String(alert.slot_id) };
    if (alert.job_code) return { type: 'job', key: String(alert.job_code) };
  }
  return { type, key };
}

const DATA_BOUND_ALERT_TYPES = new Set(['data_quality', 'dependency_blocked']);

function allCircuitsClosed(rows) {
  return Array.isArray(rows) && rows.length > 0 && rows.every(row => row.state === 'closed');
}

async function verifyScope(alert, query = (sql, params) => pool.query(sql, params)) {
  const scope = parseScope(alert);
  if (scope.type === 'slot') {
    const { rows } = await query(
      `SELECT slot_id,job_code,status,scheduled_for,updated_at FROM ops.job_schedule_slots WHERE slot_id=$1`, [scope.key]
    );
    const row = rows[0];
    if (row && ['succeeded', 'skipped'].includes(row.status)) {
      return { recovered: true, evidence: { mode: 'original_slot_recovered', original: row } };
    }
    // 数据/分区问题只能由对应数据集恢复证明，不能被后续任务成功掩盖。
    if (!row || !row.job_code || !row.scheduled_for || DATA_BOUND_ALERT_TYPES.has(String(alert.alert_type || ''))) {
      return { recovered: false, evidence: row || null, reason: row ? 'original_slot_not_recovered' : 'slot_not_found' };
    }
    const { rows: later } = await query(
      `SELECT slot_id,status,scheduled_for FROM ops.job_schedule_slots
        WHERE job_code=$1 AND scheduled_for>$2::timestamptz
        ORDER BY scheduled_for DESC,slot_id DESC LIMIT 3`, [row.job_code, row.scheduled_for]
    );
    const recovered = later.length === 3 && later.every(item => item.status === 'succeeded');
    return {
      recovered,
      evidence: { mode: 'three_later_job_successes', original: row, later },
      ...(recovered ? {} : { reason: 'insufficient_later_successes' }),
    };
  }
  if (scope.type === 'job') {
    const { rows } = await query(
      `SELECT status FROM ops.job_schedule_slots WHERE job_code=$1
       ORDER BY scheduled_for DESC,slot_id DESC LIMIT 3`, [scope.key]
    );
    return { recovered: rows.length === 3 && rows.every(row => row.status === 'succeeded'), evidence: rows };
  }
  if (scope.type === 'dataset') {
    const [datasetCode, datasetScope, partitionKey] = scope.key.split(':');
    if (!datasetCode || !partitionKey || !/^\d{4}-\d{2}-\d{2}$/.test(partitionKey)) {
      return { recovered: false, evidence: null, reason: 'invalid_dataset_scope' };
    }
    const { rows } = await query(
      `SELECT dataset_code,scope_key,partition_key::text,status,is_stale,diagnostics
         FROM ops.dataset_partitions
        WHERE dataset_code=$1 AND scope_key=$2 AND partition_key=$3::date
        ORDER BY updated_at DESC LIMIT 1`, [datasetCode, datasetScope || '', partitionKey]
    );
    const row = rows[0];
    const quality = row && row.diagnostics && row.diagnostics.quality_status;
    return { recovered: Boolean(row && row.status === 'published' && !row.is_stale && (!quality || quality === 'passed')), evidence: row || null };
  }
  if (scope.type === 'source_endpoint') {
    const separator = scope.key.indexOf(':');
    const source = separator >= 0 ? scope.key.slice(0, separator) : scope.key;
    const apiName = separator >= 0 ? scope.key.slice(separator + 1) : '*';
    const { rows } = await query(
      `SELECT source,api_name,state,recover_at,error_code,updated_at
         FROM ops.external_circuits
        WHERE source=$1 AND api_name=ANY($2::text[]) ORDER BY updated_at DESC`, [source, [apiName, '*']]
    );
    return {
      recovered: allCircuitsClosed(rows),
      evidence: rows,
      ...(rows.length ? {} : { reason: 'circuit_evidence_missing' }),
    };
  }
  return { recovered: false, evidence: null, reason: 'unknown_scope' };
}

async function main() {
  if (APPLY && process.env.NODE_ENV === 'production' && !CONFIRM) {
    throw new Error('生产告警收敛必须设置 CONFIRM_ALERT_RECONCILIATION=1');
  }
  const ids = selectedIds();
  if (APPLY && !ids.length) throw new Error('--apply 必须同时传入 --alert-ids 1,2,...');
  const { rows: alerts } = await pool.query(
    `SELECT alert_id,alert_key,alert_type,status,job_code,slot_id,scope_type,scope_key,last_seen_at
       FROM ops.alert_notifications
      WHERE status NOT IN ('resolved','acknowledged')
      ORDER BY last_seen_at DESC LIMIT $1`, [LIMIT]
  );
  const candidates = [];
  const unresolved = [];
  for (const alert of alerts) {
    const verification = await verifyScope(alert);
    const item = { alertId: Number(alert.alert_id), alertKey: alert.alert_key, scope: parseScope(alert), status: alert.status, ...verification };
    if (verification.recovered) candidates.push(item);
    else unresolved.push(item);
  }
  const selected = candidates.filter(item => ids.includes(item.alertId));
  let closed = [];
  if (APPLY && selected.length) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `UPDATE ops.alert_notifications
            SET status='resolved',resolved_at=now(),sending_started_at=NULL,updated_at=now()
          WHERE alert_id=ANY($1::bigint[]) AND status NOT IN ('resolved','acknowledged')
          RETURNING alert_id`, [selected.map(item => item.alertId)]
      );
      await client.query('COMMIT');
      closed = result.rows.map(row => Number(row.alert_id));
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }
  console.log(JSON.stringify({ mode: APPLY ? 'apply' : 'dry-run', scanned: alerts.length, candidateCount: candidates.length,
    selectedCount: selected.length, closed, candidates, unresolved }, null, 2));
}

if (require.main === module) {
  main().catch(error => {
    console.error(`历史告警收敛核查失败：${error.message}`);
    process.exitCode = 1;
  }).finally(() => pool.end());
}

module.exports = { allCircuitsClosed, parseScope, verifyScope };

#!/usr/bin/env node
// 历史后台告警收敛核查：默认只读预览；--apply 仅关闭已验证恢复且显式列出的告警。
// 该脚本不自动发送恢复邮件，也不替用户确认线上数据修复。
require('dotenv').config();

const { pool } = require('../db/connection');
const {
  parseAlertScope, allCircuitsClosed, verifyAlertScope,
} = require('../services/jobAlertMailer');

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

// 兼容历史脚本和既有测试；判断规则统一由 jobAlertMailer 提供。
const parseScope = parseAlertScope;
async function verifyScope(alert, query = (sql, params) => pool.query(sql, params)) {
  return verifyAlertScope(alert, query, { historical: true });
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

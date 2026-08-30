require('dotenv').config();
const { execFileSync } = require('child_process');
const { pool } = require('../db');
const { sendAlert, sendDueAlerts, sendRecoveryAlert } = require('../services/jobAlertMailer');

function serviceIsActive() {
  if (process.platform === 'win32') return true;
  try {
    execFileSync('systemctl', ['is-active', '--quiet', 'portfolio-worker.service'], { stdio: 'ignore' });
    return true;
  } catch (_) { return false; }
}

async function main() {
  await sendDueAlerts(20).catch(error => console.warn('[worker-health] 邮件重试失败:', error.message));
  await pool.query(
    `DELETE FROM ops.worker_heartbeats
      WHERE last_seen_at < now()-interval '7 days'
        AND updated_at < now()-interval '7 days'`
  );
  const { rows } = await pool.query(
    `SELECT worker_id FROM ops.worker_heartbeats
      WHERE role='worker' AND status='running' AND last_seen_at >= now()-interval '2 minutes'
      ORDER BY last_seen_at DESC LIMIT 1`
  );
  const workerOnline = rows.length > 0 && serviceIsActive();
  if (!workerOnline) {
    const result = await sendAlert({
      alertKey: 'worker:offline',
      alertType: 'worker_offline',
      severity: 'critical',
      subject: '后台 Worker 已离线',
      summary: !serviceIsActive()
        ? 'portfolio-worker.service 未处于 active 状态，请立即检查服务。'
        : '最近2分钟没有收到 Worker 心跳，后台定时任务可能无法执行，请立即检查进程和服务器。',
    });
    if (!result.ok && !result.suppressed) process.exitCode = 2;
  } else {
    const old = await pool.query(
      `SELECT alert_id FROM ops.alert_notifications
        WHERE alert_key='worker:offline' AND status <> 'resolved' LIMIT 1`
    );
    if (old.rows.length) {
      await pool.query(`UPDATE ops.alert_notifications SET status='resolved', resolved_at=now(), updated_at=now() WHERE alert_id=$1`, [old.rows[0].alert_id]);
      await sendRecoveryAlert({
        alertKey: `worker:recovered:${old.rows[0].alert_id}`,
        alertType: 'worker_recovered',
        severity: 'info',
        subject: '后台 Worker 已恢复',
        summary: '已重新收到 Worker 心跳，后台定时任务恢复运行。',
      });
    }
  }
  await pool.end();
}

main().catch(async error => {
  console.error('[worker-health] 检查失败:', error.message);
  await pool.end().catch(() => {});
  process.exit(1);
});

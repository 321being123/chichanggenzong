require('dotenv').config();
const { execFileSync } = require('child_process');
const { pool } = require('../db');
const { sendAlert, sendDueAlerts, sendRecoveryAlert } = require('../services/jobAlertMailer');
const { getJobDefinition } = require('../services/jobDefinitions');

function serviceIsActive() {
  if (process.platform === 'win32') return true;
  try {
    execFileSync('systemctl', ['is-active', '--quiet', 'portfolio-worker.service'], { stdio: 'ignore' });
    return true;
  } catch (_) { return false; }
}

async function main() {
  await sendDueAlerts(20).catch(error => console.warn('[worker-health] 邮件重试失败:', error.message));
  const { rows } = await pool.query(
    `SELECT worker_id FROM ops.worker_heartbeats
      WHERE role='worker' AND status='running' AND last_seen_at >= now()-interval '2 minutes'
      ORDER BY last_seen_at DESC LIMIT 1`
  );
  const overdueResult = await pool.query(
    `SELECT slot_id,job_code,scheduled_for,status FROM ops.job_schedule_slots
      WHERE status IN ('pending','running','failed','degraded','blocked')
        AND acknowledged_at IS NULL
      ORDER BY scheduled_for ASC LIMIT 100`
  );
  const overdue = { rows: overdueResult.rows.filter(row => {
    const deadline = Number(getJobDefinition(row.job_code).deadlineMinutes || 180);
    return new Date(row.scheduled_for).getTime() + deadline * 60000 < Date.now();
  }).slice(0, 10) };
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
  if (overdue.rows.length) {
    await sendAlert({
      alertKey: 'worker:overdue-slots',
      alertType: 'job_overdue',
      severity: 'critical',
      subject: '后台任务存在逾期实例',
      summary: `发现逾期任务：${overdue.rows.map(row => `${row.job_code}#${row.slot_id}`).join('、')}`,
    });
  } else {
    const recovered = await pool.query(
      `UPDATE ops.alert_notifications
          SET status='resolved', resolved_at=now(), updated_at=now()
        WHERE alert_key='worker:overdue-slots' AND status <> 'resolved'
        RETURNING alert_id`
    );
    if (recovered.rows.length) await sendRecoveryAlert({
      alertKey: 'worker:overdue-slots:recovered',
      alertType: 'job_overdue_recovered',
      severity: 'info',
      subject: '后台逾期任务已恢复',
      summary: '当前没有未确认的逾期任务，后台任务运行已恢复正常。',
    });
  }
  await pool.end();
}

main().catch(async error => {
  console.error('[worker-health] 检查失败:', error.message);
  await pool.end().catch(() => {});
  process.exit(1);
});

require('dotenv').config();
const { execFileSync } = require('child_process');
const { pool } = require('../db');
const {
  sendAlert, sendDueAlerts, reconcileRecoveredSourceAlerts, reconcileHistoricalAlerts, reconcilePartialDataAlerts, resolveWorkerOfflineAlert,
} = require('../services/jobAlertMailer');
const { collectNginxRuntime } = require('../services/nginxRuntimeCollector');

function serviceState() {
  if (process.platform === 'win32') return 'active';
  try {
    return String(execFileSync('systemctl', ['show', '-p', 'ActiveState', '--value', 'portfolio-worker.service'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }) || '').trim() || 'unknown';
  } catch (_) { return 'unknown'; }
}

// 优雅重启过渡期（deactivating / activating）且 2 分钟内仍有心跳时，不误报 worker_offline；
// 若已停机（inactive/failed）或心跳超过 2 分钟仍无更新，则立即判离线。
function evaluateWorkerHealth({ activeState, hasRecentHeartbeat }) {
  const state = String(activeState || '').trim().toLowerCase();
  if (state === 'active') {
    return {
      online: Boolean(hasRecentHeartbeat),
      transitioning: false,
      summary: hasRecentHeartbeat ? '' : '最近2分钟没有收到 Worker 心跳，后台定时任务可能无法执行，请立即检查进程和服务器。',
    };
  }
  if ((state === 'deactivating' || state === 'activating' || state === 'reloading') && hasRecentHeartbeat) {
    return { online: true, transitioning: true, summary: '' };
  }
  return {
    online: false,
    transitioning: false,
    summary: !hasRecentHeartbeat
      ? '最近2分钟没有收到 Worker 心跳，后台定时任务可能无法执行，请立即检查进程和服务器。'
      : `portfolio-worker.service 当前状态为 ${state || 'unknown'}（非 active），请立即检查服务。`,
  };
}

async function main() {
  await collectNginxRuntime().catch(error => console.warn('[worker-health] Nginx 采样失败:', error.message));
  await sendDueAlerts(20).catch(error => console.warn('[worker-health] 邮件重试失败:', error.message));
  await reconcileRecoveredSourceAlerts(100).catch(error => console.warn('[worker-health] 来源告警恢复核对失败:', error.message));
  await reconcileHistoricalAlerts(100).catch(error => console.warn('[worker-health] 历史告警核对失败:', error.message));
  await reconcilePartialDataAlerts(100).catch(error => console.warn('[worker-health] 部分数据集告警核对失败:', error.message));
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
  const health = evaluateWorkerHealth({ activeState: serviceState(), hasRecentHeartbeat: rows.length > 0 });
  if (!health.online) {
    const result = await sendAlert({
      alertKey: 'worker:offline',
      alertType: 'worker_offline',
      severity: 'critical',
      subject: '后台 Worker 已离线',
      summary: health.summary,
    });
    if (!result.ok && !result.suppressed) process.exitCode = 2;
  } else if (!health.transitioning) {
    const old = await pool.query(
      `SELECT alert_id FROM ops.alert_notifications
        WHERE alert_key='worker:offline' AND status <> 'resolved' LIMIT 1`
    );
    if (old.rows.length) {
      await resolveWorkerOfflineAlert(old.rows[0].alert_id);
    }
  }
  await pool.end();
}

if (require.main === module) {
  main().catch(async error => {
    console.error('[worker-health] 检查失败:', error.message);
    await pool.end().catch(() => {});
    process.exit(1);
  });
}

module.exports = { evaluateWorkerHealth, serviceState };

const { pool } = require('../db/connection');

// 自 server/services/siteAnalytics.js 迁入的数据读写函数（只做标准事实读写，业务判定仍留在服务层）。

async function purgeAnalyticsData() {
  const days = Math.min(Math.max(Number(process.env.SITE_ANALYTICS_RETENTION_DAYS || 30), 7), 365);
  let events = 0; let runtime = 0;
  for (let i = 0; i < 20; i++) {
    const result = await pool.query(`WITH doomed AS (SELECT event_id FROM ops.site_events WHERE received_at < now() - make_interval(days => $1) LIMIT 1000)
      DELETE FROM ops.site_events e USING doomed d WHERE e.event_id=d.event_id`, [days]);
    events += result.rowCount || 0;
    if (!result.rowCount) break;
  }
  for (let i = 0; i < 20; i++) {
    const result = await pool.query(`WITH doomed AS (SELECT runtime_id FROM ops.site_runtime_minute WHERE bucket_start < now() - make_interval(days => $1) LIMIT 1000)
      DELETE FROM ops.site_runtime_minute r USING doomed d WHERE r.runtime_id=d.runtime_id`, [days]);
    runtime += result.rowCount || 0;
    if (!result.rowCount) break;
  }
  return { ok: true, retentionDays: days, deletedEvents: events, deletedRuntimeRows: runtime };
}

module.exports = {
  purgeAnalyticsData,
};

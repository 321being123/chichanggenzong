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

async function insert_ops_site_runtime_minute(params, client = pool) {
  return client.query(`INSERT INTO ops.site_runtime_minute
      (layer, bucket_start, batch_id, process_instance, route_key, request_kind, request_count,
       status_2xx, status_3xx, status_4xx, status_429, status_5xx, duration_buckets, bytes_sent, error_count,
       sample_type, coverage_status, event_loop_p50_ms, event_loop_p95_ms, event_loop_max_ms, source_file)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$18,$19,$20,$21)
      ON CONFLICT (layer, batch_id) DO UPDATE SET
        request_count=EXCLUDED.request_count, status_2xx=EXCLUDED.status_2xx, status_3xx=EXCLUDED.status_3xx,
        status_4xx=EXCLUDED.status_4xx, status_429=EXCLUDED.status_429, status_5xx=EXCLUDED.status_5xx, duration_buckets=EXCLUDED.duration_buckets,
        bytes_sent=EXCLUDED.bytes_sent, error_count=EXCLUDED.error_count, sample_type=EXCLUDED.sample_type,
        coverage_status=EXCLUDED.coverage_status, event_loop_p50_ms=EXCLUDED.event_loop_p50_ms,
        event_loop_p95_ms=EXCLUDED.event_loop_p95_ms, event_loop_max_ms=EXCLUDED.event_loop_max_ms,
        source_file=EXCLUDED.source_file, recorded_at=now()`, params);
}

async function select_users(params, client = pool) {
  return client.query(`SELECT COUNT(*)::int AS new_registrations FROM users
        WHERE created_at >= $1 AND created_at < $2`, params);
}

async function select_ops_alert_notifications(params, client = pool) {
  return client.query(`SELECT COUNT(*)::int AS pending_exceptions FROM ops.alert_notifications
        WHERE status NOT IN ('resolved','acknowledged','suppressed')`, params);
}

async function select_ops_site_runtime_minute(params, client = pool) {
  return client.query(`SELECT bucket_start, layer, route_key, request_kind, request_count,
        status_2xx, status_3xx, status_4xx, status_429, status_5xx, duration_buckets, error_count,
        sample_type, coverage_status, event_loop_p50_ms, event_loop_p95_ms, event_loop_max_ms, source_file,
        COUNT(*) OVER() AS total_rows
        FROM ops.site_runtime_minute WHERE bucket_start >= $1 AND bucket_start < $2
        ORDER BY bucket_start DESC LIMIT 1000`, params);
}

async function select_ops_site_runtime_minute_1(params, client = pool) {
  return client.query(`SELECT layer, SUM(request_count)::bigint AS request_count,
        SUM(status_2xx)::bigint AS status_2xx, SUM(status_3xx)::bigint AS status_3xx,
        SUM(status_4xx)::bigint AS status_4xx, SUM(status_429)::bigint AS status_429,
        SUM(status_5xx)::bigint AS status_5xx, SUM(error_count)::bigint AS error_count,
        SUM(COALESCE((duration_buckets->>'lt100')::bigint,0))::bigint AS duration_lt100,
        SUM(COALESCE((duration_buckets->>'ms100_499')::bigint,0))::bigint AS duration_ms100_499,
        SUM(COALESCE((duration_buckets->>'ms500_999')::bigint,0))::bigint AS duration_ms500_999,
        SUM(COALESCE((duration_buckets->>'gte1000')::bigint,0))::bigint AS duration_gte1000
        FROM ops.site_runtime_minute WHERE bucket_start >= $1 AND bucket_start < $2 GROUP BY layer ORDER BY layer`, params);
}

async function select_platform_config(params, client = pool) {
  return client.query(`SELECT key, value FROM platform_config WHERE key IN ('site_analytics_enabled_at')`);
}

async function select_ops_site_events(params, client = pool) {
  return client.query(`SELECT COUNT(*)::int AS count, MIN(received_at) AS first_received_at, MAX(received_at) AS last_received_at,
        COUNT(*) FILTER (WHERE visitor_key IS NULL)::int AS no_visitor_key,
        COUNT(*) FILTER (WHERE user_key IS NULL)::int AS guest_events,
        COUNT(*) FILTER (WHERE is_internal=true)::int AS internal_events
        FROM ops.site_events WHERE received_at >= $1 AND received_at < $2`, params);
}

async function select_ops_site_runtime_minute_2(params, client = pool) {
  return client.query(`SELECT MAX(bucket_start) AS last_bucket, COUNT(*)::int AS row_count FROM ops.site_runtime_minute WHERE bucket_start >= $1 AND bucket_start < $2`, params);
}

async function select_ops_sync_cursors(params, client = pool) {
  return client.query(`SELECT last_attempt_at, last_source_update, last_error, cursor_payload FROM ops.sync_cursors WHERE scope_key='site_analytics:nginx' AND dataset_code='access_log' LIMIT 1`);
}

async function select_ops_dataset_partitions(params, client = pool) {
  return client.query(`SELECT DISTINCT ON (dataset_code, scope_key) dataset_code, scope_key, partition_key::text,
          data_as_of::text, published_at, is_stale, stale_reason, row_count,
          (MIN(COALESCE(data_as_of, partition_key)) OVER (PARTITION BY dataset_code, scope_key))::text AS earliest_data_as_of,
          (MAX(COALESCE(data_as_of, partition_key)) OVER (PARTITION BY dataset_code, scope_key))::text AS latest_data_as_of
        FROM ops.dataset_partitions WHERE status='published'
        ORDER BY dataset_code, scope_key, partition_key DESC LIMIT 100`);
}

async function select_ops_data_quality_issues(params, client = pool) {
  return client.query(`SELECT dataset_code, status, severity, COUNT(*)::int AS count
        FROM ops.data_quality_issues GROUP BY dataset_code, status, severity ORDER BY count DESC LIMIT 100`);
}

async function select_ops_job_schedule_slots(params, client = pool) {
  return client.query(`SELECT status, COUNT(*)::int AS count FROM ops.job_schedule_slots
        WHERE business_date=(timezone('Asia/Shanghai', now()))::date GROUP BY status ORDER BY status`);
}

async function select_ops_alert_notifications_1(params, client = pool) {
  return client.query(`SELECT status, severity, COUNT(*)::int AS count FROM ops.alert_notifications
        WHERE status NOT IN ('resolved','acknowledged','suppressed') GROUP BY status, severity ORDER BY count DESC`);
}

async function select_ops_external_call_budgets(params, client = pool) {
  return client.query(`SELECT source, api_name, credential_profile, window_type, window_key, call_count, budget_limit,
          GREATEST(budget_limit-call_count, 0)::int AS remaining,
          ROUND(call_count::numeric * 100 / NULLIF(budget_limit, 0), 1) AS usage_percent
        FROM ops.external_call_budgets WHERE budget_limit IS NOT NULL AND budget_limit > 0
          AND call_count >= budget_limit * 0.8
          AND ((window_type='day' AND window_key=to_char(clock_timestamp() AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD'))
            OR (window_type='minute' AND window_key=floor(extract(epoch FROM clock_timestamp()) / 60)::bigint::text))
        ORDER BY updated_at DESC LIMIT 100`);
}

async function select_ops_external_circuits(params, client = pool) {
  return client.query(`SELECT source, api_name, token_fingerprint, state, recover_at, error_code, last_success_at
        FROM ops.external_circuits WHERE state='open' ORDER BY recover_at NULLS LAST LIMIT 100`);
}

async function select_data(params, client = pool) {
  return client.query(`SELECT 1`);
}

async function select_ops_worker_heartbeats(params, client = pool) {
  return client.query(`SELECT DISTINCT ON (role) role, worker_id, pid, app_version, status, last_seen_at
      FROM ops.worker_heartbeats ORDER BY role, last_seen_at DESC`);
}

module.exports = {
  purgeAnalyticsData,
  insert_ops_site_runtime_minute,
  select_users,
  select_ops_alert_notifications,
  select_ops_site_runtime_minute,
  select_ops_site_runtime_minute_1,
  select_platform_config,
  select_ops_site_events,
  select_ops_site_runtime_minute_2,
  select_ops_sync_cursors,
  select_ops_dataset_partitions,
  select_ops_data_quality_issues,
  select_ops_job_schedule_slots,
  select_ops_alert_notifications_1,
  select_ops_external_call_budgets,
  select_ops_external_circuits,
  select_data,
  select_ops_worker_heartbeats,
};

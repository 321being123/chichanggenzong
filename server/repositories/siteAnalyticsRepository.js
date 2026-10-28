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

// 埋点事件批量写入：占位符按行拼装，event_id 冲突时保留首条
async function insertSiteEvents(params, client = pool) {
  const events = params.events || [];
  const identity = params.identity || {};
  if (!events.length) return { rowCount: 0 };
  const values = [];
  const args = [];
  const add = (value) => { args.push(value); return '$' + args.length; };
  for (const event of events) {
    values.push(`(${add(event.eventId)}, now(), ${add(event.occurredAt)}, ${add(identity.visitorKey)}, ${add(identity.userKey)}, ${add(identity.sessionKey || event.sessionKey)}, ${add(event.pageViewId)}, ${add(event.eventName)}, ${add(event.pageKey)}, ${add(event.module)}, ${add(event.entry)}, ${add(event.deviceType)}, ${add(event.sourceDomain || identity.sourceDomain || '')}, ${add(identity.internal)}, 1, ${add(JSON.stringify(event.properties))}::jsonb)`);
  }
  return client.query(
    `INSERT INTO ops.site_events
    (event_id, received_at, occurred_at, visitor_key, user_key, session_key, page_view_id,
     event_name, page_key, module, entry, device_type, source_domain, is_internal, data_version, properties)
    VALUES ${values.join(',')}
    ON CONFLICT (event_id) DO NOTHING`,
    args,
  );
}

// 事件时间窗与内部流量口径（调用方传结构化 scope，SQL 片段在本层拼装）
function buildEventWhere(alias, includeInternal) {
  const where = [`${alias}.occurred_at >= $1`, `${alias}.occurred_at < $2`];
  if (!includeInternal) where.push(`${alias}.is_internal=false`);
  return where.join(' AND ');
}

// 概览：汇总、按日趋势、热门页面、设备分布
async function loadOverviewData(scope, client = pool) {
  const where = buildEventWhere('e', scope.includeInternal);
  const params = [scope.start, scope.end];
  const trendSql = scope.range === 'today'
    ? `timezone('Asia/Shanghai', date_trunc('hour', occurred_at)) AS day`
    : `timezone('Asia/Shanghai', occurred_at)::date AS day`;
  const [summary, daily, pages, devices] = await Promise.all([
    client.query(`SELECT COUNT(*) FILTER (WHERE event_name='page_view')::int AS pv,
        COUNT(DISTINCT visitor_key)::int AS uv, COUNT(DISTINCT session_key)::int AS sessions,
        COUNT(DISTINCT user_key) FILTER (WHERE event_name <> 'telemetry_init')::int AS logged_users,
        COUNT(DISTINCT visitor_key) FILTER (WHERE occurred_at >= now() - interval '5 minutes'
          AND event_name IN ('page_view','engagement','detail_open','filter_apply','register_view','register_submit','register_success','watchlist_add_success','import_result'))::int AS active_visitors,
        COUNT(*) FILTER (WHERE event_name='register_success')::int AS registrations,
        COUNT(*) FILTER (WHERE event_name='watchlist_add_success')::int AS watchlist_adds
        FROM ops.site_events e WHERE ${where}`, params),
    client.query(`SELECT ${trendSql},
        COUNT(*) FILTER (WHERE event_name='page_view')::int AS pv,
        COUNT(DISTINCT visitor_key)::int AS uv
        FROM ops.site_events e WHERE ${where}
        GROUP BY 1 ORDER BY 1`, params),
    client.query(`SELECT page_key, COUNT(*) FILTER (WHERE event_name='page_view')::int AS pv,
        COUNT(DISTINCT visitor_key)::int AS uv,
        COUNT(*) FILTER (WHERE event_name='page_view' AND entry <> '')::int AS entries,
        ROUND(AVG((properties->>'duration_sec')::numeric) FILTER (WHERE event_name='engagement'),1) AS avg_duration_sec
        FROM ops.site_events e WHERE ${where}
        GROUP BY page_key ORDER BY pv DESC LIMIT 12`, params),
    client.query(`SELECT device_type, COUNT(*) FILTER (WHERE event_name='page_view')::int AS pv
        FROM ops.site_events e WHERE ${where} GROUP BY device_type ORDER BY pv DESC`, params),
  ]);
  return { summary: summary.rows, daily: daily.rows, pages: pages.rows, devices: devices.rows };
}

// 流量来源：来源域、落地入口、按日会话、页面明细
async function loadTrafficData(scope, client = pool) {
  const where = buildEventWhere('e', scope.includeInternal);
  const params = [scope.start, scope.end];
  const [sources, entries, sessions, pages] = await Promise.all([
    client.query(`SELECT COALESCE(NULLIF(source_domain,''),'直接访问') AS source_domain,
        COUNT(*) FILTER (WHERE event_name='page_view')::int AS pv,
        COUNT(DISTINCT visitor_key)::int AS uv FROM ops.site_events e WHERE ${where}
        GROUP BY 1 ORDER BY pv DESC LIMIT 20`, params),
    client.query(`SELECT COALESCE(NULLIF(entry,''),'未标记') AS entry,
        COUNT(*) FILTER (WHERE event_name='page_view')::int AS pv,
        COUNT(DISTINCT visitor_key)::int AS uv FROM ops.site_events e WHERE ${where}
        GROUP BY 1 ORDER BY pv DESC LIMIT 20`, params),
    client.query(`SELECT timezone('Asia/Shanghai', occurred_at)::date AS day,
        COUNT(DISTINCT session_key)::int AS sessions, COUNT(DISTINCT user_key)::int AS logged_users
        FROM ops.site_events e WHERE ${where} GROUP BY 1 ORDER BY 1`, params),
    client.query(`SELECT page_key, COUNT(*) FILTER (WHERE event_name='page_view')::int AS pv,
        COUNT(DISTINCT visitor_key)::int AS uv,
        COUNT(*) FILTER (WHERE event_name='page_view' AND entry <> '')::int AS entry_count,
        ROUND(AVG((properties->>'duration_sec')::numeric) FILTER (WHERE event_name='engagement'),1) AS avg_duration_sec
        FROM ops.site_events e WHERE ${where} GROUP BY page_key ORDER BY pv DESC LIMIT 20`, params),
  ]);
  return { sources: sources.rows, entries: entries.rows, sessions: sessions.rows, pages: pages.rows };
}

// 行为分析：事件分布、注册/收藏/导入漏斗、页面停留、最近原始事件
async function loadBehaviorData(scope, client = pool) {
  const where = buildEventWhere('e', scope.includeInternal);
  const params = [scope.start, scope.end];
  const [events, funnel, details, recent] = await Promise.all([
    client.query(`SELECT event_name, COUNT(*)::int AS count,
        COUNT(DISTINCT COALESCE(user_key,visitor_key))::int AS users
        FROM ops.site_events e WHERE ${where} GROUP BY event_name ORDER BY count DESC`, params),
    client.query(`WITH session_steps AS (
          SELECT session_key,
            MIN(occurred_at) FILTER (WHERE event_name='register_view') AS register_view_at,
            MIN(occurred_at) FILTER (WHERE event_name='register_submit') AS register_submit_at,
            MIN(occurred_at) FILTER (WHERE event_name='register_success') AS register_success_at,
            MIN(occurred_at) FILTER (WHERE event_name='watchlist_add_success') AS watchlist_add_at,
            MIN(occurred_at) FILTER (WHERE event_name='import_result' AND properties->>'result'='success') AS import_success_at
          FROM ops.site_events e WHERE ${where} AND session_key IS NOT NULL GROUP BY session_key
        )
        SELECT COUNT(*) FILTER (WHERE register_view_at IS NOT NULL)::int AS register_view,
          COUNT(*) FILTER (WHERE register_view_at IS NOT NULL AND register_submit_at > register_view_at)::int AS register_submit,
          COUNT(*) FILTER (WHERE register_submit_at IS NOT NULL AND register_success_at > register_submit_at)::int AS register_success,
          COUNT(*) FILTER (WHERE watchlist_add_at IS NOT NULL)::int AS watchlist_add_success,
          COUNT(*) FILTER (WHERE import_success_at IS NOT NULL)::int AS import_success
        FROM session_steps`, params),
    client.query(`SELECT page_key, COUNT(*)::int AS count, ROUND(AVG((properties->>'duration_sec')::numeric),1) AS avg_duration_sec
        FROM ops.site_events e WHERE ${where} AND event_name IN ('detail_open','engagement') GROUP BY page_key ORDER BY count DESC LIMIT 20`, params),
    client.query(`SELECT occurred_at, event_name, page_key, module, entry,
          COALESCE(NULLIF(right(visitor_key,8),''),'匿名') AS visitor_label,
          (user_key IS NOT NULL) AS logged_in
        FROM ops.site_events e
        WHERE e.occurred_at >= GREATEST($1, now() - interval '30 minutes') AND e.occurred_at < $2
          ${scope.includeInternal ? '' : 'AND e.is_internal=false'} AND event_name <> 'telemetry_init'
        ORDER BY occurred_at DESC LIMIT 50`, params),
  ]);
  return { events: events.rows, funnel: funnel.rows, details: details.rows, recent: recent.rows };
}

module.exports = {
  loadBehaviorData,
  loadOverviewData,
  loadTrafficData,
  insertSiteEvents,
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

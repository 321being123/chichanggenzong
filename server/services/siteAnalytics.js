// 网站数据看板：匿名统计、运行时聚合和后台查询。
// 这里明确区分“统计事实”“运行采样”和“依赖健康”，不读取用户持仓、金额、搜索词或完整 URL。
const crypto = require('crypto');
const os = require('os');
const { pool } = require('../db/connection');
const { redis } = require('../config');
const { isAdminIdentity } = require('../middleware/auth');

const VISITOR_COOKIE = 'site_visitor';
const VISITOR_MAX_AGE = 30 * 24 * 60 * 60;
const EVENT_BATCH_MAX = 20;
const PROPERTY_MAX_BYTES = 4096;
const RUNTIME_CACHE_TTL = 30 * 1000;
const DASHBOARD_CACHE_TTL = 60 * 1000;
const MEMORY_CACHE_MAX = 64;
const APP_PROCESS = `${os.hostname()}:${process.pid}`.slice(0, 120);

const EVENT_NAMES = new Set([
  'page_view', 'engagement', 'detail_open', 'filter_apply', 'register_view',
  'register_submit', 'register_success', 'watchlist_add_success', 'import_result',
  'telemetry_init'
]);
const SERVER_ONLY_EVENTS = new Set(['register_success', 'watchlist_add_success', 'import_result']);
const PAGE_KEYS = new Set([
  'home', 'login', 'register', 'profile', 'changelog', 'holdings.dashboard', 'holdings.positions',
  'holdings.trades', 'holdings.nav', 'ipo.calendar', 'ipo.report', 'bond.safety', 'bond.cycle',
  'bond.valuation', 'bond.list', 'bond.redemption', 'bond.revision', 'bond.analysis',
  'stock.analysis', 'market.volatility', 'knowledge.list', 'knowledge.detail', 'knowledge.share',
  'arbitrage.list', 'arbitrage.detail'
]);
const SAFE_VALUE_RE = /^[a-zA-Z0-9._:-]{1,64}$/;

const memoryCache = new Map();
const appRuntimeBuckets = new Map();
let dependencyHealthCache = null;
const MAX_RUNTIME_RETRY_BUCKETS = 240;

function isEnabled() {
  return process.env.SITE_ANALYTICS_ENABLED !== '0';
}

function analyticsSecret() {
  const value = String(process.env.SITE_ANALYTICS_SECRET || '');
  return value.length >= 32 ? value : '';
}

function hmac(value) {
  const secret = analyticsSecret();
  if (!secret) return null;
  return crypto.createHmac('sha256', secret).update(String(value)).digest('hex');
}

function sha(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function parseCookie(header) {
  const result = {};
  String(header || '').split(';').forEach(pair => {
    const at = pair.indexOf('=');
    if (at < 0) return;
    result[pair.slice(0, at).trim()] = decodeURIComponent(pair.slice(at + 1).trim());
  });
  return result;
}

function visitorKeyFromValue(value) {
  const secret = analyticsSecret();
  const match = /^([a-f0-9]{32})\.([a-f0-9]{64})$/.exec(String(value || ''));
  if (!secret || !match) return null;
  const expected = hmac('visitor-cookie:' + match[1]);
  if (!expected || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(match[2]))) return null;
  return hmac('visitor:' + match[1]);
}

function requestVisitorKey(req) {
  const cookies = parseCookie(req && req.headers && req.headers.cookie);
  return visitorKeyFromValue(cookies[VISITOR_COOKIE]);
}

function ensureVisitorCookie(req, res) {
  const cookies = parseCookie(req && req.headers && req.headers.cookie);
  const existing = cookies[VISITOR_COOKIE];
  const existingKey = visitorKeyFromValue(existing);
  const reset = String(req && req.headers && req.headers['x-site-analytics-reset'] || '').trim() === '1';
  if (existingKey && !reset) {
    req.analyticsIdentity = { visitorKey: existingKey };
    return req.analyticsIdentity;
  }
  const secret = analyticsSecret();
  if (!secret) {
    req.analyticsIdentity = { visitorKey: null };
    return req.analyticsIdentity;
  }
  const id = crypto.randomBytes(16).toString('hex');
  const signed = id + '.' + hmac('visitor-cookie:' + id);
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const parts = [
    `${VISITOR_COOKIE}=${encodeURIComponent(signed)}`,
    `Max-Age=${VISITOR_MAX_AGE}`,
    'Path=/', 'HttpOnly', 'SameSite=Lax'
  ];
  if (secure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
  req.analyticsIdentity = { visitorKey: hmac('visitor:' + id) };
  return req.analyticsIdentity;
}

function clearVisitorCookie(req, res) {
  const secure = req && (req.secure || req.headers && req.headers['x-forwarded-proto'] === 'https');
  const parts = [`${VISITOR_COOKIE}=`, 'Max-Age=0', 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (secure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function userKey(username) {
  return username ? hmac('user:' + username) : null;
}

function isInternalTraffic(req, username) {
  if (process.env.NODE_ENV !== 'production') return true;
  if (isAdminIdentity(username, req && req.authUser && req.authUser.role)) return true;
  const users = String(process.env.SITE_ANALYTICS_INTERNAL_USERS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  return !!username && users.includes(username);
}

function cleanSourceDomain(value) {
  try {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw);
    const hostname = parsed.hostname.toLowerCase();
    return /^[a-z0-9.-]{1,120}$/.test(hostname) ? hostname : '';
  } catch (_) { return ''; }
}

function sourceDomain(req) {
  const value = req && (req.get('referer') || req.get('origin'));
  const source = cleanSourceDomain(value);
  const requestHost = cleanSourceDomain(req && req.get && req.get('host'));
  return source && source !== requestHost ? source : '';
}

function sessionKey(value) {
  const text = String(value || '').trim();
  return /^[a-zA-Z0-9._:-]{8,128}$/.test(text) ? sha('session:' + text) : null;
}

function validPageKey(value) {
  const key = String(value || '');
  return PAGE_KEYS.has(key) ? key : '';
}

function safeValue(value) {
  const text = String(value == null ? '' : value);
  return SAFE_VALUE_RE.test(text) ? text : '';
}

function boundedInteger(value, min, max) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) return null;
  return number;
}

function sanitizeProperties(eventName, input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const output = {};
  const put = (key, value) => { if (value !== null && value !== '') output[key] = value; };
  if (eventName === 'engagement') put('duration_sec', boundedInteger(source.duration_sec, 1, 600));
  if (eventName === 'filter_apply') put('filter_name', safeValue(source.filter_name));
  if (eventName === 'detail_open') put('detail_type', safeValue(source.detail_type));
  if (eventName === 'register_view' || eventName === 'register_submit') put('step', safeValue(source.step));
  if (eventName === 'telemetry_init') {
    put('script_version', safeValue(source.script_version));
    if (['ready', 'disabled', 'error'].includes(source.init_status)) put('init_status', source.init_status);
  }
  if (eventName === 'import_result') {
    put('import_type', safeValue(source.import_type));
    if (['success', 'failure'].includes(source.result)) put('result', source.result);
    if (['0', '1_10', '11_50', '51_200', '200_plus'].includes(source.count_bucket)) put('count_bucket', source.count_bucket);
  }
  if (Buffer.byteLength(JSON.stringify(output), 'utf8') > PROPERTY_MAX_BYTES) return null;
  return output;
}

function occurredAt(value, now = Date.now()) {
  if (value == null || value === '') return new Date(now);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  if (date.getTime() > now + 5 * 60 * 1000 || date.getTime() < now - 24 * 60 * 60 * 1000) return null;
  return date;
}

function sanitizeEvent(raw, options = {}) {
  const item = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const server = options.server === true;
  const eventName = String(item.event_name || item.eventName || '');
  if (!EVENT_NAMES.has(eventName) || (!server && SERVER_ONLY_EVENTS.has(eventName))) return { error: '事件类型不允许' };
  const pageKey = validPageKey(item.page_key || item.pageKey);
  if (!pageKey) return { error: '页面标识不允许' };
  const eventId = String(item.event_id || item.eventId || '');
  if (!/^[a-zA-Z0-9._:-]{8,80}$/.test(eventId)) return { error: '事件编号无效' };
  const occurred = occurredAt(item.occurred_at || item.occurredAt);
  if (!occurred) return { error: '事件时间无效' };
  const properties = sanitizeProperties(eventName, item.properties);
  if (!properties) return { error: '事件属性过大' };
  if (eventName === 'page_view' && item.page_view_id && !/^[a-zA-Z0-9._:-]{8,80}$/.test(String(item.page_view_id))) {
    return { error: '页面访问编号无效' };
  }
  return {
    eventId,
    occurredAt: occurred,
    eventName,
    pageKey,
    module: safeValue(item.module),
    entry: safeValue(item.entry),
    deviceType: ['mobile', 'desktop', 'tablet', 'unknown'].includes(item.device_type) ? item.device_type : 'unknown',
    sessionKey: sessionKey(item.session_id),
    pageViewId: item.page_view_id ? String(item.page_view_id).slice(0, 80) : null,
    sourceDomain: cleanSourceDomain(item.source_domain || item.sourceDomain),
    properties,
  };
}

function currentUser(req) {
  return (req && req.authUser && req.authUser.username) || (req && req.session && req.session.user) || '';
}

async function insertEvents(events, identity = {}) {
  if (!events.length || !isEnabled()) return { accepted: 0, disabled: !isEnabled() };
  const values = [];
  const params = [];
  const add = value => { params.push(value); return '$' + params.length; };
  for (const event of events) {
    values.push(`(${add(event.eventId)}, now(), ${add(event.occurredAt)}, ${add(identity.visitorKey)}, ${add(identity.userKey)}, ${add(identity.sessionKey || event.sessionKey)}, ${add(event.pageViewId)}, ${add(event.eventName)}, ${add(event.pageKey)}, ${add(event.module)}, ${add(event.entry)}, ${add(event.deviceType)}, ${add(event.sourceDomain || identity.sourceDomain || '')}, ${add(identity.internal)}, 1, ${add(JSON.stringify(event.properties))}::jsonb)`);
  }
  const sql = `INSERT INTO ops.site_events
    (event_id, received_at, occurred_at, visitor_key, user_key, session_key, page_view_id,
     event_name, page_key, module, entry, device_type, source_domain, is_internal, data_version, properties)
    VALUES ${values.join(',')}
    ON CONFLICT (event_id) DO NOTHING`;
  const result = await pool.query(sql, params);
  return { accepted: result.rowCount || 0, received: events.length };
}

async function ingestTelemetry(req, events) {
  if (!Array.isArray(events) || events.length < 1 || events.length > EVENT_BATCH_MAX) {
    const error = new Error(`一次最多提交 ${EVENT_BATCH_MAX} 条事件`);
    error.status = 400;
    throw error;
  }
  const normalized = [];
  for (const item of events) {
    const result = sanitizeEvent(item);
    if (result.error) { const error = new Error(result.error); error.status = 400; throw error; }
    normalized.push(result);
  }
  const username = currentUser(req);
  const identity = req.analyticsIdentity || ensureVisitorCookie(req, { append: () => {} });
  identity.userKey = userKey(username);
  identity.internal = isInternalTraffic(req, username);
  identity.sourceDomain = sourceDomain(req);
  return insertEvents(normalized, identity);
}

function serverEventId(eventName, dedupeKey) {
  return `server:${eventName}:${sha(dedupeKey || crypto.randomUUID()).slice(0, 48)}`;
}

async function recordServerEvent(eventName, data = {}, options = {}) {
  if (!SERVER_ONLY_EVENTS.has(eventName) || !isEnabled()) return { accepted: 0, disabled: !isEnabled() };
  if (options.req && String(options.req.get && options.req.get('X-Site-Analytics-Opt-Out') || '').trim() === '1') {
    return { accepted: 0, optedOut: true };
  }
  const username = options.username || (options.req && currentUser(options.req));
  const identity = options.req && options.req.analyticsIdentity
    ? options.req.analyticsIdentity : { visitorKey: options.req ? requestVisitorKey(options.req) : null };
  const requestSession = options.sessionId || (options.req && options.req.get && options.req.get('X-Site-Session'));
  const event = sanitizeEvent({
    event_id: serverEventId(eventName, options.dedupeKey || `${eventName}:${username}:${Date.now()}`),
    occurred_at: new Date(), event_name: eventName,
    page_key: data.pageKey || data.page_key || (eventName === 'register_success' ? 'register' : 'holdings.dashboard'),
    module: data.module, entry: data.entry, device_type: data.deviceType || 'unknown',
    session_id: requestSession,
    source_domain: options.req ? sourceDomain(options.req) : '',
    properties: data.properties || data,
  }, { server: true });
  if (event.error) return { accepted: 0, error: event.error };
  return insertEvents([event], {
    visitorKey: identity.visitorKey,
    userKey: userKey(username),
    sourceDomain: event.sourceDomain || (options.req ? sourceDomain(options.req) : ''),
    sessionKey: event.sessionKey,
    internal: isInternalTraffic(options.req, username),
  });
}

function bucketStart(date = new Date()) {
  const value = new Date(date);
  value.setUTCSeconds(0, 0);
  return value;
}

function runtimeBucket(key, bucket, routeKey, sampleType = 'request') {
  let item = appRuntimeBuckets.get(key);
  if (!item) {
    item = { layer: 'app', bucketStart: bucket, routeKey, requestKind: 'unknown', requestCount: 0,
      status2xx: 0, status3xx: 0, status4xx: 0, status5xx: 0, durationBuckets: { lt100: 0, ms100_499: 0, ms500_999: 0, gte1000: 0 },
      status429: 0,
      bytesSent: 0, errorCount: 0, sampleType, coverageStatus: 'complete', eventLoopP50Ms: null, eventLoopP95Ms: null, eventLoopMaxMs: null };
    appRuntimeBuckets.set(key, item);
  }
  return item;
}

function normalizedRoute(pathname) {
  const raw = String(pathname || '').split('?')[0].replace(/\\+/g, '/');
  if (!raw || raw === '/health' || raw === '/ready') return '';
  if (raw.startsWith('/admin') || raw.startsWith('/api/admin')) return '';
  if (raw.match(/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?|map)$/i)) return '';
  return raw.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ':id')
    .replace(/\/\d{6}(?:\.(?:SH|SZ|BJ))?(?=\/|$)/gi, '/:code')
    .replace(/\/\d+(?=\/|$)/g, '/:id').slice(0, 160);
}

function requestKind(pathname) {
  const raw = String(pathname || '');
  if (raw.startsWith('/api/')) return 'api';
  if (raw.match(/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?|map)$/i)) return 'static';
  return 'page';
}

function recordAppRequest(req, res, startedAt) {
  if (String(req && req.path || '').startsWith('/api/telemetry')) return;
  const routeKey = normalizedRoute(req && req.path);
  if (!routeKey) return;
  const bucket = bucketStart();
  const key = `${bucket.toISOString()}:${routeKey}`;
  const item = runtimeBucket(key, bucket, routeKey);
  item.requestKind = requestKind(req.path);
  item.requestCount++;
  const status = Number(res.statusCode) || 0;
  if (status >= 200 && status < 300) item.status2xx++;
  else if (status >= 300 && status < 400) item.status3xx++;
  else if (status === 429) { item.status4xx++; item.status429++; }
  else if (status >= 400 && status < 500) item.status4xx++;
  else if (status >= 500) { item.status5xx++; item.errorCount++; }
  const duration = Math.max(Date.now() - Number(startedAt || Date.now()), 0);
  if (duration < 100) item.durationBuckets.lt100++;
  else if (duration < 500) item.durationBuckets.ms100_499++;
  else if (duration < 1000) item.durationBuckets.ms500_999++;
  else item.durationBuckets.gte1000++;
}

function recordEventLoopSample(sample = {}) {
  const bucket = bucketStart();
  const key = `${bucket.toISOString()}:__event_loop__`;
  const item = runtimeBucket(key, bucket, '__event_loop__', 'event_loop');
  item.eventLoopP50Ms = Number(sample.p50Ms) || 0;
  item.eventLoopP95Ms = Number(sample.p95Ms) || 0;
  item.eventLoopMaxMs = Number(sample.maxMs) || 0;
  item.coverageStatus = 'sampled';
}

async function writeRuntimeRows(rows, client = pool) {
  for (const row of rows) {
    await client.query(`INSERT INTO ops.site_runtime_minute
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
        source_file=EXCLUDED.source_file, recorded_at=now()`, [
      row.layer, row.bucketStart, row.batchId, row.processInstance || APP_PROCESS, row.routeKey || '', row.requestKind || 'unknown',
      row.requestCount || 0, row.status2xx || 0, row.status3xx || 0, row.status4xx || 0, row.status429 || 0, row.status5xx || 0,
      JSON.stringify(row.durationBuckets || {}), row.bytesSent || 0, row.errorCount || 0, row.sampleType || 'request',
      row.coverageStatus || 'complete', row.eventLoopP50Ms, row.eventLoopP95Ms, row.eventLoopMaxMs, row.sourceFile || ''
    ]);
  }
}

async function flushRuntimeMinute() {
  const current = bucketStart();
  const ready = [];
  for (const [key, item] of appRuntimeBuckets) {
    if (item.bucketStart >= current) continue;
    ready.push({ ...item, batchId: `app:${APP_PROCESS}:${item.bucketStart.toISOString()}:${item.routeKey}` });
    appRuntimeBuckets.delete(key);
  }
  if (!ready.length || !isEnabled()) return { flushed: 0 };
  try {
    await writeRuntimeRows(ready);
    return { flushed: ready.length };
  } catch (error) {
    // 运行统计不能影响业务请求；写库失败时把已取出的桶放回有界内存队列，等待下一轮重试。
    for (const item of ready) {
      const key = `${item.bucketStart.toISOString()}:${item.routeKey}`;
      if (!appRuntimeBuckets.has(key)) appRuntimeBuckets.set(key, { ...item, durationBuckets: { ...(item.durationBuckets || {}) } });
    }
    while (appRuntimeBuckets.size > MAX_RUNTIME_RETRY_BUCKETS) appRuntimeBuckets.delete(appRuntimeBuckets.keys().next().value);
    console.warn('[site-analytics] 应用运行采样写入失败:', error.message);
    return { flushed: 0, retrying: ready.length, error: error.message };
  }
}

function parseAnalyticsRange(query = {}) {
  const allowed = new Set(['today', '7d', '30d', '90d']);
  const range = allowed.has(String(query.range || '30d')) ? String(query.range || '30d') : '30d';
  const end = new Date();
  const start = range === 'today'
    ? new Date(`${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(end)}T00:00:00+08:00`)
    : new Date(end.getTime() - (Number(range.slice(0, -1)) || 30) * 24 * 60 * 60 * 1000);
  return { range, start, end, includeInternal: String(query.include_internal || '') === '1' };
}

function eventWhere(scope, includeInternal) {
  const where = [`${scope}.occurred_at >= $1`, `${scope}.occurred_at < $2`];
  if (!includeInternal) where.push(`${scope}.is_internal=false`);
  return where.join(' AND ');
}

function numberRows(rows) {
  return rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (value !== null && /^\d+(\.\d+)?$/.test(String(value))) return [key, Number(value)];
    return [key, value];
  })));
}

function percentileFromBuckets(value, percentile) {
  let buckets = value;
  if (typeof buckets === 'string') { try { buckets = JSON.parse(buckets); } catch (_) { buckets = {}; } }
  buckets = buckets && typeof buckets === 'object' ? buckets : {};
  const limits = [['lt100', 50], ['ms100_499', 250], ['ms500_999', 750], ['gte1000', 1000]];
  const total = limits.reduce((sum, item) => sum + (Number(buckets[item[0]]) || 0), 0);
  if (!total) return null;
  const target = total * percentile;
  let seen = 0;
  for (const item of limits) {
    seen += Number(buckets[item[0]]) || 0;
    if (seen >= target) return item[1];
  }
  return limits[limits.length - 1][1];
}

async function cacheGet(key, ttl, loader) {
  const now = Date.now();
  const memory = memoryCache.get(key);
  if (memory && memory.expiresAt > now) return memory.value;
  if (redis.ready && redis.client) {
    try {
      const cached = await redis.client.get('site:analytics:' + key);
      if (cached) return JSON.parse(cached);
    } catch (_) { /* Redis 失败时使用有界内存缓存 */ }
  }
  const value = await loader();
  memoryCache.set(key, { expiresAt: now + ttl, value });
  while (memoryCache.size > MEMORY_CACHE_MAX) memoryCache.delete(memoryCache.keys().next().value);
  if (redis.ready && redis.client) {
    try { await redis.client.setEx('site:analytics:' + key, Math.ceil(ttl / 1000), JSON.stringify(value)); } catch (_) {}
  }
  return value;
}

async function getOverview(query = {}) {
  const scope = parseAnalyticsRange(query);
  const cacheKey = `overview:${scope.range}:${scope.includeInternal ? 'internal' : 'public'}`;
  return cacheGet(cacheKey, DASHBOARD_CACHE_TTL, async () => {
    const where = eventWhere('e', scope.includeInternal);
    const params = [scope.start, scope.end];
    const trendSql = scope.range === 'today'
      ? `timezone('Asia/Shanghai', date_trunc('hour', occurred_at)) AS day`
      : `timezone('Asia/Shanghai', occurred_at)::date AS day`;
    const [summary, daily, pages, devices, newUsers, pending] = await Promise.all([
      pool.query(`SELECT COUNT(*) FILTER (WHERE event_name='page_view')::int AS pv,
        COUNT(DISTINCT visitor_key)::int AS uv, COUNT(DISTINCT session_key)::int AS sessions,
        COUNT(DISTINCT user_key) FILTER (WHERE event_name <> 'telemetry_init')::int AS logged_users,
        COUNT(DISTINCT visitor_key) FILTER (WHERE occurred_at >= now() - interval '5 minutes'
          AND event_name IN ('page_view','engagement','detail_open','filter_apply','register_view','register_submit','register_success','watchlist_add_success','import_result'))::int AS active_visitors,
        COUNT(*) FILTER (WHERE event_name='register_success')::int AS registrations,
        COUNT(*) FILTER (WHERE event_name='watchlist_add_success')::int AS watchlist_adds
        FROM ops.site_events e WHERE ${where}`, params),
      pool.query(`SELECT ${trendSql},
        COUNT(*) FILTER (WHERE event_name='page_view')::int AS pv,
        COUNT(DISTINCT visitor_key)::int AS uv
        FROM ops.site_events e WHERE ${where}
        GROUP BY 1 ORDER BY 1`, params),
      pool.query(`SELECT page_key, COUNT(*) FILTER (WHERE event_name='page_view')::int AS pv,
        COUNT(DISTINCT visitor_key)::int AS uv,
        COUNT(*) FILTER (WHERE event_name='page_view' AND entry <> '')::int AS entries,
        ROUND(AVG((properties->>'duration_sec')::numeric) FILTER (WHERE event_name='engagement'),1) AS avg_duration_sec
        FROM ops.site_events e WHERE ${where}
        GROUP BY page_key ORDER BY pv DESC LIMIT 12`, params),
      pool.query(`SELECT device_type, COUNT(*) FILTER (WHERE event_name='page_view')::int AS pv
        FROM ops.site_events e WHERE ${where} GROUP BY device_type ORDER BY pv DESC`, params),
      pool.query(`SELECT COUNT(*)::int AS new_registrations FROM users
        WHERE created_at >= $1 AND created_at < $2`, params),
      pool.query(`SELECT COUNT(*)::int AS pending_exceptions FROM ops.alert_notifications
        WHERE status NOT IN ('resolved','acknowledged','suppressed')`, [])
    ]);
    const summaryRow = numberRows(summary.rows)[0] || {};
    summaryRow.new_registrations = Number(newUsers.rows[0] && newUsers.rows[0].new_registrations || 0);
    summaryRow.pending_exceptions = Number(pending.rows[0] && pending.rows[0].pending_exceptions || 0);
    const hasData = Number(summaryRow.pv || 0) > 0 || Number(summaryRow.sessions || 0) > 0;
    return { range: scope.range, generatedAt: new Date().toISOString(), summary: summaryRow, daily: numberRows(daily.rows), topPages: numberRows(pages.rows), devices: numberRows(devices.rows), coverage: { status: hasData ? 'complete' : 'no_data', source: 'ops.site_events' } };
  });
}

async function getTraffic(query = {}) {
  const scope = parseAnalyticsRange(query);
  const cacheKey = `traffic:${scope.range}:${scope.includeInternal ? 'internal' : 'public'}`;
  return cacheGet(cacheKey, DASHBOARD_CACHE_TTL, async () => {
    const where = eventWhere('e', scope.includeInternal);
    const params = [scope.start, scope.end];
    const [sources, entries, sessions, pages] = await Promise.all([
      pool.query(`SELECT COALESCE(NULLIF(source_domain,''),'直接访问') AS source_domain,
        COUNT(*) FILTER (WHERE event_name='page_view')::int AS pv,
        COUNT(DISTINCT visitor_key)::int AS uv FROM ops.site_events e WHERE ${where}
        GROUP BY 1 ORDER BY pv DESC LIMIT 20`, params),
      pool.query(`SELECT COALESCE(NULLIF(entry,''),'未标记') AS entry,
        COUNT(*) FILTER (WHERE event_name='page_view')::int AS pv,
        COUNT(DISTINCT visitor_key)::int AS uv FROM ops.site_events e WHERE ${where}
        GROUP BY 1 ORDER BY pv DESC LIMIT 20`, params),
      pool.query(`SELECT timezone('Asia/Shanghai', occurred_at)::date AS day,
        COUNT(DISTINCT session_key)::int AS sessions, COUNT(DISTINCT user_key)::int AS logged_users
        FROM ops.site_events e WHERE ${where} GROUP BY 1 ORDER BY 1`, params),
      pool.query(`SELECT page_key, COUNT(*) FILTER (WHERE event_name='page_view')::int AS pv,
        COUNT(DISTINCT visitor_key)::int AS uv,
        COUNT(*) FILTER (WHERE event_name='page_view' AND entry <> '')::int AS entry_count,
        ROUND(AVG((properties->>'duration_sec')::numeric) FILTER (WHERE event_name='engagement'),1) AS avg_duration_sec
        FROM ops.site_events e WHERE ${where} GROUP BY page_key ORDER BY pv DESC LIMIT 20`, params)
    ]);
    return { range: scope.range, sources: numberRows(sources.rows), entries: numberRows(entries.rows), sessions: numberRows(sessions.rows), pages: numberRows(pages.rows), coverage: { status: sources.rows.length || entries.rows.length ? 'complete' : 'no_data' } };
  });
}

async function getBehavior(query = {}) {
  const scope = parseAnalyticsRange(query);
  const cacheKey = `behavior:${scope.range}:${scope.includeInternal ? 'internal' : 'public'}`;
  return cacheGet(cacheKey, DASHBOARD_CACHE_TTL, async () => {
    const where = eventWhere('e', scope.includeInternal);
    const params = [scope.start, scope.end];
    const [events, funnel, details, recent] = await Promise.all([
      pool.query(`SELECT event_name, COUNT(*)::int AS count,
        COUNT(DISTINCT COALESCE(user_key,visitor_key))::int AS users
        FROM ops.site_events e WHERE ${where} GROUP BY event_name ORDER BY count DESC`, params),
      pool.query(`WITH session_steps AS (
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
      pool.query(`SELECT page_key, COUNT(*)::int AS count, ROUND(AVG((properties->>'duration_sec')::numeric),1) AS avg_duration_sec
        FROM ops.site_events e WHERE ${where} AND event_name IN ('detail_open','engagement') GROUP BY page_key ORDER BY count DESC LIMIT 20`, params)
      ,pool.query(`SELECT occurred_at, event_name, page_key, module, entry,
          COALESCE(NULLIF(right(visitor_key,8),''),'匿名') AS visitor_label,
          (user_key IS NOT NULL) AS logged_in
        FROM ops.site_events e
        WHERE e.occurred_at >= GREATEST($1, now() - interval '30 minutes') AND e.occurred_at < $2
          ${scope.includeInternal ? '' : 'AND e.is_internal=false'} AND event_name <> 'telemetry_init'
        ORDER BY occurred_at DESC LIMIT 50`, params)
    ]);
    return { range: scope.range, events: numberRows(events.rows), funnel: numberRows(funnel.rows)[0] || {}, details: numberRows(details.rows), recent: recent.rows, coverage: { status: events.rows.length ? 'complete' : 'no_data' } };
  });
}

async function getRuntime(query = {}) {
  const scope = parseAnalyticsRange(query);
  const cacheKey = `runtime:${scope.range}`;
  return cacheGet(cacheKey, RUNTIME_CACHE_TTL, async () => {
    const [detailResult, summaryResult] = await Promise.all([
      pool.query(`SELECT bucket_start, layer, route_key, request_kind, request_count,
        status_2xx, status_3xx, status_4xx, status_429, status_5xx, duration_buckets, error_count,
        sample_type, coverage_status, event_loop_p50_ms, event_loop_p95_ms, event_loop_max_ms, source_file,
        COUNT(*) OVER() AS total_rows
        FROM ops.site_runtime_minute WHERE bucket_start >= $1 AND bucket_start < $2
        ORDER BY bucket_start DESC LIMIT 1000`, [scope.start, scope.end]),
      pool.query(`SELECT layer, SUM(request_count)::bigint AS request_count,
        SUM(status_2xx)::bigint AS status_2xx, SUM(status_3xx)::bigint AS status_3xx,
        SUM(status_4xx)::bigint AS status_4xx, SUM(status_429)::bigint AS status_429,
        SUM(status_5xx)::bigint AS status_5xx, SUM(error_count)::bigint AS error_count,
        SUM(COALESCE((duration_buckets->>'lt100')::bigint,0))::bigint AS duration_lt100,
        SUM(COALESCE((duration_buckets->>'ms100_499')::bigint,0))::bigint AS duration_ms100_499,
        SUM(COALESCE((duration_buckets->>'ms500_999')::bigint,0))::bigint AS duration_ms500_999,
        SUM(COALESCE((duration_buckets->>'gte1000')::bigint,0))::bigint AS duration_gte1000
        FROM ops.site_runtime_minute WHERE bucket_start >= $1 AND bucket_start < $2 GROUP BY layer ORDER BY layer`, [scope.start, scope.end])
    ]);
    const rows = detailResult.rows;
    const enriched = rows.map(row => ({
      ...row,
      p50_ms: percentileFromBuckets(row.duration_buckets, 0.5),
      p95_ms: percentileFromBuckets(row.duration_buckets, 0.95),
      slow_requests: Number(row.duration_buckets && row.duration_buckets.gte1000) || 0
    }));
    const summary = summaryResult.rows.map(row => {
      const durationBuckets = {
        lt100: Number(row.duration_lt100) || 0,
        ms100_499: Number(row.duration_ms100_499) || 0,
        ms500_999: Number(row.duration_ms500_999) || 0,
        gte1000: Number(row.duration_gte1000) || 0,
      };
      return { ...row, duration_buckets: durationBuckets,
        p50_ms: percentileFromBuckets(durationBuckets, 0.5),
        p95_ms: percentileFromBuckets(durationBuckets, 0.95),
        slow_requests: durationBuckets.gte1000 };
    });
    const totalRows = Number(rows[0] && rows[0].total_rows) || 0;
    return {
      range: scope.range,
      rows: numberRows(enriched),
      summary: numberRows(summary),
      dependency: await getDependencyHealth(),
      process: { rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024), load_1m: Number(os.loadavg()[0] || 0).toFixed(2) },
      coverage: { status: !rows.length ? 'no_sample' : totalRows > rows.length ? 'partial' : 'complete', rowCount: totalRows }
    };
  });
}

async function getConfigStatus() {
  const { rows } = await pool.query(`SELECT key, value FROM platform_config WHERE key IN ('site_analytics_enabled_at')`);
  const values = Object.fromEntries(rows.map(row => [row.key, row.value]));
  return { enabled: isEnabled(), secretConfigured: !!analyticsSecret(), retentionDays: Math.min(Math.max(Number(process.env.SITE_ANALYTICS_RETENTION_DAYS || 30), 7), 365), nginxConfigured: !!process.env.NGINX_ACCESS_LOG_PATH, enabledAt: values.site_analytics_enabled_at || null };
}

async function getDataHealth(query = {}) {
  const scope = parseAnalyticsRange(query);
  const cacheKey = `health:${scope.range}`;
  return cacheGet(cacheKey, RUNTIME_CACHE_TTL, async () => {
    const [events, runtime, cursor, config, datasets, quality, jobs, alerts, budgets, circuits, dependency] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS count, MIN(received_at) AS first_received_at, MAX(received_at) AS last_received_at,
        COUNT(*) FILTER (WHERE visitor_key IS NULL)::int AS no_visitor_key,
        COUNT(*) FILTER (WHERE user_key IS NULL)::int AS guest_events,
        COUNT(*) FILTER (WHERE is_internal=true)::int AS internal_events
        FROM ops.site_events WHERE received_at >= $1 AND received_at < $2`, [scope.start, scope.end]),
      pool.query(`SELECT MAX(bucket_start) AS last_bucket, COUNT(*)::int AS row_count FROM ops.site_runtime_minute WHERE bucket_start >= $1 AND bucket_start < $2`, [scope.start, scope.end]),
      pool.query(`SELECT last_attempt_at, last_source_update, last_error, cursor_payload FROM ops.sync_cursors WHERE scope_key='site_analytics:nginx' AND dataset_code='access_log' LIMIT 1`),
      getConfigStatus(),
      pool.query(`SELECT DISTINCT ON (dataset_code, scope_key) dataset_code, scope_key, partition_key::text,
          data_as_of::text, published_at, is_stale, stale_reason, row_count,
          (MIN(COALESCE(data_as_of, partition_key)) OVER (PARTITION BY dataset_code, scope_key))::text AS earliest_data_as_of,
          (MAX(COALESCE(data_as_of, partition_key)) OVER (PARTITION BY dataset_code, scope_key))::text AS latest_data_as_of
        FROM ops.dataset_partitions WHERE status='published'
        ORDER BY dataset_code, scope_key, partition_key DESC LIMIT 100`),
      pool.query(`SELECT dataset_code, status, severity, COUNT(*)::int AS count
        FROM ops.data_quality_issues GROUP BY dataset_code, status, severity ORDER BY count DESC LIMIT 100`),
      pool.query(`SELECT status, COUNT(*)::int AS count FROM ops.job_schedule_slots
        WHERE business_date=(timezone('Asia/Shanghai', now()))::date GROUP BY status ORDER BY status`),
      pool.query(`SELECT status, severity, COUNT(*)::int AS count FROM ops.alert_notifications
        WHERE status NOT IN ('resolved','acknowledged','suppressed') GROUP BY status, severity ORDER BY count DESC`),
      pool.query(`SELECT source, api_name, credential_profile, window_type, window_key, call_count, budget_limit,
          GREATEST(budget_limit-call_count, 0)::int AS remaining,
          ROUND(call_count::numeric * 100 / NULLIF(budget_limit, 0), 1) AS usage_percent
        FROM ops.external_call_budgets WHERE budget_limit IS NOT NULL AND budget_limit > 0
          AND call_count >= budget_limit * 0.8
          AND ((window_type='day' AND window_key=to_char(clock_timestamp() AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD'))
            OR (window_type='minute' AND window_key=floor(extract(epoch FROM clock_timestamp()) / 60)::bigint::text))
        ORDER BY updated_at DESC LIMIT 100`),
      pool.query(`SELECT source, api_name, token_fingerprint, state, recover_at, error_code, last_success_at
        FROM ops.external_circuits WHERE state='open' ORDER BY recover_at NULLS LAST LIMIT 100`),
      getDependencyHealth()
    ]);
    const eventSummary = numberRows(events.rows)[0] || {};
    const runtimeSummary = numberRows(runtime.rows)[0] || {};
    const hasData = Number(eventSummary.count || 0) > 0 || Number(runtimeSummary.row_count || 0) > 0 || datasets.rows.length > 0;
    return {
      range: scope.range,
      events: eventSummary,
      runtime: runtimeSummary,
      nginxCursor: cursor.rows[0] || null,
      config,
      datasets: datasets.rows,
      quality: numberRows(quality.rows),
      jobs: numberRows(jobs.rows),
      alerts: numberRows(alerts.rows),
      budgets: numberRows(budgets.rows),
      circuits: circuits.rows,
      dependency,
      coverage: { status: hasData ? 'complete' : 'no_data' }
    };
  });
}

async function getDependencyHealth() {
  const now = Date.now();
  if (dependencyHealthCache && dependencyHealthCache.expiresAt > now) return dependencyHealthCache.value;
  const database = { configured: true, status: 'error', ready: false, reason: '连接失败' };
  try {
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('数据库检查超时')), 1200); if (timer.unref) timer.unref(); })
    ]);
    database.status = 'ok'; database.ready = true; database.reason = '连接正常';
  } catch (error) { database.reason = error.message || '连接失败'; }

  const configured = !!process.env.REDIS_URL;
  let redisStatus = configured ? 'error' : 'not_configured';
  const required = process.env.REDIS_REQUIRED === '1';
  let redisReason = configured ? '未连接' : (required ? '环境要求 Redis 但未配置' : '未配置（可选依赖）');
  if (configured && redis.ready && redis.client) {
    try {
      await Promise.race([
        redis.client.ping(),
        new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('PING超时')), 1200); if (timer.unref) timer.unref(); })
      ]);
      redisStatus = 'ok'; redisReason = 'PING正常';
    } catch (error) { redisReason = error.message || 'PING失败'; }
  }
  if (!configured && required) redisStatus = 'error';

  let worker = { status: 'not_seen', ready: false, reason: '未发现 Worker 心跳' };
  if (process.env.NODE_ENV !== 'production') {
    worker = { status: 'disabled', ready: false, reason: '非生产环境不运行后台调度' };
  } else try {
    const result = await pool.query(`SELECT DISTINCT ON (role) role, worker_id, pid, app_version, status, last_seen_at
      FROM ops.worker_heartbeats ORDER BY role, last_seen_at DESC`);
    const row = result.rows.find(item => item.role === 'worker') || result.rows[0];
    if (row) {
      const lastSeen = new Date(row.last_seen_at).getTime();
      const ready = row.status === 'running' && Number.isFinite(lastSeen) && lastSeen >= Date.now() - 120000;
      worker = { status: ready ? 'ok' : 'stale', ready, reason: ready ? '心跳正常' : '心跳已过期或 Worker 未运行', workerId: row.worker_id, pid: row.pid, appVersion: row.app_version, lastSeenAt: row.last_seen_at };
    }
  } catch (error) { worker = { status: 'error', ready: false, reason: error.message || '心跳查询失败' }; }

  const value = {
    database,
    redis: { configured, required, status: redisStatus, ready: redisStatus === 'ok', reason: redisReason },
    worker,
    checkedAt: new Date().toISOString()
  };
  dependencyHealthCache = { expiresAt: now + 15000, value };
  return value;
}

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
  EVENT_NAMES, PAGE_KEYS, SERVER_ONLY_EVENTS, sanitizeEvent, parseAnalyticsRange,
  ensureVisitorCookie, clearVisitorCookie, ingestTelemetry, recordServerEvent, recordAppRequest, recordEventLoopSample,
  flushRuntimeMinute, writeRuntimeRows, getOverview, getTraffic, getBehavior, getRuntime, getDataHealth,
  getConfigStatus, getDependencyHealth, purgeAnalyticsData, normalizedRoute, parseCookie,
};

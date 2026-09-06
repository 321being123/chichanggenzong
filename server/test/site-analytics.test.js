const assert = require('assert');
process.env.SITE_ANALYTICS_SECRET = 'a'.repeat(32);
const analytics = require('../services/siteAnalytics');
const { parseNginxLine, extractCompleteLines } = require('../services/nginxRuntimeCollector');

const valid = analytics.sanitizeEvent({
  event_id: 'event-12345678', event_name: 'filter_apply', page_key: 'ipo.calendar',
  module: 'ipo', entry: 'history', session_id: 'session-id',
  properties: { filter_name: 'history_all', username: 'must-not-store' }
});
assert.ok(!valid.error, '白名单事件应通过校验');
assert.strictEqual(valid.properties.filter_name, 'history_all');
assert.ok(!Object.prototype.hasOwnProperty.call(valid.properties, 'username'), '事件属性不得保存账号等敏感字段');
assert.strictEqual(valid.sourceDomain, '', '未提供来源域名时不得猜测来源');
assert.ok(valid.sessionKey && valid.sessionKey.length === 64, '会话标识必须只保存不可逆摘要');
const externalSource = analytics.sanitizeEvent({
  event_id: 'event-12345680', event_name: 'page_view', page_key: 'home', source_domain: 'https://ref.example/path'
});
assert.strictEqual(externalSource.sourceDomain, 'ref.example', '来源域名只保留主机名');
assert.ok(analytics.sanitizeEvent({ event_id: 'event-12345679', event_name: 'register_success', page_key: 'register' }).error, '客户端不得伪造后端成功事件');
assert.strictEqual(analytics.parseAnalyticsRange({ range: '7d' }).range, '7d');
assert.strictEqual(analytics.parseAnalyticsRange({ range: 'unknown' }).range, '30d');
const rangeToday = analytics.parseAnalyticsRange({ range: 'today' });
const expectedShanghaiStart = new Date(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date()) + 'T00:00:00+08:00');
assert.strictEqual(rangeToday.start.toISOString(), expectedShanghaiStart.toISOString(), '统计日边界必须固定为上海时区');

const cookies = [];
const cookieResponse = { append(name, value) { if (name === 'Set-Cookie') cookies.push(value); } };
analytics.ensureVisitorCookie({ headers: {}, secure: false }, cookieResponse);
const existingCookie = cookies[0].split(';')[0];
analytics.ensureVisitorCookie({ headers: { cookie: existingCookie, 'x-site-analytics-reset': '1' }, secure: false }, cookieResponse);
analytics.clearVisitorCookie({ headers: {}, secure: false }, cookieResponse);
assert.ok(cookies.at(-1).includes('Max-Age=0'), '退出统计必须由服务端清除 HttpOnly 访客 Cookie');

const parsed = parseNginxLine('2026-09-06T12:34:56+08:00 rid=abc "GET /api/stock-analysis/600000.SH HTTP/2.0" status=200 request_time=0.123 upstream_connect_time=0.001 upstream_response_time=0.122 bytes=456 gzip_ratio=- protocol=http/2 ssl_protocol=- ssl_session_reused=-');
assert.ok(parsed, '现有 Nginx 日志格式应可解析');
assert.strictEqual(parsed.status, 200);
assert.strictEqual(parsed.routeKey, '/api/stock-analysis/:code');
const telemetryParsed = parseNginxLine('2026-09-06T12:34:57+08:00 rid=abc "POST /api/telemetry/events HTTP/2.0" status=429 request_time=0.012 upstream_connect_time=0.001 upstream_response_time=0.011 bytes=12 gzip_ratio=- protocol=http/2 ssl_protocol=- ssl_session_reused=-');
assert.ok(telemetryParsed && telemetryParsed.routeKey === '/api/telemetry/events' && telemetryParsed.status === 429, 'Nginx 应采集统计接口自身的限流结果');
const completeLines = extractCompleteLines('line-1\n');
assert.strictEqual(completeLines.lineMatches.length, 1, '完整日志行以换行符结束时也必须被消费');
assert.strictEqual(completeLines.selectedText, 'line-1\n');

console.log('site-analytics: 白名单、匿名字段、范围和 Nginx 增量日志解析通过');

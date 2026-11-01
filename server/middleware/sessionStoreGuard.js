// 会话存储故障的统一出口（复验 RV-02）。
//
// 背景：`app.use(session(...))` 在路由之前装配，只要请求带了 Cookie，express-session 就会先向
// Store 取会话。生产必需 Redis 在运行期断连时，connect-redis 的 get 抛 ClientOfflineError，
// 这个异常发生在任何路由守卫之前，于是带旧 Cookie 的请求拿到 500，而没 Cookie 的请求才是 503 ——
// 同一个故障两种响应，用户还会以为是"服务内部错误"。
//
// 这里做两件事，保证"敏感入口一律按约定 503，其它入口不出现 500 假象"：
//   1) `guardSensitiveSession` 必须在 session 中间件**之前**注册：必需存储不可用时立刻 503，
//      连会话读取都不发生（既不会挂住等重连，也不会把 Store 异常抖成 500）；
//   2) `isSessionStoreError` 给统一错误中间件用：任何路径上仍然冒出来的 Store 故障都映射成 503，
//      包括 /api/me 这类非敏感入口。
const { redis, isRedisRequired, redisUsable } = require('../config');

// 与路由里的 requireSessionStore 完全同一组入口：注册/登录/发码/重置。
const SENSITIVE_SESSION_PATHS = Object.freeze([
  '/api/register',
  '/api/login',
  '/api/send-code',
  '/api/forgot-password/send-code',
  '/api/forgot-password/reset',
]);

const STORE_ERROR_NAMES = new Set([
  'ClientOfflineError',
  'ClientClosedError',
  'SocketClosedUnexpectedlyError',
  'DisconnectsClientError',
  'MaxRetriesPerRequestError',
]);

const STORE_ERROR_CODES = new Set(['NR_CLOSED', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE']);
const STORE_ERROR_HINTS = [
  'the client is closed',
  'socket closed unexpectedly',
  'connection is closed',
  'client is offline',
  'stream isn\'t writeable',
  'reconnect',
];

function normalizePath(pathname) {
  return String(pathname || '').replace(/\/+$/, '') || '/';
}

function isSensitiveSessionPath(pathname) {
  return SENSITIVE_SESSION_PATHS.includes(normalizePath(pathname));
}

// 必需存储可用性：非必需环境（生产没开 REDIS_REQUIRED / 非生产）一直放行，行为和以前一致。
function sessionStoreUsable() {
  if (!(typeof isRedisRequired === 'function' && isRedisRequired())) return true;
  if (typeof redisUsable === 'function') return redisUsable();
  return Boolean(redis.ready && redis.client);
}

function rejectUnavailable(res) {
  res.set('Retry-After', '5');
  return res.status(503).json({ error: '登录服务暂时不可用，请稍后再试' });
}

// 必须在 express-session 之前注册。
function guardSensitiveSession(req, res, next) {
  if (!isSensitiveSessionPath(req.path)) return next();
  if (sessionStoreUsable()) return next();
  return rejectUnavailable(res);
}

// 会话 Store 抛出的异常识别：node-redis 的 name/code 与常见消息都覆盖，
// 避免 connect-redis 包装后只剩一句 message 就退化成 500。
function isSessionStoreError(error) {
  if (!error) return false;
  const name = String(error.name || '');
  const code = String(error.code || '');
  if (STORE_ERROR_NAMES.has(name) || STORE_ERROR_CODES.has(code)) return true;
  if (String(error.storeFault || '') === '1') return true;
  const message = String(error.message || '').toLowerCase();
  return STORE_ERROR_HINTS.some(hint => message.includes(hint));
}

module.exports = {
  SENSITIVE_SESSION_PATHS,
  guardSensitiveSession,
  sessionStoreUsable,
  isSessionStoreError,
  isSensitiveSessionPath,
  rejectUnavailable,
};

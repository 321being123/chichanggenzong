// ========== 统一错误处理、请求追踪与结构化日志（P2-2）==========
// 零额外依赖，全部用内置模块，避免引入新包。
const crypto = require('crypto');
const { monitorEventLoopDelay } = require('perf_hooks');
const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();
const eventLoopSampleTimer = setInterval(() => {
  const nsToMs = (value) => Number((value / 1e6).toFixed(1));
  console.log('[event-loop]', JSON.stringify({
    ts: new Date().toISOString(),
    p50Ms: nsToMs(eventLoopDelay.percentile(50)),
    p95Ms: nsToMs(eventLoopDelay.percentile(95)),
    maxMs: nsToMs(eventLoopDelay.max),
  }));
  try {
    const analytics = require('../services/siteAnalytics');
    analytics.recordEventLoopSample({
      p50Ms: nsToMs(eventLoopDelay.percentile(50)),
      p95Ms: nsToMs(eventLoopDelay.percentile(95)),
      maxMs: nsToMs(eventLoopDelay.max),
    });
    analytics.flushRuntimeMinute().catch(() => {});
  } catch (_) {}
  eventLoopDelay.reset();
}, 60000);
eventLoopSampleTimer.unref();

// 请求 ID：便于跨日志关联一次请求（支持上游透传 X-Request-Id）
function requestId(req, res, next) {
  req.id = req.headers['x-request-id'] || crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  // 审查 R-4：错误响应统一附带 requestId（与中央 errorHandler 同口径），
  // 路由内自行返回的 { error } 不再缺请求号，排障不用再猜对应哪条访问日志。
  const rawJson = res.json.bind(res);
  res.json = function (body) {
    if (body && typeof body === 'object' && !Array.isArray(body)
        && typeof body.error === 'string' && body.requestId === undefined) {
      return rawJson({ ...body, requestId: req.id });
    }
    return rawJson(body);
  };
  next();
}

// 结构化访问日志：记录方法、路径、状态码、耗时；失败时保留原因
function accessLog(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const line = {
      ts: new Date().toISOString(),
      rid: req.id,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durMs: Date.now() - start,
      ip: req.ip
    };
    if (res.statusCode >= 500) console.error('[access]', JSON.stringify(line));
    else console.log('[access]', JSON.stringify(line));
    try { require('../services/siteAnalytics').recordAppRequest(req, res, start); } catch (_) {}
  });
  next();
}

// 懒加载：错误中间件被所有路由引用，避免在模块加载期就把配置/Store 判定拉进来形成环。
function isSessionStoreError(error) {
  try {
    return require('./sessionStoreGuard').isSessionStoreError(error);
  } catch (_) {
    return false;
  }
}

// 统一错误中间件：兜底所有未捕获异常，输出结构化日志并返回 JSON 错误
// 注意：Express 要求该中间件恰好 4 个参数，才能识别为错误处理中间件
function errorHandler(err, req, res, next) {
  const rid = req.id || '-';
  console.error('[error]', JSON.stringify({
    ts: new Date().toISOString(),
    rid,
    method: req.method,
    path: req.originalUrl || req.path,
    message: err && err.message ? err.message : String(err),
    stack: err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n') : undefined
  }));
  if (res.headersSent) return next(err);
  // 会话存储故障必须映射成约定的 503（复验 RV-02）：生产必需 Redis 断连时，
  // express-session 读取 Store 抛出的 ClientOfflineError 会落在任何路由守卫之前，
  // 若按 500 返回，同一个故障会出现"无 Cookie 503、带旧 Cookie 500"两种口径，
  // 用户还会以为是服务内部错误。非敏感入口（如 /api/me）同样按 503 处理。
  if (isSessionStoreError(err)) {
    res.set('Retry-After', '5');
    return res.status(503).json({ error: '登录服务暂时不可用，请稍后再试', rid });
  }
  // 业务冲突（乐观锁）映射为 409；否则 500
  const status = err.status || (err.conflict ? 409 : 500);
  let message = (err && err.message) ? err.message : '服务器内部错误';
  // 500 错误一律不向客户端暴露内部细节（数据库/堆栈等），仅返回通用提示；
  // 完整信息已记入服务端日志。防止敏感信息泄露（P1-5）。
  if (status === 500) message = '服务器内部错误，请稍后重试';
  res.status(status).json({ error: message, rid });
}

module.exports = { requestId, accessLog, errorHandler };

// ========== 统一错误处理、请求追踪与结构化日志（P2-2）==========
// 零额外依赖，全部用内置模块，避免引入新包。
const crypto = require('crypto');

// 请求 ID：便于跨日志关联一次请求（支持上游透传 X-Request-Id）
function requestId(req, res, next) {
  req.id = req.headers['x-request-id'] || crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
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
  });
  next();
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
  // 业务冲突（乐观锁）映射为 409；否则 500
  const status = err.status || (err.conflict ? 409 : 500);
  let message = (err && err.message) ? err.message : '服务器内部错误';
  // 生产环境：500 不向客户端暴露原始数据库/内部错误细节，仅返回通用提示（P1-6）
  if (status === 500 && process.env.NODE_ENV === 'production') message = '服务器内部错误，请稍后重试';
  res.status(status).json({ error: message, rid });
}

module.exports = { requestId, accessLog, errorHandler };

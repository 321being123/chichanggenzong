// 包装异步路由，避免未捕获异常导致请求挂起
function asyncHandler(fn) { return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next); }

module.exports = asyncHandler;

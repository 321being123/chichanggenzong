// ========= 通用限流（Redis 优先，内存兜底） =========
const { redis } = require('../config');

const memBuckets = new Map();
function rateLimit({ prefix, windowMs, max, getKey, message }) {
  return async function (req, res, next) {
    const id = getKey ? getKey(req) : (req.ip || '');
    const key = 'rl:' + prefix + ':' + id;
    if (redis.ready && redis.client) {
      try {
        const c = await redis.client.incr(key);
        if (c === 1) await redis.client.expire(key, Math.ceil(windowMs / 1000));
        if (c > max) return res.status(429).json({ error: message || '请求过于频繁，请稍后再试' });
        return next();
      } catch (e) { /* 降级到内存 */ }
    }
    const now = Date.now();
    let b = memBuckets.get(key);
    if (!b || now > b.reset) { b = { count: 0, reset: now + windowMs }; }
    b.count++;
    memBuckets.set(key, b);
    if (b.count > max) return res.status(429).json({ error: message || '请求过于频繁，请稍后再试' });
    next();
  };
}

// TTL 清理（P1-6）：内存兜底桶长期不清理会无限增长，定期清除已过期条目避免内存泄漏
if (typeof setInterval === 'function') {
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of memBuckets) { if (b.reset < now) memBuckets.delete(k); }
  }, 5 * 60 * 1000);
  if (sweep.unref) sweep.unref();
}

module.exports = rateLimit;

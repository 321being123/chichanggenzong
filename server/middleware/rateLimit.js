// ========= 通用限流（Redis 优先，内存兜底） =========
const { redis, isRedisRequired } = require('../config');

// R2-003（2026-11-01）：固定窗口的计数与首次 TTL 改成一个 Lua 原子调用。
// 原来是 incr 与 expire 两条命令：中间失败会留下没有过期时间的键（该键永久计数，
// 命中它的用户被永久限流，或者永不过期占内存）。Lua 里：
//   - 新键（计数=1）设窗口过期；
//   - 已有键只有在 TTL 为 -1（历史遗留、丢了过期时间）时才补一个完整窗口，
//     正常正 TTL 一律不延长，保持固定窗口语义；
//   - 不扫描、不清空共用缓存，只修自己这个键。
const INCR_WITH_TTL_LUA = [
  "local current = redis.call('INCR', KEYS[1])",
  'if current == 1 then',
  "  redis.call('EXPIRE', KEYS[1], ARGV[1])",
  "elseif redis.call('TTL', KEYS[1]) < 0 then",
  "  redis.call('EXPIRE', KEYS[1], ARGV[1])",
  'end',
  'return current',
].join('\n');

const memBuckets = new Map();
function rateLimit({ prefix, windowMs, max, getKey, message }) {
  const reject = (res) => res.status(429).json({ error: message || '请求过于频繁，请稍后再试' });
  return async function (req, res, next) {
    const id = getKey ? getKey(req) : (req.ip || '');
    const key = 'rl:' + prefix + ':' + id;
    if (redis.ready && redis.client) {
      try {
        const windowSeconds = Math.max(Math.ceil(windowMs / 1000), 1);
        const c = await redis.client.eval(INCR_WITH_TTL_LUA, { keys: [key], arguments: [String(windowSeconds)] });
        if (Number(c) > max) return reject(res);
        return next();
      } catch (e) {
        // Redis 故障不能静默变成"没限流"：敏感入口要求共享计数时直接 503（区别于超限 429），
        // 可选模式下才退回本进程内存计数，并保留一条可诊断的告警。
        console.warn(`[rateLimit] ${prefix} Redis 计数失败：${String(e && e.message).slice(0, 160)}`);
        if (typeof isRedisRequired === 'function' && isRedisRequired()) {
          return res.status(503).json({ error: '服务繁忙，请稍后再试' });
        }
      }
    }
    const now = Date.now();
    let b = memBuckets.get(key);
    if (!b || now > b.reset) { b = { count: 0, reset: now + windowMs }; }
    b.count++;
    memBuckets.set(key, b);
    if (b.count > max) return reject(res);
    next();
  };
}

// TTL 清理（P1-6）：内存兜底桶长期不清理会无限增长，定期清除已过期条目避免内存泄漏。
// 只清理已过期项，不做"按最旧淘汰有效项"，避免新键挤掉仍在生效的计数。
if (typeof setInterval === 'function') {
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of memBuckets) { if (b.reset < now) memBuckets.delete(k); }
  }, 5 * 60 * 1000);
  if (sweep.unref) sweep.unref();
}

module.exports = rateLimit;
module.exports.INCR_WITH_TTL_LUA = INCR_WITH_TTL_LUA;
module.exports.memBuckets = memBuckets;

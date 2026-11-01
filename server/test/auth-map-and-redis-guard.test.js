// 认证状态回收、限流原子性与 Redis 必需配置的回归（审查 R2-003 / R2-004 / R2-007，T-001 组成部分）。
//
// 全部用注入替身与虚拟时钟，不连真实 Redis、不发外部请求；需要数据库的部分不在本文件。
// 运行：node server/test/auth-map-and-redis-guard.test.js
process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
process.env.PGDATABASE = process.env.PGTESTDATABASE || 'portfolio_test';

const assert = require('assert');

const cases = [];
function check(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    cases.push(['PASS', name]);
    console.log('  [PASS] ' + name);
  }).catch(error => {
    cases.push(['FAIL', name + ' :: ' + (error && error.message)]);
    console.log('  [FAIL] ' + name + ' :: ' + (error && error.message));
  });
}

(async () => {
  const config = require('../config');
  const auth = require('../middleware/auth');
  const rateLimit = require('../middleware/rateLimit');

  console.log('A. 登录失败锁定与 Map 回收（R2-004）');

  await check('五次失败进入 15 分钟锁定，锁定期内 sweep 不回收', async () => {
    const key = 'login_lock_probe_1';
    for (let i = 0; i < 5; i += 1) auth.recordFail(key);
    let snapshot = auth.inspectAuthMaps();
    assert.ok(snapshot.lockedKeys.includes(key), '五次失败后该键必须处于锁定状态');
    // 虚拟时钟推进 2 小时：锁定期（15 分钟）已过，但"有效锁定"的判定要用当时时间。
    auth.sweepAuthMaps(Date.now() + 2 * 60 * 1000);
    snapshot = auth.inspectAuthMaps();
    assert.ok(snapshot.lockedKeys.includes(key), '锁定仍在有效期内时，清理不得淘汰它（否则新键攻击可绕过锁定）');
  });

  await check('锁定到期后由定时清理主动回收', async () => {
    const key = 'login_lock_probe_2';
    for (let i = 0; i < 5; i += 1) auth.recordFail(key);
    const later = Date.now() + 16 * 60 * 1000;
    auth.sweepAuthMaps(later);
    const snapshot = auth.inspectAuthMaps(later);
    assert.ok(!snapshot.failKeys.includes(key), '锁定期已过的记录必须被清理（原来被排除在清理之外，永久驻留）');
  });

  await check('普通失败按最后活动时间计 TTL，持续失败不会被提前清掉', async () => {
    const key = 'login_fail_probe_1';
    const t0 = Date.now();
    auth.recordFail(key, t0);                             // 第 1 次失败
    auth.recordFail(key, t0 + 50 * 60 * 1000);            // 50 分钟后再失败：活动时间前移
    // 距首次失败 80 分钟、距最后一次失败 30 分钟：按活动时间算仍在 1 小时 TTL 内。
    auth.sweepAuthMaps(t0 + 80 * 60 * 1000);
    assert.ok(auth.inspectAuthMaps(t0 + 80 * 60 * 1000).failKeys.includes(key),
      'at 必须随失败更新，否则持续攻击中的键会被按首次失败时间提前回收');
    auth.sweepAuthMaps(t0 + 3 * 60 * 60 * 1000);
    assert.ok(!auth.inspectAuthMaps(t0 + 3 * 60 * 60 * 1000).failKeys.includes(key), '超过 TTL 应回收');
  });

  await check('注册 IP 记录同样按 TTL 回收', async () => {
    auth.checkRegLimit('203.0.113.10');
    assert.ok(auth.inspectAuthMaps().regIpKeys.includes('203.0.113.10'));
    assert.strictEqual(auth.checkRegLimit('203.0.113.10'), true, '60 秒内重复注册必须被拦');
    auth.sweepAuthMaps(Date.now() + 2 * 60 * 60 * 1000);
    assert.ok(!auth.inspectAuthMaps().regIpKeys.includes('203.0.113.10'), '注册 IP 记录必须随 TTL 回收');
  });

  console.log('B. 限流原子性与故障语义（R2-003 / R2-007）');

  await check('计数与 TTL 走同一个 Lua 原子调用，不再分 incr/expire', async () => {
    const calls = [];
    config.redis.ready = true;
    config.redis.client = {
      eval: async (script, options) => { calls.push({ script, options }); return 1; },
      incr: async () => { throw new Error('不得再单独调用 incr'); },
      expire: async () => { throw new Error('不得再单独调用 expire'); },
    };
    const middleware = rateLimit({ prefix: 'probe-atomic', windowMs: 60000, max: 5, getKey: () => 'k1' });
    let status = 200;
    const res = { status(code) { status = code; return this; }, json() { return this; } };
    await middleware({ ip: '1.1.1.1' }, res, () => {});
    assert.strictEqual(status, 200);
    assert.strictEqual(calls.length, 1, '一次请求只允许一次 Redis 调用（原子）');
    assert.match(calls[0].script, /INCR/, '必须包含计数');
    assert.match(calls[0].script, /EXPIRE/, '必须包含过期设置');
    assert.match(calls[0].script, /TTL.*< 0/, '命中的旧无 TTL 键必须自愈，否则会永久计数');
    assert.deepStrictEqual(calls[0].options.keys, ['rl:probe-atomic:k1']);
    assert.deepStrictEqual(calls[0].options.arguments, ['60']);
    config.redis.ready = false; config.redis.client = null;
  });

  await check('超过上限返回 429（保持原语义）', async () => {
    config.redis.ready = true;
    config.redis.client = { eval: async () => 6 };
    const middleware = rateLimit({ prefix: 'probe-limit', windowMs: 60000, max: 5, getKey: () => 'k2' });
    let status = 200;
    const res = { status(code) { status = code; return this; }, json() { return this; } };
    await middleware({ ip: '1.1.1.1' }, res, () => {});
    assert.strictEqual(status, 429);
    config.redis.ready = false; config.redis.client = null;
  });

  await check('必需 Redis 但计数失败：返回 503（存储故障），不静默降级成各进程各算', async () => {
    const saved = { nodeEnv: process.env.NODE_ENV, required: process.env.REDIS_REQUIRED };
    process.env.NODE_ENV = 'production';
    process.env.REDIS_REQUIRED = '1';
    config.redis.ready = true;
    config.redis.client = { eval: async () => { throw new Error('redis down'); } };
    const middleware = rateLimit({ prefix: 'probe-fail-required', windowMs: 60000, max: 5, getKey: () => 'k3' });
    let status = 200;
    const res = { status(code) { status = code; return this; }, json() { return this; } };
    await middleware({ ip: '1.1.1.1' }, res, () => {});
    assert.strictEqual(status, 503, '存储故障必须与超限 429 区分');
    config.redis.ready = false; config.redis.client = null;
    process.env.NODE_ENV = saved.nodeEnv;
    process.env.REDIS_REQUIRED = saved.required || '';
  });

  await check('可选 Redis 计数失败：退回本进程内存计数并留日志', async () => {
    config.redis.ready = true;
    config.redis.client = { eval: async () => { throw new Error('redis down'); } };
    const middleware = rateLimit({ prefix: 'probe-fail-optional', windowMs: 60000, max: 2, getKey: () => 'k4' });
    const run = async () => {
      let status = 200;
      const res = { status(code) { status = code; return this; }, json() { return this; } };
      await middleware({ ip: '1.1.1.1' }, res, () => {});
      return status;
    };
    assert.strictEqual(await run(), 200);
    assert.strictEqual(await run(), 200);
    assert.strictEqual(await run(), 429, '内存兜底也要真正生效');
    config.redis.ready = false; config.redis.client = null;
  });

  await check('必需 Redis 但缺少/空白 URL：初始化直接阻断启动（R2-007）', async () => {
    const saved = { nodeEnv: process.env.NODE_ENV, required: process.env.REDIS_REQUIRED, url: process.env.REDIS_URL };
    process.env.NODE_ENV = 'production';
    process.env.REDIS_REQUIRED = '1';
    delete process.env.REDIS_URL;
    await assert.rejects(config.initRedis(), /REDIS_URL 缺失或为空/, '缺 URL 必须在入口阻断，不能靠后续连接异常');
    process.env.REDIS_URL = '   ';
    await assert.rejects(config.initRedis(), /REDIS_URL 缺失或为空/, '只有空白同样算缺失');
    assert.strictEqual(config.isRedisRequired(), true);
    process.env.NODE_ENV = saved.nodeEnv;
    process.env.REDIS_REQUIRED = saved.required || '';
    if (saved.url === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = saved.url;
  });

  await check('非必需环境未配置 Redis：保持原内存模式，不阻断启动', async () => {
    const saved = { nodeEnv: process.env.NODE_ENV, required: process.env.REDIS_REQUIRED, url: process.env.REDIS_URL };
    process.env.NODE_ENV = 'development';
    delete process.env.REDIS_REQUIRED;
    delete process.env.REDIS_URL;
    await config.initRedis();
    assert.strictEqual(config.redis.ready, false);
    assert.strictEqual(config.isRedisRequired(), false);
    process.env.NODE_ENV = saved.nodeEnv;
    if (saved.required !== undefined) process.env.REDIS_REQUIRED = saved.required;
    if (saved.url !== undefined) process.env.REDIS_URL = saved.url;
  });

  await check('敏感入口在必需 Redis 未就绪时返回 503，就绪后放行', async () => {
    const saved = { nodeEnv: process.env.NODE_ENV, required: process.env.REDIS_REQUIRED };
    process.env.NODE_ENV = 'production';
    process.env.REDIS_REQUIRED = '1';
    let status = 200;
    const res = { status(code) { status = code; return this; }, json() { return this; } };
    let passed = false;
    auth.requireSessionStore({}, res, () => { passed = true; });
    assert.strictEqual(passed, false);
    assert.strictEqual(status, 503);
    config.redis.ready = true;
    config.redis.client = {};
    passed = false;
    auth.requireSessionStore({}, res, () => { passed = true; });
    assert.strictEqual(passed, true, '共享存储就绪后必须放行');
    config.redis.ready = false; config.redis.client = null;
    process.env.NODE_ENV = saved.nodeEnv;
    process.env.REDIS_REQUIRED = saved.required || '';
  });

  const failed = cases.filter(item => item[0] === 'FAIL');
  console.log(`\n==== 认证状态与限流结果: ${cases.length - failed.length}/${cases.length} 通过 ====`);
  if (failed.length) {
    failed.forEach(item => console.log('  - ' + item[1]));
    process.exit(1);
  }
  console.log('全部通过 ✅');
})().catch(error => {
  console.error('auth-map-and-redis-guard.test.js 失败:', (error && error.stack) || error);
  process.exit(1);
});

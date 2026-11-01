// Web 优雅停机排空顺序与退出语义（审查 S-005）。
//
// 用真实 HTTP 服务与受控屏障验证顺序：在途请求未结束前不得关闭 DB/Redis；
// 排空后关闭依赖；硬截止超时返回非优雅结果；空闲 keep-alive 不拖住关闭。
// 不启动整个应用、不连生产依赖。运行：node server/test/web-shutdown-drain.test.js
process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
process.env.PGDATABASE = process.env.PGTESTDATABASE || 'portfolio_test';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { drainHttpAndDeps, closeListener } = require('../app');

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

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function makeServer({ delayMs = 0, port = 0 } = {}) {
  const app = express();
  app.get('/slow', (req, res) => {
    setTimeout(() => res.json({ ok: true }), delayMs);
  });
  const server = http.createServer(app);
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)));
}

function getWithAgent(server, agent) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, path: '/slow', method: 'GET', agent,
    }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  console.log('A. 排空顺序');

  await check('在途请求结束前不关闭 DB/Redis，结束后才释放', async () => {
    const server = await makeServer({ delayMs: 300 });
    const deps = { closed: false };
    const inFlight = getWithAgent(server, http.globalAgent);
    await wait(60); // 等请求真的进到路由里
    const drain = drainHttpAndDeps({
      servers: [server],
      closeDeps: async () => { deps.closed = true; return [{ status: 'fulfilled' }, { status: 'fulfilled' }]; },
      timeoutMs: 5000,
    });
    await wait(120);
    assert.strictEqual(deps.closed, false, '在途请求还没结束就不能关闭依赖（原实现发完 close() 就去 pool.end）');
    const response = await inFlight;
    assert.strictEqual(response.status, 200, '在途请求必须收到完整响应');
    assert.strictEqual(await drain, 'drained');
    assert.strictEqual(deps.closed, true, '排空完成后必须关闭依赖');
  });

  await check('两个监听都关闭后才返回（IPv4/IPv6 双栈）', async () => {
    const first = await makeServer({ delayMs: 0 });
    const second = await makeServer({ delayMs: 0 });
    let closed = 0;
    const outcome = await drainHttpAndDeps({
      servers: [first, second],
      closeDeps: async () => { closed += 1; return [{ status: 'fulfilled' }]; },
      timeoutMs: 3000,
    });
    assert.strictEqual(outcome, 'drained');
    assert.strictEqual(closed, 1);
    assert.strictEqual(first.listening, false);
    assert.strictEqual(second.listening, false);
  });

  await check('空闲 keep-alive 连接不拖住关闭', async () => {
    const server = await makeServer({ delayMs: 0 });
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    await getWithAgent(server, agent); // 请求完成后连接进入空闲 keep-alive
    const startedAt = Date.now();
    const outcome = await drainHttpAndDeps({
      servers: [server],
      closeDeps: async () => [{ status: 'fulfilled' }],
      timeoutMs: 3000,
    });
    agent.destroy();
    assert.strictEqual(outcome, 'drained', '空闲连接必须被主动断开，不能等到 keep-alive 超时');
    assert.ok(Date.now() - startedAt < 2000, '关闭耗时应远小于超时上限');
  });

  console.log('B. 截止时间与退出语义');

  await check('请求迟迟不结束：到点返回 timeout，且不关闭依赖', async () => {
    const server = await makeServer({ delayMs: 2000 });
    const deps = { closed: false };
    const inFlight = getWithAgent(server, http.globalAgent).catch(() => null);
    await wait(50);
    const outcome = await drainHttpAndDeps({
      servers: [server],
      closeDeps: async () => { deps.closed = true; return [{ status: 'fulfilled' }]; },
      timeoutMs: 100,
    });
    assert.strictEqual(outcome, 'timeout', '硬截止到点必须报 timeout（调用方据此非零退出）');
    assert.strictEqual(deps.closed, false, '超时前不得假装已经排空并关闭依赖');
    try { server.closeAllConnections(); } catch (_) { /* 忽略 */ }
    await inFlight;
  });

  await check('依赖关闭失败：返回 degraded（排空完成但资源释放不完整）', async () => {
    const server = await makeServer({ delayMs: 0 });
    const outcome = await drainHttpAndDeps({
      servers: [server],
      closeDeps: async () => [{ status: 'fulfilled' }, { status: 'rejected', reason: new Error('redis quit failed') }],
      timeoutMs: 3000,
    });
    assert.strictEqual(outcome, 'degraded');
  });

  await check('未启动或已关闭的监听安全处理', async () => {
    await closeListener(null);
    await closeListener(undefined);
    const server = await makeServer({ delayMs: 0 });
    await closeListener(server);
    await closeListener(server); // 重复关闭同一监听不能抛错
    assert.strictEqual(server.listening, false);
  });

  console.log('C. 停机入口语义（静态钉住，避免退回旧实现）');

  const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  await check('停机是幂等的：重复信号不重复关闭依赖、不重置截止时间', async () => {
    assert.match(source, /if \(shutdownPromise\) return shutdownPromise;/, '重复信号必须复用同一个停机 Promise');
    assert.match(source, /shuttingDown = true;/, '必须有一次性停机状态');
    assert.match(source, /closeIdleConnections/, '关闭监听后要主动断开空闲连接');
  });

  await check('正常排空才退出 0，超时/依赖失败退出非 0', async () => {
    assert.match(source, /outcome === 'drained'\) process\.exit\(0\)/, '正常排空才以 0 退出');
    assert.match(source, /outcome === 'degraded'[\s\S]{0,200}process\.exit\(1\)/, '依赖释放异常必须非零退出');
    assert.match(source, /排空超时[\s\S]{0,300}process\.exit\(1\)/, '超时强制退出必须非零，不能记作优雅成功');
  });

  await check('停机期间就绪状态不再冒充可用', async () => {
    assert.match(source, /shutting_down/, '/ready 在停机时必须返回 not ready');
    assert.match(source, /rejectWhileShuttingDown/, '停机期的新业务请求要明确拒绝');
  });

  const failed = cases.filter(item => item[0] === 'FAIL');
  console.log(`\n==== Web 停机排空结果: ${cases.length - failed.length}/${cases.length} 通过 ====`);
  if (failed.length) {
    failed.forEach(item => console.log('  - ' + item[1]));
    process.exit(1);
  }
  console.log('全部通过 ✅');
  process.exit(0);
})().catch(error => {
  console.error('web-shutdown-drain.test.js 失败:', (error && error.stack) || error);
  process.exit(1);
});

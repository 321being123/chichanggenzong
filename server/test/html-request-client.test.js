const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..', '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

(async () => {
  for (const page of ['public/index.html', 'public/login.html', 'public/ipo-report.html', 'public/share-knowledge.html']) {
    const html = read(page);
    assert.ok(!/\bfetch\s*\(/.test(html), `${page} 不得绕过站内请求客户端`);
    assert.ok(html.includes('js/api/client.js?v=__APP_VERSION__'), `${page} 必须加载客户端`);
    if (!page.endsWith('/index.html')) assert.ok(html.indexOf('js/api/client.js') < html.indexOf('siteApi.fetchResponse('), `${page} 必须先加载客户端`);
  }
  const response = { ok: false, status: 403, json: async () => ({ error: '拒绝' }) };
  let called;
  const context = { api: () => { throw new Error('已拼接路径不得再次处理'); },
    fetch: async (...args) => { called = args; return response; } };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(read('public/js/api/client.js'), context);
  const opts = { method: 'POST', credentials: 'same-origin', body: 'x', headers: { 'Content-Type': 'text/plain' } };
  assert.strictEqual(await context.siteApi.fetchResponse('/api/test', opts), response, 'HTTP 错误仍返回原响应');
  assert.strictEqual(called[0], '/api/test');
  assert.strictEqual(called[1].method, 'POST');
  assert.strictEqual(called[1].credentials, 'same-origin');
  assert.strictEqual(called[1].headers['Content-Type'], 'text/plain');
  assert.strictEqual(called[1].timeoutMs, undefined);
  assert.strictEqual(called[1].relativePath, undefined);
  context.fetch = async () => { throw new Error('离线'); };
  await assert.rejects(context.siteApi.fetchResponse('/api/test'), /离线/);
  console.log('页面请求客户端：加载顺序、原始响应、参数和网络失败通过');
})().catch(error => { console.error(error); process.exitCode = 1; });

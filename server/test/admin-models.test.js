// 后台大模型配置路由（admin.js /models*）路由级测试
// 方式：monkeypatch requireAdmin(放行) + db 读写/审计(内存/空操作)，挂载 router 到最小 express 实例，
//       用 Node 22 全局 fetch 打本地临时端口，验证增/查/改/删/测试/设默认/排序的真实路由逻辑。
// 不依赖起完整 server 或真实 PG。运行: node server/test/admin-models.test.js
const assert = require('assert');
const express = require('express');
const http = require('http');

// 1) mock 鉴权：放行所有请求（把 auth 模块导出替换为 pass-through，须在 require admin.js 之前）
const auth = require('../middleware/auth');
auth.requireStaff = (req, res, next) => next();
auth.requireCapability = () => (req, res, next) => next();

// 2) mock db 读写 + 审计
const db = require('../db');
const _store = {};
db.getConfig = async (k, def) => (k in _store ? _store[k] : (def === undefined ? '' : def));
db.setConfig = async (k, v) => { _store[k] = String(v); };
let auditCalls = 0;
db.auditEvent = async () => { auditCalls++; };

// 3) mock 全局 fetch（测试连通性路由用真实外部请求，这里替换为可控桩）
//    注意：测试客户端 call() 必须用自己的引用 clientFetch，否则 mock 会连带把客户端请求也劫持。
const realFetch = global.fetch;
const clientFetch = global.fetch;
function installFetch(handler) { global.fetch = handler; }
function restoreFetch() { global.fetch = realFetch; }

const router = require('../routes/admin');
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.session = { user: 'admin' }; next(); }); // 模拟已登录管理员
app.use('/api/admin', router);

const server = http.createServer(app);
let PORT, BASE;

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + '\n    ' + (e && e.message)); }
}
async function call(method, p, body) {
  const r = await clientFetch(BASE + p, {
    method, headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: body ? JSON.stringify(body) : undefined
  });
  let b; try { b = await r.json(); } catch (e) { b = null; }
  return { status: r.status, body: b };
}

// 测试连通性路由：fetch 桩返回成功
function fakeFetchOk() {
  return async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'OK' } }] }) });
}
// 测试连通性路由：fetch 桩抛错（模拟网络失败）
function fakeFetchErr() {
  return async () => { throw new Error('connect ECONNREFUSED'); };
}

async function main() {
  console.log('后台大模型配置路由 (admin /models*):');
  await new Promise(r => server.listen(0, r));
  PORT = server.address().port;
  BASE = 'http://127.0.0.1:' + PORT;

  await check('GET /models 初始返回空列表', async () => {
    const r = await call('GET', '/api/admin/models');
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.body.list) && r.body.list.length === 0, '初始应为空');
  });

  await check('POST /models 新增成功且分配 order', async () => {
    const r = await call('POST', '/api/admin/models', {
      name: '默认模型', model: 'agnes-2.0-flash',
      apiUrl: 'https://apihub.agnes-ai.com/v1/chat/completions', apiKey: 'sk-real-key-1234', enabled: true
    });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.id, '应返回 id');
    const list = (await call('GET', '/api/admin/models')).body.list;
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].order, 0);
    assert.strictEqual(list[0].enabled, true);
    assert.ok(list[0].apiKey.includes('***'), '列表里 Key 应打码'); // maskKey 生效
  });

  await check('POST /models 缺少必填返回 400', async () => {
    const r = await call('POST', '/api/admin/models', { name: 'x' }); // 缺 model/apiUrl/apiKey
    assert.strictEqual(r.status, 400);
  });

  await check('POST /models 非 HTTPS 地址返回 400', async () => {
    const r = await call('POST', '/api/admin/models', {
      name: 'bad', model: 'm', apiUrl: 'http://insecure.com/v1', apiKey: 'k'
    });
    assert.strictEqual(r.status, 400);
  });

  // 造第二个模型，用于排序/默认/删除测试
  let id2;
  await check('再新增第二个模型', async () => {
    const r = await call('POST', '/api/admin/models', {
      name: '备用', model: 'agnes-2.5-pro-alpha',
      apiUrl: 'https://apihub.agnes-ai.com/v1/chat/completions', apiKey: 'sk-second-key-5678', enabled: true
    });
    assert.strictEqual(r.status, 200); id2 = r.body.id;
    const list = (await call('GET', '/api/admin/models')).body.list;
    assert.strictEqual(list.length, 2);
    assert.strictEqual(list[1].order, 1);
  });

  await check('PUT /models/:id 编辑时回传打码 Key 则保留原值', async () => {
    const list = (await call('GET', '/api/admin/models')).body.list;
    const target = list[0];
    const r = await call('PUT', '/api/admin/models/' + target.id, {
      name: '默认模型改', model: 'agnes-2.0-flash',
      apiUrl: 'https://apihub.agnes-ai.com/v1/chat/completions',
      apiKey: target.apiKey, // 前端回传的打码串
      enabled: true
    });
    assert.strictEqual(r.status, 200);
    // 重新读库（绕过列表打码）：直接读 getModels
    const { getModels } = require('../services/aiModels');
    const raw = (await getModels()).find(m => m.id === target.id);
    assert.strictEqual(raw.apiKey, 'sk-real-key-1234', '原 Key 应被保留');
    assert.strictEqual(raw.name, '默认模型改', '名称应更新');
  });

  await check('PUT /models/:id 编辑时传新 Key 则更新', async () => {
    const list = (await call('GET', '/api/admin/models')).body.list;
    const target = list[0];
    const r = await call('PUT', '/api/admin/models/' + target.id, {
      name: '默认模型改', model: 'agnes-2.0-flash',
      apiUrl: 'https://apihub.agnes-ai.com/v1/chat/completions',
      apiKey: 'sk-new-key-9999', enabled: true
    });
    assert.strictEqual(r.status, 200);
    const { getModels } = require('../services/aiModels');
    const raw = (await getModels()).find(m => m.id === target.id);
    assert.strictEqual(raw.apiKey, 'sk-new-key-9999', 'Key 应更新为新值');
  });

  await check('POST /models/:id/default 把目标排到最前(order=0)', async () => {
    const r = await call('POST', '/api/admin/models/' + id2 + '/default');
    assert.strictEqual(r.status, 200);
    const list = (await call('GET', '/api/admin/models')).body.list;
    assert.strictEqual(list[0].id, id2, '第二个模型应成为默认(最前)');
    assert.strictEqual(list[0].order, 0);
    assert.strictEqual(list[1].order, 1);
  });

  await check('POST /models/:id/move up 与 down 调整顺序', async () => {
    // 当前顺序: [id2(order0), 第一个(order1)]，把第一个上移应交换
    const list = (await call('GET', '/api/admin/models')).body.list;
    const firstId = list[1].id;
    await call('POST', '/api/admin/models/' + firstId + '/move', { dir: 'up' });
    let after = (await call('GET', '/api/admin/models')).body.list;
    assert.strictEqual(after[0].id, firstId, '上移后应到最前');
    await call('POST', '/api/admin/models/' + firstId + '/move', { dir: 'down' });
    after = (await call('GET', '/api/admin/models')).body.list;
    assert.strictEqual(after[1].id, firstId, '下移后应回到第二位');
  });

  await check('POST /models/:id/test 连通成功记录状态', async () => {
    installFetch(fakeFetchOk());
    const list = (await call('GET', '/api/admin/models')).body.list;
    const r = await call('POST', '/api/admin/models/' + list[0].id + '/test');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true, '应返回 ok=true');
    restoreFetch();
  });

  await check('POST /models/:id/test 连通失败记录错误', async () => {
    installFetch(fakeFetchErr());
    const list = (await call('GET', '/api/admin/models')).body.list;
    const r = await call('POST', '/api/admin/models/' + list[0].id + '/test');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, false, '应返回 ok=false');
    assert.ok(r.body.error, '应附带错误信息');
    restoreFetch();
  });

  await check('DELETE /models/:id 删除模型', async () => {
    const list = (await call('GET', '/api/admin/models')).body.list;
    const target = list[0];
    const r = await call('DELETE', '/api/admin/models/' + target.id);
    assert.strictEqual(r.status, 200);
    const after = (await call('GET', '/api/admin/models')).body.list;
    assert.ok(!after.some(m => m.id === target.id), '应已删除');
  });

  await check('写操作均落审计日志', () => {
    assert.ok(auditCalls > 0, '应至少记录了一次审计');
  });

  console.log('\n通过 ' + passed + ' · 失败 ' + failed);
  server.close();
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); server.close(); process.exit(1); });

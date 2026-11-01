// 复验 RV-02（会话存储故障的统一 503）与 RV-04（合同告警的真实持久化恢复）。
//
// RV-02：生产必需 Redis 断连时，带旧 Cookie 的请求会在 express-session 读取 Store 时抛
//        ClientOfflineError，而这一步早于任何路由守卫 —— 旧实现返回 500。这里用真实
//        express-session + 可注入故障的 Store 复现，断言敏感入口在 Session 之前就被拦成 503，
//        非敏感入口的 Store 异常也映射成 503，重连后恢复，超限仍然是 429。
// RV-04：合同类告警（source_contract）必须登记恢复策略，且只认"同来源同接口、告警之后
//        一次 contract_ok=true 的复验"；普通 HTTP 200（熔断表 last_success_at 刷新）不能顶替。
//        本段用真实 PG 落库与真实 verifyAlertScope 走完整链路。
//
// 运行：node server/test/session-store-and-contract-recovery.test.js（需要隔离测试库）
process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
process.env.PGDATABASE = process.env.PGTESTDATABASE || 'portfolio_test';

const assert = require('assert');
const http = require('http');
const express = require('express');
const session = require('express-session');

const config = require('../config');
const { guardSensitiveSession, isSessionStoreError } = require('../middleware/sessionStoreGuard');
const { requireSessionStore } = require('../middleware/auth');
const { errorHandler } = require('../middleware/errorHandler');
const rateLimit = require('../middleware/rateLimit');
const mailer = require('../services/jobAlertMailer');
const repository = require('../repositories/jobAlertMailerRepository');
const { pool } = require('../db/connection');

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

function storeError(name, message) {
  const error = new Error(message);
  error.name = name;
  return error;
}

// 可注入故障的会话 Store：模拟 connect-redis 在断连/关闭时的抛错行为。
class FlakyStore extends session.Store {
  constructor() {
    super();
    this.data = new Map();
    this.getCalls = 0;
    this.setCalls = 0;
    this.failGet = null;
    this.failSet = null;
  }

  get(sid, callback) {
    this.getCalls += 1;
    if (this.failGet) return callback(this.failGet);
    return callback(null, this.data.get(sid) || null);
  }

  set(sid, sess, callback) {
    this.setCalls += 1;
    if (this.failSet) return callback(this.failSet);
    this.data.set(sid, sess);
    return callback(null);
  }

  destroy(sid, callback) {
    this.data.delete(sid);
    return callback(null);
  }
}

function buildApp(store) {
  const app = express();
  app.use(express.json());
  // 与生产顺序一致：存储守卫 → 会话 → 路由守卫 → 统一错误中间件。
  app.use(guardSensitiveSession);
  app.use(session({
    secret: 'session-store-test-secret',
    store,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' },
  }));
  // 镜像生产 establishSession：显式 regenerate + save，保存失败必须交给统一错误中间件，
  // 不能先回 200 再在 res.end 阶段丢错误（那样客户端拿到的仍是"登录成功"）。
  app.post('/api/login', requireSessionStore, (req, res, next) => {
    if (!req.session || typeof req.session.regenerate !== 'function') {
      req.session.user = 'probe-user';
      return res.json({ ok: true });
    }
    req.session.regenerate(err => {
      if (err) return next(err);
      req.session.user = 'probe-user';
      req.session.save(saveErr => (saveErr ? next(saveErr) : res.json({ ok: true })));
    });
    return undefined;
  });
  app.post('/api/register', requireSessionStore, (req, res) => { res.json({ ok: true }); });
  app.get('/api/me', (req, res) => res.json({ user: req.session.user || null }));
  app.post('/api/limited', rateLimit({ prefix: 'rv02', windowMs: 60000, max: 1, getKey: () => 'k' }), (req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  return app;
}

function request(port, { method = 'POST', path = '/api/login', cookie = null, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port, path, method,
      agent: false, // 每条请求独立连接：上一条错误响应可能已销毁 keep-alive socket
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
    }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch (_) { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, json, text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function sessionCookie(headers) {
  const raw = headers['set-cookie'];
  if (!raw) return null;
  const list = Array.isArray(raw) ? raw : [raw];
  const hit = list.find(item => /^connect\.sid=/.test(item));
  return hit ? hit.split(';')[0] : null;
}

function setRequired(on) {
  if (on) {
    process.env.NODE_ENV = 'production';
    process.env.REDIS_REQUIRED = '1';
  } else {
    process.env.NODE_ENV = 'test';
    process.env.REDIS_REQUIRED = '0';
  }
}

function setClient(client, ready = true) {
  config.redis.ready = ready;
  config.redis.client = client;
}

const healthyClient = () => ({ isReady: true, isOpen: true, eval: async () => 1 });
const offlineClient = () => ({ isReady: false, isOpen: true, eval: async () => { throw storeError('ClientOfflineError', 'The client is closed'); } });

(async () => {
  console.log('RV-02 会话存储故障必须统一 503');
  const store = new FlakyStore();
  const app = buildApp(store);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const envBackup = { NODE_ENV: process.env.NODE_ENV, REDIS_REQUIRED: process.env.REDIS_REQUIRED };

  try {
    setRequired(true);
    let cookie = null;

    await check('存储可用时登录正常，拿到可复用的旧 Cookie', async () => {
      setClient(healthyClient(), true);
      const res = await request(port, { path: '/api/login', body: {} });
      assert.strictEqual(res.status, 200, '存储可用时必须正常登录');
      cookie = sessionCookie(res.headers);
      assert.ok(cookie, '登录成功必须下发会话 Cookie');
    });

    await check('携带旧 Cookie + 存储断连：敏感入口必须 503，且根本不读 Store', async () => {
      setClient(offlineClient(), true);
      const before = store.getCalls;
      const res = await request(port, { path: '/api/login', cookie, body: {} });
      assert.strictEqual(res.status, 503, `必须 503，实际 ${res.status}（旧实现是 500）`);
      assert.strictEqual(store.getCalls, before, '守卫要在 Session 读取之前拦截，不能先去 Store 取会话');
      assert.strictEqual(res.headers['retry-after'], '5', '要给出可重试提示');
    });

    await check('无 Cookie + 存储断连：同样 503（两种请求口径一致）', async () => {
      setClient(offlineClient(), true);
      const res = await request(port, { path: '/api/register', body: {} });
      assert.strictEqual(res.status, 503);
    });

    await check('非敏感入口仍然走到 Store：读取故障映射为 503 而不是 500', async () => {
      setClient(healthyClient(), true);
      store.failGet = storeError('ClientOfflineError', 'The client is closed');
      const before = store.getCalls;
      const res = await request(port, { path: '/api/me', method: 'GET', cookie });
      store.failGet = null;
      assert.strictEqual(store.getCalls, before + 1, '非敏感入口本来就该读会话');
      assert.strictEqual(res.status, 503, `Store 读取故障必须 503，实际 ${res.status}`);
      assert.ok(!/服务器内部错误/.test(res.text), '不能暴露成通用 500 文案');
    });

    await check('重连后旧 Cookie 立即恢复可用（不需要重新登录）', async () => {
      setClient(healthyClient(), true);
      const res = await request(port, { path: '/api/me', method: 'GET', cookie });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json && res.json.user, 'probe-user', '原会话必须仍然有效');
    });

    await check('会话写回故障（保存失败）同样映射为 503', async () => {
      setClient(healthyClient(), true);
      store.failSet = storeError('ClientClosedError', 'The client is closed');
      const res = await request(port, { path: '/api/login', body: {} });
      store.failSet = null;
      assert.strictEqual(res.status, 503, `写回故障必须 503，实际 ${res.status}`);
    });

    await check('超限仍是 429，不被存储故障口径吞成 503', async () => {
      let calls = 0;
      setClient({ isReady: true, isOpen: true, eval: async () => { calls += 1; return calls; } }, true);
      const first = await request(port, { path: '/api/limited' });
      const second = await request(port, { path: '/api/limited' });
      assert.strictEqual(first.status, 200, '第一次在窗口内应放行');
      assert.strictEqual(second.status, 429, '超限必须还是 429');
    });

    await check('Store 故障识别覆盖 ClientOfflineError/ClientClosedError 与消息兜底', async () => {
      assert.strictEqual(isSessionStoreError(storeError('ClientOfflineError', 'x')), true);
      assert.strictEqual(isSessionStoreError(storeError('ClientClosedError', 'x')), true);
      assert.strictEqual(isSessionStoreError(new Error('The client is closed')), true, '只剩 message 时也要认出来');
      assert.strictEqual(isSessionStoreError(new Error('普通业务错误')), false, '普通业务错误不能被误判成 503');
      assert.strictEqual(isSessionStoreError(null), false);
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
    setClient(null, false);
    process.env.NODE_ENV = envBackup.NODE_ENV;
    process.env.REDIS_REQUIRED = envBackup.REDIS_REQUIRED;
  }

  console.log('RV-04 合同告警必须登记策略并按同接口复验证据关闭');

  const SOURCE = 'lixinger_official';
  const API = 'cn.company.fundamental.non_financial';
  const OTHER_API = 'cn.company.fs.non_financial';
  const ALERT_KEY = 'test:source_contract:rv04';
  const alertScopeKey = `${SOURCE}:${API}`;

  const cleanup = async () => {
    await pool.query('DELETE FROM ops.alert_notifications WHERE alert_key=$1', [ALERT_KEY]).catch(() => {});
    await pool.query('DELETE FROM ops.source_contract_verifications WHERE source=$1 AND api_name IN ($2,$3)', [SOURCE, API, OTHER_API]).catch(() => {});
    await pool.query('DELETE FROM ops.external_circuits WHERE source=$1 AND api_name IN ($2,$3)', [SOURCE, API, OTHER_API]).catch(() => {});
  };

  try {
    await cleanup();

    await check('source_contract 已登记恢复策略，不再是"未知类型需人工复核"', async () => {
      assert.ok(mailer.ALERT_EVIDENCE_POLICIES, '策略表应可读');
      const policy = mailer.ALERT_EVIDENCE_POLICIES.source_contract;
      assert.ok(policy, 'source_contract 必须登记进 ALERT_EVIDENCE_POLICIES');
      assert.strictEqual(policy.verifier, 'source_contract_reverify');
      assert.strictEqual(policy.autoResolve, true, '必须允许按证据自动恢复');
      const disposition = mailer.classifyAlertDisposition({ alert_type: 'source_contract', job_code: 'lixinger_live_smoke' }, { recovered: false, reason: 'x' });
      assert.notStrictEqual(disposition.reason, 'unknown_alert_type_requires_manual_review', '不能落到未知类型');
    });

    // 落一条真实告警，并把 last_seen_at 放到过去，才能区分"告警之后的新证据"。
    await repository.insert_ops_alert_notifications([
      ALERT_KEY, 'source_contract', 'critical', 'lixinger_live_smoke', null, 'source_endpoint', alertScopeKey,
      '理杏仁实源合同验证失败', '合同变化：估值指标类型异常',
    ]);
    await pool.query("UPDATE ops.alert_notifications SET last_seen_at = now() - interval '10 minutes' WHERE alert_key=$1", [ALERT_KEY]);
    const alertRow = (await pool.query(
      'SELECT alert_id, alert_key, alert_type, scope_type, scope_key, last_seen_at, job_code FROM ops.alert_notifications WHERE alert_key=$1',
      [ALERT_KEY],
    )).rows[0];
    assert.ok(alertRow, '告警必须真实落库');
    assert.strictEqual(alertRow.alert_type, 'source_contract');

    await check('没有合同复验证据时按证据不足保留，不会被普通熔断成功关掉', async () => {
      const before = await mailer.verifyAlertScope(alertRow);
      assert.strictEqual(before.recovered, false, '没证据不能自动关闭');
      assert.strictEqual(before.reason, 'contract_reverify_evidence_missing');

      // 普通 HTTP 200 的证据：熔断关闭 + last_success_at 晚于告警。
      await pool.query(
        `INSERT INTO ops.external_circuits(source,api_name,token_fingerprint,state,last_success_at,updated_at)
         VALUES($1,$2,'rv04-fp','closed',now(),now())
         ON CONFLICT (source,api_name,token_fingerprint) DO UPDATE SET state='closed', last_success_at=now(), updated_at=now()`,
        [SOURCE, API],
      );
      const withCircuit = await mailer.verifyAlertScope(alertRow);
      assert.strictEqual(withCircuit.recovered, false, '普通 HTTP 200 不能替代合同复验');
    });

    await check('失败的复验（contract_ok=false）同样不能关闭告警', async () => {
      await repository.insert_ops_source_contract_verifications([SOURCE, API, 'CONTRACT_CHANGED', false, '指标类型异常', JSON.stringify({})]);
      const verdict = await mailer.verifyAlertScope(alertRow);
      assert.strictEqual(verdict.recovered, false);
      assert.strictEqual(verdict.reason, 'contract_reverify_not_newer_or_failed');
    });

    await check('别的接口复验成功也不能关这条告警（必须同接口）', async () => {
      await repository.insert_ops_source_contract_verifications([SOURCE, OTHER_API, 'OK', true, '另一个接口正常', JSON.stringify({})]);
      const verdict = await mailer.verifyAlertScope(alertRow);
      assert.strictEqual(verdict.recovered, false, '同来源但不同接口不算恢复证据');
    });

    await check('同接口合同复验成功后才按证据关闭，并留下恢复证据', async () => {
      await repository.insert_ops_source_contract_verifications([SOURCE, API, 'OK', true, '样例正常', JSON.stringify({ sample: { stockCode: '600519' } })]);
      const verdict = await mailer.verifyAlertScope(alertRow);
      assert.strictEqual(verdict.recovered, true, '同接口复验成功必须能关闭');
      assert.ok(Array.isArray(verdict.evidence && verdict.evidence.verifications), '证据里要能看到复验记录');
      const disposition = mailer.classifyAlertDisposition(alertRow, verdict);
      assert.strictEqual(disposition.disposition, 'true_recovery', '应按真实恢复记录');
    });

    await check('告警之后没有新复验时，旧的合同成功记录不能关闭新告警', async () => {
      // 把告警时间推到"最新一条复验之后"。
      await pool.query("UPDATE ops.alert_notifications SET last_seen_at = now() + interval '5 minutes' WHERE alert_key=$1", [ALERT_KEY]);
      const fresh = (await pool.query(
        'SELECT alert_id, alert_type, scope_type, scope_key, last_seen_at, job_code FROM ops.alert_notifications WHERE alert_key=$1',
        [ALERT_KEY],
      )).rows[0];
      const verdict = await mailer.verifyAlertScope(fresh);
      assert.strictEqual(verdict.recovered, false, '必须要求"告警之后"的新复验');
      assert.strictEqual(verdict.reason, 'contract_reverify_not_newer_or_failed');
    });
  } finally {
    await cleanup();
    await pool.end().catch(() => {});
  }

  const failed = cases.filter(item => item[0] === 'FAIL');
  console.log(`\n==== 会话存储与合同恢复结果: ${cases.length - failed.length}/${cases.length} 通过 ====`);
  if (failed.length) {
    failed.forEach(item => console.log('  - ' + item[1]));
    process.exit(1);
  }
  console.log('全部通过 ✅');
  process.exit(0);
})().catch(async error => {
  console.error('session-store-and-contract-recovery.test.js 失败:', (error && error.stack) || error);
  await pool.end().catch(() => {});
  process.exit(1);
});

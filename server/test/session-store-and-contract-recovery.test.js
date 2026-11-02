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
const smoke = require('../scripts/lixingerLiveSmoke');
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
  // Worker 离线告警：按生产 checkWorkerHealth.js 的实际形状使用无 scope 的固定键。
  const WORKER_ALERT_KEY = 'worker:offline';
  const WORKER_ID = 'rv03c-worker-fixture';

  const cleanup = async () => {
    await pool.query('DELETE FROM ops.alert_notifications WHERE alert_key=$1', [ALERT_KEY]).catch(() => {});
    await pool.query('DELETE FROM ops.source_contract_verifications WHERE source=$1 AND api_name IN ($2,$3)', [SOURCE, API, OTHER_API]).catch(() => {});
    await pool.query('DELETE FROM ops.external_circuits WHERE source=$1 AND api_name IN ($2,$3)', [SOURCE, API, OTHER_API]).catch(() => {});
    await pool.query("DELETE FROM ops.alert_notifications WHERE alert_key=$1 OR alert_key LIKE 'worker:recovered:%'", [WORKER_ALERT_KEY]).catch(() => {});
    await pool.query('DELETE FROM ops.worker_heartbeats WHERE worker_id=$1', [WORKER_ID]).catch(() => {});
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
      // last_seen_at_version 是全精度文本，版本守卫必须用它（Date 只有毫秒精度）。
      'SELECT alert_id, alert_key, alert_type, status, scope_type, scope_key, last_seen_at, last_seen_at::text AS last_seen_at_version, job_code FROM ops.alert_notifications WHERE alert_key=$1',
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
      // 复验 RR-03 后原因按"最新一条"区分：最新是失败 → latest_contract_verification_failed。
      assert.strictEqual(verdict.reason, 'latest_contract_verification_failed');
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

    // last_seen_at_version 是全精度文本：版本守卫必须用它（node 的 Date 只有毫秒精度）。
    const loadAlert = async () => (await pool.query(
      `SELECT alert_id, alert_key, alert_type, status, scope_type, scope_key, last_seen_at,
              last_seen_at::text AS last_seen_at_version, job_code
         FROM ops.alert_notifications WHERE alert_key=$1`,
      [ALERT_KEY],
    )).rows[0];

    // 复验 RR-02：空样本（EMPTY_OK）没有验证任何估值字段，不能作为合同恢复证据。
    await check('空样本不算合同验证成功：结构失败 → 空样本仍未恢复 → 有效样本才恢复', async () => {
      await pool.query("UPDATE ops.alert_notifications SET last_seen_at = now() - interval '30 minutes' WHERE alert_key=$1", [ALERT_KEY]);
      await pool.query('DELETE FROM ops.source_contract_verifications WHERE source=$1 AND api_name=$2', [SOURCE, API]);

      await smoke.recordContractVerification({ status: 'CONTRACT_CHANGED', apiName: API, detail: '指标类型异常', code: '600519' });
      let verdict = await mailer.verifyAlertScope(await loadAlert());
      assert.strictEqual(verdict.recovered, false, '结构失败时当然不恢复');

      // 空样本：接口通了但 rows=0，一列字段都没校验
      const emptyRun = await smoke.recordContractVerification({ status: 'EMPTY_OK', apiName: API, detail: '当日无数据', code: '600519' });
      assert.strictEqual(emptyRun.contractOk, false, 'EMPTY_OK 不能算合同验证成功');
      const row = (await pool.query(
        'SELECT status, contract_ok FROM ops.source_contract_verifications WHERE source=$1 AND api_name=$2 ORDER BY checked_at DESC, verification_id DESC LIMIT 1',
        [SOURCE, API],
      )).rows[0];
      assert.strictEqual(row.status, 'EMPTY_OK', '空样本要留证为合法空');
      assert.strictEqual(row.contract_ok, false, '空样本的 contract_ok 必须是 false');

      verdict = await mailer.verifyAlertScope(await loadAlert());
      assert.strictEqual(verdict.recovered, false, '空样本不能关闭结构异常告警');
      assert.strictEqual(verdict.reason, 'latest_contract_verification_failed');

      await smoke.recordContractVerification({ status: 'OK', apiName: API, detail: '样例正常', code: '600519', sample: { stockCode: '600519' } });
      verdict = await mailer.verifyAlertScope(await loadAlert());
      assert.strictEqual(verdict.recovered, true, '有效样本才恢复');
    });

    // 复验 RR-03：同 scope 有更早的成功、但最新一条失败 → 不能恢复。
    await check('较早成功不能掩盖之后的失败（按最新一条判定）', async () => {
      await smoke.recordContractVerification({ status: 'CONTRACT_CHANGED', apiName: API, detail: '接口又变了', code: '600519' });
      const verdict = await mailer.verifyAlertScope(await loadAlert());
      assert.strictEqual(verdict.recovered, false, '最新一条是失败，不能拿更早的成功关闭');
      assert.strictEqual(verdict.reason, 'latest_contract_verification_failed');
      assert.strictEqual(verdict.evidence.latest.status, 'CONTRACT_CHANGED', '证据要给出最新一条');
      assert.ok(verdict.evidence.verifications.length >= 2, '历史成功记录仍保留在证据里，只是不参与判定');
    });

    // 复验 RR-03：判定与关闭之间若又来新失败（last_seen_at 前移），旧判定不能关闭新故障。
    // 这里用显式时间戳构造时序，避免"同一毫秒"导致断言不稳定。
    await check('关闭要核对告警版本：判定后又来新失败则不关闭', async () => {
      const insertVerification = (status, ok, checkedAtAgo) => pool.query(
        `INSERT INTO ops.source_contract_verifications(source,api_name,status,contract_ok,detail,sample,checked_at)
         VALUES($1,$2,$3,$4,'时序构造','{}'::jsonb, now() - ($5 || ' minutes')::interval)`,
        [SOURCE, API, status, ok, String(checkedAtAgo)],
      );

      // 初始：告警 10 分钟前发生，10 分钟内有多次失败，5 分钟前有一次成功。
      await pool.query('DELETE FROM ops.source_contract_verifications WHERE source=$1 AND api_name=$2', [SOURCE, API]);
      await pool.query("UPDATE ops.alert_notifications SET last_seen_at = now() - interval '10 minutes' WHERE alert_key=$1", [ALERT_KEY]);
      await insertVerification('CONTRACT_CHANGED', false, 8);
      await insertVerification('OK', true, 5);

      const snapshot = await loadAlert();
      const verdict = await mailer.verifyAlertScope(snapshot);
      assert.strictEqual(verdict.recovered, true, '最新一条是成功，可恢复');

      // 判定之后又发生一次失败：last_seen_at 前移到 2 分钟前（晚于那次成功）。
      await pool.query("UPDATE ops.alert_notifications SET last_seen_at = now() - interval '2 minutes' WHERE alert_key=$1", [ALERT_KEY]);
      const late = await repository.resolve_alert_with_evidence([snapshot.alert_id, snapshot.last_seen_at_version, null, false]);
      assert.strictEqual(late.rows.length, 0, '版本已变，不能用旧判定关闭新故障');
      assert.notStrictEqual((await loadAlert()).status, 'resolved', '告警必须仍是未关闭状态');

      // 新失败之后的旧成功不能当恢复证据。
      const staleVerdict = await mailer.verifyAlertScope(await loadAlert());
      assert.strictEqual(staleVerdict.recovered, false, '失败之后没有新复验不能恢复');
      assert.strictEqual(staleVerdict.reason, 'contract_reverify_not_newer_than_alert');

      // 再复验一次（当前时刻）：这次才允许关闭，且版本与判定一致。
      await insertVerification('OK', true, 0);
      const fresh = await loadAlert();
      const freshVerdict = await mailer.verifyAlertScope(fresh);
      assert.strictEqual(freshVerdict.recovered, true);
      const evidenceId = freshVerdict.evidence.latest.verification_id;
      // 不带证据 id 时合同类告警不允许关闭（原子语句要求消费的记录仍存在且有效）。
      const noEvidence = await repository.resolve_alert_with_evidence([fresh.alert_id, fresh.last_seen_at_version, null, false]);
      assert.strictEqual(noEvidence.rows.length, 0, '合同告警必须带上被消费的证据 id');
      const done = await repository.resolve_alert_with_evidence([fresh.alert_id, fresh.last_seen_at_version, evidenceId, false]);
      assert.strictEqual(done.rows.length, 1, '版本一致且证据仍有效时才能关闭');
    });

    // 复验 RR-03-A：验证失败已落库、告警 last_seen_at 还没 upsert 的窗口，常规恢复也不能关闭。
    // 走真实服务入口 resolveSourceEndpointAlerts，只在「判定后、写回前」插入新失败，原关闭 SQL 照常执行。
    await check('服务入口屏障：判定后新验证失败已落库（告警未更新）→ 常规恢复关不掉', async () => {
      const realResolve = repository.resolve_alert_with_evidence;
      const envBackup = { NODE_ENV: process.env.NODE_ENV, to: process.env.ALERT_EMAIL_TO };
      process.env.NODE_ENV = 'production';   // 进入服务入口的分支；收件人为空，不会发信
      process.env.ALERT_EMAIL_TO = '';
      try {
        await pool.query('DELETE FROM ops.source_contract_verifications WHERE source=$1 AND api_name=$2', [SOURCE, API]);
        await pool.query("UPDATE ops.alert_notifications SET status='pending', resolved_at=NULL, last_seen_at = now() - interval '10 minutes' WHERE alert_key=$1", [ALERT_KEY]);
        // 判定时会看到的那次成功
        await pool.query(
          `INSERT INTO ops.source_contract_verifications(source,api_name,status,contract_ok,detail,sample,checked_at)
           VALUES($1,$2,'OK',true,'修复后复验','{}'::jsonb, now() - interval '5 minutes')`, [SOURCE, API],
        );

        const before = await loadAlert();
        assert.strictEqual((await mailer.verifyAlertScope(before)).recovered, true, '前置：当前确实判定为可恢复');

        // 注入点：判定之后、写回之前，新的合同失败落库；告警 last_seen_at 故意不更新。
        let injected = false;
        repository.resolve_alert_with_evidence = async (params, client) => {
          if (!injected) {
            injected = true;
            await pool.query(
              `INSERT INTO ops.source_contract_verifications(source,api_name,status,contract_ok,detail,sample,checked_at)
               VALUES($1,$2,'CONTRACT_CHANGED',false,'判定后新失败','{}'::jsonb, now())`, [SOURCE, API],
            );
          }
          return realResolve(params, client);
        };

        const resolved = await mailer.resolveSourceEndpointAlerts(SOURCE, API);
        assert.strictEqual(injected, true, '注入点必须被真实关闭路径触发');
        assert.strictEqual(resolved, 0, '证据已失效时不得关闭');

        repository.resolve_alert_with_evidence = realResolve;
        const after = await loadAlert();
        assert.strictEqual(after.status, 'pending', '告警必须仍未关闭');
        assert.strictEqual((await mailer.verifyAlertScope(after)).recovered, false, '最新一条已是失败');
      } finally {
        repository.resolve_alert_with_evidence = realResolve;
        process.env.NODE_ENV = envBackup.NODE_ENV;
        if (envBackup.to === undefined) delete process.env.ALERT_EMAIL_TO; else process.env.ALERT_EMAIL_TO = envBackup.to;
      }
    });

    // 复验 RR-03-B：历史扫描入口同样不能绕过版本/证据约束。
    await check('历史扫描入口：判定后新失败且告警版本推进 → 仍不得关闭', async () => {
      const realResolve = repository.resolve_alert_with_evidence;
      const envBackup = { NODE_ENV: process.env.NODE_ENV, to: process.env.ALERT_EMAIL_TO };
      process.env.NODE_ENV = 'production';
      process.env.ALERT_EMAIL_TO = '';
      try {
        // 历史扫描取候选按到期轮转：清掉其它活动告警，保证只扫到本用例这条。
        await pool.query("DELETE FROM ops.alert_notifications WHERE alert_key <> $1", [ALERT_KEY]);
        await pool.query('DELETE FROM ops.source_contract_verifications WHERE source=$1 AND api_name=$2', [SOURCE, API]);
        await pool.query(
          "UPDATE ops.alert_notifications SET status='pending', resolved_at=NULL, last_checked_at=NULL, next_check_at=NULL, last_seen_at = now() - interval '10 minutes' WHERE alert_key=$1",
          [ALERT_KEY],
        );
        await pool.query(
          `INSERT INTO ops.source_contract_verifications(source,api_name,status,contract_ok,detail,sample,checked_at)
           VALUES($1,$2,'OK',true,'历史扫描前的成功','{}'::jsonb, now() - interval '5 minutes')`, [SOURCE, API],
        );

        let injected = false;
        repository.resolve_alert_with_evidence = async (params, client) => {
          if (!injected) {
            injected = true;
            // 同时：新失败落库 + 告警版本推进（真实扫描里 upsert 与判定可能交错）
            await pool.query(
              `INSERT INTO ops.source_contract_verifications(source,api_name,status,contract_ok,detail,sample,checked_at)
               VALUES($1,$2,'CONTRACT_CHANGED',false,'扫描判定后新失败','{}'::jsonb, now())`, [SOURCE, API],
            );
            await pool.query("UPDATE ops.alert_notifications SET last_seen_at = now() - interval '1 minute' WHERE alert_key=$1", [ALERT_KEY]);
          }
          return realResolve(params, client);
        };

        const result = await mailer.reconcileHistoricalAlerts(1);
        assert.strictEqual(injected, true, '历史扫描必须走到关闭语句');
        assert.strictEqual(result.resolved, 0, '历史扫描同样不得在证据失效后关闭');
        repository.resolve_alert_with_evidence = realResolve;
        assert.strictEqual((await loadAlert()).status, 'pending', '告警必须仍未关闭');
      } finally {
        repository.resolve_alert_with_evidence = realResolve;
        process.env.NODE_ENV = envBackup.NODE_ENV;
        if (envBackup.to === undefined) delete process.env.ALERT_EMAIL_TO; else process.env.ALERT_EMAIL_TO = envBackup.to;
      }
    });

    await check('告警之后没有新复验时，旧的合同成功记录不能关闭新告警', async () => {
      // 自包含：先清掉前面用例留下的验证记录，只留一条"更早的成功"，再把告警时间推后。
      await pool.query('DELETE FROM ops.source_contract_verifications WHERE source=$1 AND api_name=$2', [SOURCE, API]);
      await pool.query(
        `INSERT INTO ops.source_contract_verifications(source,api_name,status,contract_ok,detail,sample,checked_at)
         VALUES($1,$2,'OK',true,'更早的成功','{}'::jsonb, now() - interval '6 minutes')`, [SOURCE, API],
      );
      await pool.query("UPDATE ops.alert_notifications SET status='pending', resolved_at=NULL, last_seen_at = now() + interval '5 minutes' WHERE alert_key=$1", [ALERT_KEY]);
      const fresh = (await pool.query(
        'SELECT alert_id, alert_type, scope_type, scope_key, last_seen_at, job_code FROM ops.alert_notifications WHERE alert_key=$1',
        [ALERT_KEY],
      )).rows[0];
      const verdict = await mailer.verifyAlertScope(fresh);
      assert.strictEqual(verdict.recovered, false, '必须要求"告警之后"的新复验');
      assert.strictEqual(verdict.reason, 'contract_reverify_not_newer_than_alert');
    });

    // ===== 复验 RR-03-C：Worker 离线告警的恢复证据时序 =====
    // 生产入口是 server/scripts/checkWorkerHealth.js:51 的 resolveWorkerOfflineAlert。
    // 这里全部走真实服务入口与真实关闭 SQL，只在仓储读取边界注入时序，断言的是入口返回值与落库状态。
    const loadWorkerAlert = async () => (await pool.query(
      `SELECT alert_id, alert_type, status, resolved_at, occurrence_count,
              last_seen_at, last_seen_at::text AS last_seen_at_version
         FROM ops.alert_notifications WHERE alert_key=$1`,
      [WORKER_ALERT_KEY],
    )).rows[0];

    // 落一条与生产同形状的 worker:offline 告警，并把 last_seen_at 放到指定秒数之前。
    const seedWorkerAlert = async (secondsAgo) => {
      await repository.insert_ops_alert_notifications([
        WORKER_ALERT_KEY, 'worker_offline', 'critical', null, null, null, null,
        '后台 Worker 已离线', '最近2分钟没有收到 Worker 心跳，后台定时任务可能无法执行。',
      ]);
      await pool.query(
        `UPDATE ops.alert_notifications
            SET status='pending', resolved_at=NULL, acknowledged_at=NULL, sending_started_at=NULL,
                last_seen_at = now() - ($1 || ' seconds')::interval
          WHERE alert_key=$2`, [String(secondsAgo), WORKER_ALERT_KEY],
      );
      return loadWorkerAlert();
    };

    const seedHeartbeat = async (secondsAgo, status = 'running') => {
      await pool.query(
        `INSERT INTO ops.worker_heartbeats(worker_id, role, status, last_seen_at, updated_at)
         VALUES($1,'worker',$2, now() - ($3 || ' seconds')::interval, now())
         ON CONFLICT (worker_id) DO UPDATE
           SET role='worker', status=EXCLUDED.status, last_seen_at=EXCLUDED.last_seen_at, updated_at=now()`,
        [WORKER_ID, status, String(secondsAgo)],
      );
    };

    const recoveryNotices = async () => (await pool.query(
      "SELECT alert_id, status FROM ops.alert_notifications WHERE alert_key LIKE 'worker:recovered:%'",
    )).rows;

    // 只让 NODE_ENV 进入生产分支以走服务入口；收件人为空，绝不发信。
    const withProductionEnv = async (fn) => {
      const backup = { NODE_ENV: process.env.NODE_ENV, to: process.env.ALERT_EMAIL_TO };
      process.env.NODE_ENV = 'production';
      process.env.ALERT_EMAIL_TO = '';
      try {
        return await fn();
      } finally {
        process.env.NODE_ENV = backup.NODE_ENV;
        if (backup.to === undefined) delete process.env.ALERT_EMAIL_TO; else process.env.ALERT_EMAIL_TO = backup.to;
      }
    };

    await check('Worker 离线告警：故障之前的在线心跳不能关闭新故障（服务入口）', async () => {
      await pool.query("DELETE FROM ops.alert_notifications WHERE alert_key LIKE 'worker:recovered:%'");
      // 心跳在 30 秒前（仍在 2 分钟在线窗口内），告警 last_seen_at 在 5 秒前：
      // 这条在线证据发生在故障之前，不是这条故障的恢复证据。
      await seedHeartbeat(30);
      const alert = await seedWorkerAlert(5);
      assert.strictEqual((await repository.select_ops_worker_heartbeats()).rows.length, 1,
        '前置：2 分钟窗口内确实有在线心跳（旧实现会据此关闭）');

      const resolved = await withProductionEnv(() => mailer.resolveWorkerOfflineAlert(alert.alert_id));
      assert.strictEqual(resolved, 0, '心跳早于告警 last_seen_at 时不得关闭');
      const after = await loadWorkerAlert();
      assert.strictEqual(after.status, 'pending', '告警必须仍未关闭');
      assert.strictEqual(after.resolved_at, null, '不得写关闭时间');
      assert.strictEqual((await recoveryNotices()).length, 0, '没关闭就不能发恢复通知');
    });

    await check('Worker 离线告警：读完在线心跳后又落新故障 → 不关闭（并发时序）', async () => {
      await pool.query("DELETE FROM ops.alert_notifications WHERE alert_key LIKE 'worker:recovered:%'");
      await seedHeartbeat(1);
      const alert = await seedWorkerAlert(600);
      assert.strictEqual((await repository.select_ops_worker_heartbeats([alert.last_seen_at_version])).rows.length, 1,
        '前置：此刻心跳晚于告警，按当前证据本来可以恢复');

      const realHeartbeats = repository.select_ops_worker_heartbeats;
      let injected = false;
      repository.select_ops_worker_heartbeats = async (params, client) => {
        const result = await realHeartbeats(params, client);
        if (!injected) {
          injected = true;
          // 读完在线证据、关闭写回之前，健康检查又记录了一次离线故障（last_seen_at 前移）。
          await repository.insert_ops_alert_notifications([
            WORKER_ALERT_KEY, 'worker_offline', 'critical', null, null, null, null,
            '后台 Worker 已离线', '最近2分钟没有收到 Worker 心跳，后台定时任务可能无法执行。',
          ]);
        }
        return result;
      };
      try {
        const resolved = await withProductionEnv(() => mailer.resolveWorkerOfflineAlert(alert.alert_id));
        assert.strictEqual(injected, true, '注入点必须被服务入口真实触发');
        assert.strictEqual(resolved, 0, '心跳读取之后的新故障不得被旧心跳关闭');
        const after = await loadWorkerAlert();
        assert.strictEqual(after.status, 'pending', '告警必须仍未关闭');
        assert.strictEqual(after.occurrence_count, alert.occurrence_count + 1, '新故障确实又记了一次');
      } finally {
        repository.select_ops_worker_heartbeats = realHeartbeats;
      }
    });

    await check('Worker 离线告警：故障之后的在线心跳可以关闭并发出恢复通知', async () => {
      await pool.query("DELETE FROM ops.alert_notifications WHERE alert_key LIKE 'worker:recovered:%'");
      await seedHeartbeat(1);
      const alert = await seedWorkerAlert(600);
      const resolved = await withProductionEnv(() => mailer.resolveWorkerOfflineAlert(alert.alert_id));
      assert.strictEqual(resolved, 1, '心跳晚于故障时可以关闭');
      const after = await loadWorkerAlert();
      assert.strictEqual(after.status, 'resolved');
      assert.ok(after.resolved_at instanceof Date, '关闭要记录时间');
      const notices = await recoveryNotices();
      assert.strictEqual(notices.length, 1, '关闭后必须留一条恢复通知记录');
      assert.strictEqual(notices[0].alert_id !== undefined, true);
    });

    await check('Worker 离线告警：没有窗口内在线心跳时不关闭、不发恢复通知', async () => {
      await pool.query("DELETE FROM ops.alert_notifications WHERE alert_key LIKE 'worker:recovered:%'");
      await seedHeartbeat(600);   // 心跳在 2 分钟窗口之外，Worker 事实上离线
      const alert = await seedWorkerAlert(600);
      const resolved = await withProductionEnv(() => mailer.resolveWorkerOfflineAlert(alert.alert_id));
      assert.strictEqual(resolved, 0, '没有在线心跳就不能关闭');
      assert.strictEqual((await loadWorkerAlert()).status, 'pending');
      assert.strictEqual((await recoveryNotices()).length, 0, '不得凭空发恢复通知');
    });

    await check('关闭语句自身复核心跳：绕过服务入口也不能用旧心跳关闭', async () => {
      await seedHeartbeat(30);
      const alert = await seedWorkerAlert(5);
      // 其它关闭入口（如历史扫描）同样走这条语句，协议必须自己兜住，不能只靠服务层顺序。
      const direct = await repository.resolve_alert_with_evidence([
        alert.alert_id, alert.last_seen_at_version, null, false,
      ]);
      assert.strictEqual(direct.rows.length, 0, '关闭 SQL 自己就要拒绝早于故障的心跳');
      assert.strictEqual((await loadWorkerAlert()).status, 'pending', '告警必须仍未关闭');
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

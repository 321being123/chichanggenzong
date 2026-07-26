const assert = require('assert');

let matchedUser = { username: 'alice', email: 'alice@example.com', status: 'active' };
let changedPassword = null;
let sentMail = null;

const dbPath = require.resolve('../db');
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    getUserForPasswordReset: async () => matchedUser,
    changePassword: async (username, hash) => { changedPassword = { username, hash }; },
    hashPwd: (password) => 'hashed:' + password,
    getConfig: async (_key, fallback) => fallback,
    pool: { query: async () => ({ rows: [] }) }
  }
};

const configPath = require.resolve('../config');
require.cache[configPath] = {
  id: configPath,
  filename: configPath,
  loaded: true,
  exports: {
    REGISTER_CODE: '',
    mailer: {
      sendMail: async (message) => {
        sentMail = message;
      }
    },
    redis: { ready: false, client: null }
  }
};

const router = require('../routes/auth');

async function invoke(path, body, session = {}) {
  const layer = router.stack.find(item => item.route && item.route.path === path);
  assert.ok(layer, '未找到路由：' + path);

  const req = { body, session, ip: '127.0.0.1', connection: {} };
  const response = { status: 200, body: undefined };
  const res = {
    status(code) { response.status = code; return this; },
    json(payload) { response.body = payload; return this; }
  };

  for (const middleware of layer.route.stack) {
    let shouldContinue = false;
    await new Promise((resolve, reject) => {
      const next = (error) => {
        if (error) return reject(error);
        shouldContinue = true;
        resolve();
      };
      Promise.resolve(middleware.handle(req, res, next)).then(resolve, reject);
    });
    if (!shouldContinue) break;
  }

  return { req, response };
}

async function run() {
  const session = {};
  sentMail = null;
  const sent = await invoke('/forgot-password/send-code', {
    username: 'alice',
    email: 'Alice@Example.com'
  }, session);
  assert.strictEqual(sent.response.status, 200);
  assert.deepStrictEqual(sent.response.body, { ok: true });
  assert.ok(sentMail, '匹配账号应发送邮件');
  assert.strictEqual(sentMail.to, 'alice@example.com');
  assert.ok(session.passwordResetCode, '应保存独立的重置验证码会话');
  assert.strictEqual(session.passwordResetCode.username, 'alice');
  assert.strictEqual(session.passwordResetCode.email, 'alice@example.com');
  assert.match(session.passwordResetCode.code, /^\d{6}$/);

  changedPassword = null;
  const reset = await invoke('/forgot-password/reset', {
    username: 'alice',
    email: 'ALICE@example.com',
    emailCode: session.passwordResetCode.code,
    newPassword: 'new-secret'
  }, session);
  assert.strictEqual(reset.response.status, 200);
  assert.deepStrictEqual(reset.response.body, { ok: true });
  assert.deepStrictEqual(changedPassword, { username: 'alice', hash: 'hashed:new-secret' });
  assert.strictEqual(session.passwordResetCode, undefined, '成功后必须销毁验证码');

  const wrongSession = {
    passwordResetCode: {
      username: 'alice',
      email: 'alice@example.com',
      code: '123456',
      expires: Date.now() + 60000,
      attempts: 0
    }
  };
  changedPassword = null;
  const wrong = await invoke('/forgot-password/reset', {
    username: 'alice',
    email: 'alice@example.com',
    emailCode: '654321',
    newPassword: 'new-secret'
  }, wrongSession);
  assert.strictEqual(wrong.response.status, 400);
  assert.strictEqual(wrongSession.passwordResetCode.attempts, 1);
  assert.strictEqual(changedPassword, null, '验证码错误时不能改密');

  matchedUser = null;
  sentMail = null;
  const unknown = await invoke('/forgot-password/send-code', {
    username: 'unknown',
    email: 'unknown@example.com'
  }, {});
  assert.strictEqual(unknown.response.status, 200);
  assert.deepStrictEqual(unknown.response.body, { ok: true });
  assert.strictEqual(sentMail, null, '账号与邮箱不匹配时不能发送邮件');

  console.log('[PASS] 忘记密码：邮箱验证、重置密码、错误码拦截与账号防枚举');
}

run().catch(error => {
  console.error('[FAIL] ' + error.stack);
  process.exit(1);
});

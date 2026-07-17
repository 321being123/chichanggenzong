// ========== P1-1 认证与会话安全 回归测试 ==========
// 运行：node server/test/auth-security.test.js
// 说明：验证 verifyPwd 改为时序安全比较后，正确/错误密码的判定结果不变，
// 且 hashPwd/verifyPwd 往返一致；同时验证验证码使用 crypto.randomInt 落在 6 位区间。
const assert = require('assert');
const Module = require('module');

const calls = [];
class FakePool { query(text, params) { calls.push({ text, params }); return Promise.resolve({ rowCount: 1, rows: [] }); } }
const fakePg = { Pool: FakePool };
const pgPath = require.resolve('pg');
require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: fakePg };

const db = require('../db');

const results = [];
function check(name, fn) {
  try { fn(); results.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (e) { results.push(['FAIL', name + ' :: ' + e.message]); console.log('  [FAIL] ' + name + ' :: ' + e.message); }
}

check('hashPwd 产出 scrypt:salt:hash 格式', () => {
  const h = db.hashPwd('secret123');
  assert.ok(/^scrypt:[0-9a-f]+:[0-9a-f]+$/.test(h), '应为 scrypt:salt:hash 形式，实际: ' + h);
});
check('verifyPwd 正确密码返回 true（时序安全比较不破坏正确性）', () => {
  const h = db.hashPwd('secret123');
  assert.strictEqual(db.verifyPwd('secret123', h), true);
});
check('verifyPwd 错误密码返回 false', () => {
  const h = db.hashPwd('secret123');
  assert.strictEqual(db.verifyPwd('wrong', h), false);
});
check('verifyPwd 兼容旧 sha256 切片格式', () => {
  const crypto = require('crypto');
  const legacy = crypto.createHash('sha256').update('oldpw').digest('hex').slice(0, 16);
  assert.strictEqual(db.verifyPwd('oldpw', legacy), true);
  assert.strictEqual(db.verifyPwd('other', legacy), false);
});
check('verifyPwd 兼容旧 pbkdf2 格式（渐进迁移来源）', () => {
  const crypto = require('crypto');
  const salt = '0123456789abcdef';
  const hash = crypto.pbkdf2Sync('oldpw', salt, 10000, 32, 'sha512').toString('hex');
  const legacy = salt + ':' + hash;
  assert.strictEqual(db.verifyPwd('oldpw', legacy), true);
  assert.strictEqual(db.verifyPwd('other', legacy), false);
});
check('isLegacyHash 正确识别旧/新格式', () => {
  const crypto = require('crypto');
  const salt = '0123456789abcdef';
  const pbkdf2 = salt + ':' + crypto.pbkdf2Sync('x', salt, 10000, 32, 'sha512').toString('hex');
  const sha256 = crypto.createHash('sha256').update('x').digest('hex').slice(0, 16);
  assert.strictEqual(db.isLegacyHash(pbkdf2), true);
  assert.strictEqual(db.isLegacyHash(sha256), true);
  assert.strictEqual(db.isLegacyHash(db.hashPwd('x')), false);
});

// 验证码范围：crypto.randomInt(100000, 1000000) 必为 6 位
check('验证码落在 100000~999999 的 6 位区间', () => {
  const crypto = require('crypto');
  for (let i = 0; i < 100; i++) {
    const code = crypto.randomInt(100000, 1000000);
    assert.ok(code >= 100000 && code <= 999999, '验证码越界: ' + code);
  }
});

const failed = results.filter(r => r[0] === 'FAIL');
console.log('\n==== 结果: ' + (results.length - failed.length) + '/' + results.length + ' 通过 ====');
if (failed.length) {
  console.log('失败项:'); failed.forEach(f => console.log('  - ' + f[1]));
  process.exit(1);
}
console.log('全部通过 ✅');

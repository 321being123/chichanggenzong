// CREDENTIAL-AUTH-RECOVERY-001：只有合法业务响应能触发凭据级恢复，不借 HTTP 200 放行。
const assert = require('assert');
const { EventEmitter } = require('events');
const https = require('https');
const original = https.request;
const recovered = [], denied = [];
function stub(path, exports) {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
stub('../services/externalApiConfig', { getProviderRuntime: async () => ({ primary: 'fake-token', backup: '', mode: 'primary' }) });
stub('../services/sourceEndpointPolicy', {
  recoverCredentialAuthentication: async (...args) => { recovered.push(args); },
  recordEndpointPermission: async (...args) => { denied.push(args); },
});
stub('../services/externalCallGuard', {
  tokenFingerprint: () => 'fingerprint',
  withExternalCallGuard: async (_source, _dataset, _date, fn) => fn({}, { requestStartedAt: '2026-11-17T00:00:00Z' }),
  closeExternalCircuit: async () => {}, releaseExternalCircuitProbe: async () => {}, openExternalCircuit: async () => {},
});
let payload;
https.request = (_url, _options, callback) => {
  const request = new EventEmitter(); request.write = () => {}; request.destroy = () => {};
  request.end = () => {
    const response = new EventEmitter(); response.statusCode = 200; response.setEncoding = () => {};
    callback(response); response.emit('data', JSON.stringify(payload)); response.emit('end');
  };
  return request;
};
(async () => {
  const { tushareQuery } = require('../services/tushare');
  try {
    payload = { code: 0, data: { fields: ['close'], items: [[1]] } };
    await tushareQuery('daily', {}, 'close');
    assert.strictEqual(recovered.length, 1);
    assert.deepStrictEqual(recovered[0].slice(0, 4), ['tushare', 'primary', 'fingerprint', '2026-11-17T00:00:00Z']);
    payload = { code: 0, data: { fields: ['close'], items: [] } };
    await assert.rejects(tushareQuery('daily', {}, 'close'), e => e.code === 'EMPTY_DATA');
    assert.strictEqual(recovered.length, 2, '认证成功的空数据可恢复凭据，但数据集仍须失败');
    payload = { code: 0, data: { fields: ['close'], items: [[1, 2]] } };
    await assert.rejects(tushareQuery('daily', {}, 'close'), e => e.code === 'INVALID_RESPONSE');
    assert.strictEqual(recovered.length, 2, '结构错误不得恢复');
    payload = { code: 2002, msg: '无权限' };
    await assert.rejects(tushareQuery('daily', {}, 'close'), e => e.code === 'PERMISSION_DENIED');
    assert.strictEqual(recovered.length, 2, '接口权限拒绝不得恢复');
    assert.strictEqual(denied[0][2], 'daily', '接口拒绝只标记该接口');
    payload = { code: -1, msg: '您的token不对，请确认。' };
    await assert.rejects(tushareQuery('daily', {}, 'close'), e => e.code === 'AUTH_ERROR');
    assert.strictEqual(denied[1][2], '*', '明确 Token 错误应记为凭据级认证失败');
    assert.strictEqual(recovered.length, 2, '认证失败不得恢复');
    console.log('tushare verified credential evidence passed');
  } finally { https.request = original; }
})().catch(error => { console.error(error); process.exitCode = 1; });

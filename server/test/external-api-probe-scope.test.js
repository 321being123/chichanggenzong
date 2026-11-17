// CREDENTIAL-AUTH-RECOVERY-001：管理探测不能将本地阻断误记为上游成功或接口权限事实。
const assert = require('assert');
function stub(path, exports) {
  const id = require.resolve(path); require.cache[id] = { id, filename: id, loaded: true, exports };
}
let mode = 'blocked';
const records = [], recoveries = [];
let store = '';
stub('../db/config', { getConfig: async () => store, setConfig: async (_key, value) => { store = value; } });
stub('../services/sourceEndpointPolicy', {
  listSourceEndpointPolicies: async () => [], syncCredentialFingerprint: async () => {},
  recordEndpointPermission: async (...args) => records.push(args),
  recoverCredentialAuthentication: async (...args) => recoveries.push(args),
});
stub('../services/externalCallGuard', {
  tokenFingerprint: () => 'test-fingerprint',
  withExternalCallGuard: async (_source, _dataset, _date, fn) => {
    if (mode === 'blocked') { const e = new Error('local policy'); e.code = 'POLICY_DISABLED'; throw e; }
    return fn({}, { requestStartedAt: '2026-11-17T00:00:00Z' });
  },
});
stub('../services/tushareHealthSource', {
  normalizeReturnedData: () => null,
  readTushareHealth: async () => {
    if (['auth', 'permission', 'network', 'rate'].includes(mode)) {
      const e = new Error(mode === 'auth' ? 'token invalid' : 'request failed');
      e.code = ({ auth: 'AUTH_ERROR', permission: 'PERMISSION_DENIED', network: 'NETWORK_ERROR', rate: 'RATE_LIMIT' })[mode]; throw e;
    }
    return { data_count: 1 };
  },
});
const oldToken = process.env.TUSHARE_TOKEN;
process.env.TUSHARE_TOKEN = 'fake-token';
(async () => {
  try {
    const { testProviderAvailability } = require('../services/externalApiConfig');
    let result = await testProviderAvailability('tushare', 'primary', 'daily');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(records.length, 0, '本地策略阻断不应新建或启用接口策略');
    mode = 'network'; result = await testProviderAvailability('tushare', 'primary', 'daily');
    assert.strictEqual(result.status, 'error');
    assert.strictEqual(records.length, 0, '网络失败不应创建启用策略');
    mode = 'rate'; result = await testProviderAvailability('tushare', 'primary', 'daily');
    assert.strictEqual(result.status, 'rate_limited');
    assert.strictEqual(records.length, 0, '限流由熔断处理，不能创建权限策略');
    mode = 'auth'; result = await testProviderAvailability('tushare', 'primary', 'daily');
    assert.strictEqual(result.status, 'permission_denied');
    assert.strictEqual(records[0][2], '*', '认证失败归属于凭据，不归属于单接口');
    assert.match(records[0][4].message, /^AUTH_ERROR:/);
    mode = 'permission'; result = await testProviderAvailability('tushare', 'primary', 'daily');
    assert.strictEqual(result.status, 'permission_denied');
    assert.strictEqual(records[1][2], 'daily', '接口无权限只标记对应接口');
    mode = 'success'; result = await testProviderAvailability('tushare', 'primary', 'daily');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(recoveries.length, 1);
    assert.deepStrictEqual(recoveries[0].slice(0, 4), ['tushare', 'primary', 'test-fingerprint', '2026-11-17T00:00:00Z']);
    console.log('external API probe scope passed');
  } finally {
    if (oldToken === undefined) delete process.env.TUSHARE_TOKEN; else process.env.TUSHARE_TOKEN = oldToken;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

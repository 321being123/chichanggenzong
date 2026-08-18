const assert = require('assert');
const { EventEmitter } = require('events');
const https = require('https');
const { getConfig, setConfig } = require('../db/config');
const guard = require('../services/externalCallGuard');

const originalRequest = https.request;
const originalToken = process.env.TUSHARE_TOKEN;
const originalBackupToken = process.env.TUSHARE_BACKUP_TOKEN;
const originalTokenMode = process.env.TUSHARE_TOKEN_MODE;

(async () => {
  const originalExternalApiConfig = await getConfig('external_api_configs', '');
  try {
    delete process.env.TUSHARE_TOKEN;
    delete process.env.TUSHARE_BACKUP_TOKEN;
    delete process.env.TUSHARE_TOKEN_MODE;
    await setConfig('external_api_configs', '');
    await guard.resetExternalCallGuardPersistence('tushare');
    await guard.resetExternalCallGuardPersistence('tushare_backup');
    delete require.cache[require.resolve('../services/tushare')];
    let called = false;
    https.request = () => { called = true; throw new Error('不应发起请求'); };
    let client = require('../services/tushare');
    await assert.rejects(
      () => client.tushareQuery('trade_cal'),
      error => error.code === 'AUTH_ERROR' && error.errorType === 'permission' && error.retryable === false
    );
    assert.strictEqual(called, false);

    process.env.TUSHARE_TOKEN = 'test-token-not-real';
    let capturedOptions;
    let capturedBody = '';
    https.request = (url, options, callback) => {
      assert.strictEqual(url, 'https://api.tushare.pro');
      capturedOptions = options;
      const request = new EventEmitter();
      request.write = chunk => { capturedBody += chunk; };
      request.end = () => {
        const response = new EventEmitter();
        response.statusCode = 200;
        response.setEncoding = () => {};
        callback(response);
        response.emit('data', JSON.stringify({
          code: 0,
          data: { fields: ['cal_date', 'is_open'], items: [['20260812', '1']] },
        }));
        response.emit('end');
      };
      request.destroy = () => {};
      return request;
    };

    delete require.cache[require.resolve('../services/tushare')];
    client = require('../services/tushare');
    const result = await client.tushareQuery(
      'trade_cal',
      { exchange: 'SSE', start_date: '20260812', end_date: '20260812' },
      'cal_date,is_open'
    );
    const payload = JSON.parse(capturedBody);
    assert.strictEqual(capturedOptions.method, 'POST');
    assert.strictEqual(capturedOptions.headers['Content-Type'], 'application/json');
    assert.strictEqual(payload.api_name, 'trade_cal');
    assert.strictEqual(payload.token, 'test-token-not-real');
    assert.deepStrictEqual(payload.params, { exchange: 'SSE', start_date: '20260812', end_date: '20260812' });
    assert.strictEqual(payload.fields, 'cal_date,is_open');
    assert.deepStrictEqual(result, { fields: ['cal_date', 'is_open'], items: [['20260812', '1']] });
    console.log('tushare official client tests passed');
  } finally {
    https.request = originalRequest;
    if (originalToken === undefined) delete process.env.TUSHARE_TOKEN;
    else process.env.TUSHARE_TOKEN = originalToken;
    if (originalBackupToken === undefined) delete process.env.TUSHARE_BACKUP_TOKEN;
    else process.env.TUSHARE_BACKUP_TOKEN = originalBackupToken;
    if (originalTokenMode === undefined) delete process.env.TUSHARE_TOKEN_MODE;
    else process.env.TUSHARE_TOKEN_MODE = originalTokenMode;
    await setConfig('external_api_configs', originalExternalApiConfig);
    if (require.cache[require.resolve('../db/connection')]) await require('../db/connection').pool.end();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

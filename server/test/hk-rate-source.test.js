const assert = require('assert');
const { EventEmitter } = require('events');
const https = require('https');
const guard = require('../services/externalCallGuard');
const originalGet = https.get, originalGuard = guard.withExternalCallGuard;
let status = 200, body = '', guardCalls = [], requests = [];
guard.withExternalCallGuard = async (source, key, date, fn, options) => { guardCalls.push({ source, key, options }); return fn(); };
https.get = (url, options, callback) => {
  requests.push({ url, options });
  const response = new EventEmitter(); response.statusCode = status;
  callback(response); process.nextTick(() => { response.emit('data', body); response.emit('end'); });
  const req = new EventEmitter(); req.destroy = () => {}; return req;
};
const source = require('../services/hkRateSource');
(async () => {
  try {
    body = '{"result":"success"}';
    assert.strictEqual(await source.fetchDailyText(), body);
    assert.strictEqual(guardCalls[0].options.apiName, 'exchange_rate');
    assert.ok(requests[0].url.includes('open.er-api.com'));
    body = '<html>ok</html>';
    assert.strictEqual(await source.fetchRealtimeText('exchange_rate_realtime'), body);
    assert.strictEqual(guardCalls[1].options.apiName, 'exchange_rate_realtime');
    assert.ok(requests[1].url.includes('finance.yahoo.co.jp'));
    status = 429;
    await assert.rejects(source.fetchRealtimeText('exchange_rate_realtime'), error => error.code === 'RATE_LIMIT' && error.apiName === 'exchange_rate_realtime');
    console.log('HK rate source: guarded endpoints, parameters and rate limiting passed');
  } finally { https.get = originalGet; guard.withExternalCallGuard = originalGuard; }
})().catch(error => { console.error(error); process.exitCode = 1; });

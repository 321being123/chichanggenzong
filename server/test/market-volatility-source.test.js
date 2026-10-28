const assert = require('assert');
const { EventEmitter } = require('events');
const https = require('https');
const guard = require('../services/externalCallGuard');
const originalGet = https.get, originalRequest = https.request, originalGuard = guard.withExternalCallGuard;
const calls = [];
guard.withExternalCallGuard = async (source, dataset, day, fn) => { calls.push({ source, dataset, day }); return fn(); };
function response(status, content) {
  const result = new EventEmitter(); result.statusCode = status;
  process.nextTick(() => { result.emit('data', Buffer.from(content)); result.emit('end'); });
  return result;
}
https.get = (url, options, callback) => {
  calls.push({ url, options });
  callback(response(200, url.includes('indexCsiDsPe') ? '{"success":true,"data":[]}' : 'xlsx'));
  const req = new EventEmitter(); req.destroy = () => {}; return req;
};
https.request = (url, options, callback) => {
  calls.push({ url, options });
  const req = new EventEmitter(); req.end = () => callback(response(200, '[{"tenYear":"2.5"}]')); return req;
};
const adapter = require('../services/marketVolatilitySource');
(async () => {
  try {
    const china = await adapter.fetchChinaYield('2026-01-01', '2026-01-31');
    assert.strictEqual(china[0].tenYear, '2.5');
    assert.strictEqual(calls[0].source, 'chinabond');
    assert.strictEqual(calls[0].dataset, 'yield:2026-01-01:2026-01-31');
    assert.strictEqual(calls[1].options.method, 'POST');
    const csi = await adapter.fetchCsiPe('CSI300', '000300');
    assert.strictEqual(csi.success, true);
    assert.strictEqual(calls[2].dataset, 'pe:CSI300:000300');
    assert.ok(calls[3].url.endsWith('indexCode=000300'));
    const hsi = await adapter.fetchHsiPe();
    assert.strictEqual(hsi.toString(), 'xlsx');
    assert.strictEqual(calls[4].dataset, 'monthly-pe');
    assert.ok(calls[5].url.endsWith('/hsi.xlsx'));
    console.log('market volatility source: guarded paths, parameters and response types passed');
  } finally { https.get = originalGet; https.request = originalRequest; guard.withExternalCallGuard = originalGuard; }
})().catch(error => { console.error(error); process.exitCode = 1; });

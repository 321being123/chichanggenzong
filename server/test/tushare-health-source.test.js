const assert = require('assert');
const { EventEmitter } = require('events');
const https = require('https');
const original = https.request;
let nextResponse = { status: 200, body: JSON.stringify({ code: 0, data: { fields: ['date'], items: [['20200102']] } }) };
let captured;
https.request = (url, options, callback) => {
  const req = new EventEmitter();
  req.write = body => { captured = { url, options, body: JSON.parse(body) }; };
  req.destroy = () => {};
  req.end = () => {
    const response = new EventEmitter(); response.statusCode = nextResponse.status; response.setEncoding = () => {};
    callback(response);
    process.nextTick(() => { response.emit('data', nextResponse.body); response.emit('end'); });
  };
  return req;
};
const source = require('../services/tushareHealthSource');
(async () => {
  try {
    const result = await source.readTushareHealth('test-only', 'trade_cal', { params: { exchange: 'SSE' }, fields: 'date' });
    assert.strictEqual(result.data_count, 1);
    assert.strictEqual(result.returned_data.items[0][0], '20200102');
    assert.strictEqual(captured.url, 'https://api.tushare.pro');
    assert.strictEqual(captured.options.timeout, 10000);
    assert.deepStrictEqual(captured.body.params, { exchange: 'SSE' });
    nextResponse = { status: 403, body: JSON.stringify({ code: 2002, msg: 'permission' }) };
    await assert.rejects(source.readTushareHealth('test-only', 'trade_cal', { params: {}, fields: '' }), error => error.code === 'PERMISSION_DENIED');
    nextResponse = { status: 200, body: '{bad' };
    await assert.rejects(source.readTushareHealth('test-only', 'trade_cal', { params: {}, fields: '' }), /无法解析/);
    console.log('Tushare health source: request, response, permission and malformed data passed');
  } finally { https.request = original; }
})().catch(error => { console.error(error); process.exitCode = 1; });

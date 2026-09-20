// 港股动态来源失败夹具：只验证统一请求分类和网页结构门禁，不访问外网。
const assert = require('assert');
const https = require('https');
const EventEmitter = require('events');
const {
  requestExternal,
  validateFutuIpoHtmlResponse,
  parseFutuIpoHtml,
  parseLivermoreCurrent,
  parseVbkrCurrent,
} = require('../services/hkIpoMarketSignals');

const originalGet = https.get;
function fakeResponse(statusCode, body) {
  https.get = (_url, _options, callback) => {
    const response = new EventEmitter();
    response.statusCode = statusCode;
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.destroy = error => request.emit('error', error);
    process.nextTick(() => {
      callback(response);
      response.emit('data', Buffer.from(body));
      response.emit('end');
    });
    return request;
  };
}

async function rejected(promise, code) {
  await assert.rejects(promise, error => error && error.code === code);
}

(async () => {
  try {
    fakeResponse(429, '{"code":429}');
    await rejected(requestExternal('https://trade-info-api.jesselivermore.com/api/info/get-h5-ipo-setting'), 'RATE_LIMIT');
    fakeResponse(503, 'upstream unavailable');
    await rejected(requestExternal('https://trade-info-api.jesselivermore.com/api/info/get-h5-ipo-setting'), 'UPSTREAM_5XX');
    fakeResponse(200, '<html>not-json</html>');
    await rejected(requestExternal('https://trade-info-api.jesselivermore.com/api/info/get-h5-ipo-setting'), 'UPSTREAM_FORMAT');

    const normal = '<html><h1>HK IPO</h1><a class="list-item"><span class="code" title="03231">03231</span></a></html>';
    assert.strictEqual(validateFutuIpoHtmlResponse(normal), normal);
    assert.strictEqual(parseFutuIpoHtml(normal)[0].securityCode, '03231.HK');
    await rejected(Promise.resolve().then(() => validateFutuIpoHtmlResponse('')), 'UPSTREAM_EMPTY');
    await rejected(Promise.resolve().then(() => validateFutuIpoHtmlResponse('<html>login sign in</html>')), 'AUTH_ERROR');
    await rejected(Promise.resolve().then(() => validateFutuIpoHtmlResponse('<html>changed shell</html>')), 'UPSTREAM_FORMAT');

    assert.strictEqual(parseLivermoreCurrent({ code: 2, msg_cn: '请升级您的APP' }).length, 0, '业务错误不得解析成动态数据');
    assert.strictEqual(parseVbkrCurrent({ success: true, code: '00000', data: { applying: [] } }).length, 0, '合法空列表不得制造信号');
    console.log('OK hk-ipo-source-fixtures: 正常、空响应、业务错误、429、5xx、HTML 改版和登录失效夹具通过');
  } finally {
    https.get = originalGet;
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

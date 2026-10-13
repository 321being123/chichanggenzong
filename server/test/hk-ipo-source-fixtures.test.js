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
  probeHkIpoXPermission,
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
    // HKIPOX-PERMISSION-001：匿名网页403只阻塞具体接口，探针领取复用统一持久化策略。
    fakeResponse(403,'Forbidden');
    await assert.rejects(requestExternal('https://hkipox.com/',{format:'text'}),error=>error.code==='PERMISSION_DENIED'&&error.httpStatus===403&&error.errorType==='permission');
    const records=[];let calls=0;
    const probeDeps={businessDate:'2026-10-13',claimImpl:async()=>[{api_name:'hk_ipo_public_page',credential_fingerprint:'none',nextProbeAt:'2026-10-14T08:30:00+08:00'}],
      recordImpl:async(...args)=>records.push(args),guardImpl:async(source,dataset,date,fn,options)=>{assert.equal(source,'hkipox-public');assert.equal(options.apiName,'permission_probe');return fn();},
      fetchImpl:async()=>{calls++;return '<section><h2>今日申购<span class="count">(0)</span></h2><table><th>代码</th><th>认购倍数</th><td class="empty">暂无</td></table></section>';}};
    assert.equal((await probeHkIpoXPermission(probeDeps)).status,'available');assert.equal(calls,1);
    assert.equal(records[0][2],'hk_ipo_public_page');assert.equal(records[0][4].status,'available');
    await probeHkIpoXPermission({...probeDeps,claimImpl:async()=>[]});assert.equal(calls,1,'未领取探针不得请求外部');
    const denied=await probeHkIpoXPermission({...probeDeps,fetchImpl:async()=>{const error=new Error('403');error.code='PERMISSION_DENIED';throw error;}});
    assert.equal(denied.status,'unavailable');assert.equal(records.at(-1)[4].status,'permission_denied');
    await probeHkIpoXPermission({...probeDeps,fetchImpl:async()=>'<html>login</html>'});
    assert.equal(records.length,2,'页面结构不合法不能恢复权限或捏造空市场');
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

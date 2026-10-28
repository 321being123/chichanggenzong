// 港股 IPO 非官方市场信号 HTTP 适配：白名单外采落点。
const https = require('https');

const ALLOWED_HOSTS = new Set([
  'trade-info-api.jesselivermore.com',
  'h5stockserver.huanshoulv.com',
  'web-api.vbkr.com',
  'www.futunn.com',
  'hkipox.com',
]);

function requestExternal(url, { format = 'json', timeoutMs = 15000 } = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.has(parsed.hostname)) {
    return Promise.reject(new Error(`港股 IPO 市场信号地址不在白名单：${parsed.hostname}`));
  }
  return new Promise((resolve, reject) => {
    const req = https.get(parsed, {
      headers: {
        'User-Agent': 'portfolio-server/1.0',
        Referer: parsed.hostname === 'hkipox.com' ? 'https://hkipox.com/'
          : parsed.hostname === 'www.futunn.com' ? 'https://www.futunn.com/quote/hk/ipo'
          : parsed.hostname === 'web-api.vbkr.com' ? 'https://www.vbkr.com/ipo/hk/v2/ipo-hk-index'
            : 'https://1877.jesselivermore.com/',
        Accept: format === 'json' ? 'application/json,text/plain,*/*' : 'text/html,application/xhtml+xml,*/*',
      },
    }, response => {
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes <= 6 * 1024 * 1024) chunks.push(chunk);
      });
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode >= 400) {
          const error = new Error(`港股 IPO 市场信号 HTTP ${response.statusCode}`);
          error.httpStatus = response.statusCode;
          error.code = response.statusCode === 429 ? 'RATE_LIMIT' : response.statusCode >= 500 ? 'UPSTREAM_5XX' : response.statusCode === 401 || response.statusCode === 403 ? 'PERMISSION_DENIED' : 'UPSTREAM_HTTP';
          error.errorType = response.statusCode === 429 ? 'rate_limit' : response.statusCode >= 500 ? 'network' : response.statusCode === 401 || response.statusCode === 403 ? 'permission' : 'upstream';
          reject(error);
          return;
        }
        try {
          resolve(format === 'json' ? JSON.parse(body) : body);
        } catch (error) {
          error.code = 'UPSTREAM_FORMAT';
          reject(error);
        }
      });
    });
    req.setTimeout(timeoutMs, () => {
      const error = new Error('港股 IPO 市场信号请求超时');
      error.code = 'UPSTREAM_TIMEOUT';
      error.errorType = 'network';
      req.destroy(error);
    });
    req.on('error', reject);
  });
}

module.exports = { ALLOWED_HOSTS, requestExternal };

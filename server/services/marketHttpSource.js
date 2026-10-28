// 行情/指数 HTTP 取数适配：统一承载 https 文本请求（唯一外采落点）。
const https = require('https');

// 通用 HTTPS 文本请求（支持 GBK 解码），供市场数据模块使用。
function httpsGet(url, encoding) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 6000 }, (resp) => {
      const chunks = [];
      resp.on('data', chunk => chunks.push(chunk));
      resp.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (encoding === 'gbk') {
          try { resolve(new TextDecoder('gbk').decode(buf)); }
          catch (e) { resolve(buf.toString('utf8')); }
        } else {
          resolve(buf.toString('utf8'));
        }
      });
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
  });
}

// 带限流/上游错误归一的文本请求，供指数 K 线等受 Guard 保护的调用方使用。
function getText(source, url, options = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, options, (resp) => {
      let data = '';
      resp.on('data', chunk => data += chunk);
      resp.on('end', () => {
        if (resp.statusCode === 429) {
          const error = new Error(`${source} HTTP 429`);
          error.code = 'RATE_LIMIT'; error.errorType = 'rate_limit'; error.source = source;
          return reject(error);
        }
        if (resp.statusCode >= 500) {
          const error = new Error(`${source} HTTP ${resp.statusCode}`);
          error.code = 'UPSTREAM_5XX'; error.errorType = 'network'; error.source = source;
          return reject(error);
        }
        resolve(data);
      });
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error(`${source} timeout`)); });
  });
}

// 恒生指数历史 K 线文本。
function fetchHsiHistoryText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 10000 }, (resp) => {
      const chunks = [];
      resp.on('data', chunk => chunks.push(chunk));
      resp.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
  });
}

module.exports = { httpsGet, getText, fetchHsiHistoryText };

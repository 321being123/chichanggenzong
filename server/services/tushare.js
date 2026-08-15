const https = require('https');
const { withExternalCallGuard, openExternalCircuit } = require('./externalCallGuard');

const API_URL = 'https://api.tushare.pro';

class TushareRequestError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TushareRequestError';
    this.code = code;
    this.errorType = details.errorType || (code === 'RATE_LIMIT' || code === 'QUOTA_EXHAUSTED' ? 'rate_limit' : 'network');
    this.statusCode = details.statusCode || null;
    this.apiName = details.apiName || '';
    this.source = 'tushare';
    this.upstreamCode = details.upstreamCode == null ? null : details.upstreamCode;
    this.retryable = !['RATE_LIMIT', 'QUOTA_EXHAUSTED', 'AUTH_ERROR', 'PERMISSION_DENIED', 'INVALID_PARAMETER'].includes(code);
  }
}

function classifyUpstreamError(payload, statusCode, apiName) {
  const code = payload && payload.code;
  const message = String(payload && (payload.msg || payload.message) || `Tushare HTTP ${statusCode || 'error'}`);
  if (code === 2002 || code === 40101 || /token|权限|permission|积分不足|没有接口|无权限/i.test(message)) {
    return new TushareRequestError(code === 40101 ? 'AUTH_ERROR' : 'PERMISSION_DENIED', message,
      { errorType: 'permission', statusCode, apiName, upstreamCode: code });
  }
  if (statusCode === 429 || /429|频率|频次|配额|rate.?limit|quota/i.test(message)) {
    return new TushareRequestError('RATE_LIMIT', message, { errorType: 'rate_limit', statusCode, apiName, upstreamCode: code });
  }
  if (/参数|parameter|invalid/i.test(message)) {
    return new TushareRequestError('INVALID_PARAMETER', message,
      { errorType: 'non_retryable', statusCode, apiName, upstreamCode: code });
  }
  return new TushareRequestError(statusCode >= 500 ? 'UPSTREAM_5XX' : 'UPSTREAM_ERROR', message,
    { errorType: statusCode >= 500 ? 'network' : 'upstream', statusCode, apiName, upstreamCode: code });
}

function tushareQuery(apiName, params = {}, fields = '') {
  const token = process.env.TUSHARE_TOKEN || '';
  if (!token) {
    return Promise.reject(new TushareRequestError(
      'AUTH_ERROR', 'Tushare 未配置 TUSHARE_TOKEN，无法调用外部数据接口',
      { errorType: 'permission', apiName }
    ));
  }

  const body = JSON.stringify({ api_name: apiName, token, params: params || {}, fields: fields || '' });
  const dataset = `${apiName}:${JSON.stringify(params || {})}:${fields || ''}`;
  return withExternalCallGuard('tushare', dataset, process.env.JOB_BUSINESS_DATE, () => new Promise((resolve, reject) => {
    const request = https.request(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 30000,
    }, response => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { responseBody += chunk; });
      response.on('end', async () => {
        let payload;
        try { payload = JSON.parse(responseBody); }
        catch (_) { return reject(new TushareRequestError('INVALID_RESPONSE', 'Tushare 返回了无法解析的 JSON', { apiName, statusCode: response.statusCode })); }
        if (response.statusCode !== 200 || !payload || payload.code !== 0) {
          const error = classifyUpstreamError(payload, response.statusCode, apiName);
          if (error.errorType === 'rate_limit') await openExternalCircuit('tushare', error.message).catch(() => {});
          return reject(error);
        }
        const data = payload.data;
        if (!data) return reject(new TushareRequestError('EMPTY_DATA', `Tushare ${apiName} 未返回数据集`, { errorType: 'empty_data', apiName, statusCode: response.statusCode }));
        if (!Array.isArray(data.fields) || !Array.isArray(data.items)) {
          return reject(new TushareRequestError('INVALID_RESPONSE', `Tushare ${apiName} 数据结构无效`, { apiName, statusCode: response.statusCode }));
        }
        if (data.items.some(row => !Array.isArray(row) || row.length !== data.fields.length)) {
          return reject(new TushareRequestError('INVALID_RESPONSE', `Tushare ${apiName} 数据列数不一致`, { apiName, statusCode: response.statusCode }));
        }
        if (data.items.length === 0) {
          return reject(new TushareRequestError('EMPTY_DATA', `Tushare ${apiName} 返回空数据`, { errorType: 'empty_data', apiName, statusCode: response.statusCode }));
        }
        resolve(data);
      });
    });
    request.on('error', error => reject(new TushareRequestError(
      'NETWORK_ERROR', error.message || 'Tushare 网络请求失败', { errorType: 'network', apiName }
    )));
    request.on('timeout', () => {
      request.destroy();
      reject(new TushareRequestError('NETWORK_TIMEOUT', `Tushare ${apiName} 请求超时`, { errorType: 'network', apiName }));
    });
    request.write(body);
    request.end();
  }));
}

module.exports = { tushareQuery, TushareRequestError };

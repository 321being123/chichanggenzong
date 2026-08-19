const https = require('https');
const {
  withExternalCallGuard,
  openExternalCircuit,
  closeExternalCircuit,
  releaseExternalCircuitProbe,
  tokenFingerprint,
} = require('./externalCallGuard');
const { getProviderRuntime } = require('./externalApiConfig');

const API_URL = 'https://api.tushare.pro';
const PRIMARY_SOURCE = 'tushare';
const BACKUP_SOURCE = 'tushare_backup';

class TushareRequestError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TushareRequestError';
    this.code = code;
    this.errorType = details.errorType || (code === 'RATE_LIMIT' || code === 'QUOTA_EXHAUSTED' ? 'rate_limit' : 'network');
    this.statusCode = details.statusCode || null;
    this.apiName = details.apiName || '';
    this.source = details.source || 'tushare';
    this.tokenFingerprint = details.tokenFingerprint || '';
    this.upstreamCode = details.upstreamCode == null ? null : details.upstreamCode;
    this.retryable = !['RATE_LIMIT', 'QUOTA_EXHAUSTED', 'AUTH_ERROR', 'PERMISSION_DENIED', 'INVALID_PARAMETER'].includes(code);
  }
}

function classifyUpstreamError(payload, statusCode, apiName) {
  const code = payload && payload.code;
  const message = String(payload && (payload.msg || payload.message) || `Tushare HTTP ${statusCode || 'error'}`);
  if (statusCode === 401 || code === 401 || code === 40101 || /token\s*(无效|错误)|无效 token|invalid token|token is invalid/i.test(message)) {
    return new TushareRequestError('AUTH_ERROR', message,
      { errorType: 'permission', statusCode, apiName, upstreamCode: code });
  }
  if (statusCode === 403 || code === 2002 || /权限|permission|积分不足|没有接口|无权限/i.test(message)) {
    return new TushareRequestError('PERMISSION_DENIED', message,
      { errorType: 'permission', statusCode, apiName, upstreamCode: code });
  }
  if (/当日|每日|当天|日频|今日.*次数|次数.*耗尽|额度.*耗尽|配额.*耗尽|daily.*quota|daily.*limit/i.test(message)) {
    return new TushareRequestError('QUOTA_EXHAUSTED', message, { errorType: 'rate_limit', statusCode, apiName, upstreamCode: code });
  }
  if (statusCode === 429 || /429|频率|频次|限速|配额|rate.?limit|quota/i.test(message)) {
    return new TushareRequestError('RATE_LIMIT', message, { errorType: 'rate_limit', statusCode, apiName, upstreamCode: code });
  }
  if (/参数|parameter|invalid/i.test(message)) {
    return new TushareRequestError('INVALID_PARAMETER', message,
      { errorType: 'non_retryable', statusCode, apiName, upstreamCode: code });
  }
  return new TushareRequestError(statusCode >= 500 ? 'UPSTREAM_5XX' : 'UPSTREAM_ERROR', message,
    { errorType: statusCode >= 500 ? 'network' : 'upstream', statusCode, apiName, upstreamCode: code });
}

function failoverEligible(error) {
  return Boolean(error && ['AUTH_ERROR', 'PERMISSION_DENIED', 'RATE_LIMIT', 'QUOTA_EXHAUSTED', 'CIRCUIT_OPEN'].includes(error.code));
}

function requestWithToken(apiName, params, fields, token, guardSource, dataset) {
  const body = JSON.stringify({ api_name: apiName, token, params: params || {}, fields: fields || '' });
  const fingerprint = tokenFingerprint(token);
  const guardedRequest = withExternalCallGuard(guardSource, dataset, process.env.JOB_BUSINESS_DATE, () => new Promise((resolve, reject) => {
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
          if (error.errorType === 'rate_limit') {
            const circuit = await openExternalCircuit(guardSource, error.message, {
              // 上游日额度属于当前接口；本系统总预算由 externalCallGuard 单独写入 Token 级 '*'.
              apiName,
              tokenFingerprint: fingerprint,
              errorCode: error.code,
              errorType: error.errorType,
            }).catch(() => null);
            error.recoverAt = circuit && circuit.recoverAt || null;
          } else if (error.code === 'AUTH_ERROR' || error.code === 'PERMISSION_DENIED') {
            await openExternalCircuit(guardSource, error.message, {
              apiName: error.code === 'AUTH_ERROR' ? '*' : apiName,
              tokenFingerprint: fingerprint,
              errorCode: error.code,
              errorType: error.errorType,
            }).catch(() => {});
          }
          error.source = guardSource;
          error.tokenFingerprint = fingerprint;
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
        await closeExternalCircuit(guardSource, apiName, fingerprint).catch(() => {});
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
  }), { apiName, tokenFingerprint: fingerprint });
  return guardedRequest.catch(async error => {
    if (error && error.name === 'TushareRequestError') error.source = guardSource;
    if (error && !error.apiName) error.apiName = apiName;
    if (error && !error.tokenFingerprint) error.tokenFingerprint = fingerprint;
    // 恢复探测遇到网络、空数据或结构错误时，释放探测占用并短暂退避，避免永久卡死。
    await releaseExternalCircuitProbe(guardSource, apiName, fingerprint).catch(() => {});
    throw error;
  });
}

async function tushareQuery(apiName, params = {}, fields = '') {
  const runtime = await getProviderRuntime('tushare');
  const allCandidates = [
    { token: runtime.primary, source: PRIMARY_SOURCE },
    { token: runtime.backup, source: BACKUP_SOURCE },
  ];
  const candidates = (runtime.mode === 'primary' ? allCandidates.slice(0, 1)
    : runtime.mode === 'backup' ? allCandidates.slice(1)
      : allCandidates).filter(item => item.token);
  if (!candidates.length) {
    throw new TushareRequestError(
      'AUTH_ERROR', `Tushare 未配置${runtime.mode === 'backup' ? '备用' : ''} Token，无法调用外部数据接口`,
      { errorType: 'permission', apiName }
    );
  }

  const dataset = `${apiName}:${JSON.stringify(params || {})}:${fields || ''}`;
  let lastError = null;
  let primaryFailure = null;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    try {
      const result = await requestWithToken(apiName, params, fields, candidate.token, candidate.source, dataset);
      if (candidate.source === BACKUP_SOURCE && primaryFailure && runtime.mode === 'auto') {
        const { notifyTushareFailover } = require('./externalApiConfig');
        await notifyTushareFailover(apiName, 'primary', 'backup', primaryFailure.message, primaryFailure.recoverAt).catch(() => {});
      }
      return result;
    } catch (error) {
      lastError = error;
      if (index === candidates.length - 1 || !failoverEligible(error)) throw error;
      if (candidate.source === PRIMARY_SOURCE && runtime.mode === 'auto') {
        primaryFailure = error;
      }
    }
  }
  throw lastError;
}

module.exports = { tushareQuery, TushareRequestError };

// Tushare Replay 统一客户端：GET + X-API-Key。
// 业务层只依赖返回的 { fields, items }，不感知上游域名和认证细节。

const DEFAULT_BASE_URL = 'https://ai-tool.indevs.in/tushare/pro';
const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504]);

function replayBaseUrl(env = process.env) {
  return String(env.TUSHARE_REPLAY_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function replayApiKey(env = process.env) {
  return String(env.TUSHARE_REPLAY_API_KEY || '').trim();
}

function buildReplayUrl(apiName, params = {}, fields = '', env = process.env) {
  const url = new URL(`${replayBaseUrl(env)}/${String(apiName || '').replace(/^\/+/, '')}`);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  if (fields) url.searchParams.set('fields', fields);
  return url;
}

async function requestReplayJson(url, apiName, env = process.env) {
  const timeoutMs = Math.max(1000, Number(env.TUSHARE_REPLAY_TIMEOUT_MS) || 30000);
  const retries = Math.max(0, Math.min(3, Number(env.TUSHARE_REPLAY_RETRIES) || 2));
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent': 'tushare-replay-client/1.0',
          'X-API-Key': replayApiKey(env),
        },
        signal: controller.signal,
      });
      const text = await response.text();
      let payload;
      try { payload = JSON.parse(text); } catch (_) {
        throw new Error(`Tushare Replay ${apiName} 返回非JSON（HTTP ${response.status}）`);
      }
      if (!response.ok) {
        const error = new Error(`Tushare Replay ${apiName} HTTP ${response.status}: ${payload.msg || ''}`.trim());
        error.status = response.status;
        throw error;
      }
      if (payload.code !== 0) {
        const error = new Error(`Tushare Replay ${apiName} 错误: ${payload.msg || payload.code}`);
        error.code = payload.code;
        throw error;
      }
      const data = payload.data || {};
      if (!Array.isArray(data.fields) || !Array.isArray(data.items)) {
        throw new Error(`Tushare Replay ${apiName} 响应结构异常`);
      }
      if (data.items.some(row => !Array.isArray(row) || row.length !== data.fields.length)) {
        throw new Error(`Tushare Replay ${apiName} 字段与数据列数不一致`);
      }
      return data;
    } catch (error) {
      lastError = error && error.name === 'AbortError'
        ? new Error(`Tushare Replay ${apiName} 请求超时`)
        : error;
      const status = lastError && lastError.status;
      if (attempt >= retries || (status && !TRANSIENT_STATUS.has(status))) throw lastError;
      await new Promise(resolve => setTimeout(resolve, (2 ** attempt) * 500 + 200));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error(`Tushare Replay ${apiName} 请求失败`);
}

async function tushareReplayQuery(apiName, params = {}, fields = '', env = process.env) {
  if (!replayApiKey(env)) return null;
  return requestReplayJson(buildReplayUrl(apiName, params, fields, env), apiName, env);
}

module.exports = { DEFAULT_BASE_URL, replayBaseUrl, replayApiKey, buildReplayUrl, requestReplayJson, tushareReplayQuery };

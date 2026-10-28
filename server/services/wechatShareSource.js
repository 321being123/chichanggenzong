const REQUEST_TIMEOUT_MS = 8000;

async function fetchJson(url, label) {
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    throw new Error(`${label}请求失败：${error && error.message ? error.message : error}`);
  }
  if (!response.ok) throw new Error(`${label}返回 HTTP ${response.status}`);
  let payload;
  try { payload = await response.json(); } catch (_) { throw new Error(`${label}返回内容无法解析`); }
  if (!payload || payload.errcode) {
    // 只暴露错误码，不暴露上游原始响应体，避免票据/密钥进入日志。
    const code = payload && payload.errcode ? payload.errcode : 'unknown';
    throw new Error(`${label}被微信拒绝（errcode=${code}）`);
  }
  return payload;
}


module.exports = { fetchJson };

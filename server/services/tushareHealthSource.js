const https = require('https');

function normalizeReturnedData(data) {
  if (!data || typeof data !== 'object') return null;
  const fields = Array.isArray(data.fields) ? data.fields.slice(0, 20).map(value => String(value).slice(0, 64)) : [];
  const sourceItems = Array.isArray(data.items) ? data.items : [];
  const items = sourceItems.slice(0, 5).map(row => {
    const values = Array.isArray(row) ? row : [];
    return fields.map((field, index) => {
      const value = values[index];
      if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return value == null ? null : value;
      return String(value).slice(0, 120);
    });
  });
  return { fields, items, truncated: sourceItems.length > items.length };
}


function readTushareHealth(token, probeName, probe) {
  const body = JSON.stringify({
    api_name: probeName,
    token,
    params: probe.params,
    fields: probe.fields,
  });
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const request = https.request('https://api.tushare.pro', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 10000,
    }, response => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { responseBody += chunk; });
      response.on('end', () => {
        let payload;
        try { payload = JSON.parse(responseBody); } catch (error) {
          return reject(new Error(`Tushare 返回了无法解析的响应（HTTP ${response.statusCode || '未知'}）`));
        }
        if (response.statusCode !== 200 || !payload || payload.code !== 0) {
          const upstreamCode = payload && payload.code != null ? `（代码 ${payload.code}）` : '';
          const error = new Error(`${payload && (payload.msg || payload.message) || `HTTP ${response.statusCode || '未知'}`}${upstreamCode}`);
          error.code = response.statusCode === 401 || /token\s*(无效|错误)|invalid token|无效 token/i.test(error.message)
            ? 'AUTH_ERROR' : response.statusCode === 403 || /权限|permission|积分不足|没有接口|无权限/i.test(error.message)
              ? 'PERMISSION_DENIED' : /当日|每日|次数.*耗尽|额度.*耗尽|配额.*耗尽/i.test(error.message)
                ? 'QUOTA_EXHAUSTED' : /429|频率|频次|限速|配额|rate.?limit|quota/i.test(error.message)
                  ? 'RATE_LIMIT' : 'UPSTREAM_ERROR';
          error.apiName = probeName;
          return reject(error);
        }
        const data = payload.data;
        if (data && (!Array.isArray(data.fields) || !Array.isArray(data.items))) {
          return reject(new Error('Tushare 返回的数据结构无效'));
        }
        resolve({
          latency_ms: Date.now() - startedAt,
          data_count: data && Array.isArray(data.items) ? data.items.length : 0,
          returned_data: normalizeReturnedData(data),
          api_name: probeName,
        });
      });
    });
    request.on('error', error => reject(new Error(error.message || '网络连接失败')));
    request.on('timeout', () => {
      request.destroy();
      reject(new Error('请求超时（10 秒）'));
    });
    request.write(body);
    request.end();
  });
}


module.exports = { normalizeReturnedData, readTushareHealth };

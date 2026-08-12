const https = require('https');

const API_URL = 'https://api.tushare.pro';

function tushareQuery(apiName, params = {}, fields = '') {
  return new Promise((resolve) => {
    const token = process.env.TUSHARE_TOKEN || '';
    if (!token) return resolve(null);

    const body = JSON.stringify({
      api_name: apiName,
      token,
      params: params || {},
      fields: fields || '',
    });
    const request = https.request(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 30000,
    }, (response) => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { responseBody += chunk; });
      response.on('end', () => {
        try {
          const payload = JSON.parse(responseBody);
          const data = payload && payload.data;
          if (response.statusCode !== 200 || payload.code !== 0 || !data) return resolve(null);
          if (!Array.isArray(data.fields) || !Array.isArray(data.items)) return resolve(null);
          if (data.items.some(row => !Array.isArray(row) || row.length !== data.fields.length)) return resolve(null);
          resolve(data);
        } catch (_) { resolve(null); }
      });
    });
    request.on('error', () => resolve(null));
    request.on('timeout', () => { request.destroy(); resolve(null); });
    request.write(body);
    request.end();
  });
}

module.exports = { tushareQuery };

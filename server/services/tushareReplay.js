const https = require('https');

const BASE_URL = (process.env.TUSHARE_REPLAY_BASE_URL || 'https://ai-tool.indevs.in/tushare/pro').replace(/\/$/, '');
const API_KEY = process.env.TUSHARE_REPLAY_API_KEY || '';

function tushareQuery(apiName, params = {}, fields = '') {
  return new Promise((resolve) => {
    if (!API_KEY) return resolve(null);
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params || {})) {
      if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
    }
    if (fields) query.set('fields', fields);
    const request = https.get(`${BASE_URL}/${encodeURIComponent(apiName)}?${query.toString()}`, {
      headers: { 'X-API-Key': API_KEY },
      timeout: 15000,
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try {
          const payload = JSON.parse(body);
          if (response.statusCode !== 200 || payload.code !== 0 || !payload.data) return resolve(null);
          resolve(payload.data);
        } catch (_) { resolve(null); }
      });
    });
    request.on('error', () => resolve(null));
    request.on('timeout', () => { request.destroy(); resolve(null); });
  });
}

module.exports = { tushareQuery };

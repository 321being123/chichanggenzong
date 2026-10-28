const https = require('https');
const { withExternalCallGuard } = require('./externalCallGuard');

async function fetchDailyText() {
  return withExternalCallGuard('exchange-rate', 'HKD:CNY', process.env.JOB_BUSINESS_DATE, () => new Promise((resolve, reject) => {
      https.get('https://open.er-api.com/v6/latest/HKD', { timeout: 8000 }, (resp) => {
        let data = ''; resp.on('data', c => data += c);
        resp.on('end', () => {
          if (resp.statusCode === 429) {
            const error = new Error('汇率接口 HTTP 429');
            error.code = 'RATE_LIMIT'; error.errorType = 'rate_limit'; error.source = 'exchange-rate';
            return reject(error);
          }
          if (resp.statusCode >= 500) {
            const error = new Error(`汇率接口 HTTP ${resp.statusCode}`);
            error.code = 'UPSTREAM_5XX'; error.errorType = 'network'; error.source = 'exchange-rate';
            return reject(error);
          }
          resolve(data);
        });
      }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
    }), { apiName: 'exchange_rate', credentialProfile: 'anonymous', tokenFingerprint: 'none' });
}

async function fetchRealtimeText(REALTIME_API_NAME) {
  return withExternalCallGuard('exchange-rate', 'HKD:CNY', process.env.JOB_BUSINESS_DATE, () => new Promise((resolve, reject) => {
      https.get('https://finance.yahoo.co.jp/quote/HKDCNY%3DX', {
        timeout: 8000,
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Accept': 'text/html,application/xhtml+xml',
        },
      }, (resp) => {
        let data = ''; resp.on('data', c => data += c);
        resp.on('end', () => {
          if (resp.statusCode === 429) {
            const error = new Error('实时汇率接口 HTTP 429');
            error.code = 'RATE_LIMIT'; error.errorType = 'rate_limit'; error.source = 'exchange-rate'; error.apiName = REALTIME_API_NAME;
            return reject(error);
          }
          if (resp.statusCode >= 400) {
            const error = new Error(`实时汇率接口 HTTP ${resp.statusCode}`);
            error.code = resp.statusCode >= 500 ? 'UPSTREAM_5XX' : 'UPSTREAM_4XX';
            error.errorType = 'network'; error.source = 'exchange-rate'; error.apiName = REALTIME_API_NAME;
            return reject(error);
          }
          resolve(data);
        });
      }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('realtime timeout')); });
    }), { apiName: REALTIME_API_NAME, credentialProfile: 'anonymous', tokenFingerprint: 'none' });
}

module.exports = { fetchDailyText, fetchRealtimeText };

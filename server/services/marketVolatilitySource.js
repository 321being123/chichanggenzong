const https = require('https');
const { withExternalCallGuard } = require('./externalCallGuard');

function request(url, binary, source = 'market-volatility', dataset = url) {
  return withExternalCallGuard(source, dataset, process.env.JOB_BUSINESS_DATE, () => new Promise((resolve, reject) => {
  https.get(url, { headers: { 'User-Agent': 'portfolio-server/1.0 (+official-data-sync)' }, timeout: 60000 }, r => {
    const chunks = []; r.on('data', c => chunks.push(c)); r.on('end', () => {
      if (r.statusCode < 200 || r.statusCode >= 300) {
        const error = new Error('HTTP ' + r.statusCode);
        error.code = r.statusCode === 429 ? 'RATE_LIMIT' : r.statusCode >= 500 ? 'UPSTREAM_5XX' : 'UPSTREAM_ERROR';
        error.errorType = r.statusCode === 429 ? 'rate_limit' : r.statusCode >= 500 ? 'network' : 'upstream';
        error.source = source;
        return reject(error);
      }
      const b = Buffer.concat(chunks); resolve(binary ? b : JSON.parse(b.toString('utf8')));
    });
  }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  }));
}

async function fetchChinaYield(from, to) {
  const u = 'https://yield.chinabond.com.cn/cbweb-mn/pgxh/historyQuery?startDate=' + from + '&&endDate=' + to + '&&gjqx=10&&locale=cn_ZH';
  return withExternalCallGuard('chinabond', `yield:${from}:${to}`, process.env.JOB_BUSINESS_DATE, () => new Promise((resolve, reject) => { const req = https.request(u, { method: 'POST', headers: { 'User-Agent': 'portfolio-server/1.0', Referer: 'https://yield.chinabond.com.cn/cbweb-mn/pgxh/showHistory' } }, r => { let b=''; r.on('data', c => b += c); r.on('end', () => { try { if (r.statusCode === 429) { const e = new Error('中债接口 HTTP 429'); e.code='RATE_LIMIT'; e.errorType='rate_limit'; e.source='chinabond'; throw e; } if (r.statusCode >= 500) { const e = new Error('中债接口 HTTP ' + r.statusCode); e.code='UPSTREAM_5XX'; e.errorType='network'; e.source='chinabond'; throw e; } const data=JSON.parse(b); if (!Array.isArray(data)) throw new Error('中债返回格式错误'); resolve(data); } catch(e) { if (!e.code) { e = new Error('中债 ' + from + ' 至 ' + to + ' 查询失败：' + e.message); } reject(e); } }); }); req.on('error', reject); req.end(); }));
}

function fetchCsiPe(benchmark, indexCode) {
  return request('https://www.csindex.com.cn/csindex-home/perf/indexCsiDsPe?indexCode=' + indexCode, false, 'csindex', `pe:${benchmark}:${indexCode}`);
}

function fetchHsiPe() {
  return request('https://www.hsi.com.hk/content/dam/wpb/hsil/index_operation/historical_pe/en_hk/hsi/hsi.xlsx', true, 'hsi-official', 'monthly-pe');
}

module.exports = { fetchChinaYield, fetchCsiPe, fetchHsiPe };

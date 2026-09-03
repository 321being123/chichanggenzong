// ========== 行情代理路由 ==========
const express = require('express');
const https = require('https');
const router = express.Router();
const asyncHandler = require('../middleware/async');
const { requireLogin } = require('../middleware/auth');
const {
  fetchQuoteByCode, fetchQuotesByCodes, tushareQuery, tsRows,
  tsDateStr, normDate
} = require('../services/market');
const { resolveInstrument, resolveProviderCode } = require('../services/securityIdentity');
const { withExternalCallGuard } = require('../services/externalCallGuard');

function guardedTextGet(source, dataset, url, options = {}) {
  return withExternalCallGuard(source, dataset, process.env.JOB_BUSINESS_DATE, () => new Promise((resolve, reject) => {
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
  }));
}

router.get('/quote/:code', requireLogin, asyncHandler(async (req, res) => {
  const code = req.params.code.trim().toUpperCase().replace(/\s/g, '');
  if (!code) return res.json({ price: null });
  res.json(await fetchQuoteByCode(code) || { price: null, code });
}));

// 批量行情（刷新用）：A股/可转债/港股统一走腾讯实时，Tushare 日线仅作回退
router.get('/quotes', requireLogin, asyncHandler(async (req, res) => {
  const codes = (req.query.codes || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  res.json(await fetchQuotesByCodes(codes));
}));

// 港币→人民币汇率代理（抓取逻辑见 server/jobs/hkRate.js，单点真相，供路由与定时任务共用）
const { ensureHkRate, getCurrentFxRate } = require('../jobs/hkRate');
router.get('/hkrate', requireLogin, asyncHandler(async (req, res) => {
  const result = await ensureHkRate();
  const rate = result.ok ? result.rate : await getCurrentFxRate();
  res.json({ rate: rate || 0.868, source: result.ok ? 'global' : 'global_cache' });
}));

// 指数K线数据代理（多源：A股三指数走新浪，恒生走腾讯 web.ifzq 历史日K）
// 注：东方财富(push2his)对腾讯云IP封禁，故改用新浪/腾讯源
router.get('/kline', requireLogin, asyncHandler(async (req, res) => {
  const { secid, days } = req.query;
  if (!secid) return res.json([]);
  const requestedSecid = String(secid).trim();
  let instrument = null;
  if (/^\d{5,6}\.(SH|SZ|BJ|HK)$/i.test(requestedSecid)) {
    instrument = await resolveInstrument({ canonicalCode: requestedSecid }).catch(() => null);
  } else if (/^[a-z]{2}\d{6}$/i.test(requestedSecid) || /^hkHSI$/i.test(requestedSecid)) {
    instrument = await resolveInstrument({ sourceCode: 'sina', identifierType: 'symbol', identifierValue: requestedSecid }).catch(() => null);
  }
  const tencentSymbol = instrument
    ? await resolveProviderCode({ instrumentId: instrument.instrument_id, sourceCode: 'tencent', identifierType: 'quote_symbol' }).catch(() => null)
    : null;
  const sinaSymbol = instrument
    ? await resolveProviderCode({ instrumentId: instrument.instrument_id, sourceCode: 'sina', identifierType: 'symbol' }).catch(() => null)
    : null;
  try {
    if (requestedSecid === 'hkHSI' || tencentSymbol === 'hkHSI') {
      // 恒生指数：腾讯 web.ifzq hkfqkline 历史日K（服务器实测可用，替代原 qt.gtimg 实时单点）
      // 返回 data.hkHSI.day：每条 [日期,开,收,高,低,...]，收盘价在 index 2
      const lim = Math.min(Math.max(parseInt(days) || 365, 250), 1500);
      const hkText = await guardedTextGet('tencent', `hsi-kline:${lim}`,
        'https://web.ifzq.gtimg.cn/appstock/app/hkfqkline/get?param=hkHSI,day,,,' + lim + ',qfq', {
          timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' }
        });
      const json = JSON.parse(hkText);
      const dayArr = json && json.data && json.data.hkHSI && json.data.hkHSI.day;
      if (Array.isArray(dayArr)) {
        const result = dayArr.map(function (it) {
          return { date: normDate(it[0]), close: parseFloat(it[2]) };
        }).filter(function (it) { return it.date && !isNaN(it.close) && it.close > 0; });
        return res.json(result);
      }
      return res.json([]);
    }
    // A股指数：Tushare index_daily（优先）。前端传标准代码，供应商代码只从映射表读取。
    const tsCode = instrument
      ? await resolveProviderCode({ instrumentId: instrument.instrument_id, sourceCode: 'tushare', identifierType: 'ts_code' }).catch(() => null)
      : null;
    if (tsCode) {
      const daysN = Math.min(parseInt(days) || 365, 2500);
      const end = tsDateStr(new Date());
      const dt = new Date(); dt.setDate(dt.getDate() - daysN);
      const start = tsDateStr(dt);
      const data = await tushareQuery('index_daily', { ts_code: tsCode, start_date: start, end_date: end }, 'trade_date,close');
      const rows = tsRows(data).map(r => ({ date: normDate(r.trade_date), close: parseFloat(r.close) }))
        .filter(r => r.date && !isNaN(r.close) && r.close > 0);
      if (rows.length > 0) return res.json(rows);
      // Tushare 无数据（如 token 失效/无权限）→ 落到下方新浪兜底，避免指数线空白
    }
    if (!sinaSymbol) return res.json([]);
    // A股三指数兜底：新浪历史K线
    const datalen = Math.min(parseInt(days) || 365, 500);
    const sinaText = await guardedTextGet('sina', `index-kline:${sinaSymbol}:${datalen}`,
      'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=' + encodeURIComponent(sinaSymbol) + '&scale=240&ma=no&datalen=' + datalen, {
        timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.sina.com.cn' }
      });
    const arr = JSON.parse(sinaText);
    if (Array.isArray(arr)) {
      const result = arr.map(function (it) {
        return { date: it.day, close: parseFloat(it.close) };
      }).filter(function (it) { return it.date && !isNaN(it.close) && it.close > 0; });
      return res.json(result);
    }
  } catch (e) {}
  res.json([]);
}));

module.exports = router;

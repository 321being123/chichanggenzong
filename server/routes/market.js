// ========== 行情代理路由 ==========
const express = require('express');
const https = require('https');
const router = express.Router();
const asyncHandler = require('../middleware/async');
const { requireLogin } = require('../middleware/auth');
const {
  fetchQuoteByCode, tushareQuery, tsRows, toTsCode,
  tsDateStr, normDate, ensureTsNames, ensureTsDaily
} = require('../services/market');
const { fetchTencentQuotes, isConvertibleBondCode, normalizeCode } = require('../services/tencentQuote');
const { resolveInstrument, resolveProviderCode } = require('../services/securityIdentity');

router.get('/quote/:code', requireLogin, asyncHandler(async (req, res) => {
  const code = req.params.code.trim().toUpperCase().replace(/\s/g, '');
  if (!code) return res.json({ price: null });
  res.json(await fetchQuoteByCode(code) || { price: null, code });
}));

// 批量行情（刷新用）：A股/可转债/港股统一走腾讯实时，Tushare 日线仅作回退
router.get('/quotes', requireLogin, asyncHandler(async (req, res) => {
  const codes = (req.query.codes || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  const result = {};
  if (!codes.length) return res.json(result);

  const stockCodes = [], bondCodes = [], hkCodes = [];
  codes.forEach(c => {
    if (toTsCode(c).endsWith('.HK')) hkCodes.push(c);
    else if (isConvertibleBondCode(c)) bondCodes.push(c);
    else stockCodes.push(c);
  });

  // A 股实时价格和涨跌幅优先使用腾讯同一条行情，Tushare 名称/日线只作回退。
  // 辅助数据源失败时不能阻断腾讯实时行情返回。
  const [names, daily, tencent] = await Promise.all([
    stockCodes.length ? ensureTsNames().catch(() => new Map()) : Promise.resolve(new Map()),
    stockCodes.length ? ensureTsDaily().catch(() => new Map()) : Promise.resolve(new Map()),
    fetchTencentQuotes(stockCodes.concat(bondCodes, hkCodes)).catch(() => new Map()),
  ]);
  stockCodes.forEach(c => {
    const ts = toTsCode(c);
    const d = daily.get(ts);
    const quote = tencent.get(normalizeCode(c));
    const price = quote ? quote.price : (d ? d.close : null);
    let change = null;
    if (quote && quote.change != null) change = quote.change;
    else if (d) change = d.pct_chg;
    result[c] = {
      price: (price != null && !isNaN(price)) ? price : null,
      name: names.get(ts) || (quote && quote.name) || '',
      code: c,
      change: (change != null && !isNaN(change)) ? change : null,
      quote_time: quote ? quote.quote_time : (d && d.quote_time || null),
      source: quote ? quote.source : 'tushare_daily'
    };
  });

  // 可转债和港股统一走腾讯批量接口；缓存命中时不访问上游。
  bondCodes.concat(hkCodes).forEach(c => {
    const quote = tencent.get(normalizeCode(c));
    result[c] = quote ? {
      price: quote.price,
      name: quote.name || c,
      code: normalizeCode(c),
      change: quote.change,
      quote_time: quote.quote_time,
      source: quote.source,
    } : { price: null, name: '', code: c, change: null };
  });

  res.json(result);
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
      const hkText = await new Promise((resolve, reject) => {
        https.get('https://web.ifzq.gtimg.cn/appstock/app/hkfqkline/get?param=hkHSI,day,,,' + lim + ',qfq', {
          timeout: 10000,
          headers: { 'User-Agent': 'Mozilla/5.0' }
        }, (resp) => {
          let data = '';
          resp.on('data', chunk => data += chunk);
          resp.on('end', () => resolve(data));
        }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
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
    const sinaText = await new Promise((resolve, reject) => {
      https.get('https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=' + encodeURIComponent(sinaSymbol) + '&scale=240&ma=no&datalen=' + datalen, {
        timeout: 10000,
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.sina.com.cn' }
      }, (resp) => {
        let data = '';
        resp.on('data', chunk => data += chunk);
        resp.on('end', () => resolve(data));
      }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
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

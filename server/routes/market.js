// ========== 行情代理路由 ==========
const express = require('express');
const router = express.Router();
const asyncHandler = require('../middleware/async');
const { requireLogin } = require('../middleware/auth');
const {
  fetchQuoteByCode, fetchQuotesByCodes, tushareQuery, tsRows,
  tsDateStr, normDate
} = require('../services/market');
const { getText } = require('../services/marketHttpSource');
const { resolveInstrument, resolveProviderCode } = require('../services/securityIdentity');
const { withExternalCallGuard } = require('../services/externalCallGuard');
const { getCurrentMarketStates, getMarketState } = require('../services/marketState');

function guardedTextGet(source, dataset, url, options = {}) {
  return withExternalCallGuard(source, dataset, process.env.JOB_BUSINESS_DATE, () => getText(source, url, options));
}

router.get('/quote/:code', requireLogin, asyncHandler(async (req, res) => {
  const code = req.params.code.trim().toUpperCase().replace(/\s/g, '');
  if (!code) return res.json({ price: null });
  res.json(await fetchQuoteByCode(code) || { price: null, code });
}));

// 手动刷新行情：绕过腾讯行情缓存，A股/可转债/港股统一取最新报价，Tushare 日线仅作回退
router.get('/quotes', requireLogin, asyncHandler(async (req, res) => {
  const codes = (req.query.codes || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  res.json(await fetchQuotesByCodes(codes, { force: true }));
}));

router.get('/market-state', requireLogin, asyncHandler(async (req, res) => {
  const date = String(req.query.date || '').trim();
  const time = String(req.query.time || '').trim();
  const market = String(req.query.market || '').trim().toUpperCase();
  if (date || time || market) {
    if (!date || !time || !['CN', 'HK'].includes(market)) {
      return res.status(400).json({ error: '指定查询需要同时提供 date、time 和 market（CN/HK）' });
    }
    return res.json(await getMarketState({ market, businessDate: date, time }));
  }
  res.json(await getCurrentMarketStates());
}));

// 普通读取走最近有效缓存；港股交易时段的持仓刷新才显式请求实时汇率。
const { getCurrentFxRate, ensureRealtimeHkRate, isHkTradingTime } = require('../jobs/hkRate');
router.get('/hkrate', requireLogin, asyncHandler(async (req, res) => {
  const realtimeRequested = String(req.query.realtime || '') === '1';
  if (realtimeRequested && await isHkTradingTime(new Date(), { allowUnknown: true })) {
    try {
      const snapshot = await ensureRealtimeHkRate();
      return res.json({
        rate: snapshot.rate || 0.868,
        source: 'realtime_cache',
        realtime: true,
        rateDate: snapshot.rateDate || null,
        fetchedAt: snapshot.fetchedAt || null,
      });
    } catch (error) {
      // 实时源失败时仍返回最近有效汇率，不能让一次外部抖动阻断估值。
    }
  }
  const rate = await getCurrentFxRate();
  res.json({ rate: rate || 0.868, source: 'global_cache', realtime: false });
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
      // 恒生指数：理杏仁官方 hk/index/candlestick 优先（type=normal），取不到回退腾讯 web.ifzq 历史日K。
      try {
        const { resolveIndexDaily } = require('../services/lixingerDatasetSources');
        const lim = Math.min(Math.max(parseInt(days) || 365, 250), 1500);
        const endHs = normDate(new Date());
        const startHs = normDate(new Date(Date.now() - lim * 1.6 * 86400000));
        const officialHs = await resolveIndexDaily({ tsCode: 'HSI', market: 'hk', startDate: startHs, endDate: endHs });
        if (officialHs && officialHs.length) return res.json(officialHs.slice(-lim));
      } catch (error) {
        console.warn(`理杏仁恒指K线不可用，回退腾讯：${String(error.message).slice(0, 160)}`);
      }
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
      // 理杏仁官方优先：指数 K 线只取收盘价序列，与页面需要一致；取不到再回退 Tushare。
      try {
        const { resolveIndexDaily } = require('../services/lixingerDatasetSources');
        const official = await resolveIndexDaily({ tsCode, startDate: start, endDate: end });
        if (official && official.length) return res.json(official);
      } catch (error) {
        console.warn(`理杏仁指数K线不可用，回退 Tushare：${String(error.message).slice(0, 160)}`);
      }
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

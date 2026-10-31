// ========== 行情代理路由 ==========
const express = require('express');
const router = express.Router();
const asyncHandler = require('../middleware/async');
const { requireLogin } = require('../middleware/auth');
const { fetchQuoteByCode, fetchQuotesByCodes, tsDateStr } = require('../services/market');
const { resolveInstrument, resolveProviderCode } = require('../services/securityIdentity');
const { getCurrentMarketStates, getMarketState } = require('../services/marketState');

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
  try {
    // 指数 K 线：只向数据层要「指数收盘序列」，主备来源（官方 / Tushare / 腾讯 / 新浪）由数据层决定。
    const { readIndexCloseSeries } = require('../dataAccess/marketDatasets');
    const daysWanted = Math.min(Math.max(parseInt(days) || 365, 250), 2500);
    const endDate = tsDateStr(new Date());
    const startDate = tsDateStr(new Date(Date.now() - Math.ceil(daysWanted * 1.6) * 86400000));
    if (requestedSecid === 'hkHSI' || tencentSymbol === 'hkHSI') {
      const series = await readIndexCloseSeries({ tsCode: 'HSI', market: 'hk', startDate, endDate });
      return res.json(series.slice(-Math.min(daysWanted, 1500)));
    }
    // A股指数：前端传标准代码，供应商代码只从映射表读取。
    const tsCode = instrument
      ? await resolveProviderCode({ instrumentId: instrument.instrument_id, sourceCode: 'tushare', identifierType: 'ts_code' }).catch(() => null)
      : null;
    if (tsCode) {
      const series = await readIndexCloseSeries({ tsCode, market: 'cn', startDate, endDate });
      return res.json(series);
    }
    return res.json([]);
  } catch (e) {}
  res.json([]);
}));

module.exports = router;

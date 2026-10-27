const express = require('express');
const router = express.Router();
const asyncHandler = require('../middleware/async');
const { requireLogin } = require('../middleware/auth');
const rateLimit = require('../middleware/rateLimit');
const stockAnalysisRepository = require('../repositories/stockAnalysisRepository');
const {
  normalizeStockCode, isOrdinaryAStock, refreshStockAnalysis, buildAnalysis, getSnapshot, listUserStocks,
} = require('../services/stockAnalysis');
const { enqueueStockAnalysisSync } = require('../services/companyFinancialIncrementalSync');
const { getStockStatements } = require('../services/stockStatements');
const { getDatasetMetadata } = require('../services/datasetPartitions');
const { recordServerEvent } = require('../services/siteAnalytics');

async function validStock(req, res, next) {
  const tsCode = normalizeStockCode(req.params.ts_code);
  if (!tsCode || !isOrdinaryAStock(tsCode)) return res.status(400).json({ error: '仅支持A股普通股票' });
  req.stockTsCode = tsCode;
  next();
}

router.get('/stocks', requireLogin, asyncHandler(async (req, res) => {
  const stocks = await listUserStocks(req.session.user);
  res.json({ data: stocks });
}));

router.get('/watchlist', requireLogin, asyncHandler(async (req, res) => {
  const rows = await stockAnalysisRepository.listWatchlist({ username: req.session.user });
  res.json({ data: rows });
}));

router.post('/watchlist', requireLogin, rateLimit({ prefix: 'stock-watchlist', windowMs: 60000, max: 10,
  getKey: req => req.session.user, message: '自选股操作过于频繁，请稍后再试' }), asyncHandler(async (req, res) => {
  const tsCode = normalizeStockCode(req.body && req.body.ts_code);
  if (!tsCode || !isOrdinaryAStock(tsCode)) return res.status(400).json({ error: '请输入有效的A股代码' });
  const watchlistInsert = await stockAnalysisRepository.insertWatchlist({ username: req.session.user, tsCode });
  const recordWatchlistEvent = () => recordServerEvent('watchlist_add_success', {
    pageKey: 'stock.analysis', module: 'stock'
  }, { req, username: req.session.user, dedupeKey: `watchlist:${req.session.user}:${tsCode}:${Math.floor(Date.now() / 60000)}` }).catch(() => {});
  try {
    const analysis = await refreshStockAnalysis(tsCode, `watchlist:${req.session.user}`, { readOnly: true });
    await stockAnalysisRepository.updateWatchlistName({ username: req.session.user, tsCode, name: analysis.name || '' });
    if (watchlistInsert.rowCount > 0) recordWatchlistEvent();
    res.json({ ok: true, stock: { ts_code: tsCode, name: analysis.name }, analysis });
  } catch (error) {
    const queued = await enqueueStockAnalysisSync(tsCode);
    if (watchlistInsert.rowCount > 0) recordWatchlistEvent();
    res.status(202).json({ ok: true, stock: { ts_code: tsCode, name: '' }, queued, warning: error.message });
  }
}));

router.delete('/watchlist/:ts_code', requireLogin, asyncHandler(async (req, res) => {
  const tsCode = normalizeStockCode(req.params.ts_code);
  if (!tsCode) return res.status(400).json({ error: '股票代码无效' });
  await stockAnalysisRepository.deleteWatchlist({ username: req.session.user, tsCode });
  res.json({ ok: true });
}));

router.get('/:ts_code/statements', asyncHandler(validStock), asyncHandler(async(req,res)=>{
  res.json(await getStockStatements(req.stockTsCode,String(req.query.type||'balance'),req.query.limit));
}));

router.get('/:ts_code', asyncHandler(validStock), asyncHandler(async (req, res) => {
  const snapshot = await getSnapshot(req.stockTsCode);
  if (!snapshot) return res.status(404).json({ error: '尚未建档，请刷新该股票' });
  try {
    const current = await buildAnalysis(req.stockTsCode, { readOnly: true });
    const partition = await getDatasetMetadata('stock_daily', 'CN');
    res.json(Object.assign(current, { refreshed_at: snapshot.refreshed_at, source_updated_at: snapshot.source_updated_at,
      data_as_of: partition.data_as_of || current.latest_market_trade_date || null, published_at: partition.published_at,
      is_stale: partition.is_stale, stale_reason: partition.stale_reason,
      diagnostics: snapshot.diagnostics, needs_refresh: snapshot.needs_refresh, freshness: snapshot.freshness }));
  } catch (_) {
    res.json(snapshot);
  }
}));

router.post('/:ts_code/refresh', requireLogin, rateLimit({ prefix: 'stock-analysis-refresh', windowMs: 60 * 60 * 1000, max: 10,
  getKey: req => req.session.user, message: '刷新过于频繁，请稍后再试' }), asyncHandler(validStock), asyncHandler(async (req, res) => {
  try {
    const queued = await enqueueStockAnalysisSync(req.stockTsCode);
    const snapshot = await getSnapshot(req.stockTsCode);
    res.status(202).json({ ok: true, queued, ...(snapshot ? { stale: true, analysis: snapshot } : {}) });
  } catch (error) {
    res.status(503).json({ error: error.message });
  }
}));

module.exports = router;

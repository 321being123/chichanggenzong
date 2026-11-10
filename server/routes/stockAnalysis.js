const express = require('express');
const router = express.Router();
const asyncHandler = require('../middleware/async');
const { requireLogin } = require('../middleware/auth');
const rateLimit = require('../middleware/rateLimit');
const stockAnalysisRepository = require('../repositories/stockAnalysisRepository');
const {
  normalizeStockCode, isOrdinaryAStock, refreshStockAnalysis, buildAnalysis, getSnapshot, listUserStocks,
} = require('../services/stockAnalysis');
const { normalizeAnalyzableStockCode, resolveAnalysisSecurity } = require('../services/securityAnalysisIdentity');
const hkAnalysis = require('../services/hkSecurityAnalysis');
const { getHkStockStatements } = require('../services/hkStockStatements');
const { enqueueStockAnalysisSync } = require('../services/companyFinancialIncrementalSync');
const { getStockStatements } = require('../services/stockStatements');
const { getDatasetMetadata } = require('../services/datasetPartitions');
const { recordServerEvent } = require('../services/siteAnalytics');

// A 股沿用原同步准入；港股走统一身份服务核对主档与证券类型，不以代码前缀猜市场。
async function validStock(req, res, next) {
  const cnCode = normalizeStockCode(req.params.ts_code);
  if (cnCode && isOrdinaryAStock(cnCode)) {
    req.stockTsCode = cnCode;
    req.stockMarket = 'CN';
    return next();
  }
  const candidate = normalizeAnalyzableStockCode(req.params.ts_code);
  if (!candidate || !/\.HK$/.test(candidate)) return res.status(400).json({ error: '请输入有效的股票代码' });
  const resolved = await resolveAnalysisSecurity(candidate);
  if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error });
  req.stockTsCode = resolved.security.code;
  req.stockMarket = resolved.security.market;
  req.stockCurrency = resolved.security.currency;
  next();
}

router.get('/stocks', requireLogin, asyncHandler(async (req, res) => {
  const stocks = await listUserStocks(req.session.user);
  res.json({ data: stocks });
}));

// 普通用户只读本人发起的证券刷新进度（授权投影），不开放任意任务详情。
router.get('/refresh/:slotId', requireLogin, asyncHandler(async (req, res) => {
  const slot = await require('../repositories/hkSecurityAnalysisRepository')
    .readRefreshSlotForUser(req.params.slotId, req.session.user);
  if (!slot) return res.status(404).json({ error: '没有找到本人的刷新请求' });
  res.json({ data: {
    slotId: slot.slot_id, status: slot.status, stageStatus: slot.stage_status,
    stageComplete: slot.stage_complete, targetDate: slot.target_date,
    effectiveDataDate: slot.effective_data_date || null,
    analysisVersion: slot.analysis_version || null,
    remainingCount: slot.remaining_count, market: slot.market || 'CN',
    updatedAt: slot.updated_at,
  } });
}));

router.get('/watchlist', requireLogin, asyncHandler(async (req, res) => {
  const rows = await stockAnalysisRepository.listWatchlist({ username: req.session.user });
  res.json({ data: rows });
}));

router.post('/watchlist', requireLogin, rateLimit({ prefix: 'stock-watchlist', windowMs: 60000, max: 10,
  getKey: req => req.session.user, message: '自选股操作过于频繁，请稍后再试' }), asyncHandler(async (req, res) => {
  const raw = req.body && req.body.ts_code;
  const cnCode = normalizeStockCode(raw);
  let tsCode = cnCode, market = 'CN';
  if (!cnCode || !isOrdinaryAStock(cnCode)) {
    const resolved = await resolveAnalysisSecurity(raw);
    if (!resolved.ok) return res.status(resolved.status || 400).json({ error: resolved.error || '请输入有效的股票代码' });
    tsCode = resolved.security.code;
    market = resolved.security.market;
  }
  const watchlistInsert = await stockAnalysisRepository.insertWatchlist({ username: req.session.user, tsCode });
  const recordWatchlistEvent = () => recordServerEvent('watchlist_add_success', {
    pageKey: 'stock.analysis', module: 'stock'
  }, { req, username: req.session.user, dedupeKey: `watchlist:${req.session.user}:${tsCode}:${Math.floor(Date.now() / 60000)}` }).catch(() => {});
  // 港股不套用 A 股公式重算：只登记自选，由同一单股刷新入口补齐资料。
  if (market === 'HK') {
    if (watchlistInsert.rowCount > 0) recordWatchlistEvent();
    const queued = await enqueueStockAnalysisSync(tsCode, { market: 'HK', requestedBy: req.session.user })
      .catch(error => ({ error: error.message }));
    return res.status(202).json({ ok: true, stock: { ts_code: tsCode, name: '' }, queued });
  }
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
  const tsCode = normalizeStockCode(req.params.ts_code) || normalizeAnalyzableStockCode(req.params.ts_code);
  if (!tsCode) return res.status(400).json({ error: '股票代码无效' });
  await stockAnalysisRepository.deleteWatchlist({ username: req.session.user, tsCode });
  res.json({ ok: true });
}));

router.get('/:ts_code/statements', asyncHandler(validStock), asyncHandler(async (req, res) => {
  const type = String(req.query.type || 'balance');
  if (req.stockMarket === 'HK') {
    try {
      return res.json(await getHkStockStatements(req.stockTsCode, type, req.query.limit, req.query.analysis_version));
    } catch (error) {
      if (error.status === 409) {
        return res.status(409).json({ error: error.message, code: 'ANALYSIS_VERSION_CONFLICT', conflict: error.conflict });
      }
      throw error;
    }
  }
  res.json(await getStockStatements(req.stockTsCode, type, req.query.limit));
}));

router.get('/:ts_code', asyncHandler(validStock), asyncHandler(async (req, res) => {
  // 港股只返回已发布快照的公开字段，不临时重算、不外采、不排队刷新。
  if (req.stockMarket === 'HK') {
    const snapshot = await hkAnalysis.getHkSnapshot(req.stockTsCode);
    if (!snapshot) return res.status(404).json({ error: '该港股的分析资料尚未就绪', code: 'HK_ANALYSIS_NOT_READY' });
    return res.json(hkAnalysis.publicSnapshotOf(snapshot));
  }
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
    const queued = await enqueueStockAnalysisSync(req.stockTsCode, {
      market: req.stockMarket === 'HK' ? 'HK' : 'CN', requestedBy: req.session.user,
    });
    const snapshot = req.stockMarket === 'HK'
      ? await hkAnalysis.getHkSnapshot(req.stockTsCode)
      : await getSnapshot(req.stockTsCode);
    res.status(202).json({ ok: true, queued, ...(snapshot ? { stale: true, analysis: req.stockMarket === 'HK' ? hkAnalysis.publicSnapshotOf(snapshot) : snapshot } : {}) });
  } catch (error) {
    res.status(503).json({ error: error.message });
  }
}));

module.exports = router;

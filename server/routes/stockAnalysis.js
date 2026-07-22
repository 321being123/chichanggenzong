const express = require('express');
const router = express.Router();
const asyncHandler = require('../middleware/async');
const { requireLogin } = require('../middleware/auth');
const rateLimit = require('../middleware/rateLimit');
const { pool } = require('../db/connection');
const {
  normalizeStockCode, isOrdinaryAStock, refreshStockAnalysis, buildAnalysis, getSnapshot, listUserStocks,
} = require('../services/stockAnalysis');
const { getStockStatements } = require('../services/stockStatements');

router.use(requireLogin);

async function validStock(req, res, next) {
  const tsCode = normalizeStockCode(req.params.ts_code);
  if (!tsCode || !isOrdinaryAStock(tsCode)) return res.status(400).json({ error: '仅支持A股普通股票' });
  req.stockTsCode = tsCode;
  next();
}

router.get('/stocks', asyncHandler(async (req, res) => {
  const stocks = await listUserStocks(req.session.user);
  res.json({ data: stocks });
}));

router.get('/watchlist', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT ts_code,name,created_at FROM stock_watchlist WHERE username=$1 ORDER BY created_at',
    [req.session.user]
  );
  res.json({ data: rows });
}));

router.post('/watchlist', rateLimit({ prefix: 'stock-watchlist', windowMs: 60000, max: 10,
  getKey: req => req.session.user, message: '自选股操作过于频繁，请稍后再试' }), asyncHandler(async (req, res) => {
  const tsCode = normalizeStockCode(req.body && req.body.ts_code);
  if (!tsCode || !isOrdinaryAStock(tsCode)) return res.status(400).json({ error: '请输入有效的A股代码' });
  await pool.query(
    `INSERT INTO stock_watchlist (username,ts_code,name) VALUES ($1,$2,'')
     ON CONFLICT (username,ts_code) DO NOTHING`, [req.session.user, tsCode]
  );
  try {
    const analysis = await refreshStockAnalysis(tsCode, `watchlist:${req.session.user}`);
    await pool.query('UPDATE stock_watchlist SET name=$3 WHERE username=$1 AND ts_code=$2', [req.session.user, tsCode, analysis.name || '']);
    res.json({ ok: true, stock: { ts_code: tsCode, name: analysis.name }, analysis });
  } catch (error) {
    res.status(202).json({ ok: true, stock: { ts_code: tsCode, name: '' }, warning: error.message });
  }
}));

router.delete('/watchlist/:ts_code', asyncHandler(async (req, res) => {
  const tsCode = normalizeStockCode(req.params.ts_code);
  if (!tsCode) return res.status(400).json({ error: '股票代码无效' });
  await pool.query('DELETE FROM stock_watchlist WHERE username=$1 AND ts_code=$2', [req.session.user, tsCode]);
  res.json({ ok: true });
}));

router.get('/:ts_code/statements', asyncHandler(validStock), asyncHandler(async(req,res)=>{
  res.json(await getStockStatements(req.stockTsCode,String(req.query.type||'balance'),req.query.limit));
}));

router.get('/:ts_code', asyncHandler(validStock), asyncHandler(async (req, res) => {
  const snapshot = await getSnapshot(req.stockTsCode);
  if (!snapshot) return res.status(404).json({ error: '尚未建档，请刷新该股票' });
  try {
    const current = await buildAnalysis(req.stockTsCode);
    res.json(Object.assign(current, { refreshed_at: snapshot.refreshed_at, source_updated_at: snapshot.source_updated_at, diagnostics: snapshot.diagnostics }));
  } catch (_) {
    res.json(snapshot);
  }
}));

router.post('/:ts_code/refresh', rateLimit({ prefix: 'stock-analysis-refresh', windowMs: 60 * 60 * 1000, max: 10,
  getKey: req => req.session.user, message: '刷新过于频繁，请稍后再试' }), asyncHandler(validStock), asyncHandler(async (req, res) => {
  try {
    const analysis = await refreshStockAnalysis(req.stockTsCode, `manual:${req.session.user}`);
    res.json({ ok: true, analysis });
  } catch (error) {
    const snapshot = await getSnapshot(req.stockTsCode);
    if (snapshot) return res.status(502).json({ error: error.message, stale: true, analysis: snapshot });
    res.status(502).json({ error: error.message });
  }
}));

module.exports = router;

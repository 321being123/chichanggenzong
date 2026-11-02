// 投资策略选股中心 API（方案第 11 节）。
// Route 只做参数校验、权限与协议映射；计算、质量裁决和发布事务都在 stockSelectionService。
'use strict';

const express = require('express');
const router = express.Router();
const asyncHandler = require('../middleware/async');
const { requireLogin, requireCapability } = require('../middleware/auth');
const service = require('../services/stockSelectionService');
const backtestService = require('../services/stockSelectionBacktest');
const { auditEvent } = require('../db');
const { enqueueManualJob } = require('../services/jobScheduleSlots');

const MAX_PAGE_SIZE = 200;

function intParam(value, fallback, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return fallback;
  return max ? Math.min(n, max) : n;
}

function runEnvelope(run) {
  return {
    runId: Number(run.run_id),
    market: run.market,
    runKind: run.run_kind,
    quarter: run.quarter,
    asOfDate: run.as_of_date_text || run.as_of_date,
    knowledgeCutoff: run.knowledge_cutoff_text || run.knowledge_cutoff,
    strategyVersion: run.strategy_version,
    revision: Number(run.revision || 1),
    publishedAt: run.published_at || null,
    executionStatus: run.execution_status,
    qualityStatus: run.quality_status,
    businessStatus: run.business_status,
    universeCount: Number(run.universe_count || 0),
    pendingCount: Number(run.pending_count || 0),
    selectedCount: Number(run.selected_count || 0),
    marketPb: run.market_pb === null ? null : Number(run.market_pb),
    marketPe: run.market_pe === null ? null : Number(run.market_pe),
    benchmarkCode: run.benchmark_code,
    valuationMethod: run.valuation_method,
    positionRatio: run.position_ratio === null ? null : Number(run.position_ratio),
    budgetRatio: run.budget_ratio === null ? null : Number(run.budget_ratio),
    ownerUsername: run.owner_username || null,
    inputManifest: run.input_manifest || null,
  };
}

/** 个人运行的归属校验：不属于本人一律 404，不泄露存在性。 */
function assertRunAccess(req, run) {
  if (!run) {
    const error = new Error('批次不存在');
    error.status = 404;
    throw error;
  }
  if (run.run_kind === 'personal' && run.owner_username !== req.session.user) {
    const error = new Error('批次不存在');
    error.status = 404;
    throw error;
  }
  return run;
}

router.get('/markets', requireLogin, asyncHandler(async (req, res) => {
  res.json(await service.getMarkets());
}));

router.get('/runs', requireLogin, asyncHandler(async (req, res) => {
  const market = req.query.market ? String(req.query.market).toUpperCase() : null;
  if (market && !['CN', 'HK'].includes(market)) return res.status(400).json({ error: '市场参数不合法' });
  const kind = req.query.kind ? String(req.query.kind) : null;
  if (kind && !['quarterly', 'preview', 'personal'].includes(kind)) return res.status(400).json({ error: '运行类型不合法' });
  const quarter = req.query.quarter ? String(req.query.quarter) : null;
  if (quarter && !/^\d{4}Q[1-4]$/.test(quarter)) return res.status(400).json({ error: '季度参数不合法' });
  const limit = intParam(req.query.limit, 20, MAX_PAGE_SIZE) || 20;
  const offset = intParam(req.query.offset, 0);
  const result = await service.listRuns({ market, quarter, kind, ownerUsername: req.session.user, limit, offset });
  res.json({
    total: result.total,
    limit, offset,
    runs: result.rows.map(row => ({
      runId: Number(row.run_id),
      market: row.market,
      runKind: row.run_kind,
      quarter: row.quarter,
      asOfDate: row.as_of_date,
      strategyVersion: row.strategy_version,
      executionStatus: row.execution_status,
      qualityStatus: row.quality_status,
      businessStatus: row.business_status,
      universeCount: Number(row.universe_count || 0),
      pendingCount: Number(row.pending_count || 0),
      selectedCount: Number(row.selected_count || 0),
      marketPb: row.market_pb === null ? null : Number(row.market_pb),
      marketPe: row.market_pe === null ? null : Number(row.market_pe),
      revision: Number(row.revision || 1),
      publishedAt: row.published_at || null,
      ownerUsername: row.owner_username || null,
    })),
  });
}));

router.get('/runs/:id', requireLogin, asyncHandler(async (req, res) => {
  const runId = intParam(req.params.id, null);
  if (!runId) return res.status(400).json({ error: '批次编号不合法' });
  const run = assertRunAccess(req, await service.getRun(runId));
  res.json(runEnvelope(run));
}));

router.get('/runs/:id/candidates', requireLogin, asyncHandler(async (req, res) => {
  const runId = intParam(req.params.id, null);
  if (!runId) return res.status(400).json({ error: '批次编号不合法' });
  assertRunAccess(req, await service.getRun(runId));
  const limit = intParam(req.query.limit, 50, MAX_PAGE_SIZE) || 50;
  const offset = intParam(req.query.offset, 0);
  const filterStatus = req.query.filterStatus ? String(req.query.filterStatus).toUpperCase() : null;
  if (filterStatus && !['PASS', 'FAIL', 'PENDING', 'NOT_APPLICABLE'].includes(filterStatus)) {
    return res.status(400).json({ error: '筛选状态不合法' });
  }
  const orderBy = req.query.orderBy === 'code' ? 'code' : 'rank';
  const result = await service.getCandidates({ runId, limit, offset, filterStatus, orderBy });
  res.json({
    total: result.total, limit, offset,
    candidates: result.rows.map(row => ({
      instrumentId: Number(row.instrument_id),
      code: row.code,
      name: row.name,
      industry: row.industry_code ? { code: row.industry_code, name: row.industry_name, system: row.industry_system, version: row.industry_version } : null,
      currentPb: row.current_pb === null ? null : Number(row.current_pb),
      historicalPbMax: row.historical_pb_max === null ? null : Number(row.historical_pb_max),
      currentPe: row.current_pe === null ? null : Number(row.current_pe),
      profitStatus: row.profit_status,
      dividendYield: row.dividend_yield === null ? null : Number(row.dividend_yield),
      equityAmount: row.equity_amount === null ? null : Number(row.equity_amount),
      equityCurrency: row.equity_currency,
      equityCny: row.equity_cny === null ? null : Number(row.equity_cny),
      fxRate: row.fx_rate === null ? null : Number(row.fx_rate),
      fxDate: row.fx_date,
      pbRank: row.pb_rank,
      peRank: row.pe_rank,
      dividendRank: row.dividend_rank,
      totalScore: row.total_score === null ? null : Number(row.total_score),
      selectionOrder: row.selection_order,
      filterStatus: row.filter_status,
      dataQualityStatus: row.data_quality_status,
      exclusionReasons: row.exclusion_reasons,
    })),
  });
}));

router.get('/runs/:id/portfolio', requireLogin, asyncHandler(async (req, res) => {
  const runId = intParam(req.params.id, null);
  if (!runId) return res.status(400).json({ error: '批次编号不合法' });
  assertRunAccess(req, await service.getRun(runId));
  const portfolio = await service.getPortfolio(runId);
  if (!portfolio) return res.status(404).json({ error: '批次不存在' });
  res.json(portfolio);
}));

router.get('/runs/:id/stocks/:code', requireLogin, asyncHandler(async (req, res) => {
  const runId = intParam(req.params.id, null);
  if (!runId) return res.status(400).json({ error: '批次编号不合法' });
  assertRunAccess(req, await service.getRun(runId));
  const detail = await service.getStockDetail({ runId, code: String(req.params.code || '') });
  if (!detail) return res.status(404).json({ error: '该股票不属于此批次' });
  res.json(detail);
}));

router.get('/backtests', requireLogin, asyncHandler(async (req, res) => {
  const market = req.query.market ? String(req.query.market).toUpperCase() : null;
  if (market && !['CN', 'HK'].includes(market)) return res.status(400).json({ error: '市场参数不合法' });
  const limit = intParam(req.query.limit, 10, MAX_PAGE_SIZE) || 10;
  const offset = intParam(req.query.offset, 0);
  const result = await service.listBacktests({ market, limit, offset });
  res.json({ total: result.total, limit, offset, backtests: result.rows });
}));

router.get('/backtests/:id', requireLogin, asyncHandler(async (req, res) => {
  const backtestId = intParam(req.params.id, null);
  if (!backtestId) return res.status(400).json({ error: '回测编号不合法' });
  const backtest = await service.getBacktest(backtestId);
  if (!backtest) return res.status(404).json({ error: '回测不存在' });
  res.json(backtest);
}));

router.get('/backtests/:id/periods', requireLogin, asyncHandler(async (req, res) => {
  const backtestId = intParam(req.params.id, null);
  if (!backtestId) return res.status(400).json({ error: '回测编号不合法' });
  const limit = intParam(req.query.limit, 200, MAX_PAGE_SIZE) || 200;
  const offset = intParam(req.query.offset, 0);
  const result = await service.getBacktestPeriods({ backtestId, limit, offset });
  res.json({ total: result.total, limit, offset, periods: result.rows });
}));

router.get('/settings', requireLogin, asyncHandler(async (req, res) => {
  res.json(await service.getSettings(req.session.user));
}));

router.put('/settings', requireLogin, asyncHandler(async (req, res) => {
  try {
    const saved = await service.saveSettings({ username: req.session.user, body: req.body || {} });
    await auditEvent({
      actor: req.session.user, action: 'stock_selection_settings', target: req.session.user,
      result: 'success', requestId: req.id, metadata: { revision: saved.revision },
    });
    res.json({ ok: true, ...saved });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
}));

router.post('/simulations', requireLogin, asyncHandler(async (req, res) => {
  const body = req.body || {};
  const sourceRunId = intParam(body.sourceRunId, null);
  if (!sourceRunId) return res.status(400).json({ error: '请选择已发布的批次' });
  try {
    const result = await service.createSimulation({
      username: req.session.user,
      sourceRunId,
      positionRatio: body.positionRatio,
      budgetRatio: body.budgetRatio,
    });
    await auditEvent({
      actor: req.session.user, action: 'stock_selection_simulation', target: String(sourceRunId),
      result: 'success', requestId: req.id, metadata: { runId: result.runId, reused: result.reused },
    });
    res.status(result.reused ? 200 : 201).json({ ok: true, runId: result.runId, reused: result.reused, run: runEnvelope(result.run) });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
}));

// ========== 管理员：补数 / 计算 / 回测（复用原人工任务队列） ==========
const adminRouter = express.Router();
const ALLOWED_SELECTION_MODES = ['selection_quarterly', 'selection_preview', 'selection_backtest'];

adminRouter.post('/runs', requireCapability('ops_manage'), asyncHandler(async (req, res) => {
  const body = req.body || {};
  const market = String(body.market || '').toUpperCase();
  if (!['CN', 'HK'].includes(market)) return res.status(400).json({ error: '市场参数不合法' });
  const mode = String(body.mode || 'selection_quarterly');
  if (!ALLOWED_SELECTION_MODES.includes(mode)) return res.status(400).json({ error: '运行模式不合法' });
  const quarter = body.quarter ? String(body.quarter) : null;
  if (quarter && !/^\d{4}Q[1-4]$/.test(quarter)) return res.status(400).json({ error: '季度参数不合法' });
  const requestId = body.requestId ? String(body.requestId).slice(0, 100) : `sel-${market}-${Date.now()}`;
  try {
    const slot = await enqueueManualJob('stock_analysis_refresh', { mode, market, quarter, targetDate: body.targetDate, requestId });
    if (!slot) return res.status(400).json({ error: '选股任务暂不可用' });
    await auditEvent({
      actor: req.session.user, action: 'stock_selection_queue', target: market,
      result: 'success', requestId: req.id, metadata: { slotId: slot.slot_id, mode, quarter },
    });
    res.status(202).json({ ok: true, queued: true, slotId: slot.slot_id, requestId, mode, market, quarter });
  } catch (error) {
    await auditEvent({
      actor: req.session.user, action: 'stock_selection_queue', target: market,
      result: 'failure', requestId: req.id, detail: error.message,
    });
    res.status(error.status || 500).json({ error: error.message });
  }
}));

adminRouter.post('/backfills', requireCapability('ops_manage'), asyncHandler(async (req, res) => {
  const body = req.body || {};
  const market = String(body.market || '').toUpperCase();
  if (!['CN', 'HK'].includes(market)) return res.status(400).json({ error: '市场参数不合法' });
  // 补数仍走原财务与行情采集入口，不在这里新增第二套外采链路。
  try {
    const slot = await enqueueManualJob('company_financial_incremental_sync', {
      mode: 'selection_inputs', market, targetDate: body.targetDate,
    });
    if (!slot) return res.status(400).json({ error: '补数任务暂不可用' });
    await auditEvent({
      actor: req.session.user, action: 'stock_selection_backfill_queue', target: market,
      result: 'success', requestId: req.id, metadata: { slotId: slot.slot_id },
    });
    res.status(202).json({ ok: true, queued: true, slotId: slot.slot_id, market });
  } catch (error) {
    await auditEvent({
      actor: req.session.user, action: 'stock_selection_backfill_queue', target: market,
      result: 'failure', requestId: req.id, detail: error.message,
    });
    res.status(error.status || 500).json({ error: error.message });
  }
}));

adminRouter.post('/backtests', requireCapability('ops_manage'), asyncHandler(async (req, res) => {
  const body = req.body || {};
  const market = String(body.market || '').toUpperCase();
  if (!['CN', 'HK'].includes(market)) return res.status(400).json({ error: '市场参数不合法' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.startDate || '')) || !/^\d{4}-\d{2}-\d{2}$/.test(String(body.endDate || ''))) {
    return res.status(400).json({ error: '回测区间参数不合法' });
  }
  try {
    const result = await backtestService.runBacktest({
      market, startDate: String(body.startDate), endDate: String(body.endDate),
      currency: body.currency ? String(body.currency) : 'LOCAL',
    });
    await auditEvent({
      actor: req.session.user, action: 'stock_selection_backtest', target: market,
      result: 'success', requestId: req.id, metadata: { backtestId: result.backtestId, status: result.status },
    });
    res.status(202).json({ ok: true, backtestId: result.backtestId, status: result.status, metrics: result.metrics, diagnostics: result.diagnostics });
  } catch (error) {
    await auditEvent({
      actor: req.session.user, action: 'stock_selection_backtest', target: market,
      result: 'failure', requestId: req.id, detail: error.message,
    });
    res.status(error.status || 500).json({ error: error.message });
  }
}));

module.exports = router;
module.exports.adminRouter = adminRouter;

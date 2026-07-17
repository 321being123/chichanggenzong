const express = require('express');
const router = express.Router();
const asyncHandler = require('../middleware/async');
const { requireLogin, requireAdmin } = require('../middleware/auth');
const { RATINGS } = require('../services/bondSafety');
const { getLatestSnapshot, refreshBondSafety, isConfigured } = require('../services/bondSafetyService');
const { filterAndSortRows, buildBondSafetyWorkbook } = require('../services/bondSafetyExport');

router.get('/bonds', asyncHandler(async (req, res) => {
  const requestedRating = String(req.query.rating || '').trim();
  if (requestedRating && !RATINGS.includes(requestedRating)) {
    return res.status(400).json({ error: '未知的安全性评级' });
  }
  const snapshot = await getLatestSnapshot();
  if (!snapshot) {
    return res.json({
      configured: isConfigured(),
      updated_at: null,
      source_updated_at: null,
      count: 0,
      total: 0,
      data: [],
      diagnostics: null,
    });
  }
  const allData = Array.isArray(snapshot.data) ? snapshot.data : [];
  const data = requestedRating ? allData.filter(row => row.safety === requestedRating) : allData;
  res.json({
    configured: isConfigured(),
    updated_at: snapshot.refreshed_at,
    source_updated_at: snapshot.source_updated_at,
    count: data.length,
    total: allData.length,
    data,
    diagnostics: snapshot.diagnostics || null,
  });
}));

router.get('/export', asyncHandler(async (req, res) => {
  const snapshot = await getLatestSnapshot();
  if (!snapshot) return res.status(404).json({ error: '尚无可导出的安全性快照' });
  const rows = filterAndSortRows(Array.isArray(snapshot.data) ? snapshot.data : [], req.query);
  const workbook = await buildBondSafetyWorkbook(rows);
  const buffer = await workbook.xlsx.writeBuffer();
  const filename = `可转债安全性评估_${new Date().toISOString().slice(0, 10)}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader('Content-Length', buffer.length);
  res.end(Buffer.from(buffer));
}));

router.post('/refresh', requireAdmin, asyncHandler(async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ error: '数据源尚未配置' });
  try {
    const result = await refreshBondSafety('manual:' + req.session.user);
    if (result.skipped) return res.status(409).json({ error: '已有刷新任务正在运行，请稍后再试' });
    res.json({ ok: true, updated_at: result.snapshot.refreshed_at, count: result.snapshot.row_count });
  } catch (error) {
    console.error('[bond-safety] 手动刷新失败:', error.message);
    res.status(502).json({ error: '刷新失败，已继续使用上一份有效数据' });
  }
}));

module.exports = router;

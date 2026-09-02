const express = require('express');
const router = express.Router();
const asyncHandler = require('../middleware/async');
const { requireLogin, requireCapability } = require('../middleware/auth');
const { RATINGS } = require('../services/bondSafety');
const { getLatestSnapshot, refreshBondSafety } = require('../services/bondSafetyService');
const { getLatestCallStateBySecurityCodes } = require('../services/convertibleBondRedemptionService');
const { filterAndSortRows, buildBondSafetyWorkbook } = require('../services/bondSafetyExport');
const { auditEvent } = require('../db');
const { getDatasetMetadata } = require('../services/datasetPartitions');

router.get('/bonds', asyncHandler(async (req, res) => {
  const requestedRating = String(req.query.rating || '').trim();
  if (requestedRating && !RATINGS.includes(requestedRating)) {
    return res.status(400).json({ error: '未知的安全性评级' });
  }
  const snapshot = await getLatestSnapshot();
  const partition = await getDatasetMetadata('bond_safety_snapshot', 'CN');
  if (!snapshot) {
    return res.json({
      configured: isConfigured(),
      updated_at: null,
      source_updated_at: null,
      count: 0,
      total: 0,
      data: [],
      diagnostics: null,
      data_as_of: partition.data_as_of,
      published_at: partition.published_at,
      is_stale: partition.is_stale,
      stale_reason: partition.stale_reason,
    });
  }
  const allData = Array.isArray(snapshot.data) ? snapshot.data : [];
  const callStates = await getLatestCallStateBySecurityCodes(allData.map(row => row.bond_code));
  const enriched = allData.map(row => {
    const code = String(row.bond_code || '').trim().toUpperCase().replace(/\.(SH|SZ|BJ|HK)$/, '');
    const callState = callStates.get(code);
    return { ...row, call_status: callState ? callState.business_status : 'incomplete' };
  });
  const data = requestedRating ? enriched.filter(row => row.safety === requestedRating) : enriched;
  res.json({
    configured: isConfigured(),
    updated_at: snapshot.refreshed_at,
    source_updated_at: snapshot.source_updated_at,
    count: data.length,
    total: enriched.length,
    data,
    diagnostics: snapshot.diagnostics || null,
    data_as_of: partition.data_as_of || (snapshot.source_updated_at ? String(snapshot.source_updated_at).slice(0, 10) : null),
    published_at: partition.published_at,
    is_stale: partition.is_stale,
    stale_reason: partition.stale_reason,
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

router.post('/refresh', requireCapability('ops_manage'), asyncHandler(async (req, res) => {
  try {
    const result = await refreshBondSafety('manual:' + req.session.user, { readOnly: true });
    if (result.skipped) {
      await auditEvent({ actor: req.session.user, action: 'bond_safety_refresh', target: 'all', result: 'failure', requestId: req.id, detail: '已有刷新任务正在运行' });
      return res.status(409).json({ error: '已有刷新任务正在运行，请稍后再试' });
    }
    await auditEvent({ actor: req.session.user, action: 'bond_safety_refresh', target: 'all', result: 'success', requestId: req.id, metadata: { count: result.snapshot ? result.snapshot.row_count : 0 } });
    res.json({ ok: true, updated_at: result.snapshot.refreshed_at, count: result.snapshot.row_count });
  } catch (error) {
    console.error('[bond-safety] 手动刷新失败:', error.message);
    await auditEvent({ actor: req.session.user, action: 'bond_safety_refresh', target: 'all', result: 'failure', requestId: req.id, detail: error.message || '刷新失败' });
    res.status(502).json({ error: '刷新失败，已继续使用上一份有效数据' });
  }
}));

module.exports = router;

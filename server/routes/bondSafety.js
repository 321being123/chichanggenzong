const express = require('express');
const router = express.Router();
const asyncHandler = require('../middleware/async');
const { requireLogin, requireCapability } = require('../middleware/auth');
const { RATINGS } = require('../services/bondSafety');
const { getLatestSnapshot, refreshBondSafety } = require('../services/bondSafetyService');
const { isConfigured } = require('../services/bondSafetyFetcher');
const { getLatestCallStateBySecurityCodes } = require('../services/convertibleBondRedemptionService');
const { filterAndSortRows, buildBondSafetyWorkbook } = require('../services/bondSafetyExport');
const { auditEvent, pool } = require('../db');
const { getDatasetMetadata } = require('../services/datasetPartitions');
const { publishJobDatasets } = require('../services/datasetPartitionRegistry');
const { applyPublicCache } = require('../middleware/publicCache');

router.get('/bonds', asyncHandler(async (req, res) => {
  const requestedRating = String(req.query.rating || '').trim();
  const summaryView = String(req.query.view || '').toLowerCase() === 'summary';
  if (requestedRating && !RATINGS.includes(requestedRating)) {
    return res.status(400).json({ error: '未知的安全性评级' });
  }
  const snapshot = await getLatestSnapshot();
  const partition = await getDatasetMetadata('bond_safety_snapshot', 'CN');
  // 完整列表还会附加强赎状态；把其最新计算/公告更新时间和行情水位纳入版本，
  // 避免安全性快照未变但 call_status 已变化时错误返回 304。
  let callStateVersion = '';
  if (!summaryView) {
    try {
      const { rows } = await pool.query(`
        SELECT
          (SELECT COALESCE(MAX(calculated_at)::text, '')
             FROM analytics.convertible_bond_trigger_daily
            WHERE trigger_type='call') AS trigger_calculated_at,
          (SELECT COALESCE(MAX(updated_at)::text, '')
             FROM event.convertible_bond_call_events) AS event_updated_at,
          (SELECT COALESCE(MAX(event_id)::text, '')
             FROM event.convertible_bond_call_events) AS event_id,
          (SELECT COALESCE(MAX(trade_date)::text, '')
             FROM market.convertible_bond_daily_metrics) AS market_trade_date`);
      callStateVersion = rows[0]
        ? [rows[0].trigger_calculated_at, rows[0].event_updated_at, rows[0].event_id,
          rows[0].market_trade_date].join('|')
        : '';
    } catch (e) {
      // 兼容旧库：状态版本查询失败不阻断原有列表读取，部署后由日志和 nginx 验收发现。
    }
  }
  const currentDateCN = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
  const cacheVersion = [snapshot && snapshot.refreshed_at, snapshot && snapshot.source_updated_at,
    partition.data_as_of, partition.published_at, requestedRating || 'all', summaryView ? 'summary' : 'full',
    currentDateCN, callStateVersion].join('|');
  if (applyPublicCache(req, res, cacheVersion)) return;
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
  if (summaryView) {
    const filtered = requestedRating ? allData.filter(row => row.safety === requestedRating) : allData;
    const safetyCounts = { '安全': 0, '低风险': 0, '中风险': 0, '高风险': 0 };
    filtered.forEach(row => { if (Object.prototype.hasOwnProperty.call(safetyCounts, row.safety)) safetyCounts[row.safety]++; });
    return res.json({
      configured: isConfigured(),
      updated_at: snapshot.refreshed_at,
      source_updated_at: snapshot.source_updated_at,
      count: filtered.length,
      total: filtered.length,
      data: [],
      safety_counts: safetyCounts,
      diagnostics: snapshot.diagnostics || null,
      data_as_of: partition.data_as_of || (snapshot.source_updated_at ? String(snapshot.source_updated_at).slice(0, 10) : null),
      published_at: partition.published_at,
      is_stale: partition.is_stale,
      stale_reason: partition.stale_reason,
    });
  }
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
    await publishJobDatasets('bond_safety_refresh', String(result.dataAsOf || new Date().toISOString()).slice(0, 10), result);
    await auditEvent({ actor: req.session.user, action: 'bond_safety_refresh', target: 'all', result: 'success', requestId: req.id, metadata: { count: result.snapshot ? result.snapshot.row_count : 0 } });
    res.json({ ok: true, updated_at: result.snapshot.refreshed_at, count: result.snapshot.row_count });
  } catch (error) {
    console.error('[bond-safety] 手动刷新失败:', error.message);
    await auditEvent({ actor: req.session.user, action: 'bond_safety_refresh', target: 'all', result: 'failure', requestId: req.id, detail: error.message || '刷新失败' });
    res.status(502).json({ error: '刷新失败，已继续使用上一份有效数据' });
  }
}));

module.exports = router;

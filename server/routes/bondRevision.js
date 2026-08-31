const express = require('express');
const asyncHandler = require('../middleware/async');
const { getBondRevisionOverview } = require('../services/convertibleBondRevisionService');
const { getBondRevisionMotiveDetail } = require('../services/convertibleBondRevisionMotiveService');

const router = express.Router();

// 下修监控只读数据库统一视图；页面刷新不会触发公告或行情外部请求。
router.get('/', asyncHandler(async (req, res) => {
  const status = String(req.query.status || '').trim();
  const query = String(req.query.q || '').trim();
  const near = ['1', 'true', 'yes'].includes(String(req.query.near || '').toLowerCase());
  const limit = req.query.limit == null ? 2000 : Number(req.query.limit);
  if (!Number.isFinite(limit) || limit < 1) return res.status(400).json({ error: 'limit 参数不合法' });
  res.json(await getBondRevisionOverview({ status, query, near, limit }));
}));

// 详情页只读评分当天快照，不在请求中补抓任何外部数据。
router.get('/:tsCode/motive-detail', asyncHandler(async (req, res) => {
  const tsCode = String(req.params.tsCode || '').trim().toUpperCase();
  const tradeDate = req.query.tradeDate == null ? null : String(req.query.tradeDate).trim();
  if (!/^(110|111|113|118|123|127|128)\d{3}\.(SH|SZ)$/.test(tsCode)) {
    return res.status(400).json({ error: '可转债代码不合法' });
  }
  if (tradeDate && !/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) {
    return res.status(400).json({ error: 'tradeDate 参数不合法' });
  }
  const parsedTradeDate = tradeDate ? new Date(`${tradeDate}T00:00:00Z`) : null;
  if (tradeDate && (Number.isNaN(parsedTradeDate.getTime()) || parsedTradeDate.toISOString().slice(0, 10) !== tradeDate)) {
    return res.status(400).json({ error: 'tradeDate 参数不合法' });
  }
  const detail = await getBondRevisionMotiveDetail({ tsCode, tradeDate });
  if (!detail) return res.status(404).json({ error: '尚无评分数据' });
  return res.json(detail);
}));

module.exports = router;

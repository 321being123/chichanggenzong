const express = require('express');
const asyncHandler = require('../middleware/async');
const { getBondRevisionOverview } = require('../services/convertibleBondRevisionService');

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

module.exports = router;

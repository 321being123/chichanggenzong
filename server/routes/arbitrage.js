// ========== 套利机会公开接口 ==========
const express = require('express');
const router = express.Router();
const asyncHandler = require('../middleware/async');
const svc = require('../services/arbitrageService');

// 列表
router.get('/', asyncHandler(async (req, res) => {
  const { type = 'a_stock', page = 1, page_size = 50 } = req.query;
  const result = await svc.getArbitrageList(type, parseInt(page), parseInt(page_size));
  res.json(result);
}));

// 详情
router.get('/:caseId', asyncHandler(async (req, res) => {
  const detail = await svc.getArbitrageDetail(parseInt(req.params.caseId));
  if (!detail) return res.status(404).json({ error: '未找到该套利事件或尚未审核通过' });
  res.json(detail);
}));

module.exports = router;

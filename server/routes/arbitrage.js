// ========== 套利机会公开接口 ==========
const express = require('express');
const router = express.Router();
const asyncHandler = require('../middleware/async');
const svc = require('../services/arbitrageService');
const { optionalLogin, requireLogin } = require('../middleware/auth');

// 列表
router.get('/', optionalLogin, asyncHandler(async (req, res) => {
  const { type = 'a_stock', page = 1, page_size = 50 } = req.query;
  const result = await svc.getArbitrageList(type, parseInt(page), parseInt(page_size), req.authUser && req.authUser.username);
  res.set('Cache-Control', 'private, no-store');
  res.json(result);
}));

router.get('/unread-count', optionalLogin, asyncHandler(async (req, res) => {
  const count = await svc.getArbitrageUnreadCount(req.authUser && req.authUser.username);
  res.set('Cache-Control', 'private, no-store');
  res.json({ unreadCount: count });
}));

// 详情
router.post('/:caseId/seen', requireLogin, asyncHandler(async (req, res) => {
  const caseId = Number(req.params.caseId);
  if (!/^[1-9]\d*$/.test(req.params.caseId) || !Number.isSafeInteger(caseId)) {
    return res.status(400).json({ error: '机会编号无效' });
  }
  const saved = await svc.markArbitrageSeen(req.authUser.username, caseId);
  if (!saved) return res.status(404).json({ error: '未找到该套利机会' });
  res.json({ ok: true, unreadCount: await svc.getArbitrageUnreadCount(req.authUser.username) });
}));

router.get('/:caseId', optionalLogin, asyncHandler(async (req, res) => {
  const detail = await svc.getArbitrageDetail(parseInt(req.params.caseId), req.authUser && req.authUser.username);
  if (!detail) return res.status(404).json({ error: '未找到该套利事件或尚未审核通过' });
  res.set('Cache-Control', 'private, no-store');
  res.json(detail);
}));

module.exports = router;

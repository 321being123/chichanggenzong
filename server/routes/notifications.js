// ========== 站内通知（前台，2026-10-25） ==========
// 契约：docs/意见反馈与版本发布闭环研发方案_20261023.md 第 14.3 / 14.7 节。
// 固定路径必须先于 /:id 注册；收件人身份只能来自会话，不接受请求体指定。
// 本人身份数据一律 private/no-store，禁止进入共享缓存。
const express = require('express');
const asyncHandler = require('../middleware/async');
const rateLimit = require('../middleware/rateLimit');
const { requireLogin } = require('../middleware/auth');
const service = require('../services/notificationService');

const router = express.Router();

function noStore(res) {
  res.setHeader('Cache-Control', 'private, no-store');
}

const readLimiter = rateLimit({
  prefix: 'notification-read', windowMs: 5 * 60 * 1000, max: 120,
  getKey: function (req) { return (req.authUser && req.authUser.username) || req.ip || ''; },
  message: '操作过于频繁，请稍后再试',
});

function actorName(req) {
  return (req.authUser && req.authUser.username) || null;
}

// ===== 固定路径（必须先于 /:id） =====
router.get('/unread-count', requireLogin, asyncHandler(async function (req, res) {
  noStore(res);
  res.json(await service.unreadCountSummary(actorName(req)));
}));

router.get('/', requireLogin, asyncHandler(async function (req, res) {
  noStore(res);
  res.json(await service.listInbox(actorName(req), req.query));
}));

router.post('/read-all', requireLogin, readLimiter, asyncHandler(async function (req, res) {
  const body = req.body || {};
  noStore(res);
  res.json(await service.markAllRead(actorName(req), body.category));
}));

// ===== 单条 =====
router.get('/:id', requireLogin, asyncHandler(async function (req, res) {
  noStore(res);
  res.json(await service.detail(actorName(req), req.params.id));
}));

router.post('/:id/read', requireLogin, readLimiter, asyncHandler(async function (req, res) {
  noStore(res);
  res.json(await service.markRead(actorName(req), req.params.id));
}));

module.exports = router;

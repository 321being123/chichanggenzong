// 公开网站统计入口：只接收白名单事件，游客和登录用户均可提交。
const express = require('express');
const router = express.Router();
const asyncHandler = require('../middleware/async');
const rateLimit = require('../middleware/rateLimit');
const { optionalLogin } = require('../middleware/auth');
const { ensureVisitorCookie, clearVisitorCookie, ingestTelemetry } = require('../services/siteAnalytics');

const ipLimit = rateLimit({
  prefix: 'site-telemetry-ip', windowMs: 60 * 1000, max: 60,
  getKey: req => req.ip || '0.0.0.0', message: '统计请求过于频繁，请稍后再试'
});
const visitorLimit = rateLimit({
  prefix: 'site-telemetry-visitor', windowMs: 60 * 1000, max: 30,
  getKey: req => req.analyticsIdentity && req.analyticsIdentity.visitorKey || req.ip || 'unknown',
  message: '统计请求过于频繁，请稍后再试'
});

router.post('/events', optionalLogin, function (req, res, next) {
  ensureVisitorCookie(req, res);
  next();
}, ipLimit, visitorLimit, asyncHandler(async (req, res) => {
  const events = req.body && req.body.events;
  const result = await ingestTelemetry(req, events);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, ...result });
}));

router.post('/opt-out', optionalLogin, ipLimit, function (req, res) {
  clearVisitorCookie(req, res);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true });
});

module.exports = router;

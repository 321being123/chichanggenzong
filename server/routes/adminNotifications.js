// ========== 后台站内通知群发接口（2026-10-25） ==========
// 契约：docs/意见反馈与版本发布闭环研发方案_20261023.md 第 14.5 / 14.7 节。
// 首期仅系统管理员：菜单、路径派发和本子路由三处都限定，内容管理员与其他员工不能群发。
// 审计只记动作/操作者/范围摘要/时间，绝不写通知正文或完整名单。
const express = require('express');
const asyncHandler = require('../middleware/async');
const { requireAdmin } = require('../middleware/auth');
const { auditEvent } = require('../db');
const service = require('../services/notificationBatchService');

const router = express.Router();
router.use(requireAdmin);

function noStore(res) { res.setHeader('Cache-Control', 'private, no-store'); }

function actor(req) {
  return { username: (req.session && req.session.user) || null };
}

function audit(req, action, target, detail, metadata) {
  return auditEvent({
    actor: req.session && req.session.user, action: action, target: String(target || ''),
    result: 'success', requestId: req.id, detail: detail, metadata: metadata,
  }).catch(function () {});
}

// ===== 收件人搜索（必须先于 /batches/:id 等固定段） =====
router.get('/recipients', asyncHandler(async function (req, res) {
  noStore(res);
  res.json(await service.searchRecipients(actor(req), req.query));
}));

router.post('/preview', asyncHandler(async function (req, res) {
  const body = req.body || {};
  const result = await service.previewBatch(actor(req), body);
  await audit(req, 'notification_preview', result.batchId,
    '生成站内通知发送草稿', { audienceMode: result.audienceMode, snapshotCount: result.snapshotCount });
  noStore(res);
  res.status(result.reused ? 200 : 201).json(result);
}));

router.get('/batches', asyncHandler(async function (req, res) {
  noStore(res);
  res.json(await service.listBatches(actor(req), req.query));
}));

router.get('/batches/:id', asyncHandler(async function (req, res) {
  noStore(res);
  res.json(await service.batchDetail(actor(req), req.params.id));
}));

router.get('/batches/:id/recipients', asyncHandler(async function (req, res) {
  noStore(res);
  res.json(await service.batchRecipients(actor(req), req.params.id, req.query));
}));

// 202 只表示已排队，不等于已投递、更不等于已读
router.post('/batches/:id/send', asyncHandler(async function (req, res) {
  const result = await service.sendBatch(actor(req), req.params.id, req.body || {});
  await audit(req, 'notification_send', req.params.id, '确认发送站内通知', {
    slotId: result.slotId || null, pendingCount: result.pendingCount || 0,
  });
  noStore(res);
  res.status(result.reused ? 200 : 202).json(result);
}));

router.post('/batches/:id/retry', asyncHandler(async function (req, res) {
  const result = await service.retryBatch(actor(req), req.params.id, req.body || {});
  await audit(req, 'notification_retry', req.params.id, '重试站内通知未完成投递', {
    slotId: result.slotId || null, merged: result.merged === true,
  });
  noStore(res);
  res.status(result.reused ? 200 : 202).json(result);
}));

router.post('/batches/:id/cancel', asyncHandler(async function (req, res) {
  const result = await service.cancelBatch(actor(req), req.params.id, req.body || {});
  await audit(req, 'notification_cancel', req.params.id, '取消站内通知草稿');
  noStore(res);
  res.json(result);
}));

module.exports = router;

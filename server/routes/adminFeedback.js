// ========== 后台反馈管理接口（2026-10-23） ==========
// 挂在现有 adminRouter 的员工/能力中间件之后；本文件自身再次要求 content_manage，
// 不另开绕过权限派发的平行入口。
const express = require('express');
const asyncHandler = require('../middleware/async');
const { requireCapability } = require('../middleware/auth');
const { auditEvent } = require('../db');
const service = require('../services/feedbackService');
const release = require('../services/feedbackRelease');

const router = express.Router();
router.use(requireCapability('content_manage'));

function noStore(res) { res.setHeader('Cache-Control', 'private, no-store'); }

function audit(req, action, target, detail) {
  return auditEvent({
    actor: req.session && req.session.user, action: action, target: String(target || ''),
    result: 'success', requestId: req.id, detail: detail,
  }).catch(function () {});
}

// ===== 发布批次（必须先于 /:id 注册） =====
router.get('/releases', asyncHandler(async function (req, res) {
  noStore(res);
  res.json(await release.listRuns(req.query));
}));

router.post('/releases', asyncHandler(async function (req, res) {
  const body = req.body || {};
  const actor = service.actorFromRequest(req);
  const result = await release.prepareRun({
    deploymentId: body.deploymentId, releaseSha: body.releaseSha, appVersion: body.appVersion,
    baseDeployedSha: body.baseDeployedSha, owner: body.owner || (req.authUser && req.authUser.username),
  });
  await audit(req, 'feedback_release_prepare', result.runId, '准备发布核对清单');
  noStore(res);
  res.status(result.reused ? 200 : 201).json(result);
}));

router.get('/releases/:runId', asyncHandler(async function (req, res) {
  noStore(res);
  res.json(await release.status(req.params.runId));
}));

router.get('/releases/:runId/items', asyncHandler(async function (req, res) {
  noStore(res);
  res.json(await release.listItems(req.params.runId, req.query));
}));

// ===== 反馈列表与详情 =====
router.get('/', asyncHandler(async function (req, res) {
  const actor = service.actorFromRequest(req);
  noStore(res);
  res.json(await service.adminList(actor, req.query));
}));

router.get('/:id', asyncHandler(async function (req, res) {
  const actor = service.actorFromRequest(req);
  noStore(res);
  res.json(await service.adminDetail(req.params.id, actor));
}));

router.patch('/:id', asyncHandler(async function (req, res) {
  const actor = service.actorFromRequest(req);
  const body = req.body || {};
  const result = await service.adminUpdate(req.params.id, actor, body);
  await audit(req, 'feedback_update', req.params.id, '更新反馈处理信息');
  noStore(res);
  res.json(result);
}));

// ===== 回复隐藏/恢复 =====
router.patch('/:id/comments/:commentId', asyncHandler(async function (req, res) {
  const actor = service.actorFromRequest(req);
  const body = req.body || {};
  const result = await service.moderateComment(req.params.id, req.params.commentId, actor, body.action, body.reason);
  await audit(req, 'feedback_comment_' + (body.action === 'hide' ? 'hide' : 'restore'), req.params.commentId,
    body.action === 'hide' ? '隐藏违规回复' : '恢复被隐藏回复');
  noStore(res);
  res.json(result);
}));

module.exports = router;

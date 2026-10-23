// ========== 反馈接口（前台，2026-10-23） ==========
// 契约：docs/意见反馈与版本发布闭环研发方案_20261023.md 第六节。
// 固定路径必须先于 /:id 注册；作者身份只能来自会话，不接受请求体传入。
const express = require('express');
const asyncHandler = require('../middleware/async');
const multer = require('multer');
const rateLimit = require('../middleware/rateLimit');
const { requireLogin, optionalLogin } = require('../middleware/auth');
const service = require('../services/feedbackService');

const router = express.Router();

// ---------- 上传：内存暂存，原图不落盘 ----------
const uploader = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: service.MAX_FILE_BYTES,
    files: service.MAX_IMAGES,
    fields: 12,
    fieldSize: 64 * 1024,
    parts: 24,
  },
}).array('images', service.MAX_IMAGES);

function uploadMiddleware(req, res, next) {
  uploader(req, res, function (err) {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: '单张图片不能超过 2MB', requestId: req.id });
    if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ error: '最多上传 3 张截图', requestId: req.id });
    }
    if (err.code === 'LIMIT_FIELD_VALUE' || err.code === 'LIMIT_FIELD_COUNT' || err.code === 'LIMIT_PART_COUNT') {
      return res.status(413).json({ error: '提交内容过大，请精简文字或减少图片', requestId: req.id });
    }
    return res.status(400).json({ error: '上传内容无法解析', requestId: req.id });
  });
}

// 总请求字节计数：不信任 Content-Length，按实际接收量复核
function requestBytesGuard(req, res, next) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > service.MAX_REQUEST_BYTES) {
    return res.status(413).json({ error: '本次提交内容过大，请减少图片或文字', requestId: req.id });
  }
  let actual = 0;
  (req.files || []).forEach(function (f) { actual += f.size || 0; });
  Object.keys(req.body || {}).forEach(function (k) { actual += Buffer.byteLength(String(req.body[k] || '')); });
  if (actual > service.MAX_REQUEST_BYTES) {
    return res.status(413).json({ error: '本次提交内容过大，请减少图片或文字', requestId: req.id });
  }
  next();
}

// 个人状态响应禁止共享缓存
function noStore(res) {
  res.setHeader('Cache-Control', 'private, no-store');
}

const createLimiter = rateLimit({
  prefix: 'feedback-create', windowMs: 10 * 60 * 1000, max: 5,
  getKey: function (req) { return (req.authUser && req.authUser.username) || req.ip || ''; },
  message: '提交过于频繁，请 10 分钟后再试',
});
const commentLimiter = rateLimit({
  prefix: 'feedback-comment', windowMs: 5 * 60 * 1000, max: 10,
  getKey: function (req) { return (req.authUser && req.authUser.username) || req.ip || ''; },
  message: '回复过于频繁，请稍后再试',
});

// ===== 固定路径（必须先于 /:id） =====
router.get('/', optionalLogin, asyncHandler(async function (req, res) {
  const data = await service.listPublic(req.query);
  res.json(data);
}));

router.get('/mine', requireLogin, asyncHandler(async function (req, res) {
  noStore(res);
  const actor = service.actorFromRequest(req);
  res.json(await service.listMine(actor, req.query));
}));

router.get('/counts', optionalLogin, asyncHandler(async function (req, res) {
  const actor = service.actorFromRequest(req);
  const scope = req.query.scope === 'mine' ? 'mine' : 'public';
  noStore(res);
  res.json(await service.counts(actor, req.query, scope));
}));

router.get('/ranking', optionalLogin, asyncHandler(async function (req, res) {
  const actor = service.actorFromRequest(req);
  res.json(await service.ranking(actor, req.query));
}));

router.get('/version-links', asyncHandler(async function (req, res) {
  const raw = String(req.query.versions || '');
  const versions = raw.split(',').map(function (v) { return v.trim(); }).filter(Boolean).slice(0, 50);
  res.json({ map: await service.versionLinkMap(versions) });
}));

// 受保护图片读取：权限跟随主记录，首期统一 no-store
router.get('/attachments/:id', optionalLogin, asyncHandler(async function (req, res) {
  const actor = service.actorFromRequest(req);
  const file = await service.readAttachment(req.params.id, actor, { history: false });
  res.setHeader('Content-Type', file.mimeType || 'image/webp');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', 'inline');
  noStore(res);
  res.sendFile(file.filePath);
}));
// ===== 单条 =====
router.get('/:id', optionalLogin, asyncHandler(async function (req, res) {
  const actor = service.actorFromRequest(req);
  noStore(res);
  res.json(await service.detail(req.params.id, actor));
}));

router.post('/', requireLogin, createLimiter, uploadMiddleware, requestBytesGuard, asyncHandler(async function (req, res) {
  const actor = service.actorFromRequest(req);
  const body = req.body || {};
  const result = await service.createFeedback(actor, {
    type: body.type, title: body.title, description: body.description,
    pagePath: body.pagePath, visibility: body.visibility,
    submittedVersion: body.submittedVersion, clientRequestId: body.clientRequestId,
  }, req.files);
  noStore(res);
  res.status(result.created === false ? 200 : 201).json({
    id: result.id, revision: result.revision, duplicated: result.created === false,
  });
}));

router.patch('/:id', requireLogin, asyncHandler(async function (req, res) {
  const actor = service.actorFromRequest(req);
  const body = req.body || {};
  const result = await service.updateOwn(req.params.id, actor, {
    title: body.title, description: body.description, type: body.type, pagePath: body.pagePath,
  }, body.expectedRevision);
  noStore(res);
  res.json(result);
}));

router.post('/:id/withdraw', requireLogin, asyncHandler(async function (req, res) {
  const actor = service.actorFromRequest(req);
  const result = await service.withdraw(req.params.id, actor, (req.body || {}).expectedRevision);
  noStore(res);
  res.json(result);
}));

router.patch('/:id/visibility', requireLogin, asyncHandler(async function (req, res) {
  const actor = service.actorFromRequest(req);
  const body = req.body || {};
  const result = await service.setVisibility(req.params.id, actor, body.visibility, body.expectedRevision);
  noStore(res);
  res.json(result);
}));

router.post('/:id/complete-info', requireLogin, asyncHandler(async function (req, res) {
  const actor = service.actorFromRequest(req);
  const result = await service.completeInfo(req.params.id, actor, (req.body || {}).expectedRevision);
  noStore(res);
  res.json(result);
}));

router.get('/:id/events', optionalLogin, asyncHandler(async function (req, res) {
  const actor = service.actorFromRequest(req);
  const data = await service.detail(req.params.id, actor);
  noStore(res);
  res.json({ events: data.events });
}));

// ===== 附件增删与历史读取 =====
router.post('/:id/attachments', requireLogin, uploadMiddleware, requestBytesGuard, asyncHandler(async function (req, res) {
  const actor = service.actorFromRequest(req);
  const body = req.body || {};
  const result = await service.addAttachments(req.params.id, actor, req.files, body.expectedRevision, body.clientRequestId);
  noStore(res);
  res.status(result.created === false ? 200 : 201).json(result);
}));

router.delete('/:id/attachments/:attachmentId', requireLogin, asyncHandler(async function (req, res) {
  const actor = service.actorFromRequest(req);
  const expected = (req.body && req.body.expectedRevision) || req.query.expectedRevision;
  const result = await service.deleteAttachment(req.params.id, req.params.attachmentId, actor, expected);
  noStore(res);
  res.json(result);
}));

// 旧修订附件：仅作者与内容管理员可读，统一 404 掩盖存在性
router.get('/:id/attachments/:attachmentId/history', optionalLogin, asyncHandler(async function (req, res) {
  const actor = service.actorFromRequest(req);
  const file = await service.readAttachment(req.params.attachmentId, actor, {
    history: true, expectedFeedbackId: req.params.id,
  });
  res.setHeader('Content-Type', file.mimeType || 'image/webp');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  noStore(res);
  res.sendFile(file.filePath);
}));

// ===== 回复 =====
router.get('/:id/comments', optionalLogin, asyncHandler(async function (req, res) {
  const actor = service.actorFromRequest(req);
  const data = await service.detail(req.params.id, actor);
  noStore(res);
  res.json({ comments: data.comments, revision: data.feedback.revision });
}));

router.post('/:id/comments', requireLogin, commentLimiter, asyncHandler(async function (req, res) {
  const actor = service.actorFromRequest(req);
  const body = req.body || {};
  const result = await service.addComment(req.params.id, actor, body.content, body.clientRequestId);
  noStore(res);
  res.status(result.created === false ? 200 : 201).json(result);
}));

router.delete('/:id/comments/:commentId', requireLogin, asyncHandler(async function (req, res) {
  const actor = service.actorFromRequest(req);
  const result = await service.deleteOwnComment(req.params.id, req.params.commentId, actor);
  noStore(res);
  res.json(result);
}));

module.exports = router;

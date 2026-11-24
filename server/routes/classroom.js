'use strict';

const express = require('express');
const asyncHandler = require('../middleware/async');
const { requireLogin, requireAdmin } = require('../middleware/auth');
const classroomService = require('../services/classroomService');
const precheckService = require('../services/classroomPrecheckService');
const sseHub = require('../services/classroomSseHub');
const repo = require('../repositories/classroomRepository');

const router = express.Router();

function resolveOrigin(req) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.get('host') || '').split(',')[0].trim();
  return host ? `${proto}://${host}` : '';
}

function handleServiceError(err, res, next) {
  if (err && err.status) {
    const body = { error: err.message };
    if (err.extra) Object.assign(body, err.extra);
    return res.status(err.status).json(body);
  }
  return next(err);
}

// ---------- 教师 / 管理员接口（必须 requireLogin + requireAdmin）----------

router.get('/admin/creation-options', requireLogin, requireAdmin, asyncHandler(async (req, res, next) => {
  try {
    const startYear = req.query.startYear ? Number(req.query.startYear) : null;
    const out = await precheckService.getCreationOptions({ startYear });
    res.json(out);
  } catch (err) {
    handleServiceError(err, res, next);
  }
}));

router.post('/admin/sample', requireLogin, requireAdmin, asyncHandler(async (req, res, next) => {
  try {
    const { startYear = 2011, lockedGroups = [], targetGroupIndex = null, excludeComboKey = null, seed = null } = req.body || {};
    const out = await precheckService.sampleRealClassroomSelection({
      startYear: Number(startYear),
      lockedGroups,
      targetGroupIndex,
      excludeComboKey,
      seed,
    });
    res.json(out);
  } catch (err) {
    handleServiceError(err, res, next);
  }
}));

router.post('/admin/preview', requireLogin, requireAdmin, asyncHandler(async (req, res, next) => {
  try {
    const {
      title,
      mode = 'demo',
      blindMode = true,
      startYear = 2011,
      industries = null,
      demoVariant = 'fixed',
      demoSeed = null,
    } = req.body || {};
    const out = await classroomService.createCreationPreview({
      adminUser: req.authUser,
      title,
      mode,
      blindMode,
      startYear,
      industries,
      demoVariant,
      demoSeed,
    });
    res.json(out);
  } catch (err) {
    handleServiceError(err, res, next);
  }
}));

router.post('/admin/confirm', requireLogin, requireAdmin, asyncHandler(async (req, res, next) => {
  try {
    const { previewId, confirmRequestId = null } = req.body || {};
    const out = await classroomService.confirmCreationPreview({
      adminUser: req.authUser,
      previewId,
      confirmRequestId,
      origin: resolveOrigin(req),
    });
    res.status(out.idempotentReplay ? 200 : 201).json(out);
  } catch (err) {
    handleServiceError(err, res, next);
  }
}));

router.post('/admin/precheck', requireLogin, requireAdmin, asyncHandler(async (req, res) => {
  const { industries, startYear = 2011, totalRounds = 15, autoBackfill = true } = req.body || {};
  const result = await precheckService.ensureRealClassroomDataAndPrecheck({
    industries,
    startYear: Number(startYear),
    totalRounds: Number(totalRounds),
    autoBackfill: autoBackfill !== false,
  });
  res.json(result);
}));

router.get('/admin/list', requireLogin, requireAdmin, asyncHandler(async (req, res) => {
  const result = await repo.listClassroomsForAdmin({
    page: req.query.page,
    pageSize: req.query.pageSize,
  });
  res.json(result);
}));

router.post('/admin/create', requireLogin, requireAdmin, asyncHandler(async (req, res, next) => {
  try {
    const {
      title,
      mode = 'demo',
      blindMode = true,
      startYear = 2011,
      industries = null,
      demoVariant = 'fixed',
      demoSeed = null,
      previewId = null,
      confirmRequestId = null,
    } = req.body || {};
    const out = await classroomService.createClassroom({
      adminUser: req.authUser,
      title,
      mode,
      blindMode,
      startYear,
      industries,
      demoVariant,
      demoSeed,
      previewId,
      confirmRequestId,
      origin: resolveOrigin(req),
    });
    res.status(out.idempotentReplay ? 200 : 201).json(out);
  } catch (err) {
    handleServiceError(err, res, next);
  }
}));

router.get('/admin/:id/state', requireLogin, requireAdmin, asyncHandler(async (req, res, next) => {
  try {
    const out = await classroomService.getTeacherState({
      classroomId: Number(req.params.id),
      origin: resolveOrigin(req),
    });
    res.json(out);
  } catch (err) {
    handleServiceError(err, res, next);
  }
}));

router.get('/admin/:id/projector', requireLogin, requireAdmin, asyncHandler(async (req, res, next) => {
  try {
    const roundNo = req.query.roundNo ? Number(req.query.roundNo) : null;
    const out = await classroomService.getProjectorState({
      classroomId: Number(req.params.id),
      roundNo,
    });
    res.json(out);
  } catch (err) {
    handleServiceError(err, res, next);
  }
}));

router.post('/admin/:id/rounds/:roundNo/open', requireLogin, requireAdmin, asyncHandler(async (req, res, next) => {
  try {
    const out = await classroomService.openRound({
      classroomId: Number(req.params.id),
      roundNo: Number(req.params.roundNo),
      expectedStateVersion: req.body ? req.body.expectedStateVersion : undefined,
    });
    res.json({ classroom: out });
  } catch (err) {
    handleServiceError(err, res, next);
  }
}));

router.post('/admin/:id/rounds/:roundNo/lock', requireLogin, requireAdmin, asyncHandler(async (req, res, next) => {
  try {
    const out = await classroomService.lockRound({
      classroomId: Number(req.params.id),
      roundNo: Number(req.params.roundNo),
      expectedStateVersion: req.body ? req.body.expectedStateVersion : undefined,
    });
    res.json({ classroom: out });
  } catch (err) {
    handleServiceError(err, res, next);
  }
}));

router.post('/admin/:id/rounds/:roundNo/unlock', requireLogin, requireAdmin, asyncHandler(async (req, res, next) => {
  try {
    const out = await classroomService.unlockRound({
      classroomId: Number(req.params.id),
      roundNo: Number(req.params.roundNo),
      expectedStateVersion: req.body ? req.body.expectedStateVersion : undefined,
    });
    res.json({ classroom: out });
  } catch (err) {
    handleServiceError(err, res, next);
  }
}));

router.post('/admin/:id/rounds/:roundNo/reveal', requireLogin, requireAdmin, asyncHandler(async (req, res, next) => {
  try {
    const out = await classroomService.revealRound({
      classroomId: Number(req.params.id),
      roundNo: Number(req.params.roundNo),
      expectedStateVersion: req.body ? req.body.expectedStateVersion : undefined,
    });
    res.json({ classroom: out });
  } catch (err) {
    handleServiceError(err, res, next);
  }
}));

router.post('/admin/:id/reveal-identity', requireLogin, requireAdmin, asyncHandler(async (req, res, next) => {
  try {
    const out = await classroomService.revealIdentity({ classroomId: Number(req.params.id) });
    res.json({ classroom: out });
  } catch (err) {
    handleServiceError(err, res, next);
  }
}));

router.patch('/admin/:id/members/:memberId/nickname', requireLogin, requireAdmin, asyncHandler(async (req, res, next) => {
  try {
    const { displayNickname, isMasked } = req.body || {};
    const member = await classroomService.manageMemberNickname({
      classroomId: Number(req.params.id),
      memberId: Number(req.params.memberId),
      displayNickname,
      isMasked,
    });
    res.json({ member });
  } catch (err) {
    handleServiceError(err, res, next);
  }
}));

router.post('/admin/:id/close', requireLogin, requireAdmin, asyncHandler(async (req, res, next) => {
  try {
    const out = await classroomService.closeClassroom({ classroomId: Number(req.params.id) });
    res.json({ classroom: out });
  } catch (err) {
    handleServiceError(err, res, next);
  }
}));

router.delete('/admin/:id', requireLogin, requireAdmin, asyncHandler(async (req, res, next) => {
  try {
    const deleted = await classroomService.deleteClassroom({ classroomId: Number(req.params.id) });
    res.json({ ok: true, deleted });
  } catch (err) {
    handleServiceError(err, res, next);
  }
}));

// ---------- 学员端接口（requireLogin）----------

router.get('/my', requireLogin, asyncHandler(async (req, res) => {
  const items = await classroomService.listMyClassrooms(req.authUser.subject_identity);
  res.json({ items });
}));

router.get('/by-code/:code', requireLogin, asyncHandler(async (req, res, next) => {
  try {
    const classroom = await classroomService.resolveByCode(req.params.code);
    res.json({ classroom });
  } catch (err) {
    handleServiceError(err, res, next);
  }
}));

router.post('/:id/join', requireLogin, asyncHandler(async (req, res, next) => {
  try {
    const out = await classroomService.joinClassroom({
      classroomId: Number(req.params.id),
      authUser: req.authUser,
      nickname: req.body && req.body.nickname,
    });
    res.json(out);
  } catch (err) {
    handleServiceError(err, res, next);
  }
}));

router.get('/:id/state', requireLogin, asyncHandler(async (req, res, next) => {
  try {
    const out = await classroomService.getStudentState({
      classroomId: Number(req.params.id),
      authUser: req.authUser,
    });
    res.json(out);
  } catch (err) {
    handleServiceError(err, res, next);
  }
}));

router.put('/:id/rounds/:roundNo/draft', requireLogin, asyncHandler(async (req, res, next) => {
  try {
    const out = await classroomService.saveDraft({
      classroomId: Number(req.params.id),
      roundNo: Number(req.params.roundNo),
      authUser: req.authUser,
      allocations: req.body && req.body.allocations,
      expectedVersion: req.body ? req.body.expectedVersion : 0,
    });
    res.json(out);
  } catch (err) {
    handleServiceError(err, res, next);
  }
}));

router.post('/:id/rounds/:roundNo/submit', requireLogin, asyncHandler(async (req, res, next) => {
  try {
    const out = await classroomService.submitAllocation({
      classroomId: Number(req.params.id),
      roundNo: Number(req.params.roundNo),
      authUser: req.authUser,
      allocations: req.body && req.body.allocations,
      clientRequestId: req.body && req.body.clientRequestId,
    });
    res.json(out);
  } catch (err) {
    handleServiceError(err, res, next);
  }
}));

router.get('/:id/history', requireLogin, asyncHandler(async (req, res, next) => {
  try {
    const out = await classroomService.getMemberHistory({
      classroomId: Number(req.params.id),
      authUser: req.authUser,
    });
    res.json(out);
  } catch (err) {
    handleServiceError(err, res, next);
  }
}));

router.get('/:id/report', requireLogin, asyncHandler(async (req, res, next) => {
  try {
    const out = await classroomService.getMemberReport({
      classroomId: Number(req.params.id),
      authUser: req.authUser,
    });
    res.json(out);
  } catch (err) {
    handleServiceError(err, res, next);
  }
}));

router.put('/:id/report/note', requireLogin, asyncHandler(async (req, res, next) => {
  try {
    const out = await classroomService.saveAfterClassNote({
      classroomId: Number(req.params.id),
      authUser: req.authUser,
      note: req.body && req.body.note,
    });
    res.json(out);
  } catch (err) {
    handleServiceError(err, res, next);
  }
}));

router.get('/:id/events', requireLogin, asyncHandler(async (req, res) => {
  const classroomId = Number(req.params.id);
  const classroom = await repo.findClassroomById(classroomId);
  if (!classroom) return res.status(404).json({ error: '场次不存在' });

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const initPayload = JSON.stringify({
    classroomId,
    roundNo: Number(classroom.current_round),
    stateVersion: Number(classroom.state_version),
    status: classroom.status,
  });
  res.write(`event: connected\ndata: ${initPayload}\n\n`);

  const unsubscribe = sseHub.subscribe(classroomId, res);
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch (e) {
      clearInterval(heartbeat);
      unsubscribe();
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}));

module.exports = router;

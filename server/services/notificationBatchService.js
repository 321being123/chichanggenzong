// ========== 站内通知后台群发（2026-10-25） ==========
// 契约：docs/意见反馈与版本发布闭环研发方案_20261023.md 第 14.5 / 14.6 节。
// 职责：纯文本标题/正文、三种范围、预览固定名单、确认发送、批次查询、重试与取消。
// 纪律：首期仅系统管理员；预览与发送都必须重验身份；逐操作幂等；确认与槽位关联同事务，
// 任何一步失败整体回滚，绝不留「无槽位的 queued 批次」。
const crypto = require('crypto');
const { pool } = require('../db');
const store = require('../db/notifications');
const { isAdminIdentity } = require('../middleware/auth');
const ns = require('./notificationService');
const txControl = require('../repositories/transactionControl');
const { lockRequest } = require('../repositories/notificationBatchServiceRepository.js');
const repository = require('../repositories/notificationBatchServiceRepository.js');

const AUDIENCE_MODES = ['all', 'selected', 'filter'];
const FILTER_ROLES = ['admin', 'user'];
const MAX_SELECTED = 2000;
const TITLE_MAX = 100;
const BODY_MAX = 2000;
// 批次可重试的状态：已确认但未全部完成
const RETRYABLE = ['queued', 'running', 'partial'];

function createError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}

// 收件槽位键：不含用户名的稳定摘要，确认后不重建，也不会因同名新账号复用得旧通知
function slotKeyFor(username) {
  return 'u:' + sha256(String(username || '')).slice(0, 32);
}

function requireRequestId(value) {
  const v = String(value || '').trim();
  if (!/^[A-Za-z0-9._:-]{8,64}$/.test(v)) throw createError(400, '缺少有效的 clientRequestId');
  return v;
}

function text(value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
}

// 日期范围按上海时区半开区间：from 含当日 00:00，to 不含次日 00:00
function shanghaiStart(value) {
  const raw = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  return new Date(raw + 'T00:00:00+08:00');
}
function shanghaiEndExclusive(value) {
  const start = shanghaiStart(value);
  if (!start) return null;
  return new Date(start.getTime() + 24 * 60 * 60 * 1000);
}

// 首期只允许系统管理员；内容管理员与其他员工不能群发
function assertAdminIdentityRecord(user) {
  if (!user) throw createError(403, '无权限：站内通知群发仅限系统管理员');
  if (user.status && user.status !== 'active') throw createError(403, '当前账号已被禁用，不能群发通知');
  if (!isAdminIdentity(user.username, user.role)) throw createError(403, '无权限：站内通知群发仅限系统管理员');
}

async function assertAdmin(actor, db) {
  if (!actor || !actor.username) throw createError(401, '请先登录');
  const conn = db || pool;
  const { rows } = await repository.select_public_users([actor.username], conn);
  assertAdminIdentityRecord(rows[0] ? Object.assign({}, rows[0], { username: actor.username }) : null);
}

// 筛选参数白名单：未识别的键一律忽略，非法值直接拒绝，避免拼出未定义口径
function normalizeFilter(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const filter = {};
  if (input.role != null && String(input.role).trim() !== '') {
    const role = String(input.role).trim();
    if (FILTER_ROLES.indexOf(role) < 0) throw createError(400, '角色筛选不合法');
    filter.role = role;
  }
  const from = shanghaiStart(input.registeredFrom);
  const to = shanghaiEndExclusive(input.registeredTo);
  if (from) filter.registeredFrom = from;
  if (to) filter.registeredTo = to;
  const loginFrom = shanghaiStart(input.lastLoginFrom);
  const loginTo = shanghaiEndExclusive(input.lastLoginTo);
  if (loginFrom) filter.lastLoginFrom = loginFrom;
  if (loginTo) filter.lastLoginTo = loginTo;
  if (input.everLoggedIn === true || input.everLoggedIn === false) filter.everLoggedIn = input.everLoggedIn;
  if (input.submittedFeedback === true || input.submittedFeedback === false) {
    filter.submittedFeedback = input.submittedFeedback;
  }
  return filter;
}

function serializeFilter(filter) {
  const out = {};
  Object.keys(filter).forEach(function (k) {
    const v = filter[k];
    out[k] = v instanceof Date ? v.toISOString() : v;
  });
  return out;
}

// 内容 + 范围的摘要：预览后改内容或改范围都必须重新预览
function contentAudienceHash(title, body, mode, usernames) {
  return sha256(JSON.stringify({
    title: title, body: body, mode: mode, audience: usernames.slice().sort(),
  }));
}

async function resolveAudience(db, mode, input) {
  // 名单统一返回 {username, identity}：身份随名单一起固定，投递前用它拒绝同名新账号
  if (mode === 'all') return store.listAudience(db, {});
  if (mode === 'filter') return store.listAudience(db, normalizeFilter(input.filters));
  // selected：服务端去重并校验账号真实存在且启用，不接受请求体直接当收件人
  const raw = Array.isArray(input.usernames) ? input.usernames : [];
  const seen = new Set();
  const picked = [];
  raw.forEach(function (u) {
    const name = String(u || '').trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    picked.push(name);
  });
  if (!picked.length) return [];
  if (picked.length > MAX_SELECTED) throw createError(400, '一次性最多指定 ' + MAX_SELECTED + ' 个账号');
  return store.listActiveAccounts(db, picked);
}

// 同一请求标识串行化：并发提交同一 clientRequestId 时，后者等到前者提交后能读到原结果，
// 不会重复建批次，也不会把「复用的成功」误报成 409。
/* lockRequest 已迁入 server/repositories/notificationBatchServiceRepository.js */

async function findReplay(db, batchId, actorUsername, operation, clientRequestId, requestHash) {
  const existing = await store.findOperation(db, batchId, actorUsername, operation, clientRequestId);
  if (!existing) return null;
  if (String(existing.requestHash || '') !== String(requestHash || '')) {
    throw createError(409, '相同请求标识但内容不同，请使用新的 clientRequestId');
  }
  return existing.result;
}

// ---------- 预览 ----------
async function previewBatch(actor, input) {
  await assertAdmin(actor);
  const body = input || {};
  const clientRequestId = requireRequestId(body.clientRequestId);
  const title = text(body.title, TITLE_MAX);
  const content = text(body.body, BODY_MAX);
  if (!title) throw createError(400, '通知标题不能为空（最多 ' + TITLE_MAX + ' 字）');
  const mode = String(body.audienceMode || '').trim();
  if (AUDIENCE_MODES.indexOf(mode) < 0) throw createError(400, '发送范围不合法');
  const filter = mode === 'filter' ? normalizeFilter(body.filters) : {};
  const requestHash = sha256(JSON.stringify({
    title: title, body: content, mode: mode, filter: serializeFilter(filter),
    usernames: Array.isArray(body.usernames) ? body.usernames : [],
  }));

  const client = await pool.connect();
  try {
    await txControl.begin(client);
    await lockRequest(client, actor.username, 'preview', clientRequestId);
    const replay = await findReplay(client, null, actor.username, 'preview', clientRequestId, requestHash);
    if (replay) {
      await txControl.rollback(client);
      return Object.assign({}, replay, { reused: true });
    }
    await assertAdmin(actor, client);
    const accounts = await resolveAudience(client, mode, body);
    const usernames = accounts.map(function (a) { return a.username; });
    const hash = contentAudienceHash(title, content, mode, usernames);
    // 通知内容与批次在同事务生成：预览结果本身就是可发送的草稿
    const notification = await store.insertNotification(client, {
      type: 'system',
      title: title,
      body: content,
      targetKind: 'none',
      targetId: '',
      dedupeKey: 'system.batch:' + crypto.randomUUID(),
      payload: { audienceMode: mode, filter: serializeFilter(filter) },
    });
    if (!notification) throw createError(500, '通知草稿创建失败');
    const batch = await store.insertBatch(client, {
      notificationId: notification.id,
      creatorUsername: actor.username,
      audienceMode: mode,
      filterSnapshot: { filter: serializeFilter(filter) },
      contentAudienceHash: hash,
      revision: 1,
      snapshotCount: accounts.length,
    });
    const inserted = await store.insertRecipientsBulk(client, notification.id, accounts.map(function (a) {
      return { slotKey: slotKeyFor(a.username), username: a.username, identity: a.identity };
    }));
    // 计数以收件表实际数据为准，不用内存长度推断
    const counts = await store.countRecipients(client, notification.id);
    await store.updateBatch(client, batch.id, {
      snapshotCount: counts.total, pendingCount: counts.pending, remainingCount: counts.pending,
    });
    const result = {
      batchId: batch.id,
      revision: batch.revision,
      notificationId: notification.id,
      audienceMode: mode,
      snapshotCount: counts.total,
      pendingCount: counts.pending,
      contentAudienceHash: hash,
      status: 'draft',
      insertedRecipients: inserted,
    };
    // 首次预览没有批次号：按操作者＋操作＋请求标识去重（不能靠 NULL 批次做唯一约束）
    await store.insertOperation(client, {
      batchId: null, actorUsername: actor.username, operation: 'preview',
      clientRequestId: clientRequestId, requestHash: requestHash, result: result,
    });
    await txControl.commit(client);
    return result;
  } catch (e) {
    await txControl.rollback(client).catch(function () {});
    throw e;
  } finally {
    client.release();
  }
}

// ---------- 确认发送 ----------
async function sendBatch(actor, batchId, input) {
  await assertAdmin(actor);
  const body = input || {};
  const clientRequestId = requireRequestId(body.clientRequestId);
  const id = String(batchId || '');
  if (!/^\d{1,19}$/.test(id)) throw createError(404, '发送批次不存在');
  const expectedRevision = String(body.revision == null ? '' : body.revision).trim();
  const expectedHash = String(body.contentAudienceHash || '').trim();
  if (!expectedRevision || !expectedHash) throw createError(400, '缺少批次修订号或内容摘要，请重新预览');
  const requestHash = sha256(JSON.stringify({ batchId: id, revision: expectedRevision, hash: expectedHash }));

  const client = await pool.connect();
  try {
    await txControl.begin(client);
    await lockRequest(client, actor.username, 'send', clientRequestId);
    const replay = await findReplay(client, id, actor.username, 'send', clientRequestId, requestHash);
    if (replay) {
      await txControl.rollback(client);
      return Object.assign({}, replay, { reused: true });
    }
    await assertAdmin(actor, client);
    // 批次行锁：send 与 cancel 竞争，只有一方能改变 draft
    const batch = await store.lockBatch(client, id);
    if (!batch) throw createError(404, '发送批次不存在');
    // 等行锁期间同标识请求可能已提交：拿到锁后必须复检，复用原结果而不是报 409
    const replayAfterLock = await findReplay(client, id, actor.username, 'send', clientRequestId, requestHash);
    if (replayAfterLock) {
      await txControl.rollback(client);
      return Object.assign({}, replayAfterLock, { reused: true });
    }
    if (batch.status !== 'draft') throw createError(409, '该批次已确认或已取消，不能重复发送');
    if (String(batch.revision) !== expectedRevision) {
      throw createError(409, '批次修订号已变化，请重新预览');
    }
    if (String(batch.contentAudienceHash) !== expectedHash) {
      throw createError(409, '通知内容或发送范围已变化，请重新预览后再发送');
    }
    if (Number(batch.pendingCount) <= 0) throw createError(409, '该批次没有可发送的收件人');
    // 确认同事务建立槽位：失败整体回滚，不留无槽位 queued
    const slot = await enqueueDispatchSlot(client, id);
    const updated = await store.updateBatch(client, id, {
      status: 'queued',
      dispatchSlotId: slot.slot_id,
      dispatchGeneration: Number(batch.dispatchGeneration || 0) + 1,
      scanRound: Math.max(Number(batch.scanRound || 0), 1),
      cursor: null,
      nextAttemptAt: null,
      confirmedAt: new Date(),
    });
    if (!updated) throw createError(500, '批次状态更新失败');
    const result = {
      batchId: id, status: 'queued', slotId: String(slot.slot_id),
      revision: String(updated.revision),
      pendingCount: Number(batch.pendingCount),
    };
    await store.insertOperation(client, {
      batchId: id, actorUsername: actor.username, operation: 'send',
      clientRequestId: clientRequestId, requestHash: requestHash, result: result,
    });
    await txControl.commit(client);
    return result;
  } catch (e) {
    await txControl.rollback(client).catch(function () {});
    throw e;
  } finally {
    client.release();
  }
}

// 槽位创建统一走现有任务框架（不新建第二队列/调度器）
async function enqueueDispatchSlot(client, batchId) {
  const { enqueueManualJob } = require('./jobScheduleSlots');
  const slot = await enqueueManualJob('notification_dispatch', { batchId: String(batchId) }, client);
  if (!slot) throw createError(500, '通知投递任务未注册，无法建立调度槽位');
  return slot;
}

// ---------- 重试 ----------
async function retryBatch(actor, batchId, input) {
  await assertAdmin(actor);
  const body = input || {};
  const clientRequestId = requireRequestId(body.clientRequestId);
  const id = String(batchId || '');
  if (!/^\d{1,19}$/.test(id)) throw createError(404, '发送批次不存在');
  const requestHash = sha256(JSON.stringify({ batchId: id, op: 'retry' }));

  const client = await pool.connect();
  try {
    await txControl.begin(client);
    await lockRequest(client, actor.username, 'retry', clientRequestId);
    const replay = await findReplay(client, id, actor.username, 'retry', clientRequestId, requestHash);
    if (replay) {
      await txControl.rollback(client);
      return Object.assign({}, replay, { reused: true });
    }
    await assertAdmin(actor, client);
    const batch = await store.lockBatch(client, id);
    if (!batch) throw createError(404, '发送批次不存在');
    const replayAfterLock = await findReplay(client, id, actor.username, 'retry', clientRequestId, requestHash);
    if (replayAfterLock) {
      await txControl.rollback(client);
      return Object.assign({}, replayAfterLock, { reused: true });
    }
    if (RETRYABLE.indexOf(batch.status) < 0) throw createError(409, '该批次当前状态不能重试');
    // 已有活动槽位时合并请求，不新增第二个槽位、不重复投递已完成的收件
    if (batch.dispatchSlotId) {
      const slot = await repository.select_ops_job_schedule_slots([batch.dispatchSlotId], client);
      const current = slot.rows[0];
      if (current && ['pending', 'running', 'waiting_external'].indexOf(current.status) >= 0) {
        const merged = {
          batchId: id, status: batch.status, slotId: String(current.slot_id),
          merged: true, pendingCount: Number(batch.pendingCount),
        };
        await store.insertOperation(client, {
          batchId: id, actorUsername: actor.username, operation: 'retry',
          clientRequestId: clientRequestId, requestHash: requestHash, result: merged,
        });
        await txControl.commit(client);
        return merged;
      }
    }
    const slot = await enqueueDispatchSlot(client, id);
    await store.updateBatch(client, id, {
      status: 'queued',
      dispatchSlotId: slot.slot_id,
      dispatchGeneration: Number(batch.dispatchGeneration || 0) + 1,
      scanRound: Number(batch.scanRound || 0) + 1,
      cursor: null,
      nextAttemptAt: null,
    });
    // 新一轮只处理 pending/failed；delivered/skipped 不再重投
    await store.resetRecipientScanRound(client, batch.notificationId);
    const result = {
      batchId: id, status: 'queued', slotId: String(slot.slot_id),
      scanRound: Number(batch.scanRound || 0) + 1, pendingCount: Number(batch.pendingCount),
    };
    await store.insertOperation(client, {
      batchId: id, actorUsername: actor.username, operation: 'retry',
      clientRequestId: clientRequestId, requestHash: requestHash, result: result,
    });
    await txControl.commit(client);
    return result;
  } catch (e) {
    await txControl.rollback(client).catch(function () {});
    throw e;
  } finally {
    client.release();
  }
}

// ---------- 取消 ----------
async function cancelBatch(actor, batchId, input) {
  await assertAdmin(actor);
  const body = input || {};
  const clientRequestId = requireRequestId(body.clientRequestId);
  const id = String(batchId || '');
  if (!/^\d{1,19}$/.test(id)) throw createError(404, '发送批次不存在');
  const requestHash = sha256(JSON.stringify({ batchId: id, op: 'cancel' }));

  const client = await pool.connect();
  try {
    await txControl.begin(client);
    await lockRequest(client, actor.username, 'cancel', clientRequestId);
    const replay = await findReplay(client, id, actor.username, 'cancel', clientRequestId, requestHash);
    if (replay) {
      await txControl.rollback(client);
      return Object.assign({}, replay, { reused: true });
    }
    await assertAdmin(actor, client);
    const batch = await store.lockBatch(client, id);
    if (!batch) throw createError(404, '发送批次不存在');
    const replayAfterLock = await findReplay(client, id, actor.username, 'cancel', clientRequestId, requestHash);
    if (replayAfterLock) {
      await txControl.rollback(client);
      return Object.assign({}, replayAfterLock, { reused: true });
    }
    // 仅草稿可取消；queued/running/partial 不可取消（已进入投递）
    if (batch.status !== 'draft') throw createError(409, '只有未确认的草稿可以取消');
    await store.updateBatch(client, id, { status: 'cancelled' });
    // 草稿取消后同步失效通知内容，避免它出现在任何查询里
    await store.invalidateNotification(client, batch.notificationId, '发送草稿已取消');
    const result = { batchId: id, status: 'cancelled' };
    await store.insertOperation(client, {
      batchId: id, actorUsername: actor.username, operation: 'cancel',
      clientRequestId: clientRequestId, requestHash: requestHash, result: result,
    });
    await txControl.commit(client);
    return result;
  } catch (e) {
    await txControl.rollback(client).catch(function () {});
    throw e;
  } finally {
    client.release();
  }
}

// ---------- 查询 ----------
async function searchRecipients(actor, query) {
  await assertAdmin(actor);
  const limit = Math.min(Math.max(parseInt((query || {}).limit, 10) || 20, 1), 50);
  const offset = Math.max(parseInt((query || {}).offset, 10) || 0, 0);
  return store.searchUsers(pool, (query || {}).q, limit, offset);
}

async function listBatches(actor, query) {
  await assertAdmin(actor);
  const pageSize = Math.min(Math.max(parseInt((query || {}).pageSize, 10) || 20, 1), 100);
  const page = Math.max(parseInt((query || {}).page, 10) || 1, 1);
  return store.listBatches(pool, pageSize, (page - 1) * pageSize);
}

async function batchDetail(actor, batchId) {
  await assertAdmin(actor);
  const id = String(batchId || '');
  if (!/^\d{1,19}$/.test(id)) throw createError(404, '发送批次不存在');
  const batch = await store.getBatch(pool, id);
  if (!batch) throw createError(404, '发送批次不存在');
  // 计数与收件实际状态核对：缓存列只用于展示，不以累计值冒充真实进度
  const counts = await store.countRecipients(pool, batch.notificationId);
  const cached = {
    snapshot: Number(batch.snapshotCount), delivered: Number(batch.deliveredCount),
    skipped: Number(batch.skippedCount), failed: Number(batch.failedCount),
    pending: Number(batch.pendingCount),
  };
  return {
    batch: batch,
    counts: counts,
    countsMatch: cached.snapshot === counts.total
      && cached.delivered === counts.delivered && cached.skipped === counts.skipped
      && cached.pending === counts.pending,
  };
}

async function batchRecipients(actor, batchId, query) {
  await assertAdmin(actor);
  const id = String(batchId || '');
  if (!/^\d{1,19}$/.test(id)) throw createError(404, '发送批次不存在');
  const batch = await store.getBatch(pool, id);
  if (!batch) throw createError(404, '发送批次不存在');
  const limit = Math.min(Math.max(parseInt((query || {}).limit, 10) || 50, 1), 200);
  return store.listBatchRecipients(pool, id, limit, (query || {}).cursor || null);
}

module.exports = {
  AUDIENCE_MODES, RETRYABLE, FILTER_ROLES,
  createError, slotKeyFor, normalizeFilter, contentAudienceHash,
  previewBatch, sendBatch, retryBatch, cancelBatch,
  searchRecipients, listBatches, batchDetail, batchRecipients,
};

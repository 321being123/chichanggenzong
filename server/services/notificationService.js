// ========== 统一站内通知服务（2026-10-25） ==========
// 契约：docs/意见反馈与版本发布闭环研发方案_20261023.md 第十四节。
// 职责：通知内容生成/失效、本人收件箱读写。
// 关键纪律：反馈完成通知只能在 feedbackRelease.applyOne 的逐项业务 client 事务内生成，
// 失效只能在 rollbackOne / feedbackService 原事务 client 内写入；本文件所有写函数都接收调用方 client，
// 禁止自行 pool.connect() 另开事务提交（否则会出现「反馈已回滚但通知仍有效」）。
const store = require('../db/notifications');

const CATEGORIES = ['all', 'feedback', 'system'];
const PAGE_LIMIT_DEFAULT = 20;
const PAGE_LIMIT_MAX = 50;
// 反馈完成通知的唯一收件槽位：作者删号也保留一行，不能改投同名新账号
const FEEDBACK_AUTHOR_SLOT = 'feedback_author';
const SYSTEM_TITLE_MAX = 100;
const SYSTEM_BODY_MAX = 2000;

function createError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function clampLimit(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return PAGE_LIMIT_DEFAULT;
  return Math.min(n, PAGE_LIMIT_MAX);
}

function cleanText(value, max) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeCategory(value) {
  const v = String(value || '').trim();
  return CATEGORIES.indexOf(v) >= 0 ? v : 'all';
}

// 目标由服务端注册表生成，拒绝任意 URL；前端只按 kind 决定渲染方式
function buildTarget(row) {
  if (row.targetKind === 'feedback' && row.feedbackId) {
    return {
      kind: 'feedback',
      feedbackId: row.feedbackId,
      path: '/?main=feedback&sub=mine&feedback=' + encodeURIComponent(row.feedbackId),
    };
  }
  if (row.type === 'system') {
    return {
      kind: 'notification',
      notificationId: row.notificationId,
      path: '/?main=notifications&sub=system&notification=' + encodeURIComponent(row.notificationId),
    };
  }
  return { kind: 'none' };
}

function projectInboxItem(row) {
  return {
    id: row.notificationId,
    recipientId: row.recipientId,
    type: row.type,
    category: row.type,
    title: row.title,
    body: row.body,
    createdAt: row.createdAt,
    deliveredAt: row.deliveredAt,
    readAt: row.readAt,
    read: !!row.readAt,
    invalidated: row.invalidated === true,
    invalidationReason: row.invalidationReason || '',
    feedback: row.feedbackId
      ? {
        id: row.feedbackId,
        title: row.feedbackTitle || '',
        status: row.feedbackStatus || '',
        version: row.feedbackVersion || '',
      }
      : null,
    target: buildTarget(row),
  };
}

// ---------- 反馈完成通知（同事务写入） ----------
// 去重键按批次：同批次重复应用返回原记录；新批次重新验收可再通知，不能只按 SHA 去重。
function feedbackDedupeKey(releaseRunId, feedbackId) {
  return 'feedback.implemented:' + String(releaseRunId) + ':' + String(feedbackId);
}

async function createFeedbackImplementedNotice(client, options) {
  const opts = options || {};
  const feedbackId = String(opts.feedbackId || '');
  const releaseRunId = String(opts.releaseRunId || '');
  const appVersion = String(opts.appVersion || '').trim();
  if (!feedbackId || !releaseRunId || !appVersion) {
    throw createError(400, '生成反馈完成通知缺少反馈编号、发布批次或版本号');
  }
  const authorUsername = opts.authorUsername || null;
  const created = await store.insertNotification(client, {
    type: 'feedback',
    title: '你提交的反馈已解决',
    // 不复制反馈正文、截图、内部证据或发布 SHA
    body: '反馈#' + feedbackId + '已随版本 ' + appVersion + ' 上线，感谢你的反馈',
    targetKind: 'feedback',
    targetId: feedbackId,
    feedbackId: feedbackId,
    releaseRunId: releaseRunId,
    dedupeKey: feedbackDedupeKey(releaseRunId, feedbackId),
    payload: { appVersion: appVersion },
  });
  if (!created) return null;
  if (created.inserted === false) {
    const existing = await client.query(
      `SELECT count(*)::int AS count FROM public.notification_recipients
        WHERE notification_id=$1 AND recipient_slot_key=$2`,
      [created.id, FEEDBACK_AUTHOR_SLOT]
    );
    if (existing.rows[0] && existing.rows[0].count > 0) {
      return { notificationId: created.id, reused: true, authorDeleted: false };
    }
  }
  // 作者已删除仍保留唯一单收件槽位，写 skipped/author_deleted 且用户名为空
  const authorDeleted = !authorUsername;
  const recipient = await store.insertRecipient(client, {
    notificationId: created.id,
    recipientSlotKey: FEEDBACK_AUTHOR_SLOT,
    recipientUsername: authorDeleted ? null : authorUsername,
    status: authorDeleted ? 'skipped' : 'delivered',
    skipReason: authorDeleted ? 'author_deleted' : '',
  });
  return {
    notificationId: created.id,
    recipientId: recipient ? recipient.id : null,
    reused: created.inserted === false,
    authorDeleted: authorDeleted,
  };
}

// 失效：反馈离开 implemented（含回滚恢复）时调用，保留历史与已读，只标记处理状态已更新。
// 按当前事件/发布项定位：传 releaseRunId 只失效该批次；不传则失效当前所有有效完成通知（同一时刻最多一条）。
async function invalidateFeedbackNotifications(client, options) {
  const opts = options || {};
  const feedbackId = String(opts.feedbackId || '');
  if (!feedbackId) throw createError(400, '失效反馈通知缺少反馈编号');
  const reason = cleanText(opts.reason, 200) || '处理状态已更新';
  const params = [feedbackId];
  let extra = '';
  if (opts.releaseRunId) {
    params.push(String(opts.releaseRunId));
    extra = ' AND release_run_id = $' + params.length;
  }
  const { rows } = await client.query(
    `SELECT id::text AS id FROM public.notifications
      WHERE feedback_id=$1 AND invalidated_at IS NULL${extra}
      ORDER BY id DESC`,
    params
  );
  let invalidated = 0;
  for (let i = 0; i < rows.length; i++) {
    const done = await store.invalidateNotification(client, rows[i].id, reason);
    if (done) invalidated++;
  }
  return { invalidated: invalidated, notificationIds: rows.map(function (r) { return r.id; }) };
}

// ---------- 本人收件箱 ----------
async function listInbox(username, query) {
  if (!username) throw createError(401, '请先登录');
  const q = query || {};
  const category = normalizeCategory(q.category);
  const limit = clampLimit(q.limit);
  const data = await store.listInbox(pool(), username, {
    category: category,
    unreadOnly: q.unreadOnly === '1' || q.unreadOnly === 'true' || q.unreadOnly === true,
    afterId: q.cursor ? String(q.cursor) : null,
  }, limit);
  return {
    category: category,
    items: data.items.map(projectInboxItem),
    nextCursor: data.nextCursor,
    complete: data.complete,
  };
}

async function unreadCountSummary(username) {
  if (!username) throw createError(401, '请先登录');
  return store.unreadCounts(pool(), username);
}

async function detail(username, notificationId) {
  if (!username) throw createError(401, '请先登录');
  const id = String(notificationId || '');
  if (!/^\d{1,19}$/.test(id)) throw createError(404, '通知不存在或无权访问');
  const row = await store.getInboxItem(pool(), id, username);
  // 未投递、他人、已删除一律同一提示，不泄露存在性
  if (!row) throw createError(404, '通知不存在或无权访问');
  return projectInboxItem(row);
}

async function markRead(username, notificationId) {
  if (!username) throw createError(401, '请先登录');
  const id = String(notificationId || '');
  if (!/^\d{1,19}$/.test(id)) throw createError(404, '通知不存在或无权访问');
  const row = await store.markRead(pool(), id, username);
  if (!row) throw createError(404, '通知不存在或无权访问');
  return { id: id, readAt: row.readAt, unread: await store.unreadCounts(pool(), username) };
}

async function markAllRead(username, category) {
  if (!username) throw createError(401, '请先登录');
  const scope = normalizeCategory(category);
  const count = await store.markAllRead(pool(), username, scope);
  return { category: scope, marked: count, unread: await store.unreadCounts(pool(), username) };
}

// 由 db 模块统一导出，避免服务层直接依赖连接细节
function pool() {
  return require('../db').pool;
}

module.exports = {
  CATEGORIES, FEEDBACK_AUTHOR_SLOT, SYSTEM_TITLE_MAX, SYSTEM_BODY_MAX,
  createError, cleanText, clampLimit, normalizeCategory, buildTarget, projectInboxItem,
  feedbackDedupeKey, createFeedbackImplementedNotice, invalidateFeedbackNotifications,
  listInbox, unreadCountSummary, detail, markRead, markAllRead,
};

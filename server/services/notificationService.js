// ========== 统一站内通知服务（2026-10-25） ==========
// 契约：docs/意见反馈与版本发布闭环研发方案_20261023.md 第十四节。
// 职责：通知内容生成/失效、本人收件箱读写。
// 关键纪律：反馈完成通知只能在 feedbackRelease.applyOne 的逐项业务 client 事务内生成，
// 失效只能在 rollbackOne / feedbackService 原事务 client 内写入；本文件所有写函数都接收调用方 client，
// 禁止自行 pool.connect() 另开事务提交（否则会出现「反馈已回滚但通知仍有效」）。
const store = require('../db/notifications');
const repository = require('../repositories/notificationServiceRepository.js');

const CATEGORIES = ['all', 'feedback', 'system', 'comment'];
const PAGE_LIMIT_DEFAULT = 20;
const PAGE_LIMIT_MAX = 50;
// 反馈完成通知的唯一收件槽位：作者删号也保留一行，不能改投同名新账号
const FEEDBACK_AUTHOR_SLOT = 'feedback_author';
// 评论通知：每个收件人一条通知，槽位固定（一条通知只有一个收件人）
const COMMENT_RECIPIENT_SLOT = 'comment_recipient';
const SYSTEM_TITLE_MAX = 100;
const SYSTEM_BODY_MAX = 2000;
// 评论通知的原因与展示优先级：@ ＞ 回复 ＞ 文章评论
const COMMENT_REASONS = ['comment_mention', 'comment_reply', 'article_comment'];
const COMMENT_TITLES = {
  comment_mention: '有人在评论中提到了你',
  comment_reply: '有人回复了你的评论',
  article_comment: '你的文章收到了新评论',
};

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
  // 评论：站内地址只能由这里的注册表拼出，文章与评论编号来自服务端写入的目标字段。
  // 附带通知编号：真正的目标（文章与评论）加载成功后才由页面回标已读，失败保持未读。
  if (row.targetKind === 'article_comment' && row.targetId) {
    return {
      kind: 'article_comment',
      articleId: row.targetArticleId || '',
      commentId: row.targetId,
      notificationId: row.notificationId,
      path: '/?main=knowledge&article=' + encodeURIComponent(row.targetArticleId || '')
        + '&comment=' + encodeURIComponent(row.targetId)
        + '&notification=' + encodeURIComponent(row.notificationId),
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
    const existing = await repository.select_public_notification_recipients([created.id, FEEDBACK_AUTHOR_SLOT], client);
    if (existing.rows[0] && existing.rows[0].count > 0) {
      return { notificationId: created.id, reused: true, authorDeleted: false };
    }
  }
  // 作者已删除仍保留唯一单收件槽位，写 skipped/author_deleted 且用户名为空
  const account = authorUsername ? await store.readAccountByUsername(client, authorUsername) : null;
  const authorDeleted = !authorUsername || !account;
  if (authorDeleted) {
    const recipient = await store.insertRecipient(client, {
      notificationId: created.id,
      recipientSlotKey: FEEDBACK_AUTHOR_SLOT,
      recipientUsername: null,
      status: 'skipped',
      skipReason: 'author_deleted',
    });
    return {
      notificationId: created.id,
      recipientId: recipient ? recipient.id : null,
      reused: created.inserted === false,
      authorDeleted: true,
    };
  }
  // 本人设置：关闭「自己反馈的处理结果」只冻结这一次投递（skipped/preference_disabled），
  // 反馈本身的状态更新、事件与发布明细照常完成；重开或重试都不补发。
  // 读取异常必须抛出，让调用方整体回滚——不能把读取失败当成用户关闭。
  const lockedPrefs = await store.lockPreferences(client, [account.subjectId]);
  const pref = lockedPrefs[0];
  const enabled = !pref || pref.feedbackImplemented !== false;
  // 反馈通知沿用原口径：只按用户名与投递时身份判定，不写主体快照（历史兼容）。
  const recipient = await store.insertRecipient(client, {
    notificationId: created.id,
    recipientSlotKey: FEEDBACK_AUTHOR_SLOT,
    recipientUsername: account.username,
    recipientIdentity: account.identity,
    status: enabled ? 'delivered' : 'skipped',
    skipReason: enabled ? '' : 'preference_disabled',
  });
  return {
    notificationId: created.id,
    recipientId: recipient ? recipient.id : null,
    reused: created.inserted === false,
    authorDeleted: false,
    preferenceDisabled: !enabled,
  };
}

// 失效：反馈离开 implemented（含回滚恢复）时调用，保留历史与已读，只标记处理状态已更新。
// 按当前事件/发布项定位：传 releaseRunId 只失效该批次；不传则失效当前所有有效完成通知（同一时刻最多一条）。
async function invalidateFeedbackNotifications(client, options) {
  const opts = options || {};
  const feedbackId = String(opts.feedbackId || '');
  if (!feedbackId) throw createError(400, '失效反馈通知缺少反馈编号');
  const reason = cleanText(opts.reason, 200) || '处理状态已更新';
  const { rows } = await repository.selectInvalidatableFeedbackNotifications({ feedbackId, releaseRunId: opts.releaseRunId }, client);
  let invalidated = 0;
  for (let i = 0; i < rows.length; i++) {
    const done = await store.invalidateNotification(client, rows[i].id, reason);
    if (done) invalidated++;
  }
  return { invalidated: invalidated, notificationIds: rows.map(function (r) { return r.id; }) };
}

// ---------- 评论通知（文章评论 / 回复 / @，同事务写入） ----------
// 规则：候选按账号主体去重、排除发送人自己；先逐原因按收件人设置过滤，
// 再保留所有仍开启且命中的原因；三个原因全关才不生成通知。
// 一条评论对每个收件人最多一条通知，去重键由数据库唯一索引兜底。
function commentDedupeKey(commentId, subjectId) {
  return 'comment:' + String(commentId) + ':' + String(subjectId);
}

async function createCommentNotices(client, ctx) {
  const context = ctx || {};
  const commentId = String(context.commentId || '');
  const articleId = String(context.articleId || '');
  if (!commentId || !articleId) throw createError(400, '生成评论通知缺少评论或文章编号');
  const articleTitle = cleanText(context.articleTitle, 60);
  const candidates = new Map();
  function push(account, reason) {
    if (!account || !account.subjectId || !account.username) return;
    if (account.subjectId === context.authorSubjectId) return;          // 不通知自己
    if (account.status && account.status !== 'active') return;          // 停用/删除不投递
    if (!candidates.has(account.subjectId)) {
      candidates.set(account.subjectId, {
        subjectId: account.subjectId, username: account.username,
        identity: account.identity || '', reasons: [],
      });
    }
    const entry = candidates.get(account.subjectId);
    if (entry.reasons.indexOf(reason) < 0) entry.reasons.push(reason);
  }
  push(context.articleAuthorAccount, 'article_comment');
  push(context.parentAuthorAccount, 'comment_reply');
  (context.mentionAccounts || []).forEach(function (a) { push(a, 'comment_mention'); });
  if (!candidates.size) return { notified: 0, recipients: [] };

  const subjects = Array.from(candidates.keys());
  // 偏好按主体稳定顺序加锁：与反馈完成、设置保存共用同一锁序，避免环形等待
  const prefs = await store.lockPreferences(client, subjects);
  const prefBySubject = new Map();
  prefs.forEach(function (p) { prefBySubject.set(p.subjectId, p); });

  const results = [];
  for (let i = 0; i < subjects.length; i++) {
    const subjectId = subjects[i];
    const entry = candidates.get(subjectId);
    const pref = prefBySubject.get(subjectId);
    const kept = COMMENT_REASONS.filter(function (reason) {
      if (entry.reasons.indexOf(reason) < 0) return false;
      if (!pref) return true;                       // 缺失记录默认全开
      return pref[prefKeyOf(reason)] !== false;
    });
    if (!kept.length) continue;
    const top = kept[0];
    const notice = await store.insertNotification(client, {
      type: 'comment',
      title: COMMENT_TITLES[top],
      body: commentBody(top, articleTitle),
      targetKind: 'article_comment',
      targetId: commentId,
      dedupeKey: commentDedupeKey(commentId, subjectId),
      // 只存定位与原因，不存评论正文、任意 URL 或私有资料
      payload: { articleId: articleId, commentId: commentId, reasons: kept },
    });
    if (!notice) continue;
    const recipient = await store.insertRecipient(client, {
      notificationId: notice.id,
      recipientSlotKey: COMMENT_RECIPIENT_SLOT,
      recipientUsername: entry.username,
      recipientIdentity: entry.identity,
      recipientSubjectId: subjectId,
      status: 'delivered',
    });
    results.push({
      subjectId: subjectId, notificationId: notice.id,
      recipientId: recipient ? recipient.id : null, reasons: kept, reused: notice.inserted === false,
    });
  }
  return { notified: results.length, recipients: results };
}

// 设置键 → 偏好列名（评论三原因共用同一套命名）
function prefKeyOf(reason) {
  if (reason === 'comment_mention') return 'commentMention';
  if (reason === 'comment_reply') return 'commentReply';
  return 'articleComment';
}

function commentBody(topReason, articleTitle) {
  const title = articleTitle ? '「' + articleTitle + '」' : '投资笔记文章';
  if (topReason === 'comment_mention') return '你在' + title + '的评论中被提到';
  if (topReason === 'comment_reply') return '你在' + title + '的评论收到了回复';
  return '你的文章' + title + '收到了新评论';
}

// ---------- 本人收件箱 ----------
async function listInbox(username, query, subjectId) {
  if (!username) throw createError(401, '请先登录');
  const q = query || {};
  const category = normalizeCategory(q.category);
  const limit = clampLimit(q.limit);
  const data = await store.listInbox(pool(), username, subjectId, {
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

async function unreadCountSummary(username, subjectId) {
  if (!username) throw createError(401, '请先登录');
  return store.unreadCounts(pool(), username, subjectId);
}

async function detail(username, notificationId, subjectId) {
  if (!username) throw createError(401, '请先登录');
  const id = String(notificationId || '');
  if (!/^\d{1,19}$/.test(id)) throw createError(404, '通知不存在或无权访问');
  const row = await store.getInboxItem(pool(), id, username, subjectId);
  // 未投递、他人、已删除一律同一提示，不泄露存在性
  if (!row) throw createError(404, '通知不存在或无权访问');
  return projectInboxItem(row);
}

async function markRead(username, notificationId, subjectId) {
  if (!username) throw createError(401, '请先登录');
  const id = String(notificationId || '');
  if (!/^\d{1,19}$/.test(id)) throw createError(404, '通知不存在或无权访问');
  const row = await store.markRead(pool(), id, username, subjectId);
  if (!row) throw createError(404, '通知不存在或无权访问');
  return { id: id, readAt: row.readAt, unread: await store.unreadCounts(pool(), username, subjectId) };
}

async function markAllRead(username, category, subjectId) {
  if (!username) throw createError(401, '请先登录');
  const scope = normalizeCategory(category);
  const count = await store.markAllRead(pool(), username, subjectId, scope);
  return { category: scope, marked: count, unread: await store.unreadCounts(pool(), username, subjectId) };
}

// 由 db 模块统一导出，避免服务层直接依赖连接细节
function pool() {
  return require('../db').pool;
}

module.exports = {
  CATEGORIES, FEEDBACK_AUTHOR_SLOT, COMMENT_RECIPIENT_SLOT, COMMENT_REASONS, COMMENT_TITLES,
  SYSTEM_TITLE_MAX, SYSTEM_BODY_MAX,
  createError, cleanText, clampLimit, normalizeCategory, buildTarget, projectInboxItem,
  feedbackDedupeKey, createFeedbackImplementedNotice, invalidateFeedbackNotifications,
  commentDedupeKey, createCommentNotices,
  listInbox, unreadCountSummary, detail, markRead, markAllRead,
};

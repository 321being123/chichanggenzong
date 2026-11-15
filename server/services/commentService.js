// ========== 文章评论（发表/删除）与评论通知编排（2026-11-15） ==========
// 契约：docs/意见反馈与版本发布闭环研发方案_20261023.md 第 14.13 节。
// 纪律：评论、@ 关系、提醒设置读取、通知与收件记录、请求幂等必须落在同一个 client 事务内；
// 通知写失败整条评论回滚。删除评论/文章时，失效通知与删除必须同事务，且先失效后删除。
const crypto = require('crypto');
const { pool } = require('../db');
const txControl = require('../repositories/transactionControl');
const knowledgeRepository = require('../repositories/knowledgeRepository');
const store = require('../db/notifications');
const notificationService = require('./notificationService');

const MAX_MENTIONS = 10;
const MENTION_RESULT_LIMIT = 8;
const INVALIDATED_REASON = '内容已不可用';

// code 供前端判断错误的性质（例如「同编号已处理」不能当成「明确没提交」），
// 不改变 HTTP 语义与既有 error 文案。
function createError(status, message, code) {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
}

// 请求摘要：同请求标识只允许同内容重放；内容变了必须 409，不能静默换成另一条评论
function hashRequest(payload) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
}

// 规范化并校验 @ 选择：区间必须落在正文内、文本与所选身份一致、互不重叠、同一主体只算一次。
// 不信任客户端昵称或用户名——发送人身份与正文之外的账号信息一律在事务内按主体复核。
function normalizeMentions(raw, content) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw createError(400, '@ 选择格式不正确');
  if (raw.length > MAX_MENTIONS) throw createError(400, '一条评论最多提到 ' + MAX_MENTIONS + ' 个人');
  const seen = new Set();
  const items = raw.map(function (m) {
    if (!m || typeof m !== 'object') throw createError(400, '@ 选择格式不正确');
    const subjectId = String(m.subjectId || '').trim();
    const text = typeof m.text === 'string' ? m.text : '';
    const start = Number(m.start);
    const end = Number(m.end);
    if (!/^[0-9a-fA-F-]{36}$/.test(subjectId)) throw createError(400, '@ 选择的账号无效，请重新选择');
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > content.length) {
      throw createError(400, '@ 选择的位置无效，请重新选择');
    }
    if (content.slice(start, end) !== text || !text) {
      throw createError(400, '正文与所选 @ 用户不一致，请重新选择');
    }
    if (seen.has(subjectId)) throw createError(400, '同一条评论不能重复提到同一个人');
    seen.add(subjectId);
    return { subjectId: subjectId, text: text, start: start, end: end };
  });
  items.sort(function (a, b) { return a.start - b.start; });
  for (let i = 1; i < items.length; i++) {
    if (items[i].start < items[i - 1].end) throw createError(400, '@ 选择的位置相互重叠，请重新选择');
  }
  return items;
}

// 事务内复核 @ 目标：必须存在、active、非本人；并用「当前昵称」核对正文里那段文字。
// 只校验正文与区间一致还不够：客户端可以拿别人的 subjectId 配任意文字，
// 因此这里要求该段文字必须正好是所选账号的当前显示名（选择后改名/身份变化一律要求重选）。
async function resolveMentionAccounts(client, mentions, authorSubjectId) {
  if (!mentions.length) return [];
  const accounts = await store.listAccountsBySubjects(client, mentions.map(function (m) { return m.subjectId; }));
  const byId = new Map();
  accounts.forEach(function (a) { byId.set(a.subjectId, a); });
  return mentions.map(function (m) {
    const account = byId.get(m.subjectId);
    if (!account) throw createError(400, '被提到的账号不存在，请重新选择');
    if (account.status !== 'active') throw createError(400, '被提到的账号已不可用，请重新选择');
    if (account.subjectId === authorSubjectId) throw createError(400, '不能提到自己');
    if (m.text !== '@' + account.nickname) {
      throw createError(400, '正文里的 @ 与所选账号的当前昵称不一致，请重新选择');
    }
    return account;
  });
}

// 发表评论：单事务写入评论、@ 关系、请求幂等记录与通知
async function createComment(params) {
  const p = params || {};
  const articleId = parseInt(p.articleId, 10);
  if (!Number.isInteger(articleId) || articleId <= 0) throw createError(404, '文章不存在或未发布');
  const authorUsername = String(p.authorUsername || '');
  if (!authorUsername) throw createError(401, '请先登录');
  const content = String(p.content || '');
  const parentId = p.parentId ? parseInt(p.parentId, 10) : null;
  const clientRequestId = p.clientRequestId ? String(p.clientRequestId).slice(0, 64) : '';
  const mentions = normalizeMentions(p.mentions, content);
  const requestHash = hashRequest({
    articleId: articleId,
    parentId: parentId,
    content: content,
    mentions: mentions.map(function (m) { return m.subjectId; }).sort(),
  });

  const client = await pool.connect();
  try {
    await txControl.begin(client);
    // 发送人身份：会话主体必须与库内当前主体一致（删号后同名重建不得沿用旧会话）
    const author = await store.readAccountByUsername(client, authorUsername);
    if (!author || author.status !== 'active') throw createError(401, '登录状态已失效');
    if (p.authorSubjectId && author.subjectId !== p.authorSubjectId) throw createError(401, '登录状态已失效');

    // 请求编号查重必须在文章状态检查之前：重试时文章可能已被撤回成草稿或被删，
    // 若先判文章状态就会返回 404，而 404 无法区分「上次根本没提交」与「上次已提交、之后文章被撤回」，
    // 前端会据此丢掉请求编号，文章重新发布后再提交就换了新编号，同一条评论被发两次。
    // 这里先按编号取上次结果：找到且评论仍在就直接回放，不看文章当前状态。
    if (clientRequestId) {
      const existing = await store.findCommentRequest(client, author.subjectId, clientRequestId);
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw createError(409, '同一请求标识不能提交不同内容', 'request_conflict');
        }
        const replay = existing.commentId
          ? await knowledgeRepository.readCommentBrief({ id: existing.commentId }, client)
          : null;
        if (replay) {
          await txControl.commit(client);
          return { comment: replay, reused: true, notified: 0 };
        }
        // 原请求确实处理过，但评论随后被删除（作者/管理员删除，或文章删除的级联）：
        // 这是「已处理 + 已删除」的终态，不能借同编号再发一条——那等于把用户删掉的评论和通知又造回来。
        // 请求记录保留作墓碑（comment_id 被置空），重试一律返回同一结论，由前端如实告知用户。
        throw createError(409, '这条评论已经发表过，之后被删除，不会重复发表', 'request_comment_deleted');
      }
    }

    // 文章共享锁：阻止并发撤回/删除在本次提交前把文章改走
    const article = await knowledgeRepository.lockArticleForComment({ id: articleId }, client);
    if (!article || article.status !== 'published') throw createError(404, '文章不存在或未发布');

    let parent = null;
    let rootId = null;
    if (parentId) {
      parent = await knowledgeRepository.lockCommentParentFull({ id: parentId }, client);
      // 显式父评论不存在、跨文章或并发删除：409 并提示刷新，不再悄悄降为一级评论
      if (!parent || Number(parent.article_id) !== articleId) {
        throw createError(409, '回复的评论已删除或不属于该文章，请刷新后重试');
      }
      rootId = parent.root_id || parent.id;
    }

    const mentionAccounts = await resolveMentionAccounts(client, mentions, author.subjectId);

    // 候选收件人的账号快照在事务内读取：作者/父评论作者删号或停用时跳过对应原因
    const usernames = [article.author_username, parent && parent.author_username].filter(Boolean);
    const accounts = await store.listAccountsByUsernames(client, usernames);
    const byUsername = new Map();
    accounts.forEach(function (a) { byUsername.set(a.username, a); });

    const inserted = await knowledgeRepository.insertComment({
      articleId: articleId,
      parentId: parent ? parent.id : null,
      rootId: rootId,
      nickname: p.nickname || authorUsername,
      content: content,
      ipHash: p.ipHash,
      authorUsername: authorUsername,
    }, client);

    if (clientRequestId) {
      const record = await store.insertCommentRequest(client, {
        subjectId: author.subjectId,
        clientRequestId: clientRequestId,
        requestHash: requestHash,
        commentId: inserted.id,
      });
      // 并发同标识：另一事务已先写入，本次回滚，交由调用方按 409 提示刷新。
      // 这条 409 的含义是「这条请求已经处理过」，不是「明确没提交」——前端必须保留原编号，
      // 否则第三次提交换了新编号，就会在第一条已落库的情况下再发一条。
      if (!record) {
        throw createError(409, '该请求已处理，请刷新后查看', 'request_already_processed');
      }
    }

    const notices = await notificationService.createCommentNotices(client, {
      articleId: articleId,
      articleTitle: article.title || '',
      commentId: inserted.id,
      authorSubjectId: author.subjectId,
      articleAuthorAccount: byUsername.get(article.author_username) || null,
      parentAuthorAccount: parent ? (byUsername.get(parent.author_username) || null) : null,
      mentionAccounts: mentionAccounts,
    });

    await txControl.commit(client);
    return { comment: inserted, reused: false, notified: notices.notified };
  } catch (e) {
    await txControl.rollback(client).catch(function () {});
    throw e;
  } finally {
    client.release();
  }
}

// 删除评论（含子树）：先取文章排它锁再收集子树、失效通知、删除。
// 锁顺序与创建评论一致（先文章行）：创建评论持共享锁，删除持排它锁，二者互斥，
// 因此不会出现「子树查询之后又插入一条回复、被级联删除但通知仍有效」。
async function deleteComment(commentId) {
  const id = parseInt(commentId, 10);
  if (!Number.isInteger(id) || id <= 0) throw createError(404, '评论不存在');
  const client = await pool.connect();
  try {
    await txControl.begin(client);
    const brief = await knowledgeRepository.readCommentBrief({ id: id }, client);
    if (!brief) throw createError(404, '评论不存在');
    await knowledgeRepository.lockArticleForWrite({ id: brief.article_id }, client);
    // 取得排它锁后重新收集：此前并发提交的回复此时已可见，不会漏在子树之外
    const ids = await knowledgeRepository.listCommentSubtreeIds({ id: id }, client);
    if (!ids.length) throw createError(404, '评论不存在');
    await store.invalidateCommentNotificationsByComments(client, ids, INVALIDATED_REASON);
    await knowledgeRepository.deleteComment({ id: id }, client);
    await txControl.commit(client);
    return { ok: true, invalidatedComments: ids.length };
  } catch (e) {
    await txControl.rollback(client).catch(function () {});
    throw e;
  } finally {
    client.release();
  }
}

// 文章删除：级联删除会带走评论，必须先按文章失效通知。
// 同样先取文章排它锁，挡住正在提交的评论（否则失效之后才插入的评论通知会变成孤儿）。
async function deleteArticle(articleId) {
  const id = parseInt(articleId, 10);
  const client = await pool.connect();
  try {
    await txControl.begin(client);
    const locked = await knowledgeRepository.lockArticleForWrite({ id: id }, client);
    if (!locked) { await txControl.rollback(client); return { ok: true, missing: true }; }
    await store.invalidateCommentNotificationsByArticle(client, id, INVALIDATED_REASON);
    await knowledgeRepository.deleteArticle({ id: id }, client);
    await txControl.commit(client);
    return { ok: true };
  } catch (e) {
    await txControl.rollback(client).catch(function () {});
    throw e;
  } finally {
    client.release();
  }
}

// 撤回为草稿：同事务失效该文章的评论通知；重新发布不自动恢复
async function unpublishArticle(articleId) {
  const id = parseInt(articleId, 10);
  const client = await pool.connect();
  try {
    await txControl.begin(client);
    const locked = await knowledgeRepository.lockArticleForWrite({ id: id }, client);
    if (!locked) { await txControl.rollback(client); return { ok: true, missing: true }; }
    await store.invalidateCommentNotificationsByArticle(client, id, INVALIDATED_REASON);
    await knowledgeRepository.unpublishArticle({ id: id }, client);
    await txControl.commit(client);
    return { ok: true };
  } catch (e) {
    await txControl.rollback(client).catch(function () {});
    throw e;
  } finally {
    client.release();
  }
}

// 编辑文章：状态改为草稿时同事务失效评论通知，其余编辑不动通知。
// 涉及状态变化时先取文章排它锁，避免「撤回期间提交的评论」在失效之后落库。
async function updateArticle(params) {
  const p = params || {};
  const client = await pool.connect();
  try {
    await txControl.begin(client);
    if (p.status === 'draft') {
      const locked = await knowledgeRepository.lockArticleForWrite({ id: p.id }, client);
      if (!locked) { await txControl.rollback(client); return { ok: true, missing: true }; }
      await store.invalidateCommentNotificationsByArticle(client, p.id, INVALIDATED_REASON);
    }
    await knowledgeRepository.updateArticle(p, client);
    await txControl.commit(client);
    return { ok: true };
  } catch (e) {
    await txControl.rollback(client).catch(function () {});
    throw e;
  } finally {
    client.release();
  }
}

// @ 候选：只返回 active 账号必要标识与显示名，限定数量，LIKE 通配符按字面转义
async function listMentionCandidates(keyword) {
  const q = String(keyword || '').trim();
  if (!q) throw createError(400, '请输入要搜索的昵称或用户名');
  if (q.length > 50) throw createError(400, '搜索内容过长');
  const escaped = q.replace(/[\\%_]/g, function (ch) { return '\\' + ch; });
  return store.listMentionCandidates(pool, '%' + escaped + '%', MENTION_RESULT_LIMIT);
}

module.exports = {
  MAX_MENTIONS, MENTION_RESULT_LIMIT, INVALIDATED_REASON,
  createError, hashRequest, normalizeMentions,
  createComment, deleteComment, deleteArticle, unpublishArticle, updateArticle,
  listMentionCandidates,
};

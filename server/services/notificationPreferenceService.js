// ========== 通知提醒设置（个人偏好，2026-11-15） ==========
// 契约：docs/意见反馈与版本发布闭环研发方案_20261023.md 第 14.13.2 / 14.13.5 节。
// 边界：偏好是「用户设置」，不是第二份通知事实；只影响之后提交的评论与之后应用的反馈完成事件，
// 不删除、不隐藏既有通知，也不清零未读；重开不追补。
// 并发：按账号主体单行存储，保存用版本号条件更新，冲突 409 要求重新获取，避免覆盖其他设备改动。
const { pool } = require('../db');
const store = require('../db/notifications');

const FIELDS = ['articleComment', 'commentReply', 'commentMention', 'feedbackImplemented'];
const DEFAULTS = {
  articleComment: true,
  commentReply: true,
  commentMention: true,
  feedbackImplemented: true,
};

function createError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// 缺失记录默认全开；version=0 表示「服务端还没有这一行」，保存时按首次创建处理
function project(row) {
  if (!row) {
    return Object.assign({ version: 0, defaults: true }, DEFAULTS);
  }
  return {
    articleComment: row.articleComment !== false,
    commentReply: row.commentReply !== false,
    commentMention: row.commentMention !== false,
    feedbackImplemented: row.feedbackImplemented !== false,
    version: Number(row.version),
    defaults: false,
  };
}

async function read(subjectId) {
  if (!subjectId) throw createError(401, '请先登录');
  const row = await store.readPreferences(pool, subjectId);
  return project(row);
}

// 严格白名单布尔值：四项必须全部显式给出，多余字段一律忽略；无效直接 400，不做静默兜底
function readValues(body) {
  const src = body || {};
  const values = {};
  for (let i = 0; i < FIELDS.length; i++) {
    const key = FIELDS[i];
    if (typeof src[key] !== 'boolean') throw createError(400, '提醒设置格式不正确');
    values[key] = src[key];
  }
  return values;
}

async function save(subjectId, body) {
  if (!subjectId) throw createError(401, '请先登录');
  const values = readValues(body);
  const expectedVersion = Number(body && body.version);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    throw createError(400, '缺少提醒设置版本号');
  }
  if (expectedVersion === 0) {
    const created = await store.insertPreferences(pool, subjectId, values);
    if (created) return project(created);
    // 另一台设备已先建行：不覆盖，交给调用方重新获取后重试
    throw createError(409, '提醒设置已在其他设备更新，请重新获取');
  }
  const updated = await store.updatePreferences(pool, subjectId, values, expectedVersion);
  if (!updated) throw createError(409, '提醒设置已在其他设备更新，请重新获取');
  return project(updated);
}

module.exports = { FIELDS, DEFAULTS, createError, project, read, save };

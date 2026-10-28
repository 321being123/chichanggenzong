// ========== 反馈业务服务（2026-10-23） ==========
// 契约：docs/意见反馈与版本发布闭环研发方案_20261023.md
// 这里集中承载：字段与状态规则、可见范围与字段级权限、提交幂等、附件压缩与文件生命周期、处理事件。
// 路由层只做参数校验与权限中间件，发布命令（reconcileFeedbackRelease）复用本服务的状态规则。
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pool, DATA_DIR } = require('../db');
const store = require('../db/feedback');
const notificationService = require('./notificationService');
const { hasCapability, isAdminIdentity } = require('../middleware/auth');
const txControl = require('../repositories/transactionControl');
const repository = require('../repositories/feedbackServiceRepository.js');

// ---------- 常量 ----------
const TYPES = ['bug', 'improvement', 'feature'];
const TYPE_LABELS = { bug: '错误', improvement: '改进', feature: '需求' };
const STATUSES = ['new', 'needs_info', 'accepted', 'in_progress', 'implemented', 'duplicate', 'declined'];
const STATUS_LABELS = {
  new: '未处理', needs_info: '待补充', accepted: '已采纳', in_progress: '进行中',
  implemented: '已实施', duplicate: '重复', declined: '不采纳',
};
// 终态：参与“待处理范围”排除
const CLOSED_STATUSES = ['implemented', 'duplicate', 'declined'];
// 作者可编辑正文/截图的阶段
const AUTHOR_EDITABLE_STATUSES = ['new', 'needs_info'];
// 需要填写处理原因的状态
const REASON_REQUIRED_STATUSES = ['needs_info', 'duplicate', 'declined'];

const MAX_IMAGES = 3;
const MAX_FILE_BYTES = 2 * 1024 * 1024;      // 单张接收上限
const MAX_REQUEST_BYTES = 7 * 1024 * 1024;   // multipart 全量上限
const MAX_RECEIVED_PIXELS = 20000000;        // 解码像素上限
const MAX_EDGE = 2048;                       // 最终长边上限
const TARGET_FILE_BYTES = 1024 * 1024;       // 最终单张上限
const COMPRESSION_VERSION = 'webp-v1';
const ALLOWED_INPUT_FORMATS = ['jpeg', 'png', 'webp'];

// 服务端可信运行版本（A-07）：提交版本只取自当前运行代码，忽略客户端传值。
let cachedRuntimeVersion = null;
function runtimeVersion() {
  if (cachedRuntimeVersion !== null) return cachedRuntimeVersion;
  try {
    const pkg = require('../../package.json');
    cachedRuntimeVersion = String(pkg.appVersion || pkg.version || '').slice(0, 40);
  } catch (e) {
    cachedRuntimeVersion = '';
  }
  return cachedRuntimeVersion;
}

// ---------- 响应字段白名单（A-03） ----------
// 公开响应一律只输出这里列出的字段；作者额外可见自己的可见性/隐藏状态；管理员才看内部证据字段。
const PUBLIC_FIELDS = [
  'id', 'type', 'typeLabel', 'title', 'description', 'pagePath', 'submittedVersion',
  'status', 'statusLabel', 'implementedVersion', 'revision', 'createdAt', 'updatedAt',
  'withdrawnAt', 'commentCount', 'latestSummary', 'lastEventAt', 'nickname', 'attachments',
];
const AUTHOR_FIELDS = ['visibility', 'moderation', 'moderationReason'];
const ADMIN_FIELDS = ['authorUsername', 'duplicateOf', 'implementedReleaseSha'];

function pickFields(row, fields) {
  const out = {};
  fields.forEach(function (k) { if (row[k] !== undefined) out[k] = row[k]; });
  return out;
}

// scope: public（游客/他人）| author（本人）| admin（内容管理员）
function projectFeedback(row, scope) {
  if (!row) return row;
  const out = pickFields(row, PUBLIC_FIELDS);
  if (scope === 'author' || scope === 'admin') {
    Object.assign(out, pickFields(row, AUTHOR_FIELDS));
  }
  if (scope === 'admin') {
    Object.assign(out, pickFields(row, ADMIN_FIELDS));
  }
  out.typeLabel = TYPE_LABELS[out.type] || out.type;
  out.statusLabel = STATUS_LABELS[out.status] || out.status;
  if (out.latestSummary == null) out.latestSummary = '';
  out.isMine = scope === 'author' || scope === 'admin';
  return out;
}

function projectComment(c, actor, authorUsername) {
  const mine = !!(actor && actor.username && actor.username === authorUsername);
  const out = {
    id: c.id, nickname: c.nickname, content: c.deleted || c.hidden ? '' : c.content,
    isOfficial: !!c.isOfficial, deleted: !!c.deleted, hidden: !!c.hidden, createdAt: c.createdAt,
    canDelete: mine && !c.deleted,
  };
  return out;
}

// ---------- 错误 ----------
function createError(status, message, extra) {
  const err = new Error(message);
  err.status = status;
  if (extra) Object.assign(err, extra);
  return err;
}
const conflict = function (msg) { return createError(409, msg || '内容已被更新，请刷新后重试'); };
const notFound = function () { return createError(404, '反馈不存在或无权访问'); };

// ---------- 附件目录 ----------
function uploadDir() {
  return process.env.FEEDBACK_UPLOAD_DIR || path.join(DATA_DIR, 'feedback-uploads');
}
function ensureUploadDir() {
  const dir = uploadDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
// 存储键只允许服务端生成的安全字符，读取时再复核一次，杜绝路径穿越
function safeStorageKey(key) {
  if (!/^[a-f0-9]{32}\.webp$/.test(String(key || ''))) throw notFound();
  return key;
}

// ---------- 通用 ----------
function hashRequest(parts) {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
function hashContent(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}
function cleanText(v, max) {
  const s = String(v == null ? '' : v).replace(/\r\n/g, '\n').trim();
  if (max && s.length > max) return s.slice(0, max);
  return s;
}

// 问题页面：只保留站内白名单路径与业务参数，不保存账户名、凭证或外部 URL
const ALLOWED_PAGE_KEYS = ['main', 'sub', 'case', 'code', 'metric', 'kind', 'feedback'];
function normalizePagePath(raw) {
  const value = cleanText(raw, 1000);
  if (!value) return '';
  let url;
  try { url = new URL(value, 'https://cunzaitouzi.cn'); } catch (e) { return ''; }
  if (url.origin !== 'https://cunzaitouzi.cn') return '';
  const params = new URLSearchParams();
  ALLOWED_PAGE_KEYS.forEach(function (k) {
    const v = url.searchParams.get(k);
    if (v && /^[A-Za-z0-9._~:-]{1,64}$/.test(v)) params.set(k, v);
  });
  const qs = params.toString();
  return (url.pathname || '/') + (qs ? '?' + qs : '');
}

// 操作者：会话用户 + 内容管理能力（管理员天然具备）
function loadActor(username, role, permissions) {
  if (!username) return { username: null, canModerate: false };
  const identity = { username: username, role: role, permissions: permissions || {} };
  const canModerate = isAdminIdentity(username, role) || hasCapability(identity, 'content_manage');
  return { username: username, canModerate: canModerate };
}

function actorFromRequest(req) {
  const user = req && req.authUser;
  if (!user) return { username: null, canModerate: false };
  return loadActor(user.username, user.role, user.permissions);
}

async function nicknameOf(db, username) {
  if (!username) return '已注销用户';
  const { rows } = await repository.select_public_users([username]);
  return (rows[0] && rows[0].nickname) || '';
}

// ---------- 可见性 / 权限 ----------
function isPublicVisible(fb) {
  return fb.visibility === 'public' && fb.moderation === 'normal' && !fb.withdrawnAt;
}
function canView(fb, actor) {
  if (!fb) return false;
  if (isPublicVisible(fb)) return true;
  if (actor && actor.canModerate) return true;
  return !!(actor && actor.username && actor.username === fb.authorUsername);
}
function canEditOwn(fb, actor) {
  if (!fb || !actor || !actor.username) return false;
  if (actor.username !== fb.authorUsername) return false;
  if (fb.withdrawnAt) return false;
  return AUTHOR_EDITABLE_STATUSES.indexOf(fb.status) >= 0;
}
function assertRevision(fb, expectedRevision) {
  if (expectedRevision == null) throw createError(400, '缺少并发版本 expectedRevision');
  if (String(fb.revision) !== String(expectedRevision)) throw conflict();
}
async function loadFeedbackForActor(db, id, actor) {
  const fb = await store.getFeedback(db, id);
  if (!canView(fb, actor)) throw notFound();
  return fb;
}

// ---------- 图片压缩 ----------
let sharpLib = null;
function sharp() {
  if (sharpLib) return sharpLib;
  try { sharpLib = require('sharp'); } catch (e) { sharpLib = null; }
  if (!sharpLib) {
    throw createError(503, '服务器暂不可处理图片（缺少图片处理组件），请稍后重试或只提交文字');
  }
  return sharpLib;
}

// 单张图片：校验真实格式 → 按方向旋转 → 长边≤2048 → WebP；超 1MiB 逐级降质/缩边，失败整批拒绝
async function encodeImage(buffer) {
  const sharpFn = sharp();
  if (!buffer || !buffer.length) throw createError(400, '图片内容为空');
  if (buffer.length > MAX_FILE_BYTES) throw createError(413, '单张图片不能超过 2MB');
  let meta;
  try {
    meta = await sharpFn(buffer, { failOn: 'error', animated: true }).metadata();
  } catch (e) {
    throw createError(400, '图片无法识别，请换一张 PNG/JPEG/WebP 图片');
  }
  if (ALLOWED_INPUT_FORMATS.indexOf(meta.format) < 0) {
    throw createError(400, '只支持 PNG/JPEG/WebP 图片，不支持 SVG、网页或动态图片');
  }
  if (meta.pages && meta.pages > 1) throw createError(400, '不支持动态图（GIF/动态 WebP），请改用静态截图');
  const pixels = (meta.width || 0) * (meta.height || 0);
  if (pixels > MAX_RECEIVED_PIXELS) throw createError(400, '图片像素过大，请先裁剪到 2000 万像素以内');

  const longEdge = Math.min(Math.max(meta.width || 0, meta.height || 0) || MAX_EDGE, MAX_EDGE);
  const edges = [longEdge];
  if (longEdge > 1600) edges.push(1600);
  if (longEdge > 1280) edges.push(1280);
  const qualities = [82, 74, 66, 60];
  for (let i = 0; i < edges.length; i++) {
    for (let j = 0; j < qualities.length; j++) {
      const out = await sharpFn(buffer, { failOn: 'error' })
        .rotate()
        .resize({ width: edges[i], height: edges[i], fit: 'inside', withoutEnlargement: true })
        .webp({ quality: qualities[j] })
        .toBuffer({ resolveWithObject: true });
      if (out.info.size <= TARGET_FILE_BYTES) {
        return {
          buffer: out.data,
          width: out.info.width,
          height: out.info.height,
          sizeBytes: out.info.size,
          sha256: crypto.createHash('sha256').update(out.data).digest('hex'),
        };
      }
    }
  }
  throw createError(400, '图片压缩后仍超过 1MB，请裁剪后再试');
}

// 逐张处理；任何一张失败则整批失败（调用方据此不写库、不写文件）
async function encodeImages(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  if (list.length > MAX_IMAGES) throw createError(400, '最多上传 3 张截图');
  const out = [];
  for (let i = 0; i < list.length; i++) {
    out.push(await encodeImage(list[i].buffer));
  }
  return out;
}

function writeEncodedFiles(encoded) {
  const dir = ensureUploadDir();
  const written = [];
  try {
    for (let i = 0; i < encoded.length; i++) {
      const key = crypto.randomBytes(16).toString('hex') + '.webp';
      const full = path.join(dir, key);
      fs.writeFileSync(full, encoded[i].buffer, { mode: 0o600 });
      written.push({ key: key, full: full, meta: encoded[i] });
    }
  } catch (e) {
    written.forEach(function (w) { try { fs.unlinkSync(w.full); } catch (err) { /* 清理失败不影响主错误 */ } });
    throw createError(500, '截图保存失败，请重试');
  }
  return written;
}
function removeFiles(written) {
  (written || []).forEach(function (w) { try { fs.unlinkSync(w.full); } catch (e) { /* 结果未知，运维检查会兜底 */ } });
}

// ---------- 创建 ----------
async function createFeedback(actor, input, files) {
  if (!actor.username) throw createError(401, '请先登录');
  const type = TYPES.indexOf(input.type) >= 0 ? input.type : null;
  if (!type) throw createError(400, '请选择反馈类型');
  const title = cleanText(input.title, 100);
  if (!title.length) throw createError(400, '请填写标题（1—100 字）');
  const description = cleanText(input.description, 5000);
  if (!description.length) throw createError(400, '请填写描述（1—5000 字）');
  const visibility = input.visibility === 'private' ? 'private' : 'public';
  const pagePath = normalizePagePath(input.pagePath);
  // A-07：问题版本由服务端运行元数据写入，客户端传值一律忽略
  const submittedVersion = runtimeVersion();
  const clientRequestId = cleanText(input.clientRequestId, 80) || null;

  const encoded = await encodeImages(files);
  const requestHash = hashRequest({
    title: title, description: description, type: type, visibility: visibility,
    pagePath: pagePath, images: encoded.map(function (e) { return e.sha256; }),
  });

  const client = await pool.connect();
  let written = [];
  try {
    await txControl.begin(client);
    const dup = clientRequestId ? await store.findByIdempotencyKey(client, actor.username, clientRequestId) : null;
    if (dup) {
      await txControl.rollback(client);
      if (dup.requestHash !== requestHash) {
        throw createError(409, '该提交标识已用于另一份内容，请刷新页面后重新提交');
      }
      return { id: dup.id, revision: dup.revision, created: false };
    }
    const nickname = await nicknameOf(client, actor.username);
    const created = await store.insertFeedback(client, {
      authorUsername: actor.username, authorNicknameSnapshot: nickname, type: type,
      title: title, description: description, pagePath: pagePath,
      submittedVersion: submittedVersion, visibility: visibility,
      clientRequestId: clientRequestId, requestHash: requestHash,
    });
    written = writeEncodedFiles(encoded);
    for (let i = 0; i < written.length; i++) {
      await store.insertAttachment(client, {
        feedbackId: created.id, uploaderUsername: actor.username, storageKey: written[i].key,
        mimeType: 'image/webp', sizeBytes: written[i].meta.sizeBytes, sha256: written[i].meta.sha256,
        width: written[i].meta.width, height: written[i].meta.height,
        compressionVersion: COMPRESSION_VERSION, clientRequestId: clientRequestId,
        requestHash: requestHash, sortOrder: i,
      });
    }
    await store.insertEvent(client, {
      feedbackId: created.id, actorUsername: actor.username, actorSource: 'user',
      eventType: 'create', statusTo: 'new', summary: '提交反馈', revision: created.revision,
    });
    await txControl.commit(client);
    return { id: created.id, revision: created.revision, created: true };
  } catch (e) {
    await txControl.rollback(client).catch(function () {});
    removeFiles(written);
    throw e;
  } finally {
    client.release();
  }
}

// ---------- 读取 ----------
async function listPublic(query) {
  const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || 20, 1), 100);
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const filter = buildFilter(query, 'public');
  const result = await store.listFeedbacks(pool, filter, pageSize, (page - 1) * pageSize);
  return {
    items: result.items.map(function (r) { return projectFeedback(r, 'public'); }),
    total: result.total, page: page, pageSize: pageSize,
  };
}

async function listMine(actor, query) {
  if (!actor.username) throw createError(401, '请先登录');
  const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || 20, 1), 100);
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const filter = buildFilter(query, 'mine');
  filter.authorUsername = actor.username;
  const result = await store.listMine(pool, filter, pageSize, (page - 1) * pageSize);
  return {
    items: result.items.map(function (r) { return projectFeedback(r, 'author'); }),
    total: result.total, page: page, pageSize: pageSize,
  };
}

function buildFilter(query, scope) {
  const filter = {
    visibilityScope: scope,
    type: TYPES.indexOf(query.type) >= 0 ? query.type : null,
    status: STATUSES.indexOf(query.status) >= 0 ? query.status : null,
    q: cleanText(query.q, 60) || null,
    sort: query.sort === 'updated' ? 'updated' : 'created',
    from: shanghaiStart(query.from),
    to: shanghaiEndExclusive(query.to),
  };
  return filter;
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

async function counts(actor, query, scope) {
  const filter = buildFilter(query, scope === 'mine' ? 'mine' : 'public');
  if (scope === 'mine') {
    if (!actor.username) throw createError(401, '请先登录');
    filter.authorUsername = actor.username;
  }
  const rows = await store.countByStatus(pool, filter);
  const map = {};
  STATUSES.forEach(function (s) { map[s] = 0; });
  let total = 0;
  rows.forEach(function (r) { map[r.status] = r.count; total += r.count; });
  return { byStatus: map, total: total, labels: STATUS_LABELS };
}

async function detail(id, actor) {
  const db = pool;
  const fb = await loadFeedbackForActor(db, id, actor);
  const [comments, attachments, events] = await Promise.all([
    store.listComments(db, id, actor),
    store.listAttachments(db, id, false),
    store.listEvents(db, id, !!actor.canModerate),
  ]);
  let duplicatePublic = null;
  if (fb.duplicateOf) {
    const target = await store.getFeedback(db, fb.duplicateOf);
    // 关联私密目标不向无权限者泄露编号与标题
    duplicatePublic = target && isPublicVisible(target)
      ? { id: target.id, title: target.title }
      : { id: null, title: '已关联同类反馈' };
  }
  const allowed = {
    edit: canEditOwn(fb, actor),
    withdraw: !!(actor.username && actor.username === fb.authorUsername && !fb.withdrawnAt),
    visibility: !!(actor.username && actor.username === fb.authorUsername && !fb.withdrawnAt),
    comment: !!(actor.username && !fb.withdrawnAt && canView(fb, actor)),
    completeInfo: !!(actor.username && actor.username === fb.authorUsername && fb.status === 'needs_info'),
    moderate: !!actor.canModerate,
  };
  // A-03：按访问者身份裁剪字段，公开响应不出现登录名、内部证据或私密目标编号
  const scope = actor.canModerate ? 'admin' : (actor.username && actor.username === fb.authorUsername ? 'author' : 'public');
  const projected = projectFeedback(Object.assign({}, fb, {
    attachments: attachments.map(function (a) {
      return { id: a.id, width: a.width, height: a.height, sortOrder: a.sortOrder };
    }),
  }), scope);
  return {
    feedback: projected,
    duplicateOf: duplicatePublic,
    comments: comments.map(function (c) { return projectComment(c, actor, c.authorUsername); }),
    events: events,
    permissions: allowed,
  };
}

async function ranking(actor, query) {
  const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || 20, 1), 100);
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const result = await store.rankingPage(pool, pageSize, (page - 1) * pageSize);
  const mine = actor.username ? await store.rankingForUser(pool, actor.username) : null;
  return {
    items: result.items.map(function (r) {
      return { rank: r.rank, nickname: r.nickname, avatar: r.avatar, count: r.count };
    }),
    total: result.total, page: page, pageSize: pageSize,
    mine: mine ? { rank: mine.rank, count: mine.count } : null,
  };
}

async function versionLinkMap(versions) {
  const list = (Array.isArray(versions) ? versions : [])
    .map(function (v) { return cleanText(v, 40); })
    .filter(Boolean).slice(0, 50);
  if (!list.length) return {};
  const rows = await store.versionLinks(pool, list);
  const map = {};
  rows.forEach(function (r) {
    if (!map[r.version]) map[r.version] = [];
    map[r.version].push({ id: r.id, title: r.title });
  });
  return map;
}

// ---------- 本人修改 ----------
async function updateOwn(id, actor, patch, expectedRevision) {
  if (!actor.username) throw createError(401, '请先登录');
  const client = await pool.connect();
  try {
    await txControl.begin(client);
    const fb = await store.lockFeedback(client, id);
    if (!canView(fb, actor)) throw notFound();
    if (!canEditOwn(fb, actor)) throw createError(403, '当前阶段不能修改正文，可在回复中补充');
    assertRevision(fb, expectedRevision);
    const fields = {};
    if (patch.title != null) {
      const title = cleanText(patch.title, 100);
      if (!title.length) throw createError(400, '请填写标题（1—100 字）');
      fields.title = title;
    }
    if (patch.description != null) {
      const description = cleanText(patch.description, 5000);
      if (!description.length) throw createError(400, '请填写描述（1—5000 字）');
      fields.description = description;
    }
    if (patch.type != null) {
      if (TYPES.indexOf(patch.type) < 0) throw createError(400, '反馈类型不合法');
      fields.type = patch.type;
    }
    if (patch.pagePath != null) fields.pagePath = normalizePagePath(patch.pagePath);
    if (!Object.keys(fields).length) throw createError(400, '没有需要保存的内容');
    const revision = await store.updateFeedbackFields(client, id, fields);
    await store.insertEvent(client, {
      feedbackId: id, actorUsername: actor.username, actorSource: 'user',
      eventType: 'edit', summary: '修改反馈内容', revision: revision,
    });
    await txControl.commit(client);
    return { id: id, revision: revision };
  } catch (e) {
    await txControl.rollback(client).catch(function () {});
    throw e;
  } finally {
    client.release();
  }
}

async function withdraw(id, actor, expectedRevision) {
  if (!actor.username) throw createError(401, '请先登录');
  const client = await pool.connect();
  try {
    await txControl.begin(client);
    const fb = await store.lockFeedback(client, id);
    if (!canView(fb, actor)) throw notFound();
    if (fb.authorUsername !== actor.username) throw createError(403, '只有提交人可以撤回');
    if (fb.withdrawnAt) throw createError(400, '该反馈已撤回');
    assertRevision(fb, expectedRevision);
    const revision = await store.updateFeedbackFields(client, id, { withdrawnAt: new Date() });
    await store.insertEvent(client, {
      feedbackId: id, actorUsername: actor.username, actorSource: 'user',
      eventType: 'withdraw', summary: '提交人撤回反馈', revision: revision,
    });
    await txControl.commit(client);
    return { id: id, revision: revision };
  } catch (e) {
    await txControl.rollback(client).catch(function () {});
    throw e;
  } finally {
    client.release();
  }
}

// 可见范围：独立于正文编辑阶段；私密转公开必须本人显式确认
async function setVisibility(id, actor, visibility, expectedRevision) {
  if (!actor.username) throw createError(401, '请先登录');
  if (visibility !== 'public' && visibility !== 'private') throw createError(400, '可见范围不合法');
  const client = await pool.connect();
  try {
    await txControl.begin(client);
    const fb = await store.lockFeedback(client, id);
    if (!canView(fb, actor)) throw notFound();
    if (fb.authorUsername !== actor.username) throw createError(403, '只有提交人可以修改可见范围');
    if (fb.withdrawnAt) throw createError(400, '已撤回的反馈不能再修改');
    assertRevision(fb, expectedRevision);
    const revision = await store.updateFeedbackFields(client, id, { visibility: visibility });
    await store.insertEvent(client, {
      feedbackId: id, actorUsername: actor.username, actorSource: 'user',
      eventType: 'visibility', summary: visibility === 'public' ? '改为公开' : '改为仅本人可见',
      revision: revision,
    });
    await txControl.commit(client);
    return { id: id, revision: revision };
  } catch (e) {
    await txControl.rollback(client).catch(function () {});
    throw e;
  } finally {
    client.release();
  }
}

// 作者完成补充：原子地转回未处理；他人回复不触发
async function completeInfo(id, actor, expectedRevision) {
  if (!actor.username) throw createError(401, '请先登录');
  const client = await pool.connect();
  try {
    await txControl.begin(client);
    const fb = await store.lockFeedback(client, id);
    if (!canView(fb, actor)) throw notFound();
    if (fb.authorUsername !== actor.username) throw createError(403, '只有提交人可以提交补充');
    if (fb.status !== 'needs_info') throw createError(400, '该反馈当前不需要补充');
    assertRevision(fb, expectedRevision);
    const revision = await store.updateFeedbackFields(client, id, { status: 'new' });
    await store.insertEvent(client, {
      feedbackId: id, actorUsername: actor.username, actorSource: 'user', eventType: 'complete_info',
      statusFrom: 'needs_info', statusTo: 'new', summary: '提交人完成补充', revision: revision,
    });
    await txControl.commit(client);
    return { id: id, revision: revision };
  } catch (e) {
    await txControl.rollback(client).catch(function () {});
    throw e;
  } finally {
    client.release();
  }
}

// ---------- 回复 ----------
async function addComment(id, actor, content, clientRequestId) {
  if (!actor.username) throw createError(401, '请先登录');
  const body = cleanText(content, 2000);
  if (!body.length) throw createError(400, '请填写回复内容（1—2000 字）');
  const requestHash = hashRequest({ feedbackId: id, content: body });
  const client = await pool.connect();
  try {
    await txControl.begin(client);
    const fb = await store.lockFeedback(client, id);
    if (!canView(fb, actor)) throw notFound();
    if (fb.withdrawnAt) throw createError(400, '该反馈已撤回，不能再回复');
    if (clientRequestId) {
      const dup = await store.findCommentByRequest(client, actor.username, clientRequestId);
      if (dup) {
        await txControl.rollback(client);
        if (dup.requestHash !== requestHash) throw createError(409, '该回复标识已用于另一条内容');
        return { id: dup.id, feedbackId: dup.feedbackId, created: false };
      }
    }
    const nickname = await nicknameOf(client, actor.username);
    const created = await store.insertComment(client, {
      feedbackId: id, authorUsername: actor.username, authorNicknameSnapshot: nickname,
      content: body, isOfficial: !!actor.canModerate,
      clientRequestId: clientRequestId || null, requestHash: requestHash,
    });
    const revision = await store.bumpRevision(client, id);
    await store.insertEvent(client, {
      feedbackId: id, actorUsername: actor.username, actorSource: actor.canModerate ? 'admin' : 'user',
      eventType: 'comment', summary: '新增回复', revision: revision,
    });
    await txControl.commit(client);
    return { id: created.id, feedbackId: id, created: true, revision: revision };
  } catch (e) {
    await txControl.rollback(client).catch(function () {});
    throw e;
  } finally {
    client.release();
  }
}

async function deleteOwnComment(id, commentId, actor) {
  if (!actor.username) throw createError(401, '请先登录');
  const client = await pool.connect();
  try {
    await txControl.begin(client);
    const fb = await store.lockFeedback(client, id);
    if (!canView(fb, actor)) throw notFound();
    const comment = await store.getComment(client, commentId);
    if (!comment || comment.feedbackId !== String(id)) throw notFound();
    if (comment.authorUsername !== actor.username) throw createError(403, '只能删除自己的回复');
    const ok = await store.markComment(client, commentId, 'delete');
    if (!ok) throw createError(400, '该回复已删除');
    const revision = await store.bumpRevision(client, id);
    await store.insertEvent(client, {
      feedbackId: id, actorUsername: actor.username, actorSource: 'user', eventType: 'comment_delete',
      summary: '删除回复', revision: revision,
    });
    await txControl.commit(client);
    return { id: id, revision: revision };
  } catch (e) {
    await txControl.rollback(client).catch(function () {});
    throw e;
  } finally {
    client.release();
  }
}

async function moderateComment(id, commentId, actor, action, reason) {
  if (!actor.canModerate) throw createError(403, '无权限：需要 content_manage 能力');
  if (['hide', 'restore'].indexOf(action) < 0) throw createError(400, '操作不合法');
  const client = await pool.connect();
  try {
    await txControl.begin(client);
    const fb = await store.lockFeedback(client, id);
    if (!fb) throw notFound();
    const comment = await store.getComment(client, commentId);
    if (!comment || comment.feedbackId !== String(id)) throw notFound();
    if (action === 'hide' && !cleanText(reason, 200)) throw createError(400, '隐藏回复必须填写原因');
    const ok = await store.markComment(client, commentId, action, cleanText(reason, 200));
    if (!ok) throw createError(400, action === 'hide' ? '该回复已隐藏' : '该回复未处于隐藏状态');
    const revision = await store.bumpRevision(client, id);
    await store.insertEvent(client, {
      feedbackId: id, actorUsername: actor.username, actorSource: 'admin',
      eventType: action === 'hide' ? 'comment_hide' : 'comment_restore',
      summary: action === 'hide' ? '隐藏违规回复' : '恢复被隐藏回复',
      note: cleanText(reason, 200), revision: revision,
    });
    await txControl.commit(client);
    return { id: id, revision: revision };
  } catch (e) {
    await txControl.rollback(client).catch(function () {});
    throw e;
  } finally {
    client.release();
  }
}

// ---------- 附件 ----------
async function addAttachments(id, actor, files, expectedRevision, clientRequestId) {
  if (!actor.username) throw createError(401, '请先登录');
  const encoded = await encodeImages(files);
  if (!encoded.length) throw createError(400, '没有收到图片');
  const requestHash = hashRequest({ feedbackId: id, images: encoded.map(function (e) { return e.sha256; }) });
  const client = await pool.connect();
  let written = [];
  try {
    await txControl.begin(client);
    const fb = await store.lockFeedback(client, id);
    if (!canView(fb, actor)) throw notFound();
    if (!canEditOwn(fb, actor)) throw createError(403, '当前阶段不能修改截图');
    assertRevision(fb, expectedRevision);
    if (clientRequestId) {
      const dupRows = [];
      for (let i = 0; i < encoded.length; i++) {
        const dup = await store.findAttachmentByRequest(client, id, clientRequestId, i);
        if (dup) dupRows.push(dup);
      }
      if (dupRows.length) {
        await txControl.rollback(client);
        const sameHash = dupRows.every(function (r) { return r.requestHash === requestHash; });
        if (!sameHash) throw createError(409, '该图片请求标识已用于另一批图片');
        return { feedbackId: id, attachmentIds: dupRows.map(function (r) { return r.id; }), created: false };
      }
    }
    const active = await store.countActiveAttachments(client, id);
    if (active + encoded.length > MAX_IMAGES) {
      throw createError(400, '最多保留 3 张截图，请先移除旧图');
    }
    written = writeEncodedFiles(encoded);
    const ids = [];
    for (let i = 0; i < written.length; i++) {
      const row = await store.insertAttachment(client, {
        feedbackId: id, uploaderUsername: actor.username, storageKey: written[i].key,
        mimeType: 'image/webp', sizeBytes: written[i].meta.sizeBytes, sha256: written[i].meta.sha256,
        width: written[i].meta.width, height: written[i].meta.height,
        compressionVersion: COMPRESSION_VERSION, clientRequestId: clientRequestId || null,
        requestHash: requestHash, sortOrder: active + i,
      });
      ids.push(row.id);
    }
    const revision = await store.bumpRevision(client, id);
    await store.insertEvent(client, {
      feedbackId: id, actorUsername: actor.username, actorSource: 'user', eventType: 'attachment_add',
      summary: '追加截图 ' + encoded.length + ' 张', revision: revision,
    });
    await txControl.commit(client);
    return { feedbackId: id, attachmentIds: ids, created: true, revision: revision };
  } catch (e) {
    await txControl.rollback(client).catch(function () {});
    removeFiles(written);
    throw e;
  } finally {
    client.release();
  }
}

async function deleteAttachment(id, attachmentId, actor, expectedRevision) {
  if (!actor.username) throw createError(401, '请先登录');
  const client = await pool.connect();
  try {
    await txControl.begin(client);
    const fb = await store.lockFeedback(client, id);
    if (!canView(fb, actor)) throw notFound();
    if (!canEditOwn(fb, actor)) throw createError(403, '当前阶段不能修改截图');
    assertRevision(fb, expectedRevision);
    const att = await store.getAttachment(client, attachmentId);
    if (!att || att.feedbackId !== String(id) || att.removedAt) throw notFound();
    await store.removeAttachment(client, attachmentId);
    const revision = await store.bumpRevision(client, id);
    await store.insertEvent(client, {
      feedbackId: id, actorUsername: actor.username, actorSource: 'user', eventType: 'attachment_remove',
      summary: '移除截图', revision: revision,
    });
    await txControl.commit(client);
    return { id: id, revision: revision };
  } catch (e) {
    await txControl.rollback(client).catch(function () {});
    throw e;
  } finally {
    client.release();
  }
}

// 受保护读取：先校验主记录与附件活动状态，再校验会话权限
async function readAttachment(attachmentId, actor, options) {
  const history = !!(options && options.history);
  const expectedFeedbackId = options && options.expectedFeedbackId ? String(options.expectedFeedbackId) : null;
  const att = await store.getAttachment(pool, attachmentId);
  if (!att) throw notFound();
  // 主记录归属必须与请求路径一致，不能用 A 的地址读 B 的附件
  if (expectedFeedbackId && String(att.feedbackId) !== expectedFeedbackId) throw notFound();
  const fb = await store.getFeedback(pool, att.feedbackId);
  if (!canView(fb, actor)) throw notFound();
  if (history) {
    // 历史（已移除）附件只允许该反馈作者与内容管理员读取
    if (!(actor.canModerate || (actor.username && actor.username === fb.authorUsername))) throw notFound();
  } else if (att.removedAt) {
    throw notFound();
  }
  const full = path.join(uploadDir(), safeStorageKey(att.storageKey));
  if (!fs.existsSync(full)) throw notFound();
  return { filePath: full, mimeType: att.mimeType };
}

// ---------- 后台 ----------
async function adminList(actor, query) {
  if (!actor.canModerate) throw createError(403, '无权限：需要 content_manage 能力');
  const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || 20, 1), 100);
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const filter = buildFilter(query, 'admin');
  filter.authorUsernameExact = cleanText(query.author, 64) || null;
  const result = await store.listFeedbacks(pool, filter, pageSize, (page - 1) * pageSize);
  return {
    items: result.items.map(function (r) { return projectFeedback(r, 'admin'); }),
    total: result.total, page: page, pageSize: pageSize,
  };
}

async function adminDetail(id, actor) {
  if (!actor.canModerate) throw createError(403, '无权限：需要 content_manage 能力');
  const fb = await store.getFeedback(pool, id);
  if (!fb) throw notFound();
  const [comments, attachments, events] = await Promise.all([
    store.listComments(pool, id, { canModerate: true, username: actor.username }),
    store.listAttachments(pool, id, true),
    store.listEvents(pool, id, true),
  ]);
  return {
    feedback: projectFeedback(Object.assign({}, fb, { attachments: attachments }), 'admin'),
    comments: comments.map(function (c) { return projectComment(c, actor, c.authorUsername); }),
    events: events,
    permissions: { moderate: true },
  };
}

// 已实施的唯一来源：一条已验收、且清单里把本条核对为「完整解决」的发布批次。
// internalRelease=true 仅供 applyRun 在自己事务内构造字段时使用（此时明细尚未标 applied）。
async function resolveImplementedFields(client, fb, options) {
  const opts = options || {};
  const runId = cleanText(opts.releaseRunId, 20);
  if (!runId) throw createError(400, '标记已实施必须指定已通过专项验收的发布批次');
  const runQuery = await repository.select_ops_feedback_release_runs([runId], client);
  const run = runQuery.rows[0];
  if (!run) throw createError(400, '指定的发布批次不存在');
  if (run.environment !== 'production') throw createError(409, '发布批次不是生产环境记录');
  if (run.verifyStatus !== 'passed') throw createError(409, '该发布批次未通过专项验收，不能标记已实施');
  if (!run.releaseSha || !run.appVersion) throw createError(409, '发布批次缺少发布提交或版本号');
  const evidence = run.verifyEvidence && typeof run.verifyEvidence === 'object' ? run.verifyEvidence : {};
  if (!Object.keys(evidence).length) throw createError(409, '该发布批次没有验收证据，不能标记已实施');

  const itemQuery = await repository.select_ops_feedback_release_items([runId, fb.id], client);
  const item = itemQuery.rows[0];
  if (!item) throw createError(400, '该发布批次清单不包含这条反馈');
  if (item.conclusion !== 'solved') throw createError(400, '该发布批次未把这条反馈核对为完整解决');
  if (!opts.internalRelease) {
    if (item.applyStatus !== 'applied') throw createError(400, '该发布批次尚未成功应用这条反馈');
    if (String(item.expectedRevision) !== String(fb.revision)) {
      throw createError(409, '核对之后这条反馈已被修改，需要重新核对并验收');
    }
  }
  return { implementedVersion: run.appVersion, implementedReleaseSha: run.releaseSha, runId: run.id };
}

// 状态流转校验：所有人工状态变更都走这里（后台 PATCH 与发布回写共用）
async function validateStatusChange(client, fb, next, options) {
  const opts = options || {};
  if (STATUSES.indexOf(next.status) < 0) throw createError(400, '状态不合法');
  const reason = cleanText(opts.reason, 500);
  const reopening = CLOSED_STATUSES.indexOf(fb.status) >= 0 && ['new', 'accepted', 'in_progress'].indexOf(next.status) >= 0;
  if (REASON_REQUIRED_STATUSES.indexOf(next.status) >= 0 && !reason) {
    throw createError(400, '切换到「' + STATUS_LABELS[next.status] + '」必须填写处理原因');
  }
  if (reopening && !reason) throw createError(400, '重新打开必须说明原因');
  const fields = { status: next.status };
  if (next.status === 'implemented') {
    // A-02：版本与发布提交只能来自已通过专项验收、且清单包含本条反馈的发布批次，
    // 不再接受调用方自由填写；客户端传 version/sha 一律忽略。
    const resolved = await resolveImplementedFields(client, fb, opts);
    fields.implementedVersion = resolved.implementedVersion;
    fields.implementedReleaseSha = resolved.implementedReleaseSha;
  } else {
    fields.implementedVersion = null;
    fields.implementedReleaseSha = null;
  }
  if (next.status === 'duplicate') {
    const target = cleanText(opts.duplicateOf, 32);
    if (!target) throw createError(400, '标记重复必须指定主反馈编号');
    if (String(target) === String(fb.id)) throw createError(400, '不能把反馈标记为重复自身');
    const main = await store.getFeedback(client, target);
    if (!main) throw createError(400, '指定的主反馈不存在');
    // 防循环：主反馈不能间接回到自身
    let cursor = main;
    let guard = 0;
    while (cursor && cursor.duplicateOf && guard < 20) {
      if (String(cursor.duplicateOf) === String(fb.id)) throw createError(400, '重复关联会形成循环');
      cursor = await store.getFeedback(client, cursor.duplicateOf);
      guard++;
    }
    fields.duplicateOf = target;
  } else {
    fields.duplicateOf = null;
  }
  return { fields: fields, reason: reason };
}

async function adminUpdate(id, actor, patch) {
  if (!actor.canModerate) throw createError(403, '无权限：需要 content_manage 能力');
  const client = await pool.connect();
  try {
    await txControl.begin(client);
    const fb = await store.lockFeedback(client, id);
    if (!fb) throw notFound();
    assertRevision(fb, patch.expectedRevision);
    const fields = {};
    if (patch.type != null) {
      if (TYPES.indexOf(patch.type) < 0) throw createError(400, '反馈类型不合法');
      fields.type = patch.type;
    }
    let note = cleanText(patch.reason, 500);
    if (patch.moderation != null) {
      if (['normal', 'hidden'].indexOf(patch.moderation) < 0) throw createError(400, '隐藏状态不合法');
      if (patch.moderation === 'hidden' && !note) throw createError(400, '隐藏反馈必须填写原因');
      fields.moderation = patch.moderation;
      fields.moderationReason = patch.moderation === 'hidden' ? note : '';
    }
    if (patch.status != null && patch.status !== fb.status) {
      const validated = await validateStatusChange(client, fb, { status: patch.status }, {
        reason: patch.reason,
        releaseRunId: patch.releaseRunId,
        duplicateOf: patch.duplicateOf,
      });
      Object.assign(fields, validated.fields);
      note = validated.reason || note;
    }
    if (!Object.keys(fields).length) throw createError(400, '没有需要保存的变更');
    const revision = await store.updateFeedbackFields(client, id, fields);
    await store.insertEvent(client, {
      feedbackId: id, actorUsername: actor.username, actorSource: 'admin', eventType: 'admin_update',
      statusFrom: fb.status, statusTo: fields.status || fb.status,
      summary: '管理员更新处理信息', note: note, revision: revision,
    });
    // 离开 implemented 的任何目标状态（new/accepted/in_progress/needs_info/duplicate/declined）都要
    // 失效当前完成通知；不能只监听「重新打开」。失效走同一事务 client，失败则整项回滚。
    if (fb.status === 'implemented' && fields.status && fields.status !== 'implemented') {
      await notificationService.invalidateFeedbackNotifications(client, {
        feedbackId: id,
        reason: '处理状态已更新为「' + (STATUS_LABELS[fields.status] || fields.status) + '」',
      });
    }
    await txControl.commit(client);
    return { id: id, revision: revision };
  } catch (e) {
    await txControl.rollback(client).catch(function () {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = {
  TYPES, TYPE_LABELS, STATUSES, STATUS_LABELS, CLOSED_STATUSES, AUTHOR_EDITABLE_STATUSES,
  MAX_IMAGES, MAX_FILE_BYTES, MAX_REQUEST_BYTES, COMPRESSION_VERSION,
  createError, conflict, notFound,
  uploadDir, ensureUploadDir, normalizePagePath, hashRequest, hashContent,
  loadActor, actorFromRequest, isPublicVisible, canView, canEditOwn,  createFeedback, listPublic, listMine, counts, detail, ranking, versionLinkMap,
  updateOwn, withdraw, setVisibility, completeInfo,
  addComment, deleteOwnComment, moderateComment,
  addAttachments, deleteAttachment, readAttachment,
  adminList, adminDetail, adminUpdate, validateStatusChange,
  encodeImage,
};

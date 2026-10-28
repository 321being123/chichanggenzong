// ========== 知识分享模块路由（文章 / 分类目录树 / 评论 / 公开分享） ==========
const express = require('express');
const asyncHandler = require('../middleware/async');
const router = express.Router();
const crypto = require('crypto');
const net = require('net');
const dns = require('dns').promises;
const { pool, auditLog } = require('../db');
const knowledgeRepository = require('../repositories/knowledgeRepository');
const { requireLogin, optionalLogin, isAdminIdentity } = require('../middleware/auth');
const rateLimit = require('../middleware/rateLimit');
const { redis } = require('../config');
const { safeParseDocx } = require('../services/docxSafe');
const txControl = require('../repositories/transactionControl');

// 生成公开分享 token（随机 48 位十六进制，唯一）
function genToken() {
  return crypto.randomBytes(24).toString('hex');
}

// IP 哈希：只存哈希，不存明文 IP
function hashIp(ip) {
  return crypto.createHash('sha256').update('ks:' + (ip || '0.0.0.0')).digest('hex').slice(0, 32);
}

// 取客户端真实 IP（只信任 Express 经 trust proxy 处理后的 req.ip，避免伪造 X-Forwarded-For 绕过）
function clientIp(req) {
  return req.ip || req.connection.remoteAddress || '0.0.0.0';
}

// 输入长度上限（P2-2）
const LIMITS = {
  title: 255,
  summary: 500,
  categoryName: 100,
  commentNick: 50,
  comment: 2000,
  importUrl: 2048,
  markdown: 5 * 1024 * 1024, // 5MB
  imageSingle: 5 * 1024 * 1024,   // 单张图片 5MB（P2-4）
  imageTotal: 20 * 1024 * 1024,  // 单篇图片总大小 20MB（P2-4）
};

// P2-1：摘要由服务端根据正文生成，不被客户端伪造或超长写入
function deriveSummary(md) {
  let s = (md || '').toString();
  s = s.replace(/```[\s\S]*?```/g, ' ');      // 代码块
  s = s.replace(/`[^`]*`/g, ' ');             // 行内代码
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' '); // 图片
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'); // 链接保留文字
  s = s.replace(/^[#>*_~\-]+/gm, ' ');         // 标题/引用/列表标记
  s = s.replace(/[*_~`>#]/g, ' ');            // 残余标记
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > LIMITS.summary) s = s.slice(0, LIMITS.summary);
  return s;
}

// P2-4：校验正文内嵌图片（Base64 写进 Markdown 的情况）
const ALLOWED_IMG = ['png', 'jpeg', 'jpg', 'gif', 'webp'];
function validateImages(content) {
  if (!content) return { ok: true };
  const re = /!\[[^\]]*\]\(data:image\/([a-zA-Z0-9.+-]+);base64,([^)\s]+)\)/g;
  let m, total = 0;
  while ((m = re.exec(content))) {
    const type = m[1].toLowerCase();
    if (type === 'svg' || type === 'svg+xml') return { ok: false, error: '禁止上传 SVG 图片' };
    if (!ALLOWED_IMG.includes(type)) return { ok: false, error: '不支持的图片格式：' + type };
    const b64 = m[2];
    let bytes = Math.floor((b64.length * 3) / 4);
    if (b64.endsWith('==')) bytes -= 2; else if (b64.endsWith('=')) bytes -= 1;
    if (bytes > LIMITS.imageSingle) return { ok: false, error: '单张图片不能超过 5MB' };
    total += bytes;
    if (total > LIMITS.imageTotal) return { ok: false, error: '单篇文章图片总大小不能超过 20MB' };
  }
  return { ok: true };
}

function resolveCommentNickname(profileNickname, username) {
  const profileName = String(profileNickname || '').trim();
  return String(profileName || username || '匿名').slice(0, LIMITS.commentNick);
}
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const IMPORT_TIMEOUT_MS = 25000;

// 写权限中间件：统一登录态校验已把当前用户放入 req.authUser。
async function requireKsWrite(req, res, next) {
  const u = req.authUser;
  if (u && (isAdminIdentity(u.username, u.role) || (u.permissions && u.permissions.knowledge_write))) return next();
  return res.status(403).json({ error: '你暂无投资笔记的写权限' });
}

// 当前用户角色与写权限
async function getUserKsInfo(username) {
  const r = await knowledgeRepository.readUserAccess({ username });
  const role = r && r.role;
  const isAdmin = isAdminIdentity(username, role);
  const canWrite = isAdmin || !!(r && r.permissions && r.permissions.knowledge_write);
  return { role, isAdmin, canWrite };
}

// 文章归属校验：仅作者本人可以修改自己的文章
async function requireArticleOwner(req, res, next) {
  const username = req.session && req.session.user;
  if (!username) return res.status(401).json({ error: '未登录' });
  try {
    const id = parseInt(req.params.id, 10);
    const authorRow = await knowledgeRepository.readArticleAuthor({ id });
    if (!authorRow) return res.status(404).json({ error: '文章不存在' });
    const info = await getUserKsInfo(username);
    if (info.canWrite && authorRow.author_username === username) return next();
    return res.status(403).json({ error: '无权操作该文章' });
  } catch (e) {
    return res.status(500).json({ error: '校验权限失败' });
  }
}

// 分类归属校验：仅创建该分类的用户可以管理
async function requireCategoryOwner(req, res, next) {
  const username = req.session && req.session.user;
  if (!username) return res.status(401).json({ error: '未登录' });
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: '分类参数无效' });
    const ownerRow = await knowledgeRepository.readCategoryOwner({ id });
    if (!ownerRow) return res.status(404).json({ error: '分类不存在' });
    const info = await getUserKsInfo(username);
    if (info.canWrite && ownerRow.owner_username === username) return next();
    return res.status(403).json({ error: '只能管理自己创建的分类' });
  } catch (e) {
    return res.status(500).json({ error: '校验分类权限失败' });
  }
}

// 当前登录用户角色/写权限（供前端隐藏写按钮与分类管理）
router.get('/can-write', requireLogin, asyncHandler(async (req, res) => {
  try {
    const info = await getUserKsInfo(req.session.user);
    res.json({ canWrite: info.canWrite, isAdmin: info.isAdmin });
  } catch (e) {
    res.status(500).json({ error: '查询写权限失败' });
  }
}));

// 把扁平分类列表整理成树
function buildTree(rows) {
  const map = new Map();
  rows.forEach(r => map.set(r.id, { ...r, children: [] }));
  const roots = [];
  rows.forEach(r => {
    const node = map.get(r.id);
    if (r.parent_id && map.has(r.parent_id)) map.get(r.parent_id).children.push(node);
    else roots.push(node);
  });
  return roots;
}

// ---------- 分类目录树 ----------
// P2-6：读取接口不再写库（默认分类由迁移 018 幂等种子）
router.get('/categories', optionalLogin, asyncHandler(async (req, res) => {
  try {
    const username = req.authUser && req.authUser.username;
    const rows = await knowledgeRepository.listCategories({ username });
    res.json(buildTree(rows));
  } catch (e) {
    res.status(500).json({ error: '读取分类失败' });
  }
}));

// 有知识写作权限的用户可新增分类，并拥有自己创建的分类
router.post('/categories', requireLogin, requireKsWrite, asyncHandler(async (req, res) => {
  try {
    const name = String(req.body.name || '').trim().slice(0, LIMITS.categoryName);
    if (!name) return res.status(400).json({ error: '分类名称不能为空' });
    const parentId = req.body.parent_id ? parseInt(req.body.parent_id, 10) : null;
    const sortOrder = parseInt(req.body.sort_order || '0', 10) || 0;
    const created = await knowledgeRepository.insertCategory({
      name, parentId, sortOrder, ownerUsername: req.session.user,
    });
    await auditLog(req.session.user, 'ks_category_create', created.id, '新建分类：' + name).catch(() => {});
    res.json({ id: created.id });
  } catch (e) {
    if (/uq_cat_parent_name/.test(e.message || '')) return res.status(400).json({ error: '同级已存在同名分类' });
    res.status(500).json({ error: '新建分类失败' });
  }
}));

router.put('/categories/:id', requireLogin, requireCategoryOwner, asyncHandler(async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const name = String(req.body.name || '').trim().slice(0, LIMITS.categoryName);
    if (!name) return res.status(400).json({ error: '分类名称不能为空' });
    await knowledgeRepository.renameCategory({ name, id });
    await auditLog(req.session.user, 'ks_category_update', id, '编辑分类：' + name).catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    if (/uq_cat_parent_name/.test(e.message || '')) return res.status(400).json({ error: '同级已存在同名分类' });
    res.status(500).json({ error: '更新分类失败' });
  }
}));

router.post('/categories/:id/move', requireLogin, requireCategoryOwner, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const parentId = req.body.parent_id ? parseInt(req.body.parent_id, 10) : null;
  const beforeId = req.body.before_id ? parseInt(req.body.before_id, 10) : null;
  if ((parentId !== null && !Number.isInteger(parentId)) || (beforeId !== null && !Number.isInteger(beforeId))) {
    return res.status(400).json({ error: '移动参数无效' });
  }

  const client = await pool.connect();
  try {
    await txControl.begin(client);
    const current = await client.query(
      'SELECT id, parent_id FROM article_categories WHERE id=$1 AND owner_username=$2 FOR UPDATE',
      [id, req.session.user]
    );
    if (!current.rows[0]) {
      await txControl.rollback(client);
      return res.status(404).json({ error: '分类不存在' });
    }
    if (parentId !== null) {
      const parent = await client.query('SELECT id FROM article_categories WHERE id=$1 AND owner_username=$2', [parentId, req.session.user]);
      if (!parent.rows[0]) {
        await txControl.rollback(client);
        return res.status(400).json({ error: '目标分类不存在' });
      }
    }

    const all = await client.query('SELECT id, parent_id FROM article_categories');
    const parentMap = new Map(all.rows.map(row => [row.id, row.parent_id]));
    let cursor = parentId;
    while (cursor !== null) {
      if (cursor === id) {
        await txControl.rollback(client);
        return res.status(400).json({ error: '不能移动到自身或自己的子分类下' });
      }
      cursor = parentMap.get(cursor) ?? null;
    }

    const oldParentId = current.rows[0].parent_id;
    await client.query('UPDATE article_categories SET parent_id=$1 WHERE id=$2', [parentId, id]);
    const target = await client.query(
      `SELECT id FROM article_categories
       WHERE parent_id IS NOT DISTINCT FROM $1 AND id<>$2 AND owner_username=$3
       ORDER BY sort_order, id`,
      [parentId, id, req.session.user]
    );
    const targetIds = target.rows.map(row => row.id);
    let insertAt = targetIds.length;
    if (beforeId !== null) {
      insertAt = targetIds.indexOf(beforeId);
      if (insertAt < 0) {
        await txControl.rollback(client);
        return res.status(400).json({ error: '目标排序位置无效' });
      }
    }
    targetIds.splice(insertAt, 0, id);
    for (let i = 0; i < targetIds.length; i++) {
      await client.query('UPDATE article_categories SET sort_order=$1 WHERE id=$2', [(i + 1) * 10, targetIds[i]]);
    }

    if (oldParentId !== parentId) {
      const old = await client.query(
        `SELECT id FROM article_categories
         WHERE parent_id IS NOT DISTINCT FROM $1 AND owner_username=$2
         ORDER BY sort_order, id`,
        [oldParentId, req.session.user]
      );
      for (let i = 0; i < old.rows.length; i++) {
        await client.query('UPDATE article_categories SET sort_order=$1 WHERE id=$2', [(i + 1) * 10, old.rows[i].id]);
      }
    }
    await txControl.commit(client);
    await auditLog(req.session.user, 'ks_category_move', id, '移动分类').catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    await txControl.rollback(client).catch(() => {});
    if (/uq_cat_parent_name/.test(e.message || '')) return res.status(400).json({ error: '目标位置已有同名分类' });
    res.status(500).json({ error: '移动分类失败' });
  } finally {
    client.release();
  }
}));

router.delete('/categories/:id', requireLogin, requireCategoryOwner, asyncHandler(async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await knowledgeRepository.deleteCategory({ id });
    await auditLog(req.session.user, 'ks_category_delete', id, '删除分类').catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: '删除分类失败' });
  }
}));

// ---------- 文章列表 ----------
router.get('/articles', optionalLogin, asyncHandler(async (req, res) => {
  try {
    // 只信任 optionalLogin 校验后的 req.authUser，禁止用已吊销会话直接读取草稿。
    const username = req.authUser && req.authUser.username;
    const isLogin = !!username;
    const me = isLogin ? await getUserKsInfo(username) : { isAdmin: false, canWrite: false, username: null };
    const categoryId = req.query.category_id ? parseInt(req.query.category_id, 10) : null;
    const q = req.query.q ? String(req.query.q).trim() : '';
    const params = [];
    let where = '';
    // 可见性规则（P0-2）
    if (!isLogin) {
      where = "WHERE a.status='published' ";
    } else if (me.isAdmin) {
      if (req.query.status === 'draft' || req.query.status === 'published') {
        where = 'WHERE a.status=$1 '; params.push(req.query.status);
      }
    } else if (me.canWrite) {
      where = 'WHERE (a.status=$1 OR a.author_username=$2) ';
      params.push('published', username);
    } else {
      where = "WHERE a.status='published' ";
    }
    if (categoryId) {
      where += (where ? 'AND ' : 'WHERE ') + 'a.category_id=$' + (params.length + 1) + ' ';
      params.push(categoryId);
    }
    if (q) {
      where += (where ? 'AND ' : 'WHERE ') + 'a.title ILIKE $' + (params.length + 1) + ' ';
      params.push('%' + q + '%');
    }
    // 列表不返回 share_token（P0-2.5）
    const orderBy = 'a.sort_order ASC, a.id ASC';
    const sql = `
      SELECT a.id, a.title, a.summary, a.category_id, c.name AS category_name,
             a.status, a.view_count, a.author_username,
             a.created_at, a.updated_at, a.published_at, a.sort_order
      FROM articles a
      LEFT JOIN article_categories c ON c.id = a.category_id
      ${where}
      ORDER BY ${orderBy}
      LIMIT 200
    `;
    const rows = (await knowledgeRepository.listArticles({ where, values: params })).map(a => ({
      ...a,
      can_edit: me.canWrite && a.author_username === username,
      can_delete: me.canWrite && a.author_username === username,
    }));
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: '读取文章列表失败' });
  }
}));

// 首页最新文章（公开）
router.get('/latest', asyncHandler(async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 5, 20);
    res.json(await knowledgeRepository.listLatestArticles({ limit }));
  } catch (e) {
    res.status(500).json({ error: '读取最新文章失败' });
  }
}));

// ---------- 单篇文章详情 ----------
async function getRawArticle(id) {
  return knowledgeRepository.readArticleById({ id });
}

router.get('/articles/:id', optionalLogin, asyncHandler(async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const article = await getRawArticle(id);
    if (!article) return res.status(404).json({ error: '文章不存在或未发布' });
    const username = req.authUser && req.authUser.username;
    const isLogin = !!username;
    const me = isLogin ? await getUserKsInfo(username) : { isAdmin: false, username: null };
    // 草稿仅作者或管理员可见
    if (article.status !== 'published' && !(me.isAdmin || article.author_username === username)) {
      return res.status(404).json({ error: '文章不存在或未发布' });
    }
    const isOwner = !!(me.canWrite && article.author_username === username);
    const out = { ...article };
    delete out.share_token;
    out.can_edit = isOwner;
    out.can_delete = isOwner;
    // share_token 仅作者/管理员读取已发布单篇时返回
    if (isOwner && article.status === 'published') out.share_token = article.share_token;
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: '读取文章失败' });
  }
}));

// ---------- 公开分享（免登录） ----------
router.get('/share/:token', asyncHandler(async (req, res) => {
  try {
    const token = String(req.params.token || '');
    const row = await knowledgeRepository.readArticleByShareToken({ token });
    if (!row || row.status !== 'published') return res.status(404).json({ error: '分享链接无效或文章未发布' });
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: '读取分享文章失败' });
  }
}));

// ---------- 新建 ----------
router.post('/articles', requireLogin, requireKsWrite, asyncHandler(async (req, res) => {
  try {
    const title = String(req.body.title || '').trim().slice(0, LIMITS.title);
    if (!title) return res.status(400).json({ error: '标题不能为空' });
    const content = String(req.body.content || '');
    if (content.length > LIMITS.markdown) return res.status(413).json({ error: '正文内容过大' });
    // P2-4：图片类型/大小/SVG 校验（正文内嵌 Base64）
    const imgCheck = validateImages(content);
    if (!imgCheck.ok) return res.status(400).json({ error: imgCheck.error });
    // P2-1：html_content 不再信任前端提交；summary 由服务端从正文生成
    const htmlContent = null;
    const summary = deriveSummary(content);
    const categoryId = req.body.category_id ? parseInt(req.body.category_id, 10) : null;
    const status = req.body.status === 'published' ? 'published' : 'draft';
    const shareToken = genToken();
    const created = await knowledgeRepository.insertArticle({
      title, content, htmlContent, summary, categoryId, status,
      shareToken, authorUsername: req.session.user,
    });
    const newId = created.id;
    await auditLog(req.session.user, 'ks_article_create', newId, '新建' + (status === 'published' ? '并发布' : '草稿') + '文章：' + title).catch(() => {});
    res.json({ id: newId, share_token: shareToken, status });
  } catch (e) {
    res.status(500).json({ error: '新建文章失败' });
  }
}));

// ---------- 分类内文章排序 ----------
router.put('/articles/reorder', requireLogin, requireKsWrite, asyncHandler(async (req, res) => {
  const rawCategoryId = req.body.category_id;
  const categoryId = rawCategoryId === null || rawCategoryId === undefined || rawCategoryId === ''
    ? null
    : parseInt(rawCategoryId, 10);
  const orderedIds = Array.isArray(req.body.article_ids) ? req.body.article_ids.map(Number) : [];
  if ((categoryId !== null && !Number.isInteger(categoryId)) || !orderedIds.length || orderedIds.some(id => !Number.isInteger(id))) {
    return res.status(400).json({ error: '排序参数无效' });
  }
  if (new Set(orderedIds).size !== orderedIds.length) return res.status(400).json({ error: '文章列表重复' });

  const client = await pool.connect();
  try {
    await txControl.begin(client);
    const rows = await client.query(
      'SELECT id, category_id, author_username FROM articles ORDER BY sort_order, id FOR UPDATE'
    );
    const scopedRows = categoryId === null
      ? rows.rows
      : rows.rows.filter(row => Number(row.category_id) === categoryId);
    const actualIds = scopedRows.map(row => row.id);
    if (actualIds.length !== orderedIds.length || actualIds.some(id => !orderedIds.includes(id))) {
      await txControl.rollback(client);
      return res.status(409).json({ error: '文章列表已变化，请刷新后重试' });
    }
    const me = await getUserKsInfo(req.session.user);
    if (!me.isAdmin && scopedRows.some(row => row.author_username !== req.session.user)) {
      await txControl.rollback(client);
      return res.status(403).json({ error: '只能排序自己创建的文章' });
    }
    const queue = orderedIds.slice();
    const finalIds = categoryId === null
      ? queue
      : rows.rows.map(row => Number(row.category_id) === categoryId ? queue.shift() : row.id);
    for (let i = 0; i < finalIds.length; i++) {
      await client.query('UPDATE articles SET sort_order=$1 WHERE id=$2', [(i + 1) * 10, finalIds[i]]);
    }
    await txControl.commit(client);
    await auditLog(req.session.user, 'ks_article_reorder', categoryId, '调整分类内文章顺序').catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    await txControl.rollback(client).catch(() => {});
    res.status(500).json({ error: '文章排序失败' });
  } finally {
    client.release();
  }
}));

// ---------- 更新（归属校验 + 保留发布时间） ----------
router.put('/articles/:id', requireLogin, requireArticleOwner, asyncHandler(async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const title = req.body.title != null ? String(req.body.title).trim().slice(0, LIMITS.title) : null;
    const content = req.body.content != null ? String(req.body.content) : null;
    if (content && content.length > LIMITS.markdown) return res.status(413).json({ error: '正文内容过大' });
    if (content) {
      const imgCheck = validateImages(content);
      if (!imgCheck.ok) return res.status(400).json({ error: imgCheck.error });
    }
    // P2-1：有正文才重算摘要；html_content 不信任前端，保持原值
    const summary = content ? deriveSummary(content) : null;
    const hasCategoryId = Object.prototype.hasOwnProperty.call(req.body, 'category_id');
    const categoryId = !hasCategoryId || req.body.category_id === null || req.body.category_id === ''
      ? null
      : parseInt(req.body.category_id, 10);
    if (hasCategoryId && categoryId !== null && !Number.isInteger(categoryId)) {
      return res.status(400).json({ error: '文章分类无效' });
    }
    const curRow = await knowledgeRepository.readArticleStatusAndPublished({ id });
    if (!curRow) return res.status(404).json({ error: '文章不存在' });
    const status = req.body.status === 'published' ? 'published'
      : req.body.status === 'draft' ? 'draft' : curRow.status;
    // P1-2：已发布文章普通编辑保留原发布时间；草稿首次发布才设为 now()
    const publishedAtSql = (status === 'published' && !curRow.published_at) ? 'now()' : 'published_at';
    await knowledgeRepository.updateArticle({
      title, content, summary, hasCategoryId, categoryId, status, id,
      setPublishedNow: publishedAtSql === 'now()',
    });
    await auditLog(req.session.user, 'ks_article_update', id, '编辑文章（状态：' + status + '）').catch(() => {});
    res.json({ ok: true, status });
  } catch (e) {
    res.status(500).json({ error: '更新文章失败' });
  }
}));

// ---------- 删除（归属校验） ----------
router.delete('/articles/:id', requireLogin, requireArticleOwner, asyncHandler(async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await knowledgeRepository.deleteArticle({ id });
    await auditLog(req.session.user, 'ks_article_delete', id, '删除文章').catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: '删除文章失败' });
  }
}));

// 发布 / 撤回（归属校验）
router.post('/articles/:id/publish', requireLogin, requireArticleOwner, asyncHandler(async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const curRow = await knowledgeRepository.readArticleShareToken({ id });
    if (!curRow) return res.status(404).json({ error: '文章不存在' });
    const token = curRow.share_token || genToken();
    // 保留原有发布时间；撤回后再发布则使用当前时间
    await knowledgeRepository.publishArticle({ token, id });
    await auditLog(req.session.user, 'ks_article_publish', id, '发布文章').catch(() => {});
    res.json({ ok: true, share_token: token });
  } catch (e) {
    res.status(500).json({ error: '发布失败' });
  }
}));

router.post('/articles/:id/unpublish', requireLogin, requireArticleOwner, asyncHandler(async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await knowledgeRepository.unpublishArticle({ id });
    await auditLog(req.session.user, 'ks_article_unpublish', id, '撤回文章').catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: '撤回失败' });
  }
}));

// 阅读量 +1（P2-7：仅已发布文章，不存在返回 404）
router.post('/articles/:id/view', asyncHandler(async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const statusRow = await knowledgeRepository.readArticleStatus({ id });
    if (!statusRow) return res.status(404).json({ error: '文章不存在' });
    if (statusRow.status !== 'published') return res.status(404).json({ error: '文章未发布' });
    await knowledgeRepository.incrementArticleView({ id });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: '更新阅读量失败' });
  }
}));

// ---------- 评论（楼中楼嵌套） ----------
// 返回嵌套结构：一级评论（parent_id IS NULL）+ 其下 replies 数组
router.get('/articles/:id/comments', optionalLogin, asyncHandler(async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const article = await getRawArticle(id);
    if (!article) return res.status(404).json({ error: '文章不存在或未发布' });
    if (article.status !== 'published') {
      const username = req.authUser && req.authUser.username;
      if (!username) return res.status(404).json({ error: '文章不存在或未发布' });
      const access = await getUserKsInfo(username);
      if (!access.isAdmin && article.author_username !== username) {
        return res.status(404).json({ error: '文章不存在或未发布' });
      }
    }
    const r = { rows: await knowledgeRepository.listComments({ articleId: id }) };
    const username = req.authUser && req.authUser.username;
    const me = username ? await getUserKsInfo(username) : { isAdmin: false, username: null };
    const all = r.rows.map(c => ({
      ...c,
      can_delete: me.isAdmin || c.author_username === username,
    }));
    const buildTree = () => {
      const map = new Map();
      all.forEach(c => map.set(c.id, { ...c, replies: [] }));
      const roots = [];
      map.forEach(c => {
        if (c.parent_id && map.has(c.parent_id)) map.get(c.parent_id).replies.push(c);
        else roots.push(c);
      });
      return roots;
    };
    res.json(buildTree());
  } catch (e) {
    res.status(500).json({ error: '读取评论失败' });
  }
}));

// P1-6：评论限流——以登录用户名+文章为权威维度（不可伪造），Redis 优先、内存兜底
router.post('/articles/:id/comments', requireLogin,
  rateLimit({
    prefix: 'ks-comment', windowMs: 5 * 60 * 1000, max: 10,
    getKey: req => (req.session.user || 'anon') + ':' + req.params.id,
    message: '评论太频繁，请稍后再试',
  }),
  asyncHandler(async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const articleRow = await knowledgeRepository.readArticleStatus({ id });
      if (!articleRow || articleRow.status !== 'published') {
        return res.status(404).json({ error: '文章不存在或未发布' });
      }
      const content = String(req.body.content || '').trim();
      if (!content) return res.status(400).json({ error: '评论内容不能为空' });
      if (content.length > LIMITS.comment) return res.status(400).json({ error: '评论内容过长' });
      const userRow = await knowledgeRepository.readUserNickname({ username: req.session.user });
      if (!userRow) return res.status(401).json({ error: '登录状态已失效' });
      const nickname = resolveCommentNickname(userRow.nickname, req.session.user);
      const ipHash = hashIp(clientIp(req));
      // 处理楼中楼：parent_id 指向某条已有评论
      let parentId = null;
      let rootId = null;
      if (req.body.parent_id) {
        const pid = parseInt(req.body.parent_id, 10);
        const pr = await knowledgeRepository.readCommentParent({ id: pid, articleId: id });
        if (pr) {
          parentId = pr.id;
          rootId = pr.root_id || pr.id;
        }
      }
      // P0-3：author_username 从会话写入，不接受前端传入
      const inserted = await knowledgeRepository.insertComment({
        articleId: id, parentId, rootId, nickname, content, ipHash, authorUsername: req.session.user,
      });
      res.json(inserted);
    } catch (e) {
      res.status(500).json({ error: '发表评论失败' });
    }
  }
));

// P0-3：删除评论——仅作者或管理员
router.delete('/comments/:id', requireLogin, asyncHandler(async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const authorRow = await knowledgeRepository.readCommentAuthor({ id });
    if (!authorRow) return res.status(404).json({ error: '评论不存在' });
    const me = await getUserKsInfo(req.session.user);
    if (!me.isAdmin && authorRow.author_username !== req.session.user) {
      return res.status(403).json({ error: '无权删除该评论' });
    }
    await knowledgeRepository.deleteComment({ id });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: '删除评论失败' });
  }
}));

// ---------- 链接导入（抓取网页正文转 Markdown） ----------
// 优先使用 Jina AI Reader（GitHub: jina-ai/reader），可绕过语雀等反爬站点；
// 失败时回退到本地 fetch + Readability + Turndown。
router.post('/import-url', requireLogin, requireKsWrite, asyncHandler(async (req, res) => {
  try {
    const url = String(req.body.url || '').trim();
    if (!url) return res.status(400).json({ error: '请提供文章链接' });
    if (url.length > LIMITS.importUrl) return res.status(400).json({ error: '链接过长' });
    // P1-4：SSRF 防护（异步 DNS 解析 + 公网地址校验）
    if (!await isSafeUrl(url)) return res.status(400).json({ error: '链接不合法或目标不可访问' });

    const isWeChat = isWeChatArticleUrl(url);
    let result = isWeChat ? await fetchWeChatArticle(url) : await fetchJinaReader(url);
    if (!result && isWeChat) {
      result = await fetchJinaReader(url);
    }
    if (!result || !result.content) {
      result = await fetchWithReadability(url);
    }
    if (!result || !result.content) {
      return res.status(422).json({ error: '无法提取正文，可能是登录页、纯图片页或目标网站禁止抓取' });
    }
    if ((result.content || '').length > LIMITS.markdown) {
      return res.status(413).json({ error: '抓取内容过大' });
    }
    await auditLog(req.session.user, 'ks_import_url', '-', '链接导入：' + url).catch(() => {});
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: '链接抓取失败' });
  }
}));

// P1-4：SSRF 防护
// 仅允许 http/https；默认仅 80/443；拒绝内网/回环/链路本地/保留地址（含 IPv6 与 DNS 解析后的真实地址）
function isPublicIPv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => isNaN(n) || n < 0 || n > 255)) return false;
  if (p[0] === 0) return false;            // 0.0.0.0/8
  if (p[0] === 10) return false;           // 私网
  if (p[0] === 127) return false;          // 回环
  if (p[0] === 169 && p[1] === 254) return false; // 链路本地
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return false; // 私网
  if (p[0] === 192 && p[1] === 168) return false; // 私网
  if (p[0] >= 224) return false;           // 多播/保留
  return true;
}
function isPublicIPv6(addr) {
  const a = addr.toLowerCase();
  if (a === '::1' || a === '::' || a === '0:0:0:0:0:0:0:1') return false;
  if (a.startsWith('fe80')) return false;   // 链路本地
  if (a.startsWith('fc') || a.startsWith('fd')) return false; // 唯一本地
  if (a.startsWith('::ffff:')) return isPublicIPv4(a.slice('::ffff:'.length)); // IPv4 映射
  return true;
}
async function resolveSafeTarget(url) {
  let u;
  try { u = new URL(url); } catch (e) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const port = u.port ? parseInt(u.port, 10) : (u.protocol === 'https:' ? 443 : 80);
  if (port !== 80 && port !== 443) return null;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    const family = net.isIPv4(host) ? 4 : 6;
    const ok = family === 4 ? isPublicIPv4(host) : isPublicIPv6(host);
    return ok ? { url: u, hostname: host, address: host, family } : null;
  }
  // 域名：解析全部地址，任一非公网则拒绝，并返回一个将用于真实连接的固定地址。
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); } catch (e) { return null; }
  if (!addrs.length) return null;
  for (const a of addrs) {
    const ok = a.family === 4 ? isPublicIPv4(a.address) : isPublicIPv6(a.address);
    if (!ok) return null;
  }
  return { url: u, hostname: host, address: addrs[0].address, family: addrs[0].family };
}

async function isSafeUrl(url) {
  return !!(await resolveSafeTarget(url));
}

function createPinnedDispatcher(target) {
  const { Agent } = require('undici');
  return new Agent({
    connect: {
      lookup(hostname, options, callback) {
        if (String(hostname).toLowerCase() !== target.hostname) {
          return callback(new Error('目标主机在连接前发生变化'));
        }
        if (options && options.all) return callback(null, [{ address: target.address, family: target.family }]);
        return callback(null, target.address, target.family);
      },
    },
  });
}

// ---------- 文件导入（Word / Markdown / txt） ----------
const multer = require('multer');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
});

router.post('/import-file', requireLogin, requireKsWrite, upload.single('file'), asyncHandler(async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '未收到文件' });
    const fname = req.file.originalname || '';
    const lower = fname.toLowerCase();
    const buf = req.file.buffer;
    if (buf.length > 15 * 1024 * 1024) return res.status(413).json({ error: '文件过大' });
    let title = fname.replace(/\.[^.]+$/, '');
    let content = '';
    if (lower.endsWith('.md') || lower.endsWith('.markdown') || lower.endsWith('.txt')) {
      const decoded = decodeBufferWithChardet(buf);
      content = decoded.text;
      const titleMatch = content.match(/^#\s+(.+)$/m);
      if (titleMatch) title = titleMatch[1].trim();
    } else if (lower.endsWith('.docx')) {
      // P2-3：核对 MIME，拒绝伪装文件
      if (req.file.mimetype && !/wordprocessingml|officedocument|zip|octet-stream/.test(req.file.mimetype)) {
        return res.status(400).json({ error: '文件类型不支持' });
      }
      content = await safeParseDocx(buf, { timeoutMs: 15000 });
    } else {
      return res.status(400).json({ error: '仅支持 .md / .txt / .docx 文件' });
    }
    // P2-3：限制最终 Markdown 长度
    if (content.length > LIMITS.markdown) return res.status(413).json({ error: '文件内容过大' });
    await auditLog(req.session.user, 'ks_import_file', '-', '文件导入：' + fname).catch(() => {});
    res.json({ title: title, content: content });
  } catch (e) {
    res.status(500).json({ error: '文件解析失败' });
  }
}));

// ---------- 辅助函数 ----------

async function fetchJinaReader(url) {
  const jinaUrl = 'https://r.jina.ai/' + url;
  try {
    const r = await fetchWithProxy(jinaUrl, {
      maxBytes: MAX_IMPORT_BYTES,
      allowedTypes: ['text/plain', 'application/json', 'text/'],
      timeoutMs: IMPORT_TIMEOUT_MS,
      headers: { 'Accept': 'text/plain, */*' },
    });
    if (!r.ok) return null;
    const text = await r.text();
    return parseJinaOutput(text);
  } catch (e) {
    console.error('Jina Reader failed:', e.message);
    return null;
  }
}

// 统一请求走系统代理（Node 内置 fetch 不读 HTTP_PROXY，这里用 undici.request）
function getProxyDispatcher() {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (!proxy) return null;
  try {
    const { ProxyAgent } = require('undici');
    return new ProxyAgent(proxy);
  } catch (e) {
    console.error('Proxy agent init failed:', e.message);
    return null;
  }
}

// P1-5：不打印完整代理地址/凭据；带响应大小与内容类型限制
async function fetchWithProxy(url, options = {}) {
  const undici = require('undici');
  let dispatcher = null;
  let pinnedDispatcher = null;
  const maxBytes = options.maxBytes || MAX_IMPORT_BYTES;
  const allowedTypes = options.allowedTypes || null;
  const timeoutMs = options.timeoutMs || IMPORT_TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    if (options.enforcePublicTarget) {
      const target = await resolveSafeTarget(url);
      if (!target) return { ok: false, status: 400, text: () => Promise.resolve('') };
      // 用户控制的目标不交给代理二次解析；连接固定到本次验证通过的公网 IP。
      pinnedDispatcher = createPinnedDispatcher(target);
      dispatcher = pinnedDispatcher;
    } else {
      dispatcher = getProxyDispatcher();
    }
    const { requestWithLimits } = require('../services/knowledgeSource');
    return await requestWithLimits(url, {
      dispatcher,
      signal: ctrl.signal,
      headers: options.headers,
      method: options.method,
      maxBytes,
      allowedTypes,
    });
  } catch (e) {
    return { ok: false, status: 0, statusText: 'fetch error', text: () => Promise.resolve(String((e && e.message) || '')) };
  } finally {
    clearTimeout(timer);
    if (pinnedDispatcher) await pinnedDispatcher.close().catch(() => {});
  }
}

function safeClose(body) {
  if (!body) return;
  try { if (body.getReader) body.getReader().cancel(); else if (body.destroy) body.destroy(); }
  catch (e) {}
}

function parseJinaOutput(text) {
  const lines = text.split(/\r?\n/);
  let title = '';
  let contentStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('Title:')) {
      title = line.slice(6).trim();
    } else if (line.startsWith('Markdown Content:')) {
      contentStart = i + 1;
      break;
    }
  }
  const content = contentStart >= 0 ? lines.slice(contentStart).join('\n').trim() : text.trim();
  if (!content && !title) return null;
  return { title, content };
}

function isWeChatArticleUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.hostname.toLowerCase() === 'mp.weixin.qq.com' && /^\/s(?:\/|$)/.test(url.pathname);
  } catch (e) {
    return false;
  }
}

function buildWeChatArticleUrl(rawUrl) {
  const url = new URL(rawUrl);
  url.searchParams.set('nwr_flag', '1');
  url.hash = '';
  return url.toString();
}

function parseWeChatArticleHtml(html, url) {
  const { JSDOM } = require('jsdom');
  const TurndownService = require('turndown');
  const dom = new JSDOM(html, { url });
  const document = dom.window.document;
  const article = document.querySelector('#js_content');
  if (!article) return null;
  article.querySelectorAll('script, style').forEach(node => node.remove());
  article.querySelectorAll('img[data-src]').forEach(img => {
    if (!img.getAttribute('src')) img.setAttribute('src', img.getAttribute('data-src'));
  });
  const titleNode = document.querySelector('#activity-name');
  const titleMeta = document.querySelector('meta[property="og:title"]');
  const title = String(
    (titleNode && titleNode.textContent) || (titleMeta && titleMeta.getAttribute('content')) || ''
  ).trim();
  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  const content = turndown.turndown(article.innerHTML).trim();
  return content ? { title, content } : null;
}

async function fetchWeChatArticle(url) {
  try {
    const requestUrl = buildWeChatArticleUrl(url);
    const response = await fetchWithProxy(requestUrl, {
      maxBytes: MAX_IMPORT_BYTES,
      allowedTypes: ['text/html', 'application/xhtml+xml'],
      timeoutMs: IMPORT_TIMEOUT_MS,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/107.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.50 WeChat/arm64 NetType/WIFI Language/zh_CN',
        Referer: 'https://mp.weixin.qq.com/',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    });
    if (!response.ok) {
      console.error('WeChat article fetch failed: HTTP ' + response.status);
      return null;
    }
    return parseWeChatArticleHtml(await response.text(), requestUrl);
  } catch (e) {
    console.error('WeChat article fetch failed:', e.message);
    return null;
  }
}

async function fetchWithReadability(url) {
  const { Readability } = require('@mozilla/readability');
  const { JSDOM } = require('jsdom');
  const TurndownService = require('turndown');
  try {
    const fr = await fetchWithProxy(url, {
      maxBytes: MAX_IMPORT_BYTES,
      allowedTypes: ['text/html', 'application/xhtml+xml', 'text/plain'],
      timeoutMs: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KnowledgeBot/1.0)' },
      enforcePublicTarget: true,
    });
    if (!fr.ok) throw new Error('HTTP ' + fr.status);
    const html = await fr.text();
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document).parse();
    if (!reader || !reader.content) return null;
    const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
    const markdown = turndown.turndown(reader.content);
    return { title: reader.title || '', content: markdown };
  } catch (e) {
    return null;
  }
}

function decodeBufferWithChardet(buf) {
  const iconv = require('iconv-lite');
  const chardet = require('jschardet');
  // UTF-8 BOM
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    return { text: buf.slice(3).toString('utf8'), encoding: 'UTF-8' };
  }
  // 如果字节流本身是合法 UTF-8，优先按 UTF-8 解码（避免 chardet 误判为西欧编码导致乱码）
  if (isLegalUtf8(buf)) {
    const text = iconv.decode(buf, 'UTF-8');
    if (!text.includes('�')) return { text, encoding: 'UTF-8' };
  }
  const det = chardet.detect(buf);
  let encoding = (det && det.encoding ? det.encoding : 'UTF-8').toUpperCase();
  if (encoding === 'ASCII' || (det && det.confidence < 0.5)) encoding = 'UTF-8';
  // 中文编码别名统一
  if (encoding === 'GB2312' || encoding === 'GBK' || encoding === 'GB18030') encoding = 'GB18030';
  try {
    return { text: iconv.decode(buf, encoding), encoding };
  } catch (e) {
    return { text: buf.toString('utf8'), encoding: 'UTF-8' };
  }
}

function isLegalUtf8(buf) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = router;
// 供自动化测试引用的内部工具（不改变 router 作为中间件的用法）
module.exports.isSafeUrl = isSafeUrl;
module.exports.LIMITS = LIMITS;
module.exports.deriveSummary = deriveSummary;
module.exports.validateImages = validateImages;
module.exports.resolveCommentNickname = resolveCommentNickname;
module.exports.isWeChatArticleUrl = isWeChatArticleUrl;
module.exports.buildWeChatArticleUrl = buildWeChatArticleUrl;
module.exports.parseWeChatArticleHtml = parseWeChatArticleHtml;
module.exports.fetchWeChatArticle = fetchWeChatArticle;
module.exports.resolveSafeTarget = resolveSafeTarget;
module.exports.createPinnedDispatcher = createPinnedDispatcher;

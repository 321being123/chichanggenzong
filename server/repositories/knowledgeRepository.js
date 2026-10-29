// 投资笔记（知识分享）数据仓储（批次3，从 routes/knowledge 与 routes/admin 迁入的 SQL）。
// 合同：method(params, tx)；只做文章/分类/评论/权限字段的标准读写。
// 可见性、归属校验与状态机语义留在路由；列表筛选的 where 片段由路由构造后传入，
// 仓储内不拼接外部字符串以外的标识符。
const { pool } = require('../db');

// ---------- 用户与权限 ----------
async function readUserAccess(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(
    'SELECT role, knowledge_enabled, permissions FROM users WHERE username=$1',
    [params.username],
  );
  return rows[0] || null;
}

async function readUserNickname(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query('SELECT nickname FROM users WHERE username=$1', [params.username]);
  return rows[0] || null;
}

// ---------- 分类 ----------
async function listCategories(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(
    `SELECT id, name, parent_id, sort_order,
            COALESCE(owner_username = $1, false) AS can_manage
       FROM article_categories
       ORDER BY sort_order, id`,
    [params.username || null],
  );
  return rows;
}

async function insertCategory(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(
    `INSERT INTO article_categories (name, parent_id, sort_order, owner_username)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [params.name, params.parentId, params.sortOrder, params.ownerUsername],
  );
  return rows[0];
}

async function renameCategory(params, tx) {
  const runner = tx || pool;
  await runner.query('UPDATE article_categories SET name=$1 WHERE id=$2', [params.name, params.id]);
}

async function deleteCategory(params, tx) {
  const runner = tx || pool;
  await runner.query('DELETE FROM article_categories WHERE id=$1', [params.id]);
}

async function readCategoryOwner(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query('SELECT owner_username FROM article_categories WHERE id=$1', [params.id]);
  return rows[0] || null;
}

// ---------- 文章 ----------
// where 由调用方按可见性规则拼好（只含 $n 占位），仓储不解读权限语义。
async function listArticles(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(
    `SELECT a.id, a.title, a.summary, a.category_id, c.name AS category_name,
            a.status, a.view_count, a.author_username,
            a.created_at, a.updated_at, a.published_at, a.sort_order
       FROM articles a
       LEFT JOIN article_categories c ON c.id = a.category_id
       ${params.where || ''}
       ORDER BY a.sort_order ASC, a.id ASC
       LIMIT 200`,
    params.values || [],
  );
  return rows;
}

// 首页最新文章（简报字段）
async function listLatestArticles(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(
    `SELECT a.id, a.title, a.summary, c.name AS category_name, a.view_count, a.published_at
       FROM articles a
       LEFT JOIN article_categories c ON c.id = a.category_id
       WHERE a.status='published'
       ORDER BY a.published_at DESC LIMIT $1`,
    [params.limit],
  );
  return rows;
}

async function readArticleById(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(
    `SELECT a.*, c.name AS category_name
       FROM articles a
       LEFT JOIN article_categories c ON c.id = a.category_id
       WHERE a.id=$1`,
    [params.id],
  );
  return rows[0] || null;
}

async function readArticleByShareToken(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(
    `SELECT a.*, c.name AS category_name
       FROM articles a
       LEFT JOIN article_categories c ON c.id = a.category_id
       WHERE a.share_token=$1`,
    [params.token],
  );
  return rows[0] || null;
}

async function readArticleAuthor(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query('SELECT author_username FROM articles WHERE id=$1', [params.id]);
  return rows[0] || null;
}

async function readArticleStatus(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query('SELECT status FROM articles WHERE id=$1', [params.id]);
  return rows[0] || null;
}

async function readArticleStatusAndPublished(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query('SELECT status, published_at FROM articles WHERE id=$1', [params.id]);
  return rows[0] || null;
}

async function readArticleShareToken(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query('SELECT share_token, published_at FROM articles WHERE id=$1', [params.id]);
  return rows[0] || null;
}

// 新建：发布时间由 publishNow 布尔决定（不再拼接 now()/NULL 字面量）
async function insertArticle(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(
    `INSERT INTO articles
      (title, content, html_content, summary, category_id, status, share_token, author_username, published_at, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
             CASE WHEN $9 THEN now() ELSE NULL END,
             COALESCE((SELECT MAX(sort_order) + 10 FROM articles), 10))
     RETURNING id`,
    [params.title, params.content, params.htmlContent, params.summary, params.categoryId,
      params.status, params.shareToken, params.authorUsername, params.status === 'published'],
  );
  return rows[0];
}

// 编辑：published_at 仅在“草稿首次发布”时置 now()，其余保持原值
async function updateArticle(params, tx) {
  const runner = tx || pool;
  await runner.query(
    `UPDATE articles SET
       title=COALESCE($1, title),
       content=COALESCE($2, content),
       summary=COALESCE($3, summary),
       category_id=CASE WHEN $4::boolean THEN $5 ELSE category_id END,
       status=$6,
       published_at=CASE WHEN $8::boolean THEN now() ELSE published_at END,
       updated_at=now()
     WHERE id=$7`,
    [params.title, params.content, params.summary, params.hasCategoryId, params.categoryId,
      params.status, params.id, params.setPublishedNow === true],
  );
}

async function deleteArticle(params, tx) {
  const runner = tx || pool;
  await runner.query('DELETE FROM articles WHERE id=$1', [params.id]);
}

async function publishArticle(params, tx) {
  const runner = tx || pool;
  await runner.query(
    "UPDATE articles SET status='published', published_at=COALESCE(published_at, now()), share_token=$1, updated_at=now() WHERE id=$2",
    [params.token, params.id],
  );
}

async function unpublishArticle(params, tx) {
  const runner = tx || pool;
  await runner.query(
    "UPDATE articles SET status='draft', published_at=NULL, updated_at=now() WHERE id=$1",
    [params.id],
  );
}

async function incrementArticleView(params, tx) {
  const runner = tx || pool;
  await runner.query('UPDATE articles SET view_count = view_count + 1 WHERE id=$1', [params.id]);
}

// ---------- 评论 ----------
async function listComments(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(
    `SELECT c.id, c.parent_id, c.root_id,
            COALESCE(NULLIF(BTRIM(u.nickname), ''), c.author_username, c.nickname) AS nickname,
            c.content, c.author_username, c.created_at
       FROM article_comments c
       LEFT JOIN users u ON u.username = c.author_username
       WHERE c.article_id=$1 ORDER BY c.created_at ASC`,
    [params.articleId],
  );
  return rows;
}

async function readCommentParent(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(
    'SELECT id, root_id FROM article_comments WHERE id=$1 AND article_id=$2',
    [params.id, params.articleId],
  );
  return rows[0] || null;
}

async function insertComment(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(
    `INSERT INTO article_comments (article_id, parent_id, root_id, nickname, content, ip_hash, author_username)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, parent_id, root_id, nickname, content, author_username, created_at`,
    [params.articleId, params.parentId, params.rootId, params.nickname, params.content,
      params.ipHash, params.authorUsername],
  );
  return rows[0];
}

async function readCommentAuthor(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query('SELECT author_username FROM article_comments WHERE id=$1', [params.id]);
  return rows[0] || null;
}

async function deleteComment(params, tx) {
  const runner = tx || pool;
  await runner.query('DELETE FROM article_comments WHERE id=$1', [params.id]);
}

// ---------- 后台列表（admin，带分页与计数） ----------
async function adminListArticles(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(
    `SELECT a.id, a.title, a.status, a.view_count, a.author_username, a.published_at, a.updated_at,
            c.name AS category_name
       FROM articles a
       LEFT JOIN article_categories c ON c.id = a.category_id
       ${params.where || ''}
       ORDER BY COALESCE(a.published_at, a.updated_at) DESC
       LIMIT $${(params.values || []).length + 1} OFFSET $${(params.values || []).length + 2}`,
    [...(params.values || []), params.limit, params.offset],
  );
  return rows;
}

async function countArticles(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(
    'SELECT COUNT(*)::int AS c FROM articles ' + (params.where || ''),
    params.values || [],
  );
  return rows[0] ? rows[0].c : 0;
}

async function adminListComments(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(
    `SELECT c.id, c.article_id,
            COALESCE(NULLIF(BTRIM(u.nickname), ''), c.author_username, c.nickname) AS nickname,
            c.content, c.parent_id, c.root_id, c.created_at,
            a.title AS article_title
       FROM article_comments c
       LEFT JOIN articles a ON a.id = c.article_id
       LEFT JOIN users u ON u.username = c.author_username
       ${params.where || ''}
       ORDER BY c.created_at DESC
       LIMIT $${(params.values || []).length + 1} OFFSET $${(params.values || []).length + 2}`,
    [...(params.values || []), params.limit, params.offset],
  );
  return rows;
}

async function countComments(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(
    'SELECT COUNT(*)::int AS c FROM article_comments ' + (params.where || ''),
    params.values || [],
  );
  return rows[0] ? rows[0].c : 0;
}

async function adminListUsers(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(
    `SELECT username, role, status, knowledge_enabled
       FROM users ${params.where || ''} ORDER BY created_at DESC, username`,
    params.values || [],
  );
  return rows;
}

// 分类归属锁定与树形调整：owner 校验在 WHERE 内，越权不可见
async function lockCategoryForUpdate(params, client = pool) {
  return client.query(
    'SELECT id, parent_id FROM article_categories WHERE id=$1 AND owner_username=$2 FOR UPDATE',
    [params.id, params.owner],
  );
}

async function findCategoryForOwner(params, client = pool) {
  return client.query(
    'SELECT id FROM article_categories WHERE id=$1 AND owner_username=$2',
    [params.id, params.owner],
  );
}

async function listCategoryTree(client = pool) {
  return client.query('SELECT id, parent_id FROM article_categories');
}

async function updateCategoryParent(params, client = pool) {
  return client.query(
    'UPDATE article_categories SET parent_id=$1 WHERE id=$2',
    [params.parentId, params.id],
  );
}

// 分类移动：先锁住本分类行，再取同级分类与批量改排序（顺序值按 10 递增）
async function lockCategoryForOwner({ id, username }, client = pool) {
  return client.query(
    'SELECT id, parent_id FROM article_categories WHERE id=$1 AND owner_username=$2 FOR UPDATE',
    [id, username],
  );
}

async function listSiblingCategoryIds({ parentId, excludeId, username }, client = pool) {
  return client.query(
    `SELECT id FROM article_categories
       WHERE parent_id IS NOT DISTINCT FROM $1 AND id<>$2 AND owner_username=$3
       ORDER BY sort_order, id`,
    [parentId, excludeId, username],
  );
}

async function listChildCategoryIds({ parentId, username }, client = pool) {
  return client.query(
    `SELECT id FROM article_categories
         WHERE parent_id IS NOT DISTINCT FROM $1 AND owner_username=$2
         ORDER BY sort_order, id`,
    [parentId, username],
  );
}

async function updateCategorySortOrder({ sortOrder, id }, client = pool) {
  return client.query('UPDATE article_categories SET sort_order=$1 WHERE id=$2', [sortOrder, id]);
}

// 文章排序：先整表加锁读出当前顺序，再按最终顺序回写
async function lockArticlesForReorder(client = pool) {
  return client.query(
    'SELECT id, category_id, author_username FROM articles ORDER BY sort_order, id FOR UPDATE',
  );
}

async function updateArticleSortOrder({ sortOrder, id }, client = pool) {
  return client.query('UPDATE articles SET sort_order=$1 WHERE id=$2', [sortOrder, id]);
}

module.exports = {
  lockCategoryForOwner,
  listSiblingCategoryIds,
  listChildCategoryIds,
  updateCategorySortOrder,
  lockArticlesForReorder,
  updateArticleSortOrder,
  adminListArticles,
  adminListComments,
  adminListUsers,
  countArticles,
  countComments,
  deleteArticle,
  deleteCategory,
  deleteComment,
  incrementArticleView,
  insertArticle,
  insertCategory,
  insertComment,
  listArticles,
  listCategories,
  listCategoryTree,
  listComments,
  listLatestArticles,
  publishArticle,
  readArticleAuthor,
  readArticleById,
  readArticleByShareToken,
  readArticleShareToken,
  readArticleStatus,
  readArticleStatusAndPublished,
  readCategoryOwner,
  readCommentAuthor,
  readCommentParent,
  readUserAccess,
  readUserNickname,
  renameCategory,
  unpublishArticle,
  updateArticle,
};

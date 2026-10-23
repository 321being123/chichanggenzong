// ========== 反馈模块数据访问层（2026-10-23） ==========
// 职责：只放 SQL 与字段映射，不放业务规则；事务由调用方（feedbackService / feedbackRelease）控制，
// 因此所有函数第一个参数都是 db（pool 或已 BEGIN 的 client）。
// BIGINT 编号与 revision 一律以十进制字符串输出：JSON 传输时不经过 JavaScript Number，避免超过安全整数后串号。
const SHARED_VISIBLE = "f.visibility = 'public' AND f.moderation = 'normal' AND f.withdrawn_at IS NULL";

// 作者身份：正常显示当前昵称，其次快照；账号已删除（外键置空）统一显示“已注销用户”。
const AUTHOR_NICKNAME = `CASE WHEN f.author_username IS NULL THEN '已注销用户'
  ELSE COALESCE(NULLIF(u.nickname, ''), NULLIF(f.author_nickname_snapshot, ''), '匿名用户') END`;

const FEEDBACK_COLUMNS = `
  f.id::text AS id,
  f.author_username AS "authorUsername",
  ${AUTHOR_NICKNAME} AS nickname,
  f.type, f.title, f.description, f.page_path AS "pagePath",
  f.submitted_version AS "submittedVersion",
  f.status, f.visibility, f.moderation, f.moderation_reason AS "moderationReason",
  f.withdrawn_at AS "withdrawnAt",
  f.duplicate_of::text AS "duplicateOf",
  f.implemented_version AS "implementedVersion",
  f.implemented_release_sha AS "implementedReleaseSha",
  f.revision::text AS revision,
  f.created_at AS "createdAt",
  f.updated_at AS "updatedAt"`;

async function insertFeedback(db, row) {
  const { rows } = await db.query(
    `INSERT INTO public.feedbacks
       (author_username, author_nickname_snapshot, type, title, description, page_path,
        submitted_version, status, visibility, client_request_id, request_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'new',$8,$9,$10)
     RETURNING id::text AS id, revision::text AS revision`,
    [row.authorUsername, row.authorNicknameSnapshot || '', row.type, row.title, row.description,
      row.pagePath || '', row.submittedVersion || '', row.visibility || 'public',
      row.clientRequestId || null, row.requestHash || null]
  );
  return rows[0];
}

async function findByIdempotencyKey(db, authorUsername, clientRequestId) {
  const { rows } = await db.query(
    `SELECT id::text AS id, revision::text AS revision, request_hash AS "requestHash"
       FROM public.feedbacks
      WHERE author_username = $1 AND client_request_id = $2`,
    [authorUsername, clientRequestId]
  );
  return rows[0] || null;
}

// 读取单条主记录（含作者当前昵称），不做权限判断
async function getFeedback(db, id) {
  const { rows } = await db.query(
    `SELECT ${FEEDBACK_COLUMNS}
       FROM public.feedbacks f
       LEFT JOIN public.users u ON u.username = f.author_username
      WHERE f.id = $1`,
    [id]
  );
  return rows[0] || null;
}

// 加行锁读取：用于状态变更 / 附件追加 / 发布回写，必须在事务内调用
// B-02（2026-10-23 二次复验）：必须带出 implemented_release_sha，
// 回滚恢复要靠它判断「是否仍是本批次关闭且未被后续修改」，缺这个字段会把正常项误判为已修改。
async function lockFeedback(db, id) {
  const { rows } = await db.query(
    `SELECT id::text AS id, author_username AS "authorUsername", status, visibility, moderation,
            withdrawn_at AS "withdrawnAt", duplicate_of::text AS "duplicateOf",
            implemented_version AS "implementedVersion", implemented_release_sha AS "implementedReleaseSha",
            revision::text AS revision,
            client_request_id AS "clientRequestId", request_hash AS "requestHash"
       FROM public.feedbacks WHERE id = $1 FOR UPDATE`,
    [id]
  );
  return rows[0] || null;
}

// 列表查询：filter 中的状态计数与列表使用同一数据范围（只差 status 条件）
function listFilterSql(filter, params) {
  const where = [];
  if (filter.visibilityScope === 'public') where.push(SHARED_VISIBLE);
  else if (filter.visibilityScope === 'mine') {
    params.push(filter.authorUsername);
    where.push('f.author_username = $' + params.length);
  }
  // 管理员范围不做可见性过滤：隐藏与撤回项也需要能查（菜单与接口另按内容管理能力校验）
  if (filter.type) { params.push(filter.type); where.push('f.type = $' + params.length); }
  if (filter.status) { params.push(filter.status); where.push('f.status = $' + params.length); }
  if (filter.from) { params.push(filter.from); where.push('f.created_at >= $' + params.length); }
  if (filter.to) { params.push(filter.to); where.push('f.created_at < $' + params.length); }
  if (filter.authorUsernameExact) { params.push(filter.authorUsernameExact); where.push('f.author_username = $' + params.length); }
  if (filter.q) {
    params.push('%' + filter.q + '%');
    const p = '$' + params.length;
    where.push('(f.title ILIKE ' + p + ' OR f.description ILIKE ' + p + ')');
  }
  return where.length ? 'WHERE ' + where.join(' AND ') : '';
}

async function listFeedbacks(db, filter, limit, offset) {
  // A-01（2026-10-23 验收）：列表与总数必须各用独立参数数组。
  // 复用同一数组再调用 listFilterSql 会重复追加参数，产生“无法确定参数 $1 的数据类型”。
  const listParams = [];
  const where = listFilterSql(filter, listParams);
  const sort = filter.sort === 'updated' ? 'f.updated_at DESC, f.id DESC' : 'f.created_at DESC, f.id DESC';
  listParams.push(limit, offset);
  const { rows } = await db.query(
    `SELECT ${FEEDBACK_COLUMNS},
            (SELECT count(*)::int FROM public.feedback_comments c
              WHERE c.feedback_id = f.id AND c.deleted_at IS NULL AND c.hidden_at IS NULL) AS "commentCount",
            (SELECT e.summary FROM public.feedback_events e
              WHERE e.feedback_id = f.id AND e.event_type = 'admin_update'
                AND e.actor_source IN ('admin','system') AND e.summary <> ''
              ORDER BY e.created_at DESC, e.id DESC LIMIT 1) AS "latestSummary",
            (SELECT max(e.created_at) FROM public.feedback_events e WHERE e.feedback_id = f.id) AS "lastEventAt"
       FROM public.feedbacks f
       LEFT JOIN public.users u ON u.username = f.author_username
       ${where}
      ORDER BY ${sort}
      LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
    listParams
  );
  const countParams = [];
  const countWhere = listFilterSql(filter, countParams);
  const total = await db.query(
    `SELECT count(*)::int AS total FROM public.feedbacks f ${countWhere}`, countParams
  );
  return { items: rows, total: total.rows[0].total };
}

// 状态数量：应用除 status 以外的全部筛选条件
async function countByStatus(db, filter) {
  const params = [];
  const base = Object.assign({}, filter, { status: null });
  const where = listFilterSql(base, params);
  const { rows } = await db.query(
    `SELECT f.status, count(*)::int AS count FROM public.feedbacks f ${where} GROUP BY f.status`, params
  );
  return rows;
}

async function listMine(db, filter, limit, offset) {
  return listFeedbacks(db, Object.assign({}, filter, { visibilityScope: 'mine' }), limit, offset);
}

// 公开排名：按公开有效反馈数降序；同数并列（RANK），内部用稳定用户标识保证翻页稳定
async function rankingPage(db, limit, offset) {
  const { rows } = await db.query(
    `WITH agg AS (
       SELECT f.author_username AS username, count(*)::int AS count
         FROM public.feedbacks f
        WHERE ${SHARED_VISIBLE} AND f.author_username IS NOT NULL
        GROUP BY f.author_username
     ), ranked AS (
       SELECT a.username, a.count,
              RANK() OVER (ORDER BY a.count DESC) AS rank,
              COALESCE(NULLIF(u.nickname, ''), a.username) AS nickname,
              u.avatar
         FROM agg a
         LEFT JOIN public.users u ON u.username = a.username
     )
     SELECT rank::int AS rank, username, nickname, COALESCE(avatar, '') AS avatar, count
       FROM ranked
      ORDER BY count DESC, username ASC
      LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  const total = await db.query(
    `SELECT count(*)::int AS total FROM (
       SELECT f.author_username FROM public.feedbacks f
        WHERE ${SHARED_VISIBLE} AND f.author_username IS NOT NULL
        GROUP BY f.author_username) t`
  );
  return { items: rows, total: total.rows[0].total };
}

// “我的排名”使用同一公开口径；无公开记录时返回 null
async function rankingForUser(db, username) {
  const { rows } = await db.query(
    `WITH agg AS (
       SELECT f.author_username AS username, count(*)::int AS count
         FROM public.feedbacks f
        WHERE ${SHARED_VISIBLE} AND f.author_username IS NOT NULL
        GROUP BY f.author_username
     ), ranked AS (
       SELECT a.username, a.count, RANK() OVER (ORDER BY a.count DESC) AS rank FROM agg a
     )
     SELECT rank::int AS rank, count FROM ranked WHERE username = $1`,
    [username]
  );
  return rows[0] || null;
}

// 版本 → 当前公开已实施反馈（轻量映射，正文仍读 changelog.json）
async function versionLinks(db, versions) {
  if (!versions.length) return [];
  const { rows } = await db.query(
    `SELECT f.implemented_version AS version, f.id::text AS id, f.title
       FROM public.feedbacks f
      WHERE ${SHARED_VISIBLE} AND f.status = 'implemented'
        AND f.implemented_version = ANY($1::text[])
      ORDER BY f.id DESC`,
    [versions]
  );
  return rows;
}

async function bumpRevision(db, id) {
  const { rows } = await db.query(
    `UPDATE public.feedbacks SET revision = revision + 1, updated_at = now()
      WHERE id = $1 RETURNING revision::text AS revision`,
    [id]
  );
  return rows[0] ? rows[0].revision : null;
}

async function updateFeedbackFields(db, id, fields) {
  const sets = [];
  const params = [id];
  const map = {
    title: 'title', description: 'description', type: 'type', status: 'status',
    visibility: 'visibility', moderation: 'moderation', moderationReason: 'moderation_reason',
    duplicateOf: 'duplicate_of', implementedVersion: 'implemented_version',
    implementedReleaseSha: 'implemented_release_sha', pagePath: 'page_path', withdrawnAt: 'withdrawn_at',
  };
  Object.keys(fields).forEach(function (k) {
    if (!map[k]) return;
    params.push(fields[k]);
    sets.push(map[k] + ' = $' + params.length);
  });
  if (!sets.length) return;
  sets.push('revision = revision + 1', 'updated_at = now()');
  const { rows } = await db.query(
    `UPDATE public.feedbacks SET ${sets.join(', ')} WHERE id = $1 RETURNING revision::text AS revision`, params
  );
  return rows[0] ? rows[0].revision : null;
}

// ===== 回复 =====
async function listComments(db, feedbackId, viewer) {
  const params = [feedbackId];
  let where = 'c.feedback_id = $1';
  // 他人隐藏/删除的回复正文不再开放；作者本人与内容管理员可看
  if (!viewer.canModerate) {
    params.push(viewer.username || '');
    where += ` AND ((c.deleted_at IS NULL AND c.hidden_at IS NULL) OR c.author_username = $${params.length})`;
  }
  const { rows } = await db.query(
    `SELECT c.id::text AS id, c.author_username AS "authorUsername",
            CASE WHEN c.author_username IS NULL THEN '已注销用户'
                 ELSE COALESCE(NULLIF(u.nickname, ''), NULLIF(c.author_nickname_snapshot, ''), '匿名用户') END AS nickname,
            c.content, c.is_official AS "isOfficial",
            (c.deleted_at IS NOT NULL) AS deleted, (c.hidden_at IS NOT NULL) AS hidden,
            c.created_at AS "createdAt"
       FROM public.feedback_comments c
       LEFT JOIN public.users u ON u.username = c.author_username
      WHERE ${where}
      ORDER BY c.created_at ASC, c.id ASC`,
    params
  );
  return rows.map(function (r) {
    if (r.deleted || r.hidden) return Object.assign({}, r, { content: '' });
    return r;
  });
}

async function findCommentByRequest(db, authorUsername, clientRequestId) {
  const { rows } = await db.query(
    `SELECT id::text AS id, feedback_id::text AS "feedbackId", request_hash AS "requestHash"
       FROM public.feedback_comments
      WHERE author_username = $1 AND client_request_id = $2`,
    [authorUsername, clientRequestId]
  );
  return rows[0] || null;
}

async function insertComment(db, row) {
  const { rows } = await db.query(
    `INSERT INTO public.feedback_comments
       (feedback_id, author_username, author_nickname_snapshot, content, is_official, client_request_id, request_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id::text AS id`,
    [row.feedbackId, row.authorUsername, row.authorNicknameSnapshot || '', row.content,
      row.isOfficial === true, row.clientRequestId || null, row.requestHash || null]
  );
  return rows[0];
}

async function getComment(db, id) {
  const { rows } = await db.query(
    `SELECT id::text AS id, feedback_id::text AS "feedbackId", author_username AS "authorUsername",
            deleted_at AS "deletedAt", hidden_at AS "hiddenAt"
       FROM public.feedback_comments WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function markComment(db, id, action, reason) {
  const sql = action === 'delete'
    ? 'UPDATE public.feedback_comments SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL'
    : action === 'hide'
      ? 'UPDATE public.feedback_comments SET hidden_at = now(), hidden_reason = $2 WHERE id = $1 AND hidden_at IS NULL'
      : 'UPDATE public.feedback_comments SET hidden_at = NULL, hidden_reason = \'\' WHERE id = $1';
  const params = action === 'hide' ? [id, reason || ''] : [id];
  const { rowCount } = await db.query(sql, params);
  return rowCount > 0;
}

// ===== 事件（业务处理历史，与业务修改同事务） =====
async function insertEvent(db, row) {
  await db.query(
    `INSERT INTO public.feedback_events
       (feedback_id, actor_username, actor_source, event_type, status_from, status_to, summary, note, revision, release_run_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [row.feedbackId, row.actorUsername || null, row.actorSource || 'user', row.eventType,
      row.statusFrom || null, row.statusTo || null, row.summary || '', row.note || '',
      row.revision || 0, row.releaseRunId || null]
  );
}

// 用户时间线：只输出面向用户的处理说明，不输出内部发布证据
async function listEvents(db, feedbackId, includeInternal) {
  const { rows } = await db.query(
    `SELECT e.id::text AS id, e.event_type AS "eventType", e.status_from AS "statusFrom",
            e.status_to AS "statusTo", e.summary, ${includeInternal ? 'e.note' : "''"} AS note,
            e.actor_source AS "actorSource", e.created_at AS "createdAt"
       FROM public.feedback_events e
      WHERE e.feedback_id = $1
      ORDER BY e.created_at ASC, e.id ASC`,
    [feedbackId]
  );
  return rows;
}

// ===== 附件 =====
async function listAttachments(db, feedbackId, includeRemoved) {
  const { rows } = await db.query(
    `SELECT id::text AS id, feedback_id::text AS "feedbackId", uploader_username AS "uploaderUsername",
            storage_key AS "storageKey", mime_type AS "mimeType", size_bytes AS "sizeBytes",
            sha256, width, height, sort_order AS "sortOrder", removed_at AS "removedAt",
            created_at AS "createdAt"
       FROM public.feedback_attachments
      WHERE feedback_id = $1 ${includeRemoved ? '' : 'AND removed_at IS NULL'}
      ORDER BY sort_order ASC, id ASC`,
    [feedbackId]
  );
  return rows;
}

async function countActiveAttachments(db, feedbackId) {
  const { rows } = await db.query(
    'SELECT count(*)::int AS count FROM public.feedback_attachments WHERE feedback_id = $1 AND removed_at IS NULL',
    [feedbackId]
  );
  return rows[0].count;
}

async function insertAttachment(db, row) {
  const { rows } = await db.query(
    `INSERT INTO public.feedback_attachments
       (feedback_id, uploader_username, storage_key, mime_type, size_bytes, sha256, width, height,
        compression_version, client_request_id, request_hash, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id::text AS id`,
    [row.feedbackId, row.uploaderUsername || null, row.storageKey, row.mimeType, row.sizeBytes,
      row.sha256, row.width || 0, row.height || 0, row.compressionVersion || 'webp-v1',
      row.clientRequestId || null, row.requestHash || null, row.sortOrder || 0]
  );
  return rows[0];
}

async function getAttachment(db, id) {
  const { rows } = await db.query(
    `SELECT id::text AS id, feedback_id::text AS "feedbackId", storage_key AS "storageKey",
            mime_type AS "mimeType", size_bytes AS "sizeBytes", removed_at AS "removedAt"
       FROM public.feedback_attachments WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function removeAttachment(db, id) {
  const { rowCount } = await db.query(
    'UPDATE public.feedback_attachments SET removed_at = now() WHERE id = $1 AND removed_at IS NULL', [id]
  );
  return rowCount > 0;
}

async function findAttachmentByRequest(db, feedbackId, clientRequestId, sortOrder) {
  const { rows } = await db.query(
    `SELECT id::text AS id, request_hash AS "requestHash", sha256
       FROM public.feedback_attachments
      WHERE feedback_id = $1 AND client_request_id = $2 AND sort_order = $3`,
    [feedbackId, clientRequestId, sortOrder]
  );
  return rows[0] || null;
}

// 全部仍被历史引用的 storage_key（备份/清理排除用）
async function listReferencedStorageKeys(db) {
  const { rows } = await db.query('SELECT DISTINCT storage_key AS "storageKey" FROM public.feedback_attachments');
  return rows.map(function (r) { return r.storageKey; });
}

module.exports = {
  SHARED_VISIBLE,
  insertFeedback, findByIdempotencyKey, getFeedback, lockFeedback,
  listFeedbacks, countByStatus, listMine, rankingPage, rankingForUser, versionLinks,
  bumpRevision, updateFeedbackFields,
  listComments, findCommentByRequest, insertComment, getComment, markComment,
  insertEvent, listEvents,
  listAttachments, countActiveAttachments, insertAttachment, getAttachment, removeAttachment,
  findAttachmentByRequest, listReferencedStorageKeys,
};

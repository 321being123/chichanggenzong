// ========== 统一站内通知数据访问层（2026-10-25） ==========
// 契约：docs/意见反馈与版本发布闭环研发方案_20261023.md 第十四节。
// 职责：只放 SQL 与字段映射，不放业务规则；事务由调用方（notificationService / feedbackRelease）控制，
// 因此所有写函数第一个参数都是 db（pool 或已 BEGIN 的 client）。
// BIGINT 一律以十进制字符串输出：JSON 传输不经过 Number，避免大编号串号。
const NOTIFICATION_COLUMNS = `
  n.id::text AS "notificationId",
  n.type, n.title, n.body,
  n.target_kind AS "targetKind", n.target_id AS "targetId",
  n.feedback_id::text AS "feedbackId",
  n.release_run_id::text AS "releaseRunId",
  n.schema_version AS "schemaVersion",
  n.created_at AS "createdAt",
  (n.invalidated_at IS NOT NULL) AS invalidated,
  n.invalidation_reason AS "invalidationReason"`;

// 反馈通知在列表里附带公开可展示的反馈标题/状态/版本；私密正文、截图与发布 SHA 一律不出库。
const FEEDBACK_BRIEF = `
  f.title AS "feedbackTitle",
  f.status AS "feedbackStatus",
  f.implemented_version AS "feedbackVersion"`;

const INBOX_FROM = `
  FROM public.notification_recipients r
  JOIN public.notifications n ON n.id = r.notification_id
  LEFT JOIN public.feedbacks f ON f.id = n.feedback_id`;

// ---------- 通知内容 ----------
// 同 dedupe_key 重复插入返回原记录（同批次重复应用只产生一条通知）
async function insertNotification(db, row) {
  const { rows } = await db.query(
    `INSERT INTO public.notifications
       (type, title, body, target_kind, target_id, feedback_id, release_run_id, dedupe_key, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id::text AS id, created_at AS "createdAt"`,
    [row.type, row.title, row.body || '', row.targetKind || 'none', String(row.targetId || ''),
      row.feedbackId || null, row.releaseRunId || null, row.dedupeKey,
      JSON.stringify(row.payload || {})]
  );
  if (rows[0]) return { id: rows[0].id, inserted: true, createdAt: rows[0].createdAt };
  const existing = await db.query(
    'SELECT id::text AS id, created_at AS "createdAt" FROM public.notifications WHERE dedupe_key=$1',
    [row.dedupeKey]
  );
  return existing.rows[0]
    ? { id: existing.rows[0].id, inserted: false, createdAt: existing.rows[0].createdAt }
    : null;
}

async function getNotification(db, id) {
  const { rows } = await db.query(
    `SELECT ${NOTIFICATION_COLUMNS} FROM public.notifications n WHERE n.id=$1`, [id]
  );
  return rows[0] || null;
}

// 失效：保留历史与已读状态，只标记「处理状态已更新」，不删除记录
async function invalidateNotification(db, id, reason) {
  const { rowCount } = await db.query(
    `UPDATE public.notifications
        SET invalidated_at = COALESCE(invalidated_at, now()), invalidation_reason = $2
      WHERE id = $1 AND invalidated_at IS NULL`,
    [id, String(reason || '').slice(0, 200)]
  );
  return rowCount > 0;
}

// 按反馈 + 指定发布批次定位当前有效完成通知（用于失效/回滚）
async function findActiveFeedbackNotification(db, feedbackId, releaseRunId) {
  const { rows } = await db.query(
    `SELECT id::text AS id FROM public.notifications
      WHERE feedback_id=$1 AND release_run_id IS NOT DISTINCT FROM $2::bigint
        AND invalidated_at IS NULL
      ORDER BY id DESC LIMIT 1`,
    [feedbackId, releaseRunId || null]
  );
  return rows[0] || null;
}

// ---------- 收件人 ----------
// recipient_identity 保存账号不可复用身份（建号时间，见迁移 173）：
// 只靠用户名无法区分「删号后同名重注册」，投递前必须比对身份。
async function insertRecipient(db, row) {
  const { rows } = await db.query(
    `INSERT INTO public.notification_recipients
       (notification_id, recipient_slot_key, recipient_username, recipient_identity, status, delivered_at, skip_reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (notification_id, recipient_slot_key) DO NOTHING
     RETURNING id::text AS id, status`,
    [row.notificationId, row.recipientSlotKey, row.recipientUsername || null,
      row.recipientIdentity || '', row.status || 'pending',
      row.status === 'delivered' ? new Date() : null, row.skipReason || '']
  );
  return rows[0] || null;
}

// 回到新一轮扫描起点：只重置扫描位置，不改变收件状态（重试只处理 pending/failed）
async function resetRecipientScanRound(db, notificationId) {
  const { rowCount } = await db.query(
    `UPDATE public.notification_recipients
        SET last_scan_round = 0, updated_at = now()
      WHERE notification_id = $1 AND status IN ('pending','failed')`,
    [notificationId]
  );
  return rowCount;
}

// 投递：只允许 pending/failed → delivered
async function deliverRecipient(db, recipientId, scanRound) {
  const { rowCount } = await db.query(
    `UPDATE public.notification_recipients
        SET status='delivered', delivered_at=now(), read_at=NULL, skip_reason='', last_error='',
            last_scan_round=$2, updated_at=now()
      WHERE id=$1 AND status IN ('pending','failed')`,
    [recipientId, scanRound]
  );
  return rowCount > 0;
}

async function skipRecipient(db, recipientId, reason, scanRound) {
  const { rowCount } = await db.query(
    `UPDATE public.notification_recipients
        SET status='skipped', skip_reason=$2, last_error='', last_scan_round=$3, updated_at=now()
      WHERE id=$1 AND status IN ('pending','failed')`,
    [recipientId, String(reason || '').slice(0, 64), scanRound]
  );
  return rowCount > 0;
}

async function failRecipient(db, recipientId, error, scanRound) {
  const { rowCount } = await db.query(
    `UPDATE public.notification_recipients
        SET status='failed', last_error=$2, last_scan_round=$3, updated_at=now()
      WHERE id=$1 AND status IN ('pending','failed')`,
    [recipientId, String(error || '').slice(0, 300), scanRound]
  );
  return rowCount > 0;
}

// 一页待处理收件：pending 优先、failed 次之，稳定按 id 升序（游标只代表本轮位置）
async function scanRecipients(db, notificationId, afterId, limit, scanRound) {
  const { rows } = await db.query(
    `SELECT id::text AS id, recipient_slot_key AS "slotKey",
            recipient_username AS "recipientUsername",
            recipient_identity AS "recipientIdentity", status
       FROM public.notification_recipients
      WHERE notification_id=$1 AND status IN ('pending','failed')
        AND id > $2 AND last_scan_round < $4
      ORDER BY id ASC
      LIMIT $3`,
    [notificationId, afterId || '0', limit, scanRound]
  );
  return rows;
}

// 投递前读取账号当前身份：不存在（已删）返回 null，存在但重名重注册会得到不同 identity
async function getActiveAccount(db, username) {
  if (!username) return null;
  const { rows } = await db.query(
    `SELECT u.username, COALESCE(extract(epoch FROM u.created_at)::text, '') AS identity
       FROM public.users u
      WHERE u.username = $1 AND u.status = 'active'`,
    [username]
  );
  return rows[0] || null;
}

async function countRecipients(db, notificationId) {
  const { rows } = await db.query(
    `SELECT
       count(*) FILTER (WHERE status='pending')::int   AS pending,
       count(*) FILTER (WHERE status='delivered')::int AS delivered,
       count(*) FILTER (WHERE status='skipped')::int   AS skipped,
       count(*) FILTER (WHERE status='failed')::int    AS failed,
       count(*) FILTER (WHERE status='delivered' AND read_at IS NOT NULL)::int AS read,
       count(*)::int AS total
     FROM public.notification_recipients WHERE notification_id=$1`,
    [notificationId]
  );
  return rows[0];
}

// ---------- 本人收件箱 ----------
async function listInbox(db, username, filter, limit) {
  const params = [username];
  const where = [`r.recipient_username = $1`, `r.status = 'delivered'`];
  if (filter.category && filter.category !== 'all') { params.push(filter.category); where.push('n.type = $' + params.length); }
  if (filter.unreadOnly) where.push('r.read_at IS NULL');
  if (filter.afterId) { params.push(filter.afterId); where.push('r.id < $' + params.length); }
  params.push(limit);
  const { rows } = await db.query(
    `SELECT r.id::text AS "recipientId", ${NOTIFICATION_COLUMNS}, ${FEEDBACK_BRIEF},
            r.delivered_at AS "deliveredAt", r.read_at AS "readAt"
       ${INBOX_FROM}
      WHERE ${where.join(' AND ')}
      ORDER BY r.id DESC
      LIMIT $${params.length}`,
    params
  );
  const next = rows.length === limit ? rows[rows.length - 1].recipientId : null;
  return { items: rows, nextCursor: next, complete: next === null };
}

// 未读只统计本人 delivered、read_at 为空且未失效记录；铃铛为全部类型总数
async function unreadCounts(db, username) {
  const { rows } = await db.query(
    `SELECT n.type, count(*)::int AS count
       ${INBOX_FROM}
      WHERE r.recipient_username = $1 AND r.status='delivered'
        AND r.read_at IS NULL AND n.invalidated_at IS NULL
      GROUP BY n.type`,
    [username]
  );
  const byType = { feedback: 0, system: 0 };
  let total = 0;
  rows.forEach(function (r) {
    if (byType[r.type] === undefined) byType[r.type] = 0;
    byType[r.type] += r.count;
    total += r.count;
  });
  return { total: total, feedback: byType.feedback || 0, system: byType.system || 0, byType: byType };
}

// 本人单条：只读已投递；无权/未投递一律按「不存在」处理，不泄露他人存在性
async function getInboxItem(db, notificationId, username) {
  const { rows } = await db.query(
    `SELECT r.id::text AS "recipientId", ${NOTIFICATION_COLUMNS}, ${FEEDBACK_BRIEF},
            r.delivered_at AS "deliveredAt", r.read_at AS "readAt"
       ${INBOX_FROM}
      WHERE n.id = $1 AND r.recipient_username = $2 AND r.status = 'delivered'`,
    [notificationId, username]
  );
  return rows[0] || null;
}

// 单条已读：幂等并保留首次 read_at
async function markRead(db, notificationId, username) {
  const { rows } = await db.query(
    `UPDATE public.notification_recipients r
        SET read_at = COALESCE(r.read_at, now()), updated_at = now()
       FROM public.notifications n
      WHERE n.id = r.notification_id AND r.notification_id = $1
        AND r.recipient_username = $2 AND r.status = 'delivered'
      RETURNING r.read_at AS "readAt"`,
    [notificationId, username]
  );
  return rows[0] || null;
}

// 全部已读：单条条件 UPDATE 在数据库快照内处理当时可见的 delivered 记录，
// 请求之后新投递的收件保持未读；返回实际改变的条数。
async function markAllRead(db, username, category) {
  const params = [username];
  let typeFilter = '';
  if (category && category !== 'all') { params.push(category); typeFilter = ' AND n.type = $' + params.length; }
  const { rows } = await db.query(
    `WITH updated AS (
       UPDATE public.notification_recipients r
          SET read_at = now(), updated_at = now()
         FROM public.notifications n
        WHERE n.id = r.notification_id AND r.recipient_username = $1
          AND r.status = 'delivered' AND r.read_at IS NULL${typeFilter}
        RETURNING r.id
     )
     SELECT count(*)::int AS count FROM updated`,
    params
  );
  return rows[0].count;
}

// ---------- 批次 ----------
async function insertBatch(db, row) {
  const { rows } = await db.query(
    `INSERT INTO public.notification_batches
       (notification_id, creator_username, audience_mode, filter_snapshot,
        content_audience_hash, revision, status, snapshot_count, pending_count, remaining_count)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,'draft',$7,$7,$7)
     RETURNING id::text AS id, revision::text AS revision`,
    [row.notificationId, row.creatorUsername || null, row.audienceMode,
      JSON.stringify(row.filterSnapshot || {}), row.contentAudienceHash || '',
      row.revision || 1, row.snapshotCount || 0]
  );
  return rows[0];
}

async function lockBatch(db, id) {
  const { rows } = await db.query(
    `SELECT id::text AS id, notification_id::text AS "notificationId",
            creator_username AS "creatorUsername", audience_mode AS "audienceMode",
            filter_snapshot AS "filterSnapshot", content_audience_hash AS "contentAudienceHash",
            revision::text AS revision, status, dispatch_slot_id::text AS "dispatchSlotId",
            dispatch_generation AS "dispatchGeneration", scan_round AS "scanRound", cursor,
            snapshot_count AS "snapshotCount", delivered_count AS "deliveredCount",
            skipped_count AS "skippedCount", failed_count AS "failedCount",
            pending_count AS "pendingCount", remaining_count AS "remainingCount",
            next_attempt_at AS "nextAttemptAt", created_at AS "createdAt",
            confirmed_at AS "confirmedAt", completed_at AS "completedAt"
       FROM public.notification_batches WHERE id=$1 FOR UPDATE`,
    [id]
  );
  return rows[0] || null;
}

async function getBatch(db, id) {
  const { rows } = await db.query(
    `SELECT b.id::text AS id, b.notification_id::text AS "notificationId",
            b.creator_username AS "creatorUsername", b.audience_mode AS "audienceMode",
            b.filter_snapshot AS "filterSnapshot", b.content_audience_hash AS "contentAudienceHash",
            b.revision::text AS revision, b.status, b.dispatch_slot_id::text AS "dispatchSlotId",
            b.dispatch_generation AS "dispatchGeneration", b.scan_round AS "scanRound", b.cursor,
            b.snapshot_count AS "snapshotCount", b.delivered_count AS "deliveredCount",
            b.skipped_count AS "skippedCount", b.failed_count AS "failedCount",
            b.pending_count AS "pendingCount", b.remaining_count AS "remainingCount",
            b.next_attempt_at AS "nextAttemptAt", b.created_at AS "createdAt",
            b.confirmed_at AS "confirmedAt", b.completed_at AS "completedAt",
            n.type, n.title, n.body,
            n.invalidated_at AS "invalidatedAt"
       FROM public.notification_batches b
       JOIN public.notifications n ON n.id = b.notification_id
      WHERE b.id=$1`,
    [id]
  );
  return rows[0] || null;
}

async function listBatches(db, limit, offset) {
  const { rows } = await db.query(
    `SELECT b.id::text AS id, b.notification_id::text AS "notificationId",
            b.creator_username AS "creatorUsername", b.audience_mode AS "audienceMode",
            b.revision::text AS revision, b.status, b.dispatch_slot_id::text AS "dispatchSlotId",
            b.dispatch_generation AS "dispatchGeneration", b.scan_round AS "scanRound",
            b.snapshot_count AS "snapshotCount", b.delivered_count AS "deliveredCount",
            b.skipped_count AS "skippedCount", b.failed_count AS "failedCount",
            b.pending_count AS "pendingCount", b.remaining_count AS "remainingCount",
            b.created_at AS "createdAt", b.confirmed_at AS "confirmedAt", b.completed_at AS "completedAt",
            n.title, n.type, (n.invalidated_at IS NOT NULL) AS invalidated
       FROM public.notification_batches b
       JOIN public.notifications n ON n.id = b.notification_id
      ORDER BY b.id DESC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  const total = await db.query('SELECT count(*)::int AS total FROM public.notification_batches');
  return { items: rows, total: total.rows[0].total };
}

// 批次状态与计数：只更新明确列，避免调用方误覆盖冻结内容
async function updateBatch(db, id, fields) {
  const map = {
    status: 'status', dispatchSlotId: 'dispatch_slot_id', dispatchGeneration: 'dispatch_generation',
    scanRound: 'scan_round', cursor: 'cursor', snapshotCount: 'snapshot_count',
    deliveredCount: 'delivered_count', skippedCount: 'skipped_count', failedCount: 'failed_count',
    pendingCount: 'pending_count', remainingCount: 'remaining_count', nextAttemptAt: 'next_attempt_at',
    contentAudienceHash: 'content_audience_hash', confirmedAt: 'confirmed_at', completedAt: 'completed_at',
    revision: 'revision',
  };
  const sets = [];
  const params = [id];
  Object.keys(fields).forEach(function (k) {
    if (!map[k]) return;
    params.push(fields[k]);
    sets.push(map[k] + ' = $' + params.length);
  });
  if (!sets.length) return null;
  sets.push('updated_at = now()');
  const { rows } = await db.query(
    `UPDATE public.notification_batches SET ${sets.join(', ')} WHERE id=$1
      RETURNING id::text AS id, status, revision::text AS revision`, params
  );
  return rows[0] || null;
}

async function listBatchRecipients(db, batchId, limit, afterId) {
  const params = [batchId];
  let where = 'r.notification_id = (SELECT notification_id FROM public.notification_batches WHERE id=$1)';
  if (afterId) { params.push(afterId); where += ' AND r.id > $' + params.length; }
  params.push(limit);
  const { rows } = await db.query(
    `SELECT r.id::text AS id, r.status, r.recipient_username AS "recipientUsername",
            r.skip_reason AS "skipReason", r.last_error AS "lastError",
            r.delivered_at AS "deliveredAt", r.read_at AS "readAt"
       FROM public.notification_recipients r
      WHERE ${where}
      ORDER BY r.id ASC LIMIT $${params.length}`,
    params
  );
  const next = rows.length === limit ? rows[rows.length - 1].id : null;
  return { items: rows, nextCursor: next, complete: next === null };
}

// 带守卫的批次状态更新：只有当前执行令牌、租约与代次都仍有效时才写入。
// 返回 0 行表示「本执行已失去归属」，调用方必须立即停写并回滚，不能按成功继续。
async function updateBatchGuarded(db, guard, fields) {
  const map = {
    status: 'status', dispatchSlotId: 'dispatch_slot_id', dispatchGeneration: 'dispatch_generation',
    scanRound: 'scan_round', cursor: 'cursor', snapshotCount: 'snapshot_count',
    deliveredCount: 'delivered_count', skippedCount: 'skipped_count', failedCount: 'failed_count',
    pendingCount: 'pending_count', remainingCount: 'remaining_count', nextAttemptAt: 'next_attempt_at',
    contentAudienceHash: 'content_audience_hash', confirmedAt: 'confirmed_at', completedAt: 'completed_at',
    revision: 'revision',
  };
  const sets = [];
  const params = [guard.batchId, guard.generation, guard.slotId, guard.executionToken];
  Object.keys(fields).forEach(function (k) {
    if (!map[k]) return;
    params.push(fields[k]);
    sets.push(map[k] + ' = $' + params.length);
  });
  if (!sets.length) return null;
  sets.push('updated_at = now()');
  const { rows } = await db.query(
    `UPDATE public.notification_batches b SET ${sets.join(', ')}
      WHERE b.id = $1 AND b.dispatch_generation = $2
        AND EXISTS (
          SELECT 1 FROM ops.job_schedule_slots s
           WHERE s.slot_id = $3 AND s.status = 'running'
             AND s.execution_token = $4
             -- 必须用实际时钟：now() 在事务内固定为事务开始时间，
             -- 处理过程跨过租约到期时仍会放行，导致过期执行把批次写成成功。
             AND s.lease_until IS NOT NULL AND s.lease_until > clock_timestamp()
        )
      RETURNING b.id::text AS id, b.status, b.revision::text AS revision`,
    params
  );
  return rows[0] || null;
}

// ---------- 操作幂等 ----------
async function findOperation(db, batchId, actorUsername, operation, clientRequestId) {
  const { rows } = await db.query(
    `SELECT id::text AS id, request_hash AS "requestHash", result
       FROM public.notification_operations
      WHERE operation=$1 AND client_request_id=$2
        AND (batch_id = $3::bigint OR (batch_id IS NULL AND $3::bigint IS NULL AND actor_username = $4))
      ORDER BY id DESC LIMIT 1`,
    [operation, clientRequestId, batchId || null, actorUsername || null]
  );
  return rows[0] || null;
}

async function insertOperation(db, row) {
  const { rows } = await db.query(
    `INSERT INTO public.notification_operations
       (batch_id, actor_username, operation, client_request_id, request_hash, result)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)
     RETURNING id::text AS id`,
    [row.batchId || null, row.actorUsername || null, row.operation, row.clientRequestId,
      row.requestHash || '', JSON.stringify(row.result || {})]
  );
  return rows[0];
}

// ---------- 候选账号（后台预览/发送前的账号复核） ----------
// 账号身份表达式统一：建号时间既是不可复用身份，也不含用户名本身
const ACCOUNT_IDENTITY_SQL = "COALESCE(extract(epoch FROM u.created_at)::text, '')";

async function listActiveAccounts(db, usernames) {
  if (!usernames.length) return [];
  const { rows } = await db.query(
    `SELECT u.username, ${ACCOUNT_IDENTITY_SQL} AS identity
       FROM public.users u
      WHERE u.username = ANY($1::text[]) AND u.status='active'
      ORDER BY u.username ASC`,
    [usernames]
  );
  return rows;
}

async function listActiveUsernames(db, usernames) {
  const accounts = await listActiveAccounts(db, usernames);
  return accounts.map(function (a) { return a.username; });
}

// 账号搜索：只返回用户名/昵称/状态/角色，不返回邮箱、权限 JSON 或任何反馈正文
async function searchUsers(db, keyword, limit, offset) {
  const q = String(keyword || '').trim();
  const base = "u.status <> 'deleted'"
    + (q ? " AND (u.username ILIKE $1 OR COALESCE(u.nickname,'') ILIKE $1)" : '');
  const baseParams = q ? ['%' + q + '%'] : [];
  const listParams = baseParams.concat([limit, offset]);
  const { rows } = await db.query(
    `SELECT u.username, COALESCE(u.nickname,'') AS nickname, u.status, u.role
       FROM public.users u WHERE ${base}
      ORDER BY u.username ASC LIMIT $${baseParams.length + 1} OFFSET $${baseParams.length + 2}`,
    listParams
  );
  const total = await db.query(
    `SELECT count(*)::int AS total FROM public.users u WHERE ${base}`, baseParams
  );
  return { items: rows, total: total.rows[0].total };
}

// 完整受众集合：条件一律 AND，空日期不限制，从未登录单独匹配，上海时区半开区间。
// 分页只属于展示，名单计算必须一次覆盖完整集合（不截断）。
// 返回值携带账号身份，供收件记录绑定，避免删号后同名重注册被误投。
async function listAudience(db, filter) {
  const f = filter || {};
  const params = [];
  const where = ["u.status = 'active'"];
  if (f.role) { params.push(String(f.role)); where.push('u.role = $' + params.length); }
  if (f.registeredFrom) { params.push(f.registeredFrom); where.push('u.created_at >= $' + params.length); }
  if (f.registeredTo) { params.push(f.registeredTo); where.push('u.created_at < $' + params.length); }
  if (f.lastLoginFrom) { params.push(f.lastLoginFrom); where.push('u.last_login >= $' + params.length); }
  if (f.lastLoginTo) { params.push(f.lastLoginTo); where.push('u.last_login < $' + params.length); }
  if (f.everLoggedIn === true) where.push('u.last_login IS NOT NULL');
  if (f.everLoggedIn === false) where.push('u.last_login IS NULL');
  if (f.submittedFeedback === true) {
    where.push('EXISTS (SELECT 1 FROM public.feedbacks f0 WHERE f0.author_username = u.username)');
  }
  if (f.submittedFeedback === false) {
    where.push('NOT EXISTS (SELECT 1 FROM public.feedbacks f0 WHERE f0.author_username = u.username)');
  }
  const { rows } = await db.query(
    `SELECT u.username, ${ACCOUNT_IDENTITY_SQL} AS identity
       FROM public.users u WHERE ${where.join(' AND ')} ORDER BY u.username ASC`, params
  );
  return rows;
}

// 批量生成名单（一次插入完整快照，不逐条往返）
async function insertRecipientsBulk(db, notificationId, entries) {
  if (!entries.length) return 0;
  const slots = entries.map(function (e) { return e.slotKey; });
  const usernames = entries.map(function (e) { return e.username || null; });
  const identities = entries.map(function (e) { return e.identity || ''; });
  const { rowCount } = await db.query(
    `INSERT INTO public.notification_recipients
       (notification_id, recipient_slot_key, recipient_username, recipient_identity, status)
     SELECT $1, s.slot_key, s.username, s.identity, 'pending'
       FROM unnest($2::text[], $3::text[], $4::text[]) AS s(slot_key, username, identity)
     ON CONFLICT (notification_id, recipient_slot_key) DO NOTHING`,
    [notificationId, slots, usernames, identities]
  );
  return rowCount;
}

module.exports = {
  insertNotification, getNotification, invalidateNotification, findActiveFeedbackNotification,
  insertRecipient, resetRecipientScanRound, deliverRecipient, skipRecipient, failRecipient,
  scanRecipients, getActiveAccount, countRecipients,
  listInbox, unreadCounts, getInboxItem, markRead, markAllRead,
  insertBatch, lockBatch, getBatch, listBatches, updateBatch, updateBatchGuarded, listBatchRecipients,
  findOperation, insertOperation, listActiveUsernames,
  searchUsers, listAudience, insertRecipientsBulk, listActiveAccounts,
};

const { pool } = require('../db/connection');

// 自 server/services/feedbackRelease.js 迁入的数据读写函数（只做标准事实读写，业务判定仍留在服务层）。

const OPEN_STATUSES = ['new', 'needs_info', 'accepted', 'in_progress'];
const RELEASE_LOCK_ID = 904100;

async function listItems(runId, query) {
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 100, 1), 500);
  const afterId = query.afterId ? String(query.afterId) : null;
  const params = [runId];
  let where = 'run_id = $1';
  if (afterId) { params.push(afterId); where += ' AND feedback_id > $' + params.length; }
  params.push(limit);
  const { rows } = await pool.query(
    `SELECT feedback_id::text AS "feedbackId", expected_revision::text AS "expectedRevision",
            expected_status AS "expectedStatus", conclusion, implementation_commit AS "implementationCommit",
            evidence_summary AS "evidenceSummary", apply_status AS "applyStatus", apply_error AS "applyError",
            revision_before::text AS "revisionBefore", revision_after::text AS "revisionAfter"
       FROM ops.feedback_release_items
      WHERE ${where} ORDER BY feedback_id ASC LIMIT $${params.length}`,
    params
  );
  const next = rows.length === limit ? rows[rows.length - 1].feedbackId : null;
  return { items: rows, nextCursor: next, complete: next === null };
}

async function listRuns(query) {
  const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || 20, 1), 100);
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const { rows } = await pool.query(
    `SELECT id::text AS id, deployment_id::text AS "deploymentId", environment,
            release_sha AS "releaseSha", app_version AS "appVersion", prepare_status AS "prepareStatus",
            verify_status AS "verifyStatus", apply_status AS "applyStatus", snapshot_count AS "snapshotCount",
            snapshot_at AS "snapshotAt", owner, created_at AS "createdAt"
       FROM ops.feedback_release_runs ORDER BY id DESC LIMIT $1 OFFSET $2`,
    [pageSize, (page - 1) * pageSize]
  );
  const total = await pool.query('SELECT count(*)::int AS total FROM ops.feedback_release_runs');
  return { items: rows, total: total.rows[0].total, page: page, pageSize: pageSize };
}

async function readBack(runId) {
  const { rows } = await pool.query(
    `SELECT i.feedback_id::text AS "feedbackId", i.apply_status AS "applyStatus",
            f.status, f.implemented_version AS "implementedVersion",
            f.implemented_release_sha AS "implementedReleaseSha", f.revision::text AS revision,
            (SELECT count(*)::int FROM public.feedback_events e
              WHERE e.feedback_id = i.feedback_id AND e.release_run_id = i.run_id) AS "eventCount"
       FROM ops.feedback_release_items i
       JOIN public.feedbacks f ON f.id = i.feedback_id
      WHERE i.run_id=$1 AND i.apply_status IN ('applied','skipped','conflict','failed')
      ORDER BY i.feedback_id ASC`,
    [runId]
  );
  return rows;
}

async function readCandidates(options) {
  const opts = options || {};
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 100, 1), 500);
  const afterId = opts.afterId ? String(opts.afterId) : null;
  const params = [];
  let where = `f.withdrawn_at IS NULL AND f.status = ANY($1::text[])`;
  params.push(OPEN_STATUSES);
  if (afterId) { params.push(afterId); where += ` AND f.id > $${params.length}`; }
  params.push(limit);
  const { rows } = await pool.query(
    `SELECT f.id::text AS "feedbackId", f.revision::text AS revision, f.status, f.type,
            f.visibility, f.moderation, f.title, f.updated_at AS "updatedAt"
       FROM public.feedbacks f
      WHERE ${where}
      ORDER BY f.id ASC
      LIMIT $${params.length}`,
    params
  );
  const next = rows.length === limit ? rows[rows.length - 1].feedbackId : null;
  return { items: rows, nextCursor: next, complete: next === null };
}

async function releaseLock(client, handle) {
  if (handle && handle.external) return; // 外部持锁进程负责解锁，本会话不得替它解锁
  await client.query('SELECT pg_advisory_unlock($1)', [RELEASE_LOCK_ID]).catch(function () {});
}

module.exports = {
  listItems,
  listRuns,
  readBack,
  readCandidates,
  releaseLock,
};

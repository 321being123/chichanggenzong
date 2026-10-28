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

async function select_public_users(params, client = pool) {
  return client.query(`SELECT username, role, status, permissions FROM public.users WHERE username=$1`, params);
}

async function select_data(params, client = pool) {
  return client.query(`SELECT pg_advisory_lock($1)`, params);
}

async function select_ops_feedback_release_runs(params, client = pool) {
  return client.query(`SELECT id::text AS id, manifest_hash AS "manifestHash", prepare_status AS "prepareStatus" FROM ops.feedback_release_runs WHERE environment=$1 AND deployment_id=$2`, params);
}

async function insert_ops_feedback_release_runs(params, client = pool) {
  return client.query(`INSERT INTO ops.feedback_release_runs
         (deployment_id, environment, release_sha, app_version, base_deployed_sha,
          review_policy_version, snapshot_at, owner, prepare_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draft') RETURNING id::text AS id`, params);
}

async function select_public_feedbacks(params, client = pool) {
  return client.query(`SELECT f.id::text AS id, f.revision::text AS revision, f.status
         FROM public.feedbacks f
        WHERE f.withdrawn_at IS NULL AND f.status = ANY($1::text[])
        ORDER BY f.id ASC`, params);
}

async function insert_ops_feedback_release_items(params, client = pool) {
  return client.query(`INSERT INTO ops.feedback_release_items
           (run_id, feedback_id, expected_revision, expected_status, input_hash)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (run_id, feedback_id) DO NOTHING`, params);
}

async function select_ops_feedback_release_items(params, client = pool) {
  return client.query(`SELECT feedback_id::text AS "feedbackId", expected_revision::text AS "expectedRevision", conclusion, implementation_commit AS "implementationCommit", evidence_summary AS "evidenceSummary" FROM ops.feedback_release_items WHERE run_id=$1`, params);
}

async function update_ops_feedback_release_runs(params, client = pool) {
  return client.query(`UPDATE ops.feedback_release_runs
          SET manifest_hash=$1, snapshot_count=$2, snapshot_complete=true, prepare_status='prepared', updated_at=now()
        WHERE id=$3`, params);
}

async function select_ops_feedback_release_runs_1(params, client = pool) {
  return client.query(`SELECT id::text AS id, prepare_status AS "prepareStatus", verify_status AS "verifyStatus" FROM ops.feedback_release_runs WHERE id=$1 FOR UPDATE`, params);
}

async function update_ops_feedback_release_items(params, client = pool) {
  return client.query(`UPDATE ops.feedback_release_items
          SET conclusion=$1, implementation_commit=$2, evidence_summary=$3, updated_at=now()
        WHERE run_id=$4 AND feedback_id=$5
          AND apply_status='pending'
        RETURNING id::text AS id, feedback_id::text AS "feedbackId", expected_revision::text AS "expectedRevision",
                  conclusion, implementation_commit AS "implementationCommit", evidence_summary AS "evidenceSummary"`, params);
}

async function update_ops_feedback_release_runs_1(params, client = pool) {
  return client.query(`UPDATE ops.feedback_release_runs
          SET manifest_hash=$1,
              prepare_status = CASE WHEN prepare_status='frozen' THEN 'prepared' ELSE prepare_status END,
              verify_status = CASE WHEN verify_status='passed' THEN 'pending' ELSE verify_status END,
              updated_at=now()
        WHERE id=$2`, params);
}

async function update_ops_feedback_release_runs_2(params, client = pool) {
  return client.query(`UPDATE ops.feedback_release_runs
          SET manifest_hash=$1, prepare_status='frozen',
              verify_status = CASE WHEN verify_status='passed' THEN 'pending' ELSE verify_status END,
              updated_at=now()
        WHERE id=$2 RETURNING id::text AS id`, params);
}

async function select_ops_feedback_release_runs_2(params, client = pool) {
  return client.query(`SELECT id::text AS id, release_sha AS "releaseSha", app_version AS "appVersion", owner, manifest_hash AS "manifestHash", prepare_status AS "prepareStatus" FROM ops.feedback_release_runs WHERE id=$1 FOR UPDATE`, params);
}

async function update_ops_feedback_release_runs_3(params, client = pool) {
  return client.query(`UPDATE ops.feedback_release_runs
          SET verify_status=$1, verify_evidence=$2, manifest_hash=$3, updated_at=now()
        WHERE id=$4`, params);
}

async function select_ops_feedback_release_runs_3(params, client = pool) {
  return client.query(`SELECT id::text AS id, deployment_id::text AS "deploymentId", release_sha AS "releaseSha", app_version AS "appVersion",
              verify_status AS "verifyStatus", apply_status AS "applyStatus",
              manifest_hash AS "manifestHash", prepare_status AS "prepareStatus", owner
         FROM ops.feedback_release_runs WHERE id=$1 FOR UPDATE`, params);
}

async function select_ops_feedback_release_items_1(params, client = pool) {
  return client.query(`SELECT feedback_id::text AS "feedbackId", expected_revision::text AS "expectedRevision",
              expected_status AS "expectedStatus", conclusion, implementation_commit AS "implementationCommit",
              evidence_summary AS "evidenceSummary", apply_status AS "applyStatus"
         FROM ops.feedback_release_items
        WHERE run_id=$1 AND conclusion IN ('solved','partial')
        ORDER BY feedback_id ASC`, params);
}

async function update_ops_feedback_release_runs_4(params, client = pool) {
  return client.query(`UPDATE ops.feedback_release_runs SET apply_status=$1, updated_at=now() WHERE id=$2`, params);
}

async function select_ops_feedback_release_items_2(params, client = pool) {
  return client.query(`SELECT id, apply_status AS "applyStatus", revision_after::text AS "revisionAfter"
         FROM ops.feedback_release_items
        WHERE run_id=$1 AND feedback_id=$2 FOR UPDATE`, params);
}

async function update_ops_feedback_release_items_1(params, client = pool) {
  return client.query(`UPDATE ops.feedback_release_items
          SET apply_status='applied', apply_error='', revision_before=$1, revision_after=$2,
              applied_at=now(), updated_at=now()
        WHERE run_id=$3 AND feedback_id=$4`, params);
}

async function select_ops_feedback_release_runs_4(params, client = pool) {
  return client.query(`SELECT id::text AS id, deployment_id::text AS "deploymentId", release_sha AS "releaseSha",
              app_version AS "appVersion", verify_status AS "verifyStatus", apply_status AS "applyStatus"
         FROM ops.feedback_release_runs WHERE id=$1 FOR UPDATE`, params);
}

async function select_ops_feedback_release_items_3(params, client = pool) {
  return client.query(`SELECT feedback_id::text AS "feedbackId", expected_revision::text AS "expectedRevision",
              expected_status AS "expectedStatus", revision_after::text AS "revisionAfter", apply_status AS "applyStatus"
         FROM ops.feedback_release_items
        WHERE run_id=$1 AND conclusion='solved' AND apply_status='applied'
        ORDER BY feedback_id ASC`, params);
}

async function select_ops_feedback_release_items_4(params, client = pool) {
  return client.query(`SELECT id, apply_status AS "applyStatus" FROM ops.feedback_release_items WHERE run_id=$1 AND feedback_id=$2 FOR UPDATE`, params);
}

async function update_ops_feedback_release_items_2(params, client = pool) {
  return client.query(`UPDATE ops.feedback_release_items SET apply_status='rolled_back', updated_at=now()
        WHERE run_id=$1 AND feedback_id=$2`, params);
}

async function update_ops_feedback_release_items_3(params, client = pool) {
  return client.query(`UPDATE ops.feedback_release_items SET apply_status=$1, apply_error=$2, updated_at=now()
      WHERE run_id=$3 AND feedback_id=$4 AND apply_status IN ('pending','conflict','failed')`, params);
}

async function select_ops_feedback_release_runs_5(params, client = pool) {
  return client.query(`SELECT id::text AS id, deployment_id::text AS "deploymentId", environment,
            release_sha AS "releaseSha", app_version AS "appVersion", base_deployed_sha AS "baseDeployedSha",
            manifest_hash AS "manifestHash", review_policy_version AS "reviewPolicyVersion",
            snapshot_at AS "snapshotAt", snapshot_count AS "snapshotCount", snapshot_complete AS "snapshotComplete",
            owner, prepare_status AS "prepareStatus", verify_status AS "verifyStatus", apply_status AS "applyStatus",
            verify_evidence AS "verifyEvidence", created_at AS "createdAt", updated_at AS "updatedAt"
       FROM ops.feedback_release_runs WHERE id=$1`, params);
}

module.exports = {
  listItems,
  listRuns,
  readBack,
  readCandidates,
  releaseLock,
  select_public_users,
  select_data,
  select_ops_feedback_release_runs,
  insert_ops_feedback_release_runs,
  select_public_feedbacks,
  insert_ops_feedback_release_items,
  select_ops_feedback_release_items,
  update_ops_feedback_release_runs,
  select_ops_feedback_release_runs_1,
  update_ops_feedback_release_items,
  update_ops_feedback_release_runs_1,
  update_ops_feedback_release_runs_2,
  select_ops_feedback_release_runs_2,
  update_ops_feedback_release_runs_3,
  select_ops_feedback_release_runs_3,
  select_ops_feedback_release_items_1,
  update_ops_feedback_release_runs_4,
  select_ops_feedback_release_items_2,
  update_ops_feedback_release_items_1,
  select_ops_feedback_release_runs_4,
  select_ops_feedback_release_items_3,
  select_ops_feedback_release_items_4,
  update_ops_feedback_release_items_2,
  update_ops_feedback_release_items_3,
  select_ops_feedback_release_runs_5,
};

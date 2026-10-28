const { pool } = require('../db/connection');

// 自 server/services/feedbackService.js 抽取的 SQL 执行函数：语句原样搬迁，返回 pg 原始结果（rows/rowCount），调用方零改动。
async function select_public_users(params, client = pool) {
  return client.query(`SELECT nickname FROM public.users WHERE username = $1`, params);
}

async function select_ops_feedback_release_runs(params, client = pool) {
  return client.query(`SELECT id::text AS id, release_sha AS "releaseSha", app_version AS "appVersion",
            verify_status AS "verifyStatus", verify_evidence AS "verifyEvidence",
            environment, owner
       FROM ops.feedback_release_runs WHERE id=$1`, params);
}

async function select_ops_feedback_release_items(params, client = pool) {
  return client.query(`SELECT conclusion, apply_status AS "applyStatus", expected_revision::text AS "expectedRevision"
       FROM ops.feedback_release_items WHERE run_id=$1 AND feedback_id=$2`, params);
}

module.exports = {
  select_public_users,
  select_ops_feedback_release_runs,
  select_ops_feedback_release_items,
};

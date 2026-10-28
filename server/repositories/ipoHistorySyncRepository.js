const { pool } = require('../db/connection');

// 自 server/jobs/ipoHistorySync.js 抽取的 SQL 执行函数：语句原样搬迁，返回 pg 原始结果（rows/rowCount），调用方零改动。
async function select_ops_job_schedule_slots(params, client = pool) {
  return client.query(`SELECT scheduled_for FROM ops.job_schedule_slots WHERE slot_id=$1 LIMIT 1`, params);
}

async function select_job_runs(params, client = pool) {
  return client.query(`SELECT id,status,detail FROM job_runs WHERE job=$1
        AND (started_at AT TIME ZONE 'Asia/Shanghai')::date =
            (now() AT TIME ZONE 'Asia/Shanghai')::date
        ORDER BY id DESC LIMIT 20`, params);
}

async function update_job_runs(params, client = pool) {
  return client.query(`UPDATE job_runs SET status='running', started_at=now(), finished_at=NULL,
          locked_until=now() + interval '1 hour', detail=$2 WHERE id=$1`, params);
}

async function select_ops_sync_cursors(params, client = pool) {
  return client.query(`SELECT last_success_date::text AS d FROM ops.sync_cursors WHERE scope_key=$1 AND dataset_code=$2`, params);
}

module.exports = {
  select_ops_job_schedule_slots,
  select_job_runs,
  update_job_runs,
  select_ops_sync_cursors,
};

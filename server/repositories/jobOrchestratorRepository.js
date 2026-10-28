const { pool } = require('../db/connection');

// 自 server/services/jobOrchestrator.js 迁入的数据读写函数（只做标准事实读写，业务判定仍留在服务层）。

async function readRunStatus(runId) {
  if (!runId) return null;
  const { rows } = await pool.query('SELECT id, status, detail FROM job_runs WHERE id=$1', [runId]);
  return rows[0] || null;
}

async function update_ops_job_schedule_slots(params, client = pool) {
  return client.query(`UPDATE ops.job_schedule_slots
        SET status='blocked',last_run_id=COALESCE($2,last_run_id),
            result_summary=$3::jsonb,last_error=$4,next_attempt_at=NULL,
            lease_owner=NULL,lease_until=NULL,heartbeat_at=now(),updated_at=now()
      WHERE slot_id=$1 AND status='running' RETURNING *`, params);
}

async function update_job_runs(params, client = pool) {
  return client.query(`UPDATE job_runs SET slot_id=$2, attempt_no=$3, trigger_type=$4, worker_id=$5, heartbeat_at=now()
      WHERE id=$1`, params);
}

async function update_job_runs_1(params, client = pool) {
  return client.query(`UPDATE job_runs SET status=$2, finished_at=now(), detail=$3, result_json=$4::jsonb,
        external_call_count=$5, external_sources=$6::jsonb, datasets=$7::jsonb,
        error_code=$8, error_type=$9
      WHERE id=$1`, params);
}

async function select_job_runs(params, client = pool) {
  return client.query(`SELECT COUNT(*)::int AS count, MAX(current_slot.business_date)::text AS business_date,
              current_slot.slot_id::text AS slot_id
        FROM job_runs r
         JOIN ops.job_schedule_slots current_slot ON current_slot.slot_id=(SELECT slot_id FROM job_runs WHERE id=$1)
        WHERE r.id<>$1 AND r.job=$2 AND r.status='done' AND r.trigger_type='scheduled'
          AND (SELECT trigger_type FROM job_runs WHERE id=$1)='scheduled'
          AND r.slot_id=current_slot.slot_id
        GROUP BY current_slot.slot_id`, params);
}

async function update_job_runs_2(params, client = pool) {
  return client.query(`UPDATE job_runs
        SET slot_id=$1, attempt_no=$2, trigger_type=$3, worker_id=$4, heartbeat_at=now()
      WHERE id=(
        SELECT id FROM job_runs
         WHERE job=$5 AND started_at >= $6::timestamptz - interval '5 seconds'
         ORDER BY id DESC LIMIT 1
      )
      RETURNING id`, params);
}

async function update_job_runs_3(params, client = pool) {
  return client.query(`UPDATE job_runs SET status='failed', finished_at=now(), detail=$2,
        error_code=$3, error_type=$4, external_call_count=$5,
        external_sources=$6::jsonb, datasets=$7::jsonb
       WHERE id=$1 AND status='running'`, params);
}

async function update_job_runs_4(params, client = pool) {
  return client.query(`UPDATE job_runs SET heartbeat_at=now(), locked_until=now()+($2::integer * interval '1 minute')
         WHERE id=$1 AND status='running'`, params);
}

module.exports = {
  readRunStatus,
  update_ops_job_schedule_slots,
  update_job_runs,
  update_job_runs_1,
  select_job_runs,
  update_job_runs_2,
  update_job_runs_3,
  update_job_runs_4,
};

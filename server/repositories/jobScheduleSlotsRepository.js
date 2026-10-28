const { pool } = require('../db/connection');

// 自 server/services/jobScheduleSlots.js 迁入的数据读写函数（只做标准事实读写，业务判定仍留在服务层）。

const SWEEP_MIN_AGE_MINUTES = 60;
let sweepCursor = 0;

// 待核对的旧槽游标分页读取（只做事实读取，状态判定由服务层 reconcileSlot 负责）
async function listStaleSlots(cursor, minAgeMinutes, limit) {
  const { rows } = await pool.query(
    `SELECT *, business_date::text AS business_date, updated_at::text AS updated_at_exact
       FROM ops.job_schedule_slots
      WHERE status IN ('pending','failed','waiting_external','blocked','degraded')
        AND scheduled_for < now() - ($2::integer * interval '1 minute')
        AND slot_id > $1
      ORDER BY slot_id ASC LIMIT $3`,
    [cursor, minAgeMinutes, limit]
  );
  return rows;
}

async function taskDependencyStates(slot, dependencies) {
  if (!dependencies.length) return new Map();
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (job_code) job_code,status
       FROM ops.job_schedule_slots
      WHERE business_date=$1::date AND job_code=ANY($2::text[])
        AND scheduled_for <= $3::timestamptz
      ORDER BY job_code,scheduled_for DESC`,
    [slot.business_date, dependencies, slot.scheduled_for]
  );
  return new Map(rows.map(row => [row.job_code, row.status]));
}

// 读取槽位请求载荷（重新解析等人工重试用）
async function readSlotRequestPayload(slotId) {
  const { rows } = await pool.query(
    'SELECT request_payload FROM ops.job_schedule_slots WHERE slot_id=$1',
    [slotId]
  );
  return rows[0] ? rows[0].request_payload : null;
}

module.exports = {
  listStaleSlots,
  readSlotRequestPayload,
  taskDependencyStates,
};

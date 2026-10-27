// 管理后台补充数据仓储（批次3，从 routes/admin 迁入的 SQL）。
// 合同：method(params, tx)；只做券商主档与任务槽请求参数的读写。
// 知识/文章/评论/用户列表复用 knowledgeRepository，不在此重复。
const { pool } = require('../db');

async function readBroker(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(
    'SELECT code, name, market, sort_order, import_unit FROM brokers WHERE code=$1',
    [params.code],
  );
  return rows[0] || null;
}

// 管理员强制补跑：把 force 标记并入任务槽请求参数
async function markJobSlotForce(params, tx) {
  const runner = tx || pool;
  await runner.query(
    `UPDATE ops.job_schedule_slots SET request_payload=request_payload || '{"force":true}'::jsonb, updated_at=now() WHERE slot_id=$1`,
    [params.slotId],
  );
}

module.exports = { markJobSlotForce, readBroker };

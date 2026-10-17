const assert = require('assert');
require('dotenv').config();
const testDatabase = process.env.PGTESTDATABASE || 'portfolio_test';
if (process.env.DATABASE_URL) {
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = '/' + testDatabase;
  process.env.DATABASE_URL = url.toString();
} else process.env.PGDATABASE = testDatabase;
process.env.NODE_ENV = 'test';
process.env.ALERT_EMAIL_TO = '';
const { pool } = require('../db/connection');
const { listDueSlots } = require('../services/jobScheduleSlots');

(async () => {
  const client = await pool.connect();
  const originalQuery = pool.query;
  try {
    await client.query('BEGIN');
    // 隔离库事务暂时隔离既有槽位；所有改动回滚，不执行任务或外部请求。
    await client.query("UPDATE ops.job_schedule_slots SET status='blocked'");
    pool.query = client.query.bind(client);
    let minute = 0;
    async function insert(status, attempts, job = 'hk_rate') {
      const { rows } = await client.query(`INSERT INTO ops.job_schedule_slots
        (job_code,business_date,scheduled_for,status,attempt_count,next_attempt_at)
        VALUES ($1,'2001-01-01','2001-01-01 00:00:00+08'::timestamptz + $2 * interval '1 minute',$3,$4,now()-interval '1 hour')
        RETURNING slot_id`, [job, minute++, status, attempts]);
      return String(rows[0].slot_id);
    }
    for (let i = 0; i < 21; i++) await insert('failed', 3);
    await insert('pending', 3);
    await insert('waiting_external', 3);
    const expected = [await insert('pending', 0), await insert('failed', 2), await insert('waiting_external', 2),
      await insert('failed', 3, 'company_financial_incremental_sync')];
    const due = await listDueSlots(20);
    assert.deepStrictEqual(due.map(row => String(row.slot_id)), expected,
      '超过一页耗尽重试的旧槽不得饿死新任务，且逐任务保留不同maxAttempts');
    assert.deepStrictEqual((await listDueSlots(1)).map(row => String(row.slot_id)), expected.slice(0, 1),
      '重试资格必须在分页之前过滤，仍遵守批次大小和先后顺序');
    const future = await insert('pending', 0);
    await client.query("UPDATE ops.job_schedule_slots SET next_attempt_at=now()+interval '1 hour' WHERE slot_id=$1", [future]);
    assert(!(await listDueSlots(20)).some(row => String(row.slot_id) === future), '未到退避时间不得提前重试');
    console.log('due-slot fairness: exhausted retries, per-job policy, paging and backoff passed');
  } finally {
    pool.query = originalQuery;
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

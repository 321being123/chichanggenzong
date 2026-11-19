const assert = require('assert');
const { pool } = require('../db/connection');
const repo = require('../repositories/jobScheduleSlotsRepository');

// 槽位重试计数分账（迁移 206，方案 P0-1）：真实 PG 事务回归。
// 断言的是「领取 = 失败 + 等待 + 续批 + 成功 + 其他结算 + 未结算」这套账本身，
// 不是函数名或 SQL 文本，避免把实现细节当成契约。
(async () => {
  const c = await pool.connect();
  const original = pool.query;
  const created = [];
  try {
    await c.query('BEGIN');
    pool.query = c.query.bind(c);

    let insertSeq = 0;
    const insert = async (values = {}) => {
      insertSeq += 1;
      const { rows } = await c.query(
        `INSERT INTO ops.job_schedule_slots(job_code,scheduled_for,business_date,status,trigger_type,next_attempt_at,attempt_count,claim_count,fail_count)
         VALUES($1,now()+($6::integer * interval '1 minute'),current_date,$2,'scheduled',now(),$3,$4,$5) RETURNING slot_id`,
        [values.jobCode || 'market_close:可转债', values.status || 'pending',
          values.attemptCount || 0, values.claimCount || 0, values.failCount || 0, insertSeq]
      );
      created.push(rows[0].slot_id);
      return rows[0].slot_id;
    };
    const read = async id => (await c.query('SELECT * FROM ops.job_schedule_slots WHERE slot_id=$1', [id])).rows[0];
    const claim = (id, token) => repo.update_ops_job_schedule_slots_7([id, 'test-worker', 'scheduled', 3, 30, token]);

    // ① 领取只加领取序号，不加失败预算
    const id = await insert();
    const first = (await claim(id, 'tok-1')).rows[0];
    assert(first, '首次领取必须成功');
    assert.strictEqual(first.claim_count, 1, '领取必须累加 claim_count');
    assert.strictEqual(first.fail_count, 0, '领取本身不是失败，不得累加 fail_count');

    // ② 续批（部分完成继续跑）既不消耗失败预算，也不改写领取序号
    const continued = (await repo.update_ops_job_schedule_slots_15([
      id, new Date(Date.now() + 60000), JSON.stringify({ continuationRequired: true }), null, 'tok-1',
    ])).rows[0];
    assert.strictEqual(continued.status, 'pending');
    assert.strictEqual(continued.fail_count, 0, '续批不得消耗失败预算');
    assert.strictEqual(continued.claim_count, 1, '续批不得改写领取序号');
    assert.strictEqual(continued.attempt_count, 1, '新账本续批不得反向扣减兼容领取计数');

    // ③ 反复进入外部保护等待，仍能继续领取（旧实现靠减 attempt_count 抵消，才有碰运气成分）
    for (let round = 0; round < 4; round += 1) {
      const token = `tok-wait-${round}`;
      await c.query("UPDATE ops.job_schedule_slots SET status='pending', next_attempt_at=now() WHERE slot_id=$1", [id]);
      const claimed = (await claim(id, token)).rows[0];
      assert(claimed, `第 ${round + 2} 次领取不得被等待挡死`);
      const waiting = (await repo.update_ops_job_schedule_slots_13([
        id, new Date(Date.now() + 60000), JSON.stringify({ waitingExternal: true }), null, '上游未恢复', token,
      ])).rows[0];
      assert.strictEqual(waiting.status, 'waiting_external');
      assert.strictEqual(waiting.fail_count, 0, '等待上游恢复不是失败，不得计入失败预算');
    }
    assert.strictEqual((await read(id)).claim_count, 5, '每次成功领取都必须留痕');
    assert.strictEqual((await read(id)).attempt_count, 5, '新账本等待不得反向扣减兼容领取计数');

    // ④ 真实执行失败才加失败预算（退避分支）
    await c.query("UPDATE ops.job_schedule_slots SET status='pending', next_attempt_at=now() WHERE slot_id=$1", [id]);
    await claim(id, 'tok-fail-1');
    const deferred = (await repo.update_ops_job_schedule_slots_12([
      id, '15', JSON.stringify({ ok: false }), '上游返回 502', null, 'tok-fail-1',
    ])).rows[0];
    assert.strictEqual(deferred.status, 'failed');
    assert.strictEqual(deferred.fail_count, 1, '真实失败必须累加 fail_count');

    // ⑤ 收尾为 failed 同样计入失败预算；收尾为 succeeded 不计
    await c.query("UPDATE ops.job_schedule_slots SET status='pending', next_attempt_at=now() WHERE slot_id=$1", [id]);
    await claim(id, 'tok-fail-2');
    const failedClose = (await repo.update_ops_job_schedule_slots_11([
      id, 'failed', JSON.stringify({ ok: false }), '仍然失败', null, null, 'tok-fail-2',
    ])).rows[0];
    assert.strictEqual(failedClose.fail_count, 2, '收尾 failed 必须计入失败预算');

    // ⑥ 失败预算耗尽后不再领取；等待过多少次与此无关
    const exhausted = await insert({ status: 'failed', failCount: 3, attemptCount: 3 });
    const rejected = await claim(exhausted, 'tok-exhausted');
    assert.strictEqual(rejected.rows.length, 0, '失败预算耗尽后不得继续领取，不能被等待次数掩盖');
    assert.strictEqual((await read(exhausted)).claim_count, 0, '被拒绝的领取不得留领取痕迹');

    // ⑦ 人工重试重置失败预算但保留领取序列
    const manual = (await repo.update_ops_job_schedule_slots_17([exhausted])).rows[0];
    assert.strictEqual(manual.status, 'pending');
    assert.strictEqual(manual.fail_count, 0, '人工重试必须登记新的失败预算基线');
    assert.strictEqual(manual.claim_count, 0, '人工重试保留原领取序列，不得凭空增加领取数');
    const reclaimed = (await claim(exhausted, 'tok-manual')).rows[0];
    assert(reclaimed, '人工重试后必须可以重新领取');
    assert.strictEqual(reclaimed.claim_count, 1);

    // ⑧ 租约过期由接管方结算一次失败，重复结算不二次计数（否则一次崩溃会被算多次）
    const crashed = await insert();
    await claim(crashed, 'tok-crash');
    await c.query("UPDATE ops.job_schedule_slots SET lease_until=now()-interval '5 minutes' WHERE slot_id=$1", [crashed]);
    await repo.update_ops_job_schedule_slots_8([crashed, 'pending', 5]);
    await repo.update_ops_job_schedule_slots_8([crashed, 'pending', 5]);
    const recovered = await read(crashed);
    assert.strictEqual(recovered.fail_count, 1, '一次租约过期只能结算一次失败');
    assert.strictEqual(recovered.claim_count, 1, '接管不得改写领取序号');

    // ⑨ 守恒：领取增量 = 失败 + 等待 + 续批 + 成功 + 其他结算 + 未结算，各项互斥
    // 主槽共 7 次领取 = 4 次外部等待 + 2 次真实失败 + 1 次被续批结算的首次领取。
    const row = await read(id);
    assert.strictEqual(row.claim_count, 7, '主槽必须留下 7 次领取痕迹');
    assert.strictEqual(row.fail_count, 2, '主槽只有 2 次真实失败');
    assert.strictEqual(row.claim_count, row.fail_count + 4 + 1,
      '每一次领取都必须能由已结算类别（失败/等待/续批）完整解释，不允许凭空增减');

    console.log('槽位重试计数分账真实PG回归：领取/等待/续批/失败/耗尽/人工重试/租约接管与守恒通过');
  } finally {
    pool.query = original;
    await c.query('ROLLBACK');
    c.release();
    await pool.end();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

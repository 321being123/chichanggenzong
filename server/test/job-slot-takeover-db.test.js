// 旧槽接管与告警生命周期的真实 PG 回归：
// 只有同日同阶段同范围、且运行/阶段/分区证据完整才算接管；等待、人工重试、运行中租约、
// 退役任务和无证据槽一律不动；存量旧槽必须能跨页轮转核对，且扫描不覆盖并发领取。
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
const { reconcileSlot, sweepStaleSlots, ensureSlot } = require('../services/jobScheduleSlots');
const { sameSlotRecoveryScope, slotWaitingState } = require('../services/jobRecoveryEvidence');
const { verifyAlertScope } = require('../services/jobAlertMailer');
const { applyReconciliation } = require('../scripts/reconcileAlertHistory');

const BUSINESS_DATE = '2026-10-23';
const JOB = 'ipo_history_sync';

(async () => {
  const client = await pool.connect();
  const originalQuery = pool.query;
  const report = { cases: 0, skipped: 0 };
  // 用于在“接管 UPDATE”执行前插入交错的真实读写窗口。
  let beforeSkipUpdate = null;
  try {
    await client.query('BEGIN');
    // 隔离既有槽位：succeeded 不在核对范围，本轮只看本测试自己插入的槽。
    await client.query("UPDATE ops.job_schedule_slots SET status='succeeded'");
    pool.query = async (sql, params) => {
      if (beforeSkipUpdate && /SET status='skipped'/.test(sql)) {
        const hook = beforeSkipUpdate;
        beforeSkipUpdate = null;
        await hook();
      }
      return client.query(sql, params);
    };

    async function insertSlot({
      job = JOB, businessDate = BUSINESS_DATE, mode = 'enrichment', scheduledFor,
      status = 'pending', trigger = 'scheduled', payload = {}, summary = {}, dataAsOf = null,
      resultSummary = null,
    }) {
      const { rows } = await client.query(
        `INSERT INTO ops.job_schedule_slots
           (job_code,business_date,scheduled_for,status,trigger_type,request_payload,result_summary,data_as_of)
         VALUES($1,$2::date,$3::timestamptz,$4,$5,$6::jsonb,$7::jsonb,$8::timestamptz)
         RETURNING *,business_date::text AS business_date,updated_at::text AS updated_at_exact`,
        [job, businessDate, scheduledFor, status, trigger,
          JSON.stringify({ mode, ...payload }), JSON.stringify(summary), dataAsOf]
      );
      return rows[0];
    }

    async function insertRun(slotId, job, resultJson, status = 'done') {
      const { rows } = await client.query(
        `INSERT INTO job_runs(job,slot_id,status,result_json,attempt_no,trigger_type,started_at,finished_at)
         VALUES($1,$2,$3,$4::jsonb,1,'scheduled',now(),now()) RETURNING id`,
        [job, slotId, status, JSON.stringify(resultJson)]
      );
      return rows[0].id;
    }

    async function setPartition(partitionKey, { status = 'published', stale = false, quality = 'passed' } = {}) {
      await client.query(
        `INSERT INTO ops.dataset_partitions(dataset_code,scope_key,partition_key,status,is_stale,diagnostics,published_at)
         VALUES('ipo_history','GLOBAL',$1::date,$2,$3,$4::jsonb,now())
         ON CONFLICT(dataset_code,scope_key,partition_key) DO UPDATE
           SET status=EXCLUDED.status,is_stale=EXCLUDED.is_stale,diagnostics=EXCLUDED.diagnostics,updated_at=now()`,
        [partitionKey, status, stale, JSON.stringify({ quality_status: quality, query_status: 'success' })]
      );
    }

    async function reload(slotId) {
      const { rows } = await client.query(
        `SELECT status,trigger_type,last_error,result_summary,next_attempt_at,execution_token,
                updated_at::text AS updated_at_exact
           FROM ops.job_schedule_slots WHERE slot_id=$1`, [slotId]
      );
      return rows[0];
    }

    // 与 sweepStaleSlots 一致：真实扫描必须带数据库精确版本，不能靠 JS Date 的毫秒值核对。
    async function reloadSlot(slotId) {
      const { rows } = await client.query(
        'SELECT *,updated_at::text AS updated_at_exact FROM ops.job_schedule_slots WHERE slot_id=$1', [slotId]
      );
      return rows[0];
    }

    // 完整成功候选：同日同阶段、运行 done、阶段完整、ipo_history 分区发布且质量通过。
    async function insertCompleteSuccess({ scheduledFor, mode = 'enrichment', payload = {}, job = JOB, businessDate = BUSINESS_DATE }) {
      const candidate = await insertSlot({
        job, businessDate, mode, scheduledFor, status: 'succeeded', payload,
        summary: { ok: true, mode, stageComplete: true }, dataAsOf: `${businessDate} 20:00+08`,
      });
      await insertRun(candidate.slot_id, job, { ok: true, mode, stageComplete: true, pendingStages: [], failedDatasets: [] });
      return candidate;
    }

    await setPartition(BUSINESS_DATE);
    const staleScheduled = `${BUSINESS_DATE} 19:35:00+08`;

    // 1) 同日同阶段同范围完整成功可接管到期 pending。
    {
      const original = await insertSlot({ scheduledFor: staleScheduled });
      await insertCompleteSuccess({ scheduledFor: `${BUSINESS_DATE} 20:35:00+08` });
      const after = await reconcileSlot(original);
      assert.strictEqual(after.status, 'skipped', '同日同阶段同范围的完整成功必须能接管旧 pending');
      assert.strictEqual((await reload(original.slot_id)).status, 'skipped');
      report.cases += 1;
    }

    // 2) core 不能接管 enrichment：阶段不同不能互相抵消。
    {
      const original = await insertSlot({ scheduledFor: `${BUSINESS_DATE} 21:00:00+08` });
      await insertCompleteSuccess({ scheduledFor: `${BUSINESS_DATE} 21:30:00+08`, mode: 'core' });
      assert.strictEqual((await reconcileSlot(original)).status, 'pending', 'core 成功不能接管 enrichment 旧槽');
      assert.strictEqual((await reload(original.slot_id)).status, 'pending');
      report.cases += 1;
    }

    // 3) done 但 partial/continuationRequired 不得视为成功。
    {
      const original = await insertSlot({ scheduledFor: `${BUSINESS_DATE} 22:00:00+08` });
      const candidate = await insertSlot({
        scheduledFor: `${BUSINESS_DATE} 22:30:00+08`, status: 'succeeded',
        summary: { ok: false, mode: 'enrichment', stageComplete: false, continuationRequired: true },
        dataAsOf: `${BUSINESS_DATE} 22:30+08`,
      });
      await insertRun(candidate.slot_id, JOB, {
        ok: false, status: 'partial', mode: 'enrichment', stageComplete: false,
        continuationRequired: true, pendingStages: ['enrichment'], remaining: 1,
      });
      assert.strictEqual((await reconcileSlot(original)).status, 'pending', '续批未完成的 done 运行不能接管旧槽');
      assert.strictEqual((await reload(original.slot_id)).status, 'pending');
      report.cases += 1;
    }

    // 4) 分区缺失 / rejected / stale / 质量失败全部拒绝。
    {
      const variants = [
        { name: 'missing', apply: async () => client.query('DELETE FROM ops.dataset_partitions WHERE dataset_code=$1 AND partition_key=$2::date', ['ipo_history', '2026-10-20']) },
        { name: 'rejected', apply: async () => setPartition('2026-10-20', { status: 'rejected' }) },
        { name: 'stale', apply: async () => setPartition('2026-10-20', { stale: true }) },
        { name: 'quality_failed', apply: async () => setPartition('2026-10-20', { quality: 'failed' }) },
      ];
      for (const [index, variant] of variants.entries()) {
        await variant.apply();
        const original = await insertSlot({
          businessDate: '2026-10-20', scheduledFor: `2026-10-20 19:${35 + index}:00+08`,
        });
        await insertCompleteSuccess({
          businessDate: '2026-10-20', scheduledFor: `2026-10-20 20:${35 + index}:00+08`,
        });
        assert.strictEqual((await reconcileSlot(original)).status, 'pending', `分区 ${variant.name} 必须拒绝接管`);
        report.skipped += 1;
        report.cases += 1;
      }
    }

    // 5) 最新候选是别的目标时，仍能找到更早的有效范围候选。
    {
      const original = await insertSlot({
        businessDate: '2026-10-21', mode: 'enrichment', payload: { targetCodes: ['688827.SH'] },
        scheduledFor: '2026-10-21 19:35:00+08',
      });
      await setPartition('2026-10-21');
      await insertCompleteSuccess({
        businessDate: '2026-10-21', scheduledFor: '2026-10-21 20:00:00+08', payload: { targetCodes: ['688827.SH'] },
      });
      await insertCompleteSuccess({
        businessDate: '2026-10-21', scheduledFor: '2026-10-21 21:00:00+08', payload: { targetCodes: ['301234.SZ'] },
      });
      assert.strictEqual((await reconcileSlot(original)).status, 'skipped',
        '最新候选是其他证券时不能放弃更早的有效范围候选');
      report.cases += 1;
    }

    // 6) 等待外部来源且未到期：保留等待，不得跳过或误判漏跑。
    {
      const until = new Date(Date.now() + 4 * 86400000).toISOString();
      const waiting = await insertSlot({
        businessDate: '2026-10-22', status: 'waiting_external', trigger: 'auto_retry',
        scheduledFor: '2026-10-22 19:35:00+08',
        summary: { waitingExternal: true, recoverAt: until, pendingStages: ['enrichment'], remaining: 1 },
      });
      await client.query('UPDATE ops.job_schedule_slots SET next_attempt_at=$2::timestamptz WHERE slot_id=$1', [waiting.slot_id, until]);
      const reloaded = (await reloadSlot(waiting.slot_id));
      assert.strictEqual(slotWaitingState(reloaded).waiting, true);
      assert.strictEqual((await reconcileSlot(reloaded)).status, 'waiting_external', '等待中不得被扫描跳过');
      await setPartition('2026-10-22');
      await insertCompleteSuccess({ businessDate: '2026-10-22', scheduledFor: '2026-10-22 20:35:00+08' });
      assert.strictEqual((await reconcileSlot(reloaded)).status, 'skipped', '等待中的槽在出现完整成功证据后仍可被接管');
      report.cases += 1;
    }

    // 7) 人工刚重置的 pending 必须由 Worker 真正执行一次，不被扫描接管。
    {
      const manual = await insertSlot({
        businessDate: '2026-10-19', trigger: 'manual_retry', scheduledFor: '2026-10-19 19:35:00+08',
      });
      await setPartition('2026-10-19');
      await insertCompleteSuccess({ businessDate: '2026-10-19', scheduledFor: '2026-10-19 20:35:00+08' });
      assert.strictEqual((await reconcileSlot(manual)).status, 'pending', '人工补跑槽不得被扫描接管');
      report.cases += 1;
    }

    // 8) 没有恢复证据的旧槽保持原状态，且不会先写 skipped。
    {
      const failed = await insertSlot({
        businessDate: '2026-10-18', status: 'failed', scheduledFor: '2026-10-18 19:35:00+08',
      });
      assert.strictEqual((await reconcileSlot(failed)).status, 'failed', '无后续成功证据不得改成 skipped');
      assert.strictEqual((await reload(failed.slot_id)).status, 'failed');
      report.cases += 1;
    }

    // 9) 退役任务不参与接管（港股 IPO 已下线）。
    {
      const retired = await insertSlot({
        job: 'hk_ipo_postclose', businessDate: '2026-10-17', mode: 'postclose',
        scheduledFor: '2026-10-17 19:35:00+08', status: 'failed',
      });
      assert.strictEqual((await reconcileSlot(retired)).status, 'failed', '退役任务不自动改写状态');
      report.cases += 1;
    }

    // 10) 续批止损：无官方等待证据且超过上限的续批转 blocked；有等待原因且未到期的保留。
    {
      const startedAt = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
      const expired = await insertSlot({
        businessDate: '2026-10-16', scheduledFor: '2026-10-16 19:35:00+08',
        summary: { continuationRequired: true, continuationStartedAt: startedAt, pendingStages: ['enrichment'], remaining: 3 },
      });
      await client.query('UPDATE ops.job_schedule_slots SET next_attempt_at=now()+interval \'2 days\' WHERE slot_id=$1', [expired.slot_id]);
      const expiredRow = (await reloadSlot(expired.slot_id));
      assert.strictEqual((await reconcileSlot(expiredRow)).status, 'blocked', '无等待原因的续批超期必须止损');

      const until = new Date(Date.now() + 4 * 86400000).toISOString();
      const waiting = await insertSlot({
        businessDate: '2026-10-15', scheduledFor: '2026-10-15 19:35:00+08',
        summary: {
          continuationRequired: true, continuationStartedAt: startedAt, waitReason: 'field_recheck_cooldown',
          pendingStages: ['enrichment'], remaining: 1,
        },
      });
      await client.query('UPDATE ops.job_schedule_slots SET next_attempt_at=$2::timestamptz WHERE slot_id=$1', [waiting.slot_id, until]);
      const waitingRow = (await reloadSlot(waiting.slot_id));
      assert.strictEqual((await reconcileSlot(waitingRow)).status, 'pending', '官方等待证据未到期不得按续批止损处理');

      // F4：任意未登记原因不能豁免止损；已登记原因到期后也不能继续豁免。
      const unverified = await insertSlot({
        businessDate: '2026-10-06', scheduledFor: '2026-10-06 19:35:00+08',
        summary: {
          continuationRequired: true, continuationStartedAt: startedAt,
          waitReason: 'unverified_custom_reason', pendingStages: ['enrichment'], remaining: 2,
        },
      });
      await client.query('UPDATE ops.job_schedule_slots SET next_attempt_at=now()+interval \'2 days\' WHERE slot_id=$1', [unverified.slot_id]);
      const unverifiedRow = (await reloadSlot(unverified.slot_id));
      assert.strictEqual((await reconcileSlot(unverifiedRow)).status, 'blocked', '未登记的等待原因不得豁免续批止损');

      const dueExpired = await insertSlot({
        businessDate: '2026-10-05', scheduledFor: '2026-10-05 19:35:00+08',
        summary: {
          continuationRequired: true, continuationStartedAt: startedAt,
          waitReason: 'field_recheck_cooldown', pendingStages: ['enrichment'], remaining: 1,
        },
      });
      // 复查时间已过期：等待失效，必须回到续批止损。
      await client.query("UPDATE ops.job_schedule_slots SET next_attempt_at=now()-interval '1 hour' WHERE slot_id=$1", [dueExpired.slot_id]);
      const dueExpiredRow = (await reloadSlot(dueExpired.slot_id));
      assert.strictEqual((await reconcileSlot(dueExpiredRow)).status, 'blocked', '复查时间已到期不得继续豁免止损');
      report.cases += 1;
    }

    // 11) 扫描与领取并发：扫描结果过期后不得覆盖 Worker 已领取的槽。
    {
      const original = await insertSlot({
        businessDate: '2026-10-14', scheduledFor: '2026-10-14 19:35:00+08',
      });
      await setPartition('2026-10-14');
      await insertCompleteSuccess({ businessDate: '2026-10-14', scheduledFor: '2026-10-14 20:35:00+08' });
      await client.query(
        `UPDATE ops.job_schedule_slots
            SET status='running',lease_owner='worker:test',lease_until=now()+interval '10 minutes',
                execution_token='token-test',updated_at=now()
          WHERE slot_id=$1`, [original.slot_id]
      );
      await reconcileSlot(original);
      assert.strictEqual((await reload(original.slot_id)).status, 'running', '扫描不得覆盖已领取的执行');
      report.cases += 1;
    }

    // 12) 存量旧槽跨页轮转：一次只核对一页，多轮之后仍能遍历全部到期记录。
    {
      // 清掉前面场景留下的非终态槽，确保本轮分页只统计本条自己插入的记录。
      await client.query("UPDATE ops.job_schedule_slots SET status='succeeded'");
      const created = [];
      for (let index = 0; index < 3; index += 1) {
        const businessDate = `2026-10-0${index + 1}`;
        const original = await insertSlot({
          businessDate, scheduledFor: `${businessDate} 19:35:00+08`, status: 'failed',
        });
        await setPartition(businessDate);
        await insertCompleteSuccess({ businessDate, scheduledFor: `${businessDate} 20:35:00+08` });
        created.push(original.slot_id);
      }
      let first = await sweepStaleSlots(3);
      assert.strictEqual(first.scanned, 3, '每轮只核对一页');
      const changed = new Set((first.changes || []).map(item => item.slotId));
      assert.deepStrictEqual([...changed].sort((a, b) => a - b), created.map(Number).sort((a, b) => a - b),
        '本页内可接管的旧槽必须一次性核对完成');
      const second = await sweepStaleSlots(3);
      assert.strictEqual(second.changes.length, 0, '重复扫描不得重复修改');
      for (const slotId of created) assert.strictEqual((await reload(slotId)).status, 'skipped');
      report.cases += 1;
    }

    // 13) 范围比较本身必须覆盖账户、区间、证券和字段。
    {
      assert.strictEqual(sameSlotRecoveryScope(
        { job_code: 'nav_snapshot', business_date: '2026-10-13', request_payload: { mode: 'cash_income', username: 'a', accountName: 'A' } },
        { job_code: 'nav_snapshot', business_date: '2026-10-13', request_payload: { mode: 'cash_income', username: 'a', accountName: 'B' } }
      ), false, '不同账户不能互相接管');
      assert.strictEqual(sameSlotRecoveryScope(
        { job_code: 'nav_snapshot', business_date: '2026-10-13', request_payload: { mode: 'core', fromDate: '2026-10-01', throughDate: '2026-10-13' } },
        { job_code: 'nav_snapshot', business_date: '2026-10-13', request_payload: { mode: 'core', fromDate: '2026-10-02', throughDate: '2026-10-13' } }
      ), false, '不同区间不能互相接管');
      assert.strictEqual(sameSlotRecoveryScope(
        { job_code: JOB, business_date: '2026-10-13', request_payload: { mode: 'targeted', targetCodes: ['688827.SH'] } },
        { job_code: JOB, business_date: '2026-10-13', request_payload: { mode: 'targeted', targetCodes: ['688828.SH'] } }
      ), false, '不同证券不能互相接管');
      assert.strictEqual(sameSlotRecoveryScope(
        { job_code: JOB, business_date: '2026-10-13', request_payload: { mode: 'targeted', targetCodes: ['688827.SH'], targetFields: ['industry'] } },
        { job_code: JOB, business_date: '2026-10-13', request_payload: { mode: 'targeted', targetCodes: ['688827.SH'], targetFields: ['industry_pe'] } }
      ), false, '不同字段不能互相接管');
      assert.strictEqual(sameSlotRecoveryScope(
        { job_code: JOB, business_date: '2026-10-13', request_payload: { mode: 'enrichment' } },
        { job_code: JOB, business_date: '2026-10-13', request_payload: { mode: 'enrichment' } }
      ), true, '同任务同业务日同阶段且范围一致才允许接管');
      report.cases += 1;
    }

    // 14) F1：告警路径必须用真实查询结果收敛（自动 1 次和历史 3 次）。
    // 候选 SQL 若漏选 job_code，sameSlotRecoveryScope 会永远判不匹配。
    {
      const original = await insertSlot({
        businessDate: '2026-10-11', status: 'failed', scheduledFor: '2026-10-11 19:35:00+08',
      });
      await setPartition('2026-10-11');
      await insertCompleteSuccess({ businessDate: '2026-10-11', scheduledFor: '2026-10-11 20:00:00+08' });
      await insertCompleteSuccess({ businessDate: '2026-10-11', scheduledFor: '2026-10-11 20:30:00+08' });
      await insertCompleteSuccess({ businessDate: '2026-10-11', scheduledFor: '2026-10-11 21:00:00+08' });
      const alert = {
        alert_id: 901, alert_type: 'failure', scope_type: 'slot', scope_key: String(original.slot_id),
        job_code: JOB, slot_id: String(original.slot_id), last_seen_at: '2026-10-11T12:00:00.000Z',
      };
      const automatic = await verifyAlertScope(alert);
      assert.strictEqual(automatic.recovered, true, '接续成功必须能按真实查询结果自动收敛告警');
      assert.strictEqual(automatic.evidence.mode, 'later_comparable_slot_success');
      const historical = await verifyAlertScope(alert, undefined, { historical: true });
      assert.strictEqual(historical.recovered, true, '历史三次后续成功必须能按真实查询结果收敛');
      assert.strictEqual(historical.evidence.mode, 'three_later_job_successes');
      assert.strictEqual(historical.evidence.verifications.length, 3);
      report.cases += 1;
    }

    // 15) F2：接管写入与人工重置交错时不得覆盖新的执行意图。
    {
      const original = await insertSlot({
        businessDate: '2026-10-10', scheduledFor: '2026-10-10 19:35:00+08',
      });
      await setPartition('2026-10-10');
      await insertCompleteSuccess({ businessDate: '2026-10-10', scheduledFor: '2026-10-10 20:35:00+08' });
      // 在“接管 UPDATE”执行前插入人工重置：状态仍是 pending，但触发方式改成 manual_retry。
      beforeSkipUpdate = async () => {
        await client.query(
          `UPDATE ops.job_schedule_slots
              SET trigger_type='manual_retry', next_attempt_at=now(), updated_at=now()
            WHERE slot_id=$1`, [original.slot_id]
        );
      };
      await reconcileSlot(original);
      const after = await reload(original.slot_id);
      assert.strictEqual(after.status, 'pending', '读写之间的人工重置不得被扫描覆盖为 skipped');
      assert.strictEqual(after.trigger_type, 'manual_retry');
      beforeSkipUpdate = null;
      report.cases += 1;
    }

    // 16) F3：已接管归档的槽不能被旧失败运行记录反复改回失败。
    {
      const original = await insertSlot({
        businessDate: '2026-10-09', status: 'failed', scheduledFor: '2026-10-09 19:35:00+08',
      });
      await setPartition('2026-10-09');
      await insertCompleteSuccess({ businessDate: '2026-10-09', scheduledFor: '2026-10-09 20:35:00+08' });
      assert.strictEqual((await reconcileSlot(original)).status, 'skipped');
      // 原记录里那条失败运行仍然存在，多轮扫描不得把它反推回 failed。
      await insertRun(original.slot_id, JOB, { ok: false, mode: 'enrichment', error: 'old failure' }, 'failed');
      for (let round = 0; round < 3; round += 1) {
        const row = (await reloadSlot(original.slot_id));
        await reconcileSlot(row);
      }
      assert.strictEqual((await reload(original.slot_id)).status, 'skipped', '归档终态不得被旧失败记录改写');
      report.cases += 1;
    }

    // 17) F5：不匹配前缀超过一页（原实现 5×20=100 条上限）时仍能找到同范围成功。
    {
      const original = await insertSlot({
        businessDate: '2026-10-08', mode: 'enrichment',
        payload: { targetCodes: ['688827.SH'] }, scheduledFor: '2026-10-08 19:35:00+08',
      });
      await setPartition('2026-10-08');
      await client.query(
        `INSERT INTO ops.job_schedule_slots
           (job_code,business_date,scheduled_for,status,trigger_type,request_payload,result_summary,data_as_of)
         SELECT $1,$2::date,($3::timestamptz + (n || ' seconds')::interval),'succeeded','scheduled',
                jsonb_build_object('mode','enrichment','targetCodes',jsonb_build_array('OTHER'||n||'.SZ')),
                jsonb_build_object('ok',true,'mode','enrichment','stageComplete',true),
                $2::timestamptz
           FROM generate_series(1,106) AS n`, [JOB, '2026-10-08', '2026-10-08 20:00:00+08']
      );
      await insertCompleteSuccess({
        businessDate: '2026-10-08', scheduledFor: '2026-10-08 23:59:00+08', payload: { targetCodes: ['688827.SH'] },
      });
      const matched = await reconcileSlot(original);
      assert.strictEqual(matched.status, 'skipped', '106 条不匹配前缀之后仍必须找到同范围成功');
      report.cases += 1;
    }

    // 18) F6：历史对账必须用事务内重新取证的结果，预览后证据失效要拒绝关闭。
    {
      const original = await insertSlot({
        businessDate: '2026-10-07', status: 'failed', scheduledFor: '2026-10-07 19:35:00+08',
      });
      await setPartition('2026-10-07');
      // 历史对账要求连续三次后续完整成功，这里按同一范围准备三条候选。
      await insertCompleteSuccess({ businessDate: '2026-10-07', scheduledFor: '2026-10-07 20:00:00+08' });
      await insertCompleteSuccess({ businessDate: '2026-10-07', scheduledFor: '2026-10-07 20:35:00+08' });
      await insertCompleteSuccess({ businessDate: '2026-10-07', scheduledFor: '2026-10-07 21:10:00+08' });
      const alertKey = `slot:${original.slot_id}:failure:reconcile-test`;
      const { rows: alertRows } = await client.query(
        `INSERT INTO ops.alert_notifications
           (alert_key,alert_type,severity,status,scope_type,scope_key,job_code,slot_id,subject,summary)
         VALUES($1,'failure','critical','sent','slot',$2,$3,$4,'test','test') RETURNING alert_id`,
        [alertKey, String(original.slot_id), JOB, original.slot_id]
      );
      const alertId = Number(alertRows[0].alert_id);
      const preview = await verifyAlertScope(
        { alert_id: alertId, alert_type: 'failure', scope_type: 'slot', scope_key: String(original.slot_id), job_code: JOB },
        undefined, { historical: true }
      );
      assert.strictEqual(preview.recovered, true, '预览阶段证据应通过');
      // 预览与写入之间分区被撤下：事务内重验必须拒绝关闭。
      await client.query("UPDATE ops.dataset_partitions SET status='rejected' WHERE dataset_code='ipo_history' AND partition_key='2026-10-07'::date");
      const refusedApply = await applyReconciliation([alertId], { client });
      assert.deepStrictEqual(refusedApply.closed, [], '证据失效后不得关闭告警');
      assert.strictEqual(refusedApply.refused[0].reason, 'insufficient_later_successes');
      // 恢复分区后重新 apply 才能关闭，并留下可追溯审计。
      await setPartition('2026-10-07');
      const applied = await applyReconciliation([alertId], { client });
      assert.deepStrictEqual(applied.closed, [alertId]);
      const { rows: alertAfter } = await client.query(
        'SELECT status,resolved_at FROM ops.alert_notifications WHERE alert_id=$1', [alertId]
      );
      assert.strictEqual(alertAfter[0].status, 'resolved');
      assert(alertAfter[0].resolved_at);
      const { rows: audits } = await client.query(
        `SELECT metadata FROM admin_audit_log
          WHERE action='job_alert_history_reconciled' AND target=$1 ORDER BY id DESC LIMIT 1`, [String(alertId)]
      );
      assert.strictEqual(Number(audits[0].metadata.alertId), alertId);
      assert.strictEqual(Number(audits[0].metadata.originalSlotId), Number(original.slot_id));
      assert(audits[0].metadata.evidenceMode, '审计必须保存证据模式便于追溯');
      // R3：审计依据必须真正落库，不能只在内存对象里构造好再被通用脱敏过滤掉。
      const auditMeta = audits[0].metadata;
      assert(Array.isArray(auditMeta.runIds) && auditMeta.runIds.length >= 1, '审计必须保存后续运行 ID');
      assert(auditMeta.runIds.every(item => Number.isInteger(Number(item))), '运行 ID 必须是可追溯的整数');
      assert(Array.isArray(auditMeta.runs) && auditMeta.runs.length >= 1, '审计必须保存运行状态摘要');
      assert(Array.isArray(auditMeta.partitions) && auditMeta.partitions.length >= 1, '审计必须保存分区证据');
      assert(auditMeta.partitions.some(item => item.partitionKey === '2026-10-07'),
        '审计必须保存分区日期，不能只有数据集代码');
      assert(auditMeta.partitionDates.includes('2026-10-07'), '审计必须保存涉及的分区日期列表');
      assert.strictEqual(auditMeta.evidenceVersion, 1, '审计必须保存证据版本');
      assert.strictEqual(auditMeta.evidenceVerifier, 'slot_or_source', '审计必须保存证据验证器');
      assert.strictEqual(auditMeta.slotVersion, original.updated_at_exact, '审计必须保存原槽位的精确版本');
      assert.deepStrictEqual(auditMeta.scope, { type: 'slot', key: String(original.slot_id) }, '审计必须保存作用域');
      report.cases += 1;
    }

    // 19) R2：0.5 毫秒后的新一次续批是不同版本，不能被当作同一版本覆盖。
    {
      const original = await insertSlot({
        businessDate: '2026-09-28', scheduledFor: '2026-09-28 19:35:00+08',
      });
      await setPartition('2026-09-28');
      await insertCompleteSuccess({ businessDate: '2026-09-28', scheduledFor: '2026-09-28 20:35:00+08' });
      await client.query(
        "UPDATE ops.job_schedule_slots SET updated_at='2026-09-28 20:00:00.100000+08'::timestamptz WHERE slot_id=$1",
        [original.slot_id]
      );
      const snapshot = await reloadSlot(original.slot_id);
      const { rows: versionRows } = await client.query(
        'SELECT updated_at = $2::timestamptz AS same FROM ops.job_schedule_slots WHERE slot_id=$1',
        [original.slot_id, snapshot.updated_at_exact]
      );
      assert.strictEqual(versionRows[0].same, true, '数据库精确版本必须能原样往返');
      const { rows: driftRows } = await client.query(
        'SELECT $1::timestamptz = $2::timestamptz AS same',
        [snapshot.updated_at_exact, '2026-09-28 20:00:00.100500+08']
      );
      assert.strictEqual(driftRows[0].same, false, '0.5 毫秒后的新版本必须与快照版本不同');
      // 接管 UPDATE 之前：同状态同触发方式的新续批已经落库，只差 0.5 毫秒并换了执行令牌。
      beforeSkipUpdate = async () => {
        await client.query(
          `UPDATE ops.job_schedule_slots
              SET execution_token='continuation-batch-2', next_attempt_at=now() + interval '10 minutes',
                  updated_at='2026-09-28 20:00:00.100500+08'::timestamptz
            WHERE slot_id=$1`, [original.slot_id]
        );
      };
      await reconcileSlot(snapshot);
      const after = await reload(original.slot_id);
      assert.strictEqual(after.status, 'pending', '毫秒内变化的新版本不得被覆盖为 skipped');
      assert.strictEqual(after.execution_token, 'continuation-batch-2', '新续批的执行令牌必须保留');
      assert(after.next_attempt_at, '新续批的重试时间不得被清空');
      beforeSkipUpdate = null;
      // 反向确认：把版本和新续批痕迹一起还原成快照状态后，同一条接管才能真正生效。
      await client.query(
        `UPDATE ops.job_schedule_slots
            SET updated_at='2026-09-28 20:00:00.100000+08'::timestamptz,
                execution_token=NULL, next_attempt_at=NULL
          WHERE slot_id=$1`, [original.slot_id]
      );
      const reverted = await reloadSlot(original.slot_id);
      assert.strictEqual((await reconcileSlot(reverted)).status, 'skipped', '版本一致时必须正常接管');
      report.cases += 1;
    }

    // 20) R1：中间失败之后的连续成功必须能恢复告警；最新一次再次失败不得恢复。
    {
      const original = await insertSlot({
        businessDate: '2026-09-29', status: 'failed', scheduledFor: '2026-09-29 19:35:00+08',
      });
      await setPartition('2026-09-29');
      await insertSlot({
        businessDate: '2026-09-29', status: 'failed', scheduledFor: '2026-09-29 20:05:00+08',
      });
      await insertCompleteSuccess({ businessDate: '2026-09-29', scheduledFor: '2026-09-29 20:35:00+08' });
      await insertCompleteSuccess({ businessDate: '2026-09-29', scheduledFor: '2026-09-29 21:05:00+08' });
      await insertCompleteSuccess({ businessDate: '2026-09-29', scheduledFor: '2026-09-29 21:35:00+08' });
      // 同日更晚的计划还没执行：它没有结论，不能挡住已经完成的连续成功。
      await insertSlot({ businessDate: '2026-09-29', status: 'pending', scheduledFor: '2026-09-29 23:35:00+08' });
      const alert = {
        alert_id: 902, alert_type: 'failure', scope_type: 'slot', scope_key: String(original.slot_id),
        job_code: JOB, slot_id: String(original.slot_id), last_seen_at: '2026-09-29T12:00:00.000Z',
      };
      const automatic = await verifyAlertScope(alert);
      assert.strictEqual(automatic.recovered, true, '失败前缀之后的最近一次成功必须能自动收敛告警');
      assert.strictEqual(automatic.evidence.sequenceOrder, 'scheduled_for_desc');
      const historical = await verifyAlertScope(alert, undefined, { historical: true });
      assert.strictEqual(historical.recovered, true, '失败前缀之后的连续三次成功必须能历史收敛');
      assert.deepStrictEqual(
        historical.evidence.verifications.map(item => item.slot.scheduled_for.toISOString()),
        ['2026-09-29T13:35:00.000Z', '2026-09-29T13:05:00.000Z', '2026-09-29T12:35:00.000Z'],
        '历史序列必须是最新三条，而不是最早三条'
      );
      // 最新一次又失败：不能被更早的连续成功掩盖。
      await insertSlot({ businessDate: '2026-09-29', status: 'failed', scheduledFor: '2026-09-29 22:05:00+08' });
      assert.strictEqual((await verifyAlertScope(alert)).recovered, false, '最新再次失败时不得自动收敛');
      assert.strictEqual((await verifyAlertScope(alert, undefined, { historical: true })).recovered, false,
        '最新再次失败时不得历史收敛');
      report.cases += 1;
    }

    // 21) R2 延伸：调度建槽入口必须带回数据库精确版本，否则接管与续批止损在当天永远跳过。
    {
      const slot = await ensureSlot(
        JOB, '2026-09-27 19:35:00+08', '2026-09-27', 'scheduled', { mode: 'enrichment' }
      );
      assert(slot && slot.updated_at_exact, 'ensureSlot 必须返回数据库精确版本');
      const { rows: exactRows } = await client.query(
        'SELECT updated_at::text AS updated_at_exact FROM ops.job_schedule_slots WHERE slot_id=$1',
        [slot.slot_id]
      );
      assert.strictEqual(slot.updated_at_exact, exactRows[0].updated_at_exact,
        '建槽返回的版本必须与数据库原值一致');
      await setPartition('2026-09-27');
      await insertCompleteSuccess({ businessDate: '2026-09-27', scheduledFor: '2026-09-27 20:35:00+08' });
      assert.strictEqual((await reconcileSlot(slot)).status, 'skipped',
        '调度建槽入口的槽也必须能按精确版本接管');
      report.cases += 1;
    }

    console.log(`OK job-slot-takeover-db: ${report.cases} 组场景通过`
      + `（拒绝 ${report.skipped} 个分区变体，扫描未覆盖并发领取，跨页轮转无重复修改，`
      + `告警路径按真实查询收敛并按最近恢复序列取证、毫秒内版本不覆盖、审计依据完整落库）`);
  } finally {
    pool.query = originalQuery;
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

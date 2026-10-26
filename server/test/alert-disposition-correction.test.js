// 历史告警处置分类修订的真实 PG 回归：
// 只有“人工确认过、后来被改成 resolved”的告警才进入修订范围；能证明真实恢复的保留 resolved，
// 其余退回 acknowledged 且不留待处理状态；预览后状态或证据变化的记录一律拒绝写入。
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
const { preview, applyCorrection, decide } = require('../scripts/reconcileAlertDisposition');

const BUSINESS_DATE = '2026-10-23';
const JOB = 'ipo_history_sync';

(async () => {
  const client = await pool.connect();
  const originalQuery = pool.query;
  const report = { cases: 0 };
  try {
    await client.query('BEGIN');
    await client.query("UPDATE ops.job_schedule_slots SET status='succeeded'");
    await client.query("UPDATE ops.alert_notifications SET status='resolved' WHERE status <> 'resolved'");
    pool.query = (sql, params) => client.query(sql, params);

    async function insertSlot({ scheduledFor, status = 'succeeded', mode = 'enrichment', summary = {}, dataAsOf = null }) {
      const { rows } = await client.query(
        `INSERT INTO ops.job_schedule_slots
           (job_code,business_date,scheduled_for,status,trigger_type,request_payload,result_summary,data_as_of)
         VALUES($1,$2::date,$3::timestamptz,$4,'scheduled',$5::jsonb,$6::jsonb,$7::timestamptz)
         RETURNING *,business_date::text AS business_date,updated_at::text AS updated_at_exact`,
        [JOB, BUSINESS_DATE, scheduledFor, status, JSON.stringify({ mode }), JSON.stringify(summary), dataAsOf]
      );
      return rows[0];
    }

    async function insertRun(slotId, resultJson, status = 'done') {
      const { rows } = await client.query(
        `INSERT INTO job_runs(job,slot_id,status,result_json,attempt_no,trigger_type,started_at,finished_at)
         VALUES($1,$2,$3,$4::jsonb,1,'scheduled',now(),now()) RETURNING id`,
        [JOB, slotId, status, JSON.stringify(resultJson)]
      );
      return rows[0].id;
    }

    async function setPartition(partitionKey, { status = 'published', quality = 'passed' } = {}) {
      await client.query(
        `INSERT INTO ops.dataset_partitions(dataset_code,scope_key,partition_key,status,is_stale,diagnostics,published_at)
         VALUES('ipo_history','GLOBAL',$1::date,$2,false,$3::jsonb,now())
         ON CONFLICT(dataset_code,scope_key,partition_key) DO UPDATE
           SET status=EXCLUDED.status,is_stale=false,diagnostics=EXCLUDED.diagnostics,updated_at=now()`,
        [partitionKey, status, JSON.stringify({ quality_status: quality, query_status: 'success' })]
      );
    }

    // 被批量误改的告警：acknowledged_at 有值（人工确认过），status 被改成 resolved。
    async function insertMisclosedAlert({ alertKey, alertType = 'failure', slotId = null, acknowledged = true }) {
      const { rows } = await client.query(
        `INSERT INTO ops.alert_notifications
           (alert_key,alert_type,status,job_code,slot_id,subject,summary,first_seen_at,last_seen_at,
            acknowledged_at,resolved_at,created_at,updated_at)
         VALUES($1,$2,'resolved',$3,$4,'测试告警','',
                now() - interval '10 days', now() - interval '10 days',
                $5, now() - interval '1 day', now(), now())
         RETURNING alert_id`,
        [alertKey, alertType, JOB, slotId, acknowledged ? new Date() : null]
      );
      return rows[0].alert_id;
    }

    async function reloadAlert(alertId) {
      const { rows } = await client.query(
        'SELECT status, acknowledged_at, resolved_at FROM ops.alert_notifications WHERE alert_id=$1', [alertId]
      );
      return rows[0];
    }

    await setPartition(BUSINESS_DATE);

    // 1) 失败槽没有后续可比成功：不能算真实恢复，必须退回 acknowledged。
    {
      const original = await insertSlot({ scheduledFor: `${BUSINESS_DATE} 19:35:00+08`, status: 'failed', summary: { ok: false } });
      await insertRun(original.slot_id, { ok: false, mode: 'enrichment', stageComplete: false }, 'failed');
      const alertId = await insertMisclosedAlert({ alertKey: `t1:${original.slot_id}:failure`, slotId: original.slot_id });
      const { items } = await preview([await loadAlert(alertId)], (sql, params) => client.query(sql, params));
      assert.strictEqual(items[0].nextStatus, 'acknowledged', '缺少后续成功证据必须退回 acknowledged');
      assert.strictEqual(items[0].disposition, 'insufficient_evidence');
      const applied = await applyCorrection(items, { client });
      assert.strictEqual(applied.closed.length, 1);
      assert.strictEqual(applied.refused.length, 0);
      const after = await reloadAlert(alertId);
      assert.strictEqual(after.status, 'acknowledged', '修订后必须是 acknowledged');
      assert.ok(after.acknowledged_at, '原人工确认时间必须保留');
      assert.strictEqual(after.resolved_at, null, '退回后不能留着已恢复时间');
      const { rows: audits } = await client.query(
        "SELECT metadata FROM admin_audit_log WHERE action='alert_disposition_correct' AND target=$1", [String(alertId)]
      );
      assert.strictEqual(audits.length, 1, '每条修订必须留一条审计');
      assert.strictEqual(audits[0].metadata.previousStatus, 'resolved');
      assert.strictEqual(audits[0].metadata.newStatus, 'acknowledged');
      assert.strictEqual(audits[0].metadata.dataRecovered, false);
      report.cases += 1;
    }

    // 2) 同日同阶段同范围的后续连续三次完整成功：历史验证器通过，保持 resolved 不动。
    {
      const original = await insertSlot({ scheduledFor: `${BUSINESS_DATE} 20:00:00+08`, status: 'failed', summary: { ok: false } });
      await insertRun(original.slot_id, { ok: false, mode: 'enrichment', stageComplete: false }, 'failed');
      for (const at of ['20:30', '20:45', '21:00']) {
        const candidate = await insertSlot({
          scheduledFor: `${BUSINESS_DATE} ${at}:00+08`, summary: { ok: true, mode: 'enrichment', stageComplete: true },
          dataAsOf: `${BUSINESS_DATE} ${at}+08`,
        });
        await insertRun(candidate.slot_id, { ok: true, mode: 'enrichment', stageComplete: true, pendingStages: [], failedDatasets: [] });
      }
      const alertId = await insertMisclosedAlert({ alertKey: `t2:${original.slot_id}:failure`, slotId: original.slot_id });
      const { items } = await preview([await loadAlert(alertId)], (sql, params) => client.query(sql, params));
      assert.strictEqual(items[0].nextStatus, 'resolved', '真实恢复必须保持 resolved');
      assert.strictEqual(items[0].disposition, 'true_recovery');
      const applied = await applyCorrection(items.filter(item => item.nextStatus === 'acknowledged'), { client });
      assert.strictEqual(applied.closed.length, 0, '真实恢复不得被退回');
      assert.strictEqual((await reloadAlert(alertId)).status, 'resolved');
      report.cases += 1;
    }

    // 3) 没有人工确认时间的 resolved 记录不在修订范围：防止误伤真正自动恢复的历史告警。
    {
      const alertId = await insertMisclosedAlert({ alertKey: `t3:${Date.now()}:failure`, acknowledged: false });
      const { items } = await preview([await loadAlert(alertId)], (sql, params) => client.query(sql, params));
      const applied = await applyCorrection(items, { client });
      assert.strictEqual(applied.closed.length, 0, '无 acknowledged_at 的记录不得被修订');
      assert.strictEqual(applied.refused.length, 1);
      assert.strictEqual(applied.refused[0].reason, 'alert_not_resolved_or_not_acknowledged');
      assert.strictEqual((await reloadAlert(alertId)).status, 'resolved');
      report.cases += 1;
    }

    // 4) 预览之后被别的流程改掉状态：写入必须拒绝，不能盖掉别人的结论。
    {
      const original = await insertSlot({ scheduledFor: `${BUSINESS_DATE} 22:15:00+08`, status: 'failed', summary: { ok: false } });
      await insertRun(original.slot_id, { ok: false, mode: 'enrichment', stageComplete: false }, 'failed');
      const alertId = await insertMisclosedAlert({ alertKey: `t4:${original.slot_id}:failure`, slotId: original.slot_id });
      const { items } = await preview([await loadAlert(alertId)], (sql, params) => client.query(sql, params));
      await client.query("UPDATE ops.alert_notifications SET status='acknowledged' WHERE alert_id=$1", [alertId]);
      const applied = await applyCorrection(items, { client });
      assert.strictEqual(applied.closed.length, 0, '状态已变必须拒绝');
      assert.strictEqual(applied.refused[0].reason, 'alert_not_resolved_or_not_acknowledged');
      report.cases += 1;
    }

    // 5) 通知型记录（recovery）不是故障恢复对象，同样退回 acknowledged 并记分类。
    {
      const original = await insertSlot({ scheduledFor: `${BUSINESS_DATE} 23:00:00+08`, status: 'failed', summary: { ok: false } });
      const alertId = await insertMisclosedAlert({ alertKey: `t5:${original.slot_id}:recovery`, alertType: 'recovery', slotId: original.slot_id });
      const { items } = await preview([await loadAlert(alertId)], (sql, params) => client.query(sql, params));
      assert.strictEqual(items[0].disposition, 'not_a_fault');
      assert.strictEqual(items[0].nextStatus, 'acknowledged');
      const applied = await applyCorrection(items, { client });
      assert.strictEqual(applied.closed.length, 1);
      assert.strictEqual((await reloadAlert(alertId)).status, 'acknowledged');
      report.cases += 1;
    }

    // 6) decide 是纯函数：只有验证通过且分类为 true_recovery 才保留 resolved。
    {
      const base = { alert_type: 'failure', job_code: JOB, slot_id: 1 };
      assert.strictEqual(decide(base, { recovered: true }).nextStatus, 'resolved');
      assert.strictEqual(decide(base, { recovered: false, reason: 'x' }).nextStatus, 'acknowledged');
      assert.strictEqual(decide({ ...base, alert_type: 'recovery' }, { recovered: true }).nextStatus, 'acknowledged');
      report.cases += 1;
    }

    async function loadAlert(alertId) {
      const { rows } = await client.query('SELECT * FROM ops.alert_notifications WHERE alert_id=$1', [alertId]);
      return rows[0];
    }

    console.log(`告警处置分类修订：${report.cases} 组通过`);
    await client.query('ROLLBACK');
    console.log('全部回滚，生产与测试库均未留数据');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('失败:', error.message);
    process.exitCode = 1;
  } finally {
    pool.query = originalQuery;
    client.release();
    await pool.end();
  }
})();

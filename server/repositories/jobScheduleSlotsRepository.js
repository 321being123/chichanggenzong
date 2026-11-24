const { pool } = require('../db/connection');

// 自 server/services/jobScheduleSlots.js 迁入的数据读写函数（只做标准事实读写，业务判定仍留在服务层）。

const SWEEP_MIN_AGE_MINUTES = 60;
let sweepCursor = 0;

// 领取资格与失败上限的计数来源（迁移 206 的 retry_contract 显式边界）：
//   legacy  —— 迁移瞬间已存在的未结槽，继续用旧 attempt_count 判定，不切入新合同；
//   counters —— 新槽，用 fail_count（只记真实执行失败）。
// 旧 attempt_count 混有"领取 +1"和"等待豁免 -1"，无法拆成历史领取数与真实失败数，
// 所以边界必须显式标记，不能靠新列隐式回退或按旧值推导。
const retryCountSql = (alias = '') =>
  `(CASE WHEN ${alias}retry_contract='legacy' THEN ${alias}attempt_count ELSE ${alias}fail_count END)`;

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

async function insert_ops_job_schedule_slots(params, client = pool) {
  return client.query(`INSERT INTO ops.job_schedule_slots(job_code, scheduled_for, business_date, trigger_type, next_attempt_at,request_payload)
     VALUES ($1,$2,$3,$4,$2,$5::jsonb)
     ON CONFLICT(job_code, scheduled_for) DO UPDATE SET
       request_payload=CASE
         WHEN ops.job_schedule_slots.trigger_type IN ('manual_retry','auto_retry')
              AND ops.job_schedule_slots.status IN ('pending','running','failed','waiting_external')
           THEN ops.job_schedule_slots.request_payload
         ELSE EXCLUDED.request_payload
       END,
       updated_at=now()
     RETURNING *, updated_at::text AS updated_at_exact`, params);
}

// 定时任务改点只撤销未结束的同日自动旧槽；运行中及手动补跑保留。
async function skipReplacedScheduledSlot(jobCode, previousScheduledFor, replacementSlotId, client = pool) {
  return client.query(
    `UPDATE ops.job_schedule_slots
        SET status='skipped', next_attempt_at=NULL, last_error='定时任务已改点',
            result_summary=COALESCE(result_summary,'{}'::jsonb) || jsonb_build_object('replacementSlotId',$3::bigint),
            updated_at=now()
      WHERE job_code=$1 AND scheduled_for=$2 AND slot_id<>$3
        AND trigger_type IN ('scheduled','startup_catchup','auto_retry')
        AND status IN ('pending','failed','waiting_readiness','waiting_external')`,
    [jobCode, previousScheduledFor, replacementSlotId],
  );
}

async function select_ops_dataset_partitions(params, client = pool) {
  return client.query(`SELECT status,is_stale,diagnostics
         FROM ops.dataset_partitions
        WHERE dataset_code=$1 AND scope_key=$2 AND partition_key=$3::date
        ORDER BY updated_at DESC LIMIT 1`, params);
}

async function select_data(params, client = pool) {
  return client.query(`SELECT pg_advisory_xact_lock(hashtext('manual_job:' || $1 || ':' || $2))`, params);
}

async function select_ops_job_schedule_slots(params, client = pool) {
  return client.query(`
      SELECT * FROM ops.job_schedule_slots
       WHERE job_code=$1
         AND request_payload @> $3::jsonb
         -- 选股槽位的规范业务键必须两边完全相等：普通请求不得命中多带 shadow 的旧槽，
         -- 同日不同周期也不得互相吃槽；其他任务两边都为空，行为与原来一致（方案 27.8）。
         AND COALESCE(request_payload->>'selectionBusinessKey','') = COALESCE($3::jsonb->>'selectionBusinessKey','')
          AND (status='running' OR (status='pending' AND scheduled_for <= now()
            AND COALESCE(next_attempt_at,scheduled_for) <= now() AND ${retryCountSql()} < $2
            AND result_summary->>'readinessExpiredAt' IS NULL))
       ORDER BY slot_id DESC LIMIT 1
    `, params);
}

async function select_job_slot_by_request_id(params, client = pool) {
  return client.query(`
      SELECT slot_id, job_code, status, request_payload
        FROM ops.job_schedule_slots
       WHERE job_code = $1 AND request_payload->>'requestId' = $2
       ORDER BY slot_id DESC LIMIT 1`, params);
}

async function insert_ops_job_schedule_slots_1(params, client = pool) {
  return client.query(`
      INSERT INTO ops.job_schedule_slots(job_code,scheduled_for,business_date,trigger_type,next_attempt_at,request_payload)
      VALUES($1,$2,$3,'manual_retry',$2,$4::jsonb) RETURNING *
    `, params);
}

async function update_ops_job_schedule_slots(params, client = pool) {
  return client.query(`UPDATE ops.job_schedule_slots
        SET status='skipped', next_attempt_at=NULL, last_error=$2,
            lease_owner=NULL, lease_until=NULL, updated_at=now()
      WHERE slot_id=$1 AND status=$3
        AND updated_at=$4::timestamptz
        AND ($5::text IS NULL OR trigger_type=$5)
        AND status <> 'skipped'
      RETURNING *`, params);
}

async function update_ops_job_schedule_slots_1(params, client = pool) {
  return client.query(`UPDATE ops.job_schedule_slots
        SET status='blocked', next_attempt_at=NULL, last_error=$2, updated_at=now()
      WHERE slot_id=$1 AND status='pending'
        AND updated_at=$3::timestamptz
      RETURNING *`, params);
}

async function update_ops_job_schedule_slots_2(params, client = pool) {
  return client.query(`UPDATE ops.job_schedule_slots
            SET status='succeeded', data_as_of=$2, last_error=NULL, updated_at=now()
          WHERE slot_id=$1 AND status IN ('failed','waiting_external') RETURNING *`, params);
}

async function update_ops_job_schedule_slots_3(params, client = pool) {
  return client.query(`UPDATE ops.job_schedule_slots
            SET status='succeeded', data_as_of=$2, last_error=NULL, updated_at=now()
          WHERE slot_id=$1 AND status='degraded' RETURNING *`, params);
}

async function update_ops_job_schedule_slots_4(params, client = pool) {
  return client.query(`UPDATE ops.job_schedule_slots
              SET status='pending', next_attempt_at=now(), last_error=NULL, updated_at=now()
            WHERE slot_id=$1 AND status='blocked' RETURNING *`, params);
}

async function select_job_runs(params, client = pool) {
  return client.query(`SELECT id, status, finished_at, detail, result_json
       FROM job_runs
      WHERE slot_id=$1
      ORDER BY id DESC LIMIT 1`, params);
}

async function select_job_runs_1(params, client = pool) {
  return client.query(`SELECT id, status, finished_at, detail, result_json
         FROM job_runs
       WHERE job=$1 AND started_at >= $2::timestamptz
         AND started_at < $2::timestamptz + make_interval(mins => $3::integer)
        ORDER BY id DESC LIMIT 1`, params);
}

async function update_ops_job_schedule_slots_5(params, client = pool) {
  return client.query(`UPDATE ops.job_schedule_slots
        SET status=$2, last_run_id=$3,
            data_as_of=CASE WHEN $2='succeeded' THEN COALESCE($4, data_as_of) ELSE data_as_of END,
            last_error=$5, result_summary=COALESCE(result_summary,'{}'::jsonb) || $6::jsonb, updated_at=now()
      WHERE slot_id=$1 AND status NOT IN ('running','succeeded','skipped')
        AND updated_at=$7::timestamptz
      RETURNING *`, params);
}

// R4-01：领取与依赖解析需要 request_payload.mode —— 漏这一列会让按模式解析永远退回 core，
// 选股槽又被 A 股转债链挡住（表现为"列为 due 却领不到"）。
async function select_ops_job_schedule_slots_1(params, client = pool) {
  return client.query(`SELECT job_code,business_date::text AS business_date,scheduled_for,request_payload FROM ops.job_schedule_slots WHERE slot_id=$1`, params);
}

async function update_ops_job_schedule_slots_6(params, client = pool) {
  return client.query(`UPDATE ops.job_schedule_slots
            SET status='blocked', last_error=$2, next_attempt_at=NULL,
                lease_owner=NULL, lease_until=NULL, heartbeat_at=now(), updated_at=now()
          WHERE slot_id=$1 AND status IN ('pending','failed','degraded','waiting_external')`, params);
}

async function update_ops_job_schedule_slots_7(params, client = pool) {
  // 领取计数分账（迁移 206）：claim_count 记总领取、fail_count 只记真实失败。
  // 资格判定按 retry_contract 分流：legacy 存量槽仍用 attempt_count，新槽用 fail_count。
  // attempt_count 同步 +1 只为兼容回滚后的旧 Worker。
  return client.query(`UPDATE ops.job_schedule_slots
        SET status='running', attempt_count=attempt_count+1, claim_count=claim_count+1, lease_owner=$2,
            lease_until=now()+($5::integer * interval '1 minute'), heartbeat_at=now(),
            next_attempt_at=NULL, trigger_type=$3, execution_token=$6, updated_at=now()
      WHERE slot_id=$1 AND status IN ('pending','failed','waiting_external')
        AND ${retryCountSql()} < $4 + CASE WHEN job_code='nav_snapshot' AND result_summary ? 'dependencyRecovery' THEN 1 ELSE 0 END
        AND (next_attempt_at IS NULL OR next_attempt_at<=now())
        AND ($3::text='manual_retry' OR result_summary->>'readinessExpiredAt' IS NULL)
      RETURNING *, business_date::text AS business_date`, params);
}

async function update_job_runs(params, client = pool) {
  return client.query(`UPDATE job_runs
        SET status='failed', finished_at=COALESCE(finished_at, now()),
            detail=CASE WHEN COALESCE(detail,'')='' THEN '执行租约已过期，系统已自动回收' ELSE detail END
      WHERE status='running' AND locked_until IS NOT NULL AND locked_until < now()`);
}

async function select_ops_job_schedule_slots_2(params, client = pool) {
  return client.query(`SELECT slot_id, job_code, attempt_count, claim_count, fail_count, retry_contract
       FROM ops.job_schedule_slots
      WHERE status='running' AND lease_until IS NOT NULL AND lease_until < now()
      ORDER BY slot_id`);
}

async function update_ops_job_schedule_slots_8(params, client = pool) {
  // 租约过期由接管方结算：本次领取既没成功也没进入等待，按真实执行失败计一次，
  // 保留"最多 maxAttempts 次"的止损语义，不让崩溃的槽无限 pending 重试。
  // legacy 存量槽不加 fail_count：它的失败已经由领取时的 attempt_count+1 表达（原合同）。
  return client.query(`UPDATE ops.job_schedule_slots
          SET status=$2,
              fail_count=fail_count + CASE WHEN retry_contract='legacy' THEN 0 ELSE 1 END,
              next_attempt_at=CASE WHEN $2='pending' THEN now()+($3::integer * interval '1 minute') ELSE NULL END,
              lease_owner=NULL, lease_until=NULL, execution_token=NULL, heartbeat_at=now(),
              last_error='执行租约已过期，系统已自动接管', updated_at=now()
        WHERE slot_id=$1 AND status='running'`, params);
}

// 候选查询（R2-006）：按执行分类在 LIMIT 之前排序与过滤。
// policy 里带 tier（0=核心、1=普通、2=历史/补全），避免"前 20 条全是历史回填"把核心任务挡在候选之外；
// $3 为 null 时不过滤分类，保持旧调用可用。
async function select_ops_job_schedule_slots_3(params, client = pool) {
  return client.query(`SELECT s.*, s.business_date::text AS business_date FROM ops.job_schedule_slots s
      JOIN jsonb_to_recordset($2::jsonb) AS policy(job_code text,max_attempts integer,tier integer)
        ON policy.job_code=s.job_code
      WHERE (status='pending' AND (next_attempt_at IS NULL OR next_attempt_at <= now())
        OR (status IN ('failed','waiting_external') AND next_attempt_at IS NOT NULL AND next_attempt_at <= now()))
        AND scheduled_for <= now()
        AND s.result_summary->>'readinessExpiredAt' IS NULL
        AND ($3::int[] IS NULL OR policy.tier = ANY($3))
        AND ${retryCountSql('s.')} < policy.max_attempts + CASE WHEN s.job_code='nav_snapshot' AND s.result_summary ? 'dependencyRecovery' THEN 1 ELSE 0 END
      ORDER BY policy.tier ASC, scheduled_for ASC, slot_id ASC LIMIT $1`, params);
}

async function update_ops_job_schedule_slots_9(params, client = pool) {
  return client.query(`UPDATE ops.job_schedule_slots
              SET status='blocked', last_error=$2, next_attempt_at=NULL,
                  lease_owner=NULL, lease_until=NULL, heartbeat_at=now(), updated_at=now()
            WHERE slot_id=$1 AND status <> 'blocked'
            RETURNING *`, params);
}

async function update_ops_job_schedule_slots_10(params, client = pool) {
  return client.query(`UPDATE ops.job_schedule_slots
              SET status='pending', next_attempt_at=now(), last_error=NULL, updated_at=now()
            WHERE slot_id=$1 AND status='blocked'`, params);
}

async function select_ops_job_schedule_slots_4(params, client = pool) {
  return client.query(`SELECT job_code,business_date::text AS business_date,request_payload FROM ops.job_schedule_slots WHERE slot_id=$1`, params);
}

async function update_ops_job_schedule_slots_11(params, client = pool) {
  // 收尾结算：只有 failed 且属于新账本的槽才计入失败预算；
  // degraded/succeeded/blocked/skipped 都不加，legacy 槽保持旧合同（失败由领取计数体现）。
  return client.query(`UPDATE ops.job_schedule_slots
        SET status=$2, last_run_id=COALESCE($5,last_run_id), data_as_of=CASE WHEN $2 IN ('succeeded','degraded') THEN COALESCE($6, data_as_of) ELSE data_as_of END,
            fail_count=fail_count + CASE WHEN $2::text='failed' AND retry_contract='counters' THEN 1 ELSE 0 END,
            result_summary=COALESCE(result_summary,'{}'::jsonb) || $3::jsonb, last_error=$4, lease_owner=NULL, lease_until=NULL,
            heartbeat_at=now(), updated_at=now()
      WHERE slot_id=$1 AND status='running'
        AND ($7::text IS NULL OR (execution_token=$7
             -- 收尾也必须按实际时间复核：租约已过期就不能标记成功
             AND lease_until IS NOT NULL AND lease_until > clock_timestamp())) RETURNING *`, params);
}

async function update_ops_job_schedule_slots_12(params, client = pool) {
  // 真实执行失败退避：失败预算只在这里累加（等待/续批/收尾成功都不加）。
  // legacy 存量槽保持旧合同，不写新列。
  return client.query(`UPDATE ops.job_schedule_slots
        SET status='failed', last_run_id=COALESCE($5,last_run_id), trigger_type='auto_retry',
            fail_count=fail_count + CASE WHEN retry_contract='counters' THEN 1 ELSE 0 END,
            next_attempt_at=now()+($2 || ' minutes')::interval,
            result_summary=COALESCE(result_summary,'{}'::jsonb) || $3::jsonb, last_error=$4, lease_owner=NULL, lease_until=NULL,
            heartbeat_at=now(), updated_at=now()
      WHERE slot_id=$1 AND status='running'
        AND ($6::text IS NULL OR (execution_token=$6
             AND lease_until IS NOT NULL AND lease_until > clock_timestamp())) RETURNING *`, params);
}

async function update_ops_job_schedule_slots_13(params, client = pool) {
  // 外部保护等待：不动 fail_count（本次不是真实执行失败）。只有 legacy 存量槽继续
  // 维持旧字段"抵消本次领取"的兼容语义；新账本的 attempt_count 只增不减，避免反向扣减
  // 让审计看到的领取次数失真。
  return client.query(`UPDATE ops.job_schedule_slots
        SET status='waiting_external', last_run_id=COALESCE($4,last_run_id), trigger_type='auto_retry',
            next_attempt_at=$2, attempt_count=CASE WHEN retry_contract='legacy' THEN GREATEST(attempt_count-1,0) ELSE attempt_count END,
            result_summary=COALESCE(result_summary,'{}'::jsonb) || $3::jsonb, last_error=$5, lease_owner=NULL, lease_until=NULL,
            heartbeat_at=now(), updated_at=now()
      WHERE slot_id=$1 AND status='running'
        AND ($6::text IS NULL OR (execution_token=$6
             AND lease_until IS NOT NULL AND lease_until > clock_timestamp())) RETURNING *`, params);
}

async function update_ops_job_schedule_slots_14(params, client = pool) {
  return client.query(`UPDATE ops.job_schedule_slots
        SET result_summary = COALESCE(result_summary, '{}'::jsonb) || $2::jsonb ||
          jsonb_build_object('slotExternalCallsTotal',
            COALESCE((COALESCE(result_summary, '{}'::jsonb)->>'slotExternalCallsTotal')::integer, 0) + $3::integer,
            'attemptExternalCalls', $3::integer),
            updated_at=now()
      WHERE slot_id=$1 AND status='running'
        AND ($4::text IS NULL OR (execution_token=$4
             AND lease_until IS NOT NULL AND lease_until > clock_timestamp()))
      RETURNING result_summary`, params);
}

async function update_ops_job_schedule_slots_15(params, client = pool) {
  // 续批（部分完成继续跑）：释放回 pending，不动 fail_count——续批不是失败。
  // 只有 legacy 存量槽保留旧字段兼容扣减；新账本的 attempt_count 只增不减。
  // legacy 分支仍等价于 attempt_count=GREATEST(attempt_count-1,0)，供旧兼容合同使用。
  return client.query(`UPDATE ops.job_schedule_slots
        SET status='pending', last_run_id=COALESCE($4,last_run_id), trigger_type='auto_retry',
            attempt_count=CASE WHEN retry_contract='legacy' THEN GREATEST(attempt_count-1,0) ELSE attempt_count END, next_attempt_at=$2,
            result_summary=COALESCE(result_summary,'{}'::jsonb) || $3::jsonb, last_error=NULL, lease_owner=NULL, lease_until=NULL,
            heartbeat_at=now(), updated_at=now()
      WHERE slot_id=$1 AND status='running'
        AND ($5::text IS NULL OR (execution_token=$5
             AND lease_until IS NOT NULL AND lease_until > clock_timestamp())) RETURNING *`, params);
}

async function select_ops_job_schedule_slots_5(params, client = pool) {
  return client.query(`SELECT job_code FROM ops.job_schedule_slots WHERE slot_id=$1`, params);
}

async function update_ops_job_schedule_slots_16(params, client = pool) {
  return client.query(`UPDATE ops.job_schedule_slots SET heartbeat_at=now(), lease_until=now()+($3::integer * interval '1 minute'), updated_at=now()
      WHERE slot_id=$1 AND lease_owner=$2
        AND ($4::text IS NULL OR (execution_token=$4
             AND lease_until IS NOT NULL AND lease_until > clock_timestamp()))`, params);
}

async function update_ops_job_schedule_slots_17(params, client = pool) {
  // 人工重试：保留 claim_count（领取序列连续可审计），只重置失败预算基线。
  // 这一步同时把槽切到新账本（retry_contract='counters'）：人工重试就是对存量槽的
  // 显式定向确认，符合"未经定向确认不切换"。attempt_count=0 维持旧字段兼容语义。
  return client.query(`UPDATE ops.job_schedule_slots
        SET status='pending', attempt_count=0, fail_count=0, retry_contract='counters',
            next_attempt_at=now(), trigger_type='manual_retry',
            lease_owner=NULL, lease_until=NULL, acknowledged_at=NULL, last_error=NULL,
            execution_token=NULL,
            result_summary='{}'::jsonb, request_payload=request_payload - 'force', updated_at=now()
      WHERE slot_id=$1 AND status IN ('failed','degraded','blocked','skipped','waiting_external','waiting_readiness')
      RETURNING *`, params);
}

async function update_ops_job_schedule_slots_18(params, client = pool) {
  return client.query(`UPDATE ops.job_schedule_slots SET acknowledged_at=now(), updated_at=now()
      WHERE slot_id=$1 RETURNING *`, params);
}

async function select_ops_job_schedule_slots_6(params, client = pool) {
  return client.query(`SELECT s.*, s.business_date::text AS business_date
       FROM ops.job_schedule_slots s
      WHERE s.business_date=$1::date AND ($2::text IS NULL OR s.status=$2)
        AND ($4::text IS NULL OR s.trigger_type=$4)
        AND ($5::text IS NULL OR s.job_code ILIKE '%' || $5 || '%' OR s.last_error ILIKE '%' || $5 || '%' OR s.job_code=ANY($7::text[]))
        AND ($6::text[] IS NULL OR s.job_code=ANY($6::text[]))
      ORDER BY s.scheduled_for DESC, s.slot_id DESC LIMIT $3`, params);
}

async function select_ops_job_schedule_slots_7(params, client = pool) {
  return client.query(`SELECT s.*, s.business_date::text AS business_date FROM ops.job_schedule_slots s WHERE slot_id=$1`, params);
}

async function select_job_runs_2(params, client = pool) {
  return client.query(`SELECT id,job,status,started_at,finished_at,detail,attempt_no,trigger_type,worker_id,heartbeat_at,error_code,error_type,external_call_count,external_sources,datasets FROM job_runs WHERE slot_id=$1 OR id=$2 ORDER BY id DESC LIMIT 20`, params);
}

async function select_ops_job_schedule_slots_8(params, client = pool) {
  return client.query(`SELECT DISTINCT ON (job_code) job_code,status,scheduled_for,data_as_of,last_error
                  FROM ops.job_schedule_slots
                 WHERE business_date=$1::date AND job_code=ANY($2::text[])
                   AND scheduled_for <= $3::timestamptz
                 ORDER BY job_code,scheduled_for DESC`, params);
}

async function select_ops_alert_notifications(params, client = pool) {
  return client.query(`SELECT alert_id,alert_key,alert_type,severity,status,subject,summary,send_attempts,last_sent_at,next_send_at,last_send_error FROM ops.alert_notifications WHERE slot_id=$1 ORDER BY alert_id DESC LIMIT 20`, params);
}

async function select_admin_audit_log(params, client = pool) {
  return client.query(`SELECT id,actor,action,target,detail,result,request_id,metadata,created_at FROM admin_audit_log WHERE target=$1 OR metadata->>'slotId'=$1 ORDER BY id DESC LIMIT 20`, params);
}

async function update_ops_worker_heartbeats(params, client = pool) {
  return client.query(`UPDATE ops.worker_heartbeats
        SET status='stopped', updated_at=now()
      WHERE role=$1 AND worker_id LIKE $2 AND worker_id<>$3 AND status<>'stopped'`, params);
}

async function insert_ops_worker_heartbeats(params, client = pool) {
  // params: [worker_id, role, pid, app_version, status, commit_sha]
  // commit_sha 是部署后核对"进程加载的是哪个提交"的唯一心跳证据（迁移 182）。
  return client.query(`INSERT INTO ops.worker_heartbeats(worker_id,role,pid,app_version,status,commit_sha,started_at,last_seen_at,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,now(),now(),now())
     ON CONFLICT(worker_id) DO UPDATE SET role=EXCLUDED.role,pid=EXCLUDED.pid,
       app_version=EXCLUDED.app_version,commit_sha=EXCLUDED.commit_sha,
       started_at=CASE WHEN ops.worker_heartbeats.pid IS DISTINCT FROM EXCLUDED.pid
                            OR ops.worker_heartbeats.status='stopped'
                       THEN EXCLUDED.started_at ELSE ops.worker_heartbeats.started_at END,
       status=EXCLUDED.status,last_seen_at=now(),updated_at=now()`, params);
}

async function select_ops_job_schedule_slots_9(params, client = pool) {
  return client.query(`SELECT status, COUNT(*)::int AS count FROM ops.job_schedule_slots WHERE business_date=$1::date GROUP BY status`, params);
}

async function select_ops_job_schedule_slots_10(params, client = pool) {
  return client.query(`SELECT job_code, status, scheduled_for, updated_at, last_error FROM ops.job_schedule_slots WHERE business_date=$1::date ORDER BY scheduled_for DESC`, params);
}

async function with_ops_worker_heartbeats(params, client = pool) {
  return client.query(`WITH ranked AS (
          SELECT worker_id,role,pid,app_version,status,started_at,last_seen_at,
                 row_number() OVER (PARTITION BY role ORDER BY last_seen_at DESC) AS row_no
            FROM ops.worker_heartbeats
        )
        SELECT worker_id,role,pid,app_version,
          CASE WHEN last_seen_at < now()-interval '2 minutes' THEN 'stale' ELSE status END AS status,
          started_at,last_seen_at
          FROM ranked WHERE row_no=1 ORDER BY last_seen_at DESC`);
}

async function select_ops_job_schedule_slots_11(params, client = pool) {
  return client.query(`SELECT * FROM ops.job_schedule_slots WHERE slot_id=$1`, params);
}

async function select_job_runs_3(params, client = pool) {
  return client.query(`SELECT status FROM job_runs WHERE id=$1`, params);
}

async function update_ops_job_schedule_slots_19(params, client = pool) {
  return client.query(`UPDATE ops.job_schedule_slots
              SET status='succeeded', last_error=NULL, data_as_of=NULL, updated_at=now()
            WHERE slot_id=$1
            RETURNING *`, params);
}

async function update_ops_job_schedule_slots_20(params, client = pool) {
  return client.query(`UPDATE ops.job_schedule_slots
          SET data_as_of=$2,
              status=CASE WHEN $3::boolean THEN 'succeeded' ELSE 'degraded' END,
              last_error=CASE WHEN $3::boolean THEN NULL ELSE '重新校验发现业务数据水位落后' END,
              updated_at=now()
        WHERE slot_id=$1
        RETURNING *`, params);
}

// 就绪等待写入（迁移 206 的 waiting_readiness）：发布/锁/依赖类等待。
// 与 waiting_external 的区别是不消耗失败预算、不参与"缺 recover_at 三次"规则，
// 由 sweepStaleSlots 的同周期到期批次统一重验（方案 P0-A）。
async function update_ops_job_schedule_slots_21(params, client = pool) {
  // params: [slotId, nextCheckAt, summary, runId, errorMessage, expectedToken]
  return client.query(`UPDATE ops.job_schedule_slots
        SET status='waiting_readiness', last_run_id=COALESCE($4,last_run_id), trigger_type='auto_retry',
            next_attempt_at=$2, attempt_count=CASE WHEN retry_contract='legacy' THEN GREATEST(attempt_count-1,0) ELSE attempt_count END,
            result_summary=COALESCE(result_summary,'{}'::jsonb) || $3::jsonb, last_error=$5, lease_owner=NULL, lease_until=NULL,
            heartbeat_at=now(), updated_at=now()
      WHERE slot_id=$1 AND status='running'
        AND ($6::text IS NULL OR (execution_token=$6
             AND lease_until IS NOT NULL AND lease_until > clock_timestamp())) RETURNING *`, params);
}

// 到期就绪等待的有界批次：不受旧槽 60 分钟最小年龄限制，否则 17:15 的复查点会被挡到 18:10。
async function listDueReadinessSlots(limit, client = pool) {
  const { rows } = await client.query(
    `SELECT *, business_date::text AS business_date, updated_at::text AS updated_at_exact
       FROM ops.job_schedule_slots
      WHERE status='waiting_readiness' AND next_attempt_at IS NOT NULL AND next_attempt_at <= now()
      ORDER BY next_attempt_at ASC, slot_id ASC LIMIT $1`, [limit]);
  return rows;
}

// 重验通过：按 updated_at 做乐观锁转回原槽 pending，不新开实例、不直接调 Runner。
// 就绪观测只在调用方明确传入 readyEvidence 时落库；锁等待唤醒不能伪造数据就绪。
// readinessFirstReadyAt 是本站观测，不是供应商发布时间；实际 published_at 与分区状态另读。
async function update_ops_job_schedule_slots_22(params, client = pool) {
  // params: [slotId, updated_at 文本, readyEvidence JSON]
  return client.query(`UPDATE ops.job_schedule_slots
        SET status='pending', next_attempt_at=now(), trigger_type='auto_retry',
            last_error=NULL,
             result_summary = COALESCE(result_summary,'{}'::jsonb)
               || jsonb_build_object('waitingReadiness', false, 'readinessReadyAt', now()::text)
               || COALESCE($3::jsonb, '{}'::jsonb),
            updated_at=now()
      WHERE slot_id=$1 AND status='waiting_readiness' AND updated_at=$2::timestamptz
      RETURNING *, business_date::text AS business_date`, params);
}

// 仍未就绪：只在原状态上推进下一个检查点，保留首次观测和等待原因。
async function update_ops_job_schedule_slots_23(params, client = pool) {
  // params: [slotId, nextCheckAt, summary, errorMessage, updated_at 文本]
  return client.query(`UPDATE ops.job_schedule_slots
        SET next_attempt_at=$2, result_summary=COALESCE(result_summary,'{}'::jsonb) || $3::jsonb, last_error=$4, updated_at=now()
      WHERE slot_id=$1 AND status='waiting_readiness' AND updated_at=$5::timestamptz
      RETURNING *`, params);
}

// 就绪等待超期：只升级状态与证据，不凭空记一次执行失败。
// 依赖未发布可以在任何一次执行之前就进入等待（claim_count=0），把它算成"执行失败"
// 会直接破坏"领取 = 失败 + 等待 + 续批 + 成功 + 其他结算 + 未结算"的守恒。
// 超期仍是真实故障，由告警与 failed 状态体现；next_attempt_at 置空避免自动重领，
// 人工重试走 retryJobSlot 显式重新排队。
async function update_ops_job_schedule_slots_24(params, client = pool) {
  // params: [slotId, summary, errorMessage, updated_at 文本]
  return client.query(`UPDATE ops.job_schedule_slots
        SET status='failed', next_attempt_at=NULL,
            result_summary=COALESCE(result_summary,'{}'::jsonb) || $2::jsonb, last_error=$3, updated_at=now()
      WHERE slot_id=$1 AND status='waiting_readiness' AND updated_at=$4::timestamptz
      RETURNING *`, params);
}

// 候选阶段发现依赖分区未发布：试点任务转入就绪等待，不写数据集故障告警、不判永久失败。
// 只接受 pending，已失败或已阻塞的槽保持原状，等它自己的证据，不做隐式翻案。
async function update_ops_job_schedule_slots_25(params, client = pool) {
  // params: [slotId, nextCheckAt, summary 增量, errorMessage]
  return client.query(`UPDATE ops.job_schedule_slots
        SET status='waiting_readiness', next_attempt_at=$2,
            result_summary=COALESCE(result_summary,'{}'::jsonb) || $3::jsonb,
            last_error=$4, updated_at=now()
      WHERE slot_id=$1 AND status='pending'
      RETURNING *, business_date::text AS business_date`, params);
}

// 通用语句执行入口：供「可注入查询器」的默认实现使用，连接与执行留在数据层
async function runQuery(sql, params, client = pool) {
  return client.query(sql, params);
}

// 各任务的数据水位查询映射：表名与口径按任务代码固定，不接受外部输入
const DATA_AS_OF_QUERIES = {
    // 手动回查可能晚于正式快照写入、但数据日期更旧；水位必须取所有快照中的最新数据日期。
    bond_safety_refresh: `SELECT MAX(COALESCE(source_updated_at, refreshed_at)) AS data_as_of FROM bond_safety_snapshots`,
    hk_rate: `SELECT max(rate_date)::text AS data_as_of FROM market.fx_rates WHERE base_currency='HKD' AND quote_currency='CNY'`,
    nav_snapshot: `SELECT max(date)::text AS data_as_of FROM nav_history`,
    index_baseline: `SELECT max(date)::text AS data_as_of FROM index_history`,
    index_recent: `SELECT max(date)::text AS data_as_of FROM index_history`,
    ipo_calendar_refresh: `SELECT max(to_date(report_date, 'YYYYMMDD'))::text AS data_as_of
      FROM ipo_reports WHERE report_date ~ '^\\d{8}'`,
    ipo_history_sync: `SELECT max(last_success_date)::text AS data_as_of FROM ops.sync_cursors WHERE scope_key='global:ipo_history'`,
    stock_analysis_refresh: `SELECT max(NULLIF(snapshot.payload->>'latest_market_trade_date','')::date)::text AS data_as_of
      FROM analytics.stock_overview_latest latest
      JOIN LATERAL (
        SELECT payload FROM analytics.analysis_snapshots
         WHERE instrument_id=latest.instrument_id AND as_of_date=latest.as_of_date AND snapshot_type='stock_analysis'
         ORDER BY created_at DESC LIMIT 1
      ) snapshot ON true`,
    hk_trade_rules_sync: `SELECT max(source_updated_at)::text AS data_as_of FROM market.instrument_trade_rules`,
    // 套利任务必须同时确认港交所、上交所和深交所；取 max 会被单一来源的成功掩盖另一来源的落后。
    arbitrage_sync: `SELECT LEAST(
      COALESCE((SELECT max(last_success_date) FROM ops.sync_cursors WHERE scope_key='arbitrage_hkex' AND dataset_code='hkex_announcements'), '1900-01-01'::date),
      COALESCE((SELECT max(last_success_date) FROM ops.sync_cursors WHERE scope_key='arbitrage_sse' AND dataset_code='sse_announcements'), '1900-01-01'::date),
      COALESCE((SELECT max(last_success_date) FROM ops.sync_cursors WHERE scope_key='arbitrage_szse' AND dataset_code='szse_announcements'), '1900-01-01'::date)
    )::text AS data_as_of`,
    convertible_bond_announcement_history_sync: `SELECT max(last_success_date)::text AS data_as_of
      FROM ops.sync_cursors WHERE scope_key='convertible_bond_announcement_history' AND dataset_code='official_announcements'`,
    convertible_bond_universe_refresh: `SELECT max(last_success_date)::text AS data_as_of
      FROM ops.sync_cursors WHERE scope_key='convertible_bond_universe' AND dataset_code='cb_basic_cb_daily'`,
    convertible_bond_valuation_refresh: `SELECT max(trade_date)::text AS data_as_of FROM analytics.convertible_bond_valuation_daily`,
    market_volatility_sync: `SELECT LEAST(
      COALESCE((SELECT max(trade_date) FROM market.market_valuation_daily WHERE market_code='CN' AND benchmark_code='CSI300' AND source_code='lixinger_official'), '1900-01-01'::date),
      COALESCE((SELECT max(trade_date) FROM market.market_valuation_daily WHERE market_code='CN' AND benchmark_code='CSIALL' AND source_code='lixinger_official'), '1900-01-01'::date),
      COALESCE((SELECT max(trade_date) FROM market.market_valuation_daily WHERE market_code='HK' AND benchmark_code='HSI' AND source_code IN ('hsi_official','lixinger_official')), '1900-01-01'::date),
      COALESCE((SELECT max(trade_date) FROM market.sovereign_yield_daily WHERE market_code='CN' AND tenor_years=10 AND source_code IN ('chinabond','lixinger_official')), '1900-01-01'::date),
      COALESCE((SELECT max(trade_date) FROM market.sovereign_yield_daily WHERE market_code='US' AND tenor_years=10 AND source_code='tushare_us_tycr'), '1900-01-01'::date),
      COALESCE((SELECT max(trade_date) FROM analytics.graham_index_daily WHERE market_code='CN' AND benchmark_code='CSI300'), '1900-01-01'::date),
      COALESCE((SELECT max(trade_date) FROM analytics.graham_index_daily WHERE market_code='CN' AND benchmark_code='CSIALL'), '1900-01-01'::date),
      COALESCE((SELECT max(month) FROM market.money_supply_monthly WHERE market_code='CN'), '1900-01-01'::date),
      COALESCE((SELECT max(trade_date) FROM market.a_share_market_cap_daily WHERE source_code IN ('tushare_daily_basic','lixinger_official')), '1900-01-01'::date)
    )::text AS data_as_of`,
};

// 按任务代码取数据水位对应的日期文本
async function selectDataAsOfDate(sql, params, client = pool) {
  const { rows } = await client.query(sql, params);
  return rows;
}

// 按状态统计活动告警条数（活动告警口径由 jobAlertMailerRepository 定义）
async function countAlertsByStatus(client = pool) {
  const { ACTIVE_ALERT_WHERE } = require('./jobAlertMailerRepository');
  const { rows } = await client.query(
    `SELECT status, COUNT(*)::int AS count FROM ops.alert_notifications WHERE ${ACTIVE_ALERT_WHERE} GROUP BY status`,
  );
  return rows;
}

// 严格恢复候选分页：范围条件已全部进 WHERE，分页只跳过“范围匹配但证据不足”的候选
async function selectStrictRecoveryCandidates(params, client = pool) {
  const { recoveryScopeFilter } = require('./jobRecoveryEvidenceRepository');
  const slot = params.slot;
  const scope = recoveryScopeFilter(slot, 5);
  const limitIndex = scope.nextIndex;
  const offsetIndex = limitIndex + 1;
  return client.query(
    `SELECT slot_id,job_code,business_date,status,scheduled_for,request_payload,result_summary,data_as_of
       FROM ops.job_schedule_slots
      WHERE job_code=$1 AND business_date=$2::date AND status IN ('succeeded','degraded')
        AND slot_id<>$3 AND scheduled_for>$4::timestamptz
        AND ${scope.sql}
      ORDER BY scheduled_for ASC, slot_id ASC LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
    [slot.job_code, slot.business_date, slot.slot_id, slot.scheduled_for, ...scope.params, params.limit, params.offset],
  );
}


function recoverNavDependenciesLayerQuery1(executor, parts, ...args) { return executor("SELECT *,business_date::text AS business_date FROM ops.job_schedule_slots WHERE job_code='nav_snapshot' AND status='blocked' AND acknowledged_at IS NULL AND NOT (result_summary ? 'dependencyRecovery') AND last_error LIKE '数据集 %连续%'", ...args); }

function recoverNavDependenciesLayerQuery2(executor, parts, ...args) { return executor(`SELECT p.updated_at AS evidence_at,p.partition_id::text AS evidence_id
              FROM ops.dataset_partitions p WHERE dataset_code='repo_daily_rates' AND scope_key='CN'
              AND partition_key=$1::date AND status='published' AND NOT is_stale AND diagnostics->>'quality_status'='passed'
              AND EXISTS(SELECT 1 FROM market.repo_daily_rates r JOIN core.instruments i USING(instrument_id)
                WHERE i.canonical_code='204001.SH' AND r.trade_date=$1::date AND r.quality_status='passed')`, ...args); }

function recoverNavDependenciesLayerQuery3(executor, parts, ...args) { return executor(`SELECT c.updated_at AS evidence_at,c.cursor_id::text AS evidence_id FROM ops.sync_cursors c
              JOIN core.instruments i ON c.scope_key='cash_dividend:'||i.instrument_id::text
              WHERE c.dataset_code='stock_cash_dividend_facts' AND (i.canonical_code=$1 OR split_part(i.canonical_code,'.',1)=$1)
              AND c.last_success_date >= $2::date AND c.cursor_payload->>'complete'='true'
              AND c.cursor_payload->>'parserVersion'=$3`, ...args); }

module.exports = {
  recoverNavDependenciesLayerQuery1, recoverNavDependenciesLayerQuery2, recoverNavDependenciesLayerQuery3,
  selectStrictRecoveryCandidates,
  countAlertsByStatus,
  DATA_AS_OF_QUERIES,
  selectDataAsOfDate,
  runQuery,
  listStaleSlots,
  readSlotRequestPayload,
  taskDependencyStates,
  insert_ops_job_schedule_slots,
  skipReplacedScheduledSlot,
  select_ops_dataset_partitions,
  select_data,
  select_ops_job_schedule_slots,
  insert_ops_job_schedule_slots_1,
  update_ops_job_schedule_slots,
  update_ops_job_schedule_slots_1,
  update_ops_job_schedule_slots_2,
  update_ops_job_schedule_slots_3,
  update_ops_job_schedule_slots_4,
  select_job_runs,
  select_job_runs_1,
  update_ops_job_schedule_slots_5,
  select_ops_job_schedule_slots_1,
  update_ops_job_schedule_slots_6,
  update_ops_job_schedule_slots_7,
  update_job_runs,
  select_ops_job_schedule_slots_2,
  update_ops_job_schedule_slots_8,
  select_ops_job_schedule_slots_3,
  update_ops_job_schedule_slots_9,
  update_ops_job_schedule_slots_10,
  select_ops_job_schedule_slots_4,
  update_ops_job_schedule_slots_11,
  update_ops_job_schedule_slots_12,
  update_ops_job_schedule_slots_13,
  update_ops_job_schedule_slots_14,
  update_ops_job_schedule_slots_15,
  select_ops_job_schedule_slots_5,
  update_ops_job_schedule_slots_16,
  update_ops_job_schedule_slots_17,
  update_ops_job_schedule_slots_18,
  select_ops_job_schedule_slots_6,
  select_ops_job_schedule_slots_7,
  select_job_runs_2,
  select_ops_job_schedule_slots_8,
  select_job_slot_by_request_id,
  select_ops_alert_notifications,
  select_admin_audit_log,
  update_ops_worker_heartbeats,
  insert_ops_worker_heartbeats,
  select_ops_job_schedule_slots_9,
  select_ops_job_schedule_slots_10,
  with_ops_worker_heartbeats,
  select_ops_job_schedule_slots_11,
  select_job_runs_3,
  update_ops_job_schedule_slots_19,
  update_ops_job_schedule_slots_20,
  update_ops_job_schedule_slots_21,
  update_ops_job_schedule_slots_22,
  update_ops_job_schedule_slots_23,
  update_ops_job_schedule_slots_24,
  update_ops_job_schedule_slots_25,
  listDueReadinessSlots,
};

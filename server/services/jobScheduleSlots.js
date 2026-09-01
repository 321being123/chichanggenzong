const os = require('os');
const { pool } = require('../db/connection');
const { JOB_DEFINITIONS, getJobDefinition } = require('./jobDefinitions');
const { isCnHoliday } = require('../config/holidays');
const { sanitizeJobError, sanitizeJobResult } = require('./jobErrorSanitizer');
const { ACTIVE_ALERT_WHERE } = require('./jobAlertMailer');

const HOSTNAME = os.hostname();

function workerIdForRole(role = 'worker') {
  return `${HOSTNAME}:${String(role || 'worker').slice(0, 32)}`;
}

const WORKER_ID = workerIdForRole(process.env.JOB_PROCESS_ROLE || 'worker');

function shanghaiParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short'
  }).formatToParts(date);
  return Object.fromEntries(parts.map(item => [item.type, item.value]));
}

function dateText(date = new Date()) {
  const p = shanghaiParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

function normalizeBusinessDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return dateText(value);
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : dateText(parsed);
}

function scheduledDate(dateTextValue, hour, minute) {
  const [year, month, day] = dateTextValue.split('-').map(Number);
  // Date.UTC 的字段作为北京时间字段使用，再减去东八区偏移得到真实时刻。
  return new Date(Date.UTC(year, month - 1, day, hour - 8, minute, 0));
}

function isWeekday(dateTextValue) {
  const day = new Date(`${dateTextValue}T00:00:00Z`).getUTCDay();
  return day >= 1 && day <= 5 && !isCnHoliday(dateTextValue);
}

function previousDate(dateTextValue) {
  const d = new Date(`${dateTextValue}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// 计划实例的执行日有两种口径：
//   afterTradingDay：收盘日的次日执行。适用于收盘后才产生的数据（盘后公告、完整行情），
//     这样周五收盘后的数据周六就能同步，不必等到下周一；遇节假日自动落在假期第一天
//     （因为前一天是最后一个交易日），假期其余日期因前一天没有收盘而不再执行。
//   weekdays：交易日当天执行。适用于收盘价、净值等当天即可取到的数据。
// 两者都复用 isWeekday，已内置节假日判断。
function isSlotDayAllowed(dateTextValue, definition) {
  if (definition.afterTradingDay) return isWeekday(previousDate(dateTextValue));
  if (definition.weekdays) return isWeekday(dateTextValue);
  return true;
}

function expectedDataDate(jobCode, businessDate) {
  const normalized = normalizeBusinessDate(businessDate);
  if (!normalized) return null;
  // 打新日报在当天 18:00 生成下一个交易日的建议，不能把当天旧日报当成新鲜数据。
  if (jobCode === 'ipo_calendar_refresh') {
    let cursor = normalized;
    do { cursor = new Date(`${cursor}T00:00:00Z`); cursor.setUTCDate(cursor.getUTCDate() + 1); cursor = cursor.toISOString().slice(0, 10); }
    while (!isWeekday(cursor));
    return cursor;
  }
  if (getJobDefinition(jobCode).dataDatePolicy !== 'previous_trading_day') return normalized;
  let cursor = previousDate(normalized);
  while (!isWeekday(cursor)) cursor = previousDate(cursor);
  return cursor;
}

async function ensureSlot(jobCode, scheduledFor, businessDate, triggerType = 'scheduled', requestPayload = {}) {
  const { rows } = await pool.query(
    `INSERT INTO ops.job_schedule_slots(job_code, scheduled_for, business_date, trigger_type, next_attempt_at,request_payload)
     VALUES ($1,$2,$3,$4,$2,$5::jsonb)
     ON CONFLICT(job_code, scheduled_for) DO UPDATE SET request_payload=EXCLUDED.request_payload,updated_at=now()
     RETURNING *`,
    [jobCode, scheduledFor, businessDate, triggerType, JSON.stringify(requestPayload || {})]
  );
  return rows[0] || null;
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

async function datasetDependencyState(slot, definition) {
  const requirements = definition.datasetDependencies || [];
  if (!requirements.length) return { ready: true, failed: false, detail: '' };
  const failures = [];
  for (const requirement of requirements) {
    const partitionKey = String(slot.business_date).slice(0, 10);
    const { rows } = await pool.query(
      `SELECT status,is_stale,diagnostics
         FROM ops.dataset_partitions
        WHERE dataset_code=$1 AND scope_key=$2 AND partition_key=$3::date
        ORDER BY updated_at DESC LIMIT 1`,
      [requirement.datasetCode, requirement.scopeKey || '', partitionKey]
    );
    const partition = rows[0];
    if (!partition) {
      failures.push(`${requirement.datasetCode}@${partitionKey}=missing`);
      continue;
    }
    const qualityStatus = partition.diagnostics && partition.diagnostics.quality_status;
    if (partition.status !== 'published' || partition.is_stale
        || (requirement.requireQualityStatus && qualityStatus !== requirement.requireQualityStatus)) {
      failures.push(`${requirement.datasetCode}@${partitionKey}=${partition.status}/${qualityStatus || 'unknown'}`);
    }
  }
  return {
    ready: failures.length === 0,
    failed: failures.length > 0,
    detail: failures.join(', '),
  };
}

async function enqueueManualJob(jobCode, requestPayload = {}) {
  const definition = JOB_DEFINITIONS.find(item => item.jobCode === jobCode);
  if (!definition) return null;
  const safePayload = sanitizeJobResult(requestPayload || {});
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('manual_job:' || $1 || ':' || $2))", [jobCode, JSON.stringify(safePayload)]);
    const active = await client.query(`
      SELECT * FROM ops.job_schedule_slots
       WHERE job_code=$1
         AND request_payload @> $3::jsonb
         AND (status='running' OR (status='pending' AND scheduled_for <= now()
           AND COALESCE(next_attempt_at,scheduled_for) <= now() AND attempt_count < $2))
       ORDER BY slot_id DESC LIMIT 1
    `, [jobCode, Number(definition.maxAttempts || 3), JSON.stringify(safePayload)]);
    if (active.rows[0]) {
      await client.query('COMMIT');
      return active.rows[0];
    }
    const scheduledFor = new Date();
    const { rows } = await client.query(`
      INSERT INTO ops.job_schedule_slots(job_code,scheduled_for,business_date,trigger_type,next_attempt_at,request_payload)
      VALUES($1,$2,$3,'manual_retry',$2,$4::jsonb) RETURNING *
    `, [jobCode, scheduledFor, dateText(scheduledFor), JSON.stringify(safePayload)]);
    await client.query('COMMIT');
    return rows[0] || null;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function reconcileSlot(slot) {
  if (!slot || new Date(slot.scheduled_for) > new Date()) return slot;
  const definition = getJobDefinition(slot.job_code);
  // succeeded 是执行终态。后续只允许展示/告警，不得再次根据水位重放业务任务。
  if (slot.status === 'succeeded') return slot;
  // 人工补跑刚重置为 pending 时，旧的失败 job_runs 仍然存在；此时不能被旧记录立即回滚为 failed，
  // 必须先让统一执行器领取并生成新的 manual_retry 运行记录。
  if (slot.status === 'pending' && slot.trigger_type === 'manual_retry') return slot;
  // 外部来源限流/额度恢复前不消耗业务重试次数；恢复后由统一执行器继续执行。
  if (['failed', 'waiting_external'].includes(slot.status)
      && definition.reconcileByWatermark === true) {
    const actualDataAsOf = await queryDataAsOf(slot.job_code, slot.business_date).catch(() => null);
    if (isDataAsOfFresh(actualDataAsOf, slot.business_date, definition)) {
      const { rows: recoveredRows } = await pool.query(
        `UPDATE ops.job_schedule_slots
            SET status='succeeded', data_as_of=$2, last_error=NULL, updated_at=now()
          WHERE slot_id=$1 AND status IN ('failed','waiting_external') RETURNING *`,
        [slot.slot_id, actualDataAsOf]
      );
      if (recoveredRows[0]) {
        const { resolveJobSlotAlerts } = require('./jobAlertMailer');
        await resolveJobSlotAlerts(recoveredRows[0]).catch(error => console.warn('[job-alert] 外部水位恢复告警处理失败:', error.message));
        return recoveredRows[0];
      }
    }
  }
  // degraded 只做数据库水位重验，绝不重新调用业务 Runner 或外部接口。
  if (slot.status === 'degraded' && definition.requiresDataWatermark !== false) {
    const actualDataAsOf = await queryDataAsOf(slot.job_code, slot.business_date).catch(() => null);
    if (isDataAsOfFresh(actualDataAsOf, slot.business_date, definition)) {
      const { rows: recoveredRows } = await pool.query(
        `UPDATE ops.job_schedule_slots
            SET status='succeeded', data_as_of=$2, last_error=NULL, updated_at=now()
          WHERE slot_id=$1 AND status='degraded' RETURNING *`,
        [slot.slot_id, actualDataAsOf]
      );
      if (recoveredRows[0]) {
        const { resolveJobSlotAlerts } = require('./jobAlertMailer');
        await resolveJobSlotAlerts(recoveredRows[0]).catch(error => console.warn('[job-alert] 降级状态恢复告警处理失败:', error.message));
        return recoveredRows[0];
      }
    }
    return slot;
  }
  if (slot.status === 'blocked') {
    const dependencies = definition.dependencyCodes || [];
    if (dependencies.length || (definition.datasetDependencies || []).length) {
      const states = await taskDependencyStates(slot, dependencies);
      const datasets = await datasetDependencyState(slot, definition);
      if (dependencies.every(code => states.get(code) === 'succeeded') && datasets.ready) {
        const { rows: releasedRows } = await pool.query(
          `UPDATE ops.job_schedule_slots
              SET status='pending', next_attempt_at=now(), last_error=NULL, updated_at=now()
            WHERE slot_id=$1 AND status='blocked' RETURNING *`, [slot.slot_id]
        );
        return releasedRows[0] || slot;
      }
    }
    return slot;
  }
  if (slot.status === 'failed' && slot.result_summary && slot.result_summary.timed_out) return slot;
  const { rows } = await pool.query(
    `SELECT id, status, finished_at, detail, result_json
       FROM job_runs
      WHERE slot_id=$1
      ORDER BY id DESC LIMIT 1`,
    [slot.slot_id]
  );
  let run = rows[0];
  if (!run) {
    const legacy = await pool.query(
      `SELECT id, status, finished_at, detail, result_json
         FROM job_runs
       WHERE job=$1 AND started_at >= $2::timestamptz
         AND started_at < $2::timestamptz + make_interval(mins => $3::integer)
        ORDER BY id DESC LIMIT 1`,
    [slot.job_code, slot.scheduled_for, Number(getJobDefinition(slot.job_code).deadlineMinutes || 180)]
    );
    run = legacy.rows[0];
  }
  if (!run || !['done', 'failed'].includes(run.status)) return slot;
  const requestedStatus = run.status === 'done' ? 'succeeded' : 'failed';
  const requiresDataWatermark = definition.requiresDataWatermark !== false;
  const runResult = run.result_json && typeof run.result_json === 'object' ? run.result_json : {};
  const skipWatermark = runResult.watermarkNotRequired === true;
  const dataAsOf = requestedStatus === 'succeeded' && requiresDataWatermark && !skipWatermark
    ? await queryDataAsOf(slot.job_code, slot.business_date).catch(() => null)
    : null;
  const nextStatus = requestedStatus === 'succeeded' && requiresDataWatermark && !skipWatermark
    && !isDataAsOfFresh(dataAsOf, slot.business_date, definition) ? 'degraded' : requestedStatus;
  const resultSummary = { ...runResult, source: 'job_runs', runId: run.id, detail: sanitizeJobError(run.detail || '') };
  const updated = await pool.query(
    `UPDATE ops.job_schedule_slots
        SET status=$2, last_run_id=$3,
            data_as_of=CASE WHEN $2='succeeded' THEN COALESCE($4, data_as_of) ELSE data_as_of END,
            last_error=$5, result_summary=$6::jsonb, updated_at=now()
      WHERE slot_id=$1 AND status NOT IN ('running','succeeded')
      RETURNING *`,
    [slot.slot_id, nextStatus, run.id, dataAsOf,
      nextStatus === 'failed' ? sanitizeJobError(run.detail || '') : nextStatus === 'degraded' ? '运行记录成功但未形成可确认的数据日期' : null,
      JSON.stringify(resultSummary)]
  );
  if (updated.rows[0] && nextStatus === 'degraded') {
    const { notifyJobFailure } = require('./jobAlertMailer');
    await notifyJobFailure({
      jobCode: slot.job_code,
      slotId: slot.slot_id,
      alertKey: `slot:${slot.slot_id}:degraded`,
      alertType: 'degraded',
      subject: `后台任务数据未确认：${getJobDefinition(slot.job_code).label}`,
      summary: '任务执行记录显示成功，但没有找到不早于计划日期的数据日期，请检查上游接口和入库结果。',
      }).catch(error => console.warn('[job-alert] 降级告警失败:', error.message));
  }
  if (updated.rows[0] && nextStatus === 'succeeded') {
    const { resolveJobSlotAlerts } = require('./jobAlertMailer');
    await resolveJobSlotAlerts(updated).catch(error => console.warn('[job-alert] 重新校验恢复告警处理失败:', error.message));
  }
  return updated.rows[0] || slot;
}

async function syncScheduleSlots(now = new Date()) {
  const today = dateText(now);
  const allDates = [today];
  let cursor = today;
  for (let i = 0; i < 31; i++) {
    cursor = previousDate(cursor);
    allDates.push(cursor);
  }
  const created = [];
  for (const definition of JOB_DEFINITIONS) {
    if (definition.manualOnly) continue;
    const candidateDates = allDates.filter(date =>
      isSlotDayAllowed(date, definition) && (!definition.monthly || date.slice(8, 10) === '01'));
    const dates = definition.catchupMode === 'latest_only' ? candidateDates.slice(0, 1) : allDates;
    for (const businessDate of dates) {
      if (definition.monthly && businessDate.slice(8, 10) !== '01') continue;
      if (!isSlotDayAllowed(businessDate, definition)) continue;
      const schedules = [
        { hour: definition.hour, minute: definition.minute, mode: 'core' },
        ...(definition.additionalSchedules || []),
      ];
      for (const schedule of schedules) {
        const scheduledFor = scheduledDate(businessDate, schedule.hour, schedule.minute);
        const windowMinutes = definition.catchupWindowMinutes || definition.deadlineMinutes || 180;
        if (businessDate !== today && scheduledFor.getTime() + windowMinutes * 60000 < now.getTime()) continue;
        const slot = await ensureSlot(definition.jobCode, scheduledFor, businessDate, 'scheduled', { mode: schedule.mode || 'core' });
        const current = await reconcileSlot(slot);
        if (current.status === 'pending' && now.getTime() > scheduledFor.getTime() + definition.deadlineMinutes * 60000) {
          const { notifyJobFailure } = require('./jobAlertMailer');
          await notifyJobFailure({
            jobCode: definition.jobCode,
            slotId: current.slot_id,
            alertKey: `slot:${current.slot_id}:late`,
            alertType: 'late',
            subject: `后台任务漏跑：${definition.label}`,
            summary: `计划时间 ${scheduledFor.toISOString()} 后仍未完成，请在后台任务页面补跑或确认接管。`,
          }).catch(error => console.warn('[job-alert] 漏跑告警处理失败:', error.message));
        }
        created.push(current);
      }
    }
  }
  return { ok: true, count: created.length, slots: created };
}

async function claimSlot(slotId, workerId = WORKER_ID, triggerType = 'scheduled') {
  const lookup = await pool.query('SELECT job_code,business_date::text AS business_date,scheduled_for FROM ops.job_schedule_slots WHERE slot_id=$1', [slotId]);
  if (!lookup.rows[0]) return null;
  const definition = getJobDefinition(lookup.rows[0].job_code);
  const dependencies = definition.dependencyCodes || [];
  if (dependencies.length) {
    const states = await taskDependencyStates(lookup.rows[0], dependencies);
    if (dependencies.some(code => ['failed', 'degraded', 'blocked'].includes(states.get(code)))) {
      await pool.query(
        `UPDATE ops.job_schedule_slots
            SET status='blocked', last_error=$2, next_attempt_at=NULL,
                lease_owner=NULL, lease_until=NULL, heartbeat_at=now(), updated_at=now()
          WHERE slot_id=$1 AND status IN ('pending','failed','degraded','waiting_external')`,
        [slotId, `依赖任务未成功：${dependencies.map(code => `${code}=${states.get(code) || 'missing'}`).join(', ')}`]
      );
      return null;
    }
    if (dependencies.some(code => !states.has(code) || ['pending', 'running', 'waiting_external'].includes(states.get(code)))) return null;
  }
  const datasets = await datasetDependencyState(lookup.rows[0], definition);
  if (!datasets.ready) {
    if (datasets.failed) {
      await pool.query(
        `UPDATE ops.job_schedule_slots
            SET status='blocked', last_error=$2, next_attempt_at=NULL,
                lease_owner=NULL, lease_until=NULL, heartbeat_at=now(), updated_at=now()
          WHERE slot_id=$1 AND status IN ('pending','failed','degraded','waiting_external')`,
        [slotId, `依赖数据分区未发布：${datasets.detail}`]
      );
    }
    return null;
  }
  const { rows } = await pool.query(
    `UPDATE ops.job_schedule_slots
        SET status='running', attempt_count=attempt_count+1, lease_owner=$2,
            lease_until=now()+($5::integer * interval '1 minute'), heartbeat_at=now(),
            next_attempt_at=NULL, trigger_type=$3, updated_at=now()
      WHERE slot_id=$1 AND status IN ('pending','failed','waiting_external')
        AND attempt_count < $4
        AND (status='pending' OR (next_attempt_at IS NOT NULL AND next_attempt_at<=now()))
      RETURNING *, business_date::text AS business_date`,
    [slotId, workerId, triggerType, definition.maxAttempts || 3, definition.timeoutMinutes || 30]
  );
  return rows[0] || null;
}

async function recoverExpiredSlots() {
  await pool.query(
    `UPDATE job_runs
        SET status='failed', finished_at=COALESCE(finished_at, now()),
            detail=CASE WHEN COALESCE(detail,'')='' THEN '执行租约已过期，系统已自动回收' ELSE detail END
      WHERE status='running' AND locked_until IS NOT NULL AND locked_until < now()`
  );
  const { rows } = await pool.query(
    `SELECT slot_id, job_code, attempt_count
       FROM ops.job_schedule_slots
      WHERE status='running' AND lease_until IS NOT NULL AND lease_until < now()
      ORDER BY slot_id`
  );
  for (const slot of rows) {
    const definition = getJobDefinition(slot.job_code);
    const nextStatus = Number(slot.attempt_count || 0) < (definition.maxAttempts || 3) ? 'pending' : 'failed';
    const retryDelays = Array.isArray(definition.retryDelaysMinutes) ? definition.retryDelaysMinutes : [5, 15, 45];
    const retryDelay = definition.retryPolicy === 'external'
      ? Number(retryDelays[Math.min(Math.max(Number(slot.attempt_count || 1) - 1, 0), retryDelays.length - 1)] || 15)
      : Number(retryDelays[Math.min(Math.max(Number(slot.attempt_count || 1) - 1, 0), retryDelays.length - 1)] || 5);
    await pool.query(
      `UPDATE ops.job_schedule_slots
          SET status=$2, next_attempt_at=CASE WHEN $2='pending' THEN now()+($3::integer * interval '1 minute') ELSE NULL END,
              lease_owner=NULL, lease_until=NULL, heartbeat_at=now(),
              last_error='执行租约已过期，系统已自动接管', updated_at=now()
        WHERE slot_id=$1 AND status='running'`,
      [slot.slot_id, nextStatus, retryDelay]
    );
    if (nextStatus === 'failed') {
      const { notifyJobFailure } = require('./jobAlertMailer');
      await notifyJobFailure({
        jobCode: slot.job_code,
        slotId: slot.slot_id,
        alertKey: `slot:${slot.slot_id}:lease-exhausted`,
        alertType: 'failure',
        subject: `后台任务租约失败：${slot.job_code}`,
        summary: `计划实例 ${slot.slot_id} 的租约已过期并达到最大尝试次数，请在后台检查后手工处理。`,
      }).catch(error => console.warn('[job-alert] 租约失败告警发送失败:', error.message));
    }
  }
  return rows.length;
}

async function listDueSlots(limit = 20) {
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const { rows } = await pool.query(
    `SELECT s.*, s.business_date::text AS business_date FROM ops.job_schedule_slots s
      WHERE (status='pending'
        OR (status IN ('failed','waiting_external') AND next_attempt_at IS NOT NULL AND next_attempt_at <= now()))
        AND scheduled_for <= now()
      ORDER BY scheduled_for ASC, slot_id ASC LIMIT $1`, [safeLimit]
  );
  const due = [];
  for (const slot of rows) {
    const definition = getJobDefinition(slot.job_code);
    if (Number(slot.attempt_count || 0) >= (definition.maxAttempts || 3)) continue;
    const dependencies = definition.dependencyCodes || [];
    if (dependencies.length) {
      const states = await taskDependencyStates(slot, dependencies);
      const dependencyFailed = dependencies.some(code => ['failed', 'degraded', 'blocked'].includes(states.get(code)));
      const dependencyPending = dependencies.some(code => !states.has(code) || ['pending', 'running', 'waiting_external'].includes(states.get(code)));
      if (dependencyFailed) {
        const blocked = await pool.query(
          `UPDATE ops.job_schedule_slots
              SET status='blocked', last_error=$2, next_attempt_at=NULL,
                  lease_owner=NULL, lease_until=NULL, heartbeat_at=now(), updated_at=now()
            WHERE slot_id=$1 AND status <> 'blocked'
            RETURNING *`,
          [slot.slot_id, `依赖任务未成功：${dependencies.map(code => `${code}=${states.get(code) || 'missing'}`).join(', ')}`]
        );
        if (blocked.rows[0]) {
          const { notifyJobFailure } = require('./jobAlertMailer');
          await notifyJobFailure({
            jobCode: slot.job_code,
            slotId: slot.slot_id,
            alertKey: `slot:${slot.slot_id}:blocked`,
            alertType: 'dependency_blocked',
            subject: `后台任务被依赖任务阻塞：${definition.label}`,
            summary: blocked.rows[0].last_error,
          }).catch(error => console.warn('[job-alert] 依赖阻塞告警失败:', error.message));
        }
        continue;
      }
      if (dependencyPending) continue;
      if (slot.status === 'blocked') {
        await pool.query(
          `UPDATE ops.job_schedule_slots
              SET status='pending', next_attempt_at=now(), last_error=NULL, updated_at=now()
            WHERE slot_id=$1 AND status='blocked'`, [slot.slot_id]
        );
        slot.status = 'pending';
      }
    }
    const datasets = await datasetDependencyState(slot, definition);
    if (!datasets.ready) {
      if (datasets.failed) {
        const blocked = await pool.query(
          `UPDATE ops.job_schedule_slots
              SET status='blocked', last_error=$2, next_attempt_at=NULL,
                  lease_owner=NULL, lease_until=NULL, heartbeat_at=now(), updated_at=now()
            WHERE slot_id=$1 AND status <> 'blocked'
            RETURNING *`,
          [slot.slot_id, `依赖数据分区未发布：${datasets.detail}`]
        );
        if (blocked.rows[0]) {
          const { notifyJobFailure } = require('./jobAlertMailer');
          await notifyJobFailure({
            jobCode: slot.job_code,
            slotId: slot.slot_id,
            alertKey: `slot:${slot.slot_id}:dataset-blocked`,
            alertType: 'dependency_blocked',
            subject: `后台任务数据依赖未发布：${definition.label}`,
            summary: `任务未执行，已保留上一份有效结果。${datasets.detail}`,
          }).catch(error => console.warn('[job-alert] 数据依赖阻断告警失败:', error.message));
        }
      }
      continue;
    }
    due.push(slot);
  }
  return due;
}

function normalizeDataAsOf(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function isDataAsOfFresh(dataAsOf, businessDate, definition = {}) {
  if (!dataAsOf || !businessDate) return false;
  const actual = new Date(dataAsOf).getTime();
  const expectedDate = expectedDataDate(definition.jobCode || '', businessDate);
  const expected = expectedDate ? new Date(`${expectedDate}T00:00:00Z`).getTime() : NaN;
  const maxLagDays = Math.max(Number(definition.freshnessMaxLagDays) || 0, 0);
  const earliestAccepted = expected - maxLagDays * 86400000;
  return Number.isFinite(actual) && Number.isFinite(expected) && actual >= earliestAccepted;
}

async function queryDataAsOf(jobCode, businessDate) {
  if (jobCode === 'holiday_sync') {
    const { loadHolidays } = require('../config/holidays');
    return normalizeDataAsOf(loadHolidays().updatedAt);
  }
  const queries = {
    // 手动回查可能晚于正式快照写入、但数据日期更旧；水位必须取所有快照中的最新数据日期。
    bond_safety_refresh: `SELECT MAX(COALESCE(source_updated_at, refreshed_at)) AS data_as_of FROM bond_safety_snapshots`,
    hk_rate: `SELECT max(rate_date)::text AS data_as_of FROM market.fx_rates WHERE base_currency='HKD' AND quote_currency='CNY'`,
    nav_snapshot: `SELECT max(date)::text AS data_as_of FROM nav_history`,
    index_baseline: `SELECT max(date)::text AS data_as_of FROM index_history`,
    index_recent: `SELECT max(date)::text AS data_as_of FROM index_history`,
    ipo_calendar_refresh: `SELECT max(to_date(report_date, 'YYYYMMDD'))::text AS data_as_of
      FROM ipo_reports WHERE report_date ~ '^\\d{8}$'`,
    ipo_history_sync: `SELECT max(last_success_date)::text AS data_as_of FROM ops.sync_cursors WHERE scope_key='global:ipo_history'`,
    stock_analysis_refresh: `SELECT max(as_of_date)::text AS data_as_of FROM analytics.stock_overview_latest`,
    hk_trade_rules_sync: `SELECT max(source_updated_at)::text AS data_as_of FROM market.instrument_trade_rules`,
    // 套利任务必须同时确认港交所和巨潮两个来源；取 max 会被单一来源的成功掩盖另一来源的落后。
    arbitrage_sync: `SELECT LEAST(
      COALESCE((SELECT max(last_success_date) FROM ops.sync_cursors WHERE scope_key='arbitrage_hkex' AND dataset_code='hkex_announcements'), '1900-01-01'::date),
      COALESCE((SELECT max(last_success_date) FROM ops.sync_cursors WHERE scope_key='arbitrage_cninfo' AND dataset_code='cninfo_announcements'), '1900-01-01'::date)
    )::text AS data_as_of`,
    convertible_bond_announcement_history_sync: `SELECT max(last_success_date)::text AS data_as_of
      FROM ops.sync_cursors WHERE scope_key='convertible_bond_announcement_history' AND dataset_code='official_announcements'`,
    convertible_bond_universe_refresh: `SELECT max(last_success_date)::text AS data_as_of
      FROM ops.sync_cursors WHERE scope_key='convertible_bond_universe' AND dataset_code='cb_basic_cb_daily'`,
    convertible_bond_valuation_refresh: `SELECT max(trade_date)::text AS data_as_of FROM analytics.convertible_bond_valuation_daily`,
    market_volatility_sync: `SELECT LEAST(
      COALESCE((SELECT max(trade_date) FROM market.market_valuation_daily WHERE market_code='CN' AND benchmark_code='CSI300' AND source_code='csindex'), '1900-01-01'::date),
      COALESCE((SELECT max(trade_date) FROM market.market_valuation_daily WHERE market_code='CN' AND benchmark_code='CSIALL' AND source_code='csindex'), '1900-01-01'::date),
      COALESCE((SELECT max(trade_date) FROM market.market_valuation_daily WHERE market_code='HK' AND benchmark_code='HSI' AND source_code='hsi_official'), '1900-01-01'::date),
      COALESCE((SELECT max(trade_date) FROM market.sovereign_yield_daily WHERE market_code='CN' AND tenor_years=10 AND source_code='chinabond'), '1900-01-01'::date),
      COALESCE((SELECT max(trade_date) FROM market.sovereign_yield_daily WHERE market_code='US' AND tenor_years=10 AND source_code='tushare_us_tycr'), '1900-01-01'::date),
      COALESCE((SELECT max(trade_date) FROM analytics.graham_index_daily WHERE market_code='CN' AND benchmark_code='CSI300'), '1900-01-01'::date),
      COALESCE((SELECT max(trade_date) FROM analytics.graham_index_daily WHERE market_code='CN' AND benchmark_code='CSIALL'), '1900-01-01'::date)
    )::text AS data_as_of`,
  };
  const marketClosePredicates = {
    'market_close:A股': `p.code ~ '^(00|30|60|68|4|8)' AND COALESCE(p.name,'') !~ '(债|转债)'`,
    'market_close:港股': `char_length(p.code)=5`,
    'market_close:可转债': `p.code ~ '^(11|12)'`,
    'market_close:LOF/ETF': `p.code ~ '^(15|16|50|51)' AND char_length(p.code)=6`,
  };
  const marketPredicate = marketClosePredicates[jobCode];
  const sql = queries[jobCode] || (marketPredicate
    ? `SELECT CASE WHEN COUNT(*)=0 OR COUNT(dp.code)=COUNT(*) THEN $1::text ELSE NULL END AS data_as_of
         FROM positions p
         LEFT JOIN daily_prices dp ON dp.username=p.username AND dp.account_name=p.account_name
              AND dp.code=p.code AND dp.date=$1
        WHERE ${marketPredicate}`
    : null);
  if (!sql) return null;
  const normalizedBusinessDate = normalizeBusinessDate(businessDate);
  const { rows } = await pool.query(sql, marketPredicate ? [normalizedBusinessDate] : []);
  if (!rows[0] || !rows[0].data_as_of) return null;
  const raw = String(rows[0].data_as_of).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00.000Z` : normalizeDataAsOf(rows[0].data_as_of);
}

async function resolveDataAsOf(jobCode, businessDate, resultSummary = {}) {
  const candidates = [
    resultSummary?.data_as_of,
    resultSummary?.dataAsOf,
    resultSummary?.window_end,
    resultSummary?.trade_date,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeDataAsOf(candidate);
    if (normalized) return normalized;
  }
  return queryDataAsOf(jobCode, businessDate).catch(() => null);
}

async function completeSlot(slotId, status, resultSummary, errorMessage, runId) {
  const allowed = ['succeeded', 'degraded', 'failed', 'blocked', 'skipped'];
  const requestedStatus = allowed.includes(status) ? status : 'failed';
  const current = await pool.query('SELECT job_code,business_date::text AS business_date FROM ops.job_schedule_slots WHERE slot_id=$1', [slotId]);
  if (!current.rows[0]) return null;
  const definition = getJobDefinition(current.rows[0].job_code);
  const skipWatermark = resultSummary && resultSummary.watermarkNotRequired === true;
  const requiresDataWatermark = definition.requiresDataWatermark !== false && !skipWatermark;
  const dataAsOf = requestedStatus === 'succeeded' && requiresDataWatermark
    ? await resolveDataAsOf(current.rows[0].job_code, current.rows[0].business_date, resultSummary)
    : null;
  const nextStatus = requestedStatus === 'succeeded' && requiresDataWatermark
    && !isDataAsOfFresh(dataAsOf, current.rows[0].business_date, definition) ? 'degraded' : requestedStatus;
  const finalError = nextStatus === 'degraded' && !errorMessage
    ? '任务完成但没有形成可确认的数据日期，请检查上游返回和入库结果'
    : errorMessage;
  const { rows } = await pool.query(
    `UPDATE ops.job_schedule_slots
        SET status=$2, last_run_id=COALESCE($5,last_run_id), data_as_of=CASE WHEN $2 IN ('succeeded','degraded') THEN COALESCE($6, data_as_of) ELSE data_as_of END,
            result_summary=$3::jsonb, last_error=$4, lease_owner=NULL, lease_until=NULL,
            heartbeat_at=now(), updated_at=now()
      WHERE slot_id=$1 AND status='running' RETURNING *`,
    [slotId, nextStatus, JSON.stringify(sanitizeJobResult(resultSummary || {})), finalError ? sanitizeJobError(finalError) : null, runId || null, dataAsOf]
  );
  const completed = rows[0] || null;
  if (completed && nextStatus === 'succeeded') {
    const { resolveJobSlotAlerts } = require('./jobAlertMailer');
    await resolveJobSlotAlerts(completed).catch(error => console.warn('[job-alert] 恢复告警处理失败:', error.message));
  }
  if (completed && nextStatus === 'degraded') {
    const { notifyJobFailure } = require('./jobAlertMailer');
    await notifyJobFailure({
      jobCode: current.rows[0].job_code,
      slotId,
      alertKey: `slot:${slotId}:degraded`,
      alertType: 'degraded',
      subject: `后台任务数据未确认：${getJobDefinition(current.rows[0].job_code).label}`,
      summary: completed.last_error || '任务执行成功，但产出数据日期早于计划日期。',
    }).catch(error => console.warn('[job-alert] 降级告警失败:', error.message));
  }
  return completed;
}

async function deferSlot(slotId, errorMessage, resultSummary, delayMinutes = 5, runId = null) {
  const { rows } = await pool.query(
    `UPDATE ops.job_schedule_slots
        SET status='failed', last_run_id=COALESCE($5,last_run_id), trigger_type='auto_retry',
            next_attempt_at=now()+($2 || ' minutes')::interval,
            result_summary=$3::jsonb, last_error=$4, lease_owner=NULL, lease_until=NULL,
            heartbeat_at=now(), updated_at=now()
      WHERE slot_id=$1 AND status='running' RETURNING *`,
    [slotId, String(Math.max(Number(delayMinutes) || 5, 1)), JSON.stringify(sanitizeJobResult(resultSummary || {})),
      errorMessage ? sanitizeJobError(errorMessage) : null, runId]
  );
  return rows[0] || null;
}

async function waitForExternalSlot(slotId, errorMessage, resultSummary, retryAt = null, runId = null) {
  const parsedRetryAt = retryAt ? new Date(retryAt) : null;
  const nextAttemptAt = parsedRetryAt && !Number.isNaN(parsedRetryAt.getTime()) && parsedRetryAt.getTime() > Date.now()
    ? parsedRetryAt : new Date(Date.now() + 60 * 1000);
  const safeSummary = sanitizeJobResult({
    ...(resultSummary || {}),
    waitingExternal: true,
    recoverAt: nextAttemptAt.toISOString(),
  });
  const { rows } = await pool.query(
    `UPDATE ops.job_schedule_slots
        SET status='waiting_external', last_run_id=COALESCE($4,last_run_id), trigger_type='auto_retry',
            next_attempt_at=$2, attempt_count=GREATEST(attempt_count-1,0),
            result_summary=$3::jsonb, last_error=$5, lease_owner=NULL, lease_until=NULL,
            heartbeat_at=now(), updated_at=now()
      WHERE slot_id=$1 AND status='running' RETURNING *`,
    [slotId, nextAttemptAt, JSON.stringify(safeSummary), runId,
      errorMessage ? sanitizeJobError(errorMessage) : null]
  );
  return rows[0] || null;
}

async function touchSlot(slotId, workerId = WORKER_ID) {
  const { rows } = await pool.query('SELECT job_code FROM ops.job_schedule_slots WHERE slot_id=$1', [slotId]);
  const timeoutMinutes = rows[0] ? Number(getJobDefinition(rows[0].job_code).timeoutMinutes || 30) : 30;
  await pool.query(
    `UPDATE ops.job_schedule_slots SET heartbeat_at=now(), lease_until=now()+($3::integer * interval '1 minute'), updated_at=now()
      WHERE slot_id=$1 AND lease_owner=$2`, [slotId, workerId, timeoutMinutes]
  );
}

async function retryJobSlot(slotId) {
  const { rows } = await pool.query(
    `UPDATE ops.job_schedule_slots
        SET status='pending', attempt_count=0, next_attempt_at=now(), trigger_type='manual_retry',
            lease_owner=NULL, lease_until=NULL, acknowledged_at=NULL, last_error=NULL,
            result_summary='{}'::jsonb, request_payload=request_payload - 'force', updated_at=now()
      WHERE slot_id=$1 AND status IN ('failed','degraded','blocked','skipped','waiting_external')
      RETURNING *`, [slotId]
  );
  return rows[0] || null;
}

async function acknowledgeSlot(slotId) {
  const { rows } = await pool.query(
    `UPDATE ops.job_schedule_slots SET acknowledged_at=now(), updated_at=now()
      WHERE slot_id=$1 RETURNING *`, [slotId]
  );
  return rows[0] ? {
    ...rows[0],
    last_error: rows[0].last_error ? sanitizeJobError(rows[0].last_error, 2000) : null,
    result_summary: sanitizeJobResult(rows[0].result_summary || {}),
  } : null;
}

async function listJobSlots(options = {}) {
  const businessDate = options.date && /^\d{4}-\d{2}-\d{2}$/.test(String(options.date)) ? String(options.date) : dateText();
  const limit = Math.min(Math.max(parseInt(options.limit, 10) || 100, 1), 300);
  const status = ['pending', 'running', 'succeeded', 'degraded', 'failed', 'blocked', 'skipped', 'waiting_external'].includes(options.status) ? options.status : null;
  const triggerType = String(options.trigger || '').trim() || null;
  const keyword = String(options.keyword || '').trim() || null;
  const category = String(options.category || '').trim() || null;
  const categoryCodes = category ? JOB_DEFINITIONS.filter(item => item.category === category).map(item => item.jobCode) : null;
  const keywordCodes = keyword
    ? JOB_DEFINITIONS.filter(item => item.jobCode.toLowerCase().includes(keyword.toLowerCase()) || item.label.includes(keyword)).map(item => item.jobCode)
    : null;
  const { rows } = await pool.query(
    `SELECT s.*, s.business_date::text AS business_date
       FROM ops.job_schedule_slots s
      WHERE s.business_date=$1::date AND ($2::text IS NULL OR s.status=$2)
        AND ($4::text IS NULL OR s.trigger_type=$4)
        AND ($5::text IS NULL OR s.job_code ILIKE '%' || $5 || '%' OR s.last_error ILIKE '%' || $5 || '%' OR s.job_code=ANY($7::text[]))
        AND ($6::text[] IS NULL OR s.job_code=ANY($6::text[]))
      ORDER BY s.scheduled_for DESC, s.slot_id DESC LIMIT $3`,
    [businessDate, status, limit, triggerType, keyword, categoryCodes, keywordCodes]
  );
  const labels = new Map(JOB_DEFINITIONS.map(item => [item.jobCode, item.label]));
  return rows.map(row => {
    const definition = getJobDefinition(row.job_code);
    const lateAt = new Date(row.scheduled_for).getTime() + Number(definition.deadlineMinutes || 180) * 60000;
    return { ...row,
      last_error: row.last_error ? sanitizeJobError(row.last_error) : null,
      result_summary: sanitizeJobResult(row.result_summary || {}),
      request_payload: sanitizeJobResult(row.request_payload || {}),
      label: labels.get(row.job_code) || row.job_code,
      category: definition.category, importance: definition.importance,
      dependency_codes: definition.dependencyCodes || [],
      deadline_at: new Date(lateAt).toISOString(), max_attempts: definition.maxAttempts,
      is_late: ['pending', 'running', 'failed', 'degraded'].includes(row.status) && lateAt < Date.now() };
  });
}

async function getJobSlot(slotId) {
  const { rows } = await pool.query('SELECT s.*, s.business_date::text AS business_date FROM ops.job_schedule_slots s WHERE slot_id=$1', [slotId]);
  if (!rows[0]) return null;
  const definition = getJobDefinition(rows[0].job_code);
  const [runs, dependencies, alerts, audits] = await Promise.all([
    pool.query('SELECT id,job,status,started_at,finished_at,detail,attempt_no,trigger_type,worker_id,heartbeat_at,error_code,error_type,external_call_count,external_sources,datasets FROM job_runs WHERE slot_id=$1 OR id=$2 ORDER BY id DESC LIMIT 20', [slotId, rows[0].last_run_id || 0]),
    pool.query(`SELECT DISTINCT ON (job_code) job_code,status,scheduled_for,data_as_of,last_error
                  FROM ops.job_schedule_slots
                 WHERE business_date=$1::date AND job_code=ANY($2::text[])
                   AND scheduled_for <= $3::timestamptz
                 ORDER BY job_code,scheduled_for DESC`,
      [rows[0].business_date, definition.dependencyCodes || [], rows[0].scheduled_for]),
    pool.query('SELECT alert_id,alert_key,alert_type,severity,status,subject,summary,send_attempts,last_sent_at,next_send_at,last_send_error FROM ops.alert_notifications WHERE slot_id=$1 ORDER BY alert_id DESC LIMIT 20', [slotId]),
    pool.query("SELECT id,actor,action,target,detail,result,request_id,metadata,created_at FROM admin_audit_log WHERE target=$1 OR metadata->>'slotId'=$1 ORDER BY id DESC LIMIT 20", [String(slotId)]),
  ]);
  const freshnessRequired = definition.requiresDataWatermark !== false;
  const freshnessValid = !freshnessRequired || (Boolean(rows[0].data_as_of) && isDataAsOfFresh(rows[0].data_as_of, rows[0].business_date, definition));
  return {
    ...rows[0],
    last_error: rows[0].last_error ? sanitizeJobError(rows[0].last_error) : null,
    result_summary: sanitizeJobResult(rows[0].result_summary || {}),
    request_payload: sanitizeJobResult(rows[0].request_payload || {}),
    definition,
    runs: runs.rows.map(run => ({ ...run, detail: sanitizeJobError(run.detail || '', 4000) })),
    business_execution: sanitizeJobResult(rows[0].result_summary || {}),
    freshness_validation: {
      required: freshnessRequired,
      status: !freshnessRequired ? 'not_required' : freshnessValid ? 'passed' : 'degraded',
      dataAsOf: rows[0].data_as_of || null,
      businessDate: rows[0].business_date,
    },
    dependencies: dependencies.rows.map(dep => ({ ...dep, last_error: dep.last_error ? sanitizeJobError(dep.last_error) : null })),
    alerts: alerts.rows.map(alert => ({
      ...alert,
      subject: sanitizeJobError(alert.subject || '', 500),
      summary: sanitizeJobError(alert.summary || '', 4000),
      last_send_error: alert.last_send_error ? sanitizeJobError(alert.last_send_error, 1000) : null,
    })),
    audits: audits.rows.map(audit => ({
      ...audit,
      detail: sanitizeJobError(audit.detail || '', 500),
      metadata: sanitizeJobResult(audit.metadata || {}),
    })),
  };
}

async function heartbeat(role = 'worker', status = 'running') {
  const workerId = workerIdForRole(role);
  // 兼容旧版本留下的“主机＋进程号＋随机值”记录：同一主机同一角色启动后，
  // 先把旧进程标记为 stopped，避免旧记录继续被误判为多个在线 Worker。
  await pool.query(
    `UPDATE ops.worker_heartbeats
        SET status='stopped', updated_at=now()
      WHERE role=$1 AND worker_id LIKE $2 AND worker_id<>$3 AND status<>'stopped'`,
    [role, `${HOSTNAME}:%`, workerId]
  );
  await pool.query(
    `INSERT INTO ops.worker_heartbeats(worker_id,role,pid,app_version,status,started_at,last_seen_at,updated_at)
     VALUES($1,$2,$3,$4,$5,now(),now(),now())
     ON CONFLICT(worker_id) DO UPDATE SET role=EXCLUDED.role,pid=EXCLUDED.pid,
       app_version=EXCLUDED.app_version,
       started_at=CASE WHEN ops.worker_heartbeats.pid IS DISTINCT FROM EXCLUDED.pid
                            OR ops.worker_heartbeats.status='stopped'
                       THEN EXCLUDED.started_at ELSE ops.worker_heartbeats.started_at END,
       status=EXCLUDED.status,last_seen_at=now(),updated_at=now()`,
    [workerId, role, String(process.pid), process.env.APP_VERSION || '', status]
  );
}

async function getJobOverview() {
  const today = dateText();
  const [counts, slots, alerts, workers] = await Promise.all([
    pool.query(`SELECT status, COUNT(*)::int AS count FROM ops.job_schedule_slots WHERE business_date=$1::date GROUP BY status`, [today]),
    pool.query(`SELECT job_code, status, scheduled_for, updated_at, last_error FROM ops.job_schedule_slots WHERE business_date=$1::date ORDER BY scheduled_for DESC`, [today]),
    pool.query(`SELECT status, COUNT(*)::int AS count FROM ops.alert_notifications WHERE ${ACTIVE_ALERT_WHERE} GROUP BY status`),
    pool.query(`WITH ranked AS (
          SELECT worker_id,role,pid,app_version,status,started_at,last_seen_at,
                 row_number() OVER (PARTITION BY role ORDER BY last_seen_at DESC) AS row_no
            FROM ops.worker_heartbeats
        )
        SELECT worker_id,role,pid,app_version,
          CASE WHEN last_seen_at < now()-interval '2 minutes' THEN 'stale' ELSE status END AS status,
          started_at,last_seen_at
          FROM ranked WHERE row_no=1 ORDER BY last_seen_at DESC`),
  ]);
  return {
    today,
    definitions: JOB_DEFINITIONS,
    counts: counts.rows,
    slots: slots.rows.map(slot => ({ ...slot, last_error: slot.last_error ? sanitizeJobError(slot.last_error) : null })),
    alerts: alerts.rows,
    workers: workers.rows,
    health: {
      durableScheduler: process.env.DURABLE_SCHEDULER !== '0',
      emailConfigured: Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.ALERT_EMAIL_TO),
      schedulerOnline: workers.rows.some(worker =>
        worker.status !== 'stale' && (worker.role === 'worker' || (worker.role === 'web' && process.env.DISABLE_SCHEDULER !== '1'))
      ),
    },
  };
}

async function validateJobSlot(slotId) {
  const { rows } = await pool.query('SELECT * FROM ops.job_schedule_slots WHERE slot_id=$1', [slotId]);
  if (!rows[0]) return null;
  const slot = rows[0];
  const definition = getJobDefinition(slot.job_code);
  if (getJobDefinition(slot.job_code).requiresDataWatermark === false) {
    if (slot.status === 'degraded') {
      const runResult = slot.last_run_id
        ? await pool.query('SELECT status FROM job_runs WHERE id=$1', [slot.last_run_id])
        : { rows: [] };
      const runSucceeded = runResult.rows[0] && runResult.rows[0].status === 'done';
      const summarySucceeded = slot.result_summary && slot.result_summary.ok === true;
      if (runSucceeded || summarySucceeded) {
        const recovered = await pool.query(
          `UPDATE ops.job_schedule_slots
              SET status='succeeded', last_error=NULL, data_as_of=NULL, updated_at=now()
            WHERE slot_id=$1
            RETURNING *`,
          [slotId]
        );
        const updated = recovered.rows[0] || { ...slot, status: 'succeeded', last_error: null, data_as_of: null };
        const { resolveJobSlotAlerts } = require('./jobAlertMailer');
        await resolveJobSlotAlerts(updated).catch(error => console.warn('[job-alert] 重新校验恢复告警处理失败:', error.message));
        return { valid: true, slotId: slot.slot_id, status: 'succeeded', dataAsOf: null, message: '任务执行结果正常' };
      }
    }
    return {
      valid: slot.status === 'succeeded', slotId: slot.slot_id, status: slot.status, dataAsOf: slot.data_as_of || null,
      message: slot.status === 'succeeded' ? '任务执行结果正常' : '该任务无需数据水位校验，请查看执行结果',
    };
  }
  const actualDataAsOf = await queryDataAsOf(slot.job_code, slot.business_date).catch(() => null);
  const freshness = isDataAsOfFresh(actualDataAsOf, slot.business_date, definition);
  const canValidate = ['succeeded', 'degraded'].includes(slot.status);
  const valid = canValidate && Boolean(actualDataAsOf) && freshness;
  let updated = slot;
  if (canValidate) {
    const result = await pool.query(
      `UPDATE ops.job_schedule_slots
          SET data_as_of=$2,
              status=CASE WHEN $3::boolean THEN 'succeeded' ELSE 'degraded' END,
              last_error=CASE WHEN $3::boolean THEN NULL ELSE '重新校验发现业务数据水位落后' END,
              updated_at=now()
        WHERE slot_id=$1
        RETURNING *`,
      [slotId, actualDataAsOf, Boolean(actualDataAsOf && freshness)]
    );
    updated = result.rows[0] || { ...slot, status: valid ? 'succeeded' : 'degraded', data_as_of: actualDataAsOf };
    if (valid && slot.status === 'degraded') {
      const { resolveJobSlotAlerts } = require('./jobAlertMailer');
      await resolveJobSlotAlerts(updated).catch(error => console.warn('[job-alert] 重新校验恢复告警处理失败:', error.message));
    }
  }
  return { valid, slotId: slot.slot_id, status: canValidate ? (valid ? 'succeeded' : 'degraded') : slot.status, dataAsOf: actualDataAsOf || null,
    message: valid ? '任务状态和数据时间均正常' : '任务尚未形成可确认的数据结果' };
}

module.exports = {
  WORKER_ID, workerIdForRole, JOB_DEFINITIONS, dateText, normalizeBusinessDate, shanghaiParts, ensureSlot, enqueueManualJob, syncScheduleSlots,
  claimSlot, completeSlot, deferSlot, waitForExternalSlot, touchSlot, recoverExpiredSlots, listDueSlots, retryJobSlot, acknowledgeSlot,
  listJobSlots, getJobSlot, validateJobSlot, heartbeat, getJobOverview, queryDataAsOf, isDataAsOfFresh, resolveDataAsOf, expectedDataDate,
  isSlotDayAllowed, isWeekday, previousDate,
};

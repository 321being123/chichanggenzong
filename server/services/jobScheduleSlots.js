const layerSql = require('../repositories/jobScheduleSlotsRepository');
const os = require('os');
const { pool } = require('../db/connection');
const { JOB_DEFINITIONS, getJobDefinition, getRegisteredJobDefinition, PARTITION_DATE_POLICIES, stageCompletionEvidence } = require('./jobDefinitions');
const { getMarketState, isCnTradingDate, prefetchMarketFacts, parseClock } = require('./marketState');
const { sanitizeJobError, sanitizeJobResult } = require('./jobErrorSanitizer');
const { ACTIVE_ALERT_WHERE } = require('./jobAlertMailer');
const { sameSlotRecoveryScope, slotWaitingState, businessDateText, slotVersionText } = require('./jobRecoveryEvidence');
const classifyCode = require('../../public/js/code-classify');
const { appVersion } = require('../../package.json');
const txControl = require('../repositories/transactionControl');
const jobScheduleSlotsRepository = require('../repositories/jobScheduleSlotsRepository');
const repository = require('../repositories/jobScheduleSlotsRepository.js');
const { taskDependencyStates } = jobScheduleSlotsRepository;

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
  return isCnTradingDate(dateTextValue);
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
  if (definition.calendarWeekdays) {
    const day = new Date(`${dateTextValue}T00:00:00Z`).getUTCDay();
    return day >= 1 && day <= 5;
  }
  if (definition.weekdays) return isWeekday(dateTextValue);
  return true;
}

function formatClock(minutes) {
  if (!Number.isFinite(minutes) || minutes < 0 || minutes >= 24 * 60) return null;
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

async function resolveScheduleForDate(definition, schedule, businessDate) {
  const policy = schedule.marketCalendarPolicy || definition.marketCalendarPolicy;
  if (!policy) return schedule;
  const hk = await getMarketState({ market: 'HK', businessDate, time: '00:00' });
  if (policy === 'hk-open') return hk.status === 'open' ? schedule : null;
  const cn = await getMarketState({ market: 'CN', businessDate, time: '00:00' });
  if (policy === 'hk-close') {
    if (hk.status !== 'open' || !hk.closeQuoteTime) return null;
    const minute = parseClock(hk.closeQuoteTime);
    return { ...schedule, hour: Math.floor(minute / 60), minute: minute % 60 };
  }
  if (policy === 'hk-rate') {
    if (hk.status === 'open' && hk.closeQuoteTime) {
      const minute = parseClock(hk.closeQuoteTime) + 5;
      return { ...schedule, hour: Math.floor(minute / 60), minute: minute % 60 };
    }
    if (hk.status === 'closed' && cn.status === 'open') return { ...schedule, hour: 16, minute: 15 };
    return null;
  }
  if (policy === 'nav-snapshot') {
    // 净值快照依赖当日回购利率（Tushare repo_daily 收盘清算后傍晚才发布，实测 16:40 为空、18:00 后可得），
    // 因此不再跟着收盘就绪时间走，统一安排到 18:30；休市日（两市都不开）仍不生成槽位。
    if (hk.status === 'open' || cn.status === 'open') return { ...schedule, hour: 18, minute: 30 };
    return null;
  }
  throw new Error(`未知市场日历调度策略：${policy}`);
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

function resolveDatasetPartitionDate(requirement = {}, slot = {}, definition = {}) {
  const businessDate = normalizeBusinessDate(slot.business_date);
  if (!businessDate) return null;
  const policy = String(requirement.partitionDatePolicy || 'business_date');
  if (!PARTITION_DATE_POLICIES.includes(policy)) {
    throw new Error(`不支持的 partitionDatePolicy：${policy}`);
  }
  if (policy === 'business_date') return businessDate;
  if (policy === 'expected_data_date') return expectedDataDate(definition.jobCode, businessDate);
  let cursor = previousDate(businessDate);
  while (!isWeekday(cursor)) cursor = previousDate(cursor);
  return cursor;
}

async function ensureSlot(jobCode, scheduledFor, businessDate, triggerType = 'scheduled', requestPayload = {}) {
  if (!getRegisteredJobDefinition(jobCode)) {
    throw new Error(`未知任务 jobCode，禁止创建执行槽位：${jobCode}`);
  }
  const { rows } = await repository.insert_ops_job_schedule_slots([jobCode, scheduledFor, businessDate, triggerType, JSON.stringify(requestPayload || {})]);
  return rows[0] || null;
}

/* taskDependencyStates 已迁入 server/repositories/jobScheduleSlotsRepository.js */

async function datasetDependencyState(slot, definition) {
  const requirements = definition.datasetDependencies || [];
  if (!requirements.length) return { ready: true, failed: false, detail: '' };
  if (!getRegisteredJobDefinition(definition.jobCode)) {
    return { ready: false, failed: true, detail: 'unknown_job_definition', scopeKeys: [] };
  }
  const failures = [];
  const scopeKeys = [];
  for (const requirement of requirements) {
    // node-postgres 对 date 字段默认返回 Date；直接 String(Date).slice(0, 10)
    // 会得到“Wed Sep 02”，再传给 PostgreSQL::date 就会导致整个调度轮次失败。
    let partitionKey;
    try {
      partitionKey = resolveDatasetPartitionDate(requirement, slot, definition);
    } catch (error) {
      failures.push(`${requirement.datasetCode || 'unknown'}@invalid-partition-date-policy`);
      scopeKeys.push(`${requirement.datasetCode || 'unknown'}:${requirement.scopeKey || ''}:invalid`);
      continue;
    }
    if (!partitionKey) {
      failures.push(`${requirement.datasetCode}@invalid-business-date`);
      continue;
    }
    const { rows } = await repository.select_ops_dataset_partitions([requirement.datasetCode, requirement.scopeKey || '', partitionKey]);
    const partition = rows[0];
    if (!partition) {
      failures.push(`${requirement.datasetCode}@${partitionKey}=missing`);
      scopeKeys.push(`${requirement.datasetCode}:${requirement.scopeKey || ''}:${partitionKey}`);
      continue;
    }
    const qualityStatus = partition.diagnostics && partition.diagnostics.quality_status;
    if (partition.status !== 'published' || partition.is_stale
        || (requirement.requireQualityStatus && qualityStatus !== requirement.requireQualityStatus)) {
      failures.push(`${requirement.datasetCode}@${partitionKey}=${partition.status}/${qualityStatus || 'unknown'}`);
      scopeKeys.push(`${requirement.datasetCode}:${requirement.scopeKey || ''}:${partitionKey}`);
    }
  }
  return {
    ready: failures.length === 0,
    failed: failures.length > 0,
    detail: failures.join(', '),
    scopeKeys,
  };
}

async function enqueueManualJob(jobCode, requestPayload = {}, transactionClient = null) {
  const definition = JOB_DEFINITIONS.find(item => item.jobCode === jobCode);
  if (!definition) return null;
  if (definition.disabled) throw new Error(definition.disabledReason);
  const safePayload = sanitizeJobResult(requestPayload || {});
  const client = transactionClient || await pool.connect();
  try {
    if(!transactionClient) await txControl.begin(client);
    await repository.select_data([jobCode, JSON.stringify(safePayload)], client);
    const active = await repository.select_ops_job_schedule_slots([jobCode, Number(definition.maxAttempts || 3), JSON.stringify(safePayload)], client);
    if (active.rows[0]) {
      if(!transactionClient) await txControl.commit(client);
      return active.rows[0];
    }
    const scheduledFor = new Date();
    const { rows } = await repository.insert_ops_job_schedule_slots_1([jobCode, scheduledFor, dateText(scheduledFor), JSON.stringify(safePayload)], client);
    if(!transactionClient) await txControl.commit(client);
    return rows[0] || null;
  } catch (error) {
    if(!transactionClient) await txControl.rollback(client).catch(() => {});
    throw error;
  } finally {
    if(!transactionClient) client.release();
  }
}

// 接管旧槽只接受“同一件事的后续完整成功”：同任务、同业务日、同阶段，且账户/市场、
// 日期区间、证券和字段范围一致的候选，逐个核验运行、阶段完整性和分区发布质量。
const TAKEOVER_STATUSES = ['pending', 'failed', 'waiting_external', 'blocked', 'degraded'];
const TAKEOVER_PAGE_SIZE = 20;

// pending 只有在已到期、没有有效等待、也不是人工刚重置时，才可能是漏跑的旧槽。
function pendingNeedsTakeoverCheck(slot, now) {
  if (slot.trigger_type === 'manual_retry') return false;
  if (slot.result_summary && slot.result_summary.dependencyRecovery) return false;
  if (slotWaitingState(slot, now).waiting) return false;
  const nextAttemptAt = slot.next_attempt_at ? new Date(slot.next_attempt_at) : null;
  return !(nextAttemptAt && nextAttemptAt.getTime() > new Date(now).getTime());
}

async function findStrictRecoverySlot(slot) {
  const { verifySlotRecoveryEvidence, recoveryScopeFilter, sameSlotRecoveryScope } = require('./jobRecoveryEvidence');
  // 完整范围条件全部进 WHERE：候选集合在 SQL 就已经是同任务/同日/同阶段/同账户区间证券字段，
  // 分页只用来跳过“范围匹配但证据还不满足”的候选，因此不再有固定页数上限。
  const scope = recoveryScopeFilter(slot, 5);
  const limitIndex = scope.nextIndex;
  const offsetIndex = limitIndex + 1;
  for (let offset = 0; ; offset += TAKEOVER_PAGE_SIZE) {
    const { rows } = await jobScheduleSlotsRepository.selectStrictRecoveryCandidates({
      slot, limit: TAKEOVER_PAGE_SIZE, offset,
    });
    for (const candidate of rows) {
      // SQL 用双向包含表达集合相等，这里再按同一规则复核一次，防止表达差异放宽范围。
      if (!sameSlotRecoveryScope(slot, candidate)) continue;
      const evidence = await verifySlotRecoveryEvidence(candidate, undefined, { candidateStatus: candidate.status })
        .catch(error => ({ recovered: false, reason: `recovery_evidence_query_failed`, error: error && error.message }));
      if (evidence.recovered) return { candidate, evidence };
    }
    if (rows.length < TAKEOVER_PAGE_SIZE) break;
  }
  return null;
}

// 接管写入必须在一条语句里同时核对状态、版本和触发方式：先 SELECT 再 UPDATE 会留出
// “人工刚重置（仍为 pending）”被扫描覆盖的窗口。
async function supersedeStaleSlot(slot, recovery, reason) {
  const version = slotVersionText(slot);
  // 版本只接受数据库精确时间（微秒级）：JS Date 只剩毫秒，用 ±1 毫秒容差会把 0.5 毫秒后
  // 写入的新一次续批当成同一版本，从而覆盖新的执行意图。拿不到精确版本就不写。
  if (!version) {
    console.warn(`[job-slot] 接管跳过 slot=${slot.slot_id}：缺少数据库精确版本，无法安全核对`);
    return null;
  }
  const { rows } = await repository.update_ops_job_schedule_slots([slot.slot_id, reason, slot.status, version, slot.trigger_type || null]);
  const superseded = rows[0] || null;
  if (!superseded) return null;
  superseded.superseded_by = recovery && recovery.candidate ? recovery.candidate.slot_id : null;
  const { resolveJobSlotAlerts } = require('./jobAlertMailer');
  await resolveJobSlotAlerts(superseded).catch(error => console.warn('[job-alert] 后续成功实例收敛旧告警失败:', error.message));
  return superseded;
}

// 续批止损：只有“原因已登记 + 有未来复查时间 + 证据字段齐备 + 未超过最长等待”的有效等待才豁免；
// 任意未登记原因、过期或无证据的等待都必须按续批上限止损，不能靠未来的 next_attempt_at 永久 pending。
async function expireContinuationSlot(slot, definition, now) {
  const summary = slot.result_summary || {};
  const waiting = slotWaitingState(slot, now);
  if (waiting.exempt) return null;
  const startedAt = Date.parse(summary.continuationStartedAt || '');
  if (!Number.isFinite(startedAt)) return null;
  const maxAgeHours = Math.max(Number(summary.continuationMaxAgeHours || definition.continuationMaxAgeHours || 24), 1);
  // 已登记原因但超过该原因的最长等待时限时，按原因时限判定，不再无限延长。
  const policy = require('./jobRecoveryEvidence').waitReasonPolicy(summary.waitReason, slot.job_code);
  const reasonExpired = Boolean(policy) && Number(policy.maxWaitHours || 0) > 0
    && new Date(now).getTime() - startedAt >= Number(policy.maxWaitHours) * 3600000;
  if (!reasonExpired && new Date(now).getTime() - startedAt < maxAgeHours * 3600000) return null;
  const cause = reasonExpired
    ? `等待原因 ${policy.key} 已超过 ${policy.maxWaitHours} 小时有效期限`
    : `续批已超过 ${maxAgeHours} 小时仍未清空剩余工作`;
  const message = `${cause}，已停止自动续批并等待人工处理`;
  const version = slotVersionText(slot);
  if (!version) {
    console.warn(`[job-slot] 续批止损跳过 slot=${slot.slot_id}：缺少数据库精确版本，无法安全核对`);
    return null;
  }
  const { rows } = await repository.update_ops_job_schedule_slots_1([slot.slot_id, message, version]);
  if (!rows[0]) return null;
  const { notifyJobFailure } = require('./jobAlertMailer');
  await notifyJobFailure({
    jobCode: slot.job_code,
    slotId: slot.slot_id,
    alertKey: `slot:${slot.slot_id}:continuation-expired`,
    alertType: 'failure',
    subject: `后台任务续批止损：${definition.label}`,
    summary: `${message}。等待原因：${summary.waitReason || '未登记'}，剩余阶段：${(summary.pendingStages || []).join('/') || '-'}，剩余数量：${summary.remaining ?? '-'}`,
  }).catch(error => console.warn('[job-alert] 续批止损告警失败:', error.message));
  return rows[0];
}

async function reconcileSlot(slot) {
  if (!slot || new Date(slot.scheduled_for) > new Date()) return slot;
  const definition = getJobDefinition(slot.job_code);
  if (definition.disabled) return slot;
  // succeeded 和 skipped 都是终态：succeeded 是执行终态，skipped 是归档终态。
  // 二者都不能再被旧 job_runs 反推成 failed，否则已接管/已归档的槽会反复收敛、反复失败。
  if (slot.status === 'succeeded' || slot.status === 'skipped') return slot;
  // 人工补跑刚重置为 pending 时，旧的失败 job_runs 仍然存在；此时不能被旧记录立即回滚为 failed，
  // 必须先让统一执行器领取并生成新的 manual_retry 运行记录。
  if (slot.status === 'pending' && slot.trigger_type === 'manual_retry') return slot;
  if (slot.status === 'pending' && slot.result_summary?.dependencyRecovery) return slot;
  const now = new Date();
  const waiting = slotWaitingState(slot, now);
  // 同一业务日、同一阶段、同一范围如果已有更晚实例完成并通过严格证据，旧实例已被接管。
  // 等待外部来源的槽也参与这里的纯证据核对；但未到复查时间、人工刚重置、部分完成和无证据
  // 的槽都不满足接管条件，不会被误跳过。
  if (TAKEOVER_STATUSES.includes(slot.status)
      && (slot.status !== 'pending' || pendingNeedsTakeoverCheck(slot, now))) {
    const recovery = await findStrictRecoverySlot(slot)
      .catch(error => { console.warn('[job-slot] 接管证据核对失败:', error.message); return null; });
    if (recovery) {
      const superseded = await supersedeStaleSlot(slot, recovery,
        '同业务日同范围的后续实例已完成并通过运行、阶段和分区证据核验，本实例不再执行');
      if (superseded) return superseded;
    }
  }
  // 外部来源等待期间保留等待状态，不能被旧的失败运行记录在调度扫描时覆盖；
  // 到达 next_attempt_at 后由统一执行器重新领取并继续执行。
  if (slot.status === 'waiting_external') return slot;
  // 续批止损：有效等待（原因已登记且未超时限）在 expireContinuationSlot 内部豁免，
  // 这里不再用“有没有 waitReason 字符串”做开关，避免任意原因长期免于止损。
  if (slot.status === 'pending' && waiting.continuationRequired) {
    const expired = await expireContinuationSlot(slot, definition, now).catch(error => {
      console.warn('[job-slot] 续批止损判定失败:', error.message); return null;
    });
    if (expired) return expired;
  }
  // degraded 只做数据库水位重验，绝不重新调用业务 Runner 或外部接口。
  if (['failed', 'waiting_external'].includes(slot.status)
      && definition.reconcileByWatermark === true) {
    const actualDataAsOf = await queryDataAsOf(slot.job_code, slot.business_date).catch(() => null);
    if (isDataAsOfFresh(actualDataAsOf, slot.business_date, definition)) {
      const { verifySlotRecoveryEvidence } = require('./jobRecoveryEvidence');
      const evidence = await verifySlotRecoveryEvidence(
        { ...slot, status: 'succeeded', data_as_of: actualDataAsOf },
        (sql, params) => jobScheduleSlotsRepository.runQuery(sql, params)
      );
      if (!evidence.recovered) return slot;
      const { rows: recoveredRows } = await repository.update_ops_job_schedule_slots_2([slot.slot_id, actualDataAsOf]);
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
      const { verifySlotRecoveryEvidence } = require('./jobRecoveryEvidence');
      const evidence = await verifySlotRecoveryEvidence(slot, (sql, params) => jobScheduleSlotsRepository.runQuery(sql, params), { candidateStatus: 'succeeded' });
      if (!evidence.recovered) return slot;
      const { rows: recoveredRows } = await repository.update_ops_job_schedule_slots_3([slot.slot_id, actualDataAsOf]);
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
        const { rows: releasedRows } = await repository.update_ops_job_schedule_slots_4([slot.slot_id]);
        return releasedRows[0] || slot;
      }
    }
    return slot;
  }
  if (slot.status === 'failed' && slot.result_summary && slot.result_summary.timed_out) return slot;
  const { rows } = await repository.select_job_runs([slot.slot_id]);
  let run = rows[0];
  if (!run) {
    const legacy = await repository.select_job_runs_1([slot.job_code, slot.scheduled_for, Number(getJobDefinition(slot.job_code).deadlineMinutes || 180)]);
    run = legacy.rows[0];
  }
  if (!run || !['done', 'failed'].includes(run.status)) return slot;
  const requestedStatus = run.status === 'done' ? 'succeeded' : 'failed';
  const requiresDataWatermark = definition.requiresDataWatermark !== false;
  const runResult = run.result_json && typeof run.result_json === 'object' ? run.result_json : {};
  // 正常续批的本批运行记录虽然是 done，但槽位已经回到 pending；不能被恢复扫描误收敛为 succeeded。
  if (run.status === 'done' && (runResult.continuationRequired === true || runResult.ok === false)) return slot;
  const skipWatermark = runResult.watermarkNotRequired === true || stageCompletionEvidence(definition, runResult, slot.request_payload || {});
  const dataAsOf = requestedStatus === 'succeeded' && requiresDataWatermark && !skipWatermark
    ? await queryDataAsOf(slot.job_code, slot.business_date).catch(() => null)
    : null;
  const nextStatus = requestedStatus === 'succeeded' && requiresDataWatermark && !skipWatermark
    && !isDataAsOfFresh(dataAsOf, slot.business_date, definition) ? 'degraded' : requestedStatus;
  const resultSummary = { ...runResult, source: 'job_runs', runId: run.id, detail: sanitizeJobError(run.detail || '') };
  if (nextStatus === 'succeeded') {
    const { verifySlotRecoveryEvidence } = require('./jobRecoveryEvidence');
    const evidence = await verifySlotRecoveryEvidence(
      { ...slot, status: 'succeeded', data_as_of: dataAsOf || slot.data_as_of, result_summary: resultSummary },
      (sql, params) => jobScheduleSlotsRepository.runQuery(sql, params)
    );
    if (!evidence.recovered) return slot;
  }
  const version = slotVersionText(slot);
  if (!version) {
    console.warn(`[job-slot] 恢复写入跳过 slot=${slot.slot_id}：缺少数据库精确版本，无法安全核对`);
    return slot;
  }
  const updated = await repository.update_ops_job_schedule_slots_5([slot.slot_id, nextStatus, run.id, dataAsOf,
      nextStatus === 'failed' ? sanitizeJobError(run.detail || '') : nextStatus === 'degraded' ? '运行记录成功但未形成可确认的数据日期' : null,
      JSON.stringify(resultSummary), version]);
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
  await prefetchMarketFacts('HK', allDates);
  const created = [];
  for (const definition of JOB_DEFINITIONS) {
    if (definition.manualOnly || definition.disabled) continue;
    const schedules = [
      { hour: definition.hour, minute: definition.minute, mode: definition.mode || 'core' },
      ...(definition.additionalSchedules || []),
    ];
    for (const schedule of schedules) {
      const scheduleDefinition = { ...definition, ...schedule };
      const candidateDates = allDates.filter(date =>
        isSlotDayAllowed(date, scheduleDefinition) && (!scheduleDefinition.monthly || date.slice(8, 10) === '01'));
      const dates = definition.catchupMode === 'latest_only' ? candidateDates.slice(0, 1) : allDates;
      for (const businessDate of dates) {
        if (scheduleDefinition.monthly && businessDate.slice(8, 10) !== '01') continue;
        if (!isSlotDayAllowed(businessDate, scheduleDefinition)) continue;
        const resolvedSchedule = await resolveScheduleForDate(definition, scheduleDefinition, businessDate);
        if (!resolvedSchedule) continue;
        const scheduledFor = scheduledDate(businessDate, resolvedSchedule.hour, resolvedSchedule.minute);
        const windowMinutes = definition.catchupWindowMinutes || definition.deadlineMinutes || 180;
        if (businessDate !== today && scheduledFor.getTime() + windowMinutes * 60000 < now.getTime()) continue;
        const requestPayload = { mode: resolvedSchedule.mode || 'core' };
        if (Object.prototype.hasOwnProperty.call(resolvedSchedule, 'freshnessGate')) requestPayload.freshnessGate = Boolean(resolvedSchedule.freshnessGate);
        const slot = await ensureSlot(definition.jobCode, scheduledFor, businessDate, 'scheduled', requestPayload);
        const current = await reconcileSlot(slot);
        // 漏跑只看“已过计划期限且没有有效等待”。官方待披露、字段复查冷却和正常续批
        // 都有 next_attempt_at 和阶段证据，属于等待而不是故障，不能按计划时间误报。
        const waitingState = slotWaitingState(current, now);
        if (current.status === 'pending' && !waitingState.waiting
            && now.getTime() > scheduledFor.getTime() + definition.deadlineMinutes * 60000) {
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
  const lookup = await repository.select_ops_job_schedule_slots_1([slotId]);
  if (!lookup.rows[0]) return null;
  const definition = getJobDefinition(lookup.rows[0].job_code);
  if (definition.disabled) return null;
  const dependencies = definition.dependencyCodes || [];
  if (dependencies.length) {
    const states = await taskDependencyStates(lookup.rows[0], dependencies);
    if (dependencies.some(code => ['failed', 'degraded', 'blocked'].includes(states.get(code)))) {
      await repository.update_ops_job_schedule_slots_6([slotId, `依赖任务未成功：${dependencies.map(code => `${code}=${states.get(code) || 'missing'}`).join(', ')}`]);
      return null;
    }
    if (dependencies.some(code => !states.has(code) || ['pending', 'running', 'waiting_external'].includes(states.get(code)))) return null;
  }
  const datasets = await datasetDependencyState(lookup.rows[0], definition);
  if (!datasets.ready) {
    if (datasets.failed) {
      await repository.update_ops_job_schedule_slots_6([slotId, `依赖数据分区未发布：${datasets.detail}`]);
    }
    return null;
  }
  // 执行令牌（2026-10-25）：每次领取生成唯一令牌，接管时必然更换。
  // 旧执行后续的续租/状态写入/收件进度必须因令牌不匹配而影响 0 行，不能写回新执行。
  const executionToken = require('crypto').randomUUID();
  const { rows } = await repository.update_ops_job_schedule_slots_7([slotId, workerId, triggerType, definition.maxAttempts || 3, definition.timeoutMinutes || 30, executionToken]);
  return rows[0] || null;
}

async function recoverExpiredSlots() {
  await repository.update_job_runs();
  const { rows } = await repository.select_ops_job_schedule_slots_2();
  for (const slot of rows) {
    const definition = getJobDefinition(slot.job_code);
    const nextStatus = Number(slot.attempt_count || 0) < (definition.maxAttempts || 3) ? 'pending' : 'failed';
    const retryDelays = Array.isArray(definition.retryDelaysMinutes) ? definition.retryDelaysMinutes : [5, 15, 45];
    const retryDelay = definition.retryPolicy === 'external'
      ? Number(retryDelays[Math.min(Math.max(Number(slot.attempt_count || 1) - 1, 0), retryDelays.length - 1)] || 15)
      : Number(retryDelays[Math.min(Math.max(Number(slot.attempt_count || 1) - 1, 0), retryDelays.length - 1)] || 5);
    await repository.update_ops_job_schedule_slots_8([slot.slot_id, nextStatus, retryDelay]);
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

function attemptLimit(slot,definition){
  return (definition.maxAttempts||3)+(slot.job_code==='nav_snapshot'&&slot.result_summary?.dependencyRecovery?1:0);
}

async function recoverNavDependencies(query=(sql,params)=>jobScheduleSlotsRepository.runQuery(sql,params)){
  const {rows}=await layerSql.recoverNavDependenciesLayerQuery1(query, []);
  for(const slot of rows){
    const summary=slot.result_summary||{};
    if((slot.request_payload?.mode||'core')!=='core'||summary.continuationStopReason||summary.continuationBlocked)continue;
    if(!require('../jobs/navSnapshot').isCashIncomeDependencyWait(summary.failedAccounts||[],summary.repoRates))continue;
    const date=businessDateText(slot.business_date),evidence=[];
    let ready=true;
    for(const account of summary.failedAccounts){
      for(const diagnostic of account.diagnostics){
        if(diagnostic.date&&diagnostic.date!==date){ready=false;break;}
        for(const pending of diagnostic.pending){
          if(pending.date&&pending.date!==date){ready=false;break;}
          let result;
          if(pending.reason==='missing_repo_daily_rate'){
            result=await layerSql.recoverNavDependenciesLayerQuery2(query, [], [date]);
          }else{
            result=await layerSql.recoverNavDependenciesLayerQuery3(query, [], [pending.code,date,require('./cashDividendFacts').PARSER]);
          }
          if(result.rows.length!==1){ready=false;break;}
          evidence.push({reason:pending.reason,code:pending.code,...result.rows[0]});
        }
      }
    }
    if(!ready||!evidence.some(e=>new Date(e.evidence_at)>new Date(slot.updated_at)))continue;
    await query(`UPDATE ops.job_schedule_slots SET status='pending',next_attempt_at=now(),trigger_type='auto_retry',
      result_summary=result_summary||jsonb_build_object('dependencyRecovery',$2::jsonb),updated_at=now()
      WHERE slot_id=$1 AND status='blocked' AND acknowledged_at IS NULL AND NOT(result_summary ? 'dependencyRecovery')`,
      [slot.slot_id,JSON.stringify({evidence,businessDate:date,previousAttempts:slot.attempt_count})]);
  }
}

// 存量旧槽核对入口：syncScheduleSlots 只覆盖本次候选日期和补偿窗口，过期记录会永远
// 留在 pending/failed/waiting_external 里。这里在 Worker 周期内按 slot_id 轮转分页，
// 保证超过一页也能最终遍历，且只做数据库证据核对，不触发外部采集或重跑任务。
const SWEEP_MIN_AGE_MINUTES = 60;
const SWEEP_PAGE_SIZE_MAX = 50;
let sweepCursor = 0;

async function sweepStaleSlots(limit = 20) {
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), SWEEP_PAGE_SIZE_MAX);
  const rows = await jobScheduleSlotsRepository.listStaleSlots(sweepCursor, SWEEP_MIN_AGE_MINUTES, safeLimit);
  if (!rows.length) {
    const wrapped = sweepCursor > 0;
    sweepCursor = 0;
    return { ok: true, scanned: 0, changed: 0, changes: [], cursorReset: wrapped };
  }
  const changes = [];
  for (const slot of rows) {
    sweepCursor = Number(slot.slot_id);
    const after = await reconcileSlot(slot).catch(error => {
      console.warn(`[job-slot] 旧槽核对失败 slot=${slot.slot_id}:`, error.message);
      return slot;
    });
    if (after && after.status !== slot.status) {
      changes.push({ slotId: Number(slot.slot_id), jobCode: slot.job_code, from: slot.status, to: after.status });
    }
  }
  return { ok: true, scanned: rows.length, changed: changes.length, changes, cursor: sweepCursor };
}

async function listDueSlots(limit = 20) {
  await recoverNavDependencies();
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const retryPolicies = JOB_DEFINITIONS.filter(definition => !definition.disabled).map(definition => ({
    job_code: definition.jobCode, max_attempts: definition.maxAttempts || 3,
  }));
  const { rows } = await repository.select_ops_job_schedule_slots_3([safeLimit, JSON.stringify(retryPolicies)]);
  const due = [];
  for (const slot of rows) {
    const definition = getJobDefinition(slot.job_code);
    if (Number(slot.attempt_count || 0) >= attemptLimit(slot,definition)) continue;
    const dependencies = definition.dependencyCodes || [];
    if (dependencies.length) {
      const states = await taskDependencyStates(slot, dependencies);
      const dependencyFailed = dependencies.some(code => ['failed', 'degraded', 'blocked'].includes(states.get(code)));
      const dependencyPending = dependencies.some(code => !states.has(code) || ['pending', 'running', 'waiting_external'].includes(states.get(code)));
      if (dependencyFailed) {
        const blocked = await repository.update_ops_job_schedule_slots_9([slot.slot_id, `依赖任务未成功：${dependencies.map(code => `${code}=${states.get(code) || 'missing'}`).join(', ')}`]);
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
        await repository.update_ops_job_schedule_slots_10([slot.slot_id]);
        slot.status = 'pending';
      }
    }
    const datasets = await datasetDependencyState(slot, definition);
    if (!datasets.ready) {
      if (datasets.failed) {
        const blocked = await repository.update_ops_job_schedule_slots_9([slot.slot_id, `依赖数据分区未发布：${datasets.detail}`]);
        if (blocked.rows[0]) {
          const { notifyJobFailure } = require('./jobAlertMailer');
          await notifyJobFailure({
            jobCode: slot.job_code,
            slotId: slot.slot_id,
            ...(datasets.scopeKeys && datasets.scopeKeys[0] ? { scopeType: 'dataset', scopeKey: datasets.scopeKeys[0] } : {}),
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

function isDataAsOfFresh(dataAsOf, businessDate, definition = {}, now = new Date()) {
  if (!dataAsOf || !businessDate) return false;
  const actual = new Date(dataAsOf).getTime();
  if (!Number.isFinite(actual)) return false;
  if (definition.freshnessMode === 'max_age') {
    const reference = new Date(now).getTime();
    const maxAgeMinutes = Math.max(Number(definition.freshnessMaxAgeMinutes) || 0, 0);
    if (!Number.isFinite(reference) || maxAgeMinutes <= 0) return false;
    const age = reference - actual;
    return age >= 0 && age < maxAgeMinutes * 60000;
  }
  const expectedDate = expectedDataDate(definition.jobCode || '', businessDate);
  const expected = expectedDate ? new Date(`${expectedDate}T00:00:00Z`).getTime() : NaN;
  const maxLagDays = Math.max(Number(definition.freshnessMaxLagDays) || 0, 0);
  const earliestAccepted = expected - maxLagDays * 86400000;
  return Number.isFinite(expected) && actual >= earliestAccepted;
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
      COALESCE((SELECT max(trade_date) FROM market.market_valuation_daily WHERE market_code='CN' AND benchmark_code='CSI300' AND source_code='csindex'), '1900-01-01'::date),
      COALESCE((SELECT max(trade_date) FROM market.market_valuation_daily WHERE market_code='CN' AND benchmark_code='CSIALL' AND source_code='csindex'), '1900-01-01'::date),
      COALESCE((SELECT max(trade_date) FROM market.market_valuation_daily WHERE market_code='HK' AND benchmark_code='HSI' AND source_code='hsi_official'), '1900-01-01'::date),
      COALESCE((SELECT max(trade_date) FROM market.sovereign_yield_daily WHERE market_code='CN' AND tenor_years=10 AND source_code='chinabond'), '1900-01-01'::date),
      COALESCE((SELECT max(trade_date) FROM market.sovereign_yield_daily WHERE market_code='US' AND tenor_years=10 AND source_code='tushare_us_tycr'), '1900-01-01'::date),
      COALESCE((SELECT max(trade_date) FROM analytics.graham_index_daily WHERE market_code='CN' AND benchmark_code='CSI300'), '1900-01-01'::date),
      COALESCE((SELECT max(trade_date) FROM analytics.graham_index_daily WHERE market_code='CN' AND benchmark_code='CSIALL'), '1900-01-01'::date),
      COALESCE((SELECT max(month) FROM market.money_supply_monthly WHERE market_code='CN'), '1900-01-01'::date),
      COALESCE((SELECT max(trade_date) FROM market.a_share_market_cap_daily WHERE source_code='tushare_daily_basic'), '1900-01-01'::date)
    )::text AS data_as_of`,
  };
  const marketClosePredicates = {
    'market_close:A股': `p.code ~ '^(00|30|60|68|4|8)' AND char_length(p.code)>=6 AND COALESCE(p.subtype,'') <> '港股' AND COALESCE(p.name,'') !~ '(债|转债)'`,
    'market_close:港股': `(p.subtype='港股' OR char_length(p.code)=5)`,
    'market_close:可转债': `p.code ~ '^(11|12)'`,
    'market_close:LOF/ETF': `p.code ~ '${classifyCode.FUND_ETF_SQL_PREFIX}' AND char_length(p.code)=6`,
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
  const { rows } = await jobScheduleSlotsRepository.selectDataAsOfDate(sql, marketPredicate ? [normalizedBusinessDate] : []);
  if (!rows[0] || !rows[0].data_as_of) return null;
  if (jobCode === 'hk_rate') return normalizeDataAsOf(rows[0].data_as_of);
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

async function completeSlot(slotId, status, resultSummary, errorMessage, runId, expectedToken) {
  const allowed = ['succeeded', 'degraded', 'failed', 'blocked', 'skipped'];
  const requestedStatus = allowed.includes(status) ? status : 'failed';
  const current = await repository.select_ops_job_schedule_slots_4([slotId]);
  if (!current.rows[0]) return null;
  const definition = getJobDefinition(current.rows[0].job_code);
  resultSummary = await mergeSlotExternalCallSummary(slotId, resultSummary || {}, expectedToken);
  const request = current.rows[0].request_payload || {};
  const requestedMode = request.mode || (request.targetCodes?.length ? 'targeted' : definition.mode || 'core');
  const phase = definition.datasetPublicationByMode?.[requestedMode];
  // 任何失败结果都不能被调用方传入的 succeeded 覆盖，避免后台显示假成功。
  const resultFailed = resultSummary && (
    resultSummary.ok === false || resultSummary.status === 'failed' || Boolean(resultSummary.error)
    || (phase?.requireStageComplete && resultSummary.stageComplete !== true)
    || (phase?.requiresDataWatermark === false
      && !stageCompletionEvidence(definition, resultSummary, current.rows[0].request_payload || {}))
  );
  const effectiveStatus = requestedStatus === 'succeeded' && resultFailed ? 'failed' : requestedStatus;
  const skipWatermark = resultSummary && (resultSummary.watermarkNotRequired === true
    || stageCompletionEvidence(definition, resultSummary, current.rows[0].request_payload || {}));
  const requiresDataWatermark = definition.requiresDataWatermark !== false && !skipWatermark;
  const dataAsOf = effectiveStatus === 'succeeded' && requiresDataWatermark
    ? await resolveDataAsOf(current.rows[0].job_code, current.rows[0].business_date, resultSummary)
    : null;
  const nextStatus = effectiveStatus === 'succeeded' && requiresDataWatermark
    && !isDataAsOfFresh(dataAsOf, current.rows[0].business_date, definition) ? 'degraded' : effectiveStatus;
  const finalError = nextStatus === 'degraded' && !errorMessage
    ? (dataAsOf ? `任务数据日期过旧：${normalizeBusinessDate(dataAsOf)}，未达到计划要求；请检查受影响证券明细和上游数据` : '任务完成但数据日期缺失，请检查上游返回和入库结果')
    : errorMessage;
  const { rows } = await repository.update_ops_job_schedule_slots_11([slotId, nextStatus, JSON.stringify(sanitizeJobResult(resultSummary || {})), finalError ? sanitizeJobError(finalError) : null, runId || null, dataAsOf,
      expectedToken || null]);
  const completed = rows[0] || null;
  // 传了执行令牌却影响 0 行：说明令牌被接管或租约已过期，本次收尾不被承认。
  // 保留 running 让恢复流程回收重跑，绝不在日志之外伪装成成功。
  if (!completed && expectedToken) {
    console.warn(`[job-slot] 收尾被拒绝（执行资格已失效）slot=${slotId} status=${nextStatus}`);
  }
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

async function deferSlot(slotId, errorMessage, resultSummary, delayMinutes = 5, runId = null, expectedToken = null) {
  resultSummary = await mergeSlotExternalCallSummary(slotId, resultSummary || {}, expectedToken);
  const { rows } = await repository.update_ops_job_schedule_slots_12([slotId, String(Math.max(Number(delayMinutes) || 5, 1)), JSON.stringify(sanitizeJobResult(resultSummary || {})),
      errorMessage ? sanitizeJobError(errorMessage) : null, runId, expectedToken || null]);
  if (!rows[0] && expectedToken) {
    console.warn(`[job-slot] 退避写入被拒绝（执行资格已失效）slot=${slotId}`);
  }
  return rows[0] || null;
}

async function waitForExternalSlot(slotId, errorMessage, resultSummary, retryAt = null, runId = null, expectedToken = null) {
  const parsedRetryAt = retryAt ? new Date(retryAt) : null;
  const nextAttemptAt = parsedRetryAt && !Number.isNaN(parsedRetryAt.getTime())
    ? parsedRetryAt : new Date(Date.now() + 30 * 60 * 1000);
  resultSummary = await mergeSlotExternalCallSummary(slotId, resultSummary || {}, expectedToken);
  const safeSummary = sanitizeJobResult({
    ...(resultSummary || {}),
    waitingExternal: true,
    recoverAt: nextAttemptAt.toISOString(),
  });
  const { rows } = await repository.update_ops_job_schedule_slots_13([slotId, nextAttemptAt, JSON.stringify(safeSummary), runId,
      errorMessage ? sanitizeJobError(errorMessage) : null, expectedToken || null]);
  return rows[0] || null;
}

// 单槽位累计调用量必须由数据库原子累加，不能由多个 Worker 读旧值后覆盖。
// 传 executionToken 时同时校验执行归属：接管后的旧执行不得再累加或覆盖进度。
async function mergeSlotExternalCallSummary(slotId, resultSummary = {}, expectedToken = null) {
  const attemptExternalCalls = Math.max(Number(
    resultSummary.attemptExternalCalls ?? resultSummary.externalCalls ?? resultSummary.externalCallCount ?? 0
  ) || 0, 0);
  const { rows } = await repository.update_ops_job_schedule_slots_14([slotId, JSON.stringify(sanitizeJobResult(resultSummary || {})), attemptExternalCalls, expectedToken || null]);
  const stored = rows[0] && rows[0].result_summary || {};
  const storedLimit = Number(stored.slotExternalCallsLimit || 0);
  return { ...(resultSummary || {}), attemptExternalCalls, externalCalls: attemptExternalCalls,
    ...(stored.dependencyRecovery?{dependencyRecovery:stored.dependencyRecovery}:{}),
    slotExternalCallsTotal: Number(stored.slotExternalCallsTotal || 0),
    slotExternalCallsLimit: Number(resultSummary.slotExternalCallsLimit || storedLimit) || null };
}

async function continueSlot(slotId, resultSummary = {}, delayMinutes = 1, runId = null, expectedToken = null) {
  resultSummary = await mergeSlotExternalCallSummary(slotId, resultSummary || {}, expectedToken);
  const nextAttemptAt = resultSummary.nextAttemptAt ? new Date(resultSummary.nextAttemptAt) : new Date(Date.now() + Math.max(Number(delayMinutes) || 1, 1) * 60000);
  const safeNext = Number.isNaN(nextAttemptAt.getTime()) ? new Date(Date.now() + 60000) : nextAttemptAt;
  const { rows } = await repository.update_ops_job_schedule_slots_15([slotId, safeNext, JSON.stringify(sanitizeJobResult({ ...resultSummary, continuationRequired: true, nextAttemptAt: safeNext.toISOString() })), runId,
      expectedToken || null]);
  if (!rows[0] && expectedToken) {
    console.warn(`[job-slot] 续批写入被拒绝（执行资格已失效）slot=${slotId}`);
  }
  return rows[0] || null;
}

async function touchSlot(slotId, workerId = WORKER_ID, expectedToken = null) {
  const { rows } = await repository.select_ops_job_schedule_slots_5([slotId]);
  const timeoutMinutes = rows[0] ? Number(getJobDefinition(rows[0].job_code).timeoutMinutes || 30) : 30;
  await repository.update_ops_job_schedule_slots_16([slotId, workerId, timeoutMinutes, expectedToken || null]);
}

async function retryJobSlot(slotId) {
  const lookup = await repository.select_ops_job_schedule_slots_5([slotId]);
  const definition = getJobDefinition(lookup.rows[0]?.job_code);
  if (definition.disabled) throw new Error(definition.disabledReason);
  const { rows } = await repository.update_ops_job_schedule_slots_17([slotId]);
  return rows[0] || null;
}

async function acknowledgeSlot(slotId) {
  const { rows } = await repository.update_ops_job_schedule_slots_18([slotId]);
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
  const { rows } = await repository.select_ops_job_schedule_slots_6([businessDate, status, limit, triggerType, keyword, categoryCodes, keywordCodes]);
  const labels = new Map(JOB_DEFINITIONS.map(item => [item.jobCode, item.label]));
  return rows.map(row => {
    const definition = getJobDefinition(row.job_code);
    const lateAt = new Date(row.scheduled_for).getTime() + Number(definition.deadlineMinutes || 180) * 60000;
    const waitingState = slotWaitingState(row);
    return { ...row,
      last_error: row.last_error ? sanitizeJobError(row.last_error) : null,
      result_summary: sanitizeJobResult(row.result_summary || {}),
      request_payload: sanitizeJobResult(row.request_payload || {}),
      label: labels.get(row.job_code) || row.job_code,
      category: definition.category, importance: definition.importance,
      dependency_codes: definition.dependencyCodes || [],
      deadline_at: new Date(lateAt).toISOString(), max_attempts: definition.maxAttempts,
      waiting_state: waitingState,
      is_late: ['pending', 'running', 'failed', 'degraded'].includes(row.status) && lateAt < Date.now()
        && !waitingState.waiting };
  });
}

async function getJobSlot(slotId) {
  const { rows } = await repository.select_ops_job_schedule_slots_7([slotId]);
  if (!rows[0]) return null;
  const definition = getJobDefinition(rows[0].job_code);
  const [runs, dependencies, alerts, audits] = await Promise.all([
    repository.select_job_runs_2([slotId, rows[0].last_run_id || 0]),
    repository.select_ops_job_schedule_slots_8([rows[0].business_date, definition.dependencyCodes || [], rows[0].scheduled_for]),
    repository.select_ops_alert_notifications([slotId]),
    repository.select_admin_audit_log([String(slotId)]),
  ]);
  const freshnessRequired = definition.requiresDataWatermark !== false;
  const freshnessValid = !freshnessRequired || (Boolean(rows[0].data_as_of) && isDataAsOfFresh(rows[0].data_as_of, rows[0].business_date, definition));
  return {
    ...rows[0],
    last_error: rows[0].last_error ? sanitizeJobError(rows[0].last_error) : null,
    result_summary: sanitizeJobResult(rows[0].result_summary || {}),
    request_payload: sanitizeJobResult(rows[0].request_payload || {}),
    definition,
    waiting_state: slotWaitingState(rows[0]),
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
  await repository.update_ops_worker_heartbeats([role, `${HOSTNAME}:%`, workerId]);
  await repository.insert_ops_worker_heartbeats([workerId, role, String(process.pid), process.env.APP_VERSION || appVersion || '', status]);
}

async function getJobOverview() {
  const today = dateText();
  const [counts, slots, alerts, workers] = await Promise.all([
    repository.select_ops_job_schedule_slots_9([today]),
    repository.select_ops_job_schedule_slots_10([today]),
    jobScheduleSlotsRepository.countAlertsByStatus(),
    repository.with_ops_worker_heartbeats(),
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
  const { rows } = await repository.select_ops_job_schedule_slots_11([slotId]);
  if (!rows[0]) return null;
  const slot = rows[0];
  const definition = getJobDefinition(slot.job_code);
  if (getJobDefinition(slot.job_code).requiresDataWatermark === false) {
    if (slot.status === 'degraded') {
      const runResult = slot.last_run_id
        ? await repository.select_job_runs_3([slot.last_run_id])
        : { rows: [] };
      const runSucceeded = runResult.rows[0] && runResult.rows[0].status === 'done';
      const summarySucceeded = slot.result_summary && slot.result_summary.ok === true;
      if (runSucceeded || summarySucceeded) {
        const recovered = await repository.update_ops_job_schedule_slots_19([slotId]);
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
    const result = await repository.update_ops_job_schedule_slots_20([slotId, actualDataAsOf, Boolean(actualDataAsOf && freshness)]);
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
  claimSlot, completeSlot, deferSlot, waitForExternalSlot, continueSlot, mergeSlotExternalCallSummary, touchSlot, recoverExpiredSlots, listDueSlots, retryJobSlot, acknowledgeSlot,
  listJobSlots, getJobSlot, validateJobSlot, heartbeat, getJobOverview, queryDataAsOf, isDataAsOfFresh, resolveDataAsOf, expectedDataDate,
  isSlotDayAllowed, isWeekday, previousDate, resolveScheduleForDate,
  resolveDatasetPartitionDate, datasetDependencyState, recoverNavDependencies, attemptLimit, sweepStaleSlots,
  reconcileSlot, pendingNeedsTakeoverCheck,
};

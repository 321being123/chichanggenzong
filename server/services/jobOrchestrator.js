const { pool, startJobRun } = require('../db');
const { fork, execFile } = require('child_process');
const path = require('path');
const { sanitizeJobError, sanitizeJobResult } = require('./jobErrorSanitizer');
const { JOB_DEFINITIONS, getJobDefinition } = require('./jobDefinitions');
const {
  WORKER_ID, syncScheduleSlots, recoverExpiredSlots, listDueSlots,
  claimSlot, completeSlot, deferSlot, touchSlot, queryDataAsOf, isDataAsOfFresh,
} = require('./jobScheduleSlots');

let executorStarted = false;
let executing = false;
let stopping = false;
let executorTimer = null;
let activeRuns = 0;
const activeControllers = new Set();
const activeRunMeta = new Set();
const stopWaiters = [];

function notifyStopWaiters() {
  if (activeRuns === 0 && !executing) stopWaiters.splice(0).forEach(resolve => resolve());
}

function triggerType(reason) {
  if (reason === 'manual-retry') return 'manual_retry';
  if (reason === 'auto-retry') return 'auto_retry';
  if (reason === 'startup-catchup') return 'startup_catchup';
  return 'scheduled';
}

function reasonForSlot(slot) {
  if (slot && slot.trigger_type === 'manual_retry') return 'manual-retry';
  if (slot && slot.trigger_type === 'auto_retry') return 'auto-retry';
  if (slot && slot.trigger_type === 'startup_catchup') return 'startup-catchup';
  return 'scheduled';
}

function normalizeJobResult(result, externalCalls = 0) {
  const value = result && typeof result === 'object' ? { ...result } : {};
  const skippedFresh = value.skipped && ['fresh', 'already-ran-today'].includes(value.reason);
  const failed = value.ok === false || value.status === 'failed' || Boolean(value.error);
  const status = value.status || (skippedFresh ? 'fresh' : failed ? 'failed' : value.partial ? 'partial' : 'succeeded');
  return {
    ...value,
    ok: !failed,
    status,
    dataAsOf: value.dataAsOf || value.data_as_of || value.trade_date || value.dataDate || null,
    externalCalls: Number.isFinite(Number(value.externalCalls)) ? Number(value.externalCalls) : Number(externalCalls || 0),
    datasets: Array.isArray(value.datasets) ? value.datasets : [],
  };
}

function classifyFailure(error, result = {}) {
  const code = String((error && (error.code || error.errorCode)) || result.errorCode || '').toUpperCase();
  const type = String((error && (error.errorType || error.type)) || result.errorType || '').toLowerCase();
  const source = String((error && error.source) || result.source || '').toLowerCase() || null;
  const apiName = String((error && error.apiName) || result.apiName || '').trim() || null;
  const message = String((error && error.message) || result.error || error || '任务执行失败');
  if (code === 'QUOTA_EXHAUSTED' || /当日|每日|当天|日频|次数.*耗尽|额度.*耗尽|配额.*耗尽|daily.*quota|daily.*limit/i.test(message)) {
    return { code: code || 'QUOTA_EXHAUSTED', type: 'rate_limit', retryable: false, source, apiName, message };
  }
  if (code === 'RATE_LIMIT' || code === 'CIRCUIT_OPEN' || type === 'rate_limit' || type === 'circuit_open' || /429|频率|频次|限速|配额|rate.?limit|quota/i.test(message)) {
    return { code: code || 'RATE_LIMIT', type: 'rate_limit', retryable: false, source, apiName, message };
  }
  if (code === 'AUTH_ERROR' || /token\s*(无效|错误)|无效 token|invalid token|401/i.test(message)) {
    return { code: code || 'AUTH_ERROR', type: 'permission', retryable: false, source, apiName, message };
  }
  if (code === 'PERMISSION_DENIED' || code === 'INVALID_PARAMETER' || type === 'permission' || /权限|permission|积分不足|没有接口|无权限|参数错误|invalid parameter/i.test(message)) {
    return { code: code || 'NON_RETRYABLE', type: 'non_retryable', retryable: false, source, apiName, message };
  }
  if (code === 'EMPTY_DATA' || type === 'empty_data' || /数据为空|返回空|empty data/i.test(message)) {
    return { code: code || 'EMPTY_DATA', type: 'empty_data', retryable: true, source, apiName, message };
  }
  if (code === 'DATASET_LOCKED' || type === 'in_progress' || /DATASET_LOCKED|数据集正在由其他 Worker|正在请求中/i.test(message)) {
    return { code: 'DATASET_LOCKED', type: 'in_progress', retryable: true, delayMinutes: 1, source, apiName, message };
  }
  if (code === 'NETWORK_TIMEOUT' || code === 'UPSTREAM_5XX' || type === 'network' || /timeout|超时|上游.*5\d\d|\b5\d\d\b/i.test(message)) {
    return { code: code || 'NETWORK_ERROR', type: 'network', retryable: true, source, apiName, message };
  }
  return { code: code || 'JOB_FAILED', type: type || 'unknown', retryable: true, source, apiName, message };
}

async function startManagedRun(slot, reason) {
  const runId = await startJobRun(slot.job_code);
  if (!runId) return null;
  await pool.query(
    `UPDATE job_runs SET slot_id=$2, attempt_no=$3, trigger_type=$4, worker_id=$5, heartbeat_at=now()
      WHERE id=$1`,
    [runId, slot.slot_id, slot.attempt_count, triggerType(reason), WORKER_ID]
  );
  return runId;
}

async function finishManagedRun(runId, jobCode, ok, result = {}, failure = null) {
  if (!runId) return;
  const safeResult = sanitizeJobResult(result || {});
  await pool.query(
    `UPDATE job_runs SET status=$2, finished_at=now(), detail=$3, result_json=$4::jsonb,
        external_call_count=$5, external_sources=$6::jsonb, datasets=$7::jsonb,
        error_code=$8, error_type=$9
      WHERE id=$1`,
    [runId, ok ? 'done' : 'failed', sanitizeJobError(failure ? failure.message : safeResult.error || '', 4000),
      JSON.stringify(safeResult), Number(safeResult.externalCalls || 0),
      JSON.stringify(safeResult.externalSources || getJobDefinition(jobCode).externalSources || []),
      JSON.stringify(safeResult.datasets || []), failure ? failure.code : safeResult.errorCode || null,
      failure ? failure.type : safeResult.errorType || null]
  );
  if (ok && runId) {
    const { rows: duplicateRows } = await pool.query(
      `SELECT COUNT(*)::int AS count, MAX(s.business_date)::text AS business_date
        FROM job_runs r
         JOIN ops.job_schedule_slots s ON s.slot_id=r.slot_id
        WHERE r.id<>$1 AND r.job=$2 AND r.status='done' AND r.trigger_type='scheduled'
          AND (SELECT trigger_type FROM job_runs WHERE id=$1)='scheduled'
          AND s.business_date=(SELECT business_date FROM ops.job_schedule_slots WHERE slot_id=(SELECT slot_id FROM job_runs WHERE id=$1))`,
      [runId, jobCode]
    );
    if (Number(duplicateRows[0]?.count || 0) > 0 && duplicateRows[0]?.business_date) {
      const { notifyJobFailure } = require('./jobAlertMailer');
      await notifyJobFailure({
        alertKey: `duplicate-success:${jobCode}:${duplicateRows[0].business_date}`,
        alertType: 'duplicate_success',
        severity: 'critical',
        jobCode,
        slotId: null,
        subject: `后台任务出现重复成功记录：${jobCode}`,
        summary: `任务 ${jobCode} 在业务日期 ${duplicateRows[0].business_date} 已出现第 2 条定时成功运行记录，请检查定时计划是否重复。`,
      }).catch(error => console.warn('[job-alert] 重复成功告警失败:', error.message));
    }
  }
}

async function linkLatestRun(slot, startedAt, reason) {
  const { rows } = await pool.query(
    `UPDATE job_runs
        SET slot_id=$1, attempt_no=$2, trigger_type=$3, worker_id=$4, heartbeat_at=now()
      WHERE id=(
        SELECT id FROM job_runs
         WHERE job=$5 AND started_at >= $6::timestamptz - interval '5 seconds'
         ORDER BY id DESC LIMIT 1
      )
      RETURNING id`,
    [slot.slot_id, slot.attempt_count, triggerType(reason), WORKER_ID, slot.job_code, startedAt]
  );
  return rows[0] ? rows[0].id : null;
}

async function readRunStatus(runId) {
  if (!runId) return null;
  const { rows } = await pool.query('SELECT id, status, detail FROM job_runs WHERE id=$1', [runId]);
  return rows[0] || null;
}

function killProcessTree(child, graceMs = 3000) {
  return new Promise(resolve => {
    if (!child || !child.pid || child.exitCode !== null || child.signalCode) return resolve();
    let finished = false;
    let forceTimer = null;
    const done = () => {
      if (finished) return;
      finished = true;
      if (forceTimer) clearTimeout(forceTimer);
      resolve();
    };
    child.once('exit', done);
    if (process.platform === 'win32') {
      execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], done);
      return;
    }
    try { process.kill(-child.pid, 'SIGTERM'); }
    catch (_) {
      try { child.kill('SIGTERM'); } catch (_) { return done(); }
    }
    forceTimer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (_) { try { child.kill('SIGKILL'); } catch (_) {} }
      const settleTimer = setTimeout(done, 500);
    }, Math.max(Number(graceMs) || 3000, 500));
  });
}

function runJobInIsolatedProcess(jobCode, reason, businessDate, context, signal) {
  return new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, 'jobRunnerProcess.js'), [], {
      detached: process.platform !== 'win32', silent: true,
      env: { ...process.env, DURABLE_JOB_RUN: '1' },
    });
    if (child.stdout) child.stdout.resume();
    if (child.stderr) child.stderr.resume();
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', abort);
      fn(value);
    };
    const abort = () => {
      killProcessTree(child).then(() => finish(reject, new Error('job aborted')));
    };
    if (signal) {
      if (signal.aborted) return abort();
      signal.addEventListener('abort', abort, { once: true });
    }
    child.once('message', message => message && message.ok
      ? finish(resolve, message.result)
      : finish(reject, childErrorFromMessage(message)));
    child.once('error', error => finish(reject, error));
    child.once('exit', code => { if (!settled) finish(reject, new Error(`job child process exited ${code} without result`)); });
    child.send({ jobCode, reason, businessDate, context: context || {} });
  });
}

function childErrorFromMessage(message) {
  return Object.assign(new Error(message && message.error || 'job child process failed'), {
    code: message && message.errorCode,
    errorType: message && message.errorType,
    retryable: message && message.retryable,
    source: message && message.source,
    dataset: message && message.dataset,
    apiName: message && message.apiName,
    tokenFingerprint: message && message.tokenFingerprint,
    recoverAt: message && message.recoverAt,
    externalCallCount: message && message.externalCallCount,
    externalSources: message && message.externalSources,
  });
}

async function markRunFailed(runId, detail, failure = null, result = {}) {
  if (!runId) return;
  await pool.query(
    `UPDATE job_runs SET status='failed', finished_at=now(), detail=$2,
        error_code=$3, error_type=$4, external_call_count=$5,
        external_sources=$6::jsonb, datasets=$7::jsonb
       WHERE id=$1 AND status='running'`,
    [runId, sanitizeJobError(detail || 'job interrupted'), failure && failure.code || null, failure && failure.type || null,
      Number(result.externalCalls || result.externalCallCount || 0), JSON.stringify(result.externalSources || {}), JSON.stringify(result.datasets || [])]
  );
}

async function failOrRetry(slot, error, runId, result = {}) {
  const definition = getJobDefinition(slot.job_code);
  const failure = classifyFailure(error, result);
  const message = sanitizeJobError(failure.message || '任务执行失败');
  const configuredMax = Number(definition.maxAttempts || 3);
  const maxAttempts = Math.min(configuredMax, Number(failure.maxAttempts || (definition.retryPolicy === 'external' ? 3 : configuredMax)));
  const noRetry = definition.retryPolicy === 'no_retry' || failure.retryable === false;
  // Tushare 熔断由底层请求在拿到 Token 指纹后持久化；编排层没有指纹时禁止创建全局熔断。
  const normalized = normalizeJobResult({
    ...result, error: message, errorCode: failure.code, errorType: failure.type, apiName: failure.apiName,
  }, result.externalCalls);
  if (noRetry || Number(slot.attempt_count || 0) >= maxAttempts) {
    await finishManagedRun(runId, slot.job_code, false, normalized, failure).catch(() => {});
    const completed = await completeSlot(slot.slot_id, 'failed', { ...sanitizeJobResult(normalized), attempts: slot.attempt_count }, message, runId);
    const { notifyJobFailure } = require('./jobAlertMailer');
    await notifyJobFailure({
      jobCode: slot.job_code,
      slotId: slot.slot_id,
      alertKey: `slot:${slot.slot_id}:max-attempts`,
      alertType: 'failure',
      subject: `后台任务最终失败：${definition.label}`,
      summary: noRetry ? `错误类型 ${failure.type} 不自动重试。${message}` : `已达到最大尝试次数 ${maxAttempts} 次。${message}`,
    }).catch(mailError => console.warn('[job-alert] 最终失败告警处理失败:', mailError.message));
    return completed;
  }
  const delays = Array.isArray(definition.retryDelaysMinutes) ? definition.retryDelaysMinutes : [5, 15, 45];
  const delay = Number(failure.delayMinutes || delays[Math.min(Number(slot.attempt_count || 1) - 1, delays.length - 1)] || 15);
  await finishManagedRun(runId, slot.job_code, false, normalized, failure).catch(() => {});
  const deferred = await deferSlot(slot.slot_id, message, { ...sanitizeJobResult(normalized), retryInMinutes: delay, errorType: failure.type }, delay, runId);
  if (Number(slot.attempt_count || 0) === 2) {
    const { notifyJobFailure } = require('./jobAlertMailer');
    await notifyJobFailure({
      jobCode: slot.job_code,
      slotId: slot.slot_id,
      alertKey: `slot:${slot.slot_id}:retry-warning`,
      alertType: 'failure_warning',
      severity: 'warning',
      subject: `后台任务连续失败：${definition.label}`,
      summary: `任务已连续失败 2 次，将在 ${delay} 分钟后自动重试。${message}`,
    }).catch(mailError => console.warn('[job-alert] 连续失败告警处理失败:', mailError.message));
  }
  return deferred;
}

async function runWithAbort(jobCode, reason, businessDate, context, signal) {
  const task = runJobInIsolatedProcess(jobCode, reason, businessDate, context, signal);
  task.catch(() => {});
  if (!signal) return task;
  if (signal.aborted) throw new Error('任务已取消');
  return task;
}

async function runSlot(slot, reason = reasonForSlot(slot)) {
  if (stopping) return { ok: false, skipped: true, reason: 'executor_stopping' };
  activeRuns += 1;
  const claimed = await claimSlot(slot.slot_id, WORKER_ID, triggerType(reason));
  if (!claimed) {
    activeRuns -= 1;
    notifyStopWaiters();
    return { ok: false, skipped: true, reason: 'not_claimed' };
  }
  if (stopping) {
    await deferSlot(claimed.slot_id, 'Worker 正在停机，任务已回到补偿队列', { workerStopping: true }, 1).catch(() => {});
    activeRuns -= 1;
    notifyStopWaiters();
    return { ok: false, skipped: true, reason: 'executor_stopping' };
  }

  const startedAt = new Date();
  let runId = null;
  let timeoutTimer;
  let task;
  const controller = new AbortController();
  activeControllers.add(controller);
  const heartbeatTimer = setInterval(() => {
    touchSlot(claimed.slot_id, WORKER_ID).catch(() => {});
    if (runId) pool.query(
      `UPDATE job_runs SET heartbeat_at=now(), locked_until=now()+($2::integer * interval '1 minute')
         WHERE id=$1 AND status='running'`,
      [runId, Number(getJobDefinition(claimed.job_code).timeoutMinutes || 30) + 10]
    ).catch(() => {});
  }, 60 * 1000);
  if (heartbeatTimer.unref) heartbeatTimer.unref();
  const definition = getJobDefinition(claimed.job_code);
  const runMeta = {
    controller,
    startedAt: Date.now(),
    timeoutMs: Number(definition.timeoutMinutes || 30) * 60 * 1000,
  };
  activeRunMeta.add(runMeta);
  const runContext = {
    slotId: claimed.slot_id,
    force: Boolean(claimed.request_payload && claimed.request_payload.force === true),
    failedDatasets: claimed.result_summary && Array.isArray(claimed.result_summary.failedDatasets)
      ? claimed.result_summary.failedDatasets : [],
    externalCallCount: Number(claimed.result_summary && claimed.result_summary.externalCalls || 0),
  };

  try {
    runId = await startManagedRun(claimed, reason);
    if (definition.freshnessGate && !runContext.force) {
      const dataAsOf = await queryDataAsOf(claimed.job_code, claimed.business_date).catch(() => null);
      if (dataAsOf && isDataAsOfFresh(dataAsOf, claimed.business_date, definition)) {
        const freshResult = normalizeJobResult({ ok: true, status: 'fresh', dataAsOf, externalCalls: 0 });
        await finishManagedRun(runId, claimed.job_code, true, freshResult);
        await completeSlot(claimed.slot_id, 'succeeded', freshResult, null, runId);
        return freshResult;
      }
    }
    task = runWithAbort(
      claimed.job_code,
      reason,
      String(claimed.business_date || '').slice(0, 10),
      runContext,
      controller.signal
    );
    task.catch(() => {});
    const timeoutMinutes = Number(definition.timeoutMinutes || 30);
    const timeout = new Promise((resolve, reject) => {
      timeoutTimer = setTimeout(() => {
        controller.abort();
        task.then(
          () => reject(new Error(`任务执行超过 ${timeoutMinutes} 分钟`)),
          () => reject(new Error(`任务执行超过 ${timeoutMinutes} 分钟`))
        );
      }, timeoutMinutes * 60 * 1000);
    });
    const rawResult = await Promise.race([task, timeout]);
    const result = normalizeJobResult(rawResult);

    if (result && result.unsupported) {
      await finishManagedRun(runId, claimed.job_code, true, result);
      await completeSlot(claimed.slot_id, 'blocked', result, result.error, runId);
      return result;
    }
    if (result && result.skipped && ['failed', 'error'].includes(result.reason)) {
      await failOrRetry(claimed, result.error || result.reason, runId, result);
      return result;
    }
    if (result && result.skipped && ['fresh', 'already-ran-today'].includes(result.reason)) {
      result.status = 'fresh';
      await finishManagedRun(runId, claimed.job_code, true, result);
      await completeSlot(claimed.slot_id, 'succeeded', result, null, runId);
      return result;
    }
    if (result && result.skipped && result.reason !== 'not_configured') {
      const failure = classifyFailure(result.error || result.reason, result);
      await finishManagedRun(runId, claimed.job_code, false, result, failure);
      await deferSlot(claimed.slot_id, result.reason || '任务被其他实例占用', result, 5, runId);
      return result;
    }
    if (result && result.skipped && result.reason === 'not_configured') {
      await finishManagedRun(runId, claimed.job_code, true, result);
      await completeSlot(claimed.slot_id, 'skipped', result, '当前任务未配置，保留上一份有效数据', runId);
      return result;
    }
    if (result && result.ok === false && !result.skipped) {
      await failOrRetry(claimed, result.error, runId, result);
      return result;
    }
    if (rawResult === undefined && !runId) {
      await deferSlot(claimed.slot_id, '任务未产生运行记录，等待下一次自动补偿', {}, 5);
      return { ok: false, skipped: true, reason: 'no_run_record' };
    }
    await finishManagedRun(runId, claimed.job_code, true, result);
    await completeSlot(claimed.slot_id, 'succeeded', result || { ok: true }, null, runId);
    return { ok: true, result };
  } catch (error) {
    const timedOut = controller.signal.aborted;
    const errorResult = {
      ...(timedOut ? { timed_out: true } : {}),
      errorCode: error.code,
      errorType: error.errorType,
      source: error.source,
      dataset: error.dataset,
      apiName: error.apiName,
      tokenFingerprint: error.tokenFingerprint,
      recoverAt: error.recoverAt,
      externalCalls: Number(error.externalCallCount || 0),
      externalSources: error.externalSources || {},
    };
    const failure = classifyFailure(error, errorResult);
    await markRunFailed(runId, timedOut ? 'job timeout or worker shutdown' : error.message || error, failure, errorResult).catch(() => {});
    await failOrRetry(claimed, error, runId, { ...errorResult, errorCode: failure.code, errorType: failure.type });
    return { ok: false, error: sanitizeJobError(error.message || error), ...errorResult };
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    clearInterval(heartbeatTimer);
    activeControllers.delete(controller);
    activeRunMeta.delete(runMeta);
    activeRuns -= 1;
    notifyStopWaiters();
  }
}

async function runDueSlots() {
  if (stopping) return { ok: false, skipped: true, reason: 'executor_stopping' };
  if (executing) return { ok: true, skipped: true, reason: 'executor_busy' };
  executing = true;
  try {
    const { sendDueAlerts } = require('./jobAlertMailer');
    await sendDueAlerts(20).catch(error => console.warn('[job-alert] 到期告警投递失败:', error.message));
    await recoverExpiredSlots();
    await syncScheduleSlots();
    const due = await listDueSlots(20);
    const results = [];
    for (const slot of due) {
      if (stopping) break;
      results.push(await runSlot(slot, reasonForSlot(slot)));
    }
    return { ok: true, count: results.length, results };
  } finally {
    executing = false;
    notifyStopWaiters();
  }
}

function startDurableExecutor() {
  if (executorStarted) return;
  stopping = false;
  executorStarted = true;
  const tick = () => runDueSlots().catch(error => console.warn('[job-orchestration] 统一执行器失败:', error.message));
  tick();
  executorTimer = setInterval(tick, 60 * 1000);
  // 这是独立 Worker 的主保活句柄；不能 unref，否则启动任务结束后进程会正常退出，持久化任务无人领取。
}

async function stopDurableExecutor(timeoutMs = 5000) {
  stopping = true;
  if (executorTimer) clearInterval(executorTimer);
  if (activeRuns === 0 && !executing) return;
  const configuredWaitMs = Math.max(Number(timeoutMs) || 0, 0);
  const taskWaitMs = Array.from(activeRunMeta).reduce((max, item) => {
    const remaining = Math.max(item.timeoutMs - (Date.now() - item.startedAt), 0);
    return Math.max(max, remaining);
  }, 0);
  const drainWaitMs = Math.max(configuredWaitMs, taskWaitMs);
  await Promise.race([
    new Promise(resolve => stopWaiters.push(resolve)),
    new Promise(resolve => setTimeout(resolve, drainWaitMs)),
  ]);
  // 先给正在执行的任务一个排空窗口；只有超时仍未结束才中止，避免部署主动制造失败。
  if (activeRuns > 0) {
    activeControllers.forEach(controller => controller.abort());
    await Promise.race([
      new Promise(resolve => stopWaiters.push(resolve)),
      new Promise(resolve => setTimeout(resolve, 5000)),
    ]);
  }
  if (executing) {
    await Promise.race([
      new Promise(resolve => stopWaiters.push(resolve)),
      new Promise(resolve => setTimeout(resolve, 5000)),
    ]);
  }
}

module.exports = { startDurableExecutor, stopDurableExecutor, runDueSlots, runSlot, JOB_DEFINITIONS, touchSlot, runJobInIsolatedProcess, childErrorFromMessage };

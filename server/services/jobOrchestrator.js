const { pool } = require('../db');
const { fork, execFile } = require('child_process');
const path = require('path');
const { sanitizeJobError, sanitizeJobResult } = require('./jobErrorSanitizer');
const { JOB_DEFINITIONS, getJobDefinition } = require('./jobDefinitions');
const {
  WORKER_ID, syncScheduleSlots, recoverExpiredSlots, listDueSlots,
  claimSlot, completeSlot, deferSlot, touchSlot,
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
      detached: process.platform !== 'win32', silent: true, env: process.env,
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
      : finish(reject, new Error(message && message.error || 'job child process failed')));
    child.once('error', error => finish(reject, error));
    child.once('exit', code => { if (!settled) finish(reject, new Error(`job child process exited ${code} without result`)); });
    child.send({ jobCode, reason, businessDate, context: { slotId: context && context.slotId } });
  });
}

async function markRunFailed(runId, detail) {
  if (!runId) return;
  await pool.query(
    `UPDATE job_runs SET status='failed', finished_at=now(), detail=$2
       WHERE id=$1 AND status='running'`,
    [runId, sanitizeJobError(detail || 'job interrupted')]
  );
}

async function failOrRetry(slot, error, runId, result = {}) {
  const definition = getJobDefinition(slot.job_code);
  const message = sanitizeJobError(error || result.error || '任务执行失败');
  if (Number(slot.attempt_count || 0) >= Number(definition.maxAttempts || 3)) {
    const completed = await completeSlot(slot.slot_id, 'failed', { ...sanitizeJobResult(result), attempts: slot.attempt_count }, message, runId);
    const { notifyJobFailure } = require('./jobAlertMailer');
    await notifyJobFailure({
      jobCode: slot.job_code,
      slotId: slot.slot_id,
      alertKey: `slot:${slot.slot_id}:max-attempts`,
      alertType: 'failure',
      subject: `后台任务最终失败：${definition.label}`,
      summary: `已达到最大尝试次数 ${definition.maxAttempts || 3} 次。${message}`,
    }).catch(mailError => console.warn('[job-alert] 最终失败告警处理失败:', mailError.message));
    return completed;
  }
  const delays = Array.isArray(definition.retryDelaysMinutes) ? definition.retryDelaysMinutes : [5, 15, 45];
  const delay = delays[Math.min(Number(slot.attempt_count || 1) - 1, delays.length - 1)] || 15;
  const deferred = await deferSlot(slot.slot_id, message, { ...sanitizeJobResult(result), retryInMinutes: delay }, delay, runId);
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
  const heartbeatTimer = setInterval(() => touchSlot(claimed.slot_id, WORKER_ID).catch(() => {}), 60 * 1000);
  if (heartbeatTimer.unref) heartbeatTimer.unref();
  const definition = getJobDefinition(claimed.job_code);
  const runMeta = {
    controller,
    startedAt: Date.now(),
    timeoutMs: Number(definition.timeoutMinutes || 30) * 60 * 1000,
  };
  activeRunMeta.add(runMeta);

  try {
    task = runWithAbort(
      claimed.job_code,
      reason,
      String(claimed.business_date || '').slice(0, 10),
      { slotId: claimed.slot_id, signal: controller.signal },
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
    const result = await Promise.race([task, timeout]);
    runId = await linkLatestRun(claimed, startedAt, reason);
    const run = await readRunStatus(runId);

    if (result && result.unsupported) {
      await completeSlot(claimed.slot_id, 'blocked', result, result.error, runId);
      return result;
    }
    if (result && result.skipped && ['failed', 'error'].includes(result.reason)) {
      await failOrRetry(claimed, result.error || result.reason, runId, result);
      return result;
    }
    if (result && result.skipped && result.reason !== 'not_configured') {
      await deferSlot(claimed.slot_id, result.reason || '任务被其他实例占用', result, 5, runId);
      return result;
    }
    if (result && result.skipped && result.reason === 'not_configured') {
      await completeSlot(claimed.slot_id, 'skipped', result, '当前任务未配置，保留上一份有效数据', runId);
      return result;
    }
    if (result && result.ok === false && !result.skipped) {
      await failOrRetry(claimed, result.error, runId, result);
      return result;
    }
    if (run && run.status === 'failed') {
      await failOrRetry(claimed, run.detail, runId, { ok: false, detail: run.detail });
      return { ok: false, error: run.detail };
    }
    if (result === undefined && !runId) {
      await deferSlot(claimed.slot_id, '任务未产生运行记录，等待下一次自动补偿', {}, 5);
      return { ok: false, skipped: true, reason: 'no_run_record' };
    }
    await completeSlot(claimed.slot_id, 'succeeded', result || { ok: true }, null, runId);
    return { ok: true, result };
  } catch (error) {
    runId = runId || await linkLatestRun(claimed, startedAt, reason).catch(() => null);
    const timedOut = controller.signal.aborted;
    await markRunFailed(runId, timedOut ? 'job timeout or worker shutdown' : error.message || error).catch(() => {});
    await failOrRetry(claimed, error.message || error, runId, timedOut ? { timed_out: true } : {});
    return { ok: false, error: sanitizeJobError(error.message || error) };
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

module.exports = { startDurableExecutor, stopDurableExecutor, runDueSlots, runSlot, JOB_DEFINITIONS, touchSlot };

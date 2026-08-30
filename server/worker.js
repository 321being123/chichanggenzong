// 独立 Worker 进程：只运行后台任务，不承载 Web 请求。
require('dotenv').config();
process.env.JOB_PROCESS_ROLE = 'worker';
const { initSchema, pool } = require('./db');
const { startScheduler, waitForStartupTasks, stopJobOrchestrationObserver } = require('./scheduler');
const { stopDurableExecutor, JOB_DEFINITIONS } = require('./services/jobOrchestrator');
const { heartbeat } = require('./services/jobScheduleSlots');

async function main() {
  if (process.env.NODE_ENV !== 'production') {
    console.log('[worker] 非生产环境不启动后台任务调度');
    return;
  }
  await initSchema();
  console.log('[worker] 后台任务调度已启动（独立进程）');
  await startScheduler();
}

main().catch(error => {
  console.error('[worker] 启动失败:', error.message);
  process.exit(1);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[worker] 收到 ${signal}，停止领取新任务并等待运行中的任务结束`);
  const drainMs = Math.max(Number(process.env.WORKER_DRAIN_TIMEOUT_MS) || 60000, 10000);
  const maxTaskTimeoutMs = Math.max(...JOB_DEFINITIONS.map(item => Number(item.timeoutMinutes || 30) * 60 * 1000), 30 * 60 * 1000);
  const hard = setTimeout(() => process.exit(1), Math.max(drainMs, maxTaskTimeoutMs) + 15 * 60 * 1000);
  hard.unref();
  stopJobOrchestrationObserver();
  await waitForStartupTasks().catch(() => {});
  await stopDurableExecutor(drainMs).catch(() => {});
  await heartbeat('worker', 'stopped').catch(error => console.warn('[worker] 停止心跳标记失败:', error.message));
  await pool.end().catch(() => {});
  clearTimeout(hard);
  process.exit(0);
}

process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(1)); });
process.on('SIGINT', () => { shutdown('SIGINT').catch(() => process.exit(1)); });

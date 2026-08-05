// ========== 独立 worker 进程：只跑后台任务，不承载 Web 请求 ==========
// 用途：将后台任务从 Web 进程拆出，避免重启/扩容时任务丢失或重复。
// 启动方式：node server/worker.js   （可配合 pm2 命名为 portfolio-worker）
// Web 进程设 DISABLE_SCHEDULER=1 以防重复执行；本进程默认运行全部调度。
// 任务清单与 Web 共用 server/scheduler.js 的单一注册表，避免漏注册。
require('dotenv').config();
const { initSchema, pool } = require('./db');
const { startScheduler } = require('./scheduler');

async function main() {
  await initSchema();
  console.log('[worker] 后台任务调度已启动（独立进程）');
  // 启动即补齐缺失的每日收盘价、净值/总资产快照、指数基线、港币汇率、港股每手股数，并注册全部周期调度。
  // 月度休市日核对（holidaySyncMonthly）已随 startScheduler 统一注册，不再在此内联。
  await startScheduler();
}

main().catch(e => { console.error('[worker] 启动失败:', e.message); process.exit(1); });

// 优雅停机：释放咨询锁与连接池
function shutdown(sig) {
  console.log(`[worker] 收到 ${sig}，释放资源...`);
  const hard = setTimeout(() => process.exit(1), 5000);
  hard.unref();
  Promise.allSettled([pool.end().catch(() => {})]).then(() => process.exit(0));
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

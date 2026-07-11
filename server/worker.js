// ========== 独立 worker 进程：只跑后台任务，不承载 Web 请求 ==========
// 用途：将“收盘记录 + 指数基线”从 Web 进程拆出，避免重启/扩容时任务丢失或重复。
// 启动方式：node server/worker.js   （可配合 pm2 命名为 portfolio-worker）
// Web 进程需设 DISABLE_SCHEDULER=1 以防重复执行；本进程默认运行调度。
require('dotenv').config();
const { initSchema, pool } = require('./db');
const { scheduleAllMarketCloses } = require('./jobs/marketClose');
const { runIndexBaselineJob } = require('./jobs/indexBaseline');

async function main() {
  await initSchema();
  console.log('[worker] 后台任务调度已启动（独立进程）');
  // 收盘记录按市场时刻精准调度
  scheduleAllMarketCloses();
  // 启动即补齐指数基线（带幂等锁，多实例仅一个执行）
  runIndexBaselineJob().catch(e => console.error('[worker] 指数基线失败:', e.message));
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

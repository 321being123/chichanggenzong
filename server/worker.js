// ========== 独立 worker 进程：只跑后台任务，不承载 Web 请求 ==========
// 用途：将“收盘记录 + 指数基线”从 Web 进程拆出，避免重启/扩容时任务丢失或重复。
// 启动方式：node server/worker.js   （可配合 pm2 命名为 portfolio-worker）
// Web 进程需设 DISABLE_SCHEDULER=1 以防重复执行；本进程默认运行调度。
require('dotenv').config();
const { initSchema, pool } = require('./db');
const { scheduleAllMarketCloses, backfillMissingCloses } = require('./jobs/marketClose');
const { runNavSnapshotJob } = require('./jobs/navSnapshot');
const { runIndexBaselineJob } = require('./jobs/indexBaseline');
const { runIndexRecentJob } = require('./jobs/indexBaseline');
const { runHkRateJob } = require('./jobs/hkRate');
const { ensureHolidaysCurrent } = require('./jobs/holidaySync');
const { scheduleBondSafetyRefresh } = require('./jobs/bondSafetyRefresh');
const { scheduleIpoCalendarRefresh } = require('./jobs/ipoCalendarRefresh');
const { scheduleStockAnalysisRefresh } = require('./jobs/stockAnalysisRefresh');

async function main() {
  await initSchema();
  console.log('[worker] 后台任务调度已启动（独立进程）');
  // 启动即核对休市日（年度自愈，确保日历最新再调度）
  await ensureHolidaysCurrent().catch(e => console.warn('[worker] 休市日核对失败:', e.message));
  // 收盘记录按市场时刻精准调度（含休市识别 + 每日缺失补漏）
  scheduleAllMarketCloses();
  // 启动即补齐缺失的每日收盘价（崩溃/报错/节假日空档自愈），随后补齐净值/总资产快照、指数点位、港币汇率
  backfillMissingCloses()
    .then(() => runNavSnapshotJob())
    .then(() => runIndexRecentJob())
    .then(() => runHkRateJob())
    .catch(e => console.error('[worker] 补漏/快照失败:', e.message));
  // 每月核对一次休市日（本地短路：未跨年且 30 天内已核对则跳过联网）
  setInterval(() => {
    ensureHolidaysCurrent().catch(e => console.warn('[worker] 休市日核对失败:', e.message));
  }, 30 * 24 * 3600 * 1000);
  // 启动即补齐指数基线（带幂等锁，多实例仅一个执行）
  runIndexBaselineJob().catch(e => console.error('[worker] 指数基线失败:', e.message));
  // 每日可转债安全性快照（与 Web 进程的 DISABLE_SCHEDULER 约定一致）
  scheduleBondSafetyRefresh();
  scheduleStockAnalysisRefresh();
  scheduleIpoCalendarRefresh();
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

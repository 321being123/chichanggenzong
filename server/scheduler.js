// ========== 单一后台任务注册清单（WORKER-01） ==========
// Web 兼容模式与独立 Worker 共用同一份清单，避免再次漏注册任务。
// 历史差异已在此对齐：
//   - Web 原缺 backfillMissingCloses / ensureHolidaysCurrent / runHkTradeRulesSync('startup') 启动补漏；
//   - Worker 原缺 scheduleMarketVolatilitySync 周期调度。
// 现统一为：启动补漏（幂等+PG 锁）+ 周期调度，二者均由 startScheduler() 触发。
const { ensureHolidaysCurrent } = require('./jobs/holidaySync');
const { scheduleAllMarketCloses, backfillMissingCloses } = require('./jobs/marketClose');
const { runNavSnapshotJob } = require('./jobs/navSnapshot');
const { runIndexBaselineJob, runIndexRecentJob } = require('./jobs/indexBaseline');
const { runHkRateJob } = require('./jobs/hkRate');
const { scheduleBondSafetyRefresh } = require('./jobs/bondSafetyRefresh');
const { scheduleIpoCalendarRefresh } = require('./jobs/ipoCalendarRefresh');
const { scheduleIpoHistorySync, runIpoHistoryStartupCatchup } = require('./jobs/ipoHistorySync');
const { scheduleStockAnalysisRefresh } = require('./jobs/stockAnalysisRefresh');
const { scheduleConvertibleBondRefresh } = require('./jobs/convertibleBondRefresh');
const { scheduleMarketVolatilitySync } = require('./jobs/marketVolatilitySync');
const { scheduleHkTradeRulesSync, runHkTradeRulesSync } = require('./jobs/hkTradeRulesSync');
const { scheduleArbitrageSync } = require('./jobs/arbitrageSync');

// 启动即执行的补漏/快照（幂等、带 PG 锁，多实例仅一个真正执行）
const STARTUP_TASKS = [
  { name: 'holidaySync', run: () => ensureHolidaysCurrent() },
  {
    name: 'backfillCloses',
    run: () => backfillMissingCloses()
      .then(() => runNavSnapshotJob())
      .then(() => runIndexRecentJob())
      .then(() => runHkRateJob())
  },
  { name: 'indexBaseline', run: () => runIndexBaselineJob() },
  { name: 'hkTradeRulesStartup', run: () => runHkTradeRulesSync('startup') },
  { name: 'ipoHistoryStartupCatchup', run: () => runIpoHistoryStartupCatchup() }
];

// 周期调度注册（调用即按 cron/间隔排期，不阻塞）
const SCHEDULED_TASKS = [
  { name: 'marketCloses', register: () => scheduleAllMarketCloses() },
  { name: 'marketVolatilitySync', register: () => scheduleMarketVolatilitySync() },
  { name: 'bondSafetyRefresh', register: () => scheduleBondSafetyRefresh() },
  { name: 'stockAnalysisRefresh', register: () => scheduleStockAnalysisRefresh() },
  { name: 'convertibleBondRefresh', register: () => scheduleConvertibleBondRefresh() },
  { name: 'ipoCalendarRefresh', register: () => scheduleIpoCalendarRefresh() },
  { name: 'ipoHistorySync', register: () => scheduleIpoHistorySync() },
  { name: 'hkTradeRulesSync', register: () => scheduleHkTradeRulesSync() },
  { name: 'arbitrageSync', register: () => scheduleArbitrageSync() },
  // 月度休市日自愈：原 worker.js 内联的 setInterval 任务，现统一纳入注册表（与启动补漏 holidaySync 区分）。
  // 注意：此处故意不 unref，作为独立 Worker 进程的保活句柄（迁移前 worker.js 的内联 setInterval 即承担此职责）。
  { name: 'holidaySyncMonthly', register: () => setInterval(() => {
      ensureHolidaysCurrent().catch(e => console.warn('[scheduler] 休市日月度核对失败:', e && e.message));
    }, 30 * 24 * 3600 * 1000) }
];

// 供测试断言的清单（与技术架构后台任务清单逐项一致）
const SCHEDULER_REGISTRY = {
  startup: STARTUP_TASKS.map(t => t.name),
  scheduled: SCHEDULED_TASKS.map(t => t.name)
};

async function runStartupTasks() {
  for (const t of STARTUP_TASKS) {
    try { await t.run(); }
    catch (e) { console.error(`[scheduler] 启动任务 ${t.name} 失败:`, e && e.message); }
  }
}

function registerScheduledTasks() {
  for (const t of SCHEDULED_TASKS) {
    try { t.register(); }
    catch (e) { console.error(`[scheduler] 周期任务 ${t.name} 注册失败:`, e && e.message); }
  }
}

// Web 兼容模式与独立 Worker 共用：启动补漏 + 周期调度一起拉起
async function startScheduler() {
  await runStartupTasks();
  registerScheduledTasks();
}

module.exports = { startScheduler, runStartupTasks, registerScheduledTasks, SCHEDULER_REGISTRY };

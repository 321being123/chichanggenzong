// WORKER-01：单一任务注册清单校验（Web 兼容模式与独立 Worker 共用）
// 验收：任务注册表与技术架构后台任务清单逐项一致；Web/Worker 使用同一清单；
//       Web 在 DISABLE_SCHEDULER=1 时不运行调度；Worker 始终注册全部任务。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { SCHEDULER_REGISTRY } = require('../scheduler');

// 与技术架构后台任务清单逐项一致（并集：Web 原有 + Worker 补齐的市场周期/港股启动补跑）
const EXPECTED_SCHEDULED = [
  'marketCloses', 'marketVolatilitySync', 'bondSafetyRefresh',
  'stockAnalysisRefresh', 'convertibleBondRefresh', 'ipoCalendarRefresh', 'hkTradeRulesSync'
];
const EXPECTED_STARTUP = [
  'holidaySync', 'backfillCloses', 'indexBaseline', 'hkTradeRulesStartup'
];

const sameSet = (a, b) => {
  const sa = a.slice().sort(), sb = b.slice().sort();
  return sa.length === sb.length && sa.every((v, i) => v === sb[i]);
};

let failures = 0;
const check = (cond, msg) => { if (!cond) { failures++; console.error('FAIL: ' + msg); } };

// 1) 注册表覆盖完整且不含重复
check(Array.isArray(SCHEDULER_REGISTRY.scheduled) && SCHEDULER_REGISTRY.scheduled.length > 0, 'scheduled 任务清单为空');
check(Array.isArray(SCHEDULER_REGISTRY.startup) && SCHEDULER_REGISTRY.startup.length > 0, 'startup 任务清单为空');
check(sameSet(SCHEDULER_REGISTRY.scheduled, EXPECTED_SCHEDULED),
  'scheduled 清单与技术架构不一致: 实际=' + JSON.stringify(SCHEDULER_REGISTRY.scheduled));
check(sameSet(SCHEDULER_REGISTRY.startup, EXPECTED_STARTUP),
  'startup 清单与技术架构不一致: 实际=' + JSON.stringify(SCHEDULER_REGISTRY.startup));
const allNames = SCHEDULER_REGISTRY.scheduled.concat(SCHEDULER_REGISTRY.startup);
check(new Set(allNames).size === allNames.length, '任务清单存在重复名称');

// 2) Web 与 Worker 共用同一份注册清单（静态：都 require('./scheduler')）
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const workerSrc = fs.readFileSync(path.join(__dirname, '..', 'worker.js'), 'utf8');
check(/require\('\.\/scheduler'\)/.test(appSrc), 'app.js 未共用 server/scheduler.js 注册清单');
check(/require\('\.\/scheduler'\)/.test(workerSrc), 'worker.js 未共用 server/scheduler.js 注册清单');

// 3) Web 在 DISABLE_SCHEDULER=1 时不运行调度；Worker 始终运行（无该开关）
check(/process\.env\.DISABLE_SCHEDULER\s*!==\s*'1'/.test(appSrc) && /startScheduler\(/.test(appSrc),
  'app.js 缺少 DISABLE_SCHEDULER 守卫或未调用 startScheduler');
check(/startScheduler\(/.test(workerSrc), 'worker.js 未调用 startScheduler');
check(!/process\.env\.DISABLE_SCHEDULER/.test(workerSrc), 'worker.js 不应包含 DISABLE_SCHEDULER 开关（应始终运行调度）');

if (failures > 0) {
  console.error(`\n${failures} 项调度注册表校验失败`);
  process.exit(1);
}
console.log('OK scheduler-registry: 注册表(' + SCHEDULER_REGISTRY.scheduled.length + ' 周期 + ' +
  SCHEDULER_REGISTRY.startup.length + ' 启动) 与技术架构一致，Web/Worker 共用同一清单');
process.exit(0);

// 方案 27.38 P1：日/周选股"输入未就绪"的等待与唤醒回归。
//
// 生产实证（2026-11-10 只读）：11-09 的 HK/CN 日选股槽各自重复运行 466/467 次，
// 每次都返回同一条 selection_not_ready，最后撞 24 小时续批止损；告警摘要只剩
// "等待原因：未登记，剩余阶段：-，剩余数量：-"——原因是 Runner 给了绝对复查时间
// nextCheckAt，编排器却只认 nextAttemptInMinutes，取不到就退回 1 分钟普通续批。
// 本文件锁住四件事：编排器真的消费绝对复查时间、非法/过期/超上限必须回退或截断、
// 等待原因必须登记且带齐证据、普通续批的 1 分钟节奏不被改变。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const { resolveContinuationWait } = require('../services/jobOrchestrator');
const { slotWaitingState, waitReasonPolicy, WAIT_REASON_POLICIES } = require('../services/jobRecoveryEvidence');

const orchestrator = read('server/services/jobOrchestrator.js');
const refresh = read('server/jobs/stockAnalysisRefresh.js');
const slotsSource = read('server/services/jobScheduleSlots.js');

let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks += 1; };
const eq = (actual, expected, message) => { assert.strictEqual(actual, expected, message); checks += 1; };

// ---------- 1. 编排器必须真的消费绝对复查时间 ----------
const now = new Date('2026-11-10T13:30:00.000Z'); // 北京时间 21:30

const useAbsolute = resolveContinuationWait({ nextCheckAt: '2026-11-10T14:00:00.000Z' }, { now });
eq(useAbsolute.nextAttemptAt.toISOString(), '2026-11-10T14:00:00.000Z', '合法复查时间必须被直接采用');
eq(useAbsolute.nextAttemptInMinutes, 30, '间隔必须由复查时刻换算');
eq(useAbsolute.rejected, null, '合法复查时间不算回退');

// 普通续批（只有间隔字段）行为不变：仍是 1 分钟。
const normalRetry = resolveContinuationWait({ nextAttemptInMinutes: 1 }, { now });
eq(normalRetry.nextAttemptInMinutes, 1, '普通续批的 1 分钟节奏不得被改写');
eq(normalRetry.nextAttemptAt.toISOString(), new Date(now.getTime() + 60000).toISOString(), '普通续批仍按间隔排期');
eq(normalRetry.rejected, 'next_check_at_absent', '缺复查时刻要留回退原因');

// 非法、已过期、超上限都不能变成"无限等待"或"热循环"。
eq(resolveContinuationWait({ nextCheckAt: 'not-a-time' }, { now }).rejected, 'next_check_at_invalid', '非法时间必须回退');
eq(resolveContinuationWait({ nextCheckAt: '2026-11-10T13:00:00.000Z' }, { now }).rejected, 'next_check_at_past', '过去的复查时间必须回退');
eq(resolveContinuationWait({ nextCheckAt: '2026-11-10T13:30:00.000Z' }, { now }).rejected, 'next_check_at_past', '等于现在的复查时间同样按过期处理');
const beyond = resolveContinuationWait({ nextCheckAt: '2026-11-12T13:30:00.000Z' }, { now, maxAgeHours: 24 });
eq(beyond.rejected, 'next_check_at_beyond_max_age', '超过续批止损上限必须截断');
eq(beyond.nextAttemptAt.toISOString(), '2026-11-11T13:30:00.000Z', '截断到止损上限而不是放任等待');
const zeroGap = resolveContinuationWait({ nextAttemptInMinutes: 0 }, { now });
eq(zeroGap.nextAttemptInMinutes, 1, '间隔下限 1 分钟，禁止零延迟热循环');

// 编排器：续批分支必须调用它并写回统一字段，否则改动等于没接上。
ok(/const wait = resolveContinuationWait\(result, \{ maxAgeHours: continuationMaxAgeHours \}\)/.test(orchestrator),
  '续批分支必须消费 resolveContinuationWait');
ok(/result\.nextAttemptAt = wait\.nextAttemptAt\.toISOString\(\)/.test(orchestrator),
  '复查时刻必须写回 nextAttemptAt 供 continueSlot 使用');
ok(/await continueSlot\(claimed\.slot_id, result, result\.nextAttemptInMinutes, runId, executionToken\)/.test(orchestrator),
  '续批间隔必须使用解析后的值');
ok(!/result\.nextAttemptInMinutes \|\| 1/.test(orchestrator), '不得保留"取不到就一分钟"的旧写法');

// ---------- 2. 选股未就绪必须登记等待原因、阶段与剩余量 ----------
ok(/waitReason: 'selection_not_ready'/.test(refresh), '未就绪必须登记等待原因');
ok(/pendingStages: \['selection_period_computation'\]/.test(refresh), '必须声明待完成阶段');
ok(/remaining: Number\(result\.pendingCount \|\| 0\)/.test(refresh), '必须给出剩余待补数量');
ok(/nextCheckAt: nextSelectionRecheckAt\(\)/.test(refresh), '必须给出绝对复查时刻');
ok(/waitContext: \{/.test(refresh) && /periodKey: result\.periodKey \|\| context\.periodKey/.test(refresh),
  '必须给出目标市场与周期键');

// ---------- 3. 等待原因必须登记，且只在证据齐备时才算有效等待 ----------
const policy = waitReasonPolicy('selection_not_ready', 'stock_analysis_refresh');
ok(policy, '选股等待原因必须已登记');
eq(policy.maxWaitHours, 24, '选股等待不得超过续批止损时限');
eq(waitReasonPolicy('selection_not_ready', 'nav_snapshot'), null, '等待原因不得跨任务生效');
ok(Object.prototype.hasOwnProperty.call(WAIT_REASON_POLICIES, 'selection_not_ready'), '登记表必须显式包含该原因');
ok(/waitContext/.test(slotsSource), '续批止损摘要必须带上等待目标');

const future = '2026-11-10T14:00:00.000Z';
const waitingSlot = (summary = {}, overrides = {}) => ({
  job_code: 'stock_analysis_refresh',
  status: 'pending',
  next_attempt_at: future,
  result_summary: {
    continuationRequired: true,
    waitReason: 'selection_not_ready',
    pendingStages: ['selection_period_computation'],
    remaining: 11,
    nextAttemptAt: future,
    continuationStartedAt: new Date(now.getTime() - 3600000).toISOString(),
    waitContext: { market: 'HK', periodKey: 'D:2026-11-10' },
    ...summary,
  },
  ...overrides,
});

const waiting = slotWaitingState(waitingSlot(), now);
eq(waiting.exempt, true, '证据齐备的选股等待是有效等待');
eq(waiting.kind, 'evidence_wait', '等待类型必须是证据等待而不是普通续批');
eq(waiting.waitReasonAccepted, true, '等待原因必须被接受');
eq(waiting.remaining, 11, '剩余数量必须可用于展示');

const missingRemaining = slotWaitingState(waitingSlot({ remaining: undefined }), now);
eq(missingRemaining.exempt, false, '缺剩余数量的等待不得豁免止损');
eq(missingRemaining.kind, 'continuation', '证据不全只能算普通续批');

const expired = slotWaitingState(waitingSlot({
  continuationStartedAt: new Date(now.getTime() - 25 * 3600000).toISOString(),
}), now);
eq(expired.exempt, false, '超过 24 小时必须失去豁免');
eq(expired.waitReasonExpired, true, '超期必须显式可查');

const notDue = slotWaitingState(waitingSlot({}, { next_attempt_at: '2026-11-10T13:00:00.000Z' }), now);
eq(notDue.waiting, false, '已到期的等待不再是等待');

const otherJob = slotWaitingState(waitingSlot({}, { job_code: 'nav_snapshot' }), now);
eq(otherJob.exempt, false, '同一原因在其它任务上不豁免');

console.log(`OK selection-wait-wakeup: ${checks} 项续批复查节奏、等待证据与普通续批回归通过`);

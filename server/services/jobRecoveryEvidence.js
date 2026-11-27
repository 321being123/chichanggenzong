const layerSql = require('../repositories/jobRecoveryEvidenceRepository');
// 任务恢复的中立证据层：调度器和告警层共用，避免只凭单一 data_as_of 把槽位误判为已完成。
const { pool } = require('../db/connection');
const { getRegisteredJobDefinition, stageCompletionEvidence, jobConvergenceEnabled } = require('./jobDefinitions');
const repository = require('../repositories/jobRecoveryEvidenceRepository.js');

function businessDateText(value) {
  const text = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const date = value instanceof Date ? value : new Date(text);
  if (Number.isNaN(date.getTime())) return text.slice(0, 10);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const fields = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

function sameTargetScope(left, right) {
  const payload = row => row?.request_payload || {};
  const list = (row, key) => {
    const value = payload(row)[key];
    return value == null ? [] : Array.isArray(value) ? [...new Set(value.map(String))].sort() : null;
  };
  for (const key of ['targetCodes', 'targetFields']) {
    const a = list(left, key), b = list(right, key);
    if (!a || !b || JSON.stringify(a) !== JSON.stringify(b)) return false;
  }
  return ![left, right].some(row => String(payload(row).mode || '').includes('targeted') && !list(row, 'targetCodes')?.length);
}

// 接管旧槽必须比目标范围更严格：同一任务、同一业务日、同一阶段，且账户/市场、
// 日期区间、证券和字段范围全部一致，才算同一件事的后续执行。
// 跨业务日回退口径（ignoreBusinessDate）只放宽业务日，其余条件一项不减：
// 每天只跑一次的任务在同一业务日凑不出多次后续运行，业务日不同不代表目标范围不同。
function sameSlotRecoveryScope(left, right, options = {}) {
  if (!left || !right) return false;
  if (String(left.job_code || '') !== String(right.job_code || '')) return false;
  if (!options.ignoreBusinessDate && businessDateText(left.business_date) !== businessDateText(right.business_date)) return false;
  const payload = row => row.request_payload || {};
  if (String(payload(left).mode || 'core') !== String(payload(right).mode || 'core')) return false;
  for (const key of ['username', 'accountName', 'market', 'scopeKey']) {
    if (String(payload(left)[key] ?? '') !== String(payload(right)[key] ?? '')) return false;
  }
  // 业务身份字段必须逐一相等（F08）：SQL 侧 recoveryScopeFilter 用同一份清单，
  // 两侧任一遗漏都会得出"双重检查仍然错"的结论。
  for (const key of ['fromDate', 'throughDate', 'batchId', 'targetDate', 'targetTradeDate', 'quarter']) {
    if (String(payload(left)[key] ?? '') !== String(payload(right)[key] ?? '')) return false;
  }
  return sameTargetScope(left, right);
}

// 接管候选的完整范围条件必须先进 SQL 的 WHERE，再谈分页：只在 JS 里过滤会让
// “前 N 条都是别的目标”变成固定上限，后面的同范围成功永远找不到。
// targetCodes/targetFields 用 jsonb 双向包含表达集合相等（顺序无关、忽略重复），
// 与 sameTargetScope 的去重集合语义一致；SQL 之后仍由 sameSlotRecoveryScope 复核。
const { recoveryScopeFilter } = repository;

// 槽位版本必须是数据库精确值（微秒级）。JS Date 只保留毫秒，用 ±1 毫秒容差做“同版本”
// 判断会把 0.5 毫秒后写入的新一次续批误当成同一版本，从而覆盖新的执行意图。
// 因此只接受数据库返回的 updated_at::text（updated_at_exact）或带微秒的字符串；
// 拿不到精确版本时宁可不写入，也不退回容差比较。
function slotVersionText(slot) {
  const exact = slot && slot.updated_at_exact;
  if (typeof exact === 'string' && exact.trim()) return exact.trim();
  const raw = slot && slot.updated_at;
  if (typeof raw === 'string' && /\.\d{4,6}(?:[+-]\d{2}(?::\d{2})?|Z)$/.test(raw.trim())) return raw.trim();
  return null;
}

const WAITING_KIND_LABELS = { external: '等待外部来源', evidence_wait: '等待复查', continuation: '续批等待' };

// 等待原因必须绑定可核验的来源、适用任务和最长有效时间：任意字符串不能长期豁免止损。
// 只有这里登记的原因才按“证据等待”保留；未知原因保留在摘要里供排查，但不享受豁免。
const WAIT_REASON_POLICIES = Object.freeze({
  field_recheck_cooldown: {
    jobs: ['ipo_history_sync'],
    maxWaitHours: 720,
    evidenceFields: ['nextAttemptAt'],
    description: '资料字段待官方后续披露，按 Runner 返回的冷却时间复查',
  },
  // 方案 27.38 P1：日/周选股"输入未就绪"是等数据补齐的正常等待，但必须有复查时刻、
  // 待完成阶段和剩余数量才有资格算证据等待；缺口清空前一律不发布。
  // 上限不能按 24 小时写死：CN 的 stock_daily/stock_valuation 分区由工作日 08:00 的共享采集发布，
  // 周五 18:30 入队的槽要等到下周一 08:00（约 62.5h），春节/国庆跨休市更长（近年最长约 10 天）。
  // 24h 会让每周五和长假前最后一个交易日在**上游正常发布前**被误判止损并告警。
  // 336h（14 天）是明确硬上限：覆盖最长休市 + 下一交易日复核余量，超过仍按合同触发止损，
  // 不是无限豁免；证据字段缺任何一项仍立即退回普通续批。
  selection_not_ready: {
    jobs: ['stock_analysis_refresh'],
    maxWaitHours: 336,
    // 只有本原因允许把续批年龄上限从任务默认值延长到 maxWaitHours：
    // 其他已登记原因（如 field_recheck_cooldown）沿用各自原有续批止损语义，不因本次修订被放宽。
    extendsContinuationMaxAge: true,
    evidenceFields: ['nextAttemptAt', 'pendingStages', 'remaining'],
    description: '选股周期输入未就绪，按 Runner 给出的下一个交易日复查时刻等待，缺口清空前置为未发布',
  },
});

function waitReasonPolicy(reason, jobCode) {
  const key = String(reason || '').trim();
  const policy = WAIT_REASON_POLICIES[key];
  if (!key || !policy) return null;
  if (Array.isArray(policy.jobs) && policy.jobs.length && !policy.jobs.includes(String(jobCode || ''))) return null;
  return { key, ...policy };
}

// 就绪等待的三种合法原因：数据集锁争用、等待发布、等待依赖分区。
// 只用于校验摘要里的 waitKind，未知值一律按 null 处理，不猜。
const READINESS_WAIT_KINDS = Object.freeze(['lock', 'publication', 'dependency']);

/**
 * 阶段 3 任务码收敛的旧→新告警作用域映射（方案 5.4，对齐 ADR-0003）。
 *
 * 红线：
 * - 历史未关闭告警保留原 job_code 作用域，严禁批量清零或用空证据关闭。
 * - 只有经本映射查到「新任务的同数据集分区已发布且质量通过」或「新任务连续 3 次成功且 data_as_of 达标」
 *   的显式证据，才允许归档关闭；证据不足、跨任务、跨模式、跨市场一律不关。
 * - market_close:* / hk_rate / nav_snapshot / ipo_calendar_refresh / holiday_sync 任务码不变，登记为 unchanged。
 */
const LEGACY_JOB_ALIAS_GROUPS = Object.freeze([
  {
    id: 'cn-shared-eod-bond',
    legacy: [{ jobCode: 'convertible_bond_universe_refresh', modes: ['core', 'shared_eod', 'market_repair', 'repo_daily', 'stock_lifecycle'] }],
    successors: [
      { jobCode: 'cn_stock_eod_sync', datasets: ['bond_master', 'bond_daily', 'stock_daily', 'stock_valuation', 'stock_adj_factor', 'stock_suspend_calendar'] },
      { jobCode: 'convertible_bond_eod_sync', datasets: ['bond_master', 'bond_daily'] },
    ],
  },
  {
    id: 'cn-financial-incremental',
    legacy: [{ jobCode: 'company_financial_incremental_sync', modes: ['core', 'selection_inputs:CN'] }],
    successors: [{ jobCode: 'cn_stock_eod_sync', datasets: ['stock_financial_reports'] }],
  },
  {
    id: 'hk-financial-rules-calendar',
    legacy: [
      { jobCode: 'company_financial_incremental_sync', modes: ['selection_inputs:HK'] },
      { jobCode: 'hk_trade_rules_sync', modes: ['core'] },
      { jobCode: 'hk_trade_calendar_sync', modes: ['core'] },
    ],
    successors: [{ jobCode: 'hk_stock_eod_sync', datasets: ['hk_trade_rules', 'hk_trade_calendar', 'stock_financial_reports'] }],
  },
  {
    id: 'cn-index-volatility',
    legacy: [{ jobCode: 'index_recent', modes: ['core'] }, { jobCode: 'market_volatility_sync', modes: ['core'] }],
    successors: [{ jobCode: 'cn_stock_eod_sync', datasets: ['index_daily', 'market_volatility'] }],
  },
  {
    id: 'bond-motive-inputs',
    legacy: [{ jobCode: 'convertible_bond_revision_motive_inputs_sync', modes: ['core'] }],
    successors: [{ jobCode: 'convertible_bond_eod_sync', datasets: ['bond_motive_inputs'] }],
  },
  {
    id: 'exchange-announcements',
    legacy: [
      { jobCode: 'convertible_bond_announcement_history_sync', modes: ['core', 'calendar', 'analysis_inputs', 'analysis_inputs_targeted'] },
      { jobCode: 'arbitrage_sync', modes: ['core', 'cash_dividends', 'stock_swap_settle'] },
      { jobCode: 'ipo_history_sync', modes: ['core', 'prediction_ready', 'enrichment'] },
    ],
    successors: [{
      jobCode: 'exchange_announcements_sync',
      datasets: ['bond_announcement_facts', 'bond_issuance_events', 'bond_redemption_events', 'bond_listing_liquidity', 'bond_analysis_inputs',
        'arbitrage_cases', 'stock_cash_dividend_facts', 'stock_swap_settlements', 'ipo_history'],
    }],
  },
  {
    id: 'bond-analytics',
    legacy: [{ jobCode: 'convertible_bond_valuation_refresh', modes: ['core'] }, { jobCode: 'bond_safety_refresh', modes: ['core'] }],
    successors: [{ jobCode: 'bond_analytics_refresh', datasets: ['bond_valuation', 'bond_analysis_snapshot', 'bond_safety_snapshot'] }],
  },
  {
    id: 'stock-analytics',
    legacy: [{
      jobCode: 'stock_analysis_refresh',
      modes: ['core', 'stock_analysis_hk', 'selection_archive_light', 'selection_periodic', 'selection_daily', 'selection_weekly',
        'selection_quarterly', 'selection_preview', 'selection_backtest', 'selection_inputs'],
    }],
    successors: [{
      jobCode: 'stock_analytics_refresh',
      datasets: ['stock_analysis_snapshot', 'stock_selection_daily_cn', 'stock_selection_daily_hk', 'stock_selection_weekly_cn',
        'stock_selection_weekly_hk', 'stock_selection_shadow_cn', 'stock_selection_shadow_hk'],
    }],
  },
  {
    id: 'system-retention',
    legacy: [{ jobCode: 'site_analytics_retention', modes: ['core'] }, { jobCode: 'storage_retention', modes: ['core'] }],
    // 系统清理类没有金融数据集分区可核对，只认「新任务连续 3 次成功且 data_as_of 达标」。
    successors: [{ jobCode: 'system_retention', datasets: [], requireConsecutiveSuccesses: 3 }],
  },
]);

// 任务码不变的家族：显式登记，查询时返回 unchanged，禁止套用别名归档。
const LEGACY_JOB_UNCHANGED = Object.freeze([
  { jobCode: 'market_close:A股' }, { jobCode: 'market_close:可转债' }, { jobCode: 'market_close:LOF/ETF' },
  { jobCode: 'market_close:港股' }, { jobCode: 'hk_rate' }, { jobCode: 'nav_snapshot' },
  { jobCode: 'ipo_calendar_refresh' }, { jobCode: 'holiday_sync' },
]);

const LEGACY_JOB_ALIAS_MAP = Object.freeze((() => {
  const map = {};
  for (const group of LEGACY_JOB_ALIAS_GROUPS) {
    for (const legacy of group.legacy) {
      for (const mode of legacy.modes) {
        const key = `${legacy.jobCode}|${mode}`;
        if (!map[key]) {
          map[key] = { groupId: group.id, legacyJobCode: legacy.jobCode, legacyMode: mode, successors: group.successors, unchanged: false };
        }
      }
    }
  }
  for (const item of LEGACY_JOB_UNCHANGED) {
    map[`${item.jobCode}|*`] = { groupId: 'unchanged', legacyJobCode: item.jobCode, legacyMode: '*', successors: [], unchanged: true };
  }
  return map;
})());

// 计划槽的“旧模式”键：selection_inputs 还必须区分 CN/HK，否则会把港股证据当成 A 股恢复证据。
function legacyJobModeOf(payload = {}) {
  const mode = String(payload && payload.mode || 'core');
  const market = String(payload && payload.market || '').toUpperCase();
  if (mode === 'selection_inputs' && market) return `${mode}:${market}`;
  return mode;
}

function legacyJobAlias(jobCode, mode) {
  const code = String(jobCode || '');
  if (!code) return null;
  if (mode && LEGACY_JOB_ALIAS_MAP[`${code}|${String(mode)}`]) return LEGACY_JOB_ALIAS_MAP[`${code}|${String(mode)}`];
  return LEGACY_JOB_ALIAS_MAP[`${code}|*`] || null;
}

/**
 * 旧任务码告警的映射证据核验：只返回 recovered=true 需要同时满足
 * ① 新任务同数据集分区在旧告警目标日已发布且质量通过；或
 * ② 新任务在原告警之后连续 3 次成功且 data_as_of 达到该次槽位的目标日。
 */
async function verifyLegacyAliasEvidence(alert, query = (sql, params) => repository.runQuery(sql, params)) {
  // 回退开关开启时旧任务仍在自动排程，不能用新任务成功替代旧告警的恢复证据。
  if (!jobConvergenceEnabled()) return null;
  const jobCode = String(alert && alert.job_code || '');
  if (!jobCode) return null;
  let legacySlot = null;
  if (alert.slot_id != null) {
    const { rows } = await layerSql.loadLegacyAlertSlot(query, [], [alert.slot_id]);
    legacySlot = rows[0] || null;
  }
  const mode = legacySlot ? legacyJobModeOf(legacySlot.request_payload || {}) : null;
  const alias = legacyJobAlias(jobCode, mode);
  if (!alias || alias.unchanged || !alias.successors.length) return null;
  if (!mode && ['company_financial_incremental_sync', 'stock_analysis_refresh'].includes(jobCode)) {
    // 多模式任务的旧槽缺失时无法判定 CN/HK 或选股渠道作用域，宁可留给人工核对。
    return { recovered: false, reason: 'legacy_alias_mode_unknown', evidence: { jobCode, aliasGroup: alias.groupId } };
  }
  // 告警必须带发生时间：否则“后续成功”无从界定，空证据不得关闭。
  const since = alert.last_seen_at ? new Date(alert.last_seen_at) : null;
  if (!since || Number.isNaN(since.getTime())) {
    return { recovered: false, reason: 'legacy_alias_alert_time_missing', evidence: { jobCode } };
  }
  const { expectedDataDate } = require('./jobScheduleSlots');
  const { isPublishedDatasetEvidence, resolveDatasetScope } = require('./datasetPartitionRegistry');
  const businessDate = legacySlot ? businessDateText(legacySlot.business_date) : null;
  const attempts = [];
  for (const successor of alias.successors) {
    const partitionKey = businessDate ? expectedDataDate(successor.jobCode, businessDate) : null;
    let datasetEvidence = null;
    if (partitionKey && Array.isArray(successor.datasets) && successor.datasets.length) {
      const { rows } = await layerSql.loadLegacyAliasDatasetEvidence(query, [], [successor.datasets, partitionKey]);
      const scoped = successor.datasets.map(code => {
        const scopeKey = resolveDatasetScope(code, {});
        const row = rows.find(item => String(item.dataset_code) === code && String(item.scope_key || '') === String(scopeKey || ''));
        return { datasetCode: code, scopeKey, published: Boolean(row) && isPublishedDatasetEvidence(row, code), partitionKey };
      });
      datasetEvidence = { partitionKey, complete: scoped.every(item => item.published), datasets: scoped };
      if (datasetEvidence.complete) {
        return {
          recovered: true,
          reason: null,
          evidence: {
            mode: 'legacy_alias_dataset_partition',
            legacyJobCode: jobCode, legacyMode: mode, aliasGroup: alias.groupId,
            successorJobCode: successor.jobCode, businessDate, partitionKey,
            datasets: scoped,
            legacySlotId: legacySlot ? legacySlot.slot_id : null,
          },
        };
      }
    }
    const required = Math.max(Number(successor.requireConsecutiveSuccesses || 3), 1);
    const { rows: sequenceRows } = await layerSql.loadLegacySuccessorSuccesses(query, [], [successor.jobCode, since.toISOString(), required]);
    const sequence = sequenceRows.map(row => {
      const slotBusinessDate = businessDateText(row.business_date);
      const expected = /^\d{4}-\d{2}-\d{2}$/.test(slotBusinessDate)
        ? expectedDataDate(successor.jobCode, slotBusinessDate) : null;
      const dataAsOf = row.data_as_of ? businessDateText(row.data_as_of) : null;
      const summary = row.result_summary && typeof row.result_summary === 'object' ? row.result_summary : {};
      return {
        slotId: row.slot_id, jobCode: row.job_code, status: row.status,
        businessDate: slotBusinessDate, expectedDataAsOf: expected,
        dataAsOf: dataAsOf || (summary.dataAsOf ? businessDateText(summary.dataAsOf) : null),
        scheduledFor: row.scheduled_for,
      };
    });
    const consecutive = sequence.length === required && sequence.every(item => item.status === 'succeeded'
      && /^\d{4}-\d{2}-\d{2}$/.test(String(item.dataAsOf || ''))
      && (!item.expectedDataAsOf || item.dataAsOf >= item.expectedDataAsOf)
      && new Date(item.scheduledFor).getTime() > since.getTime());
    attempts.push({ successorJobCode: successor.jobCode, datasetEvidence, sequence, consecutive });
    if (consecutive) {
      return {
        recovered: true,
        reason: null,
        evidence: {
          mode: 'legacy_alias_three_consecutive_successes',
          legacyJobCode: jobCode, legacyMode: mode, aliasGroup: alias.groupId,
          successorJobCode: successor.jobCode, businessDate,
          requiredCount: required, sequence,
          legacySlotId: legacySlot ? legacySlot.slot_id : null,
        },
      };
    }
  }
  return {
    recovered: false,
    reason: 'legacy_alias_evidence_insufficient',
    evidence: { legacyJobCode: jobCode, legacyMode: mode, aliasGroup: alias.groupId, businessDate, attempts },
  };
}

// “有效等待”只由明确证据和未到期的复查时间构成：done 只表示本批结束，
// attempt_count 只表示当前重试计数，二者都不能单独证明工作完成或任务漏跑。
// 复查日期展示统一走上海业务日（businessDateText），不能用 toISOString().slice(0,10)。
function slotWaitingState(slot, now = new Date()) {
  const summary = slot && slot.result_summary && typeof slot.result_summary === 'object' ? slot.result_summary : {};
  const rawUntil = (slot && slot.next_attempt_at) || summary.nextAttemptAt || summary.recoverAt || null;
  const parsed = rawUntil ? new Date(rawUntil) : null;
  const until = parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
  const current = new Date(now).getTime();
  const due = Boolean(until && until.getTime() > current);
  const pendingStages = Array.isArray(summary.pendingStages) ? summary.pendingStages.filter(Boolean) : [];
  const remainingValue = Number(summary.remaining ?? summary.remainingCount);
  const remaining = Number.isFinite(remainingValue) ? remainingValue : null;
  const waitReason = String(summary.waitReason || '').trim();
  const waitingExternal = (slot && slot.status === 'waiting_external') || summary.waitingExternal === true;
  // 就绪等待（发布/锁/依赖）与外部保护等待分开：它不吃失败预算，也不参与
  // “连续三次缺 recover_at 才阻塞”的规则，只按任务定义的检查点和硬截止推进。
  const waitingReadiness = (slot && slot.status === 'waiting_readiness') || summary.waitingReadiness === true;
  const continuationRequired = summary.continuationRequired === true;
  const hasOutstanding = continuationRequired || pendingStages.length > 0 || (remaining || 0) > 0;
  const policy = waitReasonPolicy(waitReason, slot && slot.job_code);
  // 证据等待必须同时满足：原因已登记、有未来复查时间、证据字段齐备、未超过最长等待时限。
  // 复查时间的权威来源是调度列 next_attempt_at；摘要缺失时以列为准，不因字段位置差异失效。
  const evidenceSource = { ...summary };
  if (evidenceSource.nextAttemptAt == null && slot && slot.next_attempt_at) {
    evidenceSource.nextAttemptAt = slot.next_attempt_at;
  }
  const startedAt = Date.parse(summary.continuationStartedAt || '');
  const policyHours = policy ? Math.max(Number(policy.maxWaitHours || 0), 1) : 0;
  const policyExpired = Boolean(policy) && Number.isFinite(startedAt) && policyHours > 0
    && current - startedAt >= policyHours * 3600000;
  const evidenceComplete = Boolean(policy) && (policy.evidenceFields || [])
    .every(field => evidenceSource[field] != null && String(evidenceSource[field]).trim() !== '');
  const evidenceWait = Boolean(policy) && due && evidenceComplete && !policyExpired;
  const kind = !due ? null
    : waitingReadiness ? 'readiness'
      : waitingExternal ? 'external'
        : hasOutstanding ? (evidenceWait ? 'evidence_wait' : 'continuation')
          : null;
  const state = {
    waiting: Boolean(kind),
    // exempt 才是“可以免于续批止损”的等待：外部来源等待、有证据的复查等待和就绪等待。
    // 普通续批（kind=continuation）仍属正常调度，不算漏跑，但必须受续批上限约束。
    exempt: kind === 'external' || kind === 'evidence_wait' || kind === 'readiness',
    kind: kind || null,
    waitKind: waitingReadiness && READINESS_WAIT_KINDS.includes(String(summary.waitKind || ''))
      ? String(summary.waitKind) : null,
    readinessEscalateAt: waitingReadiness && summary.readinessEscalateAt ? summary.readinessEscalateAt : null,
    readinessStopAt: waitingReadiness && summary.readinessStopAt ? summary.readinessStopAt : null,
    until: until ? until.toISOString() : null,
    untilDate: until ? businessDateText(until) : null,
    pendingStages,
    remaining,
    waitReason: waitReason || null,
    waitReasonAccepted: evidenceWait,
    waitReasonPolicy: policy ? policy.key : null,
    waitReasonExpired: policyExpired,
    continuationRequired,
    waitingExternal,
    label: null,
  };
  if (state.waiting) {
    const parts = [WAITING_KIND_LABELS[state.kind] || '等待'];
    if (state.untilDate) parts.push(`至 ${state.untilDate}`);
    if (state.pendingStages.length) parts.push(`阶段 ${state.pendingStages.join('/')}`);
    if (state.remaining != null && state.remaining > 0) parts.push(`剩余 ${state.remaining} 项`);
    state.label = parts.join('，');
  }
  return state;
}

async function verifySlotRecoveryEvidence(slot, query = (sql, params) => repository.runQuery(sql, params), options = {}) {
  if (!slot || !slot.job_code || !['succeeded', 'degraded'].includes(options.candidateStatus || slot.status)) {
    return { recovered: false, reason: 'slot_not_successful', evidence: slot || null };
  }
  if (options.alertType && options.alertType !== 'dependency_blocked'
    && ['data_quality', 'dependency_blocked'].includes(String(options.alertType))) {
    return { recovered: false, reason: 'data_bound_alert_requires_dataset_evidence', evidence: slot };
  }
  const definition = getRegisteredJobDefinition(slot.job_code);
  if (!definition) {
    return { recovered: false, reason: 'unknown_job_definition', evidence: { slot } };
  }
  const { rows: runRows } = await layerSql.verifySlotRecoveryEvidenceLayerQuery1(query, [], [slot.slot_id]);
  const run = runRows[0] || null;
  if (!run || run.status !== 'done' || (run.slot_id != null && String(run.slot_id) !== String(slot.slot_id))) {
    return { recovered: false, reason: 'successful_run_evidence_missing', evidence: { slot, run } };
  }
  const runResult = run.result_json && typeof run.result_json === 'object' ? run.result_json : {};
  if (runResult.ok === false || runResult.status === 'failed' || runResult.error) {
    return { recovered: false, reason: 'successful_run_result_failed', evidence: { slot, run } };
  }
  const summary = { ...(slot.result_summary && typeof slot.result_summary === 'object' ? slot.result_summary : {}), ...runResult };
  const failedDatasets = Array.isArray(summary.failedDatasets) ? summary.failedDatasets.filter(Boolean) : [];
  const pendingStages = Array.isArray(summary.pendingStages) ? summary.pendingStages.filter(Boolean) : [];
  if (summary.continuationRequired === true || pendingStages.length || failedDatasets.length) {
    return { recovered: false, reason: 'run_stages_incomplete', evidence: { slot, run, failedDatasets, pendingStages, continuationRequired: summary.continuationRequired === true } };
  }
  const rawRequestedMode = String(slot.request_payload?.mode || (slot.request_payload?.targetCodes?.length ? 'targeted' : definition.mode || 'core'));
  // 旧HK盘后槽保存core，现役Runner一直执行postclose；兼容时额外核验原日事实分区。
  const legacyHkPostclose=rawRequestedMode==='core'&&slot.job_code==='hk_ipo_postclose';
  const requestedMode=legacyHkPostclose?'postclose':rawRequestedMode;
  if (summary.mode && String(summary.mode) !== requestedMode) return { recovered: false, reason: 'run_mode_mismatch', evidence: { slot, run } };
  const phase = definition.datasetPublicationByMode?.[requestedMode];
  const stageVerified = stageCompletionEvidence(definition, summary, slot.request_payload || {});
  if (phase?.requireStageComplete && summary.stageComplete !== true) return { recovered: false, reason: 'run_stages_incomplete', evidence: { slot, run } };
  if (phase?.requiresDataWatermark === false && !stageVerified) return { recovered: false, reason: 'target_scope_evidence_missing', evidence: { slot, run } };
  const datasets = phase ? [...new Set([...(phase.publish || []), ...(phase.requirePublished || [])])] : definition.producesDatasets || [];
  const { expectedDataDate } = require('./jobScheduleSlots');
  const { resolveDatasetScope, isPublishedDatasetEvidence } = require('./datasetPartitionRegistry');
  const businessDate = businessDateText(slot.business_date);
  if(slot.job_code==='nav_snapshot'&&requestedMode==='core'&&summary.requestedRange) {
    const expectedFrom=slot.request_payload?.fromDate||businessDate;
    const expectedThrough=slot.request_payload?.throughDate||businessDate;
    if(expectedThrough!==businessDate||summary.requestedRange.fromDate!==expectedFrom||summary.requestedRange.throughDate!==expectedThrough) {
      return {recovered:false,reason:'nav_requested_range_mismatch',evidence:{slot,run}};
    }
  }
  const partitionKey = expectedDataDate(slot.job_code, businessDate) || businessDate;
  let datasetEvidence = [];
  if ((definition.strictDatasetPublication||phase?.requireStageComplete||legacyHkPostclose) && datasets.length && partitionKey) {
    const { rows } = await layerSql.verifySlotRecoveryEvidenceLayerQuery2(query, [], [datasets, partitionKey]);
    const byCodeAndScope = new Map(rows.map(row => [`${row.dataset_code}:${row.scope_key}`, row]));
    datasetEvidence = datasets.map(code => {
      const expectedScopeKey = resolveDatasetScope(code,slot.request_payload||{});
      return byCodeAndScope.get(`${code}:${expectedScopeKey}`)
        || { dataset_code: code, scope_key: expectedScopeKey, partition_key: partitionKey, status: 'missing' };
    });
    // 统一到注册表的同一判据（F08）：不再各写一套"缺字段就算通过"。
    // legacyHkPostclose 仍需强制 quality_status='passed'。
    const allPublished = datasetEvidence.every(row => isPublishedDatasetEvidence(
      row, row.dataset_code, { requireQuality: legacyHkPostclose === true },
    ));
    if (!allPublished) return { recovered: false, reason: 'strict_dataset_evidence_missing', evidence: { slot, datasets: datasetEvidence } };
  }
  if (definition.requiresDataWatermark !== false && !stageVerified) {
    // data_as_of 从 PG 读出来是 Date；直接 String(...).slice(0,10) 会得到 “Fri Oct 2”，
    // 导致带水位的成功槽被误判为证据缺失。统一按上海时区业务日期规范化。
    const rawActual = slot.data_as_of || summary.dataAsOf || summary.data_as_of || summary.trade_date || '';
    const actual = rawActual ? businessDateText(rawActual) : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(actual) || !/^\d{4}-\d{2}-\d{2}$/.test(partitionKey) || actual < partitionKey) {
      return { recovered: false, reason: 'watermark_evidence_missing', evidence: { slot, run, expectedDataAsOf: partitionKey, actualDataAsOf: actual || null } };
    }
  }
  const expectedMode = requestedMode;
  if (summary.mode && String(summary.mode) !== expectedMode) {
    return { recovered: false, reason: 'run_mode_mismatch', evidence: { slot, run, expectedMode, actualMode: summary.mode } };
  }
  return { recovered: true, evidence: { mode: 'slot_success_and_dataset_evidence', slot, run, datasets: datasetEvidence, partitionKey } };
}

module.exports = {
  businessDateText, sameTargetScope, sameSlotRecoveryScope, recoveryScopeFilter, slotWaitingState,
  waitReasonPolicy, WAIT_REASON_POLICIES, verifySlotRecoveryEvidence, slotVersionText,
  LEGACY_JOB_ALIAS_MAP, LEGACY_JOB_ALIAS_GROUPS, legacyJobAlias, legacyJobModeOf, verifyLegacyAliasEvidence,
};

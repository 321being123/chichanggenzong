// 任务恢复的中立证据层：调度器和告警层共用，避免只凭单一 data_as_of 把槽位误判为已完成。
const { pool } = require('../db/connection');
const { getRegisteredJobDefinition, stageCompletionEvidence } = require('./jobDefinitions');
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
function sameSlotRecoveryScope(left, right) {
  if (!left || !right) return false;
  if (String(left.job_code || '') !== String(right.job_code || '')) return false;
  if (businessDateText(left.business_date) !== businessDateText(right.business_date)) return false;
  const payload = row => row.request_payload || {};
  if (String(payload(left).mode || 'core') !== String(payload(right).mode || 'core')) return false;
  for (const key of ['username', 'accountName', 'market', 'scopeKey']) {
    if (String(payload(left)[key] ?? '') !== String(payload(right)[key] ?? '')) return false;
  }
  for (const key of ['fromDate', 'throughDate']) {
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
});

function waitReasonPolicy(reason, jobCode) {
  const key = String(reason || '').trim();
  const policy = WAIT_REASON_POLICIES[key];
  if (!key || !policy) return null;
  if (Array.isArray(policy.jobs) && policy.jobs.length && !policy.jobs.includes(String(jobCode || ''))) return null;
  return { key, ...policy };
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
    : waitingExternal ? 'external'
      : hasOutstanding ? (evidenceWait ? 'evidence_wait' : 'continuation')
        : null;
  const state = {
    waiting: Boolean(kind),
    // exempt 才是“可以免于续批止损”的等待：外部来源等待和有证据的复查等待。
    // 普通续批（kind=continuation）仍属正常调度，不算漏跑，但必须受续批上限约束。
    exempt: kind === 'external' || kind === 'evidence_wait',
    kind: kind || null,
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
  const { rows: runRows } = await query(
    `SELECT id,slot_id,status,result_json,attempt_no,trigger_type
       FROM job_runs WHERE slot_id=$1 ORDER BY id DESC LIMIT 1`, [slot.slot_id]
  );
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
  const { resolveDatasetScope } = require('./datasetPartitionRegistry');
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
    const { rows } = await query(
      `SELECT dataset_code,scope_key,partition_key,status,is_stale,diagnostics
         FROM ops.dataset_partitions
        WHERE dataset_code=ANY($1::text[]) AND partition_key=$2::date`, [datasets, partitionKey]
    );
    const byCodeAndScope = new Map(rows.map(row => [`${row.dataset_code}:${row.scope_key}`, row]));
    datasetEvidence = datasets.map(code => {
      const expectedScopeKey = resolveDatasetScope(code,slot.request_payload||{});
      return byCodeAndScope.get(`${code}:${expectedScopeKey}`)
        || { dataset_code: code, scope_key: expectedScopeKey, partition_key: partitionKey, status: 'missing' };
    });
    const allPublished = datasetEvidence.every(row => {
      const diagnostics = row.diagnostics && typeof row.diagnostics === 'object' ? row.diagnostics : {};
      const qualityOk = legacyHkPostclose||['account_cash_income','repo_daily_rates','stock_cash_dividend_facts'].includes(row.dataset_code)
        ? diagnostics.quality_status==='passed':!diagnostics.quality_status || diagnostics.quality_status === 'passed';
      const queryOk = !diagnostics.query_status || ['success', 'passed', 'verified'].includes(diagnostics.query_status);
      return row.status === 'published' && !row.is_stale && qualityOk && queryOk;
    });
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
};

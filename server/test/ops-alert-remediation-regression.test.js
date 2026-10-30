const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { recoverySchedule, buildDatasetDiagnosticAlerts } = require('../services/jobOrchestrator');
const { cninfoApiName } = require('../services/cninfoAnnouncement');
const { closedCircuitApiNames } = require('../services/externalCallGuard');
const { verifyAlertScope } = require('../services/jobAlertMailer');
const { isDataAsOfFresh, resolveDatasetPartitionDate } = require('../services/jobScheduleSlots');
const { getJobDefinition, getRegisteredJobDefinition, validateJobDefinitionSources } = require('../services/jobDefinitions');
const { allCircuitsClosed, verifyScope } = require('../scripts/reconcileAlertHistory');
const { verifySlotRecoveryEvidence } = require('../services/jobRecoveryEvidence');

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function around(value, min, max) {
  return value >= min && value <= max;
}

const datasetScopedAlerts = buildDatasetDiagnosticAlerts({
  slot_id: 567, job_code: 'convertible_bond_announcement_history_sync', business_date: '2026-09-28',
}, {
  dataAsOf: '2026-09-28',
  missingDates: ['2026-09-29'],
  failedDatasets: ['bond_listing_liquidity'],
  datasets: [{ datasetCode: 'bond_issuance_events', partitionKey: '2026-09-28' }],
  datasetDiagnostics: {
    bond_issuance_events: { query_status: 'success', quality_status: 'stale' },
    bond_listing_liquidity: {
      query_status: 'success', quality_status: 'stale', coverage_status: 'incomplete',
      target_listing_date: '2026-09-29',
    },
  },
});
assert.deepStrictEqual(datasetScopedAlerts.map(alert => alert.scopeKey).sort(), [
  'bond_issuance_events:CN:2026-09-28',
  'bond_listing_liquidity:CN:2026-09-29',
], '每条数据集告警必须使用本数据集的目标分区日，不能借用其他数据集的缺失日期');

// 恢复时间与缺失恢复时间的退避必须可预测，并且不能把已经到期的时间再推迟 60 秒。
const future = new Date(Date.now() + 65 * 1000);
const exact = recoverySchedule({ result_summary: {} }, { recoverAt: future.toISOString() });
assert(around(exact.retryAt.getTime(), future.getTime() - 1000, future.getTime() + 1000));
assert.strictEqual(exact.missingCount, 0);
const past = recoverySchedule({ result_summary: {} }, { recoverAt: new Date(Date.now() - 1000).toISOString() });
assert(past.retryAt.getTime() <= Date.now() + 1000);
const missing1 = recoverySchedule({ result_summary: {} }, {});
const missing2 = recoverySchedule({ result_summary: { missingRecoverAtCount: 1 } }, {});
const missing3 = recoverySchedule({ result_summary: { missingRecoverAtCount: 2 } }, {});
assert.deepStrictEqual([missing1.missingCount, missing1.delayMinutes], [1, 30]);
assert.deepStrictEqual([missing2.missingCount, missing2.delayMinutes], [2, 60]);
assert.deepStrictEqual([missing3.missingCount, missing3.delayMinutes], [3, 120]);

assert.strictEqual(cninfoApiName('https://www.cninfo.com.cn/new/information/topSearch/query'), 'topSearch');
assert.strictEqual(cninfoApiName('https://www.cninfo.com.cn/new/hisAnnouncement/query'), 'hisAnnouncement');
assert.strictEqual(cninfoApiName('https://static.cninfo.com.cn/finalpage/a.pdf'), 'document');

const migration = require('./helpers/migration-source').readMigrationSource();
assert(migration.includes('151_alert_scope_and_cninfo_backoff'));
assert(migration.includes('scope_type TEXT'));
assert(migration.includes('consecutive_forbidden_count INTEGER'));
const mailer = read('server/services/jobAlertMailer.js') + read('server/repositories/jobAlertMailerRepository.js');
assert(mailer.includes("status === 'history'"));
assert(mailer.includes("scope_type=\'dataset\'"));
assert(mailer.includes("scope_type=\'source_endpoint\'"));
assert(mailer.includes("scope_type=\'slot\' AND scope_key=$1::text"));
// 告警恢复必须按“最近恢复序列”取证：先失败后连续成功要能收敛，最新再次失败不得收敛。
assert(mailer.includes('RECOVERY_SEQUENCE_STATUSES') && mailer.includes('ORDER BY scheduled_for DESC,slot_id DESC'),
  '告警恢复必须按最近计划时间取候选，不能取最早的失败记录');
assert(!/ORDER BY scheduled_for ASC,slot_id ASC/.test(mailer), '告警恢复不得再按最早候选取数');
assert(/loadRecentRecoverySequenceLayerQuery1\(query,\s*\[statusIndex,\s*recoveryScope\.sql,\s*limitIndex\]/.test(mailer)
  && /status = ANY\(\$\$\{parts\[0\]\}::text\[\]\)/.test(mailer), '只有已产生结果的后续实例才能进入恢复序列');
assert.deepStrictEqual(closedCircuitApiNames([{ api_name: '*' }, { api_name: 'topSearch' }, { api_name: '*' }]), ['*', 'topSearch']);
{
  const definition = getJobDefinition('hk_rate');
  const now = new Date('2026-09-15T12:00:00Z');
  assert.strictEqual(definition.freshnessMode, 'max_age');
  assert.strictEqual(isDataAsOfFresh('2026-09-14T12:00:01Z', '2026-09-15', definition, now), true,
    '港币汇率小于24小时应视为新鲜');
  assert.strictEqual(isDataAsOfFresh('2026-09-14T12:00:00Z', '2026-09-15', definition, now), false,
    '港币汇率达到24小时必须过期');
}
const orchestrator = read('server/services/jobOrchestrator.js') + read('server/repositories/jobOrchestratorRepository.js');
assert(orchestrator.includes('missingRecoverAtCount'));
assert(orchestrator.includes('scopeType: \'dataset\''));
const partitionService = read('server/services/datasetPartitions.js');
const latestFunction = partitionService.slice(partitionService.indexOf('async function getLatestPublishedPartition'));
assert(!latestFunction.includes('options.diagnostics'));
// 发布成功→告警恢复的契约改为依赖倒置钩子：数据层按相同参数调用钩子，告警侧注册 resolveDatasetAlerts。
assert(partitionService.includes('_onDatasetPublished(datasetCode, scopeKey, partitionKey)'));
const alertMailerSource = read('server/services/jobAlertMailer.js') + read('server/repositories/jobAlertMailerRepository.js');
assert(alertMailerSource.includes('setDatasetPublishedHook(resolveDatasetAlerts)'));

const holiday = read('server/config/holidays.js');
assert(holiday.includes("process.env.HOLIDAY_CONFIG_PATH"));
assert(holiday.includes('function atomicReplace'));
assert(holiday.includes('fs.rmSync(backup'));
const serverUnit = read('deploy/portfolio-server.service');
const workerUnit = read('deploy/portfolio-worker.service');
assert(serverUnit.includes('ReadWritePaths=/opt/portfolio/data'));
assert(workerUnit.includes('ReadWritePaths=/opt/portfolio/data'));
assert(!serverUnit.includes('ReadWritePaths=/opt/portfolio/server/config'));
assert(!workerUnit.includes('ReadWritePaths=/opt/portfolio/server/config'));
const partitionRepair = read('server/scripts/repairHkTradeCalendarPartitions.js');
assert(partitionRepair.includes('CONFIRM_HK_CALENDAR_REPAIR'));
assert(partitionRepair.includes('previous_target'));
const alertRepair = read('server/scripts/reconcileAlertHistory.js');
assert(alertRepair.includes('--alert-ids'));
assert(alertRepair.includes('CONFIRM_ALERT_RECONCILIATION'));

const cninfoPy = read('ipo-report/external_call_guard.py');
assert(cninfoPy.includes('def _record_forbidden'));
assert(cninfoPy.includes('consecutive_forbidden_count'));
assert(cninfoPy.includes('state["blocked"]'));
assert(cninfoPy.includes('self.credential_profile') && cninfoPy.includes('self.budget_window'));
assert(cninfoPy.includes('RETURNING api_name') && !cninfoPy.includes("scope_type='source_endpoint'"),
  'Python Guard 只关闭熔断，来源告警必须交给 Node 统一证据核对器');
assert(mailer.includes('reconcileRecoveredSourceAlerts'), '健康检查必须核对 Python 探测成功后的来源告警');
for (const relative of [
  'ipo-report/ipo_lib_common.py', 'ipo-report/ipo_lib_fetch.py',
  'ipo-report/backfill_lottery_rate.py', 'ipo-report/backfill_bond_shd.py',
]) {
  assert(!read(relative).match(/http:\/\/(?:www|static)\.cninfo\.com\.cn/), `${relative} 仍有 CNINFO 明文 HTTP`);
}
const ipoSyncPy = read('ipo-report/ipo_history_sync.py');
assert(ipoSyncPy.includes('--target-codes') && ipoSyncPy.includes('--apply-targeted'));
assert(ipoSyncPy.includes('--confirm-production') && ipoSyncPy.includes('only_codes=target_codes'));
assert(ipoSyncPy.includes('"credentialProfile"') && ipoSyncPy.includes('"budgetWindow"'));
const ipoSyncJob = read('server/jobs/ipoHistorySync.js') + read('server/repositories/ipoHistorySyncRepository.js');
assert(ipoSyncJob.includes('failure.credentialProfile = structured.credentialProfile'));
assert(ipoSyncJob.includes('failure.budgetWindow = structured.budgetWindow'));

async function verifyReconciliationEvidence() {
  assert.strictEqual(allCircuitsClosed([]), false, '没有熔断记录不能作为来源恢复证据');
  assert.strictEqual(allCircuitsClosed([{ state: 'closed' }]), true);
  assert.strictEqual(allCircuitsClosed([{ state: 'closed' }, { state: 'open' }]), false);

  const missingCircuit = await verifyScope(
    { alert_type: 'failure', scope_type: 'source_endpoint', scope_key: 'cninfo:topSearch' },
    async () => ({ rows: [] })
  );
  assert.strictEqual(missingCircuit.recovered, false);
  assert.strictEqual(missingCircuit.reason, 'circuit_evidence_missing');

  const recoveredSource = await verifyAlertScope(
    {
      alert_type: 'failure', scope_type: 'source_endpoint', scope_key: 'cninfo:*',
      last_seen_at: '2026-09-06T08:00:00.000Z',
    },
    async () => ({ rows: [
      { source: 'cninfo', api_name: '*', state: 'closed', last_success_at: '2026-09-06T08:01:00.000Z' },
    ] })
  );
  assert.strictEqual(recoveredSource.recovered, true, '来源探测成功且全部熔断关闭后才能自动关闭告警');

  let sourceQuery;
  const wildcardMustNotRecoverConcrete = await verifyAlertScope(
    {
      alert_type: 'failure', scope_type: 'source_endpoint', scope_key: 'cninfo:topSearch',
      last_seen_at: '2026-09-06T08:00:00.000Z',
    },
    async (sql, params) => {
      sourceQuery = { sql, params };
      return { rows: [{ source: 'cninfo', api_name: '*', state: 'closed', last_success_at: '2026-09-06T08:01:00.000Z' }] };
    }
  );
  assert.strictEqual(wildcardMustNotRecoverConcrete.recovered, false, '来源通配熔断不得恢复具体接口告警');
  assert.deepStrictEqual(sourceQuery.params, ['cninfo', 'topSearch'], '具体接口告警必须按精确 api_name 查询');

  const unknownAlert = await verifyAlertScope(
    { alert_type: 'new_unknown_fault', scope_type: 'slot', scope_key: '10' },
    async () => { throw new Error('未知告警类型不应访问恢复证据查询'); }
  );
  assert.strictEqual(unknownAlert.recovered, false);
  assert.strictEqual(unknownAlert.reason, 'unknown_alert_type_requires_manual_review');

  // 严格接管证据：只有同日同阶段同范围、运行 done、阶段完整且水位/分区通过才算恢复。
  // 只比较状态字符串会把“本批结束”当成“工作完成”，也会让不同阶段互相抵消。
  const JOB_CODE = 'market_close:A股';
  const BUSINESS_DATE = '2026-09-06';
  function successSlot({ slotId, scheduledFor, jobCode = JOB_CODE, businessDate = BUSINESS_DATE,
    payload = { mode: 'core' }, summary = {} }) {
    return {
      slot_id: slotId, job_code: jobCode, business_date: businessDate, status: 'succeeded',
      scheduled_for: scheduledFor, request_payload: payload,
      result_summary: { ok: true, mode: payload.mode || 'core', dataAsOf: businessDate, ...summary },
      data_as_of: `${businessDate}T00:00:00.000Z`,
    };
  }
  function evidenceQuery(original, later, options = {}) {
    return async (sql, params) => {
      if (sql.includes('FROM job_runs')) {
        const slotId = params && params[0];
        const candidate = (options.runs || later).find(row => String(row.slot_id) === String(slotId));
        return { rows: candidate ? [{
          id: Number(slotId) + 1000, slot_id: candidate.slot_id, status: options.runStatus || 'done',
          attempt_no: 1, trigger_type: 'scheduled', result_json: options.runResult || { ...candidate.result_summary },
        }] : [] };
      }
      if (sql.includes('FROM ops.dataset_partitions')) return { rows: options.partitions || [] };
      if (sql.includes('FROM ops.job_schedule_slots WHERE slot_id=$1')) return { rows: [original] };
      return { rows: later };
    };
  }
  const original = {
    slot_id: 10, job_code: JOB_CODE, business_date: BUSINESS_DATE, status: 'failed',
    scheduled_for: '2026-09-06T08:00:00.000Z', updated_at: '2026-09-06T08:30:00.000Z',
    request_payload: { mode: 'core' },
  };
  const laterSuccesses = [
    successSlot({ slotId: 13, scheduledFor: '2026-09-09T08:00:00.000Z' }),
    successSlot({ slotId: 12, scheduledFor: '2026-09-08T08:00:00.000Z' }),
    successSlot({ slotId: 11, scheduledFor: '2026-09-07T08:00:00.000Z' }),
  ];
  const query = evidenceQuery(original, laterSuccesses);
  const recoveredSlot = await verifyScope(
    { alert_type: 'failure', scope_type: 'slot', scope_key: '10', job_code: JOB_CODE }, query
  );
  assert.strictEqual(recoveredSlot.recovered, true, '历史运行失败应能用连续三次后续完整成功作为人工对账证据');
  assert.strictEqual(recoveredSlot.evidence.mode, 'three_later_job_successes');
  assert.strictEqual(recoveredSlot.evidence.verifications.length, 3, '每条后续成功都必须逐条通过严格证据');

  // 部分完成（done 但 continuationRequired）不能算成功，也不能用来关闭旧告警。
  const partialRecovered = await verifyScope(
    { alert_type: 'failure', scope_type: 'slot', scope_key: '10', job_code: JOB_CODE },
    evidenceQuery(original, [successSlot({ slotId: 11, scheduledFor: '2026-09-07T08:00:00.000Z' })], {
      runResult: { ok: false, mode: 'core', stageComplete: false, continuationRequired: true, pendingStages: ['enrichment'] },
    })
  );
  assert.strictEqual(partialRecovered.recovered, false, '本批结束但仍有未完成阶段时不得自动恢复');

  // 正常等待（官方未披露/字段复查冷却）不是故障：不自动关闭，并归入“正常等待”处置分类。
  const { classifyAlertDisposition } = require('../services/jobAlertMailer');
  // 2026-10-30：样本原先写死 nextAttemptAt，过了那个时点就变成"已到期"，断言会随真实时钟失效；
  // 改为相对当前时刻的固定偏移，「未到复查时间」的语义在任意日期都成立，判定逻辑本身未改。
  const pendingRecheckAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const waitingSlot = {
    slot_id: 30, job_code: 'ipo_history_sync', business_date: '2026-10-23', status: 'pending',
    scheduled_for: '2026-10-23T11:35:00.000Z', request_payload: { mode: 'enrichment' },
    result_summary: {
      continuationRequired: true, waitReason: 'field_recheck_cooldown', pendingStages: ['enrichment'], remaining: 1,
      nextAttemptAt: pendingRecheckAt,
    },
    next_attempt_at: pendingRecheckAt,
  };
  const waitingVerification = await verifyScope(
    { alert_type: 'failure', scope_type: 'slot', scope_key: '30', job_code: 'ipo_history_sync', alert_type: 'failure' },
    evidenceQuery(waitingSlot, [], {})
  );
  assert.strictEqual(waitingVerification.recovered, false, '未到复查时间的等待不得自动关闭告警');
  assert.strictEqual(waitingVerification.reason, 'waiting_evidence_not_due');
  assert.strictEqual(waitingVerification.evidence.waiting.remaining, 1);
  assert.deepStrictEqual(classifyAlertDisposition(
    { alert_type: 'failure', job_code: 'ipo_history_sync' }, waitingVerification
  ).disposition, 'normal_waiting', '正常等待必须与故障分开记录');

  // F4/F7：等待原因必须绑定登记来源、证据字段和最长时限；复查日期按上海业务日显示。
  {
    const { slotWaitingState, waitReasonPolicy } = require('../services/jobRecoveryEvidence');
    const now = new Date('2026-10-26T04:00:00.000Z'); // 上海 12:00
    const future = '2026-10-30T02:00:00.000Z';
    const waitingSlotFixture = (summary, overrides = {}) => ({
      job_code: 'ipo_history_sync', status: 'pending', next_attempt_at: future,
      result_summary: {
        continuationRequired: true, pendingStages: ['enrichment'], remaining: 1, nextAttemptAt: future, ...summary,
      },
      ...overrides,
    });
    const unverified = slotWaitingState(waitingSlotFixture({ waitReason: 'unverified_custom_reason' }), now);
    assert.strictEqual(unverified.exempt, false, '未登记原因不得豁免续批止损');
    assert.strictEqual(unverified.waitReasonAccepted, false);
    assert.strictEqual(unverified.kind, 'continuation', '未登记原因只能算普通续批');

    const expired = slotWaitingState(waitingSlotFixture({
      waitReason: 'field_recheck_cooldown',
      continuationStartedAt: new Date(now.getTime() - 800 * 3600000).toISOString(),
    }), now);
    assert.strictEqual(expired.exempt, false, '已登记原因超过最长等待时限必须失效');
    assert.strictEqual(expired.waitReasonExpired, true);

    const accepted = slotWaitingState(waitingSlotFixture({
      waitReason: 'field_recheck_cooldown',
      continuationStartedAt: new Date(now.getTime() - 30 * 3600000).toISOString(),
    }), now);
    assert.strictEqual(accepted.exempt, true, '已登记原因未到期且未超时限必须保留');

    const wrongJob = slotWaitingState(waitingSlotFixture({ waitReason: 'field_recheck_cooldown' }, { job_code: 'nav_snapshot' }), now);
    assert.strictEqual(wrongJob.exempt, false, '等待原因必须匹配适用任务');
    assert.strictEqual(waitReasonPolicy('field_recheck_cooldown', 'nav_snapshot'), null);
    assert(waitReasonPolicy('field_recheck_cooldown', 'ipo_history_sync'));

    // 上海零点（UTC 前一日 16:00）曾被显示成前一天，必须按共享业务日期转换。
    const midnightSlot = {
      job_code: 'ipo_history_sync', status: 'pending', next_attempt_at: null,
      result_summary: {
        continuationRequired: true, waitReason: 'field_recheck_cooldown', pendingStages: ['enrichment'], remaining: 1,
        nextAttemptAt: '2026-10-29T16:00:00.000Z',
      },
    };
    const midnight = slotWaitingState(midnightSlot, now);
    assert.strictEqual(midnight.untilDate, '2026-10-30', '上海零点必须显示当天，不能少一天');
    assert(midnight.label.includes('至 2026-10-30'), midnight.label);
    assert.strictEqual(slotWaitingState(waitingSlotFixture({ waitReason: 'field_recheck_cooldown' }), now).untilDate, '2026-10-30',
      '上海上午时间必须显示当天');
    const crossDay = slotWaitingState({
      job_code: 'ipo_history_sync', status: 'pending', next_attempt_at: null,
      result_summary: {
        continuationRequired: true, waitReason: 'field_recheck_cooldown', pendingStages: ['enrichment'], remaining: 1,
        nextAttemptAt: '2026-10-30T15:59:00.000Z',
      },
    }, now);
    assert.strictEqual(crossDay.untilDate, '2026-10-30', '上海 23:59 仍属当天');
  }
  assert.strictEqual(classifyAlertDisposition(
    { alert_type: 'failure', job_code: 'hk_ipo_preopen' }, { recovered: false, reason: 'successful_run_evidence_missing' }
  ).disposition, 'task_retired', '已下线任务归入任务下线，不是当前故障');
  assert.strictEqual(classifyAlertDisposition(
    { alert_type: 'recovery', job_code: JOB_CODE }, { recovered: false, reason: 'notification_only_alert' }
  ).disposition, 'not_a_fault');
  assert.strictEqual(classifyAlertDisposition(
    { alert_type: 'failure', job_code: JOB_CODE }, { recovered: true }
  ).disposition, 'true_recovery');
  assert.strictEqual(classifyAlertDisposition(
    { alert_type: 'duplicate_success', job_code: JOB_CODE }, { recovered: true }
  ).disposition, 'manual_disposition', '人工处置类型不得自动归类为恢复');

  // JOB-RECOVERY-TARGET-SCOPE-001：另一证券或另一字段成功，不能收敛原定向失败。
  const { sameTargetScope, sameSlotRecoveryScope } = require('../services/jobRecoveryEvidence');
  const targeted = {
    slot_id: 20, job_code: 'convertible_bond_announcement_history_sync', business_date: '2026-10-12',
    status: 'failed', scheduled_for: '2026-10-12T08:00:00.000Z', updated_at: '2026-10-12T08:30:00.000Z',
    request_payload: { mode: 'analysis_inputs_targeted', targetCodes: ['127040.SZ'] },
    result_summary: { timed_out: true },
  };
  const targetedPayload = { mode: 'analysis_inputs_targeted', targetCodes: ['127040.SZ'] };
  const targetedSummary = { stageComplete: true, codes: ['127040.SZ'], targetFields: [] };
  const other = successSlot({
    slotId: 14, scheduledFor: '2026-10-12T09:00:00.000Z', jobCode: targeted.job_code,
    businessDate: '2026-10-12', payload: { mode: 'analysis_inputs_targeted', targetCodes: ['110076.SH'] },
  });
  const scopeAlert = { alert_type: 'failure', scope_type: 'slot', scope_key: '20', job_code: targeted.job_code };
  for (const historical of [false, true]) {
    const checked = await verifyAlertScope(scopeAlert,
      evidenceQuery(targeted, Array(historical ? 3 : 1).fill(other)), { historical });
    assert.strictEqual(checked.recovered, false, '不能用另一转债的后续成功关闭原告警');
  }
  const matching = successSlot({
    slotId: 15, scheduledFor: '2026-10-12T09:30:00.000Z', jobCode: targeted.job_code,
    businessDate: '2026-10-12', payload: targetedPayload, summary: targetedSummary,
  });
  assert.strictEqual((await verifyAlertScope(scopeAlert, evidenceQuery(targeted, [matching]))).recovered, true,
    '同证券同字段的完整成功可以接管原定向失败');
  // 不同阶段不能互相抵消：候选查询必须带同阶段条件。
  const enrichmentSlot = { ...waitingSlot, result_summary: { ok: false, mode: 'enrichment' }, next_attempt_at: null, status: 'failed' };
  let scopeParams = null;
  await verifyAlertScope(
    { alert_type: 'failure', scope_type: 'slot', scope_key: '30', job_code: 'ipo_history_sync' },
    async (sql, params) => {
      if (sql.includes('FROM job_runs')) return { rows: [] };
      if (sql.includes('FROM ops.job_schedule_slots WHERE slot_id=$1')) return { rows: [enrichmentSlot] };
      scopeParams = params;
      return { rows: [] };
    }
  );
  assert.strictEqual(scopeParams[3], 'enrichment', '候选查询必须按同阶段过滤，core 不能收敛 enrichment');
  assert.strictEqual(sameTargetScope(targeted, other), false);
  assert.strictEqual(sameTargetScope({ request_payload: { targetCodes: ['A', 'B', 'A'] } }, { request_payload: { targetCodes: ['B', 'A'] } }), true);
  assert.strictEqual(sameTargetScope({ request_payload: { targetCodes: ['A'], targetFields: ['industry'] } }, { request_payload: { targetCodes: ['A'], targetFields: ['business_exposure'] } }), false);
  assert.strictEqual(sameTargetScope(targeted, { request_payload: {} }), false, '全局与定向不混用');
  assert.strictEqual(sameTargetScope({ request_payload: { mode: 'targeted' } }, { request_payload: { mode: 'targeted' } }), false, '空目标不能作为恢复证据');
  assert.strictEqual(sameSlotRecoveryScope(
    { job_code: JOB_CODE, business_date: BUSINESS_DATE, request_payload: { mode: 'core' } },
    { job_code: JOB_CODE, business_date: '2026-09-07', request_payload: { mode: 'core' } }
  ), false, '不同业务日不能互相接管');

  const vm = require('vm'), file = path.join(ROOT, 'server/services/jobScheduleSlots.js');
  const scopedRequire = require('module').createRequire(file);
  const schedulerContext = vm.createContext({
    require: name => name === '../db/connection' ? {
      pool: {
        query: async (sql) => {
          if (sql.includes('FROM job_runs')) return { rows: [other] };
          assert(sql.includes('FROM ops.job_schedule_slots'), '不匹配作用域时禁止写skipped或关闭告警');
          return { rows: [other] };
        },
      },
    } : scopedRequire(name),
    module: { exports: {} }, process, console, Buffer, setTimeout, clearTimeout,
  });
  vm.runInContext(fs.readFileSync(file, 'utf8'), schedulerContext);
  const unchanged = await vm.runInContext('reconcileSlot', schedulerContext)(targeted);
  assert.strictEqual(unchanged.status, 'failed', '调度器同样不能借其他目标成功跳过原失败');

  const dataAlert = await verifyScope(
    { alert_type: 'data_quality', scope_type: 'slot', scope_key: '10' }, query
  );
  assert.strictEqual(dataAlert.recovered, false, '数据质量告警不能被后续任务成功自动掩盖');

  const dependencySlot = {
    slot_id: 20, job_code: 'convertible_bond_valuation_refresh', business_date: '2026-09-19',
    status: 'succeeded', request_payload: { mode: 'core' },
    result_summary: { ok: true, status: 'succeeded', dataAsOf: '2026-09-18' },
  };
  const dependencyQuery = async sql => {
    if (sql.includes('FROM ops.job_schedule_slots')) return { rows: [dependencySlot] };
    if (sql.includes('FROM job_runs')) return { rows: [{
      id: 21, slot_id: 20, status: 'done', attempt_no: 1, trigger_type: 'scheduled',
      result_json: { ok: true, status: 'succeeded', dataAsOf: '2026-09-18' },
    }] };
    throw new Error(`未预期的依赖恢复查询：${sql}`);
  };
  const dependencyAlert = await verifyAlertScope(
    { alert_type: 'dependency_blocked', scope_type: 'slot', scope_key: '20' }, dependencyQuery
  );
  assert.strictEqual(dependencyAlert.recovered, true,
    '依赖阻塞告警必须允许同槽位成功运行和完整恢复证据收敛');

  assert.strictEqual(resolveDatasetPartitionDate({ partitionDatePolicy: 'business_date' }, { business_date: '2026-09-21' }, { jobCode: 'hk_ipo_preopen' }), '2026-09-21');
  assert.strictEqual(resolveDatasetPartitionDate({ partitionDatePolicy: 'previous_trading_day' }, { business_date: '2026-09-21' }, { jobCode: 'hk_ipo_preopen' }), '2026-09-18');
  assert.throws(() => resolveDatasetPartitionDate({ partitionDatePolicy: 'silently_same_day' }, { business_date: '2026-09-21' }, { jobCode: 'hk_ipo_preopen' }), /不支持的 partitionDatePolicy/);
assert.strictEqual(getRegisteredJobDefinition('unknown-job'), null);
const ipoDefinition = getJobDefinition('ipo_history_sync');
assert.deepStrictEqual(ipoDefinition.datasetPublicationByMode.prediction_ready, {
  publish: [], requirePublished: [], requireStageComplete: true,
}, '16:30 阶段按自身完成条件判定，不提前依赖核心分区');
assert.deepStrictEqual(ipoDefinition.datasetPublicationByMode.enrichment.requirePublished, ['ipo_history'],
  '19:35 补全只依赖已通过质量门禁的核心分区');
assert.deepStrictEqual(ipoDefinition.datasetPublicationByMode.enrichment.publish, [],
  '19:35 补全不得重发或覆盖核心分区');
assert(!getJobDefinition('hk_ipo_preopen').externalApis.some(api => /livermore|vbkr|futu/i.test(api)),
  '未获准入的港股动态源不得列为自动采集接口');
assert.strictEqual(validateJobDefinitionSources({
  source: [{ jobCode: 'sample', dataDatePolicy: 'same_day', producesDatasets: ['known'] }],
  contracts: { sample: { datasetPublicationByMode: { core: { publish: ['unknown'], requirePublished: [] } } } },
  datasetRegistry: { known: {} }, strict: true,
}).ok, false, '阶段发布契约不得引用任务未声明的数据集');
  const unknownRecovery = await verifySlotRecoveryEvidence({ slot_id: 99, job_code: 'unknown-job', status: 'succeeded' }, async () => {
    throw new Error('未知任务不应查询运行记录');
  });
  assert.strictEqual(unknownRecovery.recovered, false);
  assert.strictEqual(unknownRecovery.reason, 'unknown_job_definition');

  // 全任务定义不变量：无证据的 pending 不得判成等待，空结果不得算阶段完成，
  // 退役任务只允许是已下线的三个港股任务（接管核对必须对它们保持原样）。
  {
    const { JOB_DEFINITIONS: definitionList, stageCompletionEvidence } = require('../services/jobDefinitions');
    const { slotWaitingState } = require('../services/jobRecoveryEvidence');
    const failureSlot = { job_code: 'sample', status: 'pending', result_summary: {} };
    assert.strictEqual(slotWaitingState(failureSlot).waiting, false, '无证据的 pending 不是等待');
    for (const definition of definitionList) {
      assert.strictEqual(
        slotWaitingState({ ...failureSlot, job_code: definition.jobCode }).waiting, false,
        `${definition.jobCode} 无证据时不得判为等待`
      );
      for (const mode of Object.keys(definition.datasetPublicationByMode || {})) {
        assert.strictEqual(
          stageCompletionEvidence(definition, { mode }, { mode }), false,
          `${definition.jobCode}/${mode} 空结果不得算阶段完成`
        );
      }
    }
    assert.deepStrictEqual(
      definitionList.filter(item => item.disabled).map(item => item.jobCode).sort(),
      ['hk_ipo_enrichment', 'hk_ipo_postclose', 'hk_ipo_preopen'],
      '退役任务只有三个已下线港股任务'
    );
  }

  // R2：槽位版本只接受数据库精确文本；JS Date 的毫秒值不能冒充同一版本。
  const { slotVersionText } = require('../services/jobRecoveryEvidence');
  assert.strictEqual(slotVersionText({ updated_at: new Date('2026-10-26T12:00:00.100Z') }), null,
    'JS Date 只有毫秒，不能作为并发核对版本');
  assert.strictEqual(slotVersionText({ updated_at_exact: '2026-10-26 20:00:00.1005+08' }), '2026-10-26 20:00:00.1005+08',
    '数据库精确文本必须原样用于核对');
  assert.strictEqual(slotVersionText({ updated_at: '2026-10-26T12:00:00.100500Z' }), '2026-10-26T12:00:00.100500Z',
    '带微秒的字符串版本可用');
  assert.strictEqual(slotVersionText({ updated_at: '2026-10-26T12:00:00.100Z' }), null, '毫秒级字符串版本不可用');
  assert.strictEqual(slotVersionText({}), null);

  // R3：审计摘要只放开受限结构，逐层过滤凭据键，并限制深度与数量。
  const { sanitizeAuditMeta } = require('../db/config');
  const auditMeta = sanitizeAuditMeta({
    alertId: 1,
    scope: { type: 'slot', key: '10' },
    runIds: [11, 12],
    partitions: [{ code: 'ipo_history', scope: 'GLOBAL', partitionKey: '2026-10-07', status: 'published' }],
    token: 'must-not-persist',
    nested: { deeper: { deepest: 'x' } },
    huge: new Array(40).fill('a'),
  });
  assert.deepStrictEqual(auditMeta.scope, { type: 'slot', key: '10' }, '作用域对象必须落库');
  assert.deepStrictEqual(auditMeta.runIds, [11, 12], '运行 ID 数组必须落库');
  assert.strictEqual(auditMeta.partitions[0].partitionKey, '2026-10-07', '分区日期必须落库');
  assert.strictEqual(auditMeta.token, undefined, '凭据键在任何层级都不落库');
  assert.strictEqual(auditMeta.huge.length, 20, '结构数量必须受限');
  assert.strictEqual(auditMeta.nested, undefined, '超过两层深度的结构不落库');

  assert.strictEqual(validateJobDefinitionSources({
    source: [{ jobCode: 'sample' }], contracts: {}, strict: true,
  }).ok, false, '严格契约门禁必须拒绝依赖默认 dataDatePolicy 的原始定义');
}

verifyReconciliationEvidence().then(() => {
  console.log('OK ops-alert-remediation: 告警作用域、恢复证据、巨潮 403 有界退避、休市日历运行时副本和分区发布约束通过');
}).catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

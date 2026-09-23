const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { recoverySchedule } = require('../services/jobOrchestrator');
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

const migration = read('server/db/migrations.js');
assert(migration.includes('151_alert_scope_and_cninfo_backoff'));
assert(migration.includes('scope_type TEXT'));
assert(migration.includes('consecutive_forbidden_count INTEGER'));
const mailer = read('server/services/jobAlertMailer.js');
assert(mailer.includes("status === 'history'"));
assert(mailer.includes("scope_type=\'dataset\'"));
assert(mailer.includes("scope_type=\'source_endpoint\'"));
assert(mailer.includes("scope_type=\'slot\' AND scope_key=$1::text"));
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
const orchestrator = read('server/services/jobOrchestrator.js');
assert(orchestrator.includes('missingRecoverAtCount'));
assert(orchestrator.includes('scopeType: \'dataset\''));
const partitionService = read('server/services/datasetPartitions.js');
const latestFunction = partitionService.slice(partitionService.indexOf('async function getLatestPublishedPartition'));
assert(!latestFunction.includes('options.diagnostics'));
assert(partitionService.includes('resolveDatasetAlerts(datasetCode, scopeKey, partitionKey)'));

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
const ipoSyncJob = read('server/jobs/ipoHistorySync.js');
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

  const original = {
    slot_id: 10, job_code: 'convertible_bond_refresh', status: 'failed',
    scheduled_for: '2026-09-06T08:00:00.000Z', updated_at: '2026-09-06T08:30:00.000Z',
  };
  const laterSuccesses = [
    { slot_id: 13, status: 'succeeded', scheduled_for: '2026-09-09T08:00:00.000Z' },
    { slot_id: 12, status: 'succeeded', scheduled_for: '2026-09-08T08:00:00.000Z' },
    { slot_id: 11, status: 'succeeded', scheduled_for: '2026-09-07T08:00:00.000Z' },
  ];
  const query = async sql => ({ rows: sql.includes('WHERE slot_id=$1') ? [original] : laterSuccesses });
  const recoveredSlot = await verifyScope(
    { alert_type: 'failure', scope_type: 'slot', scope_key: '10' }, query
  );
  assert.strictEqual(recoveredSlot.recovered, true, '历史运行失败应能用连续三次后续成功作为人工对账证据');
  assert.strictEqual(recoveredSlot.evidence.mode, 'three_later_job_successes');

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

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { recoverySchedule } = require('../services/jobOrchestrator');
const { cninfoApiName } = require('../services/cninfoAnnouncement');
const { closedCircuitApiNames } = require('../services/externalCallGuard');
const { allCircuitsClosed, verifyScope } = require('../scripts/reconcileAlertHistory');

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
assert(cninfoPy.includes("scope_type='source_endpoint'") && cninfoPy.includes('RETURNING api_name'));
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
    { scope_type: 'source_endpoint', scope_key: 'cninfo:topSearch' },
    async () => ({ rows: [] })
  );
  assert.strictEqual(missingCircuit.recovered, false);
  assert.strictEqual(missingCircuit.reason, 'circuit_evidence_missing');

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
}

verifyReconciliationEvidence().then(() => {
  console.log('OK ops-alert-remediation: 告警作用域、恢复证据、巨潮 403 有界退避、休市日历运行时副本和分区发布约束通过');
}).catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

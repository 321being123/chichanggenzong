const assert = require('assert');
const repository = require('../repositories/jobScheduleSlotsRepository');
const { reconcileReadinessSlots, listDueSlots, claimSlot } = require('../services/jobScheduleSlots');

(async () => {
  const originalList = repository.listDueReadinessSlots;
  const originalResume = repository.update_ops_job_schedule_slots_22;
  const originalPartitionRead = repository.select_ops_dataset_partitions;
  const originalRunQuery = repository.runQuery;
  const originalListDue = repository.select_ops_job_schedule_slots_3;
  const originalLookup = repository.select_ops_job_schedule_slots_1;
  const originalClaim = repository.update_ops_job_schedule_slots_7;
  let partitionReads = 0;
  let resumeEvidence;
  let claimWrites = 0;
  const slot = {
    slot_id: 9001,
    // 真正没有就绪依赖/数据集依赖的任务：nav_snapshot 已声明 repo_daily_rates 依赖，
    // 用它当无依赖夹具会让本用例去查一次分区，断言"零次查询"必然失败。
    job_code: 'site_analytics_retention',
    business_date: '2026-11-18',
    updated_at_exact: '2026-11-19T02:00:00.000Z',
    status: 'pending',
    attempt_count: 0,
    claim_count: 0,
    fail_count: 0,
    retry_contract: 'counters',
    result_summary: {},
  };
  try {
    repository.listDueReadinessSlots = async () => [{
      slot_id: 9001,
      job_code: 'site_analytics_retention',
      business_date: '2026-11-18',
      updated_at_exact: '2026-11-19T02:00:00.000Z',
      result_summary: {
        waitKind: 'publication',
        readinessStopAt: '2099-01-01T00:00:00.000Z',
      },
    }];
    repository.select_ops_dataset_partitions = async () => {
      partitionReads += 1;
      return { rows: [] };
    };
    repository.runQuery = async () => ({ rows: [] });
    repository.select_ops_job_schedule_slots_3 = async () => ({ rows: [slot] });
    repository.select_ops_job_schedule_slots_1 = async () => ({ rows: [slot] });
    repository.update_ops_job_schedule_slots_7 = async params => {
      claimWrites += 1;
      return { rows: [{ ...slot, status: 'running', execution_token: params[5] }] };
    };
    repository.update_ops_job_schedule_slots_22 = async params => {
      resumeEvidence = params[2];
      return { rows: [{ ...slot, status: 'pending' }] };
    };

    const result = await reconcileReadinessSlots(1);
    const due = await listDueSlots(1);
    const claimed = await claimSlot(slot.slot_id);
    assert.strictEqual(result.resumed, 1, '无依赖任务的检查点应唤醒原槽');
    assert.strictEqual(partitionReads, 0, '无声明依赖时不得伪造分区查询');
    assert.strictEqual(resumeEvidence, null, '无真实数据证据时不得写首次就绪观测');
    assert.strictEqual(due.length, 1, '唤醒后的无依赖任务必须重新进入待执行列表');
    assert(claimed && claimed.status === 'running', '唤醒后的无依赖任务必须可以领取');
    assert.strictEqual(claimWrites, 1, '无依赖任务领取必须只成功一次');
    console.log('OK job-readiness-no-dependency: no false readiness observation');
  } finally {
    repository.listDueReadinessSlots = originalList;
    repository.update_ops_job_schedule_slots_22 = originalResume;
    repository.select_ops_dataset_partitions = originalPartitionRead;
    repository.runQuery = originalRunQuery;
    repository.select_ops_job_schedule_slots_3 = originalListDue;
    repository.select_ops_job_schedule_slots_1 = originalLookup;
    repository.update_ops_job_schedule_slots_7 = originalClaim;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
require('dotenv').config({ path: path.join(root, '.env') });
const testDatabase = String(process.env.PGTESTDATABASE || 'portfolio_test').replace(/[^a-zA-Z0-9_]/g, '_');
if (process.env.DATABASE_URL) {
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = '/' + testDatabase;
  process.env.DATABASE_URL = url.toString();
} else {
  process.env.PGDATABASE = testDatabase;
}
process.env.NODE_ENV = 'test';
process.env.ALERT_EMAIL_TO = '';
process.env.ALERT_EMAIL_FROM = '';

const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const { pool } = require('../db/connection');
const { publishDatasetPartition } = require('../services/datasetPartitions');
const { mergeDateRanges } = require('../services/convertibleBondSuspensionSync');
const { DATASET_PARTITION_REGISTRY, areJobDatasetsPublished } = require('../services/datasetPartitionRegistry');
const { expectedDataDate } = require('../services/jobScheduleSlots');
const { runSlot } = require('../services/jobOrchestrator');
const definitions = require('../services/jobDefinitions');

const JOB_CODE = 'convertible_bond_universe_refresh';
const mainJob = definitions.getJobDefinition(JOB_CODE);

async function cleanupFixtures(businessDates, partitionDates) {
  const slots = await pool.query(
    'SELECT slot_id FROM ops.job_schedule_slots WHERE job_code=$1 AND business_date=ANY($2::date[])',
    [JOB_CODE, businessDates]
  );
  const slotIds = slots.rows.map(row => row.slot_id);
  if (slotIds.length) {
    await pool.query('DELETE FROM job_runs WHERE slot_id=ANY($1::bigint[])', [slotIds]);
    await pool.query('DELETE FROM ops.job_schedule_slots WHERE slot_id=ANY($1::bigint[])', [slotIds]);
  }
  await pool.query(
    'DELETE FROM ops.dataset_partitions WHERE dataset_code=ANY($1::text[]) AND partition_key=ANY($2::date[])',
    [mainJob.producesDatasets, partitionDates]
  );
}

async function seedMainPartitions(targetDate, suspensionStatus = 'stale') {
  for (const datasetCode of mainJob.producesDatasets) {
    const isSuspension = datasetCode === 'stock_suspend_calendar';
    const published = !isSuspension || suspensionStatus === 'published';
    await publishDatasetPartition(datasetCode, 'CN', {
      partitionKey: targetDate,
      dataAsOf: targetDate,
      rowCount: isSuspension ? 0 : 1,
      status: published ? 'published' : 'stale',
      isStale: !published,
      staleReason: published ? '' : '验收模拟停牌接口失败',
      diagnostics: isSuspension
        ? {
            api_name: 'suspend_d',
            query_status: published ? 'success' : 'failed',
            coverage_status: published ? 'verified_no_suspension' : 'unknown',
          }
        : { test_fixture: 'inc-0010' },
    });
  }
}

async function insertSlot(businessDate, testScenario, offsetMinutes) {
  const { rows } = await pool.query(
    `INSERT INTO ops.job_schedule_slots
       (job_code,scheduled_for,business_date,status,next_attempt_at,request_payload)
     VALUES($1,now()-($4::integer * interval '1 minute'),$2::date,'pending',now()-interval '1 second',$3::jsonb)
     RETURNING *,business_date::text AS business_date`,
    [JOB_CODE, businessDate, JSON.stringify({ mode: 'core', testScenario }), offsetMinutes]
  );
  return rows[0];
}

async function loadSlot(slotId) {
  const { rows } = await pool.query(
    'SELECT *,business_date::text AS business_date FROM ops.job_schedule_slots WHERE slot_id=$1',
    [slotId]
  );
  return rows[0];
}

function runStaticContracts() {
  assert.deepStrictEqual(mergeDateRanges(
    ['2026-08-31', '20260901', '2026-09-02', '2026-09-05'],
    ['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05']
  ), [
    { startDate: '2026-08-31', endDate: '2026-09-02', dates: ['2026-08-31', '2026-09-01', '2026-09-02'] },
    { startDate: '2026-09-05', endDate: '2026-09-05', dates: ['2026-09-05'] },
  ], '非连续交易日不得误合并');
  assert.deepStrictEqual(mergeDateRanges(
    ['2026-09-04', '2026-09-07'],
    ['2026-09-04', '2026-09-07']
  ), [
    { startDate: '2026-09-04', endDate: '2026-09-07', dates: ['2026-09-04', '2026-09-07'] },
  ], '跨周末的相邻交易日必须合并为一次区间请求');

  assert.strictEqual(mainJob.strictDatasetPublication, true, '主采集任务必须开启严格数据集发布门禁');
  assert.strictEqual(mainJob.datasetFailureThreshold, 3, '主采集任务必须配置连续失败熔断阈值');
  assert.ok(mainJob.producesDatasets.length > 0 && mainJob.producesDatasets.every(code => DATASET_PARTITION_REGISTRY[code]),
    '主采集任务 producesDatasets 必须全部进入分区注册白名单');

  const suspension = read('server/services/convertibleBondSuspensionSync.js');
  assert.ok(/coverage_status: rowCount \? 'suspensions_found' : 'verified_no_suspension'/.test(suspension),
    '停牌接口成功空结果必须登记为已核验无停牌');
  assert.ok(/query_status: 'failed'/.test(suspension) && /status='stale'/.test(suspension),
    '停牌接口失败必须登记未知/过期，不能伪造空结果');
  assert.ok(/JOIN market\.convertible_bond_daily_metrics bm/.test(suspension),
    '停牌同步和缺口扫描必须限定目标交易日的现役转债范围');

  const registry = read('server/services/datasetPartitionRegistry.js');
  assert.ok(/datasets\.length !== declaredDatasets\.length/.test(registry)
    && /coverage_status === 'verified_no_suspension'/.test(registry),
    '严格任务必须校验白名单交集，并允许已核验空结果发布');

  const redemption = read('server/services/convertibleBondRedemptionService.js');
  assert.ok(/c\.business_status,c\.data_status,c\.diagnostics/.test(redemption), '强赎接口必须返回逐债诊断信息');
  const frontend = read('public/js/bond-redemption.js');
  assert.ok(/row\.diagnostics\.missing_dates/.test(frontend)
    && !/row\.data_status !== 'complete'/.test(frontend),
    '页面必须显示停牌缺口，且 waived 不得混入数据不完整筛选');
  assert.ok(read('public/index.html').includes('js/bond-redemption.js?v=5'), '强赎页面脚本版本必须更新');

  const migrations = read('server/db/migrations.js');
  assert.ok(/migration146ConvertibleBondDataStatusConstraint/.test(migrations)
    && /chk_cb_trigger_data_status/.test(migrations)
    && /'complete','incomplete','pending'/.test(migrations),
    '数据状态枚举必须在数据库层固化');
}

async function verifyFailureThenSuspensionOnlyRecovery(businessDate) {
  const targetDate = expectedDataDate(JOB_CODE, businessDate);
  assert.notStrictEqual(targetDate, businessDate, '验收日期必须覆盖业务日与目标分区日不同的场景');
  await seedMainPartitions(targetDate, 'stale');
  assert.strictEqual(await areJobDatasetsPublished(JOB_CODE, targetDate), false, '停牌分区 stale 时门禁必须失败');

  const initial = await insertSlot(businessDate, 'suspension-failure', 10);
  await runSlot(initial, 'scheduled');
  let state = await loadSlot(initial.slot_id);
  assert.strictEqual(state.status, 'failed', '首次停牌失败后槽位必须进入待重试状态');
  assert.deepStrictEqual(state.result_summary.failedDatasets, ['stock_suspend_calendar']);
  assert.strictEqual(state.result_summary.datasetFailureCounts.stock_suspend_calendar, 1);

  await pool.query(
    `UPDATE ops.job_schedule_slots
        SET next_attempt_at=now()-interval '1 second',
            request_payload=$2::jsonb
      WHERE slot_id=$1`,
    [initial.slot_id, JSON.stringify({ mode: 'core', testScenario: 'suspension-success' })]
  );
  state = await loadSlot(initial.slot_id);
  await runSlot(state, 'auto-retry');
  state = await loadSlot(initial.slot_id);
  assert.strictEqual(state.status, 'succeeded', '停牌专属续跑成功后槽位必须完成');
  assert.strictEqual(state.result_summary.testRunnerMode, 'suspension-only');
  assert.deepStrictEqual(state.result_summary.receivedFailedDatasets, ['stock_suspend_calendar'],
    '真实编排器必须把失败数据集传入重试 Runner');
  assert.strictEqual(await areJobDatasetsPublished(JOB_CODE, targetDate), true,
    '上一交易日的六个目标分区完整后必须通过严格门禁');
  assert.strictEqual(await areJobDatasetsPublished(JOB_CODE, businessDate), false,
    '计划业务日不能冒充上一交易日数据分区');
}

async function verifyRateLimitBreaker(businessDate) {
  const targetDate = expectedDataDate(JOB_CODE, businessDate);
  await seedMainPartitions(targetDate, 'stale');
  const initial = await insertSlot(businessDate, 'suspension-rate-limit', 20);
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) {
      await pool.query(
        `UPDATE ops.job_schedule_slots
            SET next_attempt_at=now()-interval '1 second'
          WHERE slot_id=$1`,
        [initial.slot_id]
      );
    }
    const stateBefore = await loadSlot(initial.slot_id);
    await runSlot(stateBefore, 'auto-retry');
    const stateAfter = await loadSlot(initial.slot_id);
    assert.strictEqual(stateAfter.result_summary.datasetFailureCounts.stock_suspend_calendar, attempt,
      `第 ${attempt} 次真实限流失败必须累计数据集失败次数`);
    assert.strictEqual(stateAfter.status, attempt < 3 ? 'waiting_external' : 'blocked',
      `第 ${attempt} 次限流后的槽位状态不正确`);
  }
  const blocked = await loadSlot(initial.slot_id);
  assert.strictEqual(blocked.next_attempt_at, null, '达到阈值后必须取消自动重试时间');
}

(async () => {
  const businessDates = ['2099-01-06', '2099-01-07'];
  const partitionDates = businessDates.map(date => expectedDataDate(JOB_CODE, date));
  try {
    await cleanupFixtures(businessDates, partitionDates);
    runStaticContracts();
    await verifyFailureThenSuspensionOnlyRecovery(businessDates[0]);
    await verifyRateLimitBreaker(businessDates[1]);
    console.log('INC-0010 regression tests passed: real orchestrator, partition date, retry and breaker');
  } finally {
    await cleanupFixtures(businessDates, partitionDates).catch(() => {});
    await pool.end();
  }
})().catch(error => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});

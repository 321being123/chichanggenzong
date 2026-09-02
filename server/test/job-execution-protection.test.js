const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

// 本测试会主动制造 degraded 告警；单独运行时也必须隔离开发机真实 SMTP。
process.env.NODE_ENV = 'test';
process.env.ALERT_EMAIL_TO = '';
process.env.ALERT_EMAIL_FROM = '';

const root = path.join(__dirname, '..', '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const definitions = require('../services/jobDefinitions');
const slots = read('server/services/jobScheduleSlots.js');
const orchestrator = read('server/services/jobOrchestrator.js');
const valuation = read('server/jobs/convertibleBondRefresh.js');
const bondAnalysis = read('server/services/convertibleBondAnalysis.js');
const stockAnalysisJob = read('server/jobs/stockAnalysisRefresh.js');
const stockJob = read('server/jobs/stockAnalysisRefresh.js');
const slotService = read('server/services/jobScheduleSlots.js');
const adminUi = read('public/js/admin.js');
const pythonGuard = read('ipo-report/external_call_guard.py');
const externalGuard = read('server/services/externalCallGuard.js');
const testRunner = read('server/test/run-all.js');
const tushareClient = read('server/services/tushare.js');
const identitySource = read('server/services/securityIdentity.js');
const financialArchitecture = read('server/services/financialDataArchitecture.js');
const ipoHistoryJob = read('server/jobs/ipoHistorySync.js');
const runnerProcess = read('server/services/jobRunnerProcess.js');
const motiveService = read('server/services/convertibleBondRevisionMotiveService.js');
const alertMailer = read('server/services/jobAlertMailer.js');

for (const definition of definitions.JOB_DEFINITIONS) {
  assert.ok(definition.retryPolicy, `${definition.jobCode} 缺少 retryPolicy`);
  assert.ok(Array.isArray(definition.externalSources), `${definition.jobCode} 缺少 externalSources`);
  assert.ok(definition.catchupMode, `${definition.jobCode} 缺少 catchupMode`);
  assert.ok(definition.dataDatePolicy, `${definition.jobCode} 缺少 dataDatePolicy`);
  assert.ok(Array.isArray(definition.externalApis), `${definition.jobCode} 缺少 externalApis`);
  assert.ok(Array.isArray(definition.producesDatasets), `${definition.jobCode} 缺少 producesDatasets`);
  assert.ok(Array.isArray(definition.consumesDatasets), `${definition.jobCode} 缺少 consumesDatasets`);
  assert.ok(Array.isArray(definition.datasetDependencies), `${definition.jobCode} 缺少 datasetDependencies`);
  assert.ok(Number.isFinite(Number(definition.maxExternalCallsPerRun)), `${definition.jobCode} 缺少 maxExternalCallsPerRun`);
}
assert.ok(definitions.JOB_DEFINITIONS.reduce((sum, job) => sum + definitions.declaredDailyExternalCallBudget(job), 0) <= 80,
  '常规任务声明调用预算不得超过每日80次目标');
assert.strictEqual(definitions.getJobDefinition('bond_safety_refresh').hour, 8, '安全评分必须在共享主链之后执行');
assert.strictEqual(definitions.getJobDefinition('bond_safety_refresh').minute, 30, '安全评分必须在08:30执行');
assert.deepStrictEqual(definitions.getJobDefinition('bond_safety_refresh').dependencyCodes, ['convertible_bond_universe_refresh'], '安全评分必须依赖可转债主链');
assert.strictEqual(definitions.getJobDefinition('convertible_bond_redemption_announcement_sync').dailyBudget, 2, '强赎任务每日预算计入值必须独立于单次上限');
assert.strictEqual(definitions.getJobDefinition('convertible_bond_redemption_announcement_sync').maxExternalCallsPerRun, 40, '强赎任务单次上限必须覆盖批量分页');
assert.ok(definitions.getJobDefinition('ipo_calendar_refresh').catchupMode === 'latest_only');
const ipoReport = definitions.getJobDefinition('ipo_calendar_refresh');
const ipoFacts = definitions.getJobDefinition('ipo_history_sync');
assert.deepStrictEqual(ipoReport.externalApis, [], '打新日报不得调用外部接口');
assert.strictEqual(ipoReport.maxExternalCallsPerRun, 0, '打新日报外部调用预算必须为0');
assert.deepStrictEqual(ipoReport.dependencyCodes, ['ipo_history_sync'], '打新日报必须依赖IPO事实同步');
assert.deepStrictEqual(ipoReport.datasetDependencies, [{
  datasetCode: 'ipo_history', scopeKey: 'GLOBAL', partitionDatePolicy: 'business_date', requireQualityStatus: 'passed'
}], '打新日报必须依赖当天通过质量门禁的IPO事实分区');
assert.ok(ipoFacts.externalApis.includes('new_share'), 'IPO事实同步必须是new_share采集者');
assert.strictEqual(definitions.externalCallLimitForMode(ipoFacts, 'core'), 1, 'IPO核心事实阶段只允许一次new_share调用');
assert.strictEqual(definitions.externalCallLimitForMode(ipoFacts, 'enrichment'), 15, 'IPO晚间补全必须使用独立调用预算');
assert.strictEqual(definitions.JOB_DEFINITIONS.filter(job => job.externalApis.includes('new_share')).length, 1,
  'new_share在任务契约中只能有一个采集者');
assert.ok(definitions.getJobDefinition('hk_trade_rules_sync').catchupMode === 'latest_only');
assert.ok(/WHERE \(status='pending'[\s\S]*status IN \('failed','waiting_external'\)/.test(slots), 'degraded/blocked 不得直接进入待执行筛选');
assert.ok(/status IN \('pending','failed','waiting_external'\)/.test(slots), '领取任务不得领取 degraded');
assert.ok(/freshnessGate/.test(orchestrator) && /externalCalls: 0/.test(orchestrator), '外部任务必须先执行本地新鲜度门禁');
assert.ok(/DURABLE_JOB_RUN/.test(orchestrator) && /唯一 job_runs/.test(read('server/db/jobs.js')), '子进程不得创建嵌套 job_runs');
const valuationRunner = valuation.slice(valuation.indexOf('async function runRefreshChain'), valuation.indexOf('function nextShanghaiDelay'));
assert.ok(!/syncConvertibleBondUniverseWithBackfill/.test(valuationRunner), '估值 Runner 不得嵌套可转债行情同步');
assert.ok(!/syncConvertibleBondSuspensions/.test(valuationRunner), '估值 Runner 不得重复调用 suspend_d，停牌日由行情主采集链路统一拉取');
assert.ok(/derivedCoverage >= 0\.8/.test(bondAnalysis) && /minimumPriced/.test(bondAnalysis), '可转债半成品行情不得覆盖完整行情日');
assert.ok(/runRefreshChain\(reason, businessDate\)/.test(read('server/services/jobRunners.js')), '人工补跑估值必须沿用计划业务日期');
assert.ok(/stock_basic\\s\+返回空数据/.test(stockAnalysisJob) && /skippedCodes/.test(stockAnalysisJob), '无股票基础档案不得阻断整批分析任务');
assert.ok(/duplicate-success:/.test(orchestrator), '同一任务和业务日期重复成功必须告警');
assert.ok(/freshness_validation/.test(slotService) && /业务执行结果/.test(adminUi), '后台必须分开展示业务执行和新鲜度校验');
assert.ok(/ops\.external_call_budgets/.test(pythonGuard) && /pg_try_advisory_lock/.test(pythonGuard), 'Python 自动任务必须复用 PostgreSQL API 预算和数据集锁');
assert.ok(/ops\.consume_external_call_budget/.test(externalGuard) && /ops\.consume_external_call_budget/.test(pythonGuard), 'Node/Python 预算扣减必须共用数据库原子函数');
assert.ok(/configured == "0"/.test(pythonGuard) && /production/.test(pythonGuard) && /return configured != "0"/.test(pythonGuard),
  'Python Guard 必须默认开启且生产环境不可关闭');
assert.ok(/BUDGET_WAIT/.test(externalGuard) && /BUDGET_WAIT/.test(orchestrator),
  '内部预算耗尽必须进入等待状态，不得误开来源熔断');
assert.ok(/JOB_EXTERNAL_CALL_USED/.test(pythonGuard) && /_budget_date_text/.test(pythonGuard)
  && /return \{"total": _run_call_count/.test(pythonGuard), 'Python 必须继承累计调用数且预算日不能使用业务日期');
assert.ok(/setExternalCallCount/.test(externalGuard) && /setExternalCallCount\(message\.context/.test(runnerProcess),
  'Node 子进程必须继承计划实例累计调用数');
assert.ok(/JOB_BUDGET_EXCEEDED/.test(ipoHistoryJob) && /error\.code !== 'ENOENT'/.test(ipoHistoryJob)
  && /externalCallCount = structured\.externalCalls/.test(ipoHistoryJob), 'IPO 业务/API错误不得换解释器重跑，且必须透传结构化预算信息');
assert.ok(/isRunBudgetBoundaryError/.test(motiveService) && /holderAttempted = false/.test(motiveService)
  && /pledgeAttempted = false/.test(motiveService), '下修动机达到批次上限必须顺延而非制造单债失败');
assert.ok(/alert_type='failure_warning' AND EXISTS/.test(alertMailer)
  && /alert_type='late' AND EXISTS/.test(alertMailer), '同一计划的预警和下游逾期告警必须归并');
assert.ok(/TEST_DATABASE/.test(testRunner) && /cleanupTestArtifacts/.test(testRunner)
  && /test_guard_%/.test(testRunner) && /cninfo-test/.test(testRunner),
  '全量测试必须使用隔离库，并在前后清理测试专属熔断记录');
assert.ok(/async function resolveCanonicalCode/.test(identitySource)
  && /assetClass === 'convertible_bond'/.test(identitySource)
  && /\^\(4\|8\|92\)/.test(identitySource),
  '标准代码解析必须按统一市场规则生成标准代码，不能退化为按历史主档扫描');
assert.ok(/assetClass='stock'/.test(financialArchitecture), '股票标准层不得继续写入 equity 类型');
assert.ok(/const result = await fn\(lock\.client, guardResult\)/.test(externalGuard)
  && /closeExternalCircuit\(guardSource, apiName, fingerprint, guardClient, probeToken\)/.test(tushareClient)
  && /}, \{\}, guardClient\)\.catch/.test(tushareClient)
  && /circuitScopeLabel/.test(externalGuard), 'Tushare 请求收尾必须复用数据集锁连接，禁止连接池互等');
assert.ok(/EXTERNAL_CALL_GUARD/.test(read('server/jobs/ipoCalendarRefresh.js')) && /EXTERNAL_CALL_GUARD/.test(read('server/jobs/ipoHistorySync.js')), 'Python 自动任务子进程必须开启外部请求保护');
assert.ok(/UPDATE job_runs[\s\S]*status='failed'/.test(slots) && /locked_until=now\(\)\+/.test(orchestrator), '过期运行记录必须自动回收且活动任务必须续租');
assert.ok(/jobCode: 'holiday_sync'[\s\S]*mayConsumeQuota: true[\s\S]*externalSources: \['tushare'\]/.test(read('server/services/jobDefinitions.js')), '休市日自动同步必须纳入 Tushare 预算保护');
assert.ok(/SELECT max\(as_of_date\)::text AS data_as_of FROM analytics\.stock_overview_latest/.test(stockJob)
  && /const dataAsOf = stocks\.length && failed === 0 \? await latestStockAnalysisDate\(\) : null/.test(stockJob)
  && /watermarkNotRequired: stocks\.length === 0/.test(stockJob), '个股分析成功水位必须来自实际入库，无目标时不得误报');

(async () => {
  const originalRequest = require('https').request;
  const originalToken = process.env.TUSHARE_TOKEN;
  const guard = require('../services/externalCallGuard');
  process.env.TUSHARE_TOKEN = 'test-token';
  try {
    const https = require('https');
    const clientPath = require.resolve('../services/tushare');
    delete require.cache[clientPath];
    const { tushareQuery } = require('../services/tushare');
    const mock = (statusCode, payload) => {
      https.request = (url, options, callback) => {
        const request = new EventEmitter();
        request.write = () => {};
        request.end = () => {
          const response = new EventEmitter();
          response.statusCode = statusCode;
          response.setEncoding = () => {};
          callback(response);
          response.emit('data', JSON.stringify(payload));
          response.emit('end');
        };
        request.destroy = () => {};
        return request;
      };
    };

    const resetTushareGuards = async () => {
      guard.resetExternalCallGuard();
      await guard.resetExternalCallGuardPersistence('tushare');
      await guard.resetExternalCallGuardPersistence('tushare_backup');
    };

    await resetTushareGuards();
    mock(429, { code: 40203, msg: '频率限制' });
    await assert.rejects(() => tushareQuery('daily'), error => error.code === 'RATE_LIMIT' && error.retryable === false);
    const circuitRows = await require('../db/connection').pool.query(
      `SELECT source,api_name,state FROM ops.external_circuits
        WHERE source=$1 AND token_fingerprint=$2`,
      ['tushare', guard.tokenFingerprint('test-token')]
    );
    assert.strictEqual(circuitRows.rows.find(row => row.api_name === '*'), undefined,
      '单个 Tushare 接口限流不得创建 Token 全局熔断');
    assert.strictEqual(circuitRows.rows.find(row => row.api_name === 'daily')?.state, 'open',
      '限流熔断必须记录到具体接口');
    const budgetColumns = await require('../db/connection').pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='ops' AND table_name='external_call_budgets' AND column_name='circuit_open'`
    );
    assert.strictEqual(budgetColumns.rowCount, 0, '预算表不得继续保存熔断状态');
    const budgetFunction = await require('../db/connection').pool.query(
      `SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='ops' AND p.proname='consume_external_call_budget'`
    );
    assert.strictEqual(budgetFunction.rowCount, 1, 'Node/Python 必须共用数据库预算原子入口');

    mock(200, { code: 0, data: { fields: ['cal_date'], items: [['20260812']] } });
    const unaffected = await tushareQuery('trade_cal');
    assert.deepStrictEqual(unaffected, { fields: ['cal_date'], items: [['20260812']] },
      'daily 限流不得阻断 trade_cal 等其它接口');

    await resetTushareGuards();
    mock(200, { code: 40101, msg: 'token 无效' });
    await assert.rejects(() => tushareQuery('daily'), error => error.code === 'AUTH_ERROR' && error.retryable === false);

    await resetTushareGuards();
    mock(200, { code: 2002, msg: '没有接口访问权限' });
    await assert.rejects(() => tushareQuery('daily'), error => error.code === 'PERMISSION_DENIED' && error.errorType === 'permission' && error.retryable === false);

    const guardSource = `test_guard_${process.pid}_${Date.now()}`;
    const guardEnv = guardSource.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    process.env[`${guardEnv}_PER_MINUTE_BUDGET`] = '20';
    process.env[`${guardEnv}_DAILY_BUDGET`] = '20';
    let guardedExternalCalls = 0;
    let firstEntered;
    let releaseFirst;
    const firstEnteredPromise = new Promise(resolve => { firstEntered = resolve; });
    const firstFinishedPromise = new Promise(resolve => { releaseFirst = resolve; });
    const firstGuarded = guard.withExternalCallGuard(guardSource, 'dataset-a', '2026-08-15', async () => {
      guardedExternalCalls += 1;
      firstEntered();
      await firstFinishedPromise;
      return 'called';
    });
    await firstEnteredPromise;
    const secondGuarded = guard.withExternalCallGuard(guardSource, 'dataset-a', '2026-08-15', () => Promise.resolve('duplicate'));
    // 让 Node 在等待第一个请求释放锁期间，不把预期的 DATASET_LOCKED 视为未处理拒绝。
    secondGuarded.catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 100));
    releaseFirst();
    const guarded = await Promise.allSettled([firstGuarded, secondGuarded]);
    assert.strictEqual(guarded.filter(item => item.status === 'fulfilled').length, 1, '同一数据集并发只能有一个请求者');
    assert.strictEqual(guarded.find(item => item.status === 'rejected').reason.code, 'DATASET_LOCKED');
    assert.strictEqual(guardedExternalCalls, 1, '同一数据集并发时外部 API 实际调用次数必须为 1');
    await require('../db/connection').pool.query('DELETE FROM ops.external_call_budgets WHERE source=$1', [guardSource]);
    guard.resetExternalCallGuard();
    process.env[`${guardEnv}_DAILY_BUDGET`] = '1';
    await guard.consumeExternalCall(guardSource, 'dataset-quota-first');
    await assert.rejects(() => guard.consumeExternalCall(guardSource, 'dataset-b'), error =>
      error.code === 'BUDGET_WAIT' && error.errorType === 'rate_limit' && Boolean(error.recoverAt),
    '本系统预算耗尽应等待窗口，不得伪装成 Token 熔断');
    const budgetRows = await require('../db/connection').pool.query(
      `SELECT call_count FROM ops.external_call_budgets WHERE source=$1 AND window_type='day'`, [guardSource]
    );
    assert.strictEqual(budgetRows.rows[0].call_count, 1, '每日预算必须跨调用持久化计数');
    const quotaCircuit = await require('../db/connection').pool.query(
      `SELECT api_name,state FROM ops.external_circuits WHERE source=$1 AND token_fingerprint='none'`, [guardSource]
    );
    assert.strictEqual(quotaCircuit.rows.length, 0, '本系统每日预算耗尽不得写入 Token 级熔断');
    await require('../db/connection').pool.query('DELETE FROM ops.external_call_budgets WHERE source=$1', [guardSource]);
    delete process.env[`${guardEnv}_PER_MINUTE_BUDGET`];
    delete process.env[`${guardEnv}_DAILY_BUDGET`];

    const { pool } = require('../db/connection');
    const { claimSlot, completeSlot, listDueSlots, enqueueManualJob, syncScheduleSlots, expectedDataDate } = require('../services/jobScheduleSlots');
    assert.strictEqual(expectedDataDate('convertible_bond_valuation_refresh', '2026-02-24'), '2026-02-13', '前一交易日必须跳过春节休市日');
    assert.strictEqual(expectedDataDate('convertible_bond_universe_refresh', '2026-08-24'), '2026-08-21', '周一行情主档应校验上一个交易日');
    const claimTime = new Date(Date.now() - 60 * 1000);
    const claimInsert = await pool.query(
      `INSERT INTO ops.job_schedule_slots(job_code,scheduled_for,business_date,status,next_attempt_at)
       VALUES('market_close:A股',$1,'2099-01-01','pending',$1) RETURNING slot_id`, [claimTime]
    );
    const claimResults = await Promise.all([
      claimSlot(claimInsert.rows[0].slot_id, 'acceptance-worker-a'),
      claimSlot(claimInsert.rows[0].slot_id, 'acceptance-worker-b'),
    ]);
    assert.strictEqual(claimResults.filter(Boolean).length, 1, '两个 Worker 同时领取只能有一个成功');
    await pool.query('DELETE FROM ops.job_schedule_slots WHERE slot_id=$1', [claimInsert.rows[0].slot_id]);

    const manualInsert = await pool.query(
      `INSERT INTO ops.job_schedule_slots(job_code,scheduled_for,business_date,status,next_attempt_at,request_payload)
       VALUES('market_close:A股',$1,CURRENT_DATE,'pending',$1,'{}'::jsonb) RETURNING slot_id`, [claimTime]
    );
    const manualExisting = await enqueueManualJob('market_close:A股');
    assert.strictEqual(String(manualExisting.slot_id), String(manualInsert.rows[0].slot_id), '非强制手动补跑应复用同日可执行计划');
    await pool.query('DELETE FROM ops.job_schedule_slots WHERE slot_id=$1', [manualInsert.rows[0].slot_id]);

    const staleInsert = await pool.query(
      `INSERT INTO ops.job_schedule_slots(job_code,scheduled_for,business_date,status,attempt_count,next_attempt_at)
       VALUES('stock_analysis_refresh',$1,'2099-01-01','running',1,NULL) RETURNING slot_id`, [claimTime]
    );
    const staleSlot = await completeSlot(staleInsert.rows[0].slot_id, 'succeeded', { ok: true }, null, null);
    assert.strictEqual(staleSlot.status, 'degraded', '成功但水位落后只能标记 degraded');
    let dueAfterDegraded = [];
    for (let scan = 0; scan < 10; scan++) {
      dueAfterDegraded = await listDueSlots(100);
      assert.ok(!dueAfterDegraded.some(slot => String(slot.slot_id) === String(staleInsert.rows[0].slot_id)), `第 ${scan + 1} 次扫描不得重新执行 degraded`);
    }
    await pool.query('DELETE FROM ops.alert_notifications WHERE slot_id=$1', [staleInsert.rows[0].slot_id]);
    await pool.query('DELETE FROM ops.job_schedule_slots WHERE slot_id=$1', [staleInsert.rows[0].slot_id]);

    // 使用月初且不超过月度任务 24 小时截止线的时间，避免验收测试自己触发漏跑告警。
    const catchupNow = new Date(Date.UTC(2030, 3, 1, 0, 30, 0));
    const catchupStart = new Date(Date.UTC(2030, 3, 1, 0, 0, 0));
    const catchupEnd = new Date(Date.UTC(2030, 3, 2, 0, 0, 0));
    try {
      await syncScheduleSlots(catchupNow);
      const latestOnlyRows = await pool.query(
        `SELECT COUNT(*)::int AS count FROM ops.job_schedule_slots
          WHERE job_code='ipo_calendar_refresh' AND scheduled_for >= $1 AND scheduled_for < $2`,
        [catchupStart, catchupEnd]
      );
      assert.strictEqual(latestOnlyRows.rows[0].count, 1, 'latest_only 补跑窗口缺失多天时只能生成一个实例');
    } finally {
      const testSlots = await pool.query(
        `SELECT slot_id FROM ops.job_schedule_slots WHERE scheduled_for >= $1 AND scheduled_for < $2`,
        [new Date(catchupStart.getTime() - 31 * 24 * 60 * 60 * 1000), catchupEnd]
      );
      if (testSlots.rows.length) {
        await pool.query('DELETE FROM ops.alert_notifications WHERE slot_id=ANY($1::bigint[])', [testSlots.rows.map(row => row.slot_id)]);
        await pool.query('DELETE FROM ops.job_schedule_slots WHERE slot_id=ANY($1::bigint[])', [testSlots.rows.map(row => row.slot_id)]);
      }
    }

    console.log('job-execution-protection: 状态机、任务契约、估值拆分、Tushare 错误分类和 PostgreSQL API 保护通过');
  } finally {
    require('https').request = originalRequest;
    guard.resetExternalCallGuard();
    await guard.resetExternalCallGuardPersistence('tushare');
    await guard.resetExternalCallGuardPersistence('tushare_backup');
    if (originalToken === undefined) delete process.env.TUSHARE_TOKEN;
    else process.env.TUSHARE_TOKEN = originalToken;
    await require('../db/connection').pool.end();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { pool, tryClaimJob, releaseJob, startJobRun, finishJobRun } = require('../db');
const { syncConvertibleBondUniverse } = require('../services/convertibleBondAnalysis');
const { buildDailyMetrics } = require('../services/convertibleBondListService');
const { calculateConvertibleBondCallStatus } = require('../services/convertibleBondRedemptionService');
const { calculateConvertibleBondRevisionStatus, CALCULATION_LOGIC_VERSION } = require('../services/convertibleBondRevisionService');
const { calculateConvertibleBondRevisionMotiveScores, MOTIVE_MODEL_VERSION } = require('../services/convertibleBondRevisionMotiveService');
const { expectedTradeDate } = require('../routes/bondCycle');
const { dailyConsistencyStats } = require('./consistencyStats');
const { publishDatasetPartition } = require('../services/datasetPartitions');
const repository = require('../repositories/convertibleBondRefreshRepository.js');

const VALUATION_JOB = 'convertible_bond_valuation_refresh';
const DAILY_REFRESH_HOUR = 8;
const DAILY_REFRESH_MINUTE = 0;

// 每日估值+预警：在行情/周期同步完成后串行执行（方案 §顺序：行情→周期→估值→预警）
async function runDailyValuation(reason = 'scheduled', expectedDate = expectedTradeDate()) {
  if (!(await tryClaimJob(VALUATION_JOB))) return { skipped: true, reason: 'locked' };
  let runId = null;
  try {
    runId = await startJobRun(VALUATION_JOB);
    const root = path.join(__dirname, '..', '..');
    const script = path.join(root, 'server', 'scripts', 'convertibleBondValuation.py');
    const pythonCandidates = [
      process.env.VALUATION_PYTHON,
      path.join(root, 'venv', 'Scripts', 'python.exe'),
      path.join(root, 'venv', 'bin', 'python'),
      path.join(root, 'ipo-report', 'venv', 'bin', 'python'),
      'python3',
    ].filter(Boolean);
    const py = pythonCandidates.find(candidate => candidate === 'python3' || fs.existsSync(candidate)) || pythonCandidates[pythonCandidates.length - 1];
    const output = await new Promise((resolve, reject) => {
      execFile(py, [script, 'refresh'], {
        cwd: root,
        timeout: 15 * 60 * 1000,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, VALUATION_EXPECTED_TRADE_DATE: expectedDate },
      }, (err, stdout, stderr) => {
        if (err) {
          err.detail = String(stderr || err.message).trim().split('\n').slice(-5).join(' | ');
          reject(err);
          return;
        }
        resolve(String(stdout || '').trim());
      });
    });
    const detail = output.split('\n').slice(-3).join(' | ') || `${reason}: ok`;
    const { rows: countRows } = await repository.select_analytics_convertible_bond_valuation_daily([expectedDate]);
    await publishDatasetPartition('bond_valuation', 'CN', {
      partitionKey: expectedDate, dataAsOf: expectedDate, rowCount: Number(countRows[0]?.count || 0),
      diagnostics: { job: VALUATION_JOB },
    });
    await finishJobRun(runId, true, detail);
    return { ok: true, detail };
  } catch (error) {
    const { rows } = await repository.select_analytics_convertible_bond_valuation_models();
    const modelVersion = rows[0] ? rows[0].model_version : 'none';
    const detail = (`model=${modelVersion}; reason=${String(error.detail || error.message || 'unknown')}`).slice(0, 2000);
    await repository.update_ops_sync_cursors([detail]);
    await finishJobRun(runId, false, detail);
    throw error;
  } finally {
    await releaseJob(VALUATION_JOB);
  }
}

function nextShanghaiDelay(hour = DAILY_REFRESH_HOUR, minute = DAILY_REFRESH_MINUTE, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const p = Object.fromEntries(parts.map(item => [item.type, item.value]));
  const current = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  let target = Date.UTC(+p.year, +p.month - 1, +p.day, hour, minute, 0);
  if (target <= current) target += 24 * 3600 * 1000;
  return target - current;
}

async function bootstrapConvertibleBonds() {
  const { rows } = await repository.select_fundamental_convertible_bond_profiles();
  if (rows[0].count > 0) return { skipped: true, reason: 'already_initialized' };
  return syncConvertibleBondUniverse('first_full_sync');
}

async function refreshCompleteness(expected = expectedTradeDate()) {
  const { rows } = await repository.select_market_convertible_bond_daily_metrics([expected]);
  return { expected, ...rows[0] };
}

async function runRefreshChain(reason, businessDate = null) {
  // 估值任务只读取已入库的主档、行情和周期数据；上游同步由
  // convertible_bond_universe_refresh 独立负责，禁止在这里重复联网。
  // 计划槽位的业务日期决定“上一交易日”口径；人工晚间补跑不能因当前时钟跨过 18:00 就跳到当天半成品行情。
  const expectedDate = businessDate
    ? expectedTradeDate(new Date(`${String(businessDate).slice(0, 10)}T00:00:00+08:00`))
    : expectedTradeDate();
  const completeness = await refreshCompleteness(expectedDate);
  if (completeness.stale_snapshots) {
    console.warn(`[bond-analysis] ${completeness.stale_snapshots} 只转债的分析快照转股价与主档不一致，页面将提示需重新分析`);
  }
  if (completeness.open_conv_price_issues) {
    console.warn(`[bond-analysis] 尚有 ${completeness.open_conv_price_issues} 条转股价变动待跟进`);
  }
  if (!completeness.cycle_complete || !completeness.universe_complete) {
    console.warn(`[bond-analysis] ${completeness.expected} 数据不完整（主档 ${completeness.universe_complete ? 'ok' : '缺'}／周期 ${completeness.cycle_complete ? 'ok' : '缺'}），跳过估值，次日 08:00 自动重试`);
    return { ok: false, status: 'partial', incomplete: true, expected: completeness.expected,
      externalCalls: 0, datasets: [{ code: 'convertible_bond_valuation', status: 'blocked', dataAsOf: null }] };
  }

  let listResult = null;
  let redemptionResult = null;
  let revisionResult = null;
  let motiveResult = null;
  let analysisResult = null;
  try {
    redemptionResult = await calculateConvertibleBondCallStatus(completeness.expected);
    console.log(`[bond-redemption] 强赎进度完成：${redemptionResult.count} 只，完整 ${redemptionResult.complete} 只`);
  } catch (error) {
    // 强赎监控是派生展示链路，失败时不阻断已有上市列表和估值链路。
    console.error('[bond-redemption] 强赎进度失败，保留上一份有效数据：', error.message);
  }
  try {
    revisionResult = await calculateConvertibleBondRevisionStatus(completeness.expected);
    console.log(`[bond-revision] 下修进度完成：${revisionResult.count} 只，完整 ${revisionResult.complete} 只`);
  } catch (error) {
    // 下修监控是派生展示链路，失败时保留上一份有效快照，不阻断其他可转债链路。
    console.error('[bond-revision] 下修进度失败，保留上一份有效数据：', error.message);
  }
  if (revisionResult) {
    try {
      motiveResult = await calculateConvertibleBondRevisionMotiveScores(completeness.expected);
      console.log(`[bond-revision-motive] 动机评分完成：${motiveResult.count} 只，完整 ${motiveResult.complete} 只`);
    } catch (error) {
      // 动机评分是研究派生链路，失败不覆盖上一份评分，也不阻断估值。
      console.error('[bond-revision-motive] 动机评分失败，保留上一份有效数据：', error.message);
    }
  }
  try {
    listResult = await buildDailyMetrics({ tradeDate: completeness.expected, reason });
    console.log(`[bond-list] 上市转债列表完成：${listResult.count} 条，完整 ${listResult.complete} 条`);
  } catch (error) {
    // 列表派生指标失败不阻断现有估值链路，且事务回滚后保留上一份有效列表。
    console.error('[bond-list] 列表派生指标失败，保留上一份有效数据：', error.message);
  }

  try {
    const result = await runDailyValuation(reason, expectedDate);
    analysisResult = await require('../services/convertibleBondAnalysisSnapshots').refreshAllConvertibleBondAnalysis(expectedDate);
    if (result.skipped) console.log('[bond-valuation] 已有刷新任务运行，本次跳过');
    else console.log('[bond-valuation] 每日估值完成:', result.detail);
    return { ok: analysisResult.ok, status: analysisResult.ok ? 'succeeded' : 'partial', dataAsOf: completeness.expected, externalCalls: 0,
      datasetDiagnostics:{bond_analysis_snapshot:{partition_row_count:analysisResult.count,expected_count:analysisResult.expected,
        quality_status:analysisResult.ok?'passed':'failed',query_status:analysisResult.ok?'success':'failed',
        input_quality:Object.keys(analysisResult.missingFields).length?'partial':'passed'}},
      ...(analysisResult.ok ? {} : {failedDatasets:['bond_analysis_snapshot'],error:analysisResult.error,errorType:'data_quality'}),
      datasets: [
        { code: 'convertible_bond_revision', status: revisionResult ? 'succeeded' : 'stale', dataAsOf: revisionResult ? completeness.expected : null },
        { code: 'convertible_bond_revision_motive', status: motiveResult ? 'succeeded' : 'stale', dataAsOf: motiveResult ? completeness.expected : null },
        { code: 'convertible_bond_redemption', status: redemptionResult ? 'succeeded' : 'stale', dataAsOf: redemptionResult ? completeness.expected : null },
        { code: 'convertible_bond_list_metrics', status: listResult ? 'succeeded' : 'stale', dataAsOf: listResult ? completeness.expected : null },
        { code: 'convertible_bond_valuation', status: 'succeeded', dataAsOf: completeness.expected },
        { code: 'bond_analysis_snapshot', status: analysisResult.status, dataAsOf: expectedDate, rowCount:analysisResult.count },
      ], result, listResult,analysisResult };
  } catch (error) {
    console.error('[bond-valuation] 每日估值失败:', String(error.detail || error.message));
    return { ok: false, error: String(error.detail || error.message) };
  } finally {
    try {
      const stats = await dailyConsistencyStats();
      console.log(`[一致性统计] 转债快照 ${stats.bond_snapshots} 份，转股价错配 ${stats.bond_conv_price_mismatch} 份，未处理问题 ${stats.open_conv_price_issues} 条；股票快照 ${stats.stock_snapshots} 份，待补水位 ${stats.stock_legacy_watermark} 份`);
    } catch (e) { console.warn('[一致性统计] 统计失败（不影响主链）:', e.message); }
  }
}

function scheduleConvertibleBondRefresh() {
  bootstrapConvertibleBonds().catch(error => console.error('[bond-analysis] 首次全量同步失败:', error.message));

  function scheduleDaily(hour, minute, task) {
    const timer = setTimeout(async () => {
      try { await task(); }
      catch (error) { console.error('[bond-analysis] 定时任务执行失败:', error.message); }
      finally { scheduleDaily(hour, minute, task); }
    }, nextShanghaiDelay(hour, minute));
    if (timer.unref) timer.unref();
  }

  scheduleDaily(DAILY_REFRESH_HOUR, DAILY_REFRESH_MINUTE,
    () => require('../services/convertibleBondAnalysis').syncConvertibleBondUniverseWithBackfill('daily_incremental'));
  scheduleDaily(7, 40, async () => {
    const symbolic = await require('../services/convertibleBondAnalysis').resolveConvertibleBondSymbolicLocks();
    if (symbolic.resolved) console.log(`[bond-revision] 董事会锁定已按官方公告解析 ${symbolic.resolved} 只`);
    const result = await require('../services/convertibleBondAnalysis').syncConvertibleBondAnnouncementHistories({ mode: 'core' });
    console.log(`[bond-announcement] 统一公告同步完成：扫描 ${result.fromDate || '首次全量'} 至 ${result.toDate}`);
  });
  scheduleDaily(17, 30, () => require('../services/convertibleBondAnalysis').syncConvertibleBondAnnouncementHistories({ mode: 'calendar' }));
  scheduleDaily(DAILY_REFRESH_HOUR, DAILY_REFRESH_MINUTE + 15, () => runRefreshChain('daily_valuation'));
  console.log('[bond-analysis] 已调度：每日 07:40/17:30 统一同步可转债公告与生命周期，08:00 同步行情，08:15 刷新估值（上海时间）');
}

// 新版本发布后，即使当天 08:15 的估值槽已经成功，强赎计算也可能尚未按新公式生成。
// 启动时只检查本地覆盖率，缺失时补跑派生计算；不重新请求行情或公告接口。
async function runRedemptionStartupCatchup() {
  const jobCode = 'convertible_bond_redemption_refresh';
  if (!(await tryClaimJob(jobCode))) return { skipped: true, reason: 'locked' };
  try {
    const { rows } = await repository.with_market_convertible_bond_daily_metrics();
    const row = rows[0] || {};
    const eligible = Number(row.eligible_count || 0);
    const calculated = Number(row.calculated_count || 0);
    if (!row.trade_date || !eligible || calculated >= eligible) {
      return { skipped: true, reason: 'coverage_ok', tradeDate: row.trade_date || null, eligible, calculated };
    }
    const result = await calculateConvertibleBondCallStatus(row.trade_date);
    return { ...result, reason: 'startup_catchup', eligible, calculatedBefore: calculated };
  } finally {
    await releaseJob(jobCode);
  }
}

// 启动补漏：只在公告游标或下修派生结果落后时执行，正常启动不重复请求外部接口。
// 公告游标落后时沿用公告服务的 3 日重叠窗口，成功后再重算当前行情日。
async function runRevisionStartupCatchup() {
  const jobCode = 'convertible_bond_revision_refresh';
  if (!(await tryClaimJob(jobCode))) return { skipped: true, reason: 'locked' };
  try {
    const { rows } = await repository.select_market_convertible_bond_daily_metrics_1([CALCULATION_LOGIC_VERSION, MOTIVE_MODEL_VERSION]);
    const row = rows[0] || {};
    if (!row.market_date) return { skipped: true, reason: 'no_market_data' };
    let announcement = null;
    const announcementStale = !row.announcement_date || String(row.announcement_date).slice(0, 10) < String(row.expected_date || row.market_date).slice(0, 10)
      || Number(row.announcement_errors || 0) > 0;
    if (announcementStale) {
      announcement = await require('../services/convertibleBondAnalysis').syncConvertibleBondAnnouncementHistories({});
    } else if (Number(row.pending_parse || 0) > 0) {
      announcement = await require('../services/convertibleBondAnalysis').syncConvertibleBondAnnouncementHistories({ cachedOnly: true });
    }
    const needsCalculation = !row.state_date || String(row.state_date).slice(0, 10) < String(row.market_date).slice(0, 10)
      || row.logic_version_current !== true
      || announcementStale || Boolean(announcement && announcement.changed_count);
    const calculation = needsCalculation
      ? await calculateConvertibleBondRevisionStatus(row.market_date)
      : { skipped: true, reason: 'coverage_ok', tradeDate: row.market_date };
    const needsMotive = !row.motive_date || String(row.motive_date).slice(0, 10) < String(row.market_date).slice(0, 10);
    const motive = needsMotive
      ? await calculateConvertibleBondRevisionMotiveScores(row.market_date)
      : null;
    return { ok: true, reason: 'startup_catchup', announcement, calculation, motive };
  } finally {
    await releaseJob(jobCode);
  }
}

module.exports = {
  nextShanghaiDelay,
  bootstrapConvertibleBonds,
  refreshCompleteness,
  runRedemptionStartupCatchup,
  runRevisionStartupCatchup,
  runRefreshChain,
  runDailyValuation,
  scheduleConvertibleBondRefresh,
};

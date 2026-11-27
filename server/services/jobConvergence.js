'use strict';
/**
 * 波次二（T+1 凌晨）任务收敛编排（方案 5.2 / 5.3，阶段 2/3）。
 *
 * 设计红线：
 * - 不新增平行数据源、平行事实表或第二调度器：本模块只按显式顺序调用既有业务 Runner / 服务入口。
 * - 每个子阶段独立 try/catch：失败只记 failedDatasets / pendingStages，不阻断其余子阶段，
 *   已成功子阶段的分区保持已发布（安全评分失败不得回滚估值分区、现金分红失败不得阻断换股结算）。
 * - 发布统一走 datasetPartitionRegistry.publishJobDatasets（与 jobRunnerProcess 同一入口），
 *   聚合任务自身的契约 publish=[]，由 Runner 逐子阶段发布，避免把子阶段诊断洗成汇总快照。
 * - 子阶段业务日：计划槽 business_date 是执行日（如周六），targetDate 才是已收盘的上一交易日；
 *   所有分区发布、PB 投影和选股归档都使用 targetDate，绝不用执行日冒充目标日。
 */

const { publishJobDatasets, areDatasetPartitionsPublished } = require('./datasetPartitionRegistry');
const { expectedDataDate, previousTradingDateOf } = require('./jobScheduleSlots');

function isChildFailure(result) {
  if (!result || typeof result !== 'object') return true;
  if (result.ok === false) return true;
  if (result.error) return true;
  return result.status === 'failed';
}

function numeric(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 串行执行子阶段并聚合证据。
 * stage: { id, jobCode, datasets[], run(), context{}, publish:true|false, publishCode, requires[], skip() }
 */
async function runAggregate({ stages, targetDate, runChild, pendingStages = [] }) {
  const failedDatasets = [];
  const pendingStageIds = [];
  const summaries = [];
  const datasetDiagnostics = {};
  const stageOk = new Map();
  // 续跑只重试失败/未完成的子阶段：上一轮已成功的子阶段不重复外采与计算。
  // 只认本编排自己的阶段 id，子阶段内部的 pendingStages（如 pdfParse）不会误当阶段过滤器。
  const knownStages = new Set(stages.map(stage => stage.id));
  const resumeStages = (Array.isArray(pendingStages) ? pendingStages : [])
    .map(String).filter(id => knownStages.has(id));
  let externalCalls = 0;
  let firstError = null;
  let continuationRequired = false;
  let continuationResult = null;

  for (const stage of stages) {
    if (resumeStages.length && !resumeStages.includes(stage.id)) {
      summaries.push({ stage: stage.id, status: 'skipped', reason: 'already_completed' });
      stageOk.set(stage.id, true);
      continue;
    }
    if (typeof stage.skip === 'function') {
      let skipped = null;
      try {
        skipped = await stage.skip();
      } catch (error) {
        skipped = null;
        summaries.push({ stage: stage.id, status: 'skip_check_failed', error: String(error && error.message || error).slice(0, 300) });
      }
      if (skipped) {
        summaries.push({ stage: stage.id, status: 'skipped', reason: String(skipped).slice(0, 300) });
        stageOk.set(stage.id, true);
        continue;
      }
    }
    // 显式顺序依赖：套利换股结算只依赖 arbitrage_cases（core）成功，与现金分红互不阻断。
    if (Array.isArray(stage.requires) && stage.requires.some(id => stageOk.get(id) === false)) {
      stageOk.set(stage.id, false);
      for (const dataset of stage.datasets || []) if (!failedDatasets.includes(dataset)) failedDatasets.push(dataset);
      pendingStageIds.push(stage.id);
      summaries.push({ stage: stage.id, status: 'skipped_dependency', reason: 'upstream_stage_failed' });
      continue;
    }
    let result = null;
    let error = null;
    try {
      result = typeof stage.run === 'function'
        ? await stage.run()
        : await runChild(stage.jobCode, { ...(stage.context || {}) });
      if (isChildFailure(result)) {
        error = (result && (result.error || result.reason)) || '子阶段执行失败';
      } else if (stage.publish !== false && result && result.continuationRequired !== true) {
        const partitionDate = (result && (result.partitionKey || result.partition_key)) || targetDate;
        await publishJobDatasets(stage.publishCode || stage.jobCode, partitionDate, result);
      }
    } catch (caught) {
      error = caught;
    }
    externalCalls += numeric(result && (result.attemptExternalCalls ?? result.externalCalls));
    if (error) {
      stageOk.set(stage.id, false);
      const message = String(error && error.message || error).slice(0, 500);
      if (!firstError) firstError = error instanceof Error ? error : { message };
      const declared = Array.isArray(stage.datasets) && stage.datasets.length ? stage.datasets : [stage.jobCode];
      const childFailed = Array.isArray(result && result.failedDatasets) && result.failedDatasets.length
        ? result.failedDatasets.map(String) : declared;
      for (const dataset of childFailed) if (!failedDatasets.includes(dataset)) failedDatasets.push(dataset);
      pendingStageIds.push(stage.id);
      const missingDates = Array.isArray(result && (result.missingDates || result.missing_dates))
        ? (result.missingDates || result.missing_dates) : [];
      for (const dataset of childFailed) {
        datasetDiagnostics[dataset] = {
          stage: stage.id,
          coverage_status: 'incomplete',
          missingDates: missingDates.length ? missingDates : [targetDate],
          error: message,
        };
      }
      summaries.push({ stage: stage.id, status: 'failed', error: message });
      continue;
    }
    stageOk.set(stage.id, true);
    if (result && result.continuationRequired === true) {
      continuationRequired = true;
      continuationResult = continuationResult || result;
      for (const pendingName of Array.isArray(result.pendingStages) ? result.pendingStages : [stage.id]) {
        if (!pendingStageIds.includes(String(pendingName))) pendingStageIds.push(String(pendingName));
      }
      summaries.push({ stage: stage.id, status: 'partial', reason: result.waitReason || 'continuation_required' });
      continue;
    }
    summaries.push({
      stage: stage.id,
      status: (result && (result.status || (result.skipped ? 'skipped' : 'succeeded'))) || 'succeeded',
      datasets: Array.isArray(result && result.publishDatasetCodes) ? result.publishDatasetCodes : (stage.datasets || []),
    });
  }

  const ok = failedDatasets.length === 0 && !continuationRequired;
  const aggregate = {
    ok,
    status: ok ? 'succeeded' : 'partial',
    mode: 'core',
    stageComplete: ok,
    dataAsOf: targetDate,
    partitionKey: targetDate,
    trade_date: targetDate,
    targetTradeDate: targetDate,
    stageSummaries: summaries,
    failedDatasets,
    pendingStages: pendingStageIds,
    datasetDiagnostics,
    externalCalls,
  };
  if (continuationRequired) {
    aggregate.continuationRequired = true;
    aggregate.nextAttemptInMinutes = Number(continuationResult && continuationResult.nextAttemptInMinutes) || 5;
    if (continuationResult && continuationResult.nextAttemptAt) aggregate.nextAttemptAt = continuationResult.nextAttemptAt;
    aggregate.waitReason = continuationResult && continuationResult.waitReason;
  }
  if (!ok && !continuationRequired) {
    aggregate.error = String(firstError && firstError.message || '子阶段未全部完成').slice(0, 500);
    aggregate.errorCode = firstError && firstError.code || 'DATASET_INCOMPLETE';
    aggregate.errorType = firstError && firstError.errorType || 'data_quality';
    if (firstError && firstError.source) aggregate.source = firstError.source;
    if (firstError && firstError.apiName) aggregate.apiName = firstError.apiName;
    if (firstError && firstError.recoverAt) aggregate.recoverAt = firstError.recoverAt;
  }
  return aggregate;
}

function stageChild(runChild, reason, businessDate) {
  return (code, stageContext) => runChild(code, reason, businessDate, stageContext || {});
}

function targetTradeDateOf(jobCode, businessDate, context) {
  if (context && context.targetTradeDate) return String(context.targetTradeDate).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(String(businessDate || ''))
    ? expectedDataDate(jobCode, businessDate) : null;
}

async function runCnStockEodSync(reason, businessDate, context, runChild) {
  const targetDate = targetTradeDateOf('cn_stock_eod_sync', businessDate, context);
  if (!targetDate) return { ok: false, status: 'blocked', mode: 'core', error: '缺少目标交易日', failedDatasets: [] };
  const stages = [
    { id: 'shared_market_eod', jobCode: 'convertible_bond_universe_refresh', datasets: ['bond_master', 'bond_daily', 'stock_daily', 'stock_valuation', 'stock_adj_factor', 'stock_suspend_calendar', 'repo_daily_rates'], context: { mode: 'shared_eod', targetTradeDate: targetDate } },
    { id: 'company_financials', jobCode: 'company_financial_incremental_sync', datasets: ['stock_financial_reports'], context: { mode: 'core', targetTradeDate: targetDate } },
    { id: 'selection_inputs_cn', jobCode: 'company_financial_incremental_sync', datasets: ['stock_financial_reports'], context: { mode: 'selection_inputs', market: 'CN', targetTradeDate: targetDate } },
    { id: 'index_daily', jobCode: 'index_recent', datasets: ['index_daily'] },
    { id: 'market_volatility', jobCode: 'market_volatility_sync', datasets: ['market_volatility'] },
    {
      id: 'pb_projection',
      jobCode: 'pb_projection_cn',
      datasets: [],
      publish: false,
      run: async () => {
        // 写入口已由各业务同步触发；这里做一次幂等兜底，保证估值入库后投影一定跟上。
        const result = await require('./pbProjectionSync').safeSyncValuations({ market: 'CN', dates: [targetDate] });
        return { ok: result && result.ok !== false, mode: 'core', ...result };
      },
    },
  ];
  return runAggregate({ stages, targetDate, runChild: stageChild(runChild, reason, businessDate), pendingStages: context && context.pendingStages });
}

async function runHkStockEodSync(reason, businessDate, context, runChild) {
  // 港股目标日按港交所日历回看；CN 休市而港股开市时仍取到港股上一交易日。
  const targetDate = (context && context.targetTradeDate)
    ? String(context.targetTradeDate).slice(0, 10)
    : await previousTradingDateOf('HK', businessDate).catch(() => null);
  if (!targetDate) return { ok: false, status: 'blocked', mode: 'core', error: '无法确定上一港股交易日', failedDatasets: [] };
  const stages = [
    { id: 'hk_calendar', jobCode: 'hk_trade_calendar_sync', datasets: ['hk_trade_calendar'] },
    { id: 'hk_trade_rules', jobCode: 'hk_trade_rules_sync', datasets: ['hk_trade_rules'] },
    { id: 'selection_inputs_hk', jobCode: 'company_financial_incremental_sync', datasets: ['stock_financial_reports'], context: { mode: 'selection_inputs', market: 'HK', targetTradeDate: targetDate } },
    {
      id: 'pb_projection',
      jobCode: 'pb_projection_hk',
      datasets: [],
      publish: false,
      run: async () => {
        const result = await require('./pbProjectionSync').safeSyncValuations({ market: 'HK', dates: [targetDate] });
        return { ok: result && result.ok !== false, mode: 'core', ...result };
      },
    },
  ];
  return runAggregate({ stages, targetDate, runChild: stageChild(runChild, reason, businessDate), pendingStages: context && context.pendingStages });
}

async function runConvertibleBondEodSync(reason, businessDate, context, runChild) {
  const targetDate = targetTradeDateOf('convertible_bond_eod_sync', businessDate, context);
  if (!targetDate) return { ok: false, status: 'blocked', mode: 'core', error: '缺少目标交易日', failedDatasets: [] };
  // 单一采集入口：01:00 的 cn_stock_eod_sync 已用共享 Runner 发布主档/日线时不再重复联网，
  // 只补本任务独有的持有人/质押输入；缺失时才回退调用同一 Runner。
  let sharedReady = false;
  try {
    sharedReady = await areDatasetPartitionsPublished(['bond_master', 'bond_daily'], targetDate, { market: 'CN' });
  } catch (error) {
    sharedReady = false;
  }
  const stages = [
    {
      id: 'bond_master_daily',
      jobCode: 'convertible_bond_universe_refresh',
      datasets: ['bond_master', 'bond_daily'],
      context: { mode: 'shared_eod', targetTradeDate: targetDate },
      skip: () => (sharedReady ? 'shared_collector_already_published' : null),
    },
    { id: 'bond_motive_inputs', jobCode: 'convertible_bond_revision_motive_inputs_sync', datasets: ['bond_motive_inputs'], context: { businessDate: targetDate } },
  ];
  return runAggregate({ stages, targetDate, runChild: stageChild(runChild, reason, businessDate), pendingStages: context && context.pendingStages });
}

async function runExchangeAnnouncementsSync(reason, businessDate, context, runChild) {
  const targetDate = targetTradeDateOf('exchange_announcements_sync', businessDate, context);
  if (!targetDate) return { ok: false, status: 'blocked', mode: 'core', error: '缺少目标交易日', failedDatasets: [] };
  const stages = [
    { id: 'bond_announcements', jobCode: 'convertible_bond_announcement_history_sync', datasets: ['bond_announcement_facts', 'bond_issuance_events', 'bond_redemption_events'], context: { mode: 'core' } },
    { id: 'ipo_history', jobCode: 'ipo_history_sync', datasets: ['ipo_history'], context: { mode: 'core' } },
    { id: 'arbitrage_cases', jobCode: 'arbitrage_sync', datasets: ['arbitrage_cases'], context: { mode: 'core' } },
    // 现金分红与换股结算是同一任务的两个独立阶段：任一失败都不得阻断另一阶段。
    { id: 'cash_dividends', jobCode: 'arbitrage_sync', datasets: ['stock_cash_dividend_facts'], context: { mode: 'cash_dividends' } },
    { id: 'stock_swap_settle', jobCode: 'arbitrage_sync', datasets: ['stock_swap_settlements'], context: { mode: 'stock_swap_settle' }, requires: ['arbitrage_cases'] },
  ];
  return runAggregate({ stages, targetDate, runChild: stageChild(runChild, reason, businessDate), pendingStages: context && context.pendingStages });
}

async function runBondAnalyticsRefresh(reason, businessDate, context, runChild) {
  const targetDate = targetTradeDateOf('bond_analytics_refresh', businessDate, context);
  if (!targetDate) return { ok: false, status: 'blocked', mode: 'core', error: '缺少目标交易日', failedDatasets: [] };
  // 先估值、后安全评分：安全评分失败只记 failedDatasets，绝不回滚已发布的 bond_valuation / bond_analysis_snapshot 分区。
  const stages = [
    { id: 'bond_valuation', jobCode: 'convertible_bond_valuation_refresh', datasets: ['bond_valuation', 'bond_analysis_snapshot'], context: { targetTradeDate: targetDate } },
    { id: 'bond_safety', jobCode: 'bond_safety_refresh', datasets: ['bond_safety_snapshot'], context: { targetTradeDate: targetDate } },
  ];
  return runAggregate({ stages, targetDate, runChild: stageChild(runChild, reason, businessDate), pendingStages: context && context.pendingStages });
}

async function runStockAnalyticsRefresh(reason, businessDate, context, runChild) {
  const runDate = /^\d{4}-\d{2}-\d{2}$/.test(String(businessDate || '')) ? String(businessDate).slice(0, 10) : null;
  const targetDate = targetTradeDateOf('stock_analytics_refresh', runDate, context);
  if (!targetDate) return { ok: false, status: 'blocked', mode: 'core', error: '缺少目标交易日', failedDatasets: [] };
  const hkTargetDate = await previousTradingDateOf('HK', runDate || targetDate).catch(() => null);
  // 三域独立 try/catch：CN/HK 与选股轻量归档互不回滚；个股分析目标日为执行日（快照日），
  // 选股归档目标日为上一交易日（正式日/周结果必须落在已收盘日）。
  const stages = [
    { id: 'stock_analysis_cn', jobCode: 'stock_analysis_refresh', datasets: ['stock_analysis_snapshot'], publish: false, context: { mode: 'core', targetDate: runDate || targetDate } },
    {
      id: 'stock_analysis_hk',
      jobCode: 'stock_analysis_refresh',
      datasets: ['stock_analysis_snapshot'],
      publish: false,
      context: { mode: 'stock_analysis_hk', targetDate: hkTargetDate || undefined },
      skip: () => (hkTargetDate ? null : 'hk_calendar_unavailable'),
    },
    {
      id: 'selection_archive_light',
      jobCode: 'stock_analysis_refresh',
      datasets: ['stock_selection_daily_cn', 'stock_selection_daily_hk', 'stock_selection_weekly_cn', 'stock_selection_weekly_hk', 'stock_selection_shadow_cn', 'stock_selection_shadow_hk'],
      publish: false,
      context: { mode: 'selection_archive_light', targetDate },
    },
  ];
  return runAggregate({ stages, targetDate, runChild: stageChild(runChild, reason, businessDate), pendingStages: context && context.pendingStages });
}

async function runSystemRetention(reason, businessDate, context, runChild) {
  const stages = [
    { id: 'site_analytics_retention', jobCode: 'site_analytics_retention', datasets: [], publish: false },
    { id: 'storage_retention', jobCode: 'storage_retention', datasets: [], publish: false },
  ];
  return runAggregate({
    stages,
    targetDate: /^\d{4}-\d{2}-\d{2}$/.test(String(businessDate || '')) ? String(businessDate).slice(0, 10) : null,
    runChild: stageChild(runChild, reason, businessDate),
    pendingStages: context && context.pendingStages,
  });
}

module.exports = {
  runCnStockEodSync,
  runHkStockEodSync,
  runConvertibleBondEodSync,
  runExchangeAnnouncementsSync,
  runBondAnalyticsRefresh,
  runStockAnalyticsRefresh,
  runSystemRetention,
  runAggregate,
  isChildFailure,
};

const layerSql = require('../repositories/stockRefreshRepository');
const { tryClaimJob, releaseJob, startJobRun, finishJobRun } = require('../db');
const { listUserStocks, refreshStockAnalysis } = require('../services/stockAnalysis');
const { pool } = require('../db/connection');
const stockRefreshRepository = require('../repositories/stockRefreshRepository');
const { datasetScope, markDatasetFailure, markDatasetSuccess } = require('../services/datasetCursors');
const { dailyConsistencyStats } = require('./consistencyStats');
const CoreDate = require('../../public/shared/core-date.js');

const ANALYSIS_DATASET = 'stock_analysis';

const JOB = 'stock_analysis_refresh';

// 选股模式（方案 9.2）：与原单股/转债正股模式共用同一任务入口，但依赖、产出和完成条件各自声明。
// 这些模式外采为 0，只消费已核验的标准事实；任何外部采集仍走原行情/财务任务。
const SELECTION_MODES = Object.freeze([
  'selection_quarterly', 'selection_preview', 'selection_backtest', 'selection_inputs',
  // V2（方案 27.8）：每日动态与每周正式；二者共同支持 shadow=true 的影子批次。
  'selection_daily', 'selection_weekly',
  // 就绪时段触发的到期检查（18:40）：只入队日/周槽，计算由对应槽执行（B05）。
  'selection_periodic',
]);

function selectionDatasetCode(market, kind) {
  const suffix = String(market || '').toUpperCase() === 'HK' ? 'hk' : 'cn';
  return `stock_selection_${kind}_${suffix}`;
}

function quarterDateFallback(quarter) {
  return require('../services/stockSelectionService').quarterEndDate(quarter);
}

async function runSelectionMode(mode, reason, context) {
  const service = require('../services/stockSelectionService');
  // 到期检查模式（方案 27.8 / B05）：在数据就绪时段（默认 18:40）跨市场执行，
  // 只做"到期→入队"，计算由日/周槽自己领取执行；不要求单一 market，也不在这里算组合。
  if (mode === 'selection_periodic') {
    const queued = await enqueueDueSelectionPeriods(new Date());
    return {
      ok: true,
      status: 'succeeded',
      mode,
      publishDatasets: false,
      dataAsOf: null,
      stageComplete: true,
      stageCompletedKind: 'periodic_enqueued',
      queued,
      reason: queued.length ? undefined : 'no_periodic_target',
      datasetDiagnostics: {},
    };
  }
  const market = String(context.market || '').toUpperCase();
  if (!['CN', 'HK'].includes(market)) {
    return { ok: false, status: 'blocked', reason: 'selection_market_required', publishDatasets: false };
  }
  if (mode === 'selection_quarterly') {
    // 管理员没指定季度时按交易日历推最近一个已结束季度；同样必须 await。
    const quarter = context.quarter || (await service.pendingQuarter({ market })).quarter;
    if (!quarter) {
      return { ok: false, status: 'blocked', reason: 'selection_quarter_unresolved', publishDatasets: false, mode };
    }
    const result = await service.runQuarterly({ market, quarter, requestId: context.requestId });
    if (!result.ok) return Object.assign(result, { publishDatasets: false, mode });
    const { publishDatasetSnapshot } = require('../services/datasetPartitionRegistry');
    // R3-04：明确零合格是有效空仓结果，已正式发布时允许写 0 行分区（分区本身就是"本期无持仓"的证据），
    // 否则它会被当成"没有数据"而永远停在 preview_only、季度反复续跑。
    const publishedZeroSelection = result.published === true && Number(result.selectedCount || 0) === 0;
    // 只有正式发布的季度组合才产生可投资数据分区；预览状态的分区明确标 preview_only。
    const publication = await publishDatasetSnapshot(selectionDatasetCode(market, 'snapshot'), {
      partitionKey: result.quarterDate || quarterDateFallback(result.quarter),
      dataAsOf: result.quarterDate || quarterDateFallback(result.quarter),
      rowCount: result.selectedCount,
      allowEmpty: publishedZeroSelection,
      diagnostics: {
        quality_status: result.qualityStatus,
        business_status: result.businessStatus,
        query_status: 'success',
        coverage_status: result.published ? (publishedZeroSelection ? 'verified_no_member' : 'released') : 'preview_only',
        run_id: result.runId,
      },
      reason: 'job:stock_analysis_refresh:selection_quarterly',
    }).catch(error => ({ published: false, reason: 'publish_error', error: error.message }));
    const datasetCode = selectionDatasetCode(market, 'snapshot');
    // 已正式发布却写不进分区 → 任务必须失败，不能把"组合已发布但分区缺失"报成成功。
    const publicationFailed = result.published && !publication.published;
    // R2-05：阶段完成必须是**四种终态之一**，不能只看分区行有没有写成功：
    //   quarterly_published = 正式季度组合已发布且分区已落库（唯一"正式完成"）
    //   market_closed       = 指数 PB≥2 的正常业务关闭，是可核验的终态（有 runId 与质量结论）
    //   no_eligible_member  = 输入完整但没有合格股票：本季明确空仓（R3-04），不是数据缺口
    //   preview_only        = 只记录了部分/预览结果，输入未补齐 → 不得算完成，必须续跑
    //   failed              = 已发布但分区写入失败
    const released = result.published === true && publication.published === true;
    // 正常市场关闭（指数 PB≥2）不是数据缺失：本季度本就不该持股。
    // 它的终态证据是"该季度的质量裁决已经算出 market_closed"，不写空分区冒充已发布。
    const marketClosed = !released && result.businessStatus === 'market_closed' && Boolean(result.runId);
    const zeroSelection = released && Number(result.selectedCount || 0) === 0;
    const stageCompletedKind = publicationFailed ? 'failed'
      : zeroSelection ? 'no_eligible_member'
        : released ? 'quarterly_published'
          : marketClosed ? 'market_closed' : 'preview_only';
    const stageComplete = released || marketClosed;
    const resultBody = {
      ok: stageComplete && !publicationFailed,
      status: publicationFailed ? 'failed'
        : released ? 'succeeded'
          : marketClosed ? 'market_closed' : 'partial',
      mode,
      market,
      quarter: result.quarter,
      runId: result.runId,
      qualityStatus: result.qualityStatus,
      businessStatus: result.businessStatus,
      pendingCount: result.pendingCount || 0,
      qualityReasons: result.qualityReasons || [],
      dataAsOf: stageComplete ? (result.quarterDate || quarterDateFallback(result.quarter)) : null,
      // 分区已在本模式内显式发布，不再走通用发布路径，避免二次写入。
      publishDatasets: false,
      publishDatasetCodes: [datasetCode],
      stageComplete,
      stageCompletedKind,
      // 没到正式终态就是"部分完成"，必须续跑，不能凭一条 partial 分区结案。
      ...(stageComplete ? {} : {
        continuationRequired: true,
        reason: 'selection_not_publishable',
      }),
      ...(publicationFailed ? {
        error: `选股组合已发布但分区写入失败：${publication.error || publication.reason || 'unknown'}`,
        failedDatasets: [datasetCode],
      } : {}),
      datasetDiagnostics: {
        [selectionDatasetCode(market, 'snapshot')]: {
          partition_row_count: result.selectedCount,
          quality_status: result.qualityStatus,
          business_status: result.businessStatus,
          query_status: 'success',
          coverage_status: released ? (zeroSelection ? 'verified_no_member' : 'released') : (marketClosed ? 'market_closed' : 'preview_only'),
          run_id: result.runId,
          publication_reason: publication && publication.reason ? publication.reason : null,
          published: Boolean(publication && publication.published),
          stage_completed_kind: stageCompletedKind,
        },
      },
      selectionRunId: result.runId,
      published: result.published,
    };
    return resultBody;
  }
  if (mode === 'selection_daily' || mode === 'selection_weekly') {
    const periodType = mode === 'selection_daily' ? 'day' : 'week';
    const shadow = context.shadow === true;
    const prefix = shadow ? 'shadow' : (periodType === 'day' ? 'daily' : 'weekly');
    const datasetCode = `stock_selection_${prefix}_${market === 'HK' ? 'hk' : 'cn'}`;
    let result;
    try {
      result = await service.runPeriodic({
        market,
        periodType,
        targetDate: context.targetDate || context.businessDate,
        periodKey: context.periodKey,
        shadow,
        strategyCode: context.strategyCode,
        requestId: context.requestId,
        slotId: context.slotId,
        executionToken: context.executionToken,
        actor: context.actor,
        // 分区在服务事务内发布：指针、事件、质量分区同一次提交（方案 27.7）。
        datasetPublication: ({ runId, asOfDate, computed, qualityStatus, businessStatus }) => ({
          datasetCode,
          options: {
            partitionKey: asOfDate,
            dataAsOf: asOfDate,
            rowCount: computed.portfolio ? computed.portfolio.members.length : 0,
            allowEmpty: true,
            diagnostics: {
              quality_status: qualityStatus,
              business_status: businessStatus,
              query_status: 'success',
              coverage_status: shadow
                ? 'shadow_only'
                : (computed.portfolio && computed.portfolio.members.length === 0 ? 'verified_no_member' : 'released'),
              run_id: runId,
              period_type: periodType,
              period_key: context.periodKey || null,
              is_shadow: shadow,
              strategy_code: context.strategyCode || null,
            },
            reason: `job:stock_analysis_refresh:${mode}`,
          },
        }),
      });
    } catch (error) {
      // 分区写不进去或发布合同被拒：整笔已回滚，正式指针不移动，槽位按失败收尾。
      return {
        ok: false, status: 'failed', reason: error.reason || 'selection_publish_failed',
        error: error.message, mode, market, periodType, shadow,
        publishDatasets: false, publishDatasetCodes: [datasetCode],
        dataAsOf: null, stageComplete: false, stageCompletedKind: 'failed',
        failedDatasets: [datasetCode], datasetDiagnostics: {},
      };
    }
    if (!result.ok) {
      // no_session 是"整周期无交易日"的运营证据，属于可结案终态；日历缺档才是 blocked。
      const noSession = result.status === 'no_session';
      return {
        ok: noSession,
        status: result.status,
        reason: result.reason,
        mode, market, periodType,
        periodKey: result.periodKey,
        shadow,
        publishDatasets: false,
        dataAsOf: null,
        stageComplete: noSession,
        stageCompletedKind: noSession ? 'no_session' : undefined,
        datasetDiagnostics: {},
      };
    }
    const publishedFormal = !shadow && result.published === true;
    const zeroSelection = publishedFormal && Number(result.selectedCount || 0) === 0;
    // 分区已在服务事务内与指针/事件一起提交；这里只消费提交结果，不再另开事务写第二次。
    const publication = result.datasetPublication || { published: false, reason: 'not_published' };
    const publicationFailed = (publishedFormal || shadow) && !publication.published;
    // 终态：影子只证明"影子评估完成"，正式日结果记 daily_recorded，正式周度按是否零合格分开记。
    const stageCompletedKind = publicationFailed ? 'failed'
      : shadow ? 'shadow_evaluated'
        : periodType === 'day' ? 'daily_recorded'
          : zeroSelection ? 'no_eligible_member' : 'weekly_published';
    // 日结果即使全部通过也不推进 weekly 指针：它只在自己的 day 渠道发布。
    const stageComplete = shadow ? Boolean(publication.published) : publishedFormal && Boolean(publication.published);
    return {
      ok: stageComplete,
      status: publicationFailed ? 'failed' : (stageComplete ? 'succeeded' : 'partial'),
      mode, market, periodType,
      periodKey: result.periodKey,
      periodStart: result.periodStart,
      periodEnd: result.periodEnd,
      asOfDate: result.asOfDate,
      shadow,
      runId: result.runId,
      qualityStatus: result.qualityStatus,
      businessStatus: result.businessStatus,
      pendingCount: result.pendingCount || 0,
      qualityReasons: result.qualityReasons || [],
      readinessStatus: result.readinessStatus,
      publishDatasets: false,
      publishDatasetCodes: [datasetCode],
      stageComplete,
      stageCompletedKind,
      // 未就绪/未完成必须同时给出原因与下一次检查时刻，续跑由原等待语义承载（方案 27.6）。
      ...(stageComplete ? {} : {
        continuationRequired: true,
        reason: result.readinessStatus === 'not_ready' ? 'selection_not_ready' : 'selection_not_publishable',
        nextCheckAt: nextSelectionRecheckAt(),
        ...(result.readinessStatus === 'not_ready' ? { missingDatasets: [datasetCode], readinessStatus: 'not_ready' } : {}),
      }),
      ...(publicationFailed ? {
        error: `选股结果已记录但分区写入失败：${publication.error || publication.reason || 'unknown'}`,
        failedDatasets: [datasetCode],
      } : {}),
      datasetDiagnostics: {
        [datasetCode]: {
          partition_row_count: result.selectedCount,
          quality_status: result.qualityStatus,
          query_status: 'success',
          coverage_status: shadow ? 'shadow_only' : (publishedFormal ? 'released' : 'preview_only'),
          run_id: result.runId,
          period_type: periodType,
          period_key: result.periodKey,
          is_shadow: shadow,
          published: Boolean(publication && publication.published),
          stage_completed_kind: stageCompletedKind,
        },
      },
      selectionRunId: result.runId,
      published: result.published,
    };
  }
  if (mode === 'selection_inputs') {
    const targetDate = context.targetDate || context.businessDate;
    if (!targetDate) return { ok: false, status: 'blocked', reason: 'target_date_required', publishDatasets: false, mode };
    const asOfDate = String(targetDate).slice(0, 10);
    const audit = await service.auditInputs({ market, asOfDate });
    const { publishDatasetSnapshot } = require('../services/datasetPartitionRegistry');
    const publication = await publishDatasetSnapshot(selectionDatasetCode(market, 'inputs'), {
      partitionKey: asOfDate,
      dataAsOf: asOfDate,
      rowCount: audit.coverage.withValuation,
      diagnostics: {
        quality_status: audit.gapCount === 0 ? 'passed' : 'partial',
        query_status: 'success',
        coverage_status: audit.gapCount === 0 ? 'verified' : 'gaps_pending',
        universe_count: audit.coverage.universeCount,
        gap_count: audit.gapCount,
      },
      reason: 'job:stock_analysis_refresh:selection_inputs',
    }).catch(error => ({ published: false, reason: 'publish_error', error: error.message }));
    const inputDatasetCode = selectionDatasetCode(market, 'inputs');
    const clearedInputs = audit.gapCount === 0;
    return {
      // 审计成功但分区没写进去，同样不能算完成：下游看不到这份覆盖证据。
      ok: clearedInputs && Boolean(publication.published),
      status: publication.published ? (clearedInputs ? 'succeeded' : 'partial') : 'failed',
      mode,
      market,
      dataAsOf: asOfDate,
      publishDatasets: false,
      publishDatasetCodes: [inputDatasetCode],
      // R2-05：缺口未清空 = 只记录了部分覆盖，不是阶段完成。
      stageComplete: clearedInputs && Boolean(publication.published),
      stageCompletedKind: clearedInputs && publication.published ? 'inputs_cleared' : 'inputs_gaps_pending',
      ...(clearedInputs ? {} : { continuationRequired: true }),
      ...(publication.published ? {} : {
        error: `选股输入覆盖分区写入失败：${publication.error || publication.reason || 'unknown'}`,
        failedDatasets: [inputDatasetCode],
      }),
      // 缺口清单已持久化并可续跑；补齐仍走原行情/财务采集入口，本模式不自行联网。
      reason: clearedInputs ? undefined : 'selection_inputs_gaps_pending',
      gapCount: audit.gapCount,
      domainCounts: audit.domainCounts || {},
      queueId: audit.queueId,
      datasetDiagnostics: {
        [selectionDatasetCode(market, 'inputs')]: {
          partition_row_count: audit.coverage.withValuation,
          quality_status: clearedInputs ? 'passed' : 'partial',
          query_status: 'success',
          coverage_status: clearedInputs ? 'verified' : 'gaps_pending',
          universe_count: audit.coverage.universeCount,
          gap_count: audit.gapCount,
          domain_counts: audit.domainCounts || {},
          published: Boolean(publication && publication.published),
          stage_completed_kind: clearedInputs && publication.published ? 'inputs_cleared' : 'inputs_gaps_pending',
        },
      },
    };
  }
  if (mode === 'selection_backtest') {
    const backtest = require('../services/stockSelectionBacktest');
    const result = await backtest.runBacktest({
      market,
      startDate: String(context.startDate || ''),
      endDate: String(context.endDate || ''),
      currency: context.currency || 'LOCAL',
    });
    return {
      ok: result.status !== 'not_evaluable',
      status: result.status === 'not_evaluable' ? 'blocked' : 'succeeded',
      mode,
      market,
      backtestId: result.backtestId,
      publishDatasets: false,
      dataAsOf: null,
      stageComplete: result.status !== 'not_evaluable',
      stageCompletedKind: result.status === 'not_evaluable' ? 'backtest_not_evaluable' : 'backtest_evaluated',
      datasetDiagnostics: {},
    };
  }
  // selection_preview：管理员按明确目标日试算，标为预览，不替换正式季度组合。
  const asOfDate = String(context.targetDate || context.businessDate || '').slice(0, 10);
  if (!asOfDate) return { ok: false, status: 'blocked', reason: 'target_date_required', publishDatasets: false, mode };
  const result = await service.computeAndPersist({
    market, asOfDate, runKind: 'preview', requestId: context.requestId,
  });
  // R2-05：预览的终态是"预览已记录"，与"质量通过/正式发布"是两件事，这里必须写明。
  return {
    ok: true,
    status: 'succeeded',
    mode,
    market,
    dataAsOf: asOfDate,
    runId: result.runId,
    qualityStatus: result.run && result.run.quality_status,
    publishDatasets: false,
    stageComplete: true,
    stageCompletedKind: 'preview_recorded',
    datasetDiagnostics: {},
  };
}

function nextShanghaiDelay(hour = 8, minute = 20, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(now);
  const p = Object.fromEntries(parts.map(item => [item.type, item.value]));
  const current = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  let target = Date.UTC(+p.year, +p.month - 1, +p.day, hour, minute, 0);
  if (target <= current) target += 24 * 3600 * 1000;
  return target - current;
}

async function latestStockAnalysisDate() {
  const { rows } = await stockRefreshRepository.latestAnalysisDate();
  return rows[0] && rows[0].data_as_of ? String(rows[0].data_as_of).slice(0, 10) : null;
}

function targetDateStatus(targetDate, now = new Date()) {
  const requested = CoreDate.normalizeBusinessDate(targetDate);
  const today = CoreDate.todayInZone('Asia/Shanghai', now);
  if (!requested || !today) return { ok: false, reason: 'invalid_target_date' };
  if (requested < today) return { ok: false, reason: 'historical_target_unsupported' };
  if (requested > today) return { ok: false, reason: 'future_target_unsupported' };
  return { ok: true, targetDate: requested };
}

async function trackedStocks() {
  const { rows: users } = await stockRefreshRepository.listActiveUsers();
  const map = new Map();
  for (const user of users) {
    const stocks = await listUserStocks(user.username);
    stocks.forEach(row => map.set(row.ts_code, row));
  }
  return [...map.values()];
}

async function verifiedStockDataDate(tsCode, tradeDate, expectedDate, query = pool.query.bind(pool)) {
  if (!tradeDate || !expectedDate || tradeDate >= expectedDate) return { dataAsOf: tradeDate, lastTradeDate: tradeDate };
  const { rows } = await layerSql.verifiedStockDataDateQuery1(query, [tsCode, tradeDate, expectedDate]);
  const coverage = rows[0] || {};
  const verified = Number(coverage.calendar_count) === Number(coverage.calendar_days)
    && Number(coverage.expected_count) > 0 && Number(coverage.expected_count) === Number(coverage.suspended_count);
  return { dataAsOf: verified ? expectedDate : tradeDate, lastTradeDate: tradeDate,
    suspensionVerified: verified, checkedThrough: verified ? expectedDate : null };
}

async function activeStockScope(stocks, targetDate, query = pool.query.bind(pool)) {
  const { rows } = await layerSql.activeStockScopeQuery1(query, [stocks.map(stock => stock.ts_code), targetDate]);
  const excluded = rows.map(row => ({ code: row.canonical_code, reason: 'confirmed_delisted', delistDate: row.delist_date }));
  const delistedCodes = new Set(excluded.map(row => row.code));
  return { activeStocks: stocks.filter(stock => !delistedCodes.has(stock.ts_code)), excluded };
}

/**
 * 该季度是否已有"可核验的完成终态"（R4-05）。
 * 自动排队只做去重，不判断要不要重算：已正式发布、或执行成功且业务结论是
 * 正常市场关闭 / 明确零合格（旧数据可能没写 published_at）都算完成，
 * 不能让同一季度每轮自动检查都新建一个槽。数据不足与失败仍继续补算。
 */
function quarterRunCompleted(row) {
  if (!row) return false;
  if (row.published_at) return true;
  if (String(row.execution_status || '') !== 'succeeded') return false;
  return ['market_closed', 'no_eligible_member', 'insufficient_candidates'].includes(String(row.business_status || ''));
}

/**
 * 季度自动排队（方案 9.2）：由现有调度入口在交易日检查尚未生成的季度并入队。
 * 同一季度已存在任何正式批次就不再重复排队；两市场各自独立，不互相等待。
 */
async function enqueueDueSelectionQuarters(now = new Date()) {
  const service = require('../services/stockSelectionService');
  const { enqueueManualJob } = require('../services/jobScheduleSlots');
  const today = CoreDate.todayInZone('Asia/Shanghai', now);
  const queued = [];
  for (const market of ['CN', 'HK']) {
    // pendingQuarter 是异步函数：漏掉 await 会让 quarter 变成 undefined（SSV-06），
    // 结果就是"查不到、也排不出"，季度任务永远不生成。
    const pending = await service.pendingQuarter({ market, now: today });
    if (!pending || !pending.quarter) continue;
    // R5-03：去重必须走**仓储层存在性查询**，不能用列表分页当"完整终态集合"——
    // 完成批次被更新的部分批次挤到第 21 条之后时，分页会误判"没完成"并重复排队。
    if (await service.hasCompletedQuarter({ market, quarter: pending.quarter })) continue;
    const slot = await enqueueManualJob('stock_analysis_refresh', {
      mode: 'selection_quarterly', market, quarter: pending.quarter, freshnessGate: false,
    });
    if (slot) queued.push({ market, quarter: pending.quarter, slotId: slot.slot_id });
  }
  return queued;
}

/**
 * 下一次就绪检查时刻：工程默认 30 分钟，可用 STOCK_SELECTION_RECHECK_MINUTES 覆盖。
 * 这是等待节奏，不是上游供应承诺，也不改目标 T（方案 27.6）。
 */
function nextSelectionRecheckAt() {
  const minutes = Number(process.env.STOCK_SELECTION_RECHECK_MINUTES || 30);
  const safe = Number.isFinite(minutes) && minutes > 0 ? minutes : 30;
  return new Date(Date.now() + safe * 60000).toISOString();
}

/**
 * 每日/每周自动排队（方案 27.8）：复用同一个 stock_analysis_refresh Runner 与槽位，
 * 只有目标周期尚无正式批次时才入队；影子批次必须由 STOCK_SELECTION_SHADOW=1 显式开启，
 * 槽位按 selectionBusinessKey 精确去重（影子/普通、同日不同周期互不吃槽）。
 */
async function enqueueDueSelectionPeriods(now = new Date()) {
  const service = require('../services/stockSelectionService');
  // 复用既有的选股周期入队入口（规范化 shadow/策略/周期键 + requestId 幂等），
  // 再由 enqueueManualJob 补 selectionBusinessKey 做精确槽位去重。
  const { enqueueSelectionPeriodJob } = require('../services/jobScheduleSlots');
  const strategyCode = String(process.env.STOCK_SELECTION_STRATEGY || '').trim().toLowerCase() || undefined;
  const shadowEnabled = String(process.env.STOCK_SELECTION_SHADOW || '') === '1';
  const queued = [];
  for (const market of ['CN', 'HK']) {
    let targets = [];
    try {
      targets = await service.duePeriodicTargets({ market, now, strategyCode });
    } catch (error) {
      console.warn(`[选股] ${market} 周期到期待检查失败：`, error.message);
      continue;
    }
    for (const target of targets) {
      // 已有正式批次就不再排队；未就绪的历史槽位由原续跑机制继续，不新建平行槽。
      if (await service.hasPeriodRun({
        market, periodType: target.periodType, periodKey: target.periodKey, strategyCode,
      })) continue;
      const mode = target.periodType === 'day' ? 'selection_daily' : 'selection_weekly';
      const payload = { mode, market, targetDate: target.targetDate, periodKey: target.periodKey, freshnessGate: false };
      if (strategyCode) payload.strategyCode = strategyCode;
      const slot = await enqueueSelectionPeriodJob({ jobCode: 'stock_analysis_refresh', payload });
      if (slot) queued.push({ market, mode, periodKey: target.periodKey, slotId: slot.slot_id });
      if (shadowEnabled) {
        const shadowSlot = await enqueueSelectionPeriodJob({
          jobCode: 'stock_analysis_refresh',
          payload: Object.assign({}, payload, { shadow: true }),
        });
        if (shadowSlot) queued.push({ market, mode, periodKey: target.periodKey, shadow: true, slotId: shadowSlot.slot_id });
      }
    }
  }
  return queued;
}

// HK 定向纯计算模式：复用原 Runner，外采为 0；按港交所日历触发与补偿，
// HK 开市而 A 股休市也能运行，不继承默认 CN 依赖或前一 SSE 交易日。
const HK_ANALYSIS_MODE = 'stock_analysis_hk';

async function runHkAnalysisMode(reason, context) {
  const targetDate = String(context.targetDate || context.businessDate || CoreDate.todayInZone('Asia/Shanghai')).slice(0, 10);
  const { getMarketState } = require('../services/marketState');
  const state = await getMarketState({ market: 'HK', businessDate: targetDate, time: '00:00' });
  // 日历事实缺失或来源冲突时阻塞并说明，不能按周一至五猜开市。
  if (!state || !['open', 'closed'].includes(String(state.status || ''))) {
    return { ok: false, status: 'blocked', mode: HK_ANALYSIS_MODE, market: 'HK', targetDate,
      reason: '港交所交易日历缺失或冲突，无法确认目标交易日', publishDatasets: false, publishDatasetCodes: [],
      stageComplete: false, externalCalls: 0 };
  }
  const repo = require('../repositories/hkSecurityAnalysisRepository');
  const codes = await repo.listTrackedHkCodes();
  const hk = require('../services/hkSecurityAnalysis');
  const results = [], remaining = [];
  for (const code of codes) {
    try {
      const analysis = await hk.refreshHkAnalysis(code, { reason: `${reason}:hk`, isoToday: targetDate });
      results.push({ code, ok: true, analysisVersion: analysis && analysis.display ? analysis.display.analysis_version : null });
    } catch (error) {
      remaining.push({ code, reason: error.message });
    }
  }
  const stageComplete = remaining.length === 0;
  return {
    ok: true,
    status: stageComplete ? 'succeeded' : 'partial',
    mode: HK_ANALYSIS_MODE,
    market: 'HK',
    targetDate,
    marketCalendarStatus: state.status,
    targetSet: codes,
    results,
    remaining,
    stageComplete,
    dataAsOf: targetDate,
    externalCalls: 0,
    publishDatasets: false,
    publishDatasetCodes: [],
    datasetDiagnostics: {
      coverage_status: codes.length ? 'targeted_scoped' : 'verified_no_change',
      query_status: 'success',
      market: 'HK', scope: codes.length ? `security:${codes.join(',')}` : 'market',
    },
    // 无跟踪对象是可留证的正常空跑，不是失败。
    emptyReason: codes.length ? null : '当前没有持仓或显式自选的港股，正常空跑',
  };
}

async function runStockAnalysisRefresh(reason = 'scheduled', context = {}) {
  const mode = String(context.mode || 'core');
  // 选股模式必须在原"目标日只能当天"的限制之前分流：它要支持历史目标日与季度回溯。
  if (SELECTION_MODES.includes(mode)) return runSelectionMode(mode, reason, context);
  if (mode === HK_ANALYSIS_MODE) return runHkAnalysisMode(reason, context);
  const requestedDate = context.targetDate || context.businessDate || process.env.JOB_BUSINESS_DATE
    || CoreDate.todayInZone('Asia/Shanghai');
  const target = targetDateStatus(requestedDate);
  if (!target.ok) return {
    ok: false, status: 'blocked', reason: target.reason, dataAsOf: null,
    publishDatasets: false, failedDatasets: ['stock_analysis_snapshot'],
  };
  if (!(await tryClaimJob(JOB))) return { skipped: true, reason: 'locked' };
  const runId = await startJobRun(JOB);
  let ok = 0, failed = 0;
  const skipped = [];
  const isUnavailableStock = error => String(error && error.code || '').toUpperCase() === 'EMPTY_DATA'
    && /stock_basic\s+返回空数据/i.test(String(error && error.message || ''));
  try {
    const requestedCodes = new Set((context.failedDatasets || []).map(item =>
      typeof item === 'string' ? item : item && (item.code || item.tsCode)).filter(Boolean));
    const stocks = (await trackedStocks()).filter(stock => !requestedCodes.size || requestedCodes.has(stock.ts_code));
    const { activeStocks, excluded } = await activeStockScope(stocks, target.targetDate);
    const failures = [];
    const failureDetails = [];
    const dataDates = new Map();
    const marketEvidence = new Map();
    async function refreshAndMark(tsCode, refreshReason, options) {
      const analysis = await refreshStockAnalysis(tsCode, refreshReason, options);
      const dataAsOf = CoreDate.normalizeBusinessDate(analysis && analysis.latest_market_trade_date);
      if (!dataAsOf) throw new Error('分析快照缺少可核实的最新行情日期');
      const expected = require('../services/jobScheduleSlots').expectedDataDate(JOB, requestedDate);
      const evidence = await verifiedStockDataDate(tsCode, dataAsOf, expected);
      await markDatasetSuccess(datasetScope('stock', tsCode), ANALYSIS_DATASET, { lastSuccessDate: evidence.dataAsOf });
      dataDates.set(tsCode, evidence.dataAsOf);
      marketEvidence.set(tsCode, evidence);
      return evidence.dataAsOf;
    }
    for (const stock of activeStocks) {
      try {
        await refreshAndMark(stock.ts_code, reason, { readOnly: true });
        ok++;
      } catch (error) {
        if (isUnavailableStock(error)) {
          skipped.push({ code: stock.ts_code, reason: 'stock_basic 无基础信息，可能已退市或不再属于可分析普通股' });
          await markDatasetFailure(datasetScope('stock', stock.ts_code), ANALYSIS_DATASET,
            `UNAVAILABLE: ${error.message}`);
          console.warn(`[stock-analysis] ${stock.ts_code} 无基础档案，跳过本次分析：`, error.message);
          continue;
        }
        failed++;
        failures.push(stock.ts_code);
        failureDetails.push({ code: error.code || 'JOB_FAILED', errorType: error.errorType || error.type || 'unknown', source: error.source || null, error: error.message });
        console.warn(`[stock-analysis] ${stock.ts_code} 更新失败:`, error.message);
        await markDatasetFailure(datasetScope('stock', stock.ts_code), ANALYSIS_DATASET, error.message);
      }
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    // 失败的股票定点补跑一次（强制忽略 TTL），仍失败则留在数据库里等次日
    const recovered = [];
    for (const tsCode of failures) {
      try {
        await refreshAndMark(tsCode, `${reason}-retry`, { force: true, readOnly: true });
        ok++; failed--; recovered.push(tsCode);
      } catch (error) {
        failureDetails.push({ code: error.code || 'JOB_FAILED', errorType: error.errorType || error.type || 'unknown', source: error.source || null, error: error.message });
        console.warn(`[stock-analysis] ${tsCode} 补跑仍失败:`, error.message);
        await markDatasetFailure(datasetScope('stock', tsCode), ANALYSIS_DATASET, error.message);
      }
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    const detail = `成功 ${ok}，失败 ${failed}，跳过 ${skipped.length}${recovered.length ? `，补跑救回 ${recovered.length}` : ''}`;
    await finishJobRun(runId, failed === 0, detail);
    try {
      const stats = await dailyConsistencyStats();
      console.log(`[一致性统计] 股票快照 ${stats.stock_snapshots} 份，待补水位 ${stats.stock_legacy_watermark} 份；转债快照 ${stats.bond_snapshots} 份，转股价错配 ${stats.bond_conv_price_mismatch} 份`);
    } catch (e) { console.warn('[一致性统计] 统计失败（不影响任务）:', e.message); }
    // 季度选股排队失败不影响原有个股分析任务结论，差异留在日志与选股批次状态里。
    try {
      const queuedSelection = await enqueueDueSelectionQuarters();
      if (queuedSelection.length) console.log('[选股] 已排队季度任务:', queuedSelection.map(item => `${item.market}${item.quarter}`).join(','));
    } catch (e) { console.warn('[选股] 季度排队失败（不影响个股分析）:', e.message); }
    // 日/周自动排队：与季度同一个 Runner 与槽位，失败同样不拖累个股分析。
    try {
      const queuedPeriodic = await enqueueDueSelectionPeriods();
      if (queuedPeriodic.length) {
        console.log('[选股] 已排队日/周任务:', queuedPeriodic
          .map(item => `${item.market}${item.mode}${item.shadow ? '(shadow)' : ''}${item.periodKey}`).join(','));
      }
    } catch (e) { console.warn('[选股] 日/周排队失败（不影响个股分析）:', e.message); }
    const failedDatasets = failures.filter(code => !recovered.includes(code));
    const skippedCodes = new Set(skipped.map(item => item.code));
    const firstFailure = failureDetails[0] || null;
    const completedDates = activeStocks.map(stock => dataDates.get(stock.ts_code)).filter(Boolean);
    const dataAsOf = activeStocks.length && failed === 0 && skipped.length === 0 && completedDates.length === activeStocks.length
      ? completedDates.sort()[0] : null;
    return {
      ok: failed === 0,
      status: failed === 0 ? 'succeeded' : 'partial',
      dataAsOf,
      watermarkNotRequired: activeStocks.length === 0,
      reason: activeStocks.length === 0 ? 'no-tracked-stocks' : undefined,
      excluded,
      completed: ok,
      failed,
      recovered,
      skipped,
      failedDatasets,
      datasets: activeStocks.map(stock => ({ code: stock.ts_code, status: failedDatasets.includes(stock.ts_code) ? 'failed' : skippedCodes.has(stock.ts_code) ? 'skipped' : 'succeeded', dataAsOf: dataDates.get(stock.ts_code) || null, ...marketEvidence.get(stock.ts_code) })),
      ...(failedDatasets.length && firstFailure ? { error: firstFailure.error, errorCode: firstFailure.code, errorType: firstFailure.errorType, source: firstFailure.source } : {}),
    };
  } catch (error) {
    await finishJobRun(runId, false, error.message);
    throw error;
  } finally {
    await releaseJob(JOB);
  }
}

function scheduleStockAnalysisRefresh() {
  function scheduleNext() {
    const timer = setTimeout(async () => {
      try { await runStockAnalysisRefresh('daily-08:20'); }
      catch (error) { console.error('[stock-analysis] 每日更新失败:', error.message); }
      scheduleNext();
    }, nextShanghaiDelay());
    if (timer.unref) timer.unref();
  }
  scheduleNext();
  console.log('[stock-analysis] 已调度：每日 08:20（上海时间）');
}

module.exports = { nextShanghaiDelay, latestStockAnalysisDate, targetDateStatus, trackedStocks, activeStockScope, verifiedStockDataDate, runStockAnalysisRefresh, scheduleStockAnalysisRefresh, runSelectionMode, enqueueDueSelectionQuarters, enqueueDueSelectionPeriods, quarterRunCompleted, SELECTION_MODES };

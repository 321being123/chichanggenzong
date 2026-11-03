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
const SELECTION_MODES = Object.freeze(['selection_quarterly', 'selection_preview', 'selection_backtest', 'selection_inputs']);

function selectionDatasetCode(market, kind) {
  const suffix = String(market || '').toUpperCase() === 'HK' ? 'hk' : 'cn';
  return `stock_selection_${kind}_${suffix}`;
}

function quarterDateFallback(quarter) {
  return require('../services/stockSelectionService').quarterEndDate(quarter);
}

async function runSelectionMode(mode, reason, context) {
  const service = require('../services/stockSelectionService');
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
  const repo = require('../repositories/stockSelectionRepository');
  const { enqueueManualJob } = require('../services/jobScheduleSlots');
  const today = CoreDate.todayInZone('Asia/Shanghai', now);
  const queued = [];
  for (const market of ['CN', 'HK']) {
    // pendingQuarter 是异步函数：漏掉 await 会让 quarter 变成 undefined（SSV-06），
    // 结果就是"查不到、也排不出"，季度任务永远不生成。
    const pending = await service.pendingQuarter({ market, now: today });
    if (!pending || !pending.quarter) continue;
    const existing = await repo.listRuns({ market, quarter: pending.quarter, kind: 'quarterly', ownerUsername: null, limit: 20, offset: 0 });
    // 只有"已完成终态"的季度才跳过；上一轮只存了预览或部分数据时必须重新排队，
    // 不能因为表里存在过一条该季度记录就永远不再尝试。
    if (existing.rows.some(quarterRunCompleted)) continue;
    const slot = await enqueueManualJob('stock_analysis_refresh', { mode: 'selection_quarterly', market, quarter: pending.quarter });
    if (slot) queued.push({ market, quarter: pending.quarter, slotId: slot.slot_id });
  }
  return queued;
}

async function runStockAnalysisRefresh(reason = 'scheduled', context = {}) {
  const mode = String(context.mode || 'core');
  // 选股模式必须在原"目标日只能当天"的限制之前分流：它要支持历史目标日与季度回溯。
  if (SELECTION_MODES.includes(mode)) return runSelectionMode(mode, reason, context);
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

module.exports = { nextShanghaiDelay, latestStockAnalysisDate, targetDateStatus, trackedStocks, activeStockScope, verifiedStockDataDate, runStockAnalysisRefresh, scheduleStockAnalysisRefresh, runSelectionMode, enqueueDueSelectionQuarters, quarterRunCompleted, SELECTION_MODES };

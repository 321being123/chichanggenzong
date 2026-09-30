const { tryClaimJob, releaseJob, startJobRun, finishJobRun } = require('../db');
const { listUserStocks, refreshStockAnalysis } = require('../services/stockAnalysis');
const { pool } = require('../db/connection');
const { datasetScope, markDatasetFailure, markDatasetSuccess } = require('../services/datasetCursors');
const { dailyConsistencyStats } = require('./consistencyStats');
const CoreDate = require('../../public/shared/core-date.js');

const ANALYSIS_DATASET = 'stock_analysis';

const JOB = 'stock_analysis_refresh';

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
  const { rows } = await pool.query(
    `SELECT max(NULLIF(snapshot.payload->>'latest_market_trade_date','')::date)::text AS data_as_of
       FROM analytics.stock_overview_latest latest
       JOIN LATERAL (
         SELECT payload FROM analytics.analysis_snapshots
          WHERE instrument_id=latest.instrument_id AND as_of_date=latest.as_of_date AND snapshot_type='stock_analysis'
          ORDER BY created_at DESC LIMIT 1
       ) snapshot ON true`
  );
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
  const { rows: users } = await pool.query('SELECT username FROM users WHERE status=$1', ['active']);
  const map = new Map();
  for (const user of users) {
    const stocks = await listUserStocks(user.username);
    stocks.forEach(row => map.set(row.ts_code, row));
  }
  return [...map.values()];
}

async function verifiedStockDataDate(tsCode, tradeDate, expectedDate, query = pool.query.bind(pool)) {
  if (!tradeDate || !expectedDate || tradeDate >= expectedDate) return { dataAsOf: tradeDate, lastTradeDate: tradeDate };
  const { rows } = await query(`SELECT COUNT(*)::int AS expected_count,
      (SELECT COUNT(*) FROM market.trade_calendar WHERE exchange='SSE'
        AND trade_date>$2::date AND trade_date<=$3::date)::int AS calendar_count,
      ($3::date-$2::date)::int AS calendar_days,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM market.stock_suspend_calendar s
        WHERE s.instrument_id=i.instrument_id AND s.trade_date=c.trade_date AND s.suspend_type='S'))::int AS suspended_count
    FROM market.trade_calendar c CROSS JOIN core.instruments i
    WHERE i.canonical_code=$1 AND c.exchange='SSE' AND c.is_open
      AND c.trade_date>$2::date AND c.trade_date<=$3::date`, [tsCode, tradeDate, expectedDate]);
  const coverage = rows[0] || {};
  const verified = Number(coverage.calendar_count) === Number(coverage.calendar_days)
    && Number(coverage.expected_count) > 0 && Number(coverage.expected_count) === Number(coverage.suspended_count);
  return { dataAsOf: verified ? expectedDate : tradeDate, lastTradeDate: tradeDate,
    suspensionVerified: verified, checkedThrough: verified ? expectedDate : null };
}

async function runStockAnalysisRefresh(reason = 'scheduled', context = {}) {
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
    for (const stock of stocks) {
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
    const failedDatasets = failures.filter(code => !recovered.includes(code));
    const skippedCodes = new Set(skipped.map(item => item.code));
    const firstFailure = failureDetails[0] || null;
    const completedDates = stocks.map(stock => dataDates.get(stock.ts_code)).filter(Boolean);
    const dataAsOf = stocks.length && failed === 0 && skipped.length === 0 && completedDates.length === stocks.length
      ? completedDates.sort()[0] : null;
    return {
      ok: failed === 0,
      status: failed === 0 ? 'succeeded' : 'partial',
      dataAsOf,
      watermarkNotRequired: stocks.length === 0,
      reason: stocks.length === 0 ? 'no-tracked-stocks' : undefined,
      completed: ok,
      failed,
      recovered,
      skipped,
      failedDatasets,
      datasets: stocks.map(stock => ({ code: stock.ts_code, status: failedDatasets.includes(stock.ts_code) ? 'failed' : skippedCodes.has(stock.ts_code) ? 'skipped' : 'succeeded', dataAsOf: dataDates.get(stock.ts_code) || null, ...marketEvidence.get(stock.ts_code) })),
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

module.exports = { nextShanghaiDelay, latestStockAnalysisDate, targetDateStatus, trackedStocks, verifiedStockDataDate, runStockAnalysisRefresh, scheduleStockAnalysisRefresh };

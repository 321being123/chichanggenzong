// 日/周选股槽的前置就绪检查（方案 2026-11-27 第 4 节 B1-2）。
//
// 职责只有一件：在调用全市场 computeSelection 之前，按**本市场**目标日 T 的已发布上游证据，
// 判断"现在能不能算"。未就绪时立即返回精确缺失分区/域与下一次复查时刻，
// 不执行任何计算、不写入 analytics.stock_selection_runs / candidates 的 partial 试算批次。
//
// 边界：
// - selection_periodic 仍只做到期目标发现与入队，不在这里承担等待；
// - A 股只认 stock_daily / stock_valuation / stock_suspend_calendar 在 CN、T 的分区证据；
// - 港股独立开市日不借用 A 股分区，只核验港股 T 的行情/估值覆盖与 HKD→CNY 汇率水位；
// - 港股半日市的收盘截止时刻来自官方日历（marketState），不硬套 16:00；
// - 整周休市 no_session 由 resolvePeriodTarget 处理，本模块只处理"开市但数据未齐"。
'use strict';

const repo = require('../repositories/stockSelectionRepository');
const registry = require('./datasetPartitionRegistry');
const { readinessMoment, shanghaiDateText } = require('./jobReadiness');

// CN 目标日必须已发布的三个上游分区（方案 B1-2 第 2 条）。
const CN_READINESS_DATASETS = Object.freeze(['stock_daily', 'stock_valuation', 'stock_suspend_calendar']);
// 港股汇率证据不能太旧：超过 10 个自然日没有任何 HKD→CNY 汇率即视为未就绪（不是"可以用旧值"）。
const HK_FX_MAX_AGE_DAYS = 10;
// 交易时段内被唤醒时的复查节奏（不把"到点"当"数据就绪"）。
const INTRADAY_RECHECK_MINUTES = 30;
// 次日默认复查点（上海时间）：位于 CN 08:00 / HK 08:45 采集窗口之后。
const DEFAULT_RECHECK_CLOCK = '09:05';
// 交易日历向前查多少天：覆盖春节/国庆等连续休市（近年最长约 10 天），留足余量。
const RECHECK_LOOKAHEAD_DAYS = 21;

function shiftDateText(dateText, days) {
  const [year, month, day] = String(dateText).split('-').map(Number);
  const at = new Date(Date.UTC(year, month - 1, day));
  at.setUTCDate(at.getUTCDate() + Number(days || 0));
  return at.toISOString().slice(0, 10);
}

function shanghaiClock(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(item => [item.type, item.value]));
  return `${values.hour}:${values.minute}`;
}

/**
 * 严格晚于 now 的下一个**交易日**上海 09:05。
 *
 * 休市日（周末/长假）不产生无效复查：直接跳到本市场交易日历的下一个开市日；
 * 当天开市且尚未到 09:05 时仍用当天，否则从次日起找。A 股与港股各自查自己的日历
 * （CN 用 SSE、HK 用 HKEX），不互相借用。日历缺档或查询失败时回退原有行为——次日 09:05，
 * 宁可多醒一次，也不能把"未知"当休市一直跳过。
 */
async function nextDailyRecheckAt({ market, now = new Date(), deps = {} } = {}) {
  const current = new Date(now);
  const today = shanghaiDateText(current);
  const fallbackDay = shiftDateText(today, 1);
  const fallback = readinessMoment(fallbackDay, DEFAULT_RECHECK_CLOCK);
  const normalized = String(market || '').toUpperCase();
  const loadCalendar = deps.loadCalendarEvidence
    || (['CN', 'HK'].includes(normalized) ? repo.loadCalendarEvidence : null);
  if (!loadCalendar) return fallback;
  let rows;
  try {
    rows = await loadCalendar({
      market: normalized, fromDate: today, toDate: shiftDateText(today, RECHECK_LOOKAHEAD_DAYS),
    });
  } catch (_) {
    return fallback;
  }
  const openByDate = new Map((rows || []).map(row => [
    String(row.trade_date || '').slice(0, 10),
    row.is_open !== false,
  ]));
  const todayAt = readinessMoment(today, DEFAULT_RECHECK_CLOCK);
  const todayUsable = Boolean(todayAt) && todayAt.getTime() > current.getTime()
    && openByDate.get(today) === true;
  for (let offset = todayUsable ? 0 : 1; offset <= RECHECK_LOOKAHEAD_DAYS; offset += 1) {
    const day = shiftDateText(today, offset);
    const open = openByDate.get(day);
    // 日历未覆盖这一天：保持原"次日 09:05"回退，不把未知日期直接当休市跳过。
    if (open === undefined) return fallback;
    if (open) return readinessMoment(day, DEFAULT_RECHECK_CLOCK) || fallback;
  }
  return fallback;
}

function daysBetween(fromDate, toDate) {
  const from = Date.parse(`${fromDate}T00:00:00Z`);
  const to = Date.parse(`${toDate}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.round((to - from) / 86400000);
}

/**
 * A 股就绪：只认注册表统一判据（isPublishedDatasetEvidence），
 * 分区已发布但明确 row_count=0 时仍视为没有基础覆盖证据（空分区不能顶替行情）。
 */
async function assessCnReadiness({ asOfDate, deps = {} }) {
  const readPartitions = deps.readDatasetPartitions || registry.readDatasetPartitions;
  const result = await readPartitions(CN_READINESS_DATASETS, asOfDate, { market: 'CN' });
  const missingDatasets = [...(result.missingCodes || [])];
  const emptyDatasets = [];
  for (const item of result.evidence || []) {
    if (!item.published) continue;
    // 只对"必须有行"的行情/估值检查基础覆盖；停牌日历允许当天 0 条（无停牌）。
    if (!['stock_daily', 'stock_valuation'].includes(item.datasetCode)) continue;
    const diagnostics = (item.row && item.row.diagnostics) || {};
    const rowCount = Number(diagnostics.partition_row_count);
    if (Number.isFinite(rowCount) && rowCount <= 0) emptyDatasets.push(item.datasetCode);
  }
  const missingDomains = [];
  if (missingDatasets.length || emptyDatasets.length) missingDomains.push('cn_required_datasets');
  return {
    ready: missingDatasets.length === 0 && emptyDatasets.length === 0,
    missingDatasets,
    emptyDatasets,
    missingDomains,
    evidence: {
      required: [...CN_READINESS_DATASETS],
      partitionKey: result.partitionKey || asOfDate,
      datasets: (result.evidence || []).map(item => ({
        datasetCode: item.datasetCode,
        scopeKey: item.scopeKey,
        published: item.published,
        status: item.row ? item.row.status : 'missing',
        isStale: Boolean(item.row && item.row.is_stale),
        rowCount: item.row && item.row.diagnostics
          ? Number(item.row.diagnostics.partition_row_count) : null,
      })),
    },
  };
}

/**
 * 港股就绪：目标日行情/估值覆盖 + 汇率水位 + 官方日历的收盘时刻。
 * 不读 A 股分区：港股独立开市日（A 股休市）必须同样可判定。
 *
 * F-07：覆盖按**同一证券**双齐核对，不做"行情有 1 条、估值有 1 条"就放行。
 * 目标池 = 在册且近 60 日活跃的港股可评估池，排除目标日停牌（suspend_type='S'）证券；
 * 只有 targetCount > 0 且 missingCoverageCount === 0 才具备覆盖证据。
 */
async function assessHkReadiness({ asOfDate, now = new Date(), deps = {} }) {
  const loadHk = deps.loadHkPeriodReadiness || repo.loadHkPeriodReadiness;
  const getMarketState = deps.getMarketState || require('./marketState').getMarketState;
  const coverage = await loadHk({ asOfDate });
  const targetCount = Number((coverage && coverage.targetCount) || 0);
  const bothReadyCount = Number((coverage && coverage.bothReadyCount) || 0);
  const missingBarCount = Number((coverage && coverage.missingBarCount) || 0);
  const missingValuationCount = Number((coverage && coverage.missingValuationCount) || 0);
  const missingCoverageCount = coverage && coverage.missingCoverageCount !== undefined
    ? Number(coverage.missingCoverageCount)
    : Math.max(targetCount - bothReadyCount, 0);
  const missingDomains = [];
  if (targetCount <= 0) missingDomains.push('hk_target_pool_empty');
  if (missingCoverageCount > 0) {
    if (missingBarCount > 0) missingDomains.push('hk_daily_bars');
    if (missingValuationCount > 0) missingDomains.push('hk_valuation');
    // 覆盖缺口无法归因到任一侧时也必须显式留证，不能静默返回 not_ready 却不给原因。
    if (missingBarCount <= 0 && missingValuationCount <= 0) missingDomains.push('hk_target_coverage');
  }
  const fxAgeDays = coverage && coverage.fxDate ? daysBetween(coverage.fxDate, asOfDate) : null;
  if (fxAgeDays === null || fxAgeDays > HK_FX_MAX_AGE_DAYS) missingDomains.push('hk_fx_rate');

  // 官方日历的收盘时刻（半日市 12:10，全日市 16:10）：只作会话证据，不猜。
  let session = null;
  try {
    const state = await getMarketState({ market: 'HK', businessDate: asOfDate, time: '23:59' });
    session = {
      status: state ? state.status : null,
      sessionType: state ? state.sessionType : null,
      closeTime: state ? state.closeTime : null,
    };
  } catch (error) {
    session = { status: null, sessionType: null, closeTime: null, error: String(error.message || error).slice(0, 200) };
  }
  if (!session || session.status !== 'open') missingDomains.push('hk_market_session');
  const sessionCloseAt = session && session.closeTime ? readinessMoment(asOfDate, session.closeTime) : null;
  const sessionInProgress = Boolean(sessionCloseAt && new Date(now).getTime() < sessionCloseAt.getTime());
  if (sessionInProgress) missingDomains.push('hk_session_in_progress');

  return {
    ready: missingDomains.length === 0,
    missingDatasets: [],
    emptyDatasets: [],
    missingDomains,
    session,
    sessionCloseAt,
    sessionInProgress,
    evidence: {
      asOfDate,
      targetCount,
      bothReadyCount,
      missingBarCount,
      missingValuationCount,
      missingCoverageCount,
      fxDate: coverage ? coverage.fxDate : null,
      fxAgeDays,
      fxMaxAgeDays: HK_FX_MAX_AGE_DAYS,
      session,
      sessionCloseAt: sessionCloseAt ? sessionCloseAt.toISOString() : null,
    },
  };
}

/**
 * 前置就绪判定（供 selection_daily / selection_weekly 在 computeSelection 之前调用）。
 *
 * @param {object} input
 * @param {'CN'|'HK'} input.market
 * @param {'day'|'week'} input.periodType
 * @param {string} input.asOfDate 已由 resolvePeriodTarget 解析出的目标日 T
 * @param {string} [input.periodKey]
 * @param {Date} [input.now]
 * @param {object} [input.deps] 仅回归测试注入替身；生产不传
 */
async function assessPeriodReadiness({ market, periodType, asOfDate, periodKey = null, now = new Date(), deps = {} } = {}) {
  const normalized = String(market || '').toUpperCase();
  const checkedAt = new Date(now).toISOString();
  if (!['CN', 'HK'].includes(normalized)) {
    return {
      ready: false,
      readinessStatus: 'not_ready',
      waitReason: 'selection_not_ready',
      market: normalized || null,
      periodType: String(periodType || '') || null,
      periodKey,
      asOfDate: asOfDate || null,
      checkedAt,
      nextCheckAt: (await nextDailyRecheckAt({ market: normalized, now, deps })).toISOString(),
      missingDatasets: [],
      missingDomains: ['market_unsupported'],
      evidence: {},
    };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(asOfDate || ''))) {
    return {
      ready: false,
      readinessStatus: 'not_ready',
      waitReason: 'selection_not_ready',
      market: normalized,
      periodType: String(periodType || '') || null,
      periodKey,
      asOfDate: asOfDate || null,
      checkedAt,
      nextCheckAt: (await nextDailyRecheckAt({ market: normalized, now, deps })).toISOString(),
      missingDatasets: [],
      missingDomains: ['target_date_unresolved'],
      evidence: {},
    };
  }
  let detail;
  try {
    detail = normalized === 'HK'
      ? await assessHkReadiness({ asOfDate, now, deps })
      : await assessCnReadiness({ asOfDate, deps });
  } catch (error) {
    // 检查自身失败不能当成"就绪"：宁可按未就绪等待，也不在未知状态下跑全市场计算。
    return {
      ready: false,
      readinessStatus: 'not_ready',
      waitReason: 'selection_not_ready',
      market: normalized,
      periodType: String(periodType || '') || null,
      periodKey,
      asOfDate,
      checkedAt,
      nextCheckAt: new Date(new Date(now).getTime() + INTRADAY_RECHECK_MINUTES * 60000).toISOString(),
      missingDatasets: [],
      missingDomains: ['readiness_check_error'],
      readinessError: String(error.message || error).slice(0, 300),
      evidence: {},
    };
  }
  // 盘中唤醒：行情尚未收定，等到收盘后的下一个节奏；其余未就绪跳到本市场下一个交易日的 09:05。
  const nextCheckAt = detail.sessionInProgress
    ? new Date(new Date(now).getTime() + INTRADAY_RECHECK_MINUTES * 60000)
    : await nextDailyRecheckAt({ market: normalized, now, deps });
  return {
    ready: detail.ready === true,
    readinessStatus: detail.ready === true ? 'ready' : 'not_ready',
    waitReason: detail.ready === true ? null : 'selection_not_ready',
    market: normalized,
    periodType: String(periodType || '') || null,
    periodKey,
    asOfDate,
    checkedAt,
    nextCheckAt: nextCheckAt.toISOString(),
    // 未就绪时给出精确缺失清单；就绪时为空数组，便于任务摘要统一消费。
    missingDatasets: detail.missingDatasets || [],
    missingDomains: detail.missingDomains || [],
    emptyDatasets: detail.emptyDatasets || [],
    session: detail.session || null,
    sessionCloseAt: detail.sessionCloseAt ? detail.sessionCloseAt.toISOString() : null,
    evidence: detail.evidence || {},
  };
}

module.exports = {
  CN_READINESS_DATASETS,
  HK_FX_MAX_AGE_DAYS,
  DEFAULT_RECHECK_CLOCK,
  nextDailyRecheckAt,
  assessPeriodReadiness,
};

// 股票筛选优化第一批 B1-2 回归：日/周选股槽前置就绪检查与复查节奏。
//
// 锁定：
// 1. 未就绪时 selection_daily/weekly 返回 not_ready + selection_not_ready，给出精确缺失清单与 09:05 复查点，
//    执行 0 次全市场 computeSelection、写入 0 条 partial 试算批次；
// 2. 覆盖 A/H 各自开市日、港股独立开市、港股半日市、整周 no_session 与跨日续跑保留原目标 T；
// 3. 港股就绪只核验港股行情/估值/汇率，不借用 A 股分区。
'use strict';
const assert = require('assert');
const path = require('path');
const fs = require('fs');

let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks += 1; };
const eq = (actual, expected, message) => { assert.strictEqual(actual, expected, message); checks += 1; };

const registry = require('../services/datasetPartitionRegistry');
const repo = require('../repositories/stockSelectionRepository');
const service = require('../services/stockSelectionService');
const readiness = require('../services/stockSelectionReadiness');

function restore(object, backup) {
  Object.entries(backup).forEach(([key, value]) => { object[key] = value; });
}
function patch(object, overrides) {
  const backup = {};
  Object.keys(overrides).forEach(key => { backup[key] = object[key]; object[key] = overrides[key]; });
  return () => restore(object, backup);
}

function partitionEvidence(codes, missing, rowCount = 1000) {
  return {
    partitionKey: '2026-11-26',
    missingCodes: missing.slice(),
    unregisteredCodes: [],
    evidence: codes.map(datasetCode => ({
      datasetCode,
      scopeKey: 'CN',
      published: !missing.includes(datasetCode),
      row: missing.includes(datasetCode)
        ? null
        : { status: 'published', is_stale: false, diagnostics: { quality_status: 'passed', query_status: 'success', partition_row_count: rowCount } },
    })),
  };
}

async function run() {
  const CN_DATASETS = ['stock_daily', 'stock_valuation', 'stock_suspend_calendar'];

  // 交易日历替身：onlyOpen 之外的日期全部休市（周末/长假），缺档另用返回值模拟。
  const calendarOf = (market, openDates) => async ({ fromDate, toDate }) => {
    const rows = [];
    const start = new Date(`${fromDate}T00:00:00Z`);
    const end = new Date(`${toDate}T00:00:00Z`);
    for (let cursor = start; cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
      const date = cursor.toISOString().slice(0, 10);
      rows.push({ trade_date: date, is_open: openDates.includes(date) });
    }
    return rows;
  };

  // ---------- 1. 复查点按本市场交易日历：休市日不唤醒 ----------
  {
    // 2026-11-27 周五 18:30（上海）：周末休市，必须跳到下周一 09:05。
    const fridayEvening = new Date('2026-11-27T10:30:00.000Z');
    const weekdays = ['2026-11-27', '2026-11-30', '2026-12-01'];
    const cnCalendar = calendarOf('CN', weekdays);
    eq((await readiness.nextDailyRecheckAt({
      market: 'CN', now: fridayEvening, deps: { loadCalendarEvidence: cnCalendar },
    })).toISOString(), '2026-11-30T01:05:00.000Z',
    '周五 18:30 未就绪必须跳到下周一 09:05，周末不得无效唤醒');
    const fridayMorning = new Date('2026-11-27T00:00:00.000Z'); // 上海 08:00
    eq((await readiness.nextDailyRecheckAt({
      market: 'CN', now: fridayMorning, deps: { loadCalendarEvidence: cnCalendar },
    })).toISOString(), '2026-11-27T01:05:00.000Z',
    '开市日 08:00 未就绪应等当天 09:05');
    const afterCheck = new Date('2026-11-27T01:10:00.000Z'); // 上海 09:10
    eq((await readiness.nextDailyRecheckAt({
      market: 'CN', now: afterCheck, deps: { loadCalendarEvidence: cnCalendar },
    })).toISOString(), '2026-11-30T01:05:00.000Z',
    '周五已过 09:05 必须顺延到下周一，不把到点当成数据就绪');

    // 长假：2026-02-13（周五）后持续休市，2026-02-23（周一）复市。
    const holidayCalendar = calendarOf('CN', ['2026-02-13', '2026-02-23', '2026-02-24']);
    eq((await readiness.nextDailyRecheckAt({
      market: 'CN', now: new Date('2026-02-13T10:30:00.000Z'), deps: { loadCalendarEvidence: holidayCalendar },
    })).toISOString(), '2026-02-23T01:05:00.000Z',
    '春节/国庆等长假必须跳到复市日 09:05，不在休市日空跑');

    // 港股用港交所日历，不与 A 股共用：A 股 11-27 开市、港股休市时，港股应跳到 11-30。
    const hkCalendar = calendarOf('HK', ['2026-11-26', '2026-11-30']);
    eq((await readiness.nextDailyRecheckAt({
      market: 'HK', now: fridayEvening, deps: { loadCalendarEvidence: hkCalendar },
    })).toISOString(), '2026-11-30T01:05:00.000Z',
    '港股必须按自身交易日历跳过休市日，不借用 A 股开市结论');

    // 日历缺档：保持原回退——次日 09:05，不把未知日期当休市一直跳过。
    const missingCalendar = async () => [];
    eq((await readiness.nextDailyRecheckAt({
      market: 'CN', now: fridayEvening, deps: { loadCalendarEvidence: missingCalendar },
    })).toISOString(), '2026-11-28T01:05:00.000Z',
    '日历缺档时必须回退次日 09:05');
  }

  // ---------- 2. A 股：三份上游分区全部已发布才 ready ----------
  {
    const ready = await readiness.assessPeriodReadiness({
      market: 'CN', periodType: 'day', asOfDate: '2026-11-26', periodKey: 'D:2026-11-26',
      now: new Date('2026-11-27T10:30:00.000Z'),
      deps: {
        readDatasetPartitions: async () => partitionEvidence(CN_DATASETS, []),
        loadCalendarEvidence: calendarOf('CN', ['2026-11-27', '2026-11-30', '2026-12-01']),
      },
    });
    eq(ready.ready, true, '三份上游分区已发布且无陈旧时 A 股必须就绪');
    eq(ready.readinessStatus, 'ready', '就绪状态必须是 ready');
    eq(ready.missingDatasets.length, 0, '就绪时缺失清单必须为空');

    const missing = await readiness.assessPeriodReadiness({
      market: 'CN', periodType: 'week', asOfDate: '2026-11-26', periodKey: 'W:2026-11-23',
      now: new Date('2026-11-27T10:30:00.000Z'),
      deps: {
        readDatasetPartitions: async () => partitionEvidence(CN_DATASETS, ['stock_valuation']),
        loadCalendarEvidence: calendarOf('CN', ['2026-11-27', '2026-11-30', '2026-12-01']),
      },
    });
    eq(missing.ready, false, '缺 stock_valuation 分区必须 not_ready');
    eq(missing.readinessStatus, 'not_ready', '就绪状态必须是 not_ready');
    eq(missing.waitReason, 'selection_not_ready', '等待原因必须是 selection_not_ready');
    eq(missing.missingDatasets.join(','), 'stock_valuation', '必须给出精确缺失分区');
    eq(missing.missingDomains.join(','), 'cn_required_datasets', '必须给出缺失域');
    eq(missing.nextCheckAt, '2026-11-30T01:05:00.000Z', '未就绪必须给出下一个交易日 09:05 复查时刻');

    const empty = await readiness.assessPeriodReadiness({
      market: 'CN', periodType: 'day', asOfDate: '2026-11-26',
      now: new Date('2026-11-27T10:30:00.000Z'),
      deps: {
        readDatasetPartitions: async () => partitionEvidence(CN_DATASETS, [], 0),
        loadCalendarEvidence: calendarOf('CN', ['2026-11-27', '2026-11-30', '2026-12-01']),
      },
    });
    eq(empty.ready, false, '分区已发布但行数为 0 仍不得当成有基础覆盖');
    eq(empty.emptyDatasets.join(','), 'stock_daily,stock_valuation', '零行分区必须单独留证');
  }

  // ---------- 3. 港股：独立核验同一证券行情/估值双齐、汇率与官方日历 ----------
  {
    const marketStateOpen = { status: 'open', sessionType: 'full_day', closeTime: '16:10' };
    let cnPartitionReads = 0;
    const hkCoverage = ({ targetCount, bothReadyCount, missingBarCount = 0, missingValuationCount = 0, fxDate = '2026-11-26' }) => ({
      targetCount,
      bothReadyCount,
      missingBarCount,
      missingValuationCount,
      missingCoverageCount: Math.max(targetCount - bothReadyCount, 0),
      fxDate,
    });
    const baseDeps = (coverage, state = marketStateOpen) => ({
      readDatasetPartitions: async (...args) => { cnPartitionReads += 1; return partitionEvidence(CN_DATASETS, []); },
      loadCalendarEvidence: calendarOf('HK', ['2026-11-26', '2026-11-30']),
      loadHkPeriodReadiness: async () => coverage,
      getMarketState: async () => state,
    });
    const ready = await readiness.assessPeriodReadiness({
      market: 'HK', periodType: 'day', asOfDate: '2026-11-26',
      now: new Date('2026-11-27T10:30:00.000Z'),
      deps: baseDeps(hkCoverage({ targetCount: 600, bothReadyCount: 600 })),
    });
    eq(ready.ready, true, '港股目标池全部同证券双齐且汇率有效必须就绪');
    eq(cnPartitionReads, 0, '港股就绪不得读取 A 股分区');

    // 反例①：证券 A 仅有行情、证券 B 仅有估值。B 不在目标池（无近 60 日行情），
    // A 缺估值 → 覆盖缺口必须落在 hk_valuation，不能因为两条记录各有 1 条就放行。
    const splitCoverage = await readiness.assessPeriodReadiness({
      market: 'HK', periodType: 'day', asOfDate: '2026-11-26',
      now: new Date('2026-11-27T10:30:00.000Z'),
      deps: baseDeps(hkCoverage({
        targetCount: 1, bothReadyCount: 0, missingBarCount: 0, missingValuationCount: 1,
      })),
    });
    eq(splitCoverage.ready, false, '行情与估值分属不同证券时不得就绪');
    ok(splitCoverage.missingDomains.includes('hk_valuation'), '同证券缺估值必须记 hk_valuation');
    eq(splitCoverage.evidence.missingCoverageCount, 1, '必须回传同证券双齐缺口');

    // 反例②：目标池 2 只，仅 1 只同证券双齐。
    const partialCoverage = await readiness.assessPeriodReadiness({
      market: 'HK', periodType: 'day', asOfDate: '2026-11-26',
      now: new Date('2026-11-27T10:30:00.000Z'),
      deps: baseDeps(hkCoverage({ targetCount: 2, bothReadyCount: 1, missingValuationCount: 1 })),
    });
    eq(partialCoverage.ready, false, '目标池仍有 1 只未双齐时必须 not_ready');
    eq(partialCoverage.evidence.targetCount, 2, '必须回传目标池证券数');
    eq(partialCoverage.evidence.bothReadyCount, 1, '必须回传同证券双齐数');

    // 目标池为空（没有任何可评估港股）同样不得就绪。
    const emptyPool = await readiness.assessPeriodReadiness({
      market: 'HK', periodType: 'day', asOfDate: '2026-11-26',
      now: new Date('2026-11-27T10:30:00.000Z'),
      deps: baseDeps(hkCoverage({ targetCount: 0, bothReadyCount: 0 })),
    });
    eq(emptyPool.ready, false, '空目标池不得判定就绪');
    ok(emptyPool.missingDomains.includes('hk_target_pool_empty'), '空目标池必须显式留证');

    const noValuation = await readiness.assessPeriodReadiness({
      market: 'HK', periodType: 'week', asOfDate: '2026-11-26',
      now: new Date('2026-11-27T10:30:00.000Z'),
      deps: baseDeps(hkCoverage({ targetCount: 600, bothReadyCount: 590, missingValuationCount: 10 })),
    });
    ok(noValuation.missingDomains.includes('hk_valuation'), '缺港股估值覆盖必须记 hk_valuation');
    eq(noValuation.missingDatasets.length, 0, '港股缺失应落在域清单，不伪造分区名');

    const noBars = await readiness.assessPeriodReadiness({
      market: 'HK', periodType: 'day', asOfDate: '2026-11-26',
      now: new Date('2026-11-27T10:30:00.000Z'),
      deps: baseDeps(hkCoverage({ targetCount: 600, bothReadyCount: 590, missingBarCount: 10 })),
    });
    ok(noBars.missingDomains.includes('hk_daily_bars'), '缺港股行情覆盖必须记 hk_daily_bars');

    const staleFx = await readiness.assessPeriodReadiness({
      market: 'HK', periodType: 'day', asOfDate: '2026-11-26',
      now: new Date('2026-11-27T10:30:00.000Z'),
      deps: baseDeps(hkCoverage({ targetCount: 600, bothReadyCount: 600, fxDate: '2026-11-10' })),
    });
    ok(staleFx.missingDomains.includes('hk_fx_rate'), '汇率超过 10 天未更新必须记 hk_fx_rate');

    // 港股半日市：收盘截止时刻必须来自官方日历（12:10），盘中唤醒不得当成就绪。
    const halfDayMorning = await readiness.assessPeriodReadiness({
      market: 'HK', periodType: 'day', asOfDate: '2026-11-26',
      now: new Date('2026-11-26T03:00:00.000Z'), // 上海 11:00
      deps: baseDeps(hkCoverage({ targetCount: 600, bothReadyCount: 600 }),
        { status: 'open', sessionType: 'half_day', closeTime: '12:10' }),
    });
    ok(halfDayMorning.missingDomains.includes('hk_session_in_progress'), '半日市 12:10 前不得判定就绪');
    eq(halfDayMorning.session.sessionType, 'half_day', '必须保留半日市证据');
    eq(halfDayMorning.sessionCloseAt, '2026-11-26T04:10:00.000Z', '半日市收盘截止必须取 12:10（上海）');

    const halfDayAfter = await readiness.assessPeriodReadiness({
      market: 'HK', periodType: 'day', asOfDate: '2026-11-26',
      now: new Date('2026-11-26T05:00:00.000Z'), // 上海 13:00
      deps: baseDeps(hkCoverage({ targetCount: 600, bothReadyCount: 600 }),
        { status: 'open', sessionType: 'half_day', closeTime: '12:10' }),
    });
    eq(halfDayAfter.ready, true, '半日市收盘且数据齐备后必须就绪');
    eq(halfDayAfter.session.sessionType, 'half_day', '就绪结果仍须保留半日市证据');
  }

  // ---------- 4. A/H 各自开市日 + 整周休市 no_session ----------
  {
    const calendars = {
      CN: { '2026-11-26': false, '2026-11-27': true, '2026-11-30': true },
      HK: { '2026-11-26': true, '2026-11-27': false, '2026-11-30': false },
    };
    // 2026-12-07（周一）整周休市：用于验证 no_session 运营证据。
    const closedWeekStart = '2026-12-07';
    const closedWeekEnd = '2026-12-13';
    const restoreRepo = patch(repo, {
      async loadCalendarEvidence({ market, fromDate, toDate }) {
        const rows = [];
        const start = new Date(`${fromDate}T00:00:00Z`);
        const end = new Date(`${toDate}T00:00:00Z`);
        for (let cursor = start; cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
          const date = cursor.toISOString().slice(0, 10);
          const inClosedWeek = date >= closedWeekStart && date <= closedWeekEnd;
          rows.push({ trade_date: date, is_open: !inClosedWeek && calendars[market][date] !== false });
        }
        return rows;
      },
    });
    try {
      const hkIndependent = await service.resolvePeriodTarget({ market: 'HK', periodType: 'day', date: '2026-11-26' });
      eq(hkIndependent.asOfDate, '2026-11-26', '港股独立开市日必须能确定目标 T（A 股同日休市不影响）');
      const cnSameDay = await service.resolvePeriodTarget({ market: 'CN', periodType: 'day', date: '2026-11-26' });
      eq(cnSameDay.reason, 'no_session', 'A 股同日休市必须记 no_session');
      const cnOpen = await service.resolvePeriodTarget({ market: 'CN', periodType: 'day', date: '2026-11-27' });
      eq(cnOpen.asOfDate, '2026-11-27', 'A 股开市日必须能确定目标 T');
      const hkClosed = await service.resolvePeriodTarget({ market: 'HK', periodType: 'day', date: '2026-11-27' });
      eq(hkClosed.reason, 'no_session', '港股休市时 A 股开市不得被当成港股目标 T');

      const weekNoSession = await service.resolvePeriodTarget({
        market: 'HK', periodType: 'week', periodKey: 'W:2026-12-07',
      });
      eq(weekNoSession.reason, 'no_session', '整周休市必须记 no_session，不造一次证券计算');
    } finally { restoreRepo(); }
  }

  // ---------- 5. runPeriodic：未就绪 0 次 computeSelection、0 条 partial 运行 ----------
  {
    const calls = { compute: 0, insertRun: 0 };
    const restoreRepo = patch(repo, {
      async loadCalendarEvidence({ fromDate, toDate }) {
        const rows = [];
        const start = new Date(`${fromDate}T00:00:00Z`);
        const end = new Date(`${toDate}T00:00:00Z`);
        for (let cursor = start; cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
          rows.push({ trade_date: cursor.toISOString().slice(0, 10), is_open: true });
        }
        return rows;
      },
      // computeSelection 的第一条仓储读取：未就绪时绝不能被调用。
      async loadMarketValuation() { calls.compute += 1; throw new Error('computeSelection 不应执行'); },
      async insertRun() { calls.insertRun += 1; throw new Error('不得写 partial 批次'); },
    });
    const restoreRegistry = patch(registry, {
      async readDatasetPartitions(codes) { return partitionEvidence(codes, ['stock_valuation']); },
    });
    try {
      const result = await service.runPeriodic({
        market: 'CN', periodType: 'day', targetDate: '2026-11-25', periodKey: 'D:2026-11-25',
      });
      eq(calls.compute, 0, '未就绪时不得执行全市场 computeSelection');
      eq(calls.insertRun, 0, '未就绪时不得写入 partial 试算批次');
      eq(result.readinessStatus, 'not_ready', '服务层必须返回 readinessStatus=not_ready');
      eq(result.reason, 'selection_not_ready', '服务层原因必须是 selection_not_ready');
      eq(result.waitReason, 'selection_not_ready', '服务层必须登记等待原因');
      eq(result.missingDatasets.join(','), 'stock_valuation', '必须回传精确缺失分区');
      eq(result.periodKey, 'D:2026-11-25', '跨日等待必须保留原周期键');
      eq(result.asOfDate, '2026-11-25', '跨日等待必须锚定原目标日 T，不改用执行日');
      ok(/T01:05:00\.000Z$/.test(result.nextCheckAt), '复查时刻必须是上海 09:05');
    } finally { restoreRegistry(); restoreRepo(); }
  }

  // ---------- 6. Runner 摘要：not_ready 不落成 daily_recorded/weekly_published ----------
  {
    const original = service.runPeriodic;
    service.runPeriodic = async () => ({
      ok: true,
      status: 'not_ready',
      reason: 'selection_not_ready',
      readinessStatus: 'not_ready',
      waitReason: 'selection_not_ready',
      market: 'CN',
      periodType: 'day',
      periodKey: 'D:2026-11-25',
      asOfDate: '2026-11-25',
      shadow: false,
      runId: null,
      qualityStatus: null,
      businessStatus: null,
      published: false,
      selectedCount: 0,
      pendingCount: 0,
      nextCheckAt: '2026-11-28T01:05:00.000Z',
      missingDatasets: ['stock_valuation'],
      missingDomains: ['cn_required_datasets'],
    });
    try {
      const { runSelectionMode } = require('../jobs/stockAnalysisRefresh');
      const summary = await runSelectionMode('selection_daily', 'test', {
        market: 'CN', targetDate: '2026-11-25', periodKey: 'D:2026-11-25',
      });
      eq(summary.stageComplete, false, '未就绪不得标记阶段完成');
      eq(summary.stageCompletedKind, 'not_ready', '终态必须显式 not_ready，不能落成 daily_recorded');
      eq(summary.reason, 'selection_not_ready', 'Runner 必须回传 selection_not_ready');
      eq(summary.waitReason, 'selection_not_ready', 'Runner 必须登记等待原因');
      eq(summary.nextCheckAt, '2026-11-28T01:05:00.000Z', 'Runner 必须采用就绪检查给出的复查时刻');
      eq(summary.missingDatasets.join(','), 'stock_valuation', 'Runner 必须回传精确缺失分区');
      eq(summary.datasetDiagnostics['stock_selection_daily_cn'].coverage_status, 'not_ready',
        '诊断不得把未就绪标成 released/preview_only');
      eq(summary.datasetDiagnostics['stock_selection_daily_cn'].query_status, 'not_started',
        '未开始计算时 query_status 必须是 not_started');

      // 影子槽同样未就绪（F-09）：runId/datasetPublication 均为 null，不得被记成"分区写入失败"。
      const shadowSummary = await runSelectionMode('selection_weekly', 'test', {
        market: 'CN', targetDate: '2026-11-25', periodKey: 'W:2026-11-24', shadow: true,
      });
      eq(shadowSummary.status, 'partial', '影子槽未就绪必须返回 partial');
      eq(shadowSummary.stageCompletedKind, 'not_ready', '影子槽未就绪终态必须是 not_ready');
      eq(shadowSummary.error, undefined, '影子槽未就绪不得输出分区写入失败错误');
      eq(shadowSummary.reason, 'selection_not_ready', '影子槽未就绪原因必须是 selection_not_ready');
      eq(shadowSummary.stageComplete, false, '影子槽未就绪不得标记阶段完成');
      eq(shadowSummary.failedDatasets, undefined, '影子槽未就绪不得列失败数据集');
      ok(!/分区写入失败/.test(String(shadowSummary.error || '')), '未就绪不能被写成发布失败');
    } finally { service.runPeriodic = original; }
  }

  // ---------- 7. 静态契约：就绪检查必须先于 computeSelection ----------
  {
    const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'stockSelectionService.js'), 'utf8');
    const readinessIndex = source.indexOf('await readinessService.assessPeriodReadiness(');
    const computeIndex = source.indexOf('const result = await computeAndPersist({', readinessIndex);
    ok(readinessIndex > 0, 'runPeriodic 必须调用前置就绪检查');
    ok(computeIndex > readinessIndex, '就绪检查必须位于 computeAndPersist 之前');
    ok(/if \(readiness\.ready !== true\)[\s\S]{0,600}?runId: null/.test(source),
      '未就绪分支必须在写库前返回（runId=null）');
  }

  console.log(`OK stock-selection-period-readiness: ${checks} 项前置就绪、A/H 日历、半日市与复查节奏通过`);
}

run().catch(error => {
  console.error(error && (error.stack || error.message));
  process.exit(1);
});

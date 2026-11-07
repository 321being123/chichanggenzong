// 投资策略选股中心：真实发布回放合同（方案 27.22 的 D01 / D02）。
//
// D01：rollback 事件必须回到事件目标版本（to_run_id），from_run_id 只作审计；
//      反向取 from 会停在被回滚的那一版，持仓与"发布91→修订92→回滚91"的实际历史不符。
// D02：区间尾部信号（信号日之后本区间已无交易日）只记"待执行／区间外"，
//      不能把"没有未来开盘"当成历史输入缺失，从而把前面已完整的两期净值整段清空；
//      早期周期缺真实事件仍然拒绝——不借尾部豁免放行未知数据。
//
// 纯计划用例直接调用 resolveRealReplayPlan；端到端用例用固定行情/事件/成员替身
// 调用真实 runDailyBacktest，验证"保留前两期净值并估值到截止"的实际输出。
'use strict';
const assert = require('assert');
const path = require('path');

const tests = [];
async function check(name, fn) {
  try { await fn(); tests.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (error) {
    const detail = String((error && (error.stack || error.message)) || error).split('\n').slice(0, 3).join(' | ');
    tests.push(['FAIL', name + ' :: ' + detail]);
    console.log('  [FAIL] ' + name + ' :: ' + detail);
  }
}

const stub = (relativePath, exports) => {
  const resolved = require.resolve(relativePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

// 2026-10-19（周一）至 2026-11-06（周五）的连续交易日：三整周，最后一个交易日即区间末尾。
const CALENDAR = [
  '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23',
  '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30',
  '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06',
];
const START_DATE = CALENDAR[0];
const END_DATE = CALENDAR[CALENDAR.length - 1];

const MEMBERS = {
  91: [{ instrument_id: 1, code: '600000', slot_no: 1 }],
  92: [{ instrument_id: 2, code: '600001', slot_no: 1 }],
  93: [{ instrument_id: 3, code: '600002', slot_no: 1 }],
};

// 北京时间 18:00 —— 收盘后发布：当天开盘已过，只能顺延到下一个交易日。
const afterClose = day => `${day}T10:00:00Z`;

function weeklyEvents() {
  return new Map([
    ['W:2026-10-19', [{
      event_id: 1, action: 'publish', to_run_id: 91, from_run_id: null,
      visible_at: afterClose('2026-10-23'), occurred_at: afterClose('2026-10-23'), pointer_revision: 1,
    }]],
    ['W:2026-10-26', [{
      event_id: 2, action: 'publish', to_run_id: 92, from_run_id: null,
      visible_at: afterClose('2026-10-30'), occurred_at: afterClose('2026-10-30'), pointer_revision: 2,
    }]],
    // 区间最后一期：11-06 收盘后发布，区间内已没有任何开盘可以成交。
    ['W:2026-11-02', [{
      event_id: 3, action: 'publish', to_run_id: 93, from_run_id: null,
      visible_at: afterClose('2026-11-06'), occurred_at: afterClose('2026-11-06'), pointer_revision: 3,
    }]],
  ]);
}

const state = {
  events: weeklyEvents(),
  captured: { periods: [] },
  // 默认平价（开=收）；需要区分"盘口成交价"与"收盘估值价"的用例再单独覆盖。
  price: () => 10,
  close: (instrumentId, day) => state.price(instrumentId, day),
};

function barsFor(instrumentIds, fromDate, toDate) {
  const map = new Map();
  instrumentIds.forEach(instrumentId => {
    const bars = CALENDAR
      .filter(day => day >= fromDate && day <= toDate)
      .map(day => {
        const open = state.price(instrumentId, day);
        const close = state.close(instrumentId, day);
        return {
          tradeDate: day, open, high: Math.max(open, close) * 1.02, low: Math.min(open, close) * 0.98, close,
          volume: 1e6, amount: 1e9,
        };
      });
    if (bars.length) map.set(String(instrumentId), bars);
  });
  return map;
}

// 替身必须在 require 回测模块之前装好：回测模块在加载时持有 repo/service/事务的引用。
stub(path.join(__dirname, '..', 'services', 'stockSelectionService.js'), {
  STRATEGY_VERSION: 'v1',
  quarterOf: date => `${String(date).slice(0, 4)}Q${Math.ceil(Number(String(date).slice(5, 7)) / 3)}`,
  quarterEndDate: quarter => {
    const year = quarter.slice(0, 4);
    const q = Number(quarter.slice(5));
    const days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return `${year}-${String(q * 3).padStart(2, '0')}-${days[q * 3 - 1]}`;
  },
  computeSelection: async () => ({
    gate: { eligible: true, status: 'eligible' },
    quality: { publishable: true, pendingCount: 0, reasons: [] },
    portfolio: { members: [] },
    params: { slotsPerMarket: 30 },
    positionRatio: 1,
    coverage: { universeCount: 120 },
    strategyCode: 'investment_essentials_adapted',
    universeEvidence: null,
  }),
});

stub(path.join(__dirname, '..', 'repositories', 'stockSelectionRepository.js'), {
  loadCalendar: async () => CALENDAR.slice(),
  loadPublicationReplayEvidence: async () => state.events,
  listMembers: async runId => MEMBERS[Number(runId)] || [],
  loadBarWindow: async ({ instrumentIds, fromDate, toDate }) => barsFor(instrumentIds, fromDate, toDate),
  loadDividendEvents: async () => new Map(),
  loadBenchmarkCloses: async () => new Map(CALENDAR.map(day => [day, 100])),
  upsertStrategy: async () => 42,
  insertBacktest: async () => 7,
  insertBacktestPeriods: async (tx, id, periods) => {
    state.captured.periods = periods;
    return { rowCount: periods.length };
  },
});

stub(path.join(__dirname, '..', 'db', 'transaction.js'), {
  withTransaction: async fn => fn({ query: async () => ({ rows: [] }) }),
});

const BACKTEST = require('../services/stockSelectionBacktest');

async function main() {
  /* ---------------- D01：回滚必须回到事件目标版本 ---------------- */

  await check('D01 回滚回到 to_run_id（91），from_run_id=92 只作审计', () => {
    const calendar = ['2026-10-23', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-11-02'];
    const selections = [{ periodKey: 'W:2026-10-19', signalDate: '2026-10-23' }];
    const eventsByPeriod = new Map([['W:2026-10-19', [
      {
        event_id: 1, action: 'publish', to_run_id: 91, from_run_id: null,
        visible_at: afterClose('2026-10-23'), occurred_at: afterClose('2026-10-23'), pointer_revision: 1,
      },
      {
        event_id: 2, action: 'correct', to_run_id: 92, from_run_id: 91,
        visible_at: afterClose('2026-10-27'), occurred_at: afterClose('2026-10-27'), pointer_revision: 2,
      },
      {
        event_id: 3, action: 'rollback', to_run_id: 91, from_run_id: 92,
        visible_at: afterClose('2026-10-29'), occurred_at: afterClose('2026-10-29'), pointer_revision: 3,
      },
    ]]]);
    const plan = BACKTEST.resolveRealReplayPlan({
      selections, eventsByPeriod, calendar, membersByRun: new Map(Object.entries(MEMBERS).map(([k, v]) => [Number(k), v])), market: 'CN',
    });
    assert.strictEqual(plan.missing.length, 0, '三段事件都应可执行');
    assert.strictEqual(plan.resolved.length, 3, '发布/修订/回滚各留一段持仓区间');
    assert.deepStrictEqual(plan.resolved.map(item => item.replayEvidence.runId), [91, 92, 91]);
    assert.deepStrictEqual(plan.resolved.map(item => item.computed.portfolio.members[0].instrumentId), [1, 2, 1],
      '回滚后持仓必须恢复为 run 91 的成员，不能停在 92');
    // 事件方向的 from 保留在证据里，供审计核对"从哪一版离开"。
    assert.strictEqual(plan.resolved[2].replayEvidence.fromRunId, 92);
    assert.strictEqual(plan.resolved[2].replayEvidence.action, 'rollback');
    assert.strictEqual(plan.resolved[2].executionDate, '2026-10-30', '回滚在 10-29 收盘后可见，顺延到 10-30 开盘生效');
  });

  /* ---------------- D02：计划层区分"待执行"与"缺证据" ---------------- */

  await check('D02 尾部信号无未来开盘记待执行，早期周期缺事件仍拒绝', () => {
    const selections = [
      { periodKey: 'W:2026-10-19', signalDate: '2026-10-23' },
      { periodKey: 'W:2026-10-26', signalDate: '2026-10-30' },
      { periodKey: 'W:2026-11-02', signalDate: '2026-11-06' },
    ];
    const membersByRun = new Map(Object.entries(MEMBERS).map(([k, v]) => [Number(k), v]));
    const plan = BACKTEST.resolveRealReplayPlan({
      selections, eventsByPeriod: weeklyEvents(), calendar: CALENDAR, membersByRun, market: 'CN',
    });
    assert.strictEqual(plan.missing.length, 0, '尾部无未来开盘不是历史输入缺失');
    assert.deepStrictEqual(plan.resolved.map(item => item.periodKey), ['W:2026-10-19', 'W:2026-10-26']);
    assert.strictEqual(plan.pending.length, 1);
    assert.strictEqual(plan.pending[0].periodKey, 'W:2026-11-02');
    assert.strictEqual(plan.pending[0].reason, 'execution_after_window');

    // 早期周期缺事件：仍然拒绝，不能借尾部豁免放行未知数据。
    const partial = weeklyEvents();
    partial.delete('W:2026-10-19');
    const rejected = BACKTEST.resolveRealReplayPlan({
      selections, eventsByPeriod: partial, calendar: CALENDAR, membersByRun, market: 'CN',
    });
    assert.strictEqual(rejected.missing.length, 1);
    assert.strictEqual(rejected.missing[0].periodKey, 'W:2026-10-19');
    assert.strictEqual(rejected.missing[0].reason, 'publication_event_missing');
  });

  /* ---------------- D02 端到端：前两期净值必须保留 ---------------- */

  await check('D02 端到端：尾部待执行不清空前期净值，日曲线估值到区间末', async () => {
    state.events = weeklyEvents();
    state.captured.periods = [];
    const result = await BACKTEST.runBacktest({
      market: 'CN',
      startDate: START_DATE,
      endDate: END_DATE,
      signalFrequency: 'week',
      replayMode: 'real',
      costs: { buyBps: 0, sellBps: 0 },
    });
    assert.strictEqual(result.status, 'partial',
      `应为可评估，实际 ${result.status}（${result.diagnostics.missing && result.diagnostics.missing.reason}）`);
    assert.strictEqual(result.metrics.periodCount, 2, '两期已成交的发布都必须计入收益序列');
    assert.strictEqual(state.captured.periods.length, 2, '落库收益点应与已执行期次一致');
    assert.strictEqual(result.diagnostics.dailyNav.points, CALENDAR.length, '估值应覆盖到区间末');
    assert.deepStrictEqual(result.diagnostics.replayCoverage,
      { signals: 3, executed: 2, pending: 1, missing: 0 });
    assert.strictEqual(result.diagnostics.replayPending[0].periodKey, 'W:2026-11-02');
    assert.strictEqual(result.diagnostics.replayPending[0].reason, 'execution_after_window');
    // 待执行期次仍留在期次清单里，只是明确标注未成交原因。
    const tail = result.diagnostics.periods.find(item => item.periodKey === 'W:2026-11-02');
    assert.ok(tail, '尾部期次必须保留在诊断里');
    assert.strictEqual(tail.executionDate, null);
    assert.strictEqual(tail.pendingExecution[0].reason, 'execution_after_window');
    // 价格不变、零费用：前期两笔换仓后净值仍为 1，且收益曲线不是空的。
    assert.ok(Math.abs(result.metrics.totalReturn) < 1e-9, `零成本平价换仓总收益应为 0，实际 ${result.metrics.totalReturn}`);
    assert.strictEqual(result.diagnostics.missing.reason, undefined, '不得把尾部待执行写进 missing');
  });

  await check('D02 端到端：早期周期缺事件仍整体不可评估（不借尾部豁免）', async () => {
    const events = weeklyEvents();
    events.delete('W:2026-10-19');
    state.events = events;
    state.captured.periods = [];
    const result = await BACKTEST.runBacktest({
      market: 'CN',
      startDate: START_DATE,
      endDate: END_DATE,
      signalFrequency: 'week',
      replayMode: 'real',
      costs: { buyBps: 0, sellBps: 0 },
    });
    assert.strictEqual(result.status, 'not_evaluable');
    assert.strictEqual(result.diagnostics.missing.reason, 'real_publication_events_missing');
    assert.deepStrictEqual(result.diagnostics.missing.periods, ['W:2026-10-19']);
    assert.deepStrictEqual(result.metrics, {});
    assert.strictEqual(state.captured.periods.length, 0);
  });

  await check('D02 端到端：全部期次都只能区间外成交时报可执行发布不足', async () => {
    // 两周窗口（信号 10-30、11-06），两条发布都在 11-06 收盘后才可见 → 区间内没有可执行成交。
    state.captured.periods = [];
    state.events = new Map([
      ['W:2026-10-26', [{
        event_id: 8, action: 'publish', to_run_id: 92, from_run_id: null,
        visible_at: afterClose('2026-11-06'), occurred_at: afterClose('2026-11-06'), pointer_revision: 1,
      }]],
      ['W:2026-11-02', [{
        event_id: 9, action: 'publish', to_run_id: 93, from_run_id: null,
        visible_at: afterClose('2026-11-06'), occurred_at: afterClose('2026-11-06'), pointer_revision: 2,
      }]],
    ]);
    const result = await BACKTEST.runBacktest({
      market: 'CN', startDate: '2026-10-26', endDate: END_DATE,
      signalFrequency: 'week', replayMode: 'real', costs: { buyBps: 0, sellBps: 0 },
    });
    assert.strictEqual(result.status, 'not_evaluable');
    assert.strictEqual(result.diagnostics.reason, 'insufficient_executable_publications');
    assert.deepStrictEqual(result.metrics, {});
    assert.strictEqual(result.diagnostics.replayCoverage.executed, 0);
    assert.strictEqual(result.diagnostics.replayCoverage.pending, 2);
    assert.strictEqual(state.captured.periods.length, 0);
  });

  await check('D01 端到端：回滚后现金与持仓真的换回 91，后续行情不再按 92 计价', async () => {
    // 91 持 instrument 1（恒定 10）；92 持 instrument 2（10-30 开盘 10.5、收盘 11）。
    // 回滚在 10-30 开盘生效：按 10.5 卖出 92 并换回 1，当日收盘净值应为 1.0016667；
    // 若错停在被回滚的 92，收盘会按 11 计价得到 1.0033333——用净值反证持仓真的换回来了。
    state.price = (instrumentId, day) => {
      if (Number(instrumentId) !== 2) return 10;
      if (day >= '2026-11-02') return 11.5;
      if (day >= '2026-10-30') return 10.5;
      return 10;
    };
    state.close = (instrumentId, day) => {
      if (Number(instrumentId) === 2 && day === '2026-10-30') return 11;
      return state.price(instrumentId, day);
    };
    state.events = new Map([
      ['W:2026-10-19', [
        {
          event_id: 11, action: 'publish', to_run_id: 91, from_run_id: null,
          visible_at: afterClose('2026-10-23'), occurred_at: afterClose('2026-10-23'), pointer_revision: 1,
        },
        {
          event_id: 12, action: 'correct', to_run_id: 92, from_run_id: 91,
          visible_at: afterClose('2026-10-27'), occurred_at: afterClose('2026-10-27'), pointer_revision: 2,
        },
        {
          event_id: 13, action: 'rollback', to_run_id: 91, from_run_id: 92,
          visible_at: afterClose('2026-10-29'), occurred_at: afterClose('2026-10-29'), pointer_revision: 3,
        },
      ]],
      // 后两周各自发布同一份 91：只用于满足"区间内至少两期"和尾部待执行，不改变持仓。
      ['W:2026-10-26', [{
        event_id: 14, action: 'publish', to_run_id: 91, from_run_id: null,
        visible_at: afterClose('2026-10-30'), occurred_at: afterClose('2026-10-30'), pointer_revision: 4,
      }]],
      ['W:2026-11-02', [{
        event_id: 15, action: 'publish', to_run_id: 91, from_run_id: null,
        visible_at: afterClose('2026-11-06'), occurred_at: afterClose('2026-11-06'), pointer_revision: 5,
      }]],
    ]);
    state.captured.periods = [];
    const result = await BACKTEST.runBacktest({
      market: 'CN', startDate: START_DATE, endDate: END_DATE,
      signalFrequency: 'week', replayMode: 'real', costs: { buyBps: 0, sellBps: 0 },
    });
    try {
      assert.strictEqual(result.status, 'partial', `实际 ${result.status}`);
      assert.deepStrictEqual(
        result.diagnostics.replayEvidence.map(item => [item.action, item.runId]),
        [['publish', 91], ['correct', 92], ['rollback', 91], ['publish', 91]],
      );
      const day1030 = result.diagnostics.dailyNav.sample.find(item => item.tradeDate === '2026-10-30');
      assert.ok(day1030, '10-30 必须有点位');
      assert.ok(Math.abs(day1030.nav - 1.0016666667) < 1e-6,
        `回滚生效后 10-30 收盘净值应为 1.0016667，实际 ${day1030.nav}`);
      // 日曲线按 8 位小数落盘，收益由该序列计算：容差取 1e-8，足以区分 1/600 与错误路径的 1/300。
      assert.ok(Math.abs(result.metrics.totalReturn - 1 / 600) < 1e-8,
        `回滚后只保留 92 持仓段已实现收益 1/600，实际 ${result.metrics.totalReturn}`);
    } finally {
      state.price = () => 10;
      state.close = (instrumentId, day) => state.price(instrumentId, day);
    }
  });

  /* ---------------- E01：同一开盘窗口的连续修订只按最终目标成交 ---------------- */

  const e01Input = () => ({
    market: 'CN', startDate: START_DATE, endDate: END_DATE,
    signalFrequency: 'week', replayMode: 'real', costs: { buyBps: 3, sellBps: 3 },
  });
  const e01Members = () => new Map(Object.entries(MEMBERS).map(([k, v]) => [Number(k), v]));

  await check('E01 计划层：同窗两事件只认最终目标，跨开盘修订仍逐段生效', () => {
    const sameWindow = new Map([['W:2026-10-19', [
      {
        event_id: 1, action: 'publish', to_run_id: 91, from_run_id: null,
        visible_at: afterClose('2026-10-23'), occurred_at: afterClose('2026-10-23'), pointer_revision: 1,
      },
      {
        event_id: 2, action: 'correct', to_run_id: 92, from_run_id: 91,
        visible_at: afterClose('2026-10-24'), occurred_at: afterClose('2026-10-24'), pointer_revision: 2,
      },
    ]]]);
    const plan = BACKTEST.resolveRealReplayPlan({
      selections: [{ periodKey: 'W:2026-10-19', signalDate: '2026-10-23' }],
      eventsByPeriod: sameWindow, calendar: CALENDAR, membersByRun: e01Members(), market: 'CN',
    });
    assert.strictEqual(plan.missing.length, 0);
    assert.strictEqual(plan.resolved.length, 2, '两条事件都留档');
    assert.deepStrictEqual(plan.resolved.map(item => item.executionDate), ['2026-10-26', '2026-10-26']);
    assert.deepStrictEqual(plan.resolved.map(item => item.effectiveTarget), [false, true],
      '周一开盘只认最终生效的 92/B');
    assert.strictEqual(plan.resolved[1].computed.portfolio.members[0].instrumentId, 2);

    // 不同开盘日生效的修订各自真的成交过，不能误合并成只留最后一版。
    const acrossDays = new Map([['W:2026-10-19', [
      {
        event_id: 1, action: 'publish', to_run_id: 91, from_run_id: null,
        visible_at: afterClose('2026-10-23'), occurred_at: afterClose('2026-10-23'), pointer_revision: 1,
      },
      {
        event_id: 2, action: 'correct', to_run_id: 92, from_run_id: 91,
        visible_at: afterClose('2026-10-27'), occurred_at: afterClose('2026-10-27'), pointer_revision: 2,
      },
      {
        event_id: 3, action: 'correct', to_run_id: 93, from_run_id: 92,
        visible_at: afterClose('2026-10-29'), occurred_at: afterClose('2026-10-29'), pointer_revision: 3,
      },
    ]]]);
    const staged = BACKTEST.resolveRealReplayPlan({
      selections: [{ periodKey: 'W:2026-10-19', signalDate: '2026-10-23' }],
      eventsByPeriod: acrossDays, calendar: CALENDAR, membersByRun: e01Members(), market: 'CN',
    });
    assert.deepStrictEqual(staged.resolved.map(item => item.executionDate),
      ['2026-10-26', '2026-10-28', '2026-10-30']);
    assert.deepStrictEqual(staged.resolved.map(item => item.effectiveTarget), [true, true, true],
      '已各自成交的历史仓位必须保留，不能只留最后一个');

    // 跨期：上一期的修订与下一期首次发布都落在 11-02 开盘；按数组顺序会先写修订、
    // 再被下一期发布覆盖，但真实更晚生效的是 11-01 的修订。最终目标必须按时间选。
    const crossPeriod = new Map([
      ['W:2026-10-19', [
        {
          event_id: 1, action: 'publish', to_run_id: 91, from_run_id: null,
          visible_at: afterClose('2026-10-23'), occurred_at: afterClose('2026-10-23'), pointer_revision: 1,
        },
        {
          event_id: 5, action: 'correct', to_run_id: 93, from_run_id: 91,
          visible_at: afterClose('2026-11-01'), occurred_at: afterClose('2026-11-01'), pointer_revision: 5,
        },
      ]],
      ['W:2026-10-26', [{
        event_id: 2, action: 'publish', to_run_id: 92, from_run_id: null,
        visible_at: afterClose('2026-10-31'), occurred_at: afterClose('2026-10-31'), pointer_revision: 2,
      }]],
    ]);
    const cross = BACKTEST.resolveRealReplayPlan({
      selections: [
        { periodKey: 'W:2026-10-19', signalDate: '2026-10-23' },
        { periodKey: 'W:2026-10-26', signalDate: '2026-10-30' },
      ],
      eventsByPeriod: crossPeriod, calendar: CALENDAR, membersByRun: e01Members(), market: 'CN',
    });
    assert.strictEqual(cross.missing.length, 0);
    assert.strictEqual(cross.resolved.length, 3);
    const sameOpen = cross.resolved.filter(item => item.executionDate === '2026-11-02');
    assert.strictEqual(sameOpen.length, 2, '两条跨期事件落在同一开盘');
    assert.strictEqual(sameOpen.filter(item => item.effectiveTarget === true).length, 1);
    assert.strictEqual(sameOpen.find(item => item.effectiveTarget === true).replayEvidence.runId, 93,
      '11-01 更晚生效的修订才是该开盘的最终目标');
  });

  await check('E01 端到端：周五发A/周六改B，费用换手与逐日净值等于只发布B', async () => {
    const withIntermediate = weeklyEvents();
    withIntermediate.set('W:2026-10-19', [
      {
        event_id: 1, action: 'publish', to_run_id: 91, from_run_id: null,
        visible_at: afterClose('2026-10-23'), occurred_at: afterClose('2026-10-23'), pointer_revision: 1,
      },
      {
        event_id: 2, action: 'correct', to_run_id: 92, from_run_id: 91,
        visible_at: afterClose('2026-10-24'), occurred_at: afterClose('2026-10-24'), pointer_revision: 2,
      },
    ]);
    const latestOnly = weeklyEvents();
    latestOnly.set('W:2026-10-19', [{
      event_id: 2, action: 'publish', to_run_id: 92, from_run_id: null,
      visible_at: afterClose('2026-10-24'), occurred_at: afterClose('2026-10-24'), pointer_revision: 1,
    }]);
    try {
      state.events = withIntermediate;
      state.captured.periods = [];
      const a = await BACKTEST.runBacktest(e01Input());
      state.events = latestOnly;
      state.captured.periods = [];
      const b = await BACKTEST.runBacktest(e01Input());
      assert.strictEqual(a.status, 'partial', `实际 ${a.status}`);
      assert.strictEqual(b.status, 'partial', `实际 ${b.status}`);
      assert.ok(Math.abs(a.metrics.fees - b.metrics.fees) < 1e-12,
        `中间版本不得产生费用：${a.metrics.fees} vs ${b.metrics.fees}`);
      assert.ok(Math.abs(a.metrics.turnover - b.metrics.turnover) < 1e-12,
        `中间版本不得产生换手：${a.metrics.turnover} vs ${b.metrics.turnover}`);
      assert.ok(Math.abs(a.metrics.totalReturn - b.metrics.totalReturn) < 1e-12);
      assert.deepStrictEqual(
        a.diagnostics.dailyNav.sample.map(item => item.nav),
        b.diagnostics.dailyNav.sample.map(item => item.nav),
        '逐日净值必须与只发布最终目标完全一致（A 从未成交）');
      const firstTradable = a.diagnostics.dailyNav.sample.find(item => item.tradeDate === '2026-10-26');
      assert.ok(firstTradable, '首个可成交开盘必须有点位');
      assert.strictEqual(firstTradable.holdingsCount, 1, '周一开盘只按最终目标建一份仓');
      // 完整事件序列仍留审计，被取代版本明确标注。
      const audit = a.diagnostics.replayEvidence.filter(item => item.periodKey === 'W:2026-10-19');
      assert.deepStrictEqual(audit.map(item => [item.action, item.runId, item.effectiveTarget]),
        [['publish', 91, false], ['correct', 92, true]]);
      assert.ok(a.diagnostics.replaySuperseded.some(item => item.runId === 91
        && item.reason === 'superseded_before_first_tradable_open'));
    } finally {
      state.events = weeklyEvents();
      state.captured.periods = [];
    }
  });

  /* ---------------- E02：完整已发布的零合格空仓是有效现金目标 ---------------- */

  const zeroRunEvent = (overrides = {}) => Object.assign({
    event_id: 42, action: 'publish', to_run_id: 393, from_run_id: null,
    visible_at: afterClose('2026-10-23'), occurred_at: afterClose('2026-10-23'), pointer_revision: 1,
    execution_status: 'succeeded', quality_status: 'passed', business_status: 'no_eligible_member',
    selected_count: 0, pending_count: 0, universe_count: 1,
  }, overrides);

  const zeroPlan = event => BACKTEST.resolveRealReplayPlan({
    selections: [{ periodKey: 'W:2026-10-19', signalDate: '2026-10-23' }],
    eventsByPeriod: new Map([['W:2026-10-19', [event]]]),
    calendar: ['2026-10-23', '2026-10-26', '2026-10-27'],
    membersByRun: new Map([[393, []]]), market: 'CN',
  });

  await check('E02 计划层：零合格已发布批次恢复为有效现金，证据不全仍拒绝', () => {
    const ok = zeroPlan(zeroRunEvent());
    assert.strictEqual(ok.missing.length, 0, '完整已发布且 selected_count=0 不能判成员缺失');
    assert.strictEqual(ok.resolved.length, 1);
    assert.strictEqual(ok.resolved[0].executionDate, '2026-10-26');
    assert.strictEqual(ok.resolved[0].computed.portfolio.members.length, 0);
    assert.strictEqual(ok.resolved[0].replayEvidence.zeroSelection, true);
    assert.deepStrictEqual(ok.resolved[0].replayEvidence.runStatus, {
      executionStatus: 'succeeded', qualityStatus: 'passed', businessStatus: 'no_eligible_member',
      selectedCount: 0, pendingCount: 0,
    });

    // 反例：任一证据缺失或不成立都仍拒绝，防止把"成员丢失"当空仓放行。
    const rejects = [
      ['selected_count>0 却无成员', { selected_count: 3 }],
      ['待补对象不为 0', { pending_count: 2 }],
      ['执行未完成', { execution_status: 'failed' }],
      ['质量未通过', { quality_status: 'failed' }],
      ['业务状态非明确零合格', { business_status: 'ok' }],
      ['选中计数未知', { selected_count: null }],
      ['待补计数未知', { pending_count: null }],
    ];
    rejects.forEach(([label, patch]) => {
      const plan = zeroPlan(zeroRunEvent(patch));
      assert.strictEqual(plan.missing.length, 1, `${label} 应拒绝`);
      assert.strictEqual(plan.missing[0].reason, 'published_run_members_missing', label);
      assert.strictEqual(plan.resolved.length, 0, label);
    });
    // deactivate 是主动空仓，本来就不需要批次状态证据，仍应放行。
    const deactivated = zeroPlan(Object.assign(zeroRunEvent(), {
      action: 'deactivate', to_run_id: null, execution_status: null, quality_status: null,
      business_status: null, selected_count: null, pending_count: null,
    }));
    assert.strictEqual(deactivated.missing.length, 0, 'deactivate 是明确空仓，不依赖零合格证据');
    assert.strictEqual(deactivated.resolved[0].replayEvidence.zeroSelection, false);
  });

  await check('E02 端到端：旧仓净卖出、现金留存、日NAV连续', async () => {
    state.events = new Map([
      ['W:2026-10-19', [{
        event_id: 31, action: 'publish', to_run_id: 91, from_run_id: null,
        visible_at: afterClose('2026-10-23'), occurred_at: afterClose('2026-10-23'), pointer_revision: 1,
      }]],
      ['W:2026-10-26', [Object.assign(zeroRunEvent(), {
        event_id: 32, visible_at: afterClose('2026-10-30'), occurred_at: afterClose('2026-10-30'),
        pointer_revision: 2,
      })]],
      ['W:2026-11-02', [{
        event_id: 33, action: 'publish', to_run_id: 91, from_run_id: null,
        visible_at: afterClose('2026-11-06'), occurred_at: afterClose('2026-11-06'), pointer_revision: 3,
      }]],
    ]);
    // 第二期之后 instrument 1 继续上涨：只有真的卖出并留在现金，NAV 才不再随之变化。
    state.price = (instrumentId, day) => {
      if (Number(instrumentId) !== 1) return 10;
      if (day >= '2026-11-03') return 10.2;
      if (day >= '2026-11-02') return 10.1;
      return 10;
    };
    state.close = (instrumentId, day) => state.price(instrumentId, day);
    try {
      state.captured.periods = [];
      const result = await BACKTEST.runBacktest({
        market: 'CN', startDate: START_DATE, endDate: END_DATE,
        signalFrequency: 'week', replayMode: 'real', costs: { buyBps: 0, sellBps: 0 },
      });
      assert.strictEqual(result.status, 'partial',
        `实际 ${result.status}（${result.diagnostics.missing && result.diagnostics.missing.reason}）`);
      assert.deepStrictEqual(result.diagnostics.replayCoverage,
        { signals: 3, executed: 2, pending: 1, missing: 0 });
      const zeroEvidence = result.diagnostics.replayEvidence.find(item => item.runId === 393);
      assert.ok(zeroEvidence, '零合格事件必须进入回放证据');
      assert.strictEqual(zeroEvidence.zeroSelection, true);
      const series = result.diagnostics.dailyNav.sample;
      assert.strictEqual(series.length, CALENDAR.length, '日曲线不断档');
      const afterClear = series.filter(item => item.tradeDate >= '2026-11-02');
      assert.ok(afterClear.length >= 2, '清仓后仍须有日点');
      afterClear.forEach(item => {
        assert.strictEqual(item.holdingsCount, 0, `${item.tradeDate} 应已清仓`);
        assert.strictEqual(item.cashWeight, 1, `${item.tradeDate} 应全部为现金`);
      });
      afterClear.slice(1).forEach(item => {
        assert.strictEqual(item.nav, afterClear[0].nav,
          `${item.tradeDate} 不应再随旧仓价格波动`);
      });
      assert.strictEqual(state.captured.periods.length, 2, '两期已执行期次都要落库');
    } finally {
      state.events = weeklyEvents();
      state.price = () => 10;
      state.close = (instrumentId, day) => state.price(instrumentId, day);
      state.captured.periods = [];
    }
  });

  const failed = tests.filter(item => item[0] === 'FAIL').length;
  console.log('\n选股真实回放专项：' + (tests.length - failed) + '/' + tests.length + ' 通过');
  if (failed) process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

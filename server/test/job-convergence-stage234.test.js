'use strict';
// 阶段 2/3/4：凌晨波次前移、任务码收敛与旧告警映射、存量候选清理回归。
// 运行：npm.cmd run test:file -- server/test/job-convergence-stage234.test.js
//
// 覆盖：
//  A. 跨日契约与排程开关（纯函数 + 真实 syncScheduleSlots 收敛/回滚）
//  B. 失败隔离必过反例（现金分红→换股结算、安全评分→估值分区、CN/HK/选股归档）
//  C. LEGACY_JOB_ALIAS_MAP 历史告警按数据集分区 / 连续 3 次成功证据归档，以及拒绝空证据/跨作用域
//  D. pruneSelectionCandidates 真实清理、入选行全保留、断链 0、生产缺 --allow-production 拒绝执行

const assert = require('assert');

process.env.NODE_ENV = 'test';
process.env.ALERT_EMAIL_TO = '';
process.env.ALERT_EMAIL_FROM = '';

const { pool } = require('../db/connection');
const { initSchema } = require('../db/migrations');
const definitions = require('../services/jobDefinitions');
const slots = require('../services/jobScheduleSlots');
const convergence = require('../services/jobConvergence');
const recovery = require('../services/jobRecoveryEvidence');
const { verifyAlertScope } = require('../services/jobAlertMailer');
const { publishDatasetPartition } = require('../services/datasetPartitions');
const prune = require('../scripts/pruneSelectionCandidates');

const CONVERGED = ['cn_stock_eod_sync', 'hk_stock_eod_sync', 'convertible_bond_eod_sync', 'exchange_announcements_sync',
  'bond_analytics_refresh', 'stock_analytics_refresh', 'system_retention'];
const SUPERSEDED = ['convertible_bond_universe_refresh', 'company_financial_incremental_sync', 'hk_trade_rules_sync',
  'hk_trade_calendar_sync', 'index_recent', 'market_volatility_sync', 'convertible_bond_revision_motive_inputs_sync',
  'convertible_bond_announcement_history_sync', 'arbitrage_sync', 'ipo_history_sync', 'convertible_bond_valuation_refresh',
  'bond_safety_refresh', 'stock_analysis_refresh', 'site_analytics_retention', 'storage_retention'];
const SCHEDULE_DATES = ['2027-01-15', '2027-01-16'];

const failures = [];
function check(name, fn) {
  try {
    fn();
    console.log('  [PASS] ' + name);
  } catch (error) {
    failures.push(name + ' :: ' + (error && error.message || error));
    console.log('  [FAIL] ' + name + ' :: ' + (error && error.message || error));
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    console.log('  [PASS] ' + name);
  } catch (error) {
    failures.push(name + ' :: ' + (error && error.stack || error));
    console.log('  [FAIL] ' + name + ' :: ' + (error && error.message || error));
  }
}
function definitionOf(code) {
  return definitions.JOB_DEFINITIONS.find(item => item.jobCode === code);
}

function contractChecks() {
  check('7 个凌晨收敛任务已登记且带波次二时刻', () => {
    const expected = {
      cn_stock_eod_sync: [1, 0], hk_stock_eod_sync: [1, 15], convertible_bond_eod_sync: [1, 30],
      exchange_announcements_sync: [1, 45], bond_analytics_refresh: [2, 30], stock_analytics_refresh: [2, 30],
      system_retention: [4, 0],
    };
    for (const [code, [hour, minute]] of Object.entries(expected)) {
      const def = definitionOf(code);
      assert.ok(def, `${code} 未登记`);
      assert.strictEqual(def.hour, hour, `${code} 时刻错误`);
      assert.strictEqual(def.minute, minute, `${code} 分钟错误`);
    }
  });

  check('夜班任务声明 afterTradingDay/previous_trading_day，且波次一三品种时刻未变', () => {
    for (const code of ['cn_stock_eod_sync', 'hk_stock_eod_sync', 'convertible_bond_eod_sync', 'exchange_announcements_sync', 'bond_analytics_refresh', 'stock_analytics_refresh']) {
      const def = definitionOf(code);
      assert.strictEqual(def.afterTradingDay, true, `${code} 必须次日凌晨执行`);
      assert.strictEqual(def.dataDatePolicy, 'previous_trading_day', `${code} 目标日必须是上一交易日`);
    }
    for (const code of ['market_close:A股', 'market_close:可转债', 'market_close:LOF/ETF']) {
      const def = definitionOf(code);
      assert.strictEqual(def.hour, 15);
      assert.strictEqual(def.minute, 30);
      assert.strictEqual(def.afterTradingDay, false);
    }
    const hkClose = definitionOf('market_close:港股');
    assert.strictEqual(hkClose.marketCalendarPolicy, 'hk-close');
    assert.strictEqual(hkClose.minute, 30);
    const hkRate = definitionOf('hk_rate');
    assert.strictEqual(hkRate.marketCalendarPolicy, 'hk-rate', 'hk_rate 必须保持独立日历策略');
    assert.strictEqual(hkRate.hour, 16);
    assert.strictEqual(hkRate.minute, 15);
    const nav = definitionOf('nav_snapshot');
    assert.strictEqual(nav.hour, 16);
    assert.strictEqual(nav.minute, 20);
    assert.deepStrictEqual(nav.readinessCheckpoints, ['18:30']);
    assert.ok(nav.readinessDatasetDependencies.some(item => item.datasetCode === 'repo_daily_rates'));
    const ipo = definitionOf('ipo_calendar_refresh');
    assert.strictEqual(ipo.hour, 18);
    assert.strictEqual(ipo.minute, 5);
  });

  check('15 个旧任务码保留定义与 manual 入口并标注 supersededBy', () => {
    assert.strictEqual(SUPERSEDED.length, 15);
    for (const code of SUPERSEDED) {
      const def = definitionOf(code);
      assert.ok(def, `${code} 定义被删除，旧槽查询与既有单测会失效`);
      assert.ok(Array.isArray(def.supersededBy) && def.supersededBy.length, `${code} 缺少 supersededBy`);
      for (const successor of def.supersededBy) {
        assert.ok(CONVERGED.includes(successor), `${code} 的 supersededBy 指向未知任务 ${successor}`);
      }
    }
    assert.strictEqual(definitions.CONVERGED_JOB_CODES.length, 7);
  });

  check('holiday_sync 保持原任务码并调整到每月 1 日 04:30', () => {
    const def = definitionOf('holiday_sync');
    assert.strictEqual(def.monthly, true);
    assert.strictEqual(def.hour, 4);
    assert.strictEqual(def.minute, 30);
  });

  check('新任务逐模式声明契约且依赖数据集均已注册', () => {
    const { DATASET_PARTITION_REGISTRY } = require('../services/datasetPartitionRegistry');
    for (const code of CONVERGED) {
      const def = definitionOf(code);
      assert.ok(def.datasetPublicationByMode && def.datasetPublicationByMode.core, `${code} 缺少 core 阶段发布契约`);
      assert.strictEqual(def.datasetPublicationByMode.core.requireStageComplete, true, `${code} 必须要求阶段完成`);
      assert.deepStrictEqual(def.modeDependencyCodes.core || [], [], `${code} 必须显式声明无任务码依赖`);
      assert.ok(Array.isArray(def.modeDatasetDependencies.core), `${code} 缺少逐模式数据集依赖`);
      for (const requirement of def.modeDatasetDependencies.core) {
        assert.ok(def.consumesDatasets.includes(requirement.datasetCode), `${code} 依赖 ${requirement.datasetCode} 未在 consumesDatasets`);
        assert.ok(DATASET_PARTITION_REGISTRY[requirement.datasetCode], `${code} 依赖 ${requirement.datasetCode} 未注册`);
      }
      assert.strictEqual(def.requiresDataWatermark, false, `${code} 已由分区证据收口，不得再要求任务级水位`);
    }
    const bond = definitionOf('bond_analytics_refresh');
    assert.deepStrictEqual(bond.datasetDependencies.map(item => item.datasetCode).sort(),
      ['bond_daily', 'bond_master', 'stock_daily', 'stock_financial_reports', 'stock_suspend_calendar'].sort());
    const exchange = definitionOf('exchange_announcements_sync');
    assert.ok(exchange.datasetDependencies.some(item => item.datasetCode === 'bond_master'));
  });

  check('360 分钟转债估值与 60 分钟个股/选股彻底拆槽', () => {
    const bond = definitionOf('bond_analytics_refresh');
    const stock = definitionOf('stock_analytics_refresh');
    assert.strictEqual(bond.deadlineMinutes, 360);
    assert.strictEqual(bond.timeoutMinutes, 360);
    assert.strictEqual(stock.deadlineMinutes, 60);
    assert.strictEqual(stock.timeoutMinutes, 60);
    assert.notStrictEqual(bond.jobCode, stock.jobCode);
  });
}

function crossDayChecks() {
  check('周五收盘→周六凌晨目标日严格为周五，周日/周一不空跑', () => {
    assert.strictEqual(slots.isWeekday('2026-11-27'), true, '2026-11-27 应为交易日');
    assert.strictEqual(slots.isWeekday('2026-11-28'), false, '2026-11-28 应为周六');
    assert.strictEqual(slots.isSlotDayAllowed('2026-11-28', { afterTradingDay: true, weekdays: true }), true);
    assert.strictEqual(slots.isSlotDayAllowed('2026-11-29', { afterTradingDay: true, weekdays: true }), false);
    assert.strictEqual(slots.isSlotDayAllowed('2026-11-30', { afterTradingDay: true, weekdays: true }), false);
    assert.strictEqual(slots.expectedDataDate('cn_stock_eod_sync', '2026-11-28'), '2026-11-27');
    assert.strictEqual(slots.expectedDataDate('bond_analytics_refresh', '2026-11-28'), '2026-11-27');
  });

  check('ipo_calendar_refresh 目标日严格为下一工作日（不随凌晨前移漂移）', () => {
    assert.strictEqual(slots.expectedDataDate('ipo_calendar_refresh', '2026-11-27'), '2026-11-30');
    assert.strictEqual(slots.expectedDataDate('ipo_calendar_refresh', '2026-11-26'), '2026-11-27');
  });

  check('港开 A 休的次日凌晨允许生成港股槽位（CN 口径则拒绝）', () => {
    const holidays = require('../config/holidays.json');
    const list2026 = (holidays.years && holidays.years['2026']) || [];
    const weekdayHoliday = list2026.find(date => {
      const day = new Date(`${date}T00:00:00Z`).getUTCDay();
      return day >= 1 && day <= 5;
    });
    assert.ok(weekdayHoliday, '2026 年应至少有一个工作日的休市日用于本反例');
    const next = new Date(`${weekdayHoliday}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    const runDay = next.toISOString().slice(0, 10);
    const hkDefinition = definitionOf('hk_stock_eod_sync');
    assert.strictEqual(slots.isSlotDayAllowed(runDay, hkDefinition), true, '港股任务必须按港交所日历判断前一交易日');
    assert.strictEqual(slots.isSlotDayAllowed(runDay, { afterTradingDay: true, weekdays: true }), false,
      'CN 交易日口径在 A 股休市时应拒绝，反例才能证明两套日历不同');
  });

  check('JOB_CONVERGENCE_ENABLED 默认开启，显式 0 才回退', () => {
    const backup = process.env.JOB_CONVERGENCE_ENABLED;
    try {
      delete process.env.JOB_CONVERGENCE_ENABLED;
      assert.strictEqual(definitions.jobConvergenceEnabled(), true);
      process.env.JOB_CONVERGENCE_ENABLED = '1';
      assert.strictEqual(definitions.jobConvergenceEnabled(), true);
      process.env.JOB_CONVERGENCE_ENABLED = '0';
      assert.strictEqual(definitions.jobConvergenceEnabled(), false);
    } finally {
      if (backup === undefined) delete process.env.JOB_CONVERGENCE_ENABLED;
      else process.env.JOB_CONVERGENCE_ENABLED = backup;
    }
  });

  check('收敛后在役旧任务手工补跑不再被已收敛任务码阻塞', () => {
    const backup = process.env.JOB_CONVERGENCE_ENABLED;
    const legacy = definitionOf('bond_safety_refresh');
    const slot = { job_code: 'bond_safety_refresh', request_payload: { mode: 'core' } };
    try {
      process.env.JOB_CONVERGENCE_ENABLED = '1';
      assert.deepStrictEqual(slots.scheduledDependenciesFor(legacy, slot), [],
        '旧任务的任务码依赖已由新任务数据集依赖承接，手工补跑不得永久阻塞');
      process.env.JOB_CONVERGENCE_ENABLED = '0';
      assert.deepStrictEqual(slots.scheduledDependenciesFor(legacy, slot), ['convertible_bond_universe_refresh'],
        '回退时必须恢复原任务码依赖');
    } finally {
      if (backup === undefined) delete process.env.JOB_CONVERGENCE_ENABLED;
      else process.env.JOB_CONVERGENCE_ENABLED = backup;
    }
  });
}

async function clearScheduleFixtures() {
  await pool.query(
    `DELETE FROM ops.job_schedule_slots
      WHERE business_date >= $1::date AND business_date <= $2::date`,
    [SCHEDULE_DATES[0], SCHEDULE_DATES[1]],
  );
}

async function scheduledCodesOn(date) {
  const { rows } = await pool.query(
    `SELECT DISTINCT job_code FROM ops.job_schedule_slots
      WHERE (scheduled_for AT TIME ZONE 'Asia/Shanghai')::date = $1::date`,
    [date],
  );
  return rows.map(row => row.job_code);
}

async function scheduleSwitchChecks() {
  const backup = process.env.JOB_CONVERGENCE_ENABLED;
  try {
    await clearScheduleFixtures();
    process.env.JOB_CONVERGENCE_ENABLED = '1';
    await slots.syncScheduleSlots(new Date('2027-01-16T10:00:00+08:00'));
    const converged = await scheduledCodesOn('2027-01-16');
    for (const code of CONVERGED) {
      assert.ok(converged.includes(code), `收敛开启时 ${code} 未生成计划槽`);
    }
    for (const code of SUPERSEDED) {
      assert.ok(!converged.includes(code), `收敛开启时旧任务 ${code} 不得再自动排槽`);
    }

    await clearScheduleFixtures();
    process.env.JOB_CONVERGENCE_ENABLED = '0';
    await slots.syncScheduleSlots(new Date('2027-01-16T10:00:00+08:00'));
    const legacy = await scheduledCodesOn('2027-01-16');
    for (const code of CONVERGED) {
      assert.ok(!legacy.includes(code), `回退时新任务 ${code} 不得排程`);
    }
    assert.ok(legacy.includes('bond_safety_refresh'), '回退时必须恢复旧排程（bond_safety_refresh）');
    assert.ok(legacy.includes('convertible_bond_universe_refresh'), '回退时必须恢复旧排程（convertible_bond_universe_refresh）');

    process.env.JOB_CONVERGENCE_ENABLED = '1';
    await clearScheduleFixtures();
    await slots.syncScheduleSlots(new Date('2027-01-15T10:00:00+08:00'));
    const weekday = await scheduledCodesOn('2027-01-15');
    for (const code of ['market_close:A股', 'market_close:可转债', 'market_close:LOF/ETF']) {
      assert.ok(weekday.includes(code), `波次一 ${code} 必须保持原有交易日排程`);
    }
  } finally {
    if (backup === undefined) delete process.env.JOB_CONVERGENCE_ENABLED;
    else process.env.JOB_CONVERGENCE_ENABLED = backup;
    await clearScheduleFixtures();
  }
}

function fakeSuccess(mode, datasets, partitionDate) {
  const diagnostics = {};
  // 严格质量数据集（ipo_history / bond_redemption_events 等）的发布门禁要求 quality_status=passed。
  for (const code of datasets) diagnostics[code] = { partition_row_count: 1, coverage_status: 'complete', quality_status: 'passed', query_status: 'success' };
  return { ok: true, mode, status: 'succeeded', stageComplete: true, dataAsOf: partitionDate, partitionKey: partitionDate, publishDatasetCodes: datasets, datasetDiagnostics: diagnostics };
}

async function clearDatasetFixtures(date) {
  await pool.query(
    `DELETE FROM ops.dataset_partitions
      WHERE partition_key = $1::date AND dataset_code = ANY($2::text[])`,
    [date, ['bond_master', 'bond_daily', 'stock_financial_reports', 'arbitrage_cases', 'stock_cash_dividend_facts',
      'stock_swap_settlements', 'bond_announcement_facts', 'bond_issuance_events', 'bond_redemption_events',
      'ipo_history', 'bond_valuation', 'bond_analysis_snapshot', 'bond_safety_snapshot']],
  );
}

async function failureIsolationChecks() {
  const target = '2027-01-15';
  await clearDatasetFixtures(target);
  try {
    await checkAsync('现金分红失败不阻断换股结算', async () => {
      const calls = [];
      const result = await convergence.runExchangeAnnouncementsSync('test', '2027-01-16', { targetTradeDate: target }, async (code, reason, businessDate, context) => {
        calls.push(`${code}:${context.mode}`);
        if (context.mode === 'cash_dividends') throw new Error('模拟现金分红失败');
        if (code === 'convertible_bond_announcement_history_sync') return fakeSuccess('core', ['bond_announcement_facts', 'bond_issuance_events', 'bond_redemption_events'], target);
        if (code === 'ipo_history_sync') return fakeSuccess('core', ['ipo_history'], target);
        if (context.mode === 'stock_swap_settle') return fakeSuccess('stock_swap_settle', ['stock_swap_settlements'], target);
        return fakeSuccess('core', ['arbitrage_cases'], target);
      });
      assert.ok(calls.includes('arbitrage_sync:cash_dividends'), '现金分红阶段必须执行');
      assert.ok(calls.includes('arbitrage_sync:stock_swap_settle'), '现金分红失败时换股结算仍必须执行');
      assert.ok(calls.indexOf('arbitrage_sync:cash_dividends') < calls.indexOf('arbitrage_sync:stock_swap_settle'), '顺序必须先分红后结算');
      assert.deepStrictEqual(result.failedDatasets, ['stock_cash_dividend_facts']);
      assert.strictEqual(result.ok, false);
      assert.ok(result.stageSummaries.some(item => item.stage === 'stock_swap_settle' && item.status === 'succeeded'));
    });

    await checkAsync('套利案件失败时才跳过换股结算（依赖方向正确）', async () => {
      const calls = [];
      const result = await convergence.runExchangeAnnouncementsSync('test', '2027-01-16', { targetTradeDate: target }, async (code, reason, businessDate, context) => {
        calls.push(`${code}:${context.mode}`);
        if (context.mode === 'core' && code === 'arbitrage_sync') throw new Error('模拟套利案件失败');
        if (code === 'convertible_bond_announcement_history_sync') return fakeSuccess('core', ['bond_announcement_facts', 'bond_issuance_events', 'bond_redemption_events'], target);
        if (code === 'ipo_history_sync') return fakeSuccess('core', ['ipo_history'], target);
        return fakeSuccess(context.mode, ['stock_cash_dividend_facts'], target);
      });
      assert.ok(!calls.includes('arbitrage_sync:stock_swap_settle'), '案件未成功时换股结算必须跳过');
      assert.ok(result.failedDatasets.includes('arbitrage_cases'));
      assert.ok(result.failedDatasets.includes('stock_swap_settlements'));
    });

    await checkAsync('安全评分失败不回滚已发布估值分区', async () => {
      const result = await convergence.runBondAnalyticsRefresh('test', '2027-01-16', { targetTradeDate: target }, async (code) => {
        if (code === 'bond_safety_refresh') throw new Error('模拟安全评分失败');
        return fakeSuccess('core', ['bond_valuation', 'bond_analysis_snapshot'], target);
      });
      assert.deepStrictEqual(result.failedDatasets, ['bond_safety_snapshot']);
      assert.strictEqual(result.ok, false);
      assert.ok(result.stageSummaries.some(item => item.stage === 'bond_valuation' && item.status === 'succeeded'));
      const { rows } = await pool.query(
        `SELECT dataset_code, status FROM ops.dataset_partitions
          WHERE partition_key = $1::date AND dataset_code = ANY($2::text[]) ORDER BY dataset_code`,
        [slots.expectedDataDate('bond_analytics_refresh', '2027-01-16'), ['bond_valuation', 'bond_analysis_snapshot', 'bond_safety_snapshot']],
      );
      assert.deepStrictEqual(rows.map(row => row.dataset_code), ['bond_analysis_snapshot', 'bond_valuation'], '估值分区必须保持已发布');
      assert.ok(rows.every(row => row.status === 'published'));
    });

    await checkAsync('个股分析 CN 失败不回滚 HK/选股轻量归档', async () => {
      const result = await convergence.runStockAnalyticsRefresh('test', '2027-01-16', {}, async (code, reason, businessDate, context) => {
        if (context.mode === 'core') throw new Error('模拟 CN 个股分析失败');
        return { ok: true, mode: context.mode, status: 'succeeded', stageComplete: true, stageCompletedKind: 'archive_light_completed', dataAsOf: '2027-01-15' };
      });
      assert.strictEqual(result.ok, false);
      assert.ok(result.failedDatasets.includes('stock_analysis_snapshot'));
      const selection = result.stageSummaries.find(item => item.stage === 'selection_archive_light');
      assert.ok(selection && selection.status === 'succeeded', '选股轻量归档必须独立完成');
      const hk = result.stageSummaries.find(item => item.stage === 'stock_analysis_hk');
      assert.ok(hk && ['succeeded', 'skipped'].includes(hk.status), 'HK 分析不得因 CN 失败而失败');
    });

    await checkAsync('续跑只重试 pendingStages，已成功子阶段不重复执行', async () => {
      const calls = [];
      const result = await convergence.runExchangeAnnouncementsSync('test', '2027-01-16',
        { targetTradeDate: target, pendingStages: ['cash_dividends'] }, async (code, reason, businessDate, context) => {
          calls.push(`${code}:${context.mode}`);
          return fakeSuccess(context.mode, context.mode === 'cash_dividends' ? ['stock_cash_dividend_facts'] : ['arbitrage_cases'], target);
        });
      assert.deepStrictEqual(calls, ['arbitrage_sync:cash_dividends'], '续跑不得重跑已成功阶段');
      assert.strictEqual(result.ok, true);
      assert.ok(result.stageSummaries.some(item => item.stage === 'arbitrage_cases' && item.reason === 'already_completed'));
    });
  } finally {
    await clearDatasetFixtures(target);
  }
}

// ---------------- LEGACY_JOB_ALIAS_MAP 回归 ----------------
const ALIAS_LEGACY_SLOT = 990001;
const ALIAS_BASE_DATE = '2030-01-09';

async function resetAliasFixtures() {
  await pool.query(
    `DELETE FROM ops.job_schedule_slots WHERE slot_id = ANY($1::bigint[]) OR (job_code = ANY($2::text[]) AND business_date BETWEEN '2030-01-01' AND '2030-02-28')`,
    [[ALIAS_LEGACY_SLOT, ALIAS_LEGACY_SLOT + 1], ['bond_analytics_refresh', 'bond_safety_refresh', 'market_close:A股', 'hk_rate']],
  );
  await pool.query(
    `DELETE FROM ops.dataset_partitions WHERE partition_key BETWEEN '2030-01-01' AND '2030-02-28'
        AND dataset_code = ANY($1::text[])`,
    [['bond_valuation', 'bond_analysis_snapshot', 'bond_safety_snapshot']],
  );
}

async function insertLegacySlot(slotId, jobCode, businessDate, payload) {
  await pool.query(
    `INSERT INTO ops.job_schedule_slots (slot_id, job_code, scheduled_for, business_date, trigger_type, status, request_payload)
     VALUES ($1, $2, ($3::date + time '08:30') AT TIME ZONE 'Asia/Shanghai', $3::date, 'scheduled', 'failed', $4::jsonb)`,
    [slotId, jobCode, businessDate, JSON.stringify(payload || { mode: 'core' })],
  );
}

async function insertSuccessorSlot(slotId, jobCode, businessDate, dataAsOf, status = 'succeeded') {
  await pool.query(
    `INSERT INTO ops.job_schedule_slots (slot_id, job_code, scheduled_for, business_date, trigger_type, status, data_as_of, result_summary)
     VALUES ($1, $2, ($3::date + time '02:30') AT TIME ZONE 'Asia/Shanghai', $3::date, 'scheduled', $4, $5::date, '{}'::jsonb)`,
    [slotId, jobCode, businessDate, status, dataAsOf],
  );
}

function aliasAlert(alertType = 'failure') {
  return {
    alert_id: 1,
    job_code: 'bond_safety_refresh',
    alert_type: alertType,
    scope_type: 'slot',
    scope_key: String(ALIAS_LEGACY_SLOT),
    slot_id: ALIAS_LEGACY_SLOT,
    last_seen_at: '2030-01-09T04:00:00.000Z',
  };
}

async function legacyAliasChecks() {
  check('LEGACY_JOB_ALIAS_MAP 覆盖 9 组映射 + 不变家族', () => {
    assert.strictEqual(recovery.LEGACY_JOB_ALIAS_GROUPS.length, 9);
    const map = recovery.LEGACY_JOB_ALIAS_MAP;
    assert.ok(map['convertible_bond_universe_refresh|core'].successors.some(item => item.jobCode === 'cn_stock_eod_sync'));
    assert.ok(map['company_financial_incremental_sync|selection_inputs:HK'].successors.some(item => item.jobCode === 'hk_stock_eod_sync'));
    assert.ok(map['company_financial_incremental_sync|selection_inputs:CN'].successors.some(item => item.jobCode === 'cn_stock_eod_sync'));
    assert.ok(map['hk_trade_rules_sync|core'].successors.some(item => item.jobCode === 'hk_stock_eod_sync'));
    assert.ok(map['index_recent|core'].successors.some(item => item.jobCode === 'cn_stock_eod_sync'));
    assert.ok(map['arbitrage_sync|core'].successors.some(item => item.jobCode === 'exchange_announcements_sync'));
    assert.ok(map['stock_analysis_refresh|selection_archive_light'].successors.some(item => item.jobCode === 'stock_analytics_refresh'));
    assert.ok(map['storage_retention|core'].successors.some(item => item.jobCode === 'system_retention'));
    for (const code of ['market_close:A股', 'hk_rate', 'nav_snapshot', 'ipo_calendar_refresh', 'holiday_sync']) {
      assert.ok(map[`${code}|*`] && map[`${code}|*`].unchanged, `${code} 必须登记为任务码不变`);
      assert.strictEqual(recovery.legacyJobAlias(code, 'core').unchanged, true, `${code} 不得套用别名归档`);
    }
  });

  await resetAliasFixtures();
  try {
    await checkAsync('同数据集分区已发布且质量通过才允许归档', async () => {
      await insertLegacySlot(ALIAS_LEGACY_SLOT, 'bond_safety_refresh', ALIAS_BASE_DATE);
      const partitionKey = slots.expectedDataDate('bond_analytics_refresh', ALIAS_BASE_DATE);
      for (const code of ['bond_valuation', 'bond_analysis_snapshot', 'bond_safety_snapshot']) {
        await publishDatasetPartition(code, 'CN', {
          partitionKey, dataAsOf: partitionKey, rowCount: 1,
          diagnostics: { quality_status: 'passed', query_status: 'success' },
        });
      }
      const result = await recovery.verifyLegacyAliasEvidence(aliasAlert());
      assert.strictEqual(result.recovered, true);
      assert.strictEqual(result.evidence.mode, 'legacy_alias_dataset_partition');
      assert.strictEqual(result.evidence.successorJobCode, 'bond_analytics_refresh');
      assert.strictEqual(result.evidence.businessDate, ALIAS_BASE_DATE);
      assert.ok(result.evidence.datasets.every(item => item.published));
    });

    await checkAsync('空证据（无分区、无后续成功）拒绝归档', async () => {
      await pool.query('DELETE FROM ops.dataset_partitions WHERE partition_key BETWEEN \'2030-01-01\' AND \'2030-02-28\'');
      const result = await recovery.verifyLegacyAliasEvidence(aliasAlert());
      assert.strictEqual(result.recovered, false);
      assert.strictEqual(result.reason, 'legacy_alias_evidence_insufficient');
    });

    await checkAsync('新任务连续 3 次成功且 data_as_of 达标才允许归档', async () => {
      await insertSuccessorSlot(990101, 'bond_analytics_refresh', '2030-01-10', '2030-01-09');
      await insertSuccessorSlot(990102, 'bond_analytics_refresh', '2030-01-11', '2030-01-10');
      const partial = await recovery.verifyLegacyAliasEvidence(aliasAlert());
      assert.strictEqual(partial.recovered, false, '只有 2 次成功不得归档');

      await insertSuccessorSlot(990103, 'bond_analytics_refresh', '2030-01-12', '2030-01-11');
      const result = await recovery.verifyLegacyAliasEvidence(aliasAlert());
      assert.strictEqual(result.recovered, true);
      assert.strictEqual(result.evidence.mode, 'legacy_alias_three_consecutive_successes');
      assert.strictEqual(result.evidence.requiredCount, 3);
      assert.ok(result.evidence.sequence.every(item => item.dataAsOf && item.expectedDataAsOf && item.dataAsOf >= item.expectedDataAsOf));
    });

    await checkAsync('连续序列最新一条失败即拒绝归档', async () => {
      await pool.query('DELETE FROM ops.job_schedule_slots WHERE slot_id = ANY($1::bigint[])', [[990101, 990102, 990103]]);
      await insertSuccessorSlot(990104, 'bond_analytics_refresh', '2030-01-10', '2030-01-09');
      await insertSuccessorSlot(990105, 'bond_analytics_refresh', '2030-01-11', '2030-01-10');
      await insertSuccessorSlot(990106, 'bond_analytics_refresh', '2030-01-12', null, 'failed');
      const result = await recovery.verifyLegacyAliasEvidence(aliasAlert());
      assert.strictEqual(result.recovered, false);
    });

    await checkAsync('data_as_of 未达标不得归档（不能拿旧数据日期冒充恢复）', async () => {
      await pool.query('DELETE FROM ops.job_schedule_slots WHERE slot_id = ANY($1::bigint[])', [[990104, 990105, 990106]]);
      await insertSuccessorSlot(990107, 'bond_analytics_refresh', '2030-01-10', '2030-01-01');
      await insertSuccessorSlot(990108, 'bond_analytics_refresh', '2030-01-11', '2030-01-02');
      await insertSuccessorSlot(990109, 'bond_analytics_refresh', '2030-01-12', '2030-01-03');
      const result = await recovery.verifyLegacyAliasEvidence(aliasAlert());
      assert.strictEqual(result.recovered, false);
    });

    await checkAsync('跨作用域拒绝：任务码不变家族与数据质量告警不参与别名归档', async () => {
      await pool.query('DELETE FROM ops.job_schedule_slots WHERE slot_id = ANY($1::bigint[])', [[990107, 990108, 990109]]);
      const unchanged = await recovery.verifyLegacyAliasEvidence({ ...aliasAlert(), job_code: 'hk_rate', slot_id: null, scope_type: 'job' });
      assert.strictEqual(unchanged, null, '任务码不变不得套用别名');
      const quality = await verifyAlertScope({ ...aliasAlert('data_quality') });
      assert.strictEqual(quality.recovered, false);
      assert.strictEqual(quality.legacyAlias, undefined, 'data_quality 必须走数据集作用域证据');
    });

    await checkAsync('回退开关开启时不使用新任务证据（旧任务仍在排程）', async () => {
      const backup = process.env.JOB_CONVERGENCE_ENABLED;
      process.env.JOB_CONVERGENCE_ENABLED = '0';
      try {
        const result = await recovery.verifyLegacyAliasEvidence(aliasAlert());
        assert.strictEqual(result, null);
      } finally {
        if (backup === undefined) delete process.env.JOB_CONVERGENCE_ENABLED;
        else process.env.JOB_CONVERGENCE_ENABLED = backup;
      }
    });

    await checkAsync('端到端：slot 作用域历史失败告警经映射证据关闭', async () => {
      await insertSuccessorSlot(990110, 'bond_analytics_refresh', '2030-01-13', '2030-01-12');
      await insertSuccessorSlot(990111, 'bond_analytics_refresh', '2030-01-14', '2030-01-13');
      await insertSuccessorSlot(990112, 'bond_analytics_refresh', '2030-01-15', '2030-01-14');
      const verification = await verifyAlertScope(aliasAlert());
      assert.strictEqual(verification.recovered, true);
      assert.strictEqual(verification.evidence.mode, 'legacy_alias_three_consecutive_successes');
      await pool.query('DELETE FROM ops.job_schedule_slots WHERE slot_id = ANY($1::bigint[])', [[990110, 990111, 990112]]);
    });
  } finally {
    await resetAliasFixtures();
  }
}

// ---------------- 阶段 4 清理脚本回归 ----------------
const PRUNE_TAG = 'PRUNE_' + Date.now().toString(36).toUpperCase();

async function pruneChecks() {
  let strategyId = null;
  const runIds = [];
  try {
    const strategy = await pool.query(
      `INSERT INTO analytics.stock_selection_strategies (strategy_code, market, version, formula_version, content_hash)
       VALUES ($1, 'CN', '1', '1', $1) RETURNING strategy_id`,
      [PRUNE_TAG],
    );
    strategyId = Number(strategy.rows[0].strategy_id);
    const mkRun = async (kind, asOf, selected) => {
      const { rows } = await pool.query(
        `INSERT INTO analytics.stock_selection_runs
           (strategy_id, market, run_kind, as_of_date, knowledge_cutoff, input_hash, selected_count)
         VALUES ($1, 'CN', $2, $3::date, now(), $4, $5) RETURNING run_id`,
        [strategyId, kind, asOf, `${PRUNE_TAG}-${kind}-${asOf}`, selected],
      );
      const runId = Number(rows[0].run_id);
      runIds.push(runId);
      return runId;
    };
    const insertCandidate = (runId, instrumentId) => pool.query(
      `INSERT INTO analytics.stock_selection_candidates (run_id, instrument_id, code, name, filter_status, data_quality_status)
       VALUES ($1, $2, $3, $3, 'passed', 'passed')`,
      [runId, instrumentId, `${PRUNE_TAG}_${instrumentId}`],
    );
    const insertMember = (runId, instrumentId, slotNo) => pool.query(
      `INSERT INTO analytics.stock_selection_portfolio_members
         (run_id, instrument_id, slot_no, weight_in_market_budget, weight_in_equity_target)
       VALUES ($1, $2, $3, 0.03, 0.03)`,
      [runId, instrumentId, slotNo],
    );
    const dailyRun = await mkRun('daily', '2099-01-05', 3);
    for (let index = 1; index <= 5; index += 1) await insertCandidate(dailyRun, 900000 + index);
    for (let index = 1; index <= 3; index += 1) await insertMember(dailyRun, 900000 + index, index);
    const weeklyRun = await mkRun('weekly', '2099-01-06', 1);
    for (let index = 1; index <= 4; index += 1) await insertCandidate(weeklyRun, 900100 + index);
    await insertMember(weeklyRun, 900101, 1);
    const quarterlyRun = await mkRun('quarterly', '2099-03-31', 2);
    for (let index = 1; index <= 2; index += 1) await insertCandidate(quarterlyRun, 900200 + index);
    for (let index = 1; index <= 2; index += 1) await insertMember(quarterlyRun, 900200 + index, index);

    const countCandidates = async () => Number((await pool.query(
      'SELECT COUNT(*)::int AS c FROM analytics.stock_selection_candidates WHERE run_id = ANY($1::bigint[])', [runIds],
    )).rows[0].c);
    const countMembers = async () => Number((await pool.query(
      'SELECT COUNT(*)::int AS c FROM analytics.stock_selection_portfolio_members WHERE run_id = ANY($1::bigint[])', [runIds],
    )).rows[0].c);

    await checkAsync('默认 dry-run 只统计不写库', async () => {
      const before = await countCandidates();
      const code = await prune.main([]);
      assert.strictEqual(code, 0);
      assert.strictEqual(await countCandidates(), before, 'dry-run 不得删除任何行');
    });

    await checkAsync('--execute 只删未入选行，入选行与季度批次全保留', async () => {
      const membersBefore = await countMembers();
      const code = await prune.main(['--execute']);
      assert.strictEqual(code, 0);
      const remaining = await countCandidates();
      // daily 保留 3 行（入选），weekly 保留 1 行，quarterly 2 行不动
      assert.strictEqual(remaining, 6);
      assert.strictEqual(await countMembers(), membersBefore, 'portfolio_members 一行都不能删');
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS broken
           FROM analytics.stock_selection_portfolio_members m
           LEFT JOIN analytics.stock_selection_candidates c
             ON c.run_id = m.run_id AND c.instrument_id = m.instrument_id
          WHERE c.run_id IS NULL AND m.run_id = ANY($1::bigint[])`,
        [runIds],
      );
      assert.strictEqual(rows[0].broken, 0, '入选成员必须仍能 JOIN 到候选行');
      const quarterly = await pool.query(
        'SELECT COUNT(*)::int AS c FROM analytics.stock_selection_candidates WHERE run_id = $1', [quarterlyRun],
      );
      assert.strictEqual(quarterly.rows[0].c, 2, '默认不清理季度批次');
    });

    await checkAsync('NODE_ENV=production 缺少 --allow-production 必须拒绝执行', async () => {
      const backup = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        await assert.rejects(() => prune.main(['--execute']), /allow-production/);
      } finally {
        process.env.NODE_ENV = backup;
      }
    });
  } finally {
    if (runIds.length) {
      await pool.query('DELETE FROM analytics.stock_selection_runs WHERE run_id = ANY($1::bigint[])', [runIds]).catch(() => {});
    }
    if (strategyId) {
      await pool.query('DELETE FROM analytics.stock_selection_strategies WHERE strategy_id = $1', [strategyId]).catch(() => {});
    }
  }
}

async function main() {
  await initSchema();

  console.log('\n[A] 契约与排程定义');
  contractChecks();
  console.log('\n[B] 跨日契约');
  crossDayChecks();
  console.log('\n[C] 收敛开关（真实计划槽）');
  await checkAsync('JOB_CONVERGENCE_ENABLED=1/0 槽位收敛与回滚', scheduleSwitchChecks);
  console.log('\n[D] 失败隔离');
  await failureIsolationChecks();
  console.log('\n[E] LEGACY_JOB_ALIAS_MAP 历史告警映射');
  await legacyAliasChecks();
  console.log('\n[F] 阶段 4 存量候选清理');
  await pruneChecks();

  console.log(`\n${failures.length ? failures.length + ' 项失败' : '全部通过'}`);
  if (failures.length) {
    for (const item of failures) console.error('  - ' + item);
    process.exitCode = 1;
  }
}

main()
  .catch(error => {
    console.error(error && error.stack || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });

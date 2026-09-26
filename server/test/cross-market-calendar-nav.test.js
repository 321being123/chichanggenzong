const assert = require('assert');
const { pool } = require('../db/connection');
const { scheduleForDate } = require('../config/hkexAnnualSchedules');
const marketState = require('../services/marketState');
const { resolveScheduleForDate, isSlotDayAllowed } = require('../services/jobScheduleSlots');
const { normalizeCalendarRows, validateManualCorrection } = require('../jobs/hkTradeCalendarSync');
const { upsertCalendarFacts } = require('../jobs/hkTradeCalendarSync');
const { checkAnnualScheduleReminder } = require('../jobs/hkTradeCalendarSyncJob');
const { shouldRunLegacyNavAfterHkClose } = require('../jobs/marketClose');
const { computeNavAttribution } = require('../services/navAttribution');
const { getJobDefinition } = require('../services/jobDefinitions');

const originalQuery = pool.query;
const realDate = global.Date;
const frozenNow = realDate.parse('2026-09-25T04:00:00.000Z');

function calendarRow(date) {
  const schedule = scheduleForDate(date);
  if (!schedule) return null;
  return {
    trade_date: date,
    is_open: schedule.isOpen,
    source_code: 'hkex_official_schedule',
    raw_payload: {
      official_schedule: {
        is_open: schedule.isOpen,
        session_type: schedule.sessionType,
        close_time: schedule.closeTime,
        source: 'hkex_official_schedule',
      },
    },
  };
}

function installCalendarQuery() {
  pool.query = async (sql, params = []) => {
    if (sql.includes("FROM market.trade_calendar") && sql.includes("exchange='HKEX'")) {
      const dates = Array.isArray(params[0]) ? params[0] : [params[0]];
      return { rows: dates.map(value => calendarRow(String(value).slice(0, 10))).filter(Boolean) };
    }
    throw new Error(`unexpected query: ${sql}`);
  };
}

async function main() {
  try {
    assert.strictEqual(getJobDefinition('hk_rate').freshnessGate, false,
      '收盘汇率任务不得被24小时缓存新鲜度短路');
    assert.strictEqual(getJobDefinition('nav_snapshot').freshnessGate, false,
      '净值快照不得被全账户最大日期水位短路');
    installCalendarQuery();

    const fullDay = marketState.deriveMarketState({ market: 'HK', status: 'open', sessionType: 'full_day', closeTime: '16:10' }, '16:10');
    const halfDay1205 = marketState.deriveMarketState({ market: 'HK', status: 'open', sessionType: 'half_day', closeTime: '12:10' }, '12:05');
    const halfDay1211 = marketState.deriveMarketState({ market: 'HK', status: 'open', sessionType: 'half_day', closeTime: '12:10' }, '12:11');
    assert.strictEqual(halfDay1205.isTradingNow, true, '半日盘 12:05 收市竞价期间仍属交易时段');
    assert.strictEqual(halfDay1211.isTradingNow, false, '半日盘 12:11 已收市');
    assert.strictEqual(halfDay1211.closeQuoteTime, '12:30', '半日盘收盘采集须在 12:30');
    assert.strictEqual(fullDay.isTradingNow, false, '全日盘 16:10 后已收市');
    assert.strictEqual(fullDay.closeQuoteTime, '16:30', '全日盘收盘采集须在 16:30');

    const cnHoliday = await marketState.getMarketState({ market: 'CN', businessDate: '2026-09-25', time: '10:00' });
    marketState.invalidateMarketStateCache({ market: 'HK', businessDate: '2026-09-25' });
    const hkOpen = await marketState.getMarketState({ market: 'HK', businessDate: '2026-09-25', time: '10:00' });
    assert.strictEqual(cnHoliday.status, 'closed', '2026-09-25 A 股休市');
    assert.strictEqual(hkOpen.status, 'open', '2026-09-25 港股按 HKEX 日历开市');
    marketState.invalidateMarketStateCache({ market: 'HK', businessDate: '2027-01-04' });
    const unknownHk = await marketState.getMarketState({ market: 'HK', businessDate: '2027-01-04', time: '10:00' });
    assert.strictEqual(unknownHk.status, 'unknown', '未录入并核验的未来港股日期必须保持未知');
    assert.strictEqual(marketState.isPotentialHkTradingTime('2027-01-04', '10:00'), true,
      '日历未知时仅允许手动入口判断潜在交易时段');

    for (const [date, expectedHK, expectedCN] of [
      ['2026-07-01', 'closed', 'open'],
      ['2026-10-01', 'closed', 'closed'],
    ]) {
      marketState.invalidateMarketStateCache({ market: 'HK', businessDate: date });
      assert.strictEqual((await marketState.getMarketState({ market: 'HK', businessDate: date, time: '10:00' })).status, expectedHK, `${date} 港股状态错误`);
      assert.strictEqual((await marketState.getMarketState({ market: 'CN', businessDate: date, time: '10:00' })).status, expectedCN, `${date} A 股状态错误`);
    }

    for (const jobCode of ['hk_ipo_preopen', 'hk_ipo_postclose', 'hk_ipo_enrichment']) {
      const definition = getJobDefinition(jobCode);
      assert.strictEqual(definition.marketCalendarPolicy, 'hk-open', `${jobCode} 必须按港交所开市状态排程`);
      assert.strictEqual(definition.weekdays, false, `${jobCode} 不得依赖 A 股交易日历`);
      assert.strictEqual(definition.calendarWeekdays, true, `${jobCode} 先按周一至周五生成候选日`);
      assert.strictEqual(isSlotDayAllowed('2026-09-25', definition), true, 'A 股休市但港股开市时仍须生成港股候选槽位');
      marketState.invalidateMarketStateCache({ market: 'HK', businessDate: '2026-09-25' });
      assert.ok(await resolveScheduleForDate(definition, definition, '2026-09-25'), `${jobCode} 应在港股独立开市日生成任务`);
      marketState.invalidateMarketStateCache({ market: 'HK', businessDate: '2026-10-01' });
      assert.strictEqual(await resolveScheduleForDate(definition, definition, '2026-10-01'), null, `${jobCode} 港股休市日不得生成任务`);
      marketState.invalidateMarketStateCache({ market: 'HK', businessDate: '2027-01-04' });
      assert.strictEqual(await resolveScheduleForDate(definition, definition, '2027-01-04'), null, `${jobCode} 港股日历未知时不得猜测开市`);
    }

    const scheduleCases = [
      ['market_close:港股', { marketCalendarPolicy: 'hk-close', hour: 16, minute: 30 }, '2026-12-24', [12, 30]],
      ['market_close:港股', { marketCalendarPolicy: 'hk-close', hour: 16, minute: 30 }, '2026-09-25', [16, 30]],
      ['hk_rate', { marketCalendarPolicy: 'hk-rate', hour: 16, minute: 15 }, '2026-09-25', [16, 35]],
      ['nav_snapshot', { marketCalendarPolicy: 'nav-snapshot', hour: 16, minute: 20 }, '2026-12-24', [15, 20]],
      ['nav_snapshot', { marketCalendarPolicy: 'nav-snapshot', hour: 16, minute: 20 }, '2026-07-01', [16, 20]],
      ['nav_snapshot', { marketCalendarPolicy: 'nav-snapshot', hour: 16, minute: 20 }, '2026-09-25', [16, 40]],
    ];
    for (const [jobCode, definition, date, [hour, minute]] of scheduleCases) {
      marketState.invalidateMarketStateCache({ market: 'HK', businessDate: date });
      const resolved = await resolveScheduleForDate({ jobCode, ...definition }, definition, date);
      assert.ok(resolved, `${jobCode} ${date} 应生成槽位`);
      assert.deepStrictEqual([resolved.hour, resolved.minute], [hour, minute], `${jobCode} ${date} 槽位时刻错误`);
    }
    marketState.invalidateMarketStateCache({ market: 'HK', businessDate: '2026-10-01' });
    assert.strictEqual(await resolveScheduleForDate({ marketCalendarPolicy: 'hk-close' }, { hour: 16, minute: 30 }, '2026-10-01'), null,
      '港股休市日不生成港股收盘槽位');
    assert.strictEqual(await resolveScheduleForDate({ marketCalendarPolicy: 'hk-rate' }, { hour: 16, minute: 15 }, '2026-10-01'), null,
      '两市休市日不生成港币汇率收盘槽位');
    assert.strictEqual(shouldRunLegacyNavAfterHkClose('open', '16:30'), true,
      '旧调度模式两市同开市时应在港股全日收盘后生成净值');
    assert.strictEqual(shouldRunLegacyNavAfterHkClose('open', '12:30'), false,
      '旧调度模式港股半日且 A 股开市时应等 A 股收盘');
    assert.strictEqual(shouldRunLegacyNavAfterHkClose('closed', '12:30'), true,
      '旧调度模式 A 股休市、港股半日时应在港股收盘后生成净值');
    assert.strictEqual(shouldRunLegacyNavAfterHkClose('unknown', '16:30'), false,
      '旧调度模式不能用未知 A 股状态推断净值已就绪');

    assert.deepStrictEqual(normalizeCalendarRows([{ cal_date: '20260928', is_open: '1', pretrade_date: '20260925' }])[0], {
      tradeDate: '2026-09-28', preTradeDate: '2026-09-25', isOpen: true,
      rawPayload: { cal_date: '20260928', is_open: '1', pretrade_date: '20260925' },
    }, '港股日历同步应保留上游 pretrade_date');
    assert.deepStrictEqual(normalizeCalendarRows([
      { cal_date: '20260929', is_open: null },
      { cal_date: '20260230', is_open: '1' },
    ]), [], '缺失开市状态或无效日期不能被转换成休市事实');

    const priorQuery = pool.query;
    let capturedInsert = null;
    pool.query = async (sql, params = []) => {
      if (sql.includes('SELECT trade_date::text AS trade_date')) return { rows: [{
        trade_date: '2026-09-28', is_open: true, source_code: 'tushare_hk_tradecal',
        raw_payload: { legacy_source: { retained: true } },
      }] };
      if (sql.includes('INSERT INTO market.trade_calendar')) { capturedInsert = params; return { rows: [] }; }
      throw new Error(`unexpected upsert query: ${sql}`);
    };
    const officialSchedule = scheduleForDate('2026-09-28');
    const savedCalendar = await upsertCalendarFacts({
      tushareRows: [{ tradeDate: '2026-09-28', isOpen: false, rawPayload: { cal_date: '20260928', is_open: '0', pretrade_date: '20260925' } }],
      officialRows: [{
        tradeDate: '2026-09-28',
        schedule: {
          isOpen: officialSchedule.isOpen,
          sessionType: officialSchedule.sessionType,
          closeTime: officialSchedule.closeTime,
          holidayName: officialSchedule.holidayName,
          evidence: { ...officialSchedule.evidence, source: 'hkex_official_schedule' },
        },
      }],
    });
    pool.query = priorQuery;
    assert.strictEqual(savedCalendar.rows, 1, '已变更日历事实应写入同一日历表');
    assert.strictEqual(savedCalendar.conflicts.length, 1, 'Tushare 与官方开市状态冲突必须显式报告');
    assert.ok(capturedInsert, '日历事实应通过 UPSERT 保存');
    assert.strictEqual(capturedInsert[1], true, '冲突时官方安排优先于 Tushare 状态');
    assert.strictEqual(capturedInsert[2], 'hkex_official_schedule', '官方证据应保留来源优先级');
    const storedPayload = JSON.parse(capturedInsert[3]);
    assert.strictEqual(storedPayload.legacy_source.retained, true, '既有其他原始载荷必须保留');
    assert.strictEqual(storedPayload.tushare.pretrade_date, '20260925', 'Tushare 载荷应写入独立命名空间');
    assert.strictEqual(storedPayload.official_schedule.quality_status, 'conflict', '来源冲突应留在官方日历质量信息');
    pool.query = priorQuery;

    const notices = [];
    const reminderQuery = async (sql) => sql.includes('UPDATE ops.alert_notifications')
      ? { rows: [] }
      : { rows: [{ covered_days: 365, verified_days: 365 }] };
    assert.strictEqual((await checkAnnualScheduleReminder('2026-10-31', { query: reminderQuery, notify: alert => notices.push(alert), enabled: true })).status,
      'not_due', '年度日历待办应从 11 月 1 日开始检查');
    const reminder1 = await checkAnnualScheduleReminder('2026-11-01', { query: reminderQuery, notify: alert => notices.push(alert), enabled: true });
    const reminder2 = await checkAnnualScheduleReminder('2026-11-02', { query: reminderQuery, notify: alert => notices.push(alert), enabled: true });
    assert.strictEqual(reminder1.status, 'pending', '未登记核验的次年计划即使无行缺口也不得自动通过');
    assert.strictEqual(reminder1.noticePublished, false, '未核验的次年通告不得标记已发布');
    assert.strictEqual(notices[0].alertKey, notices[1].alertKey, '年度待办应按 HKEX 和目标年份使用同一去重键');
    assert.strictEqual(reminder2.targetYear, 2027, '年度待办应指向次年');
    assert.throws(() => validateManualCorrection({ date: '2026-09-25', status: 'open', sessionType: 'full_day', closeTime: '16:10', evidenceUrl: 'http://example.com/notice', reason: '临时安排已确认' }),
      /港交所官网/, '人工日历修正必须使用 HTTPS 港交所公告证据');
    assert.strictEqual(validateManualCorrection({ date: '2026-09-25', status: 'open', sessionType: 'full_day', closeTime: '16:10', evidenceUrl: 'https://www.hkex.com.hk/notice', reason: '港交所临时安排已核验' }).isOpen,
      true, '有效港交所人工修正应通过校验');

    const originalNow = realDate.now;
    global.Date = class FrozenDate extends realDate {
      constructor(...args) { super(...(args.length ? args : [frozenNow])); }
      static now() { return frozenNow; }
    };
    Date.now = () => frozenNow;
    marketState.invalidateMarketStateCache({ market: 'HK', businessDate: '2026-09-25' });
    pool.query = async (sql, params = []) => {
      if (sql.includes("FROM market.trade_calendar") && sql.includes("exchange='HKEX'")) {
        return { rows: [calendarRow('2026-09-25')] };
      }
      if (sql.includes('FROM daily_prices')) {
        const cutoff = String(params[3]).slice(0, 10);
        return { rows: cutoff < '2026-09-25'
          ? [{ date: '2026-09-24', code: '600000', price: 10 }, { date: '2026-09-24', code: '00700', price: 20 }]
          : [{ date: '2026-09-24', code: '600000', price: 10 }, { date: '2026-09-25', code: '00700', price: 22 }] };
      }
      if (sql.includes('FROM market.fx_rates')) return { rows: [] };
      throw new Error(`unexpected attribution query: ${sql}`);
    };
    const data = {
      cashBase: 1000,
      cashFlows: [],
      trades: [],
      hkRate: 0.91,
      positions: [
        { code: '600000', name: 'A 股样例', subtype: '沪市', price: 10, quantity: 100 },
        { code: '00700', name: '港股样例', subtype: '港股', price: 22, quantity: 100 },
      ],
      navHistory: [
        { date: '2026-09-24', totalAsset: 3800, hkRate: 0.90, snapshotSource: 'legacy', snapshot_at: '2026-09-24T08:00:00.000Z' },
        { date: '2026-09-25', totalAsset: 3800, hkRate: 0.90, snapshotSource: 'legacy', snapshot_at: '2026-09-25T08:00:00.000Z' },
      ],
    };
    const attribution = await computeNavAttribution('fixture-user', 'fixture-account', data, 4002);
    assert.strictEqual(attribution.complete, true, '港股单独开市时归因必须完整');
    assert.strictEqual(Math.round(attribution.previousTotalAsset), 3800, '期初总资产必须是 3800');
    assert.strictEqual(Math.round(attribution.totalChange), 202, '总资产变化应为 202 元');
    assert.strictEqual(Math.round(attribution.priceImpact), 180, '港股价格影响应为 180 元');
    assert.strictEqual(Math.round(attribution.fxImpact), 22, '港币汇率影响应为 22 元');
    assert.ok(Math.abs(attribution.snapshotDrift) < 0.01, '价格与汇率归因应闭合');

    const nextDayNow = realDate.parse('2026-09-28T04:00:00.000Z');
    global.Date = class NextTradingDate extends realDate {
      constructor(...args) { super(...(args.length ? args : [nextDayNow])); }
      static now() { return nextDayNow; }
    };
    Date.now = () => nextDayNow;
    for (const date of ['2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28']) {
      marketState.invalidateMarketStateCache({ market: 'HK', businessDate: date });
    }
    pool.query = async (sql, params = []) => {
      if (sql.includes("FROM market.trade_calendar") && sql.includes("exchange='HKEX'")) {
        const dates = Array.isArray(params[0]) ? params[0] : [params[0]];
        return { rows: dates.map(value => calendarRow(String(value).slice(0, 10))).filter(Boolean) };
      }
      throw new Error(`unexpected intermediate-gap query: ${sql}`);
    };
    const gapData = {
      ...data,
      navHistory: [
        { date: '2026-09-23', totalAsset: 3700, hkRate: 0.90, snapshotSource: 'legacy', snapshot_at: '2026-09-23T08:00:00.000Z' },
        { date: '2026-09-24', totalAsset: 3800, hkRate: 0.90, snapshotSource: 'legacy', snapshot_at: '2026-09-24T08:00:00.000Z' },
      ],
    };
    const gapAttribution = await computeNavAttribution('fixture-user', 'fixture-account', gapData, 4002);
    assert.strictEqual(gapAttribution.complete, false, '跨过港股开市日但缺快照时归因必须不完整');
    assert.strictEqual(gapAttribution.reason, 'missing_intermediate_snapshot', '缺口原因必须明确标记为中间净值快照缺失');
    assert.strictEqual(gapAttribution.missingMarketDate, '2026-09-25', '必须报告具体缺失的港股交易日');
    assert.strictEqual(gapAttribution.missingMarket, 'HK', '必须报告缺口所属市场');

    console.log('cross-market calendar and NAV regression tests passed');
    global.Date = realDate;
    Date.now = originalNow;
  } finally {
    global.Date = realDate;
    pool.query = originalQuery;
    marketState.invalidateMarketStateCache();
    await pool.end();
  }
}

main().catch(error => { console.error(error); process.exit(1); });

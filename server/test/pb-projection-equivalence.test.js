// PB 两步按月投影与原始 daily_valuations 的 15 项全字段零差异门禁（2026-11-27）。
//
// 覆盖方案第 9 章 8 类边界：
//   ① 跨年/闰年/年初年末；② 新股年中/月中上市；③ 头尾非完整月精确边界；
//   ④ 同日多来源（lixinger vs tushare）；⑤ ops.data_sources 变更后全量重算；
//   ⑥ 手工删除某日估值后重算；⑦ 交易日历/停牌/上市日纠错/证券合并；
//   ⑧ 仅有 pb IS NULL 行的 marketDays 对齐。
// 另含必红反例：asOfDate 为月中且同月后续有更极端 PB，尾月必须严格读 picked。
//
// 运行：npm.cmd run test:file -- server/test/pb-projection-equivalence.test.js
'use strict';

const assert = require('assert');
const { pool } = require('../db/connection');
const { initSchema } = require('../db/migrations');
const repo = require('../repositories/stockSelectionRepository');
const pbRepo = require('../repositories/pbProjectionRepository');
const sync = require('../services/pbProjectionSync');

const MARKET = 'CN';
const TEST_TAG = 'PB_EQ_' + Date.now().toString(36).toUpperCase();
const CODE_BASE = 930000 + (Number(process.env.TEST_RUN_ID ? process.pid : Date.now()) % 60000);
const CODES = Array.from({ length: 9 }, (_, index) => String(CODE_BASE + index) + '.SH');
const WINDOW_START = '2019-06-15';
const AS_OF = '2026-06-20';
const CAL_FROM = '2019-01-01';
const CAL_TO = '2026-12-31';
const TEST_SOURCE_ID = -30000;
const TEST_SOURCE_CODE = 'lixinger_pb_eq_probe';

let ids = {};
let sourceIds = {};

function dateOf(text) {
  return String(text).slice(0, 10);
}

async function cleanup() {
  const { rows } = await pool.query('SELECT instrument_id FROM core.instruments WHERE canonical_code = ANY($1)', [CODES]);
  const instrumentIds = rows.map(row => Number(row.instrument_id));
  if (instrumentIds.length) {
    await pool.query('DELETE FROM analytics.stock_daily_pb_picked WHERE instrument_id = ANY($1::bigint[])', [instrumentIds]);
    await pool.query('DELETE FROM analytics.instrument_pb_monthly_summary WHERE instrument_id = ANY($1::bigint[])', [instrumentIds]);
    await pool.query('DELETE FROM market.stock_suspend_calendar WHERE instrument_id = ANY($1::bigint[])', [instrumentIds]);
    await pool.query('DELETE FROM market.daily_valuations WHERE instrument_id = ANY($1::bigint[])', [instrumentIds]);
    await pool.query('DELETE FROM market.daily_bars WHERE instrument_id = ANY($1::bigint[])', [instrumentIds]);
    await pool.query('DELETE FROM core.company_instruments WHERE instrument_id = ANY($1::bigint[])', [instrumentIds]);
    await pool.query('DELETE FROM core.instruments WHERE instrument_id = ANY($1::bigint[])', [instrumentIds]);
  }
  // 测试来源只用于选源规则变更；先删估值行与投影行再删来源（旧投影表可能保留 source_id 外键）。
  await pool.query('DELETE FROM market.daily_valuations WHERE source_id = $1', [TEST_SOURCE_ID]);
  await pool.query('DELETE FROM analytics.stock_daily_pb_picked WHERE source_id = $1', [TEST_SOURCE_ID]);
  await pool.query('DELETE FROM ops.data_sources WHERE source_id = $1', [TEST_SOURCE_ID]);
  // 测试投影与测试日历行可重算，不保留污染。
  await pool.query("DELETE FROM analytics.market_pb_trade_dates WHERE market = 'CN' AND trade_date BETWEEN $1::date AND $2::date", [CAL_FROM, CAL_TO]);
  await pool.query("DELETE FROM market.trade_calendar WHERE source_code = 'pb_eq_test'");
  await pool.query("DELETE FROM ops.sync_cursors WHERE scope_key LIKE 'pb_projection:%'");
}

async function insertInstrument(code, listDate) {
  const { rows } = await pool.query(`
    INSERT INTO core.instruments (canonical_code, name, asset_class, market, exchange_code, currency_code, list_date, status)
    VALUES ($1, $2, 'stock', 'CN', 'SSE', 'CNY', $3::date, 'listed')
    RETURNING instrument_id`, [code, TEST_TAG + code, listDate]);
  return Number(rows[0].instrument_id);
}

async function insertValuation(instrumentId, tradeDate, pb, sourceId = sourceIds.lixinger) {
  await pool.query(`
    INSERT INTO market.daily_valuations (instrument_id, trade_date, source_id, pb, pe_ttm, total_market_cap, currency_code)
    VALUES ($1, $2::date, $3, $4, 10, 1e10, 'CNY')
    ON CONFLICT (instrument_id, trade_date, source_id) DO UPDATE SET pb = EXCLUDED.pb`,
  [instrumentId, tradeDate, sourceId, pb]);
}

async function seedCalendar() {
  // 保留真实日历已有的休市判断，只补缺失日期；测试产生的行统一 source_code 便于清理。
  await pool.query(`
    INSERT INTO market.trade_calendar (exchange, trade_date, is_open, source_code)
    SELECT 'SSE', d::date, EXTRACT(ISODOW FROM d) < 6, 'pb_eq_test'
      FROM generate_series($1::date, $2::date, interval '1 day') d
    ON CONFLICT (exchange, trade_date) DO NOTHING`, [CAL_FROM, CAL_TO]);
}

function monthsBetween(fromDate, toDate) {
  return pbRepo.monthsBetween(fromDate, toDate);
}

async function rebuildAllTestMonths(fromDate = CAL_FROM, toDate = CAL_TO) {
  await pbRepo.rebuildProjectionRange({
    market: MARKET,
    fromDate,
    toDate,
    months: monthsBetween(fromDate, toDate),
    instrumentIds: Object.values(ids).filter(Boolean),
  });
}

async function readBoth(options) {
  const previous = process.env.PB_PROJECTION_READ_ENABLED;
  try {
    process.env.PB_PROJECTION_READ_ENABLED = '1';
    const projected = await repo.loadPbWindow(options);
    process.env.PB_PROJECTION_READ_ENABLED = '0';
    const legacy = await repo.loadPbWindow(options);
    return { projected, legacy };
  } finally {
    if (previous === undefined) delete process.env.PB_PROJECTION_READ_ENABLED;
    else process.env.PB_PROJECTION_READ_ENABLED = previous;
  }
}

function fieldValue(item, field) {
  if (!item) return null;
  switch (field) {
    case 'listed_days': return Number(item.expectedDays || 0) + Number(item.exemptDays || 0);
    case 'expected_days': return item.expectedDays;
    case 'exempt_days': return item.exemptDays;
    case 'covered_days': return item.coveredDays;
    case 'observed_days': return item.observedDays;
    case 'non_positive_days': return item.nonPositiveDays;
    case 'invalid_days': return item.invalidDays;
    case 'max_pb': return item.maxPb;
    case 'max_positive_pb': return item.maxPbRaw;
    case 'min_positive_pb': return item.minPbRaw;
    case 'min_pb_date': return item.minPbDate || null;
    case 'max_pb_date': return item.maxPbDate || null;
    case 'effective_start': return item.effectiveStart || null;
    case 'series_digest': return item.pbSeriesDigest || null;
    case 'series_rows': return item.pbSeriesRows;
    default: throw new Error('未知字段 ' + field);
  }
}

const FIELDS = [
  'listed_days', 'expected_days', 'exempt_days', 'covered_days', 'observed_days',
  'non_positive_days', 'invalid_days', 'max_pb', 'max_positive_pb', 'min_positive_pb',
  'min_pb_date', 'max_pb_date', 'effective_start', 'series_digest', 'series_rows',
];

function assertItemEqual(projected, legacy, label) {
  assert.ok(projected, label + '：投影缺少该证券');
  assert.ok(legacy, label + '：原查询缺少该证券');
  for (const field of FIELDS) {
    const left = fieldValue(projected, field);
    const right = fieldValue(legacy, field);
    assert.deepStrictEqual(left, right, `${label} 字段 ${field} 不一致：投影=${String(left)} 原查询=${String(right)}`);
  }
}

async function assertWindowEquivalent(options, label) {
  const { projected, legacy } = await readBoth(options);
  const projectedKeys = new Set(projected.byInstrument.keys());
  const legacyKeys = new Set(legacy.byInstrument.keys());
  assert.deepStrictEqual([...projectedKeys].sort(), [...legacyKeys].sort(), label + '：证券集合不一致');
  for (const key of legacyKeys) {
    assertItemEqual(projected.byInstrument.get(key), legacy.byInstrument.get(key), `${label}[${key}]`);
  }
  assert.strictEqual(projected.calendarDays, legacy.calendarDays, label + '：calendarDays 不一致');
  assert.strictEqual(projected.marketDays, legacy.marketDays, label + '：marketDays 不一致');
  return { projected, legacy };
}

async function main() {
  await initSchema();
  await cleanup();
  await seedCalendar();

  const sources = await pool.query("SELECT source_id, source_code FROM ops.data_sources WHERE source_code IN ('lixinger_official','tushare')");
  for (const row of sources.rows) sourceIds[row.source_code === 'lixinger_official' ? 'lixinger' : 'tushare'] = Number(row.source_id);
  assert.ok(sourceIds.lixinger && sourceIds.tushare, '测试库必须已登记 lixinger_official 与 tushare');

  // 证券夹具：
  // A 覆盖跨年/闰年/多来源/负 PB/NaN；B 新股年中上市；C 停牌豁免；
  // D 年末上市；E 只有 pb IS NULL 行；F/G 用于证券合并。
  ids.A = await insertInstrument(CODES[0], '2019-01-01');
  ids.B = await insertInstrument(CODES[1], '2024-02-15');
  ids.C = await insertInstrument(CODES[2], '2020-01-01');
  ids.D = await insertInstrument(CODES[3], '2025-12-31');
  ids.E = await insertInstrument(CODES[4], '2020-01-01');
  ids.F = await insertInstrument(CODES[5], '2020-01-01');
  ids.G = await insertInstrument(CODES[6], '2020-01-01');

  // 交易日历上的锚点：用真实工作日，减少与真实日历的冲突。
  const A_DATES = [
    '2019-06-10', '2019-12-31', '2020-01-02', '2020-02-28', '2020-02-29', // 跨年/闰年
    '2024-02-29', '2024-03-15', '2024-04-15', '2024-04-16', // 闰日/多来源/负值/NaN
    '2025-05-06', '2025-06-10', '2025-06-20', // 尾月未来泄漏反例
    '2026-01-05', '2026-06-19',
  ];
  for (const [index, date] of A_DATES.entries()) {
    await insertValuation(ids.A, date, 1.2 + index * 0.05);
  }
  // 尾月防泄漏反例的确定值：06-10 之前最大 1.45，06-20 隐藏 5.0。
  await insertValuation(ids.A, '2025-05-06', 1.1);
  await insertValuation(ids.A, '2025-06-10', 1.45);
  await insertValuation(ids.A, '2025-06-20', 5.0);
  // 同日多来源：tushare 先写，lixinger 后写；投影必须取 lixinger。
  await insertValuation(ids.A, '2024-03-15', 1.10, sourceIds.tushare);
  await insertValuation(ids.A, '2024-03-15', 1.25, sourceIds.lixinger);
  // 负 PB 与 NaN：都是真实观测，NaN 只归 invalid，不当缺失。
  await insertValuation(ids.A, '2024-04-15', -0.5);
  await insertValuation(ids.A, '2024-04-16', 'NaN');

  for (const date of ['2024-02-15', '2024-02-16', '2024-03-15', '2024-04-15', '2024-05-06', '2025-12-31']) {
    await insertValuation(ids.B, date, 0.9);
  }
  for (const date of ['2024-03-18', '2024-03-19', '2024-04-10']) {
    await insertValuation(ids.C, date, 1.4);
  }
  await pool.query(`
    INSERT INTO market.stock_suspend_calendar (instrument_id, trade_date, suspend_type, source_id)
    VALUES ($1, '2024-03-18'::date, 'S', $2)
    ON CONFLICT (instrument_id, trade_date, source_id) DO NOTHING`, [ids.C, sourceIds.tushare]);
  await insertValuation(ids.D, '2025-12-31', 2.1);
  // E 只有 pb NULL 行：marketDays 必须把它算作市场估值日（原口径不滤 pb）。
  await pool.query(`
    INSERT INTO market.daily_valuations (instrument_id, trade_date, source_id, pb, total_market_cap, currency_code)
    VALUES ($1, '2024-05-15'::date, $2, NULL, 1e9, 'CNY'),
           ($1, '2024-05-16'::date, $2, NULL, 1e9, 'CNY')`,
  [ids.E, sourceIds.tushare]);
  for (const date of ['2024-05-06', '2024-05-07', '2024-05-08']) await insertValuation(ids.F, date, 1.5);
  for (const date of ['2024-05-09', '2024-05-10']) await insertValuation(ids.G, date, 1.6);

  // P0-2 反例：尚未回填（无月汇总/无投影水位）时对账必须跳过，绝不能在凌晨任务里自动全库重建。
  {
    const uninitialized = await sync.reconcilePbProjectionSample({
      markets: [MARKET], force: true,
      instrumentIds: Object.values(ids).filter(Boolean),
      latestMonth: { year: 2026, month: 5 }, monthList: [{ year: 2026, month: 5 }],
    });
    assert.strictEqual(uninitialized.markets[MARKET].skipped, 'projection_not_initialized',
      '未回填投影对账必须返回 projection_not_initialized');
    assert.strictEqual(uninitialized.repairedMonths, 0, '未回填时不得自动修复任何月份');
  }

  await rebuildAllTestMonths();
  // 模拟一次完整回填：写入市场投影水位，供对账初始化判定使用。
  await pbRepo.writeSyncCursor({
    scopeKey: `pb_projection:${MARKET}`, datasetCode: 'pb_projection', lastSuccessDate: AS_OF,
  });
  const testIds = Object.values(ids).filter(Boolean);

  // ①–④、⑦ 的基准：跨年/闰年/新股/头尾非完整月/多来源/负值/NaN 一次全窗口比对。
  await assertWindowEquivalent({
    market: MARKET, windowStart: WINDOW_START, asOfDate: AS_OF, instrumentIds: testIds,
  }, '全窗口');

  // ② 新股月中上市：B 在 2024-02 的 listed_days 必须从 list_date 之后起算（与 legacy 一致）。
  {
    const { projected } = await readBoth({ market: MARKET, windowStart: '2024-02-01', asOfDate: '2024-02-29', instrumentIds: [ids.B] });
    const item = projected.byInstrument.get(String(ids.B));
    assert.ok(item.expectedDays > 0 && item.expectedDays < 15, '新股 2 月中上市必须截断 listed_days');
  }

  // ⑧ marketDays：全市场窗口含 E 的 pb NULL 行，投影必须与原口径一致。
  {
    const { projected, legacy } = await readBoth({ market: MARKET, windowStart: '2024-05-14', asOfDate: '2024-05-16' });
    assert.strictEqual(legacy.marketDays, 2, '原口径必须把仅有 pb NULL 的日期算作市场估值日');
    assert.strictEqual(projected.marketDays, legacy.marketDays, '投影 marketDays 必须包含 pb NULL 日期');
    assert.strictEqual(projected.calendarDays, legacy.calendarDays);
  }

  // 必红反例：asOfDate=2025-06-15，同月 06-20 有更极端 PB=5.0，尾月不得泄漏。
  {
    const { projected, legacy } = await assertWindowEquivalent({
      market: MARKET, windowStart: '2025-05-01', asOfDate: '2025-06-15', instrumentIds: [ids.A],
    }, '尾月防泄漏');
    const item = projected.byInstrument.get(String(ids.A));
    assert.strictEqual(Number(item.maxPbRaw), 1.45, 'asOfDate 之前的最大 PB 应是 1.45，不得读到 06-20 的 5.0');
    assert.strictEqual(item.maxPbDate, '2025-06-10', '极值日期必须是 asOfDate 之前的 06-10');
    const later = await readBoth({ market: MARKET, windowStart: '2025-05-01', asOfDate: '2025-06-30', instrumentIds: [ids.A] });
    const laterItem = later.projected.byInstrument.get(String(ids.A));
    assert.strictEqual(Number(laterItem.maxPbRaw), 5.0, '窗口延到月末后必须能读到 06-20 的极端值');
    void legacy;
  }

  // ⑤ ops.data_sources 变更：新增一个 source_id 更小的 lixinger 来源，选源胜出行必须切换。
  {
    await pool.query(`
      INSERT INTO ops.data_sources (source_id, source_code, source_name, source_type, priority)
      VALUES ($1, $2, 'PB等价测试来源', 'official', 10)`, [TEST_SOURCE_ID, TEST_SOURCE_CODE]);
    await insertValuation(ids.A, '2024-03-15', 9.9, TEST_SOURCE_ID);
    const before = await sync.readSourceFingerprintState(MARKET);
    assert.strictEqual(before.changed, true, '新增数据源后指纹必须变化');
    // 只回填受影响月份，验证 fullRebuild 按月入口；不扩大到十年。
    await sync.fullRebuild({ market: MARKET, fromDate: '2024-03-01', toDate: '2024-03-31', sleepMs: 0 });
    const { projected } = await assertWindowEquivalent({
      market: MARKET, windowStart: '2024-03-01', asOfDate: '2024-03-31', instrumentIds: [ids.A],
    }, '数据源变更');
    const item = projected.byInstrument.get(String(ids.A));
    assert.strictEqual(Number(item.maxPbRaw), 9.9, '低 source_id 的 lixinger 来源应胜出');
    await pool.query('DELETE FROM market.daily_valuations WHERE instrument_id = $1 AND trade_date = $2::date AND source_id = $3', [ids.A, '2024-03-15', TEST_SOURCE_ID]);
    await sync.fullRebuild({ market: MARKET, fromDate: '2024-03-01', toDate: '2024-03-31', sleepMs: 0 });
    await pool.query('DELETE FROM ops.data_sources WHERE source_id = $1', [TEST_SOURCE_ID]);
  }

  // ⑥ 手工删除某日估值：删除 lixinger 行后，picked 必须回退到 tushare 行。
  {
    await pool.query('DELETE FROM market.daily_valuations WHERE instrument_id = $1 AND trade_date = $2::date AND source_id = $3', [ids.A, '2024-03-15', sourceIds.lixinger]);
    await sync.syncValuations({ market: MARKET, dates: ['2024-03-15'], instrumentIds: [ids.A] });
    const { projected } = await assertWindowEquivalent({
      market: MARKET, windowStart: '2024-03-01', asOfDate: '2024-03-31', instrumentIds: [ids.A],
    }, '手工删除估值');
    const item = projected.byInstrument.get(String(ids.A));
    assert.strictEqual(Number(item.maxPbRaw), 1.1, '删除官方行后必须回退到 tushare 的 1.10');
    await insertValuation(ids.A, '2024-03-15', 1.25, sourceIds.lixinger);
    await sync.syncValuations({ market: MARKET, dates: ['2024-03-15'], instrumentIds: [ids.A] });
  }

  // ⑦ 交易日历变更：临时关市一天，listed_days 必须减 1 且两条路径一致。
  {
    const calendarDate = '2026-12-29';
    await pool.query(`
      INSERT INTO market.trade_calendar (exchange, trade_date, is_open, source_code)
      VALUES ('SSE', $1::date, true, 'pb_eq_test')
      ON CONFLICT (exchange, trade_date) DO UPDATE SET is_open = true, source_code = 'pb_eq_test'`, [calendarDate]);
    await sync.syncCalendarChange({ market: MARKET, months: [{ year: 2026, month: 12 }] });
    const before = await readBoth({ market: MARKET, windowStart: '2026-12-01', asOfDate: '2026-12-31', instrumentIds: [ids.A] });
    const beforeExpected = before.projected.byInstrument.get(String(ids.A)).expectedDays;
    await pool.query("UPDATE market.trade_calendar SET is_open = false WHERE exchange = 'SSE' AND trade_date = $1::date", [calendarDate]);
    await sync.syncCalendarChange({ market: MARKET, months: [{ year: 2026, month: 12 }] });
    const after = await assertWindowEquivalent({
      market: MARKET, windowStart: '2026-12-01', asOfDate: '2026-12-31', instrumentIds: [ids.A],
    }, '交易日历变更');
    assert.strictEqual(after.projected.byInstrument.get(String(ids.A)).expectedDays, beforeExpected - 1,
      '关市一天后 listed_days/expectedDays 必须减 1');
    await pool.query("UPDATE market.trade_calendar SET is_open = true WHERE exchange = 'SSE' AND trade_date = $1::date", [calendarDate]);
    await sync.syncCalendarChange({ market: MARKET, months: [{ year: 2026, month: 12 }] });
  }

  // ⑦ 停牌补录：无 PB 的停牌日进入 exempt_days。
  {
    const before = await readBoth({ market: MARKET, windowStart: '2024-04-01', asOfDate: '2024-04-30', instrumentIds: [ids.C] });
    const beforeExempt = before.projected.byInstrument.get(String(ids.C)).exemptDays;
    await pool.query(`
      INSERT INTO market.stock_suspend_calendar (instrument_id, trade_date, suspend_type, source_id)
      VALUES ($1, '2024-04-11'::date, 'S', $2)
      ON CONFLICT (instrument_id, trade_date, source_id) DO NOTHING`, [ids.C, sourceIds.tushare]);
    await sync.syncSuspendChange({ market: MARKET, months: [{ year: 2024, month: 4 }] });
    const after = await assertWindowEquivalent({
      market: MARKET, windowStart: '2024-04-01', asOfDate: '2024-04-30', instrumentIds: [ids.C],
    }, '停牌补录');
    assert.strictEqual(after.projected.byInstrument.get(String(ids.C)).exemptDays, beforeExempt + 1,
      '停牌补录后 exempt_days 必须加 1');
  }

  // ⑦ 上市日纠错：B 的 list_date 提前到 2023-01-01，listed_days 必须整段前移。
  {
    const before = await readBoth({ market: MARKET, windowStart: '2024-01-01', asOfDate: '2024-02-29', instrumentIds: [ids.B] });
    const beforeExpected = before.projected.byInstrument.get(String(ids.B)).expectedDays;
    await pool.query("UPDATE core.instruments SET list_date = '2023-01-01' WHERE instrument_id = $1", [ids.B]);
    await sync.syncInstrumentChange({ market: MARKET, instrumentIds: [ids.B] });
    const after = await assertWindowEquivalent({
      market: MARKET, windowStart: '2024-01-01', asOfDate: '2024-02-29', instrumentIds: [ids.B],
    }, '上市日纠错');
    assert.ok(after.projected.byInstrument.get(String(ids.B)).expectedDays > beforeExpected,
      '上市日提前后 2024 年 1 月也应有 listed_days');
  }

  // ⑦ 证券合并：G 的估值并入 F，G 删除，F 必须整月重算且投影无 G。
  {
    const mergedId = ids.G;
    await pool.query('UPDATE market.daily_valuations SET instrument_id = $1 WHERE instrument_id = $2', [ids.F, mergedId]);
    await pool.query('DELETE FROM analytics.stock_daily_pb_picked WHERE instrument_id = $1', [mergedId]);
    await pool.query('DELETE FROM analytics.instrument_pb_monthly_summary WHERE instrument_id = $1', [mergedId]);
    await pool.query('DELETE FROM core.instruments WHERE instrument_id = $1', [mergedId]);
    ids.G = null;
    await sync.syncValuations({ market: MARKET, dates: ['2024-05-09', '2024-05-10'], instrumentIds: [ids.F] });
    await sync.syncInstrumentChange({ market: MARKET, instrumentIds: [ids.F] });
    const { projected } = await assertWindowEquivalent({
      market: MARKET, windowStart: '2024-05-01', asOfDate: '2024-05-31', instrumentIds: [ids.F],
    }, '证券合并');
    assert.ok(!projected.byInstrument.has(String(mergedId)), '被合并证券不得留在投影中');
  }

  // 恢复被修改的夹具后做一次全窗口终检，确保前面所有变更都已收敛。
  await pool.query("UPDATE market.trade_calendar SET is_open = true, source_code = 'pb_eq_test' WHERE exchange = 'SSE' AND trade_date = '2026-12-29'");
  await sync.syncCalendarChange({ market: MARKET, months: [{ year: 2026, month: 12 }] });
  await assertWindowEquivalent({
    market: MARKET,
    windowStart: WINDOW_START,
    asOfDate: AS_OF,
    instrumentIds: Object.values(ids).filter(Boolean),
  }, '终检');

  // P0-4.3 反例：稀疏两日期同步不得重算中间月份（不能把 2019-06 与 2019-12 当成连续半年）。
  {
    await pool.query(`
      DELETE FROM analytics.instrument_pb_monthly_summary
       WHERE market = $1 AND cal_year = 2019 AND cal_month = 7 AND instrument_id = ANY($2::bigint[])`,
    [MARKET, testIds]);
    await sync.syncValuations({
      market: MARKET, dates: ['2019-06-10', '2019-12-31'], instrumentIds: testIds,
    });
    const july = await pool.query(`
      SELECT COUNT(*)::int AS c FROM analytics.instrument_pb_monthly_summary
       WHERE market = $1 AND cal_year = 2019 AND cal_month = 7 AND instrument_id = ANY($2::bigint[])`,
    [MARKET, testIds]);
    assert.strictEqual(july.rows[0].c, 0, '稀疏两日期同步不得重建中间 2019-07 月汇总');
    // 恢复被删除的月份，避免影响后续对账口径。
    await pbRepo.rebuildMonthlySummaryMonth({
      market: MARKET, year: 2019, month: 7, instrumentIds: testIds,
    });
  }

  // P0-4.1 反例：历史补录的较小日期不得回退最新水位。
  {
    const scopeKey = 'pb_projection:monotonic_test';
    await pbRepo.writeSyncCursor({ scopeKey, datasetCode: 'pb_projection', lastSuccessDate: '2026-05-01' });
    await pbRepo.writeSyncCursor({ scopeKey, datasetCode: 'pb_projection', lastSuccessDate: '2024-01-01' });
    const cursor = await pbRepo.readSyncCursor({ scopeKey, datasetCode: 'pb_projection' });
    assert.strictEqual(cursor.last_success_date, '2026-05-01', 'writeSyncCursor 必须用 GREATEST 保持游标单调前进');
    await pool.query('DELETE FROM ops.sync_cursors WHERE scope_key = $1', [scopeKey]);
  }

  // P0-4.2 反例：CN 全量重建只更新 CN 指纹，不得掩盖 HK 的数据源变更检测。
  {
    const originalBounds = pbRepo.getMarketValuationBounds;
    const originalRebuild = pbRepo.rebuildProjectionRange;
    try {
      await sync.rememberSourceFingerprint('CN', 'fp-cn-old');
      await sync.rememberSourceFingerprint('HK', 'fp-hk-old');
      pbRepo.getMarketValuationBounds = async () => ({ min_date: '2024-01-15', max_date: '2024-01-15' });
      pbRepo.rebuildProjectionRange = async () => ({ picked: 0, marketDates: 0, summaries: 0 });
      await sync.fullRebuild({ market: 'CN', fromDate: '2024-01-15', toDate: '2024-01-15', sleepMs: 0 });
      const cn = await sync.readSourceFingerprintState('CN');
      const hk = await sync.readSourceFingerprintState('HK');
      assert.strictEqual(cn.changed, false, 'CN 全量重建后 CN 指纹必须更新');
      assert.strictEqual(hk.changed, true, 'CN 重建不得掩盖 HK 的数据源变更');
    } finally {
      pbRepo.getMarketValuationBounds = originalBounds;
      pbRepo.rebuildProjectionRange = originalRebuild;
      await pool.query("DELETE FROM ops.sync_cursors WHERE scope_key IN ('pb_projection:source_fingerprint:CN','pb_projection:source_fingerprint:HK')");
    }
  }

  // 定期抽样对账（Milestone A 遗留）：正常一致写水位；篡改月汇总后必须报差异并修复回零。
  {
    const scopedInstrumentIds = Object.values(ids).filter(Boolean);
    const scopedLatestMonth = { year: 2026, month: 5 };
    const scopedMonths = monthsBetween('2019-01-01', '2026-05-31');
    const firstReport = await sync.reconcilePbProjectionSample({
      markets: [MARKET], sampleSize: 20, years: 10, force: true,
      instrumentIds: scopedInstrumentIds, latestMonth: scopedLatestMonth, monthList: scopedMonths,
    });
    assert.strictEqual(firstReport.diffCount, 0, `投影一致时对账必须 diff=0（实得 ${firstReport.diffCount}）`);
    assert.ok(firstReport.markets[MARKET] && firstReport.markets[MARKET].checked > 0, '对账必须覆盖抽样对象');
    const cursor = await pbRepo.readSyncCursor({ scopeKey: sync.RECONCILE_SCOPE, datasetCode: 'pb_projection' });
    assert.ok(cursor && cursor.last_success_date, '对账通过必须写 last_success_date 水位');

    const target = await pool.query(`
      SELECT instrument_id, cal_year, cal_month, max_pb, covered_days
        FROM analytics.instrument_pb_monthly_summary
       WHERE instrument_id = ANY($1::bigint[]) AND cal_year = 2026 AND cal_month = 5
       ORDER BY instrument_id LIMIT 1`, [Object.values(ids).filter(Boolean)]);
    assert.ok(target.rows.length, '夹具必须存在 2026-05 月汇总行');
    const tampered = target.rows[0];
    await pool.query(`
      UPDATE analytics.instrument_pb_monthly_summary
         SET max_pb = max_pb + 100, covered_days = covered_days + 1, updated_at = now()
       WHERE instrument_id = $1 AND cal_year = $2 AND cal_month = $3`,
    [tampered.instrument_id, tampered.cal_year, tampered.cal_month]);

    const originalRebuild = pbRepo.rebuildProjectionRange;
    let repairCalls = 0;
    pbRepo.rebuildProjectionRange = async (...args) => {
      repairCalls += 1;
      return originalRebuild.apply(pbRepo, args);
    };
    let diffReport;
    try {
      diffReport = await sync.reconcilePbProjectionSample({
        markets: [MARKET], sampleSize: 20, years: 10, force: true,
        instrumentIds: scopedInstrumentIds, latestMonth: scopedLatestMonth, monthList: scopedMonths,
      });
    } finally {
      pbRepo.rebuildProjectionRange = originalRebuild;
    }
    assert.ok(diffReport.diffCount > 0, '篡改月汇总后对账必须发现差异');
    assert.ok(diffReport.repairedMonths > 0, '发现差异必须标脏重算受影响月份');
    assert.strictEqual(repairCalls, diffReport.markets[MARKET].repairedMonths,
      '逐月短事务修复必须每个月调用一次 rebuildProjectionRange');
    const repaired = await pool.query(`
      SELECT max_pb::text AS max_pb, covered_days
        FROM analytics.instrument_pb_monthly_summary
       WHERE instrument_id = $1 AND cal_year = $2 AND cal_month = $3`,
    [tampered.instrument_id, tampered.cal_year, tampered.cal_month]);
    assert.strictEqual(String(repaired.rows[0].max_pb), String(tampered.max_pb), '重算后 max_pb 必须恢复原始口径');
    assert.strictEqual(Number(repaired.rows[0].covered_days), Number(tampered.covered_days), '重算后 covered_days 必须恢复原始口径');
    const secondReport = await sync.reconcilePbProjectionSample({
      markets: [MARKET], sampleSize: 20, years: 10, force: true,
      instrumentIds: scopedInstrumentIds, latestMonth: scopedLatestMonth, monthList: scopedMonths,
    });
    assert.strictEqual(secondReport.diffCount, 0, '修复后再次对账必须回到 diff=0');

    // 多脏月必须逐月独立修复：2 个脏月调用 2 次重建，而不是塞进同一事务。
    await pool.query(`
      UPDATE analytics.instrument_pb_monthly_summary
         SET covered_days = covered_days + 2, updated_at = now()
       WHERE instrument_id = $1 AND ((cal_year = 2026 AND cal_month IN (4, 5)))`,
    [tampered.instrument_id]);
    let multiCalls = 0;
    pbRepo.rebuildProjectionRange = async (...args) => {
      multiCalls += 1;
      return originalRebuild.apply(pbRepo, args);
    };
    let multiReport;
    try {
      multiReport = await sync.reconcilePbProjectionSample({
        markets: [MARKET], sampleSize: 20, years: 10, force: true,
        instrumentIds: scopedInstrumentIds, latestMonth: scopedLatestMonth, monthList: scopedMonths,
      });
    } finally {
      pbRepo.rebuildProjectionRange = originalRebuild;
    }
    assert.strictEqual(multiReport.markets[MARKET].dirtyMonths, 2, '两个月被篡改必须识别 2 个脏月');
    assert.strictEqual(multiCalls, 2, '2 个脏月必须逐月短事务各修一次');

    // 超过单次自动修复上限：只标记 pending_full_rebuild，不在凌晨任务里连修 7 个月。
    await pool.query(`
      UPDATE analytics.instrument_pb_monthly_summary
         SET covered_days = covered_days + 3, updated_at = now()
       WHERE instrument_id = $1 AND (cal_year, cal_month) IN (
         (2025, 12), (2026, 1), (2026, 2), (2026, 3), (2026, 4), (2026, 5), (2026, 6))`,
    [tampered.instrument_id]);
    const cappedMonths = monthsBetween('2025-12-01', '2026-06-30');
    let cappedCalls = 0;
    pbRepo.rebuildProjectionRange = async (...args) => {
      cappedCalls += 1;
      return originalRebuild.apply(pbRepo, args);
    };
    let cappedReport;
    try {
      cappedReport = await sync.reconcilePbProjectionSample({
        markets: [MARKET], sampleSize: 20, years: 10, force: true,
        instrumentIds: scopedInstrumentIds, latestMonth: scopedLatestMonth, monthList: cappedMonths,
      });
    } finally {
      pbRepo.rebuildProjectionRange = originalRebuild;
    }
    assert.ok(cappedReport.markets[MARKET].dirtyMonths > sync.MAX_RECONCILE_REPAIR_MONTHS,
      '夹具必须产生超过安全上限的脏月');
    assert.strictEqual(cappedReport.markets[MARKET].pendingFullRebuild, true, '超过上限必须标记 pending_full_rebuild');
    assert.strictEqual(cappedCalls, 0, '超过上限时不得在凌晨对账里连续修复脏月');
    const pending = await pbRepo.readLatestCursorValue({ scopeKey: `pb_projection:pending_full_rebuild:${MARKET}` });
    assert.ok(pending && /reconcile_dirty_months_exceeded/.test(pending.dataset_code),
      '超过上限必须持久化 pending_full_rebuild 原因');
  }

  console.log('pb projection equivalence: 8 boundary groups, 15 fields and marketDays all diff = 0; reconcile diff=0/repair/diff=0');
}

main()
  .then(async () => { await cleanup(); })
  .catch(async error => {
    console.error(error);
    try { await cleanup(); } catch (cleanupError) { console.error('清理失败：', cleanupError.message); }
    process.exitCode = 1;
  })
  .finally(async () => { await pool.end().catch(() => {}); });

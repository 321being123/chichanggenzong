// 投资策略选股中心：数据语义专项测试（真实 PostgreSQL，任务隔离库）。
// 覆盖 2026-11-04 四项口径修正，防止"数据明明有、却被判缺失"再次阻断整批发布：
//  1) 送转后每股股息要按官方送转比例折算到 T 日股本单位（不再一律判"股份单位未统一"）；
//  2) 送转比例确实为空才判未知，不猜；
//  3) 从未有过任何行情的证券（已退市/摘牌残留主档）不进选股池；
//  4) 负 PB 是"净资产为负"的真实取值，计入十年窗口覆盖；空分红记录不把整年判成未知。
// 夹具使用 6098xx 未分配号段与唯一公司名，结束时按代码/名称前缀清理，不触碰真实数据。
'use strict';
const assert = require('assert');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const MARK = '6098';
const CODES = [`${MARK}01.SH`, `${MARK}02.SH`, `${MARK}03.SH`, `${MARK}04.SH`, `${MARK}05.SH`,
  `${MARK}06.SH`, `${MARK}07.SH`, `${MARK}08.SH`, `${MARK}09.SH`, `${MARK}10.SH`, `${MARK}11.SH`,
  `${MARK}12.SH`, `${MARK}13.SH`, `${MARK}14.SH`, `${MARK}15.SH`];
const COMPANY_PREFIX = '选股口径测试';
const TAG = Date.now().toString(36);
const AS_OF = '2026-09-30';
const WINDOW_START = '2025-09-30';
// 用远期日历区间，避开真实交易日历数据。
const CAL_FROM = '2028-12-31';
const CAL_TO = '2029-01-05';

const tests = [];
async function check(name, fn) {
  try {
    await fn();
    tests.push(['PASS', name]);
    console.log('  [PASS] ' + name);
  } catch (error) {
    tests.push(['FAIL', name + ' :: ' + error.message]);
    console.log('  [FAIL] ' + name + ' :: ' + error.message);
  }
}

async function cleanup(pool) {
  const { rows } = await pool.query(`SELECT instrument_id FROM core.instruments WHERE canonical_code = ANY($1)`, [CODES]);
  const ids = rows.map(row => row.instrument_id);
  if (ids.length) {
    await pool.query(`DELETE FROM fundamental.corporate_actions WHERE instrument_id = ANY($1::bigint[])`, [ids]);
    await pool.query(`DELETE FROM market.daily_valuations WHERE instrument_id = ANY($1::bigint[])`, [ids]);
    await pool.query(`DELETE FROM market.daily_bars WHERE instrument_id = ANY($1::bigint[])`, [ids]);
    await pool.query(`DELETE FROM core.company_instruments WHERE instrument_id = ANY($1::bigint[])`, [ids]);
  }
  const companies = await pool.query(`SELECT company_id FROM core.companies WHERE legal_name LIKE $1`, [COMPANY_PREFIX + TAG + '%']);
  const companyIds = companies.rows.map(row => row.company_id);
  if (companyIds.length) {
    await pool.query(
      `DELETE FROM fundamental.financial_facts WHERE report_id IN (
         SELECT report_id FROM fundamental.financial_reports WHERE company_id = ANY($1::bigint[]))`, [companyIds]);
    await pool.query(`DELETE FROM fundamental.financial_reports WHERE company_id = ANY($1::bigint[])`, [companyIds]);
    await pool.query(`DELETE FROM core.companies WHERE company_id = ANY($1::bigint[])`, [companyIds]);
  }
  await pool.query(`DELETE FROM core.instruments WHERE canonical_code = ANY($1)`, [CODES]);
  await pool.query(`DELETE FROM market.trade_calendar WHERE exchange='SSE' AND trade_date > $1::date AND trade_date <= $2::date`, [CAL_FROM, CAL_TO]);
}

async function createInstrument(pool, index, options = {}) {
  const code = CODES[index];
  const company = await pool.query(
    `INSERT INTO core.companies (legal_name, short_name, country_code, company_type)
     VALUES ($1,$2,'CN','listed') RETURNING company_id`,
    [`${COMPANY_PREFIX}${TAG}${index}`, `${MARK}${index}`]);
  const companyId = company.rows[0].company_id;
  const instrument = await pool.query(
    `INSERT INTO core.instruments (canonical_code, name, asset_class, market, exchange_code, currency_code, list_date, status)
     VALUES ($1,$2,'stock','CN','SSE','CNY',$3::date,'listed') RETURNING instrument_id`,
    [code, `口径测试${index}`, options.listDate || '2010-01-01']);
  const instrumentId = instrument.rows[0].instrument_id;
  await pool.query(
    `INSERT INTO core.company_instruments (company_id, instrument_id, relation_type, valid_from)
     VALUES ($1,$2,'issued_by','2010-01-01')`, [companyId, instrumentId]);
  return { code, companyId, instrumentId };
}

async function insertBar(pool, instrumentId, sourceId, day, close = 10) {
  await pool.query(
    `INSERT INTO market.daily_bars (instrument_id, trade_date, source_id, open, high, low, close, volume, amount)
     VALUES ($1,$2::date,$3,$4,$4,$4,$4,1000,10000)`, [instrumentId, day, sourceId, close]);
}

async function insertAction(pool, instrumentId, sourceId, row) {
  await pool.query(
    `INSERT INTO fundamental.corporate_actions
       (instrument_id, action_type, fiscal_period_end, announced_at, ex_date, status,
        cash_per_share_pre_tax, stock_dividend_ratio, capitalization_ratio, total_cash_amount,
        currency_code, source_id, source_key)
     VALUES ($1,'dividend',$2::date,$3::date,$4::date,$5,$6,$7,$8,$9,'CNY',$10,$11)`,
    [instrumentId, row.fiscalPeriodEnd || null, row.announcedAt || null, row.exDate,
      row.status || '实施', row.cash, row.bonus === undefined ? 0 : row.bonus,
      row.cap === undefined ? 0 : row.cap, row.total, sourceId, `${MARK}-${row.key}`]);
}

// 年报本体 + 归母净利事实：年度分红判定以「公司实际年报期末」为主表。
async function insertAnnualReport(pool, companyId, sourceId, periodEnd, announcedAt, profit) {
  const report = await pool.query(
    `INSERT INTO fundamental.financial_reports
       (company_id, report_kind, period_end, period_type, statement_scope, announced_at,
        source_id, source_version, update_flag, is_current_version, report_type)
     VALUES ($1,'income',$2::date,'annual','consolidated',$3::date,$4,'v1','',true,'1')
     RETURNING report_id`, [companyId, periodEnd, announcedAt, sourceId]);
  await pool.query(
    `INSERT INTO fundamental.financial_facts
       (report_id, statement_type, metric_code, numeric_value, unit_code, currency_code, source_field, is_calculated)
     VALUES ($1,'income','net_profit_parent',$2,'CNY','CNY','n_income_attr_p',false)`,
    [report.rows[0].report_id, profit]);
}

async function main() {
  const { pool } = require('../db/connection');
  const migrations = require('../db/migrations');
  await migrations.runMigrations();
  const repo = require('../repositories/stockSelectionRepository');
  const rules = require('../domain/stockSelectionRules');

  await cleanup(pool);

  const sourceRows = await pool.query(`SELECT source_id FROM ops.data_sources ORDER BY source_id`);
  assert.ok(sourceRows.rows[0], '测试环境缺少 ops.data_sources');
  const sourceId = sourceRows.rows[0].source_id;
  // 第二个来源用来复现「同一笔被两个来源各写一行」：去重只能留一条，不能双计。
  const sourceId2 = (sourceRows.rows[1] || sourceRows.rows[0]).source_id;

  try {
    const send = await createInstrument(pool, 0);
    const unknown = await createInstrument(pool, 1);
    const noMarket = await createInstrument(pool, 2);
    const negative = await createInstrument(pool, 3, { listDate: '2020-01-01' });
    const emptyAction = await createInstrument(pool, 4);
    const stalePlan = await createInstrument(pool, 5);
    const recentValuation = await createInstrument(pool, 6);
    const ancientValuation = await createInstrument(pool, 7);
    const noDividendYear = await createInstrument(pool, 8);
    const negativeFromSource = await createInstrument(pool, 9);
    const meetingZero = await createInstrument(pool, 10);
    // 11—14：2026-11-08 生产实测的四类分红判定边界（601966 / 01177 / 600959 / 002648）。
    const crossYearDiff = await createInstrument(pool, 11);
    const crossYearSame = await createInstrument(pool, 12);
    const pureTransfer = await createInstrument(pool, 13);
    const staleWithInterim = await createInstrument(pool, 14);

    // 1) 2025-12-01 派现 0.2 元/股（无送转），2026-06-15 每 10 股转增 4 股 → 1 股转增 0.4 股。
    await insertAction(pool, send.instrumentId, sourceId, { exDate: '2025-12-01', cash: 0.2, key: 'send-cash' });
    await insertAction(pool, send.instrumentId, sourceId, { exDate: '2026-06-15', cash: null, cap: 0.4, key: 'send-cap' });
    // 2) 一笔现金分红，但送转比例两项都为空 → 无法判断是否伴随送转。
    await insertAction(pool, unknown.instrumentId, sourceId, { exDate: '2026-03-01', cash: 0.3, bonus: null, cap: null, key: 'unknown-cash' });
    // 3) 有行情（用于对照"有数据的不被排除"）。
    await pool.query(
      `INSERT INTO market.daily_valuations (instrument_id, trade_date, source_id, pb, total_market_cap, currency_code)
       VALUES ($1,$2::date,$3,1.2,5e10,'CNY')`, [send.instrumentId, AS_OF, sourceId]);
    await insertBar(pool, send.instrumentId, sourceId, AS_OF);
    // 4) 负 PB 三天 + 远期日历五天。
    for (const day of ['2029-01-02', '2029-01-03', '2029-01-04']) {
      await pool.query(
        `INSERT INTO market.daily_valuations (instrument_id, trade_date, source_id, pb, total_market_cap, currency_code)
         VALUES ($1,$2::date,$3,$4,1e9,'CNY')`,
        [negative.instrumentId, day, sourceId, day === '2029-01-02' ? -3 : day === '2029-01-03' ? -2 : -1]);
    }
    for (const day of ['2028-12-29', '2029-01-02', '2029-01-03', '2029-01-04', '2029-01-05']) {
      await pool.query(
        `INSERT INTO market.trade_calendar (exchange, trade_date, is_open)
         VALUES ('SSE',$1::date,true) ON CONFLICT DO NOTHING`, [day]);
    }
    // 5) 空分红记录（已实施已除息但金额全空）+ 同财年一笔真实年度分红。
    const report = await pool.query(
      `INSERT INTO fundamental.financial_reports
         (company_id, report_kind, period_end, period_type, statement_scope, announced_at,
          source_id, source_version, update_flag, is_current_version, report_type)
       VALUES ($1,'income','2025-12-31'::date,'annual','consolidated','2026-03-31'::date,$2,'v1','',true,'1')
       RETURNING report_id`, [emptyAction.companyId, sourceId]);
    await pool.query(
      `INSERT INTO fundamental.financial_facts
         (report_id, statement_type, metric_code, numeric_value, unit_code, currency_code, source_field, is_calculated)
       VALUES ($1,'income','net_profit_parent',1e9,'CNY','CNY','n_income_attr_p',false)`, [report.rows[0].report_id]);
    await insertAction(pool, emptyAction.instrumentId, sourceId, {
      fiscalPeriodEnd: '2025-06-30', announcedAt: '2025-08-20', exDate: '2025-10-25',
      cash: null, bonus: null, cap: null, total: null, key: 'empty-action',
    });
    await insertAction(pool, emptyAction.instrumentId, sourceId, {
      fiscalPeriodEnd: '2025-12-31', announcedAt: '2026-05-01', exDate: '2026-06-20',
      cash: 0.5, total: 1e8, key: 'annual-cash',
    });

    // 6) 2022 财年只有"股东大会通过"、从未实施（财年期末距目标日已超 2 年）。
    // 年度判定以年报期末为主表，所以这只也要有 2022 年报。
    const spReport = await pool.query(
      `INSERT INTO fundamental.financial_reports
         (company_id, report_kind, period_end, period_type, statement_scope, announced_at,
          source_id, source_version, update_flag, is_current_version, report_type)
       VALUES ($1,'income','2022-12-31'::date,'annual','consolidated','2023-03-31'::date,$2,'v1','',true,'1')
       RETURNING report_id`, [stalePlan.companyId, sourceId]);
    await pool.query(
      `INSERT INTO fundamental.financial_facts
         (report_id, statement_type, metric_code, numeric_value, unit_code, currency_code, source_field, is_calculated)
       VALUES ($1,'income','net_profit_parent',3e8,'CNY','CNY','n_income_attr_p',false)`, [spReport.rows[0].report_id]);
    await pool.query(
      `INSERT INTO fundamental.corporate_actions
         (instrument_id, action_type, fiscal_period_end, announced_at, ex_date, status,
          cash_per_share_pre_tax, stock_dividend_ratio, capitalization_ratio, total_cash_amount,
          currency_code, source_id, source_key)
       VALUES ($1,'dividend','2022-12-31'::date,'2023-05-01'::date,NULL,'股东大会通过',NULL,0,0,NULL,'CNY',$2,$3)`,
      [stalePlan.instrumentId, sourceId, `${MARK}-STALE-2022`]);
    // 7) 目标日当天无估值：20 天前有值 → 应回退取到；121 天前有值 → 超出 60 天窗口，保持缺失。
    // 两者都要有窗口内的行情（否则会按"已停止交易"排除出池，测不到回退行为）。
    for (const [instrumentId, day] of [[recentValuation.instrumentId, '2026-09-10'], [ancientValuation.instrumentId, '2026-06-01']]) {
      await pool.query(
        `INSERT INTO market.daily_valuations (instrument_id, trade_date, source_id, pb, total_market_cap, currency_code)
         VALUES ($1,$2::date,$3,1.3,3e10,'CNY')`, [instrumentId, day, sourceId]);
    }
    await insertBar(pool, recentValuation.instrumentId, sourceId, '2026-09-10');
    await insertBar(pool, ancientValuation.instrumentId, sourceId, '2026-09-10');

    // 8) 有 2024 年报、但该财年一笔分红记录都没有 → 应判该财年零分红（不是未知）。
    const ndReport = await pool.query(
      `INSERT INTO fundamental.financial_reports
         (company_id, report_kind, period_end, period_type, statement_scope, announced_at,
          source_id, source_version, update_flag, is_current_version, report_type)
       VALUES ($1,'income','2024-12-31'::date,'annual','consolidated','2025-03-31'::date,$2,'v1','',true,'1')
       RETURNING report_id`, [noDividendYear.companyId, sourceId]);
    await pool.query(
      `INSERT INTO fundamental.financial_facts
         (report_id, statement_type, metric_code, numeric_value, unit_code, currency_code, source_field, is_calculated)
       VALUES ($1,'income','net_profit_parent',5e8,'CNY','CNY','n_income_attr_p',false)`, [ndReport.rows[0].report_id]);

    // 9) 源站 PB 为空、但净资产为负：应按定义式现算出负 PB，而不是判缺失。
    const neReport = await pool.query(
      `INSERT INTO fundamental.financial_reports
         (company_id, report_kind, period_end, period_type, statement_scope, announced_at,
          source_id, source_version, update_flag, is_current_version, report_type)
       VALUES ($1,'balance','2026-06-30'::date,'interim','consolidated','2026-08-20'::date,$2,'v1','',true,'2')
       RETURNING report_id`, [negativeFromSource.companyId, sourceId]);
    await pool.query(
      `INSERT INTO fundamental.financial_facts
         (report_id, statement_type, metric_code, numeric_value, unit_code, currency_code, source_field, is_calculated)
       VALUES ($1,'balance','equity_parent',-2e8,'CNY','CNY','total_hldr_eqy_exc_min_int',false)`, [neReport.rows[0].report_id]);
    await pool.query(
      `INSERT INTO market.daily_valuations (instrument_id, trade_date, source_id, pb, total_market_cap, currency_code)
       VALUES ($1,$2::date,$3,NULL,1e9,'CNY')`, [negativeFromSource.instrumentId, AS_OF, sourceId]);
    await insertBar(pool, negativeFromSource.instrumentId, sourceId, AS_OF);

    // 10) 「股东大会通过 + 每股 0」= 该财年明确不派现（不是未知）。
    const mzReport = await pool.query(
      `INSERT INTO fundamental.financial_reports
         (company_id, report_kind, period_end, period_type, statement_scope, announced_at,
          source_id, source_version, update_flag, is_current_version, report_type)
       VALUES ($1,'income','2024-12-31'::date,'annual','consolidated','2025-03-31'::date,$2,'v1','',true,'1')
       RETURNING report_id`, [meetingZero.companyId, sourceId]);
    await pool.query(
      `INSERT INTO fundamental.financial_facts
         (report_id, statement_type, metric_code, numeric_value, unit_code, currency_code, source_field, is_calculated)
       VALUES ($1,'income','net_profit_parent',2e8,'CNY','CNY','n_income_attr_p',false)`, [mzReport.rows[0].report_id]);
    await pool.query(
      `INSERT INTO fundamental.corporate_actions
         (instrument_id, action_type, fiscal_period_end, announced_at, ex_date, status,
          cash_per_share_pre_tax, stock_dividend_ratio, capitalization_ratio, total_cash_amount,
          currency_code, source_id, source_key)
       VALUES ($1,'dividend','2024-12-31'::date,'2025-03-31'::date,NULL,'股东大会通过',NULL,0,0,NULL,'CNY',$2,$3)`,
      [meetingZero.instrumentId, sourceId, `${MARK}-MEETING-ZERO`]);
    // 11) 2023 财年只有「预案」、从未实施：按 2026-11-04 口径也是「该年没分红」，不是未知。
    const poReport = await pool.query(
      `INSERT INTO fundamental.financial_reports
         (company_id, report_kind, period_end, period_type, statement_scope, announced_at,
          source_id, source_version, update_flag, is_current_version, report_type)
       VALUES ($1,'income','2023-12-31'::date,'annual','consolidated','2024-03-31'::date,$2,'v1','',true,'1')
       RETURNING report_id`, [meetingZero.companyId, sourceId]);
    await pool.query(
      `INSERT INTO fundamental.financial_facts
         (report_id, statement_type, metric_code, numeric_value, unit_code, currency_code, source_field, is_calculated)
       VALUES ($1,'income','net_profit_parent',1.5e8,'CNY','CNY','n_income_attr_p',false)`, [poReport.rows[0].report_id]);
    await pool.query(
      `INSERT INTO fundamental.corporate_actions
         (instrument_id, action_type, fiscal_period_end, announced_at, ex_date, status,
          cash_per_share_pre_tax, stock_dividend_ratio, capitalization_ratio, total_cash_amount,
          currency_code, source_id, source_key)
       VALUES ($1,'dividend','2023-12-31'::date,'2024-03-31'::date,NULL,'预案',NULL,0,0,NULL,'CNY',$2,$3)`,
      [meetingZero.instrumentId, sourceId, `${MARK}-PLAN-ONLY`]);

    // 11) 同一天除息、分属两个财年、金额不同：2026-11-08 生产实测 601966
    //    2024 年报每股 0.014 元（总额 2e7）与 2025 一季报每股 0.070 元（总额 1e8）同为 2025-07-10 除息。
    //    年报那笔用较低来源、一季报用较高来源，旧实现按除息日去重会稳定保留后者、把年报那笔吞掉。
    await insertAnnualReport(pool, crossYearDiff.companyId, sourceId, '2024-12-31', '2025-03-31', 1e9);
    await insertAction(pool, crossYearDiff.instrumentId, sourceId, {
      fiscalPeriodEnd: '2024-06-30', announcedAt: '2024-08-27', exDate: '2024-09-27',
      cash: 0.1, total: 1e8, key: 'cyd-interim',
    });
    await insertAction(pool, crossYearDiff.instrumentId, sourceId, {
      fiscalPeriodEnd: '2024-12-31', announcedAt: '2025-04-25', exDate: '2025-07-10',
      cash: 0.014, total: 2e7, key: 'cyd-year-end',
    });
    await insertAction(pool, crossYearDiff.instrumentId, sourceId2, {
      fiscalPeriodEnd: '2025-03-31', announcedAt: '2025-04-25', exDate: '2025-07-10',
      cash: 0.07, total: 1e8, key: 'cyd-next-q1',
    });

    // 12) 同一天除息、被标成两个财年、金额完全相同：同一笔重复打标（01177.HK 那种），只能算一次。
    await insertAnnualReport(pool, crossYearSame.companyId, sourceId, '2024-12-31', '2025-03-31', 1e9);
    await insertAction(pool, crossYearSame.instrumentId, sourceId, {
      fiscalPeriodEnd: '2024-12-31', announcedAt: '2025-04-25', exDate: '2025-06-20',
      cash: 0.02, total: 1e8, key: 'cys-2024',
    });
    await insertAction(pool, crossYearSame.instrumentId, sourceId2, {
      fiscalPeriodEnd: '2025-06-30', announcedAt: '2025-08-20', exDate: '2025-06-20',
      cash: 0.02, total: 1e8, key: 'cys-2025',
    });

    // 13) 纯送转方案（复现 600959 的 2015）：同年中期 0.16 元已实施，年末 10 转 3、一分现金都没有。
    //     年末那笔必须被认成「已实施、现金 0」，否则"财年末已实施"恒为 0，整年判未知。
    await insertAnnualReport(pool, pureTransfer.companyId, sourceId, '2024-12-31', '2025-03-31', 1e9);
    await insertAction(pool, pureTransfer.instrumentId, sourceId, {
      fiscalPeriodEnd: '2024-06-30', announcedAt: '2024-08-29', exDate: '2024-11-06',
      cash: 0.16, total: 4.78e8, key: 'pure-transfer-interim',
    });
    await insertAction(pool, pureTransfer.instrumentId, sourceId, {
      fiscalPeriodEnd: '2024-12-31', announcedAt: '2025-04-19', exDate: '2025-07-10',
      cash: null, cap: 0.3, total: null, key: 'pure-transfer',
    });

    // 14) 末期方案停在预案 3 年（期末距目标日超 2 年）、同年中期已实施（002648 的 2022）。
    await insertAnnualReport(pool, staleWithInterim.companyId, sourceId, '2022-12-31', '2023-03-31', 3e8);
    await insertAction(pool, staleWithInterim.instrumentId, sourceId, {
      fiscalPeriodEnd: '2022-06-30', announcedAt: '2022-08-30', exDate: '2022-10-13',
      cash: 0.4, total: 9.6e8, key: 'swi-interim',
    });
    await insertAction(pool, staleWithInterim.instrumentId, sourceId, {
      fiscalPeriodEnd: '2022-12-31', announcedAt: '2023-04-29', exDate: null,
      status: '预案', cash: null, total: null, key: 'swi-plan',
    });

    await check('送转后每股股息按官方送转比例折算到 T 日股本单位', async () => {
      const map = await repo.loadDividendWindow({ instrumentIds: [send.instrumentId], windowStart: WINDOW_START, asOfDate: AS_OF });
      const item = map.get(String(send.instrumentId));
      assert.ok(item, '必须返回该证券的分红窗口');
      assert.strictEqual(item.shareUnitUnverified, false, '比例齐全时不该判股份单位未知');
      assert.strictEqual(item.adjustmentFactor, 1.4, '一股转增 0.4 股的折算因子应为 1.4');
      assert.ok(Math.abs(item.ttmPerShare - 0.2 / 1.4) < 1e-9,
        `折算后每股应为 ${0.2 / 1.4}，实际 ${item.ttmPerShare}`);
    });

    await check('送转比例两项都为空时判股份单位未知，不猜折算因子', async () => {
      const map = await repo.loadDividendWindow({ instrumentIds: [unknown.instrumentId], windowStart: WINDOW_START, asOfDate: AS_OF });
      const item = map.get(String(unknown.instrumentId));
      assert.strictEqual(item.shareUnitUnverified, true, '比例为空必须标未知');
    });

    await check('从未有过任何行情的证券不进选股池，有行情的照常保留', async () => {
      const universe = await repo.loadUniverse({ market: 'CN', asOfDate: AS_OF });
      const ids = new Set(universe.map(row => String(row.instrument_id)));
      assert.ok(!ids.has(String(noMarket.instrumentId)), '无任何行情/估值的证券必须排除（已退市/摘牌残留主档）');
      assert.ok(ids.has(String(send.instrumentId)), '有估值的证券不能一起被排除');
    });

    await check('负 PB 计入十年窗口覆盖，且最高值如实反映', async () => {
      const detail = await repo.loadPbWindow({ market: 'CN', windowStart: CAL_FROM, asOfDate: CAL_TO });
      const item = detail.byInstrument.get(String(negative.instrumentId));
      assert.ok(item, '必须返回该证券的窗口明细');
      assert.strictEqual(item.coveredDays, 3, '负 PB 的三天必须算作有效覆盖（旧口径为 0）');
      assert.strictEqual(item.maxPb, -1, '窗口内最高 PB 应如实是 -1');
    });

    await check('空分红记录不把整年判成未知：同财年有真实年度分红即视为已知', async () => {
      const map = await repo.loadAnnualDividends({ companyIds: [emptyAction.companyId], asOfDate: AS_OF });
      const rows = map.get(String(emptyAction.companyId)) || [];
      const year = rows.find(row => row.year === 2025);
      assert.ok(year, '必须给出 2025 财年记录');
      assert.strictEqual(year.dividendKnown, true, '金额为空的中期空记录不得让整年未知');
      assert.strictEqual(Number(year.dividend), 1e8, '年度分红总额应如实取到');
    });

    await check('财年期末已过 2 年仍停在股东大会通过 → 判该年无已实施分红，不算未知', async () => {
      const map = await repo.loadAnnualDividends({ companyIds: [stalePlan.companyId], asOfDate: AS_OF });
      const rows = map.get(String(stalePlan.companyId)) || [];
      const year = rows.find(row => row.year === 2022);
      assert.ok(year, '必须给出 2022 财年记录');
      assert.strictEqual(year.dividendKnown, true, '过期的股东大会通过方案不能永远算未知');
      assert.strictEqual(Number(year.dividend), 0, '未落地方案按 0 计');
      assert.strictEqual(year.dividendBasis !== 'plan_only', true, '过期的股东大会通过方案不能永远算未知');
    });

    await check('当日无估值时回退到 60 天窗口内最后有值日，超窗不回退', async () => {
      const universe = await repo.loadUniverse({ market: 'CN', asOfDate: AS_OF });
      const byId = new Map(universe.map(row => [String(row.instrument_id), row]));
      const recent = byId.get(String(recentValuation.instrumentId));
      assert.ok(recent, '20 天前有估值的证券必须在池内');
      assert.strictEqual(Number(recent.pb), 1.3, '应回退取到 20 天前的 PB');
      assert.strictEqual(recent.valuation_date, '2026-09-10', '回退来源日期必须留证');
      const ancient = byId.get(String(ancientValuation.instrumentId));
      assert.ok(ancient, '有历史行情的证券仍在池内（不按无行情排除）');
      assert.strictEqual(ancient.pb, null, '超过 60 天窗口不得回退，保持缺失');
    });

    await check('财年一笔分红记录都没有 → 判该年零分红，不算未知', async () => {
      const map = await repo.loadAnnualDividends({ companyIds: [noDividendYear.companyId], asOfDate: AS_OF });
      const rows = map.get(String(noDividendYear.companyId)) || [];
      const year = rows.find(row => row.year === 2024);
      assert.ok(year, '必须给出 2024 财年记录（以年报期末为主表）');
      assert.strictEqual(year.dividendKnown, true, '采过但没有记录的年份就是没分红');
      assert.strictEqual(Number(year.dividend), 0);
      assert.strictEqual(year.dividendBasis, 'no_dividend_event_in_fiscal_year');
    });

    await check('股东大会通过 + 每股 0 → 判该财年明确不派现，不是未知', async () => {
      const map = await repo.loadAnnualDividends({ companyIds: [meetingZero.companyId], asOfDate: AS_OF });
      const rows = map.get(String(meetingZero.companyId)) || [];
      const year = rows.find(row => row.year === 2024);
      assert.ok(year, '必须给出 2024 财年记录');
      assert.strictEqual(year.dividendKnown, true, '方案已定、就是不分红，不能判未知');
      assert.strictEqual(Number(year.dividend), 0);
    });

    await check('只有预案、从未实施 → 判该财年没分红，不是未知', async () => {
      const map = await repo.loadAnnualDividends({ companyIds: [meetingZero.companyId], asOfDate: AS_OF });
      const rows = map.get(String(meetingZero.companyId)) || [];
      const year = rows.find(row => row.year === 2023);
      assert.ok(year, '必须给出 2023 财年记录');
      assert.strictEqual(year.dividendKnown, true, '预案没实施就是没分红');
      assert.strictEqual(Number(year.dividend), 0);
      // 距今已过 2 年的财年先命中的是「过期方案」分支，两者语义相同（未实施即 0）。
      assert.ok(['stale_plan_not_implemented', 'plan_not_implemented_zero'].includes(year.dividendBasis), '实际 basis=' + year.dividendBasis);
    });

    await check('源站 PB 为空时按总市值÷归母净资产现算，负净资产如实为负 PB', async () => {
      const universe = await repo.loadUniverse({ market: 'CN', asOfDate: AS_OF });
      const row = universe.find(item => String(item.instrument_id) === String(negativeFromSource.instrumentId));
      assert.ok(row, '该证券必须在池内');
      assert.strictEqual(Number(row.pb), -5, '总市值 10 亿 ÷ 归母净资产 -2 亿 = -5');
    });

    await check('负 PB 在 R01 判不通过而不是待补，不阻断整批发布', async () => {
      const result = rules.evaluateInstrument({
        instrumentId: negative.instrumentId, code: negative.code, name: '口径测试3',
        pb: -1, peStatic: null, dividend: { verifiedZero: false, count: 0 }, equity: { amount: null },
        pbWindow: { maxPb: -1, coveredDays: 3, expectedDays: 5, gapDays: 2 },
        annual: { latestYear: null, years: [] }, risk: [], market: 'CN',
      });
      assert.strictEqual(result.rules.R01.status, rules.STATUS.FAIL);
      assert.strictEqual(result.rules.R01.reason, 'pb_negative_equity');
    });

    // 方案 27.5 第 6 条：源端先天不给 → NOT_APPLICABLE；未登记 / 只登记一部分 → 仍待补。
    const annualYears = (skip = []) => [2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020,
      2021, 2022, 2023, 2024, 2025].filter(y => !skip.includes(y))
      .map(y => ({ year: y, profit: 1e8, complete: true, dividend: 0, dividendKnown: true }));

    await check('已核实源端不可恢复的缺口年份判不可评估，不进补数队列', async () => {
      const result = rules.evaluateAnnualAnomaly({
        latestYear: 2025, market: 'CN', currency: 'CNY',
        years: annualYears([2017]), sourceGapYears: [2017],
      });
      assert.strictEqual(result.status, rules.STATUS.NOT_APPLICABLE);
      assert.strictEqual(result.reason, 'fiscal_history_source_unrecoverable');
      assert.deepStrictEqual(result.missingYears, [2017]);
      assert.deepStrictEqual(result.sourceGapYears, [2017]);
    });

    await check('缺口未登记、或只登记了一部分年份时仍判待补', async () => {
      const unregistered = rules.evaluateAnnualAnomaly({
        latestYear: 2025, market: 'CN', currency: 'CNY',
        years: annualYears([2017]), sourceGapYears: [],
      });
      assert.strictEqual(unregistered.status, rules.STATUS.PENDING,
        '没登记的缺口不能伪称客观不可评估');
      assert.strictEqual(unregistered.reason, 'insufficient_fiscal_history');

      const partial = rules.evaluateAnnualAnomaly({
        latestYear: 2025, market: 'CN', currency: 'CNY',
        years: annualYears([2016, 2017]), sourceGapYears: [2017],
      });
      assert.strictEqual(partial.status, rules.STATUS.PENDING,
        '只登记了一半年份时，整段仍按待补');
      assert.deepStrictEqual(partial.missingYears, [2016, 2017]);
    });

    await check('年度异常与三项名次共用同一份年度事实，登记不会只生效一路', async () => {
      const fs = require('fs');
      const pathMod = require('path');
      const svc = require('../services/stockSelectionService');
      assert.strictEqual(typeof svc.annualFactsOf, 'function', 'annualFactsOf 必须可被回归断言调用');
      const facts = svc.annualFactsOf([{ year: 2025, currency: 'CNY' }], [],
        '601528.SH', new Map([['601528.SH', new Set([2017])]]));
      assert.deepStrictEqual(facts.sourceGapYears, [2017], '登记年份必须进入年度事实');
      // 源码守卫：年度列表只允许在 annualFactsOf 内部构造一次。
      // 2026-11-08 生产事故就是「名次」和「年度异常」各造一份，登记只生效一路；
      // 按行检查抓不到旧写法（buildAnnualYears 在调用行上一行），所以按出现次数守。
      const src = fs.readFileSync(pathMod.join(__dirname, '..', 'services', 'stockSelectionService.js'), 'utf8');
      // 只统计「赋值调用」（= buildAnnualYears(...)），不把函数定义算进来。
      const rebuilds = (src.match(/=\s*buildAnnualYears\(/g) || []).length;
      assert.strictEqual(rebuilds, 1,
        'buildAnnualYears 只允许在 annualFactsOf 内调用 1 次，第二处会让登记等字段只生效一路，实际 ' + rebuilds + ' 次');
      assert.ok(src.includes('annualFactsOf(profitRows, dividendRows, item.code, ctx.sourceGaps)'),
        '年度异常必须用 annualFactsOf 构造的年度事实');
    });

    await check('同一天除息、分属两个财年的两笔不同金额分红都要算进去', async () => {
      const map = await repo.loadAnnualDividends({ companyIds: [crossYearDiff.companyId], asOfDate: AS_OF });
      const year = (map.get(String(crossYearDiff.companyId)) || []).find(row => row.year === 2024);
      assert.ok(year, '必须给出 2024 财年记录');
      assert.strictEqual(year.dividendKnown, true, '年报那笔被同日另一笔挤掉会让整年判成未知');
      // 年度金额是该财年所有已实施现金之和：中期 1 亿 + 年报 2000 万 = 1.2 亿。
      // 年报那笔被同日另一笔吞掉时会只剩 1 亿，这条断言就是抓这个。
      assert.strictEqual(Number(year.dividend), 1.2e8, '中期 1 亿与年报 2000 万都必须计入');
      assert.strictEqual(year.dividendBasis, 'annual_implemented_amount');
    });

    await check('同一天除息但金额相同的两条是同一笔重复打标，只能算一次', async () => {
      const map = await repo.loadAnnualDividends({ companyIds: [crossYearSame.companyId], asOfDate: AS_OF });
      const year = (map.get(String(crossYearSame.companyId)) || []).find(row => row.year === 2024);
      assert.ok(year, '必须给出 2024 财年记录');
      assert.strictEqual(year.dividendKnown, true);
      assert.strictEqual(Number(year.dividend), 1e8, '同一笔 1 亿既不能算两次，也不能因合并丢掉');
    });

    await check('年末纯送转（有转增无现金）算已实施，现金 0 不是金额缺失', async () => {
      const map = await repo.loadAnnualDividends({ companyIds: [pureTransfer.companyId], asOfDate: AS_OF });
      const year = (map.get(String(pureTransfer.companyId)) || []).find(row => row.year === 2024);
      assert.ok(year, '必须给出 2024 财年记录');
      assert.strictEqual(year.dividendKnown, true, '10 转 3 没有一分现金，年末这笔仍是「已实施、现金 0」');
      assert.strictEqual(Number(year.dividend), 4.78e8, '该财年现金就是中期那 4.78 亿');
      assert.strictEqual(year.dividendBasis, 'annual_implemented_amount');
    });

    await check('末期方案停摆 2 年以上、同年中期已实施 → 按已实施金额判已知', async () => {
      const map = await repo.loadAnnualDividends({ companyIds: [staleWithInterim.companyId], asOfDate: AS_OF });
      const year = (map.get(String(staleWithInterim.companyId)) || []).find(row => row.year === 2022);
      assert.ok(year, '必须给出 2022 财年记录');
      assert.strictEqual(year.dividendKnown, true, '末期不再实施时，该财年金额就是已实施的中期');
      assert.strictEqual(Number(year.dividend), 9.6e8);
      assert.strictEqual(year.dividendBasis, 'stale_plan_not_implemented');
    });
  } finally {
    try { await cleanup(pool); } catch (error) { console.error('清理夹具失败：', error.message); }
    await pool.end().catch(() => {});
  }

  const pass = tests.filter(item => item[0] === 'PASS').length;
  const fail = tests.length - pass;
  console.log(`PASS=${pass} FAIL=${fail} ERROR=0`);
  process.exit(fail ? 1 : 0);
}

main().catch(error => { console.error(error); process.exit(1); });

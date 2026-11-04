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
const CODES = [`${MARK}01.SH`, `${MARK}02.SH`, `${MARK}03.SH`, `${MARK}04.SH`, `${MARK}05.SH`];
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

async function insertAction(pool, instrumentId, sourceId, row) {
  await pool.query(
    `INSERT INTO fundamental.corporate_actions
       (instrument_id, action_type, fiscal_period_end, announced_at, ex_date, status,
        cash_per_share_pre_tax, stock_dividend_ratio, capitalization_ratio, total_cash_amount,
        currency_code, source_id, source_key)
     VALUES ($1,'dividend',$2::date,$3::date,$4::date,'实施',$5,$6,$7,$8,'CNY',$9,$10)`,
    [instrumentId, row.fiscalPeriodEnd || null, row.announcedAt || null, row.exDate,
      row.cash, row.bonus === undefined ? 0 : row.bonus, row.cap === undefined ? 0 : row.cap,
      row.total, sourceId, `${MARK}-${row.key}`]);
}

async function main() {
  const { pool } = require('../db/connection');
  const migrations = require('../db/migrations');
  await migrations.runMigrations();
  const repo = require('../repositories/stockSelectionRepository');
  const rules = require('../domain/stockSelectionRules');

  await cleanup(pool);

  const sourceRow = await pool.query(`SELECT source_id FROM ops.data_sources ORDER BY source_id LIMIT 1`);
  assert.ok(sourceRow.rows[0], '测试环境缺少 ops.data_sources');
  const sourceId = sourceRow.rows[0].source_id;

  try {
    const send = await createInstrument(pool, 0);
    const unknown = await createInstrument(pool, 1);
    const noMarket = await createInstrument(pool, 2);
    const negative = await createInstrument(pool, 3, { listDate: '2020-01-01' });
    const emptyAction = await createInstrument(pool, 4);

    // 1) 2025-12-01 派现 0.2 元/股（无送转），2026-06-15 每 10 股转增 4 股 → 1 股转增 0.4 股。
    await insertAction(pool, send.instrumentId, sourceId, { exDate: '2025-12-01', cash: 0.2, key: 'send-cash' });
    await insertAction(pool, send.instrumentId, sourceId, { exDate: '2026-06-15', cash: null, cap: 0.4, key: 'send-cap' });
    // 2) 一笔现金分红，但送转比例两项都为空 → 无法判断是否伴随送转。
    await insertAction(pool, unknown.instrumentId, sourceId, { exDate: '2026-03-01', cash: 0.3, bonus: null, cap: null, key: 'unknown-cash' });
    // 3) 有行情（用于对照"有数据的不被排除"）。
    await pool.query(
      `INSERT INTO market.daily_valuations (instrument_id, trade_date, source_id, pb, total_market_cap, currency_code)
       VALUES ($1,$2::date,$3,1.2,5e10,'CNY')`, [send.instrumentId, AS_OF, sourceId]);
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

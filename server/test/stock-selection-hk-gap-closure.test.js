// 港股剩余 3 个选股缺口的归类回归（0.9.2.21）。
// 覆盖：①港股年度分红按每股现金同口径累计（含同笔分红多来源重复登记去重）；
// ②负 PE(TTM) 是 TTM 亏损的事实，不参与 PE 排名也不计待补；③财报 0 行标的判客观不可评估。
'use strict';
const assert = require('assert');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const RULES = require('../domain/stockSelectionRules');
const TEST_CODE = '60902.HK';
const KEY_MAIN = 'hk-gap-div-main';
const KEY_FINAL = 'hk-gap-div-final';
const KEY_DUP = 'hk-gap-div-dup';

const tests = [];
async function check(name, fn) {
  try { await fn(); tests.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (error) {
    const detail = String(error && (error.stack || error.message || error)).split('\n').slice(0, 3).join(' | ');
    tests.push(['FAIL', name + ' :: ' + detail]); console.log('  [FAIL] ' + name + ' :: ' + detail);
  }
}

// 与生产 01919.HK 同形态：每股现金齐全、分红总额缺失，且同一笔被两个来源各写一行。
async function withHkDividendFixture(fn) {
  const { pool } = require('../db/connection');
  const migrations = require('../db/migrations');
  await migrations.runMigrations();
  const source = await pool.query('SELECT source_id FROM ops.data_sources ORDER BY source_id LIMIT 1');
  const sourceId = source.rows[0] && source.rows[0].source_id;
  assert.ok(sourceId, '测试库缺少 ops.data_sources 记录');

  await pool.query('DELETE FROM fundamental.corporate_actions WHERE source_key = ANY($1)', [[KEY_MAIN, KEY_FINAL, KEY_DUP]]);
  await pool.query('DELETE FROM core.instruments WHERE canonical_code=$1', [TEST_CODE]);
  const company = await pool.query(
    `INSERT INTO core.companies (legal_name, short_name, country_code, company_type)
     VALUES ($1,'HKGAP','HK','listed') RETURNING company_id`, ['港股缺口归类测试' + Date.now().toString(36)]);
  const companyId = company.rows[0].company_id;
  const instrument = await pool.query(
    `INSERT INTO core.instruments (canonical_code,name,asset_class,market,exchange_code,currency_code,list_date,status)
     VALUES ($1,'港股缺口测试','stock','HK','HKEX','HKD','2015-01-01','listed') RETURNING instrument_id`, [TEST_CODE]);
  const instrumentId = instrument.rows[0].instrument_id;
  await pool.query(
    `INSERT INTO core.company_instruments (company_id, instrument_id, relation_type, valid_from)
     VALUES ($1,$2,'issued_by','2015-01-01')`, [companyId, instrumentId]);

  // 2022—2025 四个年报到齐：只有 2025 财年有分红，更早财年无记录（应判 0 而不是未知）。
  for (const year of [2022, 2023, 2024, 2025]) {
    const report = await pool.query(
      `INSERT INTO fundamental.financial_reports
         (company_id, report_kind, period_end, period_type, statement_scope, announced_at,
          source_id, source_version, update_flag, is_current_version, report_type)
       VALUES ($1,'income',$2::date,'annual','consolidated',$3::date,$4,'v1','',true,'1') RETURNING report_id`,
      [companyId, `${year}-12-31`, `${year + 1}-03-31`, sourceId]);
    await pool.query(
      `INSERT INTO fundamental.financial_facts
         (report_id, statement_type, metric_code, numeric_value, unit_code, currency_code, source_field, is_calculated)
       VALUES ($1,'income','net_profit_parent',1e9,'HKD','HKD','n_income_attr_p',false)`, [report.rows[0].report_id]);
  }

  const insert = `INSERT INTO fundamental.corporate_actions
    (instrument_id,action_type,fiscal_period_end,announced_at,ex_date,status,
     cash_per_share_pre_tax,total_cash_amount,currency_code,source_id,source_key)
    VALUES($1,'dividend',$2::date,$3::date,$4::date,'实施',$5,NULL,'HKD',$6,$7)`;
  // 2025 财年中期 0.5 + 末期 0.3，两笔都只有每股现金（没有分红总额）。
  await pool.query(insert, [instrumentId, '2025-12-31', '2025-08-01', '2025-10-01', 0.5, sourceId, KEY_MAIN]);
  await pool.query(insert, [instrumentId, '2025-12-31', '2026-02-01', '2026-04-01', 0.3, sourceId, KEY_FINAL]);
  // 同一笔中期分红被备源再写一行：同除息日、同金额，但不带财年归属（生产 01919.HK 就是这样）。
  // 去重既要避免算两遍，也不能因为留下"没有财年"的那条而把这笔钱整笔丢掉。
  await pool.query(insert, [instrumentId, null, '2025-08-02', '2025-10-01', 0.5, sourceId, KEY_DUP]);

  try {
    await fn({ instrumentId, companyId });
  } finally {
    await pool.query('DELETE FROM fundamental.corporate_actions WHERE source_key = ANY($1)', [[KEY_MAIN, KEY_FINAL, KEY_DUP]]);
    await pool.query('DELETE FROM fundamental.financial_facts WHERE report_id IN (SELECT report_id FROM fundamental.financial_reports WHERE company_id=$1)', [companyId]);
    await pool.query('DELETE FROM fundamental.financial_reports WHERE company_id=$1', [companyId]);
    await pool.query('DELETE FROM core.company_instruments WHERE company_id=$1', [companyId]);
    await pool.query('DELETE FROM core.instruments WHERE canonical_code=$1', [TEST_CODE]);
    await pool.query('DELETE FROM core.companies WHERE company_id=$1', [companyId]);
  }
}

function facts(overrides) {
  return Object.assign({
    instrumentId: 1, code: '02039.HK', name: '测试港股', market: 'HK', companyId: 200,
    pb: 0.76, peStatic: null, peTtm: -134.16, price: 10, priceDate: '2026-09-30',
    pbWindow: { maxPb: 1.4, coveredDays: 2450, expectedDays: 2450, gapDays: 0, marketDays: 2460, calendarDays: 3650 },
    equity: { amount: 5.3e10, currency: 'HKD', periodEnd: '2026-06-30', announcedAt: '2026-08-20', reportId: 1 },
    fx: { rate: 0.9, date: '2026-06-30' },
    dividend: { ttmPerShare: 0.18, count: 1, currency: 'HKD', verifiedZero: false },
    annual: {
      latestYear: 2025,
      years: Array.from({ length: 11 }, (_, index) => ({
        year: 2015 + index, profit: 1e9, dividend: 1e8, dividendKnown: true, complete: true,
      })),
      currency: 'HKD',
    },
    industry: { code: 'H001', name: '工业', system: 'HSI', version: '2021' },
    suspended: false, delistedAtTargetDate: false, riskWarning: null,
  }, overrides || {});
}

async function main() {
  await check('港股年度分红：两笔只有每股现金也判已知，2025 财年合计 0.8，更早无记录财年判 0', async () => {
    await withHkDividendFixture(async ({ companyId }) => {
      const repo = require('../repositories/stockSelectionRepository');
      const map = await repo.loadAnnualDividends({ companyIds: [companyId], asOfDate: '2026-09-30', market: 'HK' });
      const rows = map.get(String(companyId)) || [];
      assert.ok(rows.length >= 4, `应覆盖 2022—2025 四个财年，实际 ${rows.length}`);
      const byYear = new Map(rows.map(row => [row.year, row]));
      const y2025 = byYear.get(2025);
      assert.ok(y2025, '缺少 2025 财年');
      assert.strictEqual(y2025.dividendKnown, true, '只有每股现金也必须判已知');
      assert.ok(Math.abs(y2025.dividend - 0.8) < 1e-9, `2025 财年每股现金合计应为 0.8，实际 ${y2025.dividend}`);
      assert.strictEqual(y2025.amountBasis, 'per_share');
      [2022, 2023, 2024].forEach(year => {
        const row = byYear.get(year);
        assert.ok(row, `缺少 ${year} 财年`);
        assert.strictEqual(row.dividendKnown, true, `${year} 财年无分红记录且财年已定，应判已知`);
        assert.strictEqual(row.dividend, 0, `${year} 财年应判 0`);
      });
    });
  });

  await check('去重：同一笔分红被两个来源各写一行，只算一次（0.8 而不是 1.3）', async () => {
    await withHkDividendFixture(async ({ companyId }) => {
      const { pool } = require('../db/connection');
      const dup = await pool.query(
        `SELECT count(*)::int AS n FROM fundamental.corporate_actions WHERE source_key = ANY($1) AND ex_date='2025-10-01'::date`,
        [[KEY_MAIN, KEY_DUP]]);
      assert.strictEqual(dup.rows[0].n, 2, '夹具必须真的写入两条同除息日记录');
      const repo = require('../repositories/stockSelectionRepository');
      const rows = (await repo.loadAnnualDividends({ companyIds: [companyId], asOfDate: '2026-09-30', market: 'HK' }))
        .get(String(companyId)) || [];
      const y2025 = rows.find(row => row.year === 2025);
      assert.ok(Math.abs(y2025.dividend - 0.8) < 1e-9, `重复登记不得重复计入，实际 ${y2025.dividend}`);
    });
  });

  await check('同一批数据按 A 股总额口径仍判未知（市场分流真的生效，不是一刀切放行）', async () => {
    await withHkDividendFixture(async ({ companyId }) => {
      const repo = require('../repositories/stockSelectionRepository');
      const rows = (await repo.loadAnnualDividends({ companyIds: [companyId], asOfDate: '2026-09-30', market: 'CN' }))
        .get(String(companyId)) || [];
      const y2025 = rows.find(row => row.year === 2025);
      assert.strictEqual(y2025.dividendKnown, false, '缺分红总额时 A 股口径必须保持未知');
      assert.strictEqual(y2025.dividend, null);
      assert.strictEqual(y2025.amountBasis, 'total_amount');
    });
  });

  await check('负 PE(TTM)：TTM 亏损是事实，不参与 PE 排名也不计待补；PE 缺失仍待补', () => {
    const loss = RULES.evaluateInstrument(facts({}));
    assert.strictEqual(loss.peNegative, true, '负 PE 必须留证');
    assert.strictEqual(loss.rankReady, true, '负 PE 不得把标的挡在排名外');
    assert.ok(!loss.rankBlockReasons.includes('pe_ttm_unavailable'), '负 PE 不得当成缺 PE');
    assert.strictEqual(loss.filterStatus, RULES.STATUS.PASS);
    assert.strictEqual(loss.exclusionReasons.some(item => item.code === 'RANK:pe_ttm_unavailable'), false);

    const missing = RULES.evaluateInstrument(facts({ peTtm: null }));
    assert.strictEqual(missing.rankReady, false, '真的缺 PE 仍不许排名');
    assert.ok(missing.rankBlockReasons.includes('pe_ttm_unavailable'));
  });

  await check('负 PE 在排名里按亏损处理：PE 分等于盈利股数量，负数不会因数值最小占便宜', () => {
    const pool = [
      { instrumentId: 1, code: 'A', filterStatus: RULES.STATUS.PASS, rankReady: true, currentPb: 1.2, currentPe: 8, profitStatus: 'profit', dividendYield: 0.02 },
      // B 的 PB 最贵、股息率最低，只有 PE 是负数：若拿负 PE 参与升序排名它会占便宜，必须排最后。
      { instrumentId: 2, code: 'B', filterStatus: RULES.STATUS.PASS, rankReady: true, currentPb: 1.8, currentPe: -134, profitStatus: 'profit', dividendYield: 0.005 },
      { instrumentId: 3, code: 'C', filterStatus: RULES.STATUS.PASS, rankReady: true, currentPb: 1.5, currentPe: 12, profitStatus: 'profit', dividendYield: 0.01 },
    ];
    const { ranked, profitCount } = RULES.rankCandidates(pool);
    assert.strictEqual(profitCount, 2, '只有正 PE 的两只进入 PE 排名');
    const negative = ranked.find(row => row.code === 'B');
    assert.strictEqual(negative.peRank, 2, '负 PE 的 PE 分必须等于盈利股数量');
    assert.strictEqual(ranked[ranked.length - 1].code, 'B', '负 PE 不能因为数值最小而排到前面');
  });

  await check('财报 0 行：PB 客观算不出判不可评估，不入选也不阻断发布；有财报但缺 PB 仍待补', () => {
    const noReport = RULES.evaluateInstrument(facts({
      pb: null, annual: { latestYear: null, years: [], currency: null },
      equity: {},
    }));
    assert.strictEqual(noReport.rules.R01.status, RULES.STATUS.NOT_APPLICABLE);
    assert.strictEqual(noReport.rules.R01.reason, 'pb_not_evaluable_no_report');
    assert.strictEqual(noReport.filterStatus, RULES.STATUS.NOT_APPLICABLE, '无财报标的不得再阻断整批发布');

    const hasReport = RULES.evaluateInstrument(facts({ pb: null }));
    assert.strictEqual(hasReport.rules.R01.status, RULES.STATUS.PENDING);
    assert.strictEqual(hasReport.rules.R01.reason, 'pb_unavailable');
  });

  const failed = tests.filter(item => item[0] === 'FAIL');
  console.log('\n[stock-selection-hk-gap-closure] ' + (tests.length - failed.length) + '/' + tests.length + ' passed');
  if (failed.length) process.exit(1);
}

main().catch(error => { console.error(error); process.exit(1); });

// 港股选股输入缺口闭环回归（2026-11-05 方案落地）。
// 覆盖：①港股分红按官方每股现金口径（真库 + 抽样回测 0.5+0.3=0.8），A 股行为不变；
// ②汇率客观缺失判不可评估；③港股财报年份断档判不可评估、A 股仍待补；
// ④selection_inputs 连续无进展停止续批（模拟执行器续批上下文）。
'use strict';
const assert = require('assert');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const RULES = require('../domain/stockSelectionRules');
const TEST_CODE = '60901.HK';
const KEY_A = 'hk-closure-test-a';
const KEY_B = 'hk-closure-test-b';

const tests = [];
async function check(name, fn) {
  try { await fn(); tests.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (error) {
    const detail = String(error && (error.stack || error.message || error)).split('\n').slice(0, 3).join(' | ');
    tests.push(['FAIL', name + ' :: ' + detail]); console.log('  [FAIL] ' + name + ' :: ' + detail);
  }
}

function stub(relativePath, exports) {
  const resolved = require.resolve(relativePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

async function withDividendFixtures(fn) {
  const { pool } = require('../db/connection');
  const migrations = require('../db/migrations');
  await migrations.runMigrations();
  const source = await pool.query('SELECT source_id FROM ops.data_sources ORDER BY source_id LIMIT 1');
  const sourceId = source.rows[0] && source.rows[0].source_id;
  assert.ok(sourceId, '测试库缺少 ops.data_sources 记录');
  await pool.query('DELETE FROM fundamental.corporate_actions WHERE source_key = ANY($1)', [[KEY_A, KEY_B]]);
  await pool.query('DELETE FROM core.instruments WHERE canonical_code=$1', [TEST_CODE]);
  const inst = await pool.query(
    `INSERT INTO core.instruments(canonical_code,name,asset_class,market,exchange_code,currency_code,status)
     VALUES($1,$2,'stock','HK','HKEX','HKD','listed') RETURNING instrument_id`, [TEST_CODE, '港股分红口径测试']);
  const instrumentId = inst.rows[0].instrument_id;
  const insert = `INSERT INTO fundamental.corporate_actions
    (instrument_id,action_type,fiscal_period_end,announced_at,record_date,ex_date,pay_date,status,
     cash_per_share_pre_tax,cash_per_share_after_tax,stock_dividend_ratio,capitalization_ratio,
     base_shares,total_cash_amount,currency_code,source_id,source_key,raw_payload)
    VALUES($1,'dividend',$2::date,$3::date,NULL,$4::date,NULL,$5,$6,NULL,NULL,NULL,NULL,NULL,'HKD',$7,$8,$9::jsonb)`;
  await pool.query(insert, [instrumentId, '2025-12-31', '2026-03-01', '2026-04-01', '实施', 0.5, sourceId, KEY_A, '{}']);
  await pool.query(insert, [instrumentId, '2026-06-30', '2026-08-01', '2026-09-01', '实施', 0.3, sourceId, KEY_B, '{}']);
  try {
    await fn(instrumentId);
  } finally {
    await pool.query('DELETE FROM fundamental.corporate_actions WHERE source_key = ANY($1)', [[KEY_A, KEY_B]]);
    await pool.query('DELETE FROM core.instruments WHERE canonical_code=$1', [TEST_CODE]);
  }
}

async function main() {
  await check('港股分红：源未返回送转比例时按官方每股现金直接累计，抽样回测 0.5+0.3=0.8', async () => {
    await withDividendFixtures(async instrumentId => {
      const repo = require('../repositories/stockSelectionRepository');
      const input = { instrumentIds: [instrumentId], windowStart: '2025-09-30', asOfDate: '2026-09-30' };
      const hk = await repo.loadDividendWindow({ ...input, market: 'HK' });
      const row = hk.get(String(instrumentId));
      assert.ok(row, '港股分红窗口应返回该证券');
      assert.strictEqual(row.shareUnitUnverified, false, '港股不得因送转比例缺失标未核验');
      assert.strictEqual(row.shareUnitBasis, 'official_per_share_hk');
      assert.ok(Math.abs(row.ttmPerShare - 0.8) < 1e-9, `TTM 每股现金应等于 0.8，实际 ${row.ttmPerShare}`);
      assert.strictEqual(row.adjustmentFactor, 1, '港股不做 A 股式送转折算');
    });
  });

  await check('A 股分红：两项送转比例都为空仍判未核验（原口径不变）', async () => {
    await withDividendFixtures(async instrumentId => {
      const repo = require('../repositories/stockSelectionRepository');
      const input = { instrumentIds: [instrumentId], windowStart: '2025-09-30', asOfDate: '2026-09-30' };
      const cn = await repo.loadDividendWindow({ ...input, market: 'CN' });
      const row = cn.get(String(instrumentId));
      assert.strictEqual(row.shareUnitUnverified, true);
      assert.strictEqual(row.shareUnitBasis, 'verified_split_ratio');
    });
  });

  await check('港股分红：源端若真的下发送转比例，仍按同一套因子折算，不因市场被跳过', async () => {
    await withDividendFixtures(async instrumentId => {
      const { pool } = require('../db/connection');
      // 模拟将来港股端点（或其它合规来源）给出送转比例：10 送 5，作用在 2026-04-01 这笔上。
      await pool.query('UPDATE fundamental.corporate_actions SET stock_dividend_ratio=0.5 WHERE source_key=$1', [KEY_A]);
      const repo = require('../repositories/stockSelectionRepository');
      const input = { instrumentIds: [instrumentId], windowStart: '2025-09-30', asOfDate: '2026-09-30' };
      const row = (await repo.loadDividendWindow({ ...input, market: 'HK' })).get(String(instrumentId));
      const expected = 0.3 + 0.5 / 1.5;
      assert.ok(Math.abs(row.ttmPerShare - expected) < 1e-9, `TTM 每股现金应等于 ${expected}，实际 ${row.ttmPerShare}`);
      assert.strictEqual(row.adjustmentFactor, 1.5, '送转因子必须生效');
      assert.strictEqual(row.shareUnitBasis, 'verified_split_ratio', '有比例的留证不得再写成港股现金口径');
      assert.strictEqual(row.shareUnitUnverified, false);
    });
  });

  await check('R05：非 CNY 记账且无历史汇率判不可评估，不进补数队列；CNY 行为不变', () => {
    const missing = RULES.evaluateEquity({ equity: { amount: 1e11, currency: 'USD', periodEnd: '2025-12-31' }, fx: {} }, RULES.DEFAULT_PARAMS);
    assert.strictEqual(missing.rule.status, RULES.STATUS.NOT_APPLICABLE);
    assert.strictEqual(missing.rule.reason, 'fx_unavailable_not_evaluable');
    const cny = RULES.evaluateEquity({ equity: { amount: 5e10, currency: 'CNY', periodEnd: '2025-12-31' }, fx: {} }, RULES.DEFAULT_PARAMS);
    assert.ok([RULES.STATUS.PASS, RULES.STATUS.FAIL].includes(cny.rule.status), 'CNY 仍应给出明确通过/不通过');
  });

  await check('年度异常：港股财报年份断档判不可评估，A 股仍判待补', () => {
    const years = Array.from({ length: 11 }, (_, i) => ({
      year: 2015 + i, profit: 1e9, dividend: 1e8, dividendKnown: true, complete: true,
    })).filter(row => row.year !== 2020);
    const hk = RULES.evaluateAnnualAnomaly({ latestYear: 2025, years, market: 'HK' });
    assert.strictEqual(hk.status, RULES.STATUS.NOT_APPLICABLE);
    assert.strictEqual(hk.reason, 'fiscal_history_gap_not_evaluable_hk');
    const cn = RULES.evaluateAnnualAnomaly({ latestYear: 2025, years });
    assert.strictEqual(cn.status, RULES.STATUS.PENDING);
    assert.strictEqual(cn.reason, 'insufficient_fiscal_history');
  });

  await check('selection_inputs：连续两批剩余不下降即停止自动续批；下降则继续', async () => {
    const calls = [];
    stub('../services/stockSelectionInputsSync', {
      syncSelectionInputs: async options => {
        calls.push(options);
        return {
          ok: false, status: 'partial', reason: 'selection_inputs_gaps_pending',
          processed: 120, succeeded: 120, remainingFinancial: 448,
          remainingIndustry: 0, remainingValuation: 0, remainingUnclassified: 0,
        };
      },
    });
    // 保留真实导出的 DATA_DIR：server/config.js 会解构它，stub 时漏掉会让 path.join 收到 undefined。
    const realDb = require('../db');
    stub('../db', {
      ...realDb,
      tryClaimJob: async () => true, releaseJob: async () => {},
      startJobRun: async () => 1, finishJobRun: async () => {},
    });
    const servicePath = require.resolve('../services/companyFinancialIncrementalSync');
    delete require.cache[servicePath];
    const service = require(servicePath);
    const base = { mode: 'selection_inputs', market: 'HK', targetTradeDate: '2026-09-30' };
    const first = await service.runCompanyFinancialIncrementalSync('test', base);
    assert.strictEqual(calls.length, 1, '应调用被 stub 的选股补齐入口');
    assert.strictEqual(first.remaining, 448);
    assert.strictEqual(first.noProgressCount, 1);
    assert.ok(!first.continuationBlocked, '首批不应停止');
    const second = await service.runCompanyFinancialIncrementalSync('test', {
      ...base, noProgressCount: first.noProgressCount, lastRemaining: first.lastRemaining,
      initialRemaining: first.initialRemaining, continuationStartedAt: first.continuationStartedAt,
    });
    assert.strictEqual(second.noProgressCount, 2);
    assert.strictEqual(second.continuationBlocked, true, '连续两批无进展必须停止续批');
    assert.match(second.continuationStopReason, /连续两批/);
    assert.strictEqual(second.continuationRequired, true, '仍由执行器按 continuationBlocked 标 blocked');

    // 剩余下降时不得误停：上一批剩余 500，本批 448。
    const progressed = await service.runCompanyFinancialIncrementalSync('test', {
      ...base, noProgressCount: 1, lastRemaining: 500, initialRemaining: 500,
    });
    assert.strictEqual(progressed.noProgressCount, 0);
    assert.ok(!progressed.continuationBlocked, '剩余下降应允许继续续批');
  });

  const failed = tests.filter(item => item[0] === 'FAIL');
  console.log(`\nstock-selection-hk-input-closure: ${tests.length - failed.length}/${tests.length} 通过`);
  if (failed.length) process.exitCode = 1;
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });

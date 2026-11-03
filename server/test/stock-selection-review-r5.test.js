// 投资策略选股中心：五轮独立核查（R5-01—R5-03）回归反例。
// 对应《投资策略选股中心研发方案_20261102》第 24.2 节。
// 真库段（R5-02/R5-03）只在显式设置 STOCK_SELECTION_R5_DB=1 时运行，未设置时如实跳过。
'use strict';
const assert = require('assert');
const path = require('path');

const tests = [];
async function check(name, fn) {
  try { await fn(); tests.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (error) {
    const detail = error && (error.stack || error.message || String(error));
    const summary = String(detail).split('\n').slice(0, 3).join(' | ');
    tests.push(['FAIL', name + ' :: ' + summary]);
    console.log('  [FAIL] ' + name + ' :: ' + summary);
  }
}

function stub(relativePath, exports) {
  const resolved = require.resolve(relativePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
function dropCache(relativePath) {
  try { delete require.cache[require.resolve(relativePath)]; } catch (_) { /* 未加载过 */ }
}

async function main() {
  await runR501();
  await runDatabaseChecks();
  const pass = tests.filter(item => item[0] === 'PASS').length;
  const fail = tests.length - pass;
  console.log(`PASS=${pass} FAIL=${fail}`);
  process.exit(fail ? 1 : 0);
}

// ===================== R5-01：计数不得按条数截断 =====================
async function runR501() {
  await check('R5-01 2000 边界两侧都保留全部计数，不被截断', async () => {
    for (const size of [1999, 2000, 2001]) {
      const gaps = buildGaps(size);
      const store = gapQueueStore();
      // 预置"前 size-1 只各尝试 1 次，最后一只 0 次"（首轮遍历后可达的状态）。
      store.seed('CN', seedPayload(gaps, gaps.slice(0, -1)));
      const sync = loadInputsSync(store, gaps);
      sync.__setIndustry(async () => { throw new Error('controlled_failure'); });
      await sync.syncSelectionInputs({ market: 'CN', asOfDate: '2026-09-30', batchLimit: 1 });
      assert.strictEqual(sync.__lastRequest(), gaps[gaps.length - 1].code,
        `size=${size}：本轮必须选中计数为 0 的尾部对象`);
      const saved = store.rows.get('CN');
      assert.strictEqual(Object.keys(saved.lastRun.attempts || {}).length, size,
        `size=${size}：计数必须覆盖全部未完成对象（不得按条数截断）`);
    }
  });

  await check('R5-01 尾部多个对象依次获得机会，不反复撞同一只', async () => {
    const gaps = buildGaps(2005);
    const store = gapQueueStore();
    store.seed('CN', seedPayload(gaps, gaps.slice(0, 2000)));
    const sync = loadInputsSync(store, gaps);
    sync.__setIndustry(async () => { throw new Error('controlled_failure'); });
    const sequence = [];
    for (let round = 0; round < 5; round++) {
      await sync.syncSelectionInputs({ market: 'CN', asOfDate: '2026-09-30', batchLimit: 1 });
      sequence.push(sync.__lastRequest());
    }
    assert.deepStrictEqual(sequence, gaps.slice(2000).map(gap => gap.code),
      '尾部 5 只必须依次被尝试，而不是同一只反复重试');
    assert.strictEqual(new Set(sequence).size, 5);
  });

  await check('R5-01 全轮次重试覆盖不同对象（不是每只只碰一次）', async () => {
    const gaps = buildGaps(2001);
    const store = gapQueueStore();
    store.seed('CN', seedPayload(gaps, gaps));
    const sync = loadInputsSync(store, gaps);
    sync.__setIndustry(async () => { throw new Error('controlled_failure'); });
    const sequence = [];
    for (let round = 0; round < 6; round++) {
      await sync.syncSelectionInputs({ market: 'CN', asOfDate: '2026-09-30', batchLimit: 1 });
      sequence.push(sync.__lastRequest());
    }
    assert.deepStrictEqual(sequence, gaps.slice(0, 6).map(gap => gap.code),
      '全部对象都已尝试 1 次时，必须按审计顺序逐只重试，不得重复同一只');
  });

  await check('R5-01 重启后仍按持久计数轮转（2001 只）', async () => {
    const gaps = buildGaps(2001);
    const store = gapQueueStore();
    store.seed('CN', seedPayload(gaps, gaps.slice(0, 2000)));
    let sync = loadInputsSync(store, gaps);
    sync.__setIndustry(async () => { throw new Error('controlled_failure'); });
    await sync.syncSelectionInputs({ market: 'CN', asOfDate: '2026-09-30', batchLimit: 1 });
    assert.strictEqual(sync.__lastRequest(), gaps[2000].code);
    // 模拟重启：清缓存重载模块，队列与计数都在持久介质里。
    sync = loadInputsSync(store, gaps);
    sync.__setIndustry(async () => { throw new Error('controlled_failure'); });
    await sync.syncSelectionInputs({ market: 'CN', asOfDate: '2026-09-30', batchLimit: 1 });
    assert.strictEqual(sync.__lastRequest(), gaps[0].code, '重启后应回到计数最小的第一只，而不是继续撞尾部');
  });

  await check('R5-01 部分成功后只保留仍待补对象的计数', async () => {
    const gaps = buildGaps(3);
    const store = gapQueueStore();
    store.seed('CN', seedPayload(gaps, gaps));
    // 第 2 只在补齐后从缺口里消失，其余两只仍在。
    const sync = loadInputsSync(store, [gaps[0], gaps[2]]);
    sync.__setIndustry(async () => { throw new Error('controlled_failure'); });
    await sync.syncSelectionInputs({ market: 'CN', asOfDate: '2026-09-30', batchLimit: 1 });
    const saved = store.rows.get('CN');
    const keys = Object.keys(saved.lastRun.attempts || {});
    assert.strictEqual(keys.length, 2, '已补齐对象的计数要丢弃，其余保留');
    assert.ok(!keys.includes(gaps[1].code));
  });
}

function buildGaps(size) {
  return Array.from({ length: size }, (_, index) => ({
    code: `6${String(10001 + index).padStart(5, '0')}.SH`,
    name: '样本' + index,
    companyId: 100 + index,
    domains: ['industry'],
    reasons: ['industry_unverified'],
  }));
}

function seedPayload(gaps, attemptedGaps) {
  const attempts = {};
  attemptedGaps.forEach(gap => { attempts[gap.code] = 1; });
  return {
    market: 'CN', asOfDate: '2026-09-30', generatedAt: 'x', universeCount: gaps.length,
    gapCount: gaps.length, domainCounts: {}, coverage: { universeCount: gaps.length }, quality: {},
    gaps, truncated: false, lastRun: { attempts, failedCodes: [], deferredCodes: [] },
  };
}

/** 与真实 sync_cursors 一致：同一 market 只有一条记录，写入即整体替换。 */
function gapQueueStore() {
  const rows = new Map();
  return {
    rows,
    seed(market, payload) { rows.set(market, JSON.parse(JSON.stringify(payload))); },
    async saveInputGapQueue({ market, payload }) { rows.set(market, JSON.parse(JSON.stringify(payload))); return 1; },
    async readInputGapQueue({ market }) {
      const payload = rows.get(market);
      return payload ? { cursor_payload: JSON.parse(JSON.stringify(payload)), last_attempt_at: new Date() } : null;
    },
  };
}

function loadInputsSync(store, gaps) {
  let industryBehavior = async () => { throw new Error('not_configured'); };
  stub(path.join(__dirname, '..', 'services', 'stockSelectionService'), {
    auditInputs: async ({ market }) => {
      const payload = {
        market, asOfDate: '2026-09-30', generatedAt: 'x', universeCount: gaps.length, gapCount: gaps.length,
        domainCounts: {}, coverage: { universeCount: gaps.length }, quality: {}, gaps, truncated: false,
      };
      await store.saveInputGapQueue({ market, payload });
      return Object.assign({ queueId: 1 }, payload);
    },
  });
  stub(path.join(__dirname, '..', 'repositories', 'stockSelectionRepository'), {
    saveInputGapQueue: store.saveInputGapQueue,
    readInputGapQueue: store.readInputGapQueue,
    findInstrumentMeta: async () => null,
  });
  const marketDatasets = require('../dataAccess/marketDatasets');
  const requests = [];
  marketDatasets.readIndustryClassification = async ({ tsCode }) => {
    requests.push(tsCode);
    return industryBehavior(tsCode);
  };
  marketDatasets.readFinancialReportRows = async () => null;
  marketDatasets.readDividendRows = async () => null;
  require('../repositories/industryRepository').upsertIndustryPath = async () => {};
  dropCache('../services/stockSelectionInputsSync');
  const sync = require('../services/stockSelectionInputsSync');
  sync.__setIndustry = fn => { industryBehavior = fn; };
  sync.__lastRequest = () => requests[requests.length - 1];
  return sync;
}

// ===================== 真库段（R5-02 / R5-03） =====================
async function runDatabaseChecks() {
  if (String(process.env.STOCK_SELECTION_R5_DB || '') !== '1') {
    console.log('  [SKIP] R5 真库反例（未设置 STOCK_SELECTION_R5_DB=1）');
    return;
  }
  require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
  const { pool } = require('../db/connection');
  const migrations = require('../db/migrations');

  await check('R5-02 真库：未来才可见的年报版本不得改变旧季度分红判定', async () => {
    await migrations.runMigrations();
    delete require.cache[require.resolve('../repositories/stockSelectionRepository')];
    delete require.cache[require.resolve('../services/stockSelectionService')];
    const repo = require('../repositories/stockSelectionRepository');
    const service = require('../services/stockSelectionService');
    const RULES = require('../domain/stockSelectionRules');
    const asOfDate = '2026-09-30';
    const cutoff = new Date('2026-09-30T15:00:00+08:00');
    let companyId = null; let instrumentId = null;
    try {
      const source = await pool.query(`SELECT source_id FROM ops.data_sources ORDER BY source_id LIMIT 1`);
      const sourceId = source.rows[0] ? source.rows[0].source_id : null;
      const company = await pool.query(
        `INSERT INTO core.companies (legal_name, short_name, country_code, company_type) VALUES ($1,$2,'CN','listed') RETURNING company_id`,
        ['R5未来证据公司' + Date.now().toString(36), 'R5F']);
      companyId = company.rows[0].company_id;
      const instrument = await pool.query(
        `INSERT INTO core.instruments (canonical_code, name, asset_class, market, exchange_code, currency_code, list_date, status)
         VALUES ('609913.SH','R5未来证据','stock','CN','SSE','CNY','2010-01-01','listed') RETURNING instrument_id`);
      instrumentId = instrument.rows[0].instrument_id;
      await pool.query(`INSERT INTO core.company_instruments (company_id, instrument_id, relation_type, valid_from) VALUES ($1,$2,'issued_by','2010-01-01')`, [companyId, instrumentId]);
      // 11 个财年利润（2015—2025），外加分红：除 2018 外每年年末已实施、金额 1 亿；2018 只有 9-30 期末现金记录。
      for (let year = 2015; year <= 2025; year++) {
        const report = await pool.query(
          `INSERT INTO fundamental.financial_reports
             (company_id, report_kind, period_end, period_type, statement_scope, announced_at, source_id, source_version, update_flag, is_current_version, report_type)
           VALUES ($1,'income',$2::date,'annual','consolidated',$3::date,$4,'v1','',true,'1') RETURNING report_id`,
          [companyId, `${year}-12-31`, `${year + 1}-03-31`, sourceId]);
        await pool.query(
          `INSERT INTO fundamental.financial_facts (report_id, statement_type, metric_code, numeric_value, unit_code, currency_code, source_field, is_calculated)
           VALUES ($1,'income','net_profit_parent',1e9,'CNY','CNY','n_income_attr_p',false)`, [report.rows[0].report_id]);
        if (year === 2018) continue;
        await pool.query(
          `INSERT INTO fundamental.corporate_actions (instrument_id, action_type, fiscal_period_end, announced_at, ex_date, status, cash_per_share_pre_tax, total_cash_amount, currency_code, source_id, source_key)
           VALUES ($1,'dividend',$2::date,$3::date,$4::date,'实施',0.5,1e8,'CNY',$5,$6)`,
          [instrumentId, `${year}-12-31`, `${year + 1}-05-01`, `${year + 1}-06-15`, sourceId, `R5F-DIV-${year}`]);
      }
      // 2018 只有 9-30 期末现金记录（不是该财年实际年报期末）→ 中期，未知。
      await pool.query(
        `INSERT INTO fundamental.corporate_actions (instrument_id, action_type, fiscal_period_end, announced_at, ex_date, status, cash_per_share_pre_tax, total_cash_amount, currency_code, source_id, source_key)
         VALUES ($1,'dividend','2018-09-30','2018-11-01','2018-12-01','实施',0.5,1e8,'CNY',$2,'R5F-DIV-2018-INTERIM')`, [instrumentId, sourceId]);

      const profits = await repo.loadAnnualProfits({ companyIds: [companyId], asOfDate, availableBefore: cutoff });
      const before = await repo.loadAnnualDividends({ companyIds: [companyId], asOfDate, availableBefore: cutoff });
      const beforeRow = (before.get(String(companyId)) || []).find(row => row.year === 2018);
      assert.strictEqual(beforeRow.dividendKnown, false, '只有中期记录时 2018 必须是未知');
      assert.strictEqual(beforeRow.dividendBasis, 'interim_only');
      const beforeYears = service.buildAnnualYears(profits.get(String(companyId)) || [], before.get(String(companyId)) || []);
      const beforeAnomaly = RULES.evaluateAnnualAnomaly({ latestYear: 2025, years: beforeYears });
      assert.strictEqual(beforeAnomaly.status, RULES.STATUS.PENDING, '没有 2018 年末证据时必须待补');

      // 新增一份"目标日之后才可取到"的 2018-09-30 年末年报（公告在目标日之前）。
      const future = await pool.query(
        `INSERT INTO fundamental.financial_reports
           (company_id, report_kind, period_end, period_type, statement_scope, announced_at, available_at, availability_basis, source_id, source_version, update_flag, is_current_version, report_type)
         VALUES ($1,'income','2018-09-30','annual','consolidated','2019-03-01','2026-10-15T00:00:00Z','revision',$2,'v2','',true,'1') RETURNING report_id`,
        [companyId, sourceId]);
      await pool.query(
        `INSERT INTO fundamental.financial_facts (report_id, statement_type, metric_code, numeric_value, unit_code, currency_code, source_field, is_calculated)
         VALUES ($1,'income','net_profit_parent',1e9,'CNY','CNY','n_income_attr_p',false)`, [future.rows[0].report_id]);

      const profitsAfter = await repo.loadAnnualProfits({ companyIds: [companyId], asOfDate, availableBefore: cutoff });
      const afterFuture = await repo.loadAnnualDividends({ companyIds: [companyId], asOfDate, availableBefore: cutoff });
      const afterRow = (afterFuture.get(String(companyId)) || []).find(row => row.year === 2018);
      assert.strictEqual(afterRow.dividendKnown, false,
        '未来才可见的年报不得把旧季度分红从待补变成通过');
      assert.strictEqual(afterRow.dividendBasis, 'interim_only');
      const afterYears = service.buildAnnualYears(profitsAfter.get(String(companyId)) || [], afterFuture.get(String(companyId)) || []);
      const afterAnomaly = RULES.evaluateAnnualAnomaly({ latestYear: 2025, years: afterYears });
      assert.strictEqual(afterAnomaly.status, RULES.STATUS.PENDING, '未来版本存在时结论必须与不存在时相同');

      // 对照：把可用时间提前到目标日之前 → 该版本才成为可见证据，结论随之改变。
      await pool.query(`UPDATE fundamental.financial_reports SET available_at='2026-09-29T00:00:00Z' WHERE report_id=$1`, [future.rows[0].report_id]);
      const visible = await repo.loadAnnualDividends({ companyIds: [companyId], asOfDate, availableBefore: cutoff });
      const visibleRow = (visible.get(String(companyId)) || []).find(row => row.year === 2018);
      assert.strictEqual(visibleRow.dividendKnown, true, '到达可见时间后必须参与判定');
      assert.strictEqual(visibleRow.dividendBasis, 'annual_implemented_amount');
      const visibleYears = service.buildAnnualYears(profitsAfter.get(String(companyId)) || [], visible.get(String(companyId)) || []);
      assert.strictEqual(RULES.evaluateAnnualAnomaly({ latestYear: 2025, years: visibleYears }).status, RULES.STATUS.PASS);
    } finally {
      if (companyId) {
        await pool.query(`DELETE FROM fundamental.financial_facts WHERE report_id IN (SELECT report_id FROM fundamental.financial_reports WHERE company_id=$1)`, [companyId]).catch(() => {});
        await pool.query(`DELETE FROM fundamental.financial_reports WHERE company_id=$1`, [companyId]).catch(() => {});
      }
      if (instrumentId) {
        await pool.query(`DELETE FROM fundamental.corporate_actions WHERE instrument_id=$1`, [instrumentId]).catch(() => {});
        await pool.query(`DELETE FROM core.company_instruments WHERE instrument_id=$1`, [instrumentId]).catch(() => {});
        await pool.query(`DELETE FROM core.instruments WHERE instrument_id=$1`, [instrumentId]).catch(() => {});
      }
      if (companyId) await pool.query(`DELETE FROM core.companies WHERE company_id=$1`, [companyId]).catch(() => {});
    }
  });

  await check('R5-03 真库：完成批次被 20 条更新批次挤出首页后仍能去重', async () => {
    delete require.cache[require.resolve('../repositories/stockSelectionRepository')];
    delete require.cache[require.resolve('../services/stockSelectionService')];
    const repo = require('../repositories/stockSelectionRepository');
    const service = require('../services/stockSelectionService');
    const strategyCode = 'r5_dedup_fixture';
    let strategyId = null;
    try {
      strategyId = await repo.upsertStrategy(pool, {
        strategyCode, market: 'CN', version: 'r5-v1', formulaVersion: 'f', adapterVersion: 'a',
        riskVersion: 'r', industryVersion: 'i', effectiveFrom: '2026-09-30',
        parameters: { fixture: true }, contentHash: 'r5-fixture-hash',
      });
      const insertRun = async ({ revision, businessStatus, publishedAt = null, inputHash }) => {
        await pool.query(
          `INSERT INTO analytics.stock_selection_runs
             (strategy_id, market, run_kind, owner_username, quarter, as_of_date, knowledge_cutoff,
              execution_status, quality_status, business_status, input_hash, input_manifest, revision, published_at)
           VALUES ($1,'CN','quarterly',NULL,'2026Q3','2026-09-30','2026-09-30T15:00:00+08:00',
                   'succeeded','partial',$2,$3,'{}'::jsonb,$4,$5)`,
          [strategyId, businessStatus, inputHash, revision, publishedAt]);
      };
      // 先放一条正常关闭的完成批次（run_id 最小 → 列表里排最后），再放 20 条更新的部分批次。
      await insertRun({ revision: 1, businessStatus: 'market_closed', inputHash: 'hash-done' });
      for (let index = 0; index < 20; index++) {
        await insertRun({ revision: index + 2, businessStatus: 'insufficient_data', inputHash: `hash-partial-${index}` });
      }
      const page = await repo.listRuns({ market: 'CN', quarter: '2026Q3', kind: 'quarterly', ownerUsername: null, limit: 20, offset: 0 });
      assert.ok(page.total >= 21, '夹具应超过一页');
      assert.ok(!page.rows.some(row => row.business_status === 'market_closed'),
        '完成批次确实被挤出第一页（本用例的前提）');
      assert.strictEqual(await repo.hasCompletedQuarterRun({ market: 'CN', quarter: '2026Q3' }), true,
        '存在性查询必须看到分页之外的完成批次');
      assert.strictEqual(await service.hasCompletedQuarter({ market: 'CN', quarter: '2026Q3' }), true);

      // 真实入队：已有完成终态 → 不再新建槽。
      const enqueued = await enqueueWithRealService(service, 'CN');
      assert.deepStrictEqual(enqueued.filter(item => item.payload.market === 'CN'), [],
        'CN 已有完成终态，不得重复排队');
    } finally {
      if (strategyId) {
        await pool.query(`DELETE FROM analytics.stock_selection_runs WHERE strategy_id=$1`, [strategyId]).catch(() => {});
        await pool.query(`DELETE FROM analytics.stock_selection_strategies WHERE strategy_id=$1`, [strategyId]).catch(() => {});
      }
    }
  });

  await check('R5-03 真库：只有部分/失败批次时必须继续排队', async () => {
    delete require.cache[require.resolve('../repositories/stockSelectionRepository')];
    delete require.cache[require.resolve('../services/stockSelectionService')];
    const repo = require('../repositories/stockSelectionRepository');
    const service = require('../services/stockSelectionService');
    const strategyCode = 'r5_dedup_partial_only';
    let strategyId = null;
    try {
      strategyId = await repo.upsertStrategy(pool, {
        strategyCode, market: 'CN', version: 'r5-v1', formulaVersion: 'f', adapterVersion: 'a',
        riskVersion: 'r', industryVersion: 'i', effectiveFrom: '2026-09-30',
        parameters: { fixture: true }, contentHash: 'r5-partial-hash',
      });
      for (let index = 0; index < 25; index++) {
        await pool.query(
          `INSERT INTO analytics.stock_selection_runs
             (strategy_id, market, run_kind, owner_username, quarter, as_of_date, knowledge_cutoff,
              execution_status, quality_status, business_status, input_hash, input_manifest, revision)
           VALUES ($1,'CN','quarterly',NULL,'2026Q3','2026-09-30','2026-09-30T15:00:00+08:00',
                   'succeeded','partial','insufficient_data',$2,'{}'::jsonb,$3)`,
          [strategyId, `partial-${index}`, index + 1]);
      }
      assert.strictEqual(await service.hasCompletedQuarter({ market: 'CN', quarter: '2026Q3' }), false,
        '只有部分批次不算完成');
      const enqueued = await enqueueWithRealService(service, 'CN');
      assert.ok(enqueued.some(item => item.payload.market === 'CN'), '未完成季度必须重新排队');
    } finally {
      if (strategyId) {
        await pool.query(`DELETE FROM analytics.stock_selection_runs WHERE strategy_id=$1`, [strategyId]).catch(() => {});
        await pool.query(`DELETE FROM analytics.stock_selection_strategies WHERE strategy_id=$1`, [strategyId]).catch(() => {});
      }
      await pool.end().catch(() => {});
    }
  });
}

/** 用真实服务（含真实仓储去重）+ 替身入队入口跑一次自动排队。 */
async function enqueueWithRealService(service, market) {
  const enqueued = [];
  stub(path.join(__dirname, '..', 'services', 'stockSelectionService.js'), service);
  stub(path.join(__dirname, '..', 'services', 'jobScheduleSlots.js'), {
    enqueueManualJob: async (code, payload) => { enqueued.push({ code, payload }); return { slot_id: enqueued.length }; },
  });
  dropCache('../jobs/stockAnalysisRefresh');
  const refresh = require('../jobs/stockAnalysisRefresh');
  await refresh.enqueueDueSelectionQuarters(new Date('2026-10-05T02:00:00Z'));
  return enqueued;
}

main().catch(error => {
  console.error(error && (error.stack || error.message));
  process.exit(1);
});

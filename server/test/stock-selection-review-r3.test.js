// 投资策略选股中心：三轮独立核查（R3-01—R3-04）回归反例。
// 每个用例对应《投资策略选股中心研发方案_20261102》第 20.2 节的一条反例，
// 断言"整改之后"的精确行为；真实 Runner、真实 sync 与真实槽位门禁都被直接调用，
// 只替换数据库记账、外采结果与审计持久化介质，不连数据库、不调外部源、不发 HTTP。
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

const RULES = require('../domain/stockSelectionRules');
function stub(relativePath, exports) {
  const resolved = require.resolve(relativePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
function dropCache(relativePath) {
  try { delete require.cache[require.resolve(relativePath)]; } catch (_) { /* 未加载过 */ }
}

async function main() {
  await runR301();
  await runR302();
  await runR303();
  await runR303Database();
  await runR304();
  const pass = tests.filter(item => item[0] === 'PASS').length;
  const fail = tests.length - pass;
  console.log(`PASS=${pass} FAIL=${fail}`);
  process.exit(fail ? 1 : 0);
}

/**
 * R3-03 真库反例：真实 SQL → 年度事实构造 → 年度异常规则。
 * 只在显式设置 STOCK_SELECTION_R3_DB=1 时运行（需要本机 PostgreSQL），
 * 未设置时如实跳过，绝不冒充通过。夹具全部用 R3TEST 前缀并在 finally 清理。
 */
async function runR303Database() {
  if (String(process.env.STOCK_SELECTION_R3_DB || '') !== '1') {
    console.log('  [SKIP] R3-03 真库反例（未设置 STOCK_SELECTION_R3_DB=1 或未连数据库）');
    return;
  }
  await check('R3-03 真库：只有预案或总额缺失的年份不得被读成已知零分红', async () => {
    require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
    const { pool } = require('../db/connection');
    const migrations = require('../db/migrations');
    await migrations.runMigrations();
    // 前面的进程内用例把仓储与服务放进了替身缓存：真库段必须重新加载真实模块。
    delete require.cache[require.resolve('../repositories/stockSelectionRepository')];
    delete require.cache[require.resolve('../services/stockSelectionService')];
    const repo = require('../repositories/stockSelectionRepository');
    const service = require('../services/stockSelectionService');
    const code = '609902.SH';
    const companyName = 'R3分红取证公司' + Date.now().toString(36);
    let companyId = null;
    let instrumentId = null;
    try {
      const source = await pool.query(`SELECT source_id FROM ops.data_sources ORDER BY source_id LIMIT 1`);
      const sourceId = source.rows[0] ? source.rows[0].source_id : null;
      const company = await pool.query(
        `INSERT INTO core.companies (legal_name, short_name, country_code, company_type) VALUES ($1,$2,'CN','listed') RETURNING company_id`,
        [companyName, 'R3TEST']);
      companyId = company.rows[0].company_id;
      const instrument = await pool.query(
        `INSERT INTO core.instruments (canonical_code, name, asset_class, market, exchange_code, currency_code, list_date, status)
         VALUES ($1,'R3分红测试','stock','CN','SSE','CNY','2010-01-01','listed') RETURNING instrument_id`, [code]);
      instrumentId = instrument.rows[0].instrument_id;
      await pool.query(
        `INSERT INTO core.company_instruments (company_id, instrument_id, relation_type, valid_from) VALUES ($1,$2,'issued_by','2010-01-01')`,
        [companyId, instrumentId]);
      // 2015—2025 年利润各 10 亿；其余 10 年现金分红各 1 亿（年末已实施且金额已知）。
      for (let year = 2015; year <= 2025; year++) {
        const report = await pool.query(
          `INSERT INTO fundamental.financial_reports
             (company_id, report_kind, period_end, period_type, statement_scope, announced_at, source_id, source_version, update_flag, is_current_version, report_type)
           VALUES ($1,'income',$2::date,'annual','consolidated',$3::date,$4,'v1','',true,'1') RETURNING report_id`,
          [companyId, `${year}-12-31`, `${year + 1}-03-31`, sourceId]);
        await pool.query(
          `INSERT INTO fundamental.financial_facts (report_id, statement_type, metric_code, numeric_value, unit_code, currency_code, source_field, is_calculated)
           VALUES ($1,'income','net_profit_parent',1e9,'CNY','CNY','n_income_attr_p',false)`, [report.rows[0].report_id]);
        if (year === 2018) continue; // 2018 年由下面两种反例情形覆盖
        await pool.query(
          `INSERT INTO fundamental.corporate_actions (instrument_id, action_type, fiscal_period_end, announced_at, ex_date, status, cash_per_share_pre_tax, total_cash_amount, currency_code, source_id, source_key)
           VALUES ($1,'dividend',$2::date,$3::date,$4::date,'实施',0.5,1e8,'CNY',$5,$6)`,
          [instrumentId, `${year}-12-31`, `${year + 1}-05-01`, `${year + 1}-06-15`, sourceId, `R3-DIV-${year}`]);
      }
      const asOfDate = '2026-09-30';
      // 情形①：2018 年只有已公告的预案，没有除息日与总额。
      await pool.query(
        `INSERT INTO fundamental.corporate_actions (instrument_id, action_type, fiscal_period_end, announced_at, ex_date, status, cash_per_share_pre_tax, total_cash_amount, currency_code, source_id, source_key)
         VALUES ($1,'dividend','2018-12-31','2019-04-01',NULL,'预案',NULL,NULL,'CNY',$2,'R3-DIV-2018-PLAN')`,
        [instrumentId, sourceId]);
      const planOnly = await repo.loadAnnualDividends({ companyIds: [companyId], asOfDate });
      const planRow = (planOnly.get(String(companyId)) || []).find(row => row.year === 2018);
      assert.ok(planRow, '有预案记录的年份仍要返回，便于诊断');
      assert.strictEqual(planRow.dividendKnown, false, '只有预案不得标为已知');
      assert.strictEqual(planRow.dividend, null, '未知金额必须保留 NULL');
      assert.strictEqual(planRow.dividendBasis, 'plan_only');
      let years = service.buildAnnualYears(
        [{ year: 2025, profit: 1e9 }].concat(
          Array.from({ length: 10 }, (_, index) => ({ year: 2015 + index, profit: 1e9 }))),
        planOnly.get(String(companyId)));
      let anomaly = RULES.evaluateAnnualAnomaly({ latestYear: 2025, years });
      assert.strictEqual(anomaly.status, RULES.STATUS.PENDING, '只有预案必须待补，不能 PASS');
      assert.deepStrictEqual(anomaly.dividendUnknownYears, [2018]);
      assert.strictEqual(anomaly.dividendSum, null);

      // 情形②：2018 年已实施且每股 0.5 元，但公司总额为 NULL。
      await pool.query(
        `UPDATE fundamental.corporate_actions SET status='实施', ex_date='2019-06-15', cash_per_share_pre_tax=0.5
          WHERE instrument_id=$1 AND source_key='R3-DIV-2018-PLAN'`, [instrumentId]);
      const amountMissing = await repo.loadAnnualDividends({ companyIds: [companyId], asOfDate });
      const missingRow = (amountMissing.get(String(companyId)) || []).find(row => row.year === 2018);
      assert.ok(missingRow);
      assert.strictEqual(missingRow.dividendKnown, false, '已实施但总额缺失同样未知');
      assert.strictEqual(missingRow.dividend, null);
      assert.strictEqual(missingRow.dividendBasis, 'implemented_amount_missing');
      years = service.buildAnnualYears(
        [{ year: 2025, profit: 1e9 }].concat(
          Array.from({ length: 10 }, (_, index) => ({ year: 2015 + index, profit: 1e9 }))),
        amountMissing.get(String(companyId)));
      anomaly = RULES.evaluateAnnualAnomaly({ latestYear: 2025, years });
      assert.strictEqual(anomaly.status, RULES.STATUS.PENDING);
      assert.deepStrictEqual(anomaly.dividendUnknownYears, [2018]);
    } finally {
      if (companyId) {
        await pool.query(`DELETE FROM fundamental.financial_facts WHERE report_id IN (SELECT report_id FROM fundamental.financial_reports WHERE company_id=$1)`, [companyId]);
        await pool.query(`DELETE FROM fundamental.financial_reports WHERE company_id=$1`, [companyId]);
      }
      if (instrumentId) {
        await pool.query(`DELETE FROM fundamental.corporate_actions WHERE instrument_id=$1`, [instrumentId]);
        await pool.query(`DELETE FROM core.company_instruments WHERE instrument_id=$1`, [instrumentId]);
        await pool.query(`DELETE FROM core.instruments WHERE instrument_id=$1`, [instrumentId]);
      }
      if (companyId) await pool.query(`DELETE FROM core.companies WHERE company_id=$1`, [companyId]);
      await pool.end().catch(() => {});
    }
  });
}

// ===================== R3-01：财务补数 Runner 与槽位门禁同一完成合同 =====================
async function runR301() {
  const definitions = require('../services/jobDefinitions');
  const definition = definitions.getJobDefinition('company_financial_incremental_sync');
  const request = { mode: 'selection_inputs', market: 'CN' };

  await check('R3-01 缺口清空后外层必须给出 inputs_cleared 并通过槽位门禁', async () => {
    const { runner, jobRuns } = await loadFinancialRunner({
      ok: true, status: 'succeeded', market: 'CN', processed: 3, succeeded: 3, industryProcessed: 2, industrySucceeded: 2,
      remainingFinancial: 0, remainingIndustry: 0, remainingValuation: 0, remainingUnclassified: 0,
    });
    const result = await runner.runCompanyFinancialIncrementalSync('review', { mode: 'selection_inputs', market: 'CN', targetTradeDate: '2026-09-30' });
    assert.strictEqual(result.stageComplete, true);
    assert.strictEqual(result.stageCompletedKind, 'inputs_cleared');
    assert.strictEqual(result.continuationRequired, false);
    assert.strictEqual(result.status, 'succeeded');
    assert.deepStrictEqual(result.pendingStages, []);
    assert.strictEqual(definitions.stageCompletionEvidence(definition, result, request), true, '清空后必须能通过槽位完成门禁');
    assert.strictEqual(jobRuns[jobRuns.length - 1].ok, true);
  });

  await check('R3-01 只剩估值缺口时必须继续续批，不能报 succeeded', async () => {
    const { runner } = await loadFinancialRunner({
      ok: false, status: 'blocked', reason: 'remaining_valuation_gap', market: 'CN',
      processed: 0, succeeded: 0, industryProcessed: 0, industrySucceeded: 0,
      remainingFinancial: 0, remainingIndustry: 0, remainingValuation: 1, remainingUnclassified: 0,
    });
    const result = await runner.runCompanyFinancialIncrementalSync('review', { mode: 'selection_inputs', market: 'CN', targetTradeDate: '2026-09-30' });
    assert.strictEqual(result.status, 'blocked', '估值未补完时不能报 succeeded');
    assert.strictEqual(result.stageComplete, false);
    assert.strictEqual(result.continuationRequired, true);
    assert.strictEqual(result.remainingValuation, 1, '估值剩余量必须带出来');
    assert.strictEqual(result.remaining, 1);
    assert.deepStrictEqual(result.pendingStages, ['selectionInputs']);
    assert.strictEqual(definitions.stageCompletionEvidence(definition, result, request), false);
  });

  await check('R3-01 未分类缺口同样算剩余，不能被漏掉', async () => {
    const { runner } = await loadFinancialRunner({
      ok: false, status: 'blocked', market: 'CN', processed: 0, succeeded: 0,
      remainingFinancial: 0, remainingIndustry: 0, remainingValuation: 0, remainingUnclassified: 2,
    });
    const result = await runner.runCompanyFinancialIncrementalSync('review', { mode: 'selection_inputs', market: 'CN', targetTradeDate: '2026-09-30' });
    assert.strictEqual(result.remaining, 2);
    assert.strictEqual(result.stageComplete, false);
    assert.strictEqual(result.continuationRequired, true);
  });

  await check('R3-01 底层 ok=false 但剩余为 0 也不得冒充完成', async () => {
    const { runner } = await loadFinancialRunner({
      ok: false, status: 'partial', market: 'CN', processed: 1, succeeded: 0,
      remainingFinancial: 0, remainingIndustry: 0, remainingValuation: 0, remainingUnclassified: 0,
    });
    const result = await runner.runCompanyFinancialIncrementalSync('review', { mode: 'selection_inputs', market: 'CN', targetTradeDate: '2026-09-30' });
    assert.strictEqual(result.stageComplete, false, '底层未成功时不能算完成');
    assert.strictEqual(result.stageCompletedKind, 'inputs_gaps_pending');
  });
}

// ===================== R3-02：失败队列轮转不得被审计覆盖 =====================
async function runR302() {
  await check('R3-02 审计整体替换队列后，失败对象仍要轮转到队尾', async () => {
    const store = gapQueueStore();
    const gaps = [
      { code: '600001.SH', name: '甲', companyId: 11, domains: ['industry'], reasons: ['industry_unverified'] },
      { code: '600002.SH', name: '乙', companyId: 12, domains: ['industry'], reasons: ['industry_unverified'] },
    ];
    const sync = loadInputsSyncWithRealQueue(store, gaps);
    // 行业外采对每只都抛受控失败，用来观察"谁被轮到"。
    sync.__setIndustry(async tsCode => { throw new Error('controlled_failure:' + tsCode); });
    await sync.syncSelectionInputs({ market: 'CN', asOfDate: '2026-09-30', batchLimit: 1 });
    await sync.syncSelectionInputs({ market: 'CN', asOfDate: '2026-09-30', batchLimit: 1 });
    assert.deepStrictEqual(sync.__requests, ['600001.SH', '600002.SH'], '第二轮必须轮到第二只，不能被同一失败前缀反复占满');
  });

  await check('R3-02 返回成功但缺口仍在的对象也要轮转（无进展不能占队首）', async () => {
    const store = gapQueueStore();
    const gaps = [
      { code: '600001.SH', name: '甲', companyId: 11, domains: ['industry'], reasons: ['industry_unverified'] },
      { code: '600002.SH', name: '乙', companyId: 12, domains: ['industry'], reasons: ['industry_unverified'] },
    ];
    const sync = loadInputsSyncWithRealQueue(store, gaps);
    // 第一只"补了但仍缺"（取数成功、审计仍判定缺口存在）。
    sync.__setIndustry(async () => ({
      industry: '测试行业', industry_level: 1,
      industry_nodes: [{ level: 1, code: 'T1', name: '测试行业' }],
      industry_path: ['测试行业'], sourceCode: 'test',
    }));
    await sync.syncSelectionInputs({ market: 'CN', asOfDate: '2026-09-30', batchLimit: 1 });
    await sync.syncSelectionInputs({ market: 'CN', asOfDate: '2026-09-30', batchLimit: 1 });
    assert.deepStrictEqual(sync.__requests, ['600001.SH', '600002.SH'], '无进展对象也必须让出队首');
  });
}

async function loadFinancialRunner(inputsResult) {
  const jobRuns = [];
  // 只替换记账函数，保留原 db 聚合导出（DATA_DIR 等被 config 依赖，缺了会在加载期崩）。
  const originalDb = require('../db');
  stub(path.join(__dirname, '..', 'db'), Object.assign({}, originalDb, {
    tryClaimJob: async () => true,
    releaseJob: async () => {},
    startJobRun: async () => 501,
    finishJobRun: async (runId, ok, detail) => { jobRuns.push({ runId, ok, detail }); },
  }));
  stub(path.join(__dirname, '..', 'services', 'stockSelectionInputsSync'), {
    syncSelectionInputs: async () => Object.assign({}, inputsResult),
  });
  dropCache('../services/companyFinancialIncrementalSync');
  return { runner: require('../services/companyFinancialIncrementalSync'), jobRuns };
}

/** 与真实 sync_cursors 一致的语义：同一 market 只有一条记录，写入即整体替换。 */
function gapQueueStore() {
  const rows = new Map();
  return {
    rows,
    async saveInputGapQueue({ market, payload }) { rows.set(market, JSON.parse(JSON.stringify(payload))); return 1; },
    async readInputGapQueue({ market }) {
      const payload = rows.get(market);
      return payload ? { cursor_payload: JSON.parse(JSON.stringify(payload)), last_attempt_at: new Date() } : null;
    },
  };
}

/**
 * 真实 inputsSync + 会真实写队列的审计替身：
 * 审计使用与生产同一套持久化副作用（saveInputGapQueue 整体替换 cursor_payload），
 * 这正是 R3-02 的根因场景，不能用"不落队列"的替身掩盖。
 * 行业外采通过数据访问层替身控制（不联网），被调用的对象顺序就是"谁被轮到"的证据。
 */
function loadInputsSyncWithRealQueue(store, gaps) {
  const requests = [];
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
  // 行业分类取数走数据访问层替身；写库入口留空，避免测试连数据库。
  const marketDatasets = require('../dataAccess/marketDatasets');
  marketDatasets.readIndustryClassification = async ({ tsCode }) => {
    requests.push(tsCode);
    return industryBehavior(tsCode);
  };
  marketDatasets.readFinancialReportRows = async () => null;
  marketDatasets.readDividendRows = async () => null;
  require('../repositories/industryRepository').upsertIndustryPath = async () => {};
  dropCache('../services/stockSelectionInputsSync');
  const sync = require('../services/stockSelectionInputsSync');
  sync.__requests = requests;
  sync.__setIndustry = fn => { industryBehavior = fn; };
  return sync;
}

// ===================== R3-03：分红未知不得被当作零 =====================
async function runR303() {
  await check('R3-03 只有预案（未实施）的年份必须保持未知', async () => {
    const service = await loadSelectionService({
      dividendRows: key => annualDividendRows(key, { 2018: { dividend: null, dividendKnown: false, eventCount: 1, dividendBasis: 'plan_only' } }),
    });
    const computed = await service.computeSelection({ market: 'CN', asOfDate: '2026-09-30', positionRatio: 1 });
    const anomaly = computed.anomalyById[1];
    assert.strictEqual(anomaly.status, RULES.STATUS.PENDING, '只有预案不得通过年度异常');
    assert.strictEqual(anomaly.reason, 'dividend_history_unknown');
    assert.deepStrictEqual(anomaly.dividendUnknownYears, [2018]);
    assert.strictEqual(anomaly.dividendSum, null, '未知年份不得按 0 求和');
    assert.strictEqual(computed.quality.publishable, false, '分红未知必须阻断正式发布');
  });

  await check('R3-03 已实施但公司总额缺失同样属未知', async () => {
    const service = await loadSelectionService({
      dividendRows: key => annualDividendRows(key, { 2019: { dividend: null, dividendKnown: false, eventCount: 1, dividendBasis: 'implemented_amount_missing' } }),
    });
    const computed = await service.computeSelection({ market: 'CN', asOfDate: '2026-09-30', positionRatio: 1 });
    const anomaly = computed.anomalyById[1];
    assert.strictEqual(anomaly.status, RULES.STATUS.PENDING);
    assert.deepStrictEqual(anomaly.dividendUnknownYears, [2019]);
    assert.strictEqual(computed.quality.publishable, false);
  });

  await check('R3-03 只有中期记录不能证明全年完整', async () => {
    const service = await loadSelectionService({
      dividendRows: key => annualDividendRows(key, { 2020: { dividend: null, dividendKnown: false, eventCount: 1, dividendBasis: 'interim_only' } }),
    });
    const computed = await service.computeSelection({ market: 'CN', asOfDate: '2026-09-30', positionRatio: 1 });
    const anomaly = computed.anomalyById[1];
    assert.strictEqual(anomaly.status, RULES.STATUS.PENDING, '中期单条不是完整年度证据');
    assert.strictEqual(computed.quality.publishable, false);
  });

  await check('R3-03 金额已知的年末已实施分红仍可正常比较（不误伤）', async () => {
    const service = await loadSelectionService({});
    const computed = await service.computeSelection({ market: 'CN', asOfDate: '2026-09-30', positionRatio: 1 });
    const anomaly = computed.anomalyById[1];
    assert.strictEqual(anomaly.status, RULES.STATUS.PASS);
    assert.strictEqual(anomaly.dividendComparable, true);
    assert.strictEqual(computed.quality.publishable, true);
  });
}

/** 11 个完整财年的分红行：默认全部为"年末已实施且金额已知"。 */
function annualDividendRows(key, overrides = {}) {
  return Array.from({ length: 11 }, (_, index) => {
    const year = 2015 + index;
    const custom = overrides[year];
    if (custom) return Object.assign({ year, eventCount: 1, dividendBasis: 'annual_implemented_amount' }, custom);
    return { year, dividend: 1e8, eventCount: 1, dividendKnown: true, dividendBasis: 'annual_implemented_amount' };
  });
}

// ===================== R3-04：真实零合格的正常终态 =====================
async function runR304() {
  const definitions = require('../services/jobDefinitions');
  const definition = definitions.getJobDefinition('stock_analysis_refresh');

  await check('R3-04 输入完整但零合格必须可发布，业务状态是空仓而非数据不足', async () => {
    const state = { runs: [] };
    // 三只都通过四项规则（进排名池），但最新年分红超十年合计 → 年度异常明确排除，
    // 组合因此没有成员：pendingCount=0、industryMissing=0，这是"本期零合格"，不是缺数据。
    const service = await loadSelectionService({
      dividendRows: key => annualDividendRows(key, { 2025: { dividend: 3e10, dividendKnown: true } }),
    }, { state });
    const computed = await service.computeSelection({ market: 'CN', asOfDate: '2026-09-30', positionRatio: 1 });
    assert.strictEqual(computed.quality.pendingCount, 0);
    assert.strictEqual(computed.quality.industryMissing, 0);
    assert.ok(computed.quality.poolSize > 0, '有排名池但没有入选成员才是"零合格"');
    assert.strictEqual(computed.portfolio.members.length, 0);
    assert.strictEqual(computed.quality.reasons.includes('no_eligible_member'), false, '真实零合格不构成数据缺口');
    assert.strictEqual(computed.quality.publishable, true, '输入完整时零合格是可发布的有效结果');
    await service.computeAndPersist({ market: 'CN', asOfDate: '2026-09-30', runKind: 'quarterly', positionRatio: 1 });
    const run = state.runs[state.runs.length - 1];
    assert.strictEqual(run.businessStatus, 'no_eligible_member', '必须与"数据不足"和"市场关闭"区分');
  });

  await check('R3-04 零合格季度的阶段终态可推进，不再要求续跑', async () => {
    const refresh = await loadRefresh({
      quarterly: {
        ok: true, market: 'CN', quarter: '2026Q3', quarterDate: '2026-09-30', runId: 31,
        qualityStatus: 'passed', businessStatus: 'no_eligible_member', published: true, selectedCount: 0,
      },
      publish: { published: true },
    });
    const result = await refresh.runSelectionMode('selection_quarterly', 'review', { market: 'CN', quarter: '2026Q3' });
    assert.strictEqual(result.stageCompletedKind, 'no_eligible_member');
    assert.strictEqual(result.stageComplete, true);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.continuationRequired, undefined, '空仓不是待补，不需要续跑');
    assert.strictEqual(definitions.stageCompletionEvidence(definition, result, { mode: 'selection_quarterly', market: 'CN' }), true);
  });

  await check('R3-04 已发布的零合格季度不再重复排队', async () => {
    const queued = await loadQuarterEnqueue({ publishedRuns: [{ published_at: new Date().toISOString() }] });
    const result = await queued.enqueueDueSelectionQuarters(new Date('2026-10-05T02:00:00Z'));
    assert.deepStrictEqual(result, [], '输入不变时不得无意义续跑');
  });

  await check('R3-04 真未知输入仍按数据不足阻断（不能一起放行）', async () => {
    const state = { runs: [] };
    const service = await loadSelectionService({ missingPeAll: true }, { state });
    const computed = await service.computeSelection({ market: 'CN', asOfDate: '2026-09-30', positionRatio: 1 });
    assert.ok(computed.quality.pendingCount > 0);
    assert.strictEqual(computed.quality.publishable, false);
    assert.ok(computed.quality.reasons.includes('no_eligible_member'), '输入未知时不入选是附加证据，不是零合格结论');
    await service.computeAndPersist({ market: 'CN', asOfDate: '2026-09-30', runKind: 'quarterly', positionRatio: 1 });
    assert.strictEqual(state.runs[state.runs.length - 1].businessStatus, 'insufficient_data');
  });
}

// ===================== 夹具加载器 =====================
async function loadSelectionService(options = {}, extra = {}) {
  const state = extra.state || { runs: [] };
  const peOf = (index) => (options.missingPeAll ? null : (index === 2 && options.missingPeCompany === '13' ? null : 8 + index));
  const universe = [
    { instrument_id: 1, code: '600001.SH', name: '甲', market: 'CN', currency_code: 'CNY', list_date: '2010-01-01', company_id: 11, pb: extra.allFail ? 9.9 : 1.2, pe_static: peOf(0), pe_ttm: 9, price: 10, price_date: '2026-09-30', risk_warning: false, suspend_type: null },
    { instrument_id: 2, code: '600002.SH', name: '乙', market: 'CN', currency_code: 'CNY', list_date: '2010-01-01', company_id: 12, pb: extra.allFail ? 8.8 : 1.1, pe_static: peOf(1), pe_ttm: 8, price: 10, price_date: '2026-09-30', risk_warning: false, suspend_type: null },
    { instrument_id: 3, code: '600003.SH', name: '丙', market: 'CN', currency_code: 'CNY', list_date: '2010-01-01', company_id: 13, pb: extra.allFail ? 7.7 : 1.0, pe_static: peOf(2), pe_ttm: null, price: 10, price_date: '2026-09-30', risk_warning: false, suspend_type: null },
  ];
  const companies = ['11', '12', '13'];
  const equity = new Map(companies.map(key => [key, {
    amount: 6e10, currency: 'CNY', periodEnd: '2025-12-31', announcedAt: '2026-03-20', reportId: 100 + Number(key),
  }]));
  const profits = new Map(companies.map(key => [key, Array.from({ length: 11 }, (_, index) => ({
    year: 2015 + index, periodEnd: `${2015 + index}-12-31`, profit: 1e9, currency: 'CNY', sourceVersion: `v${2015 + index}`,
  }))]));
  const dividends = new Map(companies.map(key => [key, options.dividendRows ? options.dividendRows(key) : annualDividendRows(key)]));
  const industries = new Map(companies.map((key, index) => [key, {
    code: 'I' + (index + 1), name: '行业' + (index + 1), system: 'SW2021', version: '2021',
  }]));

  stub(path.join(__dirname, '..', 'repositories', 'stockSelectionRepository.js'), {
    MARKET_CONFIG: require('../repositories/stockSelectionRepository').MARKET_CONFIG,
    loadMarketValuation: async () => ({ benchmarkCode: 'CSIALL', valuationMethod: 'market_cap_weighted', tradeDate: '2026-09-30', pb: 1.5, pe: 15 }),
    loadUniverse: async () => universe,
    loadPbWindow: async () => ({
      byInstrument: new Map(universe.map(row => [String(row.instrument_id), { maxPb: 2, coveredDays: 900, expectedDays: 900, gapDays: 0 }])),
      marketDays: 900, calendarDays: 900,
    }),
    loadEquityFacts: async () => equity,
    loadAnnualProfits: async () => profits,
    loadDividendWindow: async () => new Map(universe.map(row => [String(row.instrument_id), {
      ttmPerShare: 0.5, count: 1, currency: 'CNY', totalCash: 1e8, shareUnitUnverified: false,
    }])),
    loadAnnualDividends: async () => dividends,
    loadIndustries: async () => industries,
    loadFxRatesForPairs: async () => new Map(),
    upsertStrategy: async () => 1,
    findRunByIdempotencyKey: async () => null,
    nextRevision: async () => 1,
    insertRun: async (tx, run) => { state.runs.push(run); return state.runs.length; },
    insertCandidates: async () => {},
    insertMembers: async () => {},
    publishRun: async () => ({ published: true }),
    findRun: async () => ({ run_id: 1, quality_status: 'passed', business_status: passedBusiness(state), selected_count: 0, published_at: null }),
    saveInputGapQueue: async () => 1,
    readInputGapQueue: async () => null,
  });
  stub(path.join(__dirname, '..', 'db', 'transaction.js'), {
    withTransaction: async fn => fn({ query: async () => ({ rows: [] }) }),
  });
  dropCache('../services/stockSelectionService');
  return require('../services/stockSelectionService');
}

function passedBusiness(state) {
  return (state.runs[state.runs.length - 1] || {}).businessStatus || 'insufficient_data';
}

async function loadRefresh({ quarterly, publish }) {
  stub(path.join(__dirname, '..', 'services', 'stockSelectionService.js'), {
    quarterEndDate: quarter => {
      const year = quarter.slice(0, 4), q = Number(quarter.slice(5));
      const days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      return `${year}-${String(q * 3).padStart(2, '0')}-${days[q * 3 - 1]}`;
    },
    pendingQuarter: async () => ({ quarter: '2026Q3' }),
    runQuarterly: async () => quarterly,
    computeAndPersist: async () => ({ runId: 1, run: { quality_status: 'passed' } }),
    auditInputs: async () => ({ gapCount: 0, domainCounts: {}, coverage: { withValuation: 0, universeCount: 0 }, quality: {}, queueId: 1 }),
  });
  stub(path.join(__dirname, '..', 'services', 'datasetPartitionRegistry.js'), {
    publishDatasetSnapshot: async () => publish,
  });
  dropCache('../jobs/stockAnalysisRefresh');
  return require('../jobs/stockAnalysisRefresh');
}

/** 季度排队：已发布就跳过；这里只验证"不重复排队"这一条。 */
async function loadQuarterEnqueue({ publishedRuns }) {
  const enqueued = [];
  stub(path.join(__dirname, '..', 'services', 'stockSelectionService.js'), {
    pendingQuarter: async () => ({ quarter: '2026Q3', quarterEnd: '2026-09-30' }),
  });
  stub(path.join(__dirname, '..', 'repositories', 'stockSelectionRepository.js'), {
    listRuns: async () => ({ rows: publishedRuns, total: publishedRuns.length }),
  });
  stub(path.join(__dirname, '..', 'services', 'jobScheduleSlots.js'), {
    enqueueManualJob: async (code, payload) => { enqueued.push({ code, payload }); return { slot_id: enqueued.length }; },
  });
  dropCache('../jobs/stockAnalysisRefresh');
  const refresh = require('../jobs/stockAnalysisRefresh');
  refresh.__enqueued = enqueued;
  return refresh;
}

main().catch(error => {
  console.error(error && (error.stack || error.message));
  process.exit(1);
});

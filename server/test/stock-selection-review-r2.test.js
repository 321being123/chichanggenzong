// 投资策略选股中心：二轮独立核查（R2-01—R2-06）回归反例。
// 每个用例对应《投资策略选股中心研发方案_20261102》第 19.3 节的一条反例，
// 断言"整改之后"的精确行为。服务层用例在进程内替换仓储/事务/数据集发布，
// 不连数据库、不调外部源、不发 HTTP（与验收方同一手法）。
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
const stub = (relativePath, exports) => {
  const resolved = require.resolve(relativePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};
function dropCache(relativePath) {
  try { delete require.cache[require.resolve(relativePath)]; } catch (_) { /* 未加载过 */ }
}

// 11 个完整财年，按需把某年的分红标成"未知"。
function annualYears({ unknownDividendYears = [], zeroDividendYears = [], profit = 1e9, dividend = 1e8, latestDividend } = {}) {
  return Array.from({ length: 11 }, (_, index) => {
    const year = 2015 + index;
    const unknown = unknownDividendYears.includes(year);
    const zero = zeroDividendYears.includes(year);
    const isLatest = year === 2025;
    return {
      year,
      profit,
      dividend: unknown ? null : (zero ? 0 : (isLatest && latestDividend !== undefined ? latestDividend : dividend)),
      dividendKnown: !unknown,
      complete: true,
    };
  });
}

async function main() {
  await runR201();
  await runR202();
  await runR203();
  await runR204();
  await runR205();
  await runR206();

  const pass = tests.filter(item => item[0] === 'PASS').length;
  const fail = tests.length - pass;
  console.log(`PASS=${pass} FAIL=${fail}`);
  process.exit(fail ? 1 : 0);
}

// ===================== R2-01：分红未知不得放行 =====================
async function runR201() {
  await check('R2-01 缺一年分红必须待补，不能放行', () => {
    const anomaly = RULES.evaluateAnnualAnomaly({ latestYear: 2025, years: annualYears({ unknownDividendYears: [2018] }) });
    assert.deepStrictEqual(anomaly.dividendUnknownYears, [2018]);
    assert.strictEqual(anomaly.status, RULES.STATUS.PENDING);
    assert.strictEqual(anomaly.reason, 'dividend_history_unknown');
    assert.strictEqual(anomaly.dividendComparable, false);
    assert.strictEqual(anomaly.dividendSum, null, '未知年份不得按 0 求和');
  });

  await check('R2-01 缺最新一年分红同样待补', () => {
    const anomaly = RULES.evaluateAnnualAnomaly({ latestYear: 2025, years: annualYears({ unknownDividendYears: [2025] }) });
    assert.deepStrictEqual(anomaly.dividendUnknownYears, [2025]);
    assert.strictEqual(anomaly.status, RULES.STATUS.PENDING);
  });

  await check('R2-01 明确零分红（有事实证据）不算未知，可正常比较', () => {
    const anomaly = RULES.evaluateAnnualAnomaly({ latestYear: 2025, years: annualYears({ zeroDividendYears: [2018, 2019] }) });
    assert.strictEqual(anomaly.dividendComparable, true, '有记录且金额为 0 属已核验的零分红');
    assert.deepStrictEqual(anomaly.dividendUnknownYears, []);
    assert.strictEqual(anomaly.status, RULES.STATUS.PASS);
  });

  await check('R2-01 分红完整且最新年超十年合计才排除', () => {
    const anomaly = RULES.evaluateAnnualAnomaly({ latestYear: 2025, years: annualYears({ latestDividend: 3e10 }) });
    assert.strictEqual(anomaly.dividendComparable, true);
    assert.strictEqual(anomaly.status, RULES.STATUS.FAIL);
    assert.strictEqual(anomaly.reason, 'dividend_exceed_decade');
  });

  await check('R2-01 利润已明确超十年时可直接排除，不因分红未知而阻塞', () => {
    const years = annualYears({ unknownDividendYears: [2018] });
    years.forEach(row => { row.profit = 1e8; });
    years[10].profit = 5e10; // 最新年利润 > 十年合计
    const anomaly = RULES.evaluateAnnualAnomaly({ latestYear: 2025, years });
    assert.strictEqual(anomaly.status, RULES.STATUS.FAIL, '明确不符合优先于待补');
    assert.strictEqual(anomaly.reason, 'profit_exceed_decade');
  });

  await check('R2-01 服务层：任一只分红未知都不得把季度组合标为可发布', async () => {
    const service = await loadSelectionService({ unknownDividendCompany: '13' });
    const computed = await service.computeSelection({ market: 'CN', asOfDate: '2026-09-30', positionRatio: 1 });
    const target = computed.evaluated.find(item => item.code === '600003.SH');
    assert.strictEqual(computed.anomalyById[target.instrumentId].status, RULES.STATUS.PENDING);
    assert.strictEqual(computed.quality.anomalyPendingCount >= 1, true);
    assert.strictEqual(computed.quality.publishable, false, '分红未知时不得正式发布');
    assert.ok(computed.quality.reasons.includes('pending_objects_in_ranking_pool'));
  });
}

// ===================== R2-02：输入指纹覆盖全部年度 =====================
async function runR202() {
  await check('R2-02 往年利润被更正（最新年不变）必须产生新输入哈希', async () => {
    const state = { profitOverride: {} };
    const service = await loadSelectionService({ state });
    const before = await service.computeAndPersist({ market: 'CN', asOfDate: '2026-09-30', runKind: 'preview', positionRatio: 1 });
    const beforeHash = state.runs[state.runs.length - 1].inputHash;
    assert.strictEqual(before.reused, false);
    // 把 2015 年利润从 10 亿改成 -200 亿：最新一年与其他指标都不变。
    state.profitOverride['11'] = { year: 2015, profit: -2e10 };
    const after = await service.computeAndPersist({ market: 'CN', asOfDate: '2026-09-30', runKind: 'preview', positionRatio: 1 });
    const afterHash = state.runs[state.runs.length - 1].inputHash;
    assert.notStrictEqual(afterHash, beforeHash, '往年更正必须换新哈希，不能复用旧快照');
    assert.strictEqual(after.reused, false);
  });

  await check('R2-02 分红事实变化同样进入指纹', async () => {
    const state = { dividendOverride: {} };
    const service = await loadSelectionService({ state });
    await service.computeAndPersist({ market: 'CN', asOfDate: '2026-09-30', runKind: 'preview', positionRatio: 1 });
    const beforeHash = state.runs[state.runs.length - 1].inputHash;
    state.dividendOverride['11'] = { year: 2019, dividend: 5e9 };
    await service.computeAndPersist({ market: 'CN', asOfDate: '2026-09-30', runKind: 'preview', positionRatio: 1 });
    const afterHash = state.runs[state.runs.length - 1].inputHash;
    assert.notStrictEqual(afterHash, beforeHash, '分红更正必须换新哈希');
  });

  await check('R2-02 完全相同的输入仍然命中幂等', async () => {
    const state = {};
    const service = await loadSelectionService({ state });
    await service.computeAndPersist({ market: 'CN', asOfDate: '2026-09-30', runKind: 'preview', positionRatio: 1 });
    const hash = state.runs[state.runs.length - 1].inputHash;
    const repoModule = require('../repositories/stockSelectionRepository');
    const original = repoModule.findRunByIdempotencyKey;
    repoModule.findRunByIdempotencyKey = async () => 99;
    const second = await service.computeAndPersist({ market: 'CN', asOfDate: '2026-09-30', runKind: 'preview', positionRatio: 1 });
    repoModule.findRunByIdempotencyKey = original;
    assert.strictEqual(second.reused, true);
    assert.strictEqual(second.runId, 99);
    assert.ok(hash);
  });
}

// ===================== R2-03：港股标准投影 =====================
async function runR203() {
  await check('R2-03 官方报告类型映射为标准期间类型，认不出保持未知', () => {
    const adapter = require('../dataAccess/adapters/lixingerDatasetAdapter');
    assert.strictEqual(adapter.periodTypeOfReportType('annual_report'), 'annual');
    assert.strictEqual(adapter.periodTypeOfReportType('semi_annual_report'), 'semiannual');
    assert.strictEqual(adapter.periodTypeOfReportType('q1'), 'q1');
    assert.strictEqual(adapter.periodTypeOfReportType('not_a_type'), null);
    assert.strictEqual(adapter.periodTypeOfReportType(null), null);
  });

  await check('R2-03 报告期类型优先用事实本身，未知不再按期末月份猜', () => {
    const stockFacts = require('../domain/stockFacts');
    // 3 月期末（港股财年）：有官方期间类型时按它，不会被写成 q1。
    assert.strictEqual(stockFacts.resolvePeriodType({ end_date: '2025-03-31', period_type: 'annual' }), 'annual');
    // 官方报告类型缺失：如实保留未知，不拿 0331 推断成 q1。
    assert.strictEqual(stockFacts.resolvePeriodType({ end_date: '2025-03-31', period_type: 'unknown' }), 'unknown');
    // A 股没有 period_type 字段，沿用期末月份推断。
    assert.strictEqual(stockFacts.resolvePeriodType({ end_date: '2025-12-31' }), 'annual');
    assert.strictEqual(stockFacts.resolvePeriodType({ end_date: '2025-03-31' }), 'q1');
  });

  await check('R2-03 财报写入保留原币与真实报告期', async () => {
    const projection = require('../repositories/stockProjectionRepository');
    const calls = [];
    const client = {
      async query(sql, params) {
        calls.push({ sql: String(sql), params });
        if (/INSERT INTO fundamental\.financial_reports/.test(sql)) return { rows: [{ report_id: 7 }] };
        return { rows: [] };
      },
    };
    await projection.syncReportRows(client, [{
      ts_code: '00700.HK', end_date: '2025-03-31', ann_date: '2025-05-14',
      report_type: '1', comp_type: '1', currency: 'USD', period_type: 'annual',
      n_income_attr_p: 123456, source_code: 'lixinger_official',
    }], 'income', 88, 9, { currency: 'HKD' });
    const reportCall = calls.find(call => /INSERT INTO fundamental\.financial_reports/.test(call.sql));
    assert.ok(reportCall, '必须写标准报告行');
    assert.strictEqual(reportCall.params[3], 'annual', '报告期类型必须是真实年报，不是 q1');
    const factsCall = calls.find(call => /INSERT INTO fundamental\.financial_facts/.test(call.sql));
    assert.ok(factsCall, '必须写财务事实');
    assert.strictEqual(factsCall.params[5], 'USD', '金额币种必须是原币 USD，不能硬编码 CNY');
  });

  await check('R2-03 分红总额与币种按事实落库（无 base_share 也不丢总额）', async () => {
    const projection = require('../repositories/stockProjectionRepository');
    const calls = [];
    const client = { async query(sql, params) { calls.push({ sql: String(sql), params }); return { rows: [] }; } };
    await projection.syncOfficialDividends(client, 5, 3, [{
      ts_code: '00700.HK', end_date: '2025-03-31', ann_date: '2025-05-14',
      cash_div_tax: 1.5, total_cash_amount: 1000, currency: 'HKD', div_proc: '实施',
    }]);
    const call = calls[0];
    assert.ok(call, '必须写分红事实');
    assert.strictEqual(Number(call.params[12]), 1000, '总额不能被算成 null');
    assert.strictEqual(call.params[13], 'HKD', '分红币种必须是 HKD');
  });

  await check('R2-03 标准分红写入（upsertCorporateAction）同样保留总额与币种', async () => {
    const projection = require('../repositories/stockProjectionRepository');
    const calls = [];
    const tx = { async query(sql, params) { calls.push({ sql: String(sql), params }); return { rows: [] }; } };
    await projection.upsertCorporateAction({
      instrumentId: 5, fiscalPeriodEnd: '2025-03-31', announcedAt: '2025-05-14',
      status: '实施', cashPerSharePreTax: 1.5, baseShares: null, totalCashAmount: 1000,
      currencyCode: 'HKD', sourceId: 3, sourceKey: 'k', rawPayload: {},
    }, tx);
    assert.strictEqual(Number(calls[0].params[12]), 1000);
    assert.strictEqual(calls[0].params[13], 'HKD');
  });
}

// ===================== R2-04：补数缺口分类与完成裁决 =====================
async function runR204() {
  await check('R2-04 缺静态 PE 的缺口必须带明确分类，不能 reasons 为空', async () => {
    const service = await loadSelectionService({ missingPeCompany: '13' });
    const audit = await service.auditInputs({ market: 'CN', asOfDate: '2026-09-30' });
    const gap = audit.gaps.find(item => item.code === '600003.SH');
    assert.ok(gap, '缺 PE 的对象必须进缺口清单');
    assert.ok(gap.reasons.length > 0, '缺口必须保留原因，不能 reasons=[]');
    assert.ok(gap.domains.includes('valuation'), '缺静态 PE 归入估值缺口');
  });

  await check('R2-04 同时缺分红与估值的对象必须两个域都入队', async () => {
    const service = await loadSelectionService({ missingPeCompany: '13', unknownDividendCompany: '13' });
    const audit = await service.auditInputs({ market: 'CN', asOfDate: '2026-09-30' });
    const gap = audit.gaps.find(item => item.code === '600003.SH');
    assert.ok(gap.domains.includes('valuation'), '估值缺口入队');
    assert.ok(gap.domains.includes('dividends'), '分红缺口同样入队（不能 else-if 只留一类）');
  });

  await check('R2-04 明确不符合与风险暂缓的对象不算缺口', async () => {
    const service = await loadSelectionService({ failCompany: '12' });
    const audit = await service.auditInputs({ market: 'CN', asOfDate: '2026-09-30' });
    assert.ok(!audit.gaps.some(item => item.code === '600002.SH'), 'FAIL 对象不该被反复补齐');
  });

  await check('R2-04 只剩估值缺口时必须报未完成，不能 succeeded', async () => {
    const sync = await loadInputsSync({
      auditGaps: [{ code: '600009.SH', name: '样本', companyId: 19, domains: ['valuation'], reasons: ['R01:pb_unavailable'] }],
    });
    const result = await sync.syncSelectionInputs({ market: 'CN', asOfDate: '2026-09-30', batchLimit: 5 });
    assert.strictEqual(result.ok, false, '剩余估值缺口不得报完成');
    assert.notStrictEqual(result.status, 'succeeded');
    assert.strictEqual(result.reason, 'remaining_valuation_gap');
    assert.strictEqual(result.remainingValuation, 1);
  });

  await check('R2-04 有缺口但本任务无可处理对象时不得报成功', async () => {
    const sync = await loadInputsSync({
      auditGaps: [{ code: '600010.SH', name: '样本', companyId: 20, domains: ['valuation'], reasons: ['R02:history_gap_exists'] }],
    });
    const result = await sync.syncSelectionInputs({ market: 'CN', asOfDate: '2026-09-30' });
    assert.strictEqual(result.processed, 0);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 'blocked', '处理 0 个仍有缺口只能阻塞，不能成功');
  });

  await check('R2-04 缺口队列全量保存（不再 5000 条截断）', async () => {
    const saved = [];
    const gaps = Array.from({ length: 6001 }, (_, index) => ({
      code: 'C' + index, name: 'n', companyId: index + 1, domains: ['financial_reports'], reasons: ['R05:equity_unavailable'],
    }));
    const service = await loadSelectionService({ auditOverride: { gaps, coverage: { universeCount: 6001 }, quality: {}, domainCounts: {} } }, { captureQueue: saved });
    await service.auditInputs({ market: 'CN', asOfDate: '2026-09-30' });
    const payload = saved[saved.length - 1];
    assert.strictEqual(payload.gaps.length, 6001, '缺口明细必须全量保存');
    assert.strictEqual(payload.truncated, false);
    assert.strictEqual(payload.gapCount, 6001);
  });
}

// ===================== R2-05：阶段完成终态 =====================
async function runR205() {
  const job = path.join(__dirname, '..', 'jobs', 'stockAnalysisRefresh.js');

  await check('R2-05 分区写成功但质量 partial 不得算阶段完成', async () => {
    const refresh = await loadRefresh({
      quarterly: {
        ok: true, market: 'HK', quarter: '2026Q3', quarterDate: '2026-09-30', runId: 11,
        qualityStatus: 'partial', businessStatus: 'insufficient_data', published: false,
        selectedCount: 0, pendingCount: 3, qualityReasons: ['pending_objects_in_ranking_pool'],
      },
      publish: { published: true },
    });
    const result = await refresh.runSelectionMode('selection_quarterly', 'test', { market: 'HK', quarter: '2026Q3' });
    assert.strictEqual(result.stageComplete, false, '分区写成功不等于阶段完成');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, 'partial');
    assert.strictEqual(result.stageCompletedKind, 'preview_only');
    assert.strictEqual(result.continuationRequired, true, '未发布必须续跑');
    const definitions = require('../services/jobDefinitions');
    const definition = definitions.getJobDefinition('stock_analysis_refresh');
    assert.strictEqual(definitions.stageCompletionEvidence(definition, result, { mode: 'selection_quarterly', market: 'HK' }), false);
  });

  await check('R2-05 正式发布的季度才算阶段完成', async () => {
    const refresh = await loadRefresh({
      quarterly: {
        ok: true, market: 'HK', quarter: '2026Q3', quarterDate: '2026-09-30', runId: 12,
        qualityStatus: 'passed', businessStatus: 'eligible', published: true, selectedCount: 30,
      },
      publish: { published: true },
    });
    const result = await refresh.runSelectionMode('selection_quarterly', 'test', { market: 'HK', quarter: '2026Q3' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, 'succeeded');
    assert.strictEqual(result.stageComplete, true);
    assert.strictEqual(result.stageCompletedKind, 'quarterly_published');
    const definitions = require('../services/jobDefinitions');
    assert.strictEqual(definitions.stageCompletionEvidence(
      definitions.getJobDefinition('stock_analysis_refresh'), result, { mode: 'selection_quarterly', market: 'HK' }), true);
  });

  await check('R2-05 指数 PB≥2 的正常关闭有独立可验证终态', async () => {
    const refresh = await loadRefresh({
      quarterly: {
        ok: true, market: 'CN', quarter: '2026Q3', quarterDate: '2026-09-30', runId: 13,
        qualityStatus: 'passed', businessStatus: 'market_closed', published: false, selectedCount: 0,
      },
      publish: { published: false, reason: 'empty_or_no_date' },
    });
    const result = await refresh.runSelectionMode('selection_quarterly', 'test', { market: 'CN', quarter: '2026Q3' });
    assert.strictEqual(result.status, 'market_closed');
    assert.strictEqual(result.stageComplete, true);
    assert.strictEqual(result.stageCompletedKind, 'market_closed');
    assert.strictEqual(result.continuationRequired, undefined, '正常关闭不需要续跑');
  });

  await check('R2-05 预览模式只记"预览已记录"，不冒充正式完成', async () => {
    const refresh = await loadRefresh({
      preview: { runId: 21, run: { quality_status: 'partial' } },
      publish: { published: false },
    });
    const result = await refresh.runSelectionMode('selection_preview', 'test', { market: 'CN', targetDate: '2026-09-30' });
    assert.strictEqual(result.stageCompletedKind, 'preview_recorded');
    const definitions = require('../services/jobDefinitions');
    // 预览终态只对预览模式成立，不能拿去认季度完成。
    assert.strictEqual(definitions.stageCompletionEvidence(
      definitions.getJobDefinition('stock_analysis_refresh'), result, { mode: 'selection_quarterly', market: 'CN' }), false);
  });
}

// ===================== R2-06：回测可还原性 =====================
async function runR206() {
  await check('R2-06 行业未知不得回测成全现金零收益的有效区间', async () => {
    const result = await runBacktestScenario({
      gate: { eligible: true, status: 'eligible' },
      quality: {
        publishable: false,
        pendingCount: 0,
        industryMissing: 1,
        reasons: ['industry_unverified_in_ranking_pool'],
      },
      members: [],
    });
    assert.strictEqual(result.status, 'not_evaluable', '行业未知区间不可还原');
    assert.strictEqual(result.diagnostics.missing.reason, 'point_in_time_inputs_incomplete');
    // 固定日历里 09-30 之后到区间末的交易日只有 10-01，因此 2026Q4 也以 09-30 为信号日纳入。
    assert.deepStrictEqual(result.diagnostics.missing.quarters, ['2026Q1', '2026Q2', '2026Q3', '2026Q4']);
    assert.strictEqual(result.diagnostics.missing.details[0].industryMissing, 1, '诊断必须写明是行业未知');
  });

  await check('R2-06 真实零合格股票是可还原的现金区间', async () => {
    const result = await runBacktestScenario({
      gate: { eligible: true, status: 'eligible' },
      quality: { publishable: false, pendingCount: 0, industryMissing: 0, reasons: ['no_eligible_member'] },
      members: [],
    });
    assert.strictEqual(result.status, 'partial', '确实没有合格股票时该段现金是可还原历史');
    assert.ok(result.periods >= 2);
  });

  await check('R2-06 指数 PB≥2 的正常关闭仍可还原', async () => {
    const result = await runBacktestScenario({
      gate: { eligible: false, status: 'market_closed', reason: 'market_pb_not_below_threshold' },
      quality: { publishable: false, pendingCount: 0, industryMissing: 0, reasons: ['market_pb_not_below_threshold', 'no_eligible_member'] },
      members: [],
    });
    assert.strictEqual(result.status, 'partial');
  });

  await check('R2-06 指数数据缺失仍不可还原', async () => {
    const result = await runBacktestScenario({
      gate: { eligible: false, status: 'data_missing', reason: 'market_pb_missing' },
      quality: { publishable: false, pendingCount: 0, industryMissing: 0, reasons: ['market_pb_missing'] },
      members: [],
    });
    assert.strictEqual(result.status, 'not_evaluable');
  });
}

// ===================== 夹具加载器 =====================
/**
 * 选股服务：进程内替换仓储与事务。
 * options 控制样本差异：缺 PE、缺分红、明确不符合、往年利润/分红覆盖、审计结果覆盖。
 */
async function loadSelectionService(options = {}, extra = {}) {
  const state = options.state || { runs: options.runs || [] };
  if (!state.runs) state.runs = [];
  state.profitOverride = state.profitOverride || options.profitOverride || {};
  state.dividendOverride = state.dividendOverride || options.dividendOverride || {};
  const universe = [
    { instrument_id: 1, code: '600001.SH', name: '甲', market: 'CN', currency_code: 'CNY', list_date: '2010-01-01', company_id: 11, pb: 1.2, pe_static: 10, pe_ttm: 9, price: 10, price_date: '2026-09-30', risk_warning: false, suspend_type: null },
    { instrument_id: 2, code: '600002.SH', name: '乙', market: 'CN', currency_code: 'CNY', list_date: '2010-01-01', company_id: 12, pb: 1.1, pe_static: 9, pe_ttm: 8, price: 10, price_date: '2026-09-30', risk_warning: false, suspend_type: null },
    { instrument_id: 3, code: '600003.SH', name: '丙', market: 'CN', currency_code: 'CNY', list_date: '2010-01-01', company_id: 13, pb: 1.0, pe_static: options.missingPeCompany === '13' ? null : 8, pe_ttm: null, price: 10, price_date: '2026-09-30', risk_warning: false, suspend_type: null },
  ];
  if (options.failCompany) {
    const target = universe.find(row => row.company_id === Number(options.failCompany));
    if (target) target.pb = 9.9; // PB 超阈值 → 明确不符合
  }
  const equity = new Map(['11', '12', '13'].map(key => [key, {
    amount: 6e10, currency: 'CNY', periodEnd: '2025-12-31', announcedAt: '2026-03-20', reportId: 100 + Number(key),
  }]));
  // 每次读取都按当前 state 重新生成：用例在两次计算之间改的就是这些值。
  const buildAnnual = key => {
    const rows = Array.from({ length: 11 }, (_, index) => ({
      year: 2015 + index, periodEnd: `${2015 + index}-12-31`, profit: 1e9, currency: 'CNY', sourceVersion: `v${2015 + index}`,
    }));
    const override = state.profitOverride[key];
    if (override) {
      const row = rows.find(item => item.year === override.year);
      if (row) row.profit = override.profit;
    }
    return rows;
  };
  const buildDividends = key => Array.from({ length: 11 }, (_, index) => {
    const year = 2015 + index;
    const dividendOverride = state.dividendOverride[key];
    const dividend = dividendOverride && dividendOverride.year === year ? dividendOverride.dividend : 1e8;
    // 缺分红：该年没有任何事件记录 → 未知（不是 0）。
    const unknown = options.unknownDividendCompany === key && year === 2018;
    return { year, dividend: unknown ? 0 : dividend, eventCount: unknown ? 0 : 1, dividendKnown: !unknown };
  });
  const companies = ['11', '12', '13'];
  const industries = new Map(['11', '12', '13'].map((key, index) => [key, {
    code: 'I' + (index + 1), name: '行业' + (index + 1), system: 'SW2021', version: '2021',
  }]));
  const savedQueues = extra.captureQueue || [];

  stub(path.join(__dirname, '..', 'repositories', 'stockSelectionRepository.js'), {
    MARKET_CONFIG: require('../repositories/stockSelectionRepository').MARKET_CONFIG,
    loadMarketValuation: async () => ({ benchmarkCode: 'CSIALL', valuationMethod: 'market_cap_weighted', tradeDate: '2026-09-30', pb: 1.5, pe: 15 }),
    loadUniverse: async () => universe,
    loadPbWindow: async () => ({
      byInstrument: new Map(universe.map(row => [String(row.instrument_id), { maxPb: 2, coveredDays: 900, expectedDays: 900, gapDays: 0 }])),
      marketDays: 900, calendarDays: 900,
    }),
    loadEquityFacts: async () => equity,
    loadAnnualProfits: async () => new Map(companies.map(key => [key, buildAnnual(key)])),
    loadDividendWindow: async () => new Map(universe.map(row => [String(row.instrument_id), {
      ttmPerShare: 0.5, count: 1, currency: 'CNY', totalCash: 1e8, shareUnitUnverified: false,
    }])),
    loadAnnualDividends: async () => new Map(companies.map(key => [key, buildDividends(key)])),
    loadIndustries: async () => industries,
    loadFxRatesForPairs: async () => new Map(),
    upsertStrategy: async () => 1,
    findRunByIdempotencyKey: async () => null,
    nextRevision: async () => 1,
    insertRun: async (tx, run) => { state.runs.push(run); return state.runs.length; },
    insertCandidates: async () => {},
    insertMembers: async () => {},
    publishRun: async () => ({ published: true }),
    findRun: async () => ({ run_id: 1, quality_status: 'partial', business_status: 'insufficient_data', selected_count: 0, published_at: null }),
    saveInputGapQueue: async ({ payload }) => { savedQueues.push(payload); return 1; },
    readInputGapQueue: async () => null,
  });
  stub(path.join(__dirname, '..', 'db', 'transaction.js'), {
    withTransaction: async fn => fn({ query: async () => ({ rows: [] }) }),
  });
  dropCache('../services/stockSelectionService');
  const service = require('../services/stockSelectionService');
  if (options.auditOverride) {
    // 覆盖审计：验证队列持久化本身（缺口数量、是否截断）。
    const original = service.auditInputs;
    service.auditInputs = async () => {
      const payload = Object.assign({
        market: 'CN', asOfDate: '2026-09-30', generatedAt: 'x', universeCount: 0, gapCount: 0,
        domainCounts: {}, coverage: {}, quality: {}, gaps: [], truncated: false,
      }, options.auditOverride);
      // gapCount 与明细必须一致：覆盖样本里只给 gaps 时由它推出来。
      payload.gapCount = Array.isArray(payload.gaps) ? payload.gaps.length : 0;
      savedQueues.push(payload);
      await require('../repositories/stockSelectionRepository').saveInputGapQueue({ market: 'CN', payload });
      return Object.assign({ queueId: 1 }, payload);
    };
    service.__originalAudit = original;
  }
  return service;
}

/** 选股输入补齐：替换服务审计结果与队列仓储。 */
async function loadInputsSync({ auditGaps }) {
  let phase = 0;
  stub(path.join(__dirname, '..', 'services', 'stockSelectionService.js'), {
    auditInputs: async () => {
      phase += 1;
      // 第一次是补齐前，第二次是补齐后：两者都给同样的剩余缺口（模拟"补不动"）。
      return {
        queueId: 1, gapCount: auditGaps.length, domainCounts: {}, gaps: auditGaps,
        coverage: { universeCount: auditGaps.length, withValuation: 0 }, quality: {},
      };
    },
  });
  stub(path.join(__dirname, '..', 'repositories', 'stockSelectionRepository.js'), {
    saveInputGapQueue: async () => 1,
    readInputGapQueue: async () => null,
    findInstrumentMeta: async () => null,
  });
  dropCache('../services/stockSelectionInputsSync');
  const sync = require('../services/stockSelectionInputsSync');
  sync.__phase = () => phase;
  return sync;
}

/** 任务模式执行：替换季度服务与分区发布。 */
async function loadRefresh({ quarterly, preview, publish }) {
  stub(path.join(__dirname, '..', 'services', 'stockSelectionService.js'), {
    quarterEndDate: quarter => {
      const year = quarter.slice(0, 4), q = Number(quarter.slice(5));
      const days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      return `${year}-${String(q * 3).padStart(2, '0')}-${days[q * 3 - 1]}`;
    },
    pendingQuarter: async () => ({ quarter: '2026Q3' }),
    runQuarterly: async () => quarterly,
    computeAndPersist: async () => preview,
    auditInputs: async () => ({ gapCount: 0, domainCounts: {}, coverage: { withValuation: 0, universeCount: 0 }, quality: {}, queueId: 1 }),
  });
  stub(path.join(__dirname, '..', 'services', 'datasetPartitionRegistry.js'), {
    publishDatasetSnapshot: async () => publish,
  });
  dropCache('../jobs/stockAnalysisRefresh');
  return require('../jobs/stockAnalysisRefresh');
}

/** 回测：固定日历与价格，质量裁决由参数给。 */
async function runBacktestScenario({ gate, quality, members }) {
  const calendar = ['2026-03-31', '2026-04-01', '2026-06-30', '2026-07-01', '2026-09-30', '2026-10-01'];
  stub(path.join(__dirname, '..', 'services', 'stockSelectionService.js'), {
    STRATEGY_VERSION: 'v1',
    quarterOf: date => `${String(date).slice(0, 4)}Q${Math.ceil(Number(String(date).slice(5, 7)) / 3)}`,
    quarterEndDate: quarter => {
      const year = quarter.slice(0, 4), q = Number(quarter.slice(5));
      const days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      return `${year}-${String(q * 3).padStart(2, '0')}-${days[q * 3 - 1]}`;
    },
    computeSelection: async () => ({
      gate,
      quality,
      portfolio: { members },
      coverage: { universeCount: 10 },
      params: { slotsPerMarket: 30 },
      positionRatio: 1,
    }),
  });
  const prices = new Map(calendar.map(day => [`1|${day}`, 1]));
  let periods = 0;
  stub(path.join(__dirname, '..', 'repositories', 'stockSelectionRepository.js'), {
    loadCalendar: async () => calendar,
    loadOpenPrices: async () => prices,
    loadBenchmarkCloses: async () => new Map(calendar.map(day => [day, 100])),
    loadDividendCash: async () => new Map(),
    upsertStrategy: async () => 1,
    insertBacktest: async () => 7,
    insertBacktestPeriods: async (tx, id, rows) => { periods = rows.length; return { rowCount: rows.length }; },
  });
  stub(path.join(__dirname, '..', 'db', 'transaction.js'), {
    withTransaction: async fn => fn({ query: async () => ({ rows: [] }) }),
  });
  dropCache('../services/stockSelectionBacktest');
  const backtest = require('../services/stockSelectionBacktest');
  const result = await backtest.runBacktest({
    market: 'CN', startDate: '2026-01-01', endDate: '2026-10-01', costs: { buyBps: 0, sellBps: 0 },
  });
  return { ...result, diagnostics: result.diagnostics, periods };
}

main().catch(error => {
  console.error(error && (error.stack || error.message));
  process.exit(1);
});

// 投资策略选股中心：独立验收反例回归（SSV-01—09）。
// 每个用例对应验收记录第 16.2/16.3 节的一条反例，断言"修好之后"的精确行为；
// 服务层用例在进程内替换仓储与事务，不连数据库、不调外部源（与验收方同一手法）。
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
const PORTFOLIO = require('../domain/stockSelectionPortfolio');

function facts(overrides) {
  return Object.assign({
    instrumentId: 1, code: '600000.SH', name: '测试股', market: 'CN', companyId: 100,
    pb: 1.2, peStatic: 10, peTtm: 9.5, price: 10, priceDate: '2026-09-30',
    pbWindow: { maxPb: 2.4, coveredDays: 900, expectedDays: 900, gapDays: 0 },
    equity: { amount: 5e10, currency: 'CNY', periodEnd: '2025-12-31', announcedAt: '2026-03-20', reportId: 1 },
    fx: {},
    dividend: { ttmPerShare: 0.5, count: 1, currency: 'CNY', verifiedZero: false },
    annual: {
      latestYear: 2025,
      years: Array.from({ length: 11 }, (_, index) => ({
        year: 2015 + index, profit: 1e9, dividend: 1e8, dividendKnown: true, complete: true,
      })),
      currency: 'CNY',
    },
    industry: { code: '801010', name: '农林牧渔', system: 'SW2021', version: '2021' },
    suspended: false, delistedAtTargetDate: false, riskWarning: null,
  }, overrides || {});
}

const stub = (relativePath, exports) => {
  const resolved = require.resolve(relativePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

async function main() {
  // ---------- SSV-02：风险必须真的挡住入选 ----------
  await check('SSV-02 停牌证券不得进入最终席位，且不计入"策略不符合"', () => {
    const held = RULES.evaluateInstrument(facts({ suspended: true, suspensionReason: 'S' }));
    assert.strictEqual(held.filterStatus, RULES.STATUS.RISK, '停牌必须单独标 RISK，而不是仅记原因');
    assert.strictEqual(held.rankReady, false, '停牌不得进入排名池');
    assert.ok(held.exclusionReasons.some(item => item.code === 'suspended_at_target_date'));

    const ranked = [1, 2, 3].map(index => Object.assign(
      RULES.evaluateInstrument(facts({ instrumentId: index, code: 'C' + index, suspended: index === 3 })),
      { selectionOrder: index, industry: { code: 'I' + index, name: 'I', system: 'SW2021' } }));
    const portfolio = PORTFOLIO.buildPortfolio({ ranked, positionRatio: 1, anomalyById: {} });
    assert.deepStrictEqual(portfolio.members.map(member => member.instrumentId).sort(), [1, 2], '停牌股不得占席位');
    assert.ok(portfolio.skipped.some(item => item.reason === 'risk_held'));
  });

  await check('SSV-02 ST/退市风险同样排除，临时停牌解除后可恢复入选', () => {
    const st = RULES.evaluateInstrument(facts({ riskWarning: 'risk_warning_name' }));
    assert.strictEqual(st.filterStatus, RULES.STATUS.RISK);
    const recovered = RULES.evaluateInstrument(facts({ suspended: false, riskWarning: null }));
    assert.strictEqual(recovered.filterStatus, RULES.STATUS.PASS, '风险解除后必须能恢复');
    assert.strictEqual(recovered.rankReady, true);
  });

  // ---------- SSV-09：十年 PB 缺口不能推成"不符合" ----------
  await check('SSV-09 1000 个应有日只覆盖 900 日、最高 PB=0.9 → 待补而非 FAIL', () => {
    const result = RULES.evaluateInstrument(facts({
      pbWindow: { maxPb: 0.9, coveredDays: 900, expectedDays: 1000, gapDays: 100 },
    }));
    assert.strictEqual(result.rules.R02.status, RULES.STATUS.PENDING, '有缺口时不能推断未覆盖区间没有正证');
    assert.strictEqual(result.rules.R02.reason, 'history_gap_exists');
  });

  await check('SSV-09 应有日全部覆盖且都≤1 才判不符合；正证路径不受影响', () => {
    const complete = RULES.evaluateInstrument(facts({
      pbWindow: { maxPb: 0.95, coveredDays: 1000, expectedDays: 1000, gapDays: 0 },
    }));
    assert.strictEqual(complete.rules.R02.status, RULES.STATUS.FAIL);
    const positive = RULES.evaluateInstrument(facts({
      pbWindow: { maxPb: 1.01, coveredDays: 5, expectedDays: 1000, gapDays: 995 },
    }));
    assert.strictEqual(positive.rules.R02.status, RULES.STATUS.PASS, '有正证即通过，不被其他缺口推翻');
  });

  await check('SSV-09 缺缺口信息时按未知处理，不猜成完整', () => {
    const result = RULES.evaluateInstrument(facts({
      pbWindow: { maxPb: 0.9, coveredDays: 900 },
    }));
    assert.strictEqual(result.rules.R02.status, RULES.STATUS.PENDING);
    assert.strictEqual(result.rules.R02.reason, 'history_coverage_unknown');
  });

  // ---------- SSV-04：分红缺失不能补 0 ----------
  await check('SSV-04 历史某年没有分红记录时跳过分红比较并标注，不补 0', () => {
    const years = Array.from({ length: 11 }, (_, index) => ({
      year: 2015 + index, profit: 1e9, dividend: index === 3 ? null : 1e8,
      dividendKnown: index !== 3, complete: true,
    }));
    const anomaly = RULES.evaluateAnnualAnomaly({ latestYear: 2025, years });
    assert.strictEqual(anomaly.dividendComparable, false, '分红不完整时整段比较不成立');
    assert.strictEqual(anomaly.dividendComparison, 'skipped_unknown_dividend');
    assert.deepStrictEqual(anomaly.dividendUnknownYears, [2018]);
    assert.strictEqual(anomaly.dividendSum, null, '不能用 0 参与求和');
    assert.strictEqual(anomaly.status, RULES.STATUS.PASS, '利润维度可用时不应因分红未知直接排除');
  });

  await check('SSV-04 分红全部可核验时才做十年比较', () => {
    const years = Array.from({ length: 11 }, (_, index) => ({
      year: 2015 + index, profit: 1e8, dividend: index === 10 ? 3e10 : 2e9,
      dividendKnown: true, complete: true,
    }));
    const anomaly = RULES.evaluateAnnualAnomaly({ latestYear: 2025, years });
    assert.strictEqual(anomaly.dividendComparable, true);
    assert.strictEqual(anomaly.dividendExceeded, true);
    assert.strictEqual(anomaly.status, RULES.STATUS.FAIL);
  });

  // ---------- SSV-06：季度解析 ----------
  await check('SSV-06 pendingQuarter 必须 await 后拿到确定季度', async () => {
    const service = require('../services/stockSelectionService');
    const pending = service.pendingQuarter({ market: 'CN', now: '2026-11-03' });
    assert.strictEqual(typeof pending.then, 'function', 'pendingQuarter 是异步合同');
    const resolved = await pending;
    assert.strictEqual(resolved.quarter, '2026Q3', '2026-11-03 的最近已结束季度是 2026Q3');
    assert.strictEqual(resolved.quarterEnd, '2026-09-30');
  });

  // ---------- SSV-07：依赖与完成契约 ----------
  await check('SSV-07 选股模式不继承转债正股依赖，港股不被 A 股链阻断', () => {
    const definitions = require('../services/jobDefinitions');
    const slots = require('../services/jobScheduleSlots');
    const definition = definitions.getJobDefinition('stock_analysis_refresh');
    assert.deepStrictEqual(
      slots.dependenciesForMode(definition.modeDependencyCodes, 'selection_quarterly', definition.dependencyCodes),
      [], '选股季度不得继承 convertible_bond_universe_refresh');
    assert.deepStrictEqual(
      slots.dependenciesForMode(definition.modeDatasetDependencies, 'selection_quarterly', definition.datasetDependencies),
      []);
    assert.deepStrictEqual(
      slots.dependenciesForMode(definition.modeDependencyCodes, 'core', definition.dependencyCodes),
      ['convertible_bond_universe_refresh'], '原模式依赖保持不变');
  });

  await check('SSV-07 选股数据集已登记产出，选股阶段 stageComplete 被认可', () => {
    const definitions = require('../services/jobDefinitions');
    const registry = require('../services/datasetPartitionRegistry');
    const definition = definitions.getJobDefinition('stock_analysis_refresh');
    ['stock_selection_snapshot_cn', 'stock_selection_snapshot_hk', 'stock_selection_inputs_cn', 'stock_selection_inputs_hk']
      .forEach(code => {
        assert.ok(definition.producesDatasets.includes(code), `${code} 必须在产出清单`);
        assert.ok(registry.DATASET_PARTITION_REGISTRY[code], `${code} 必须在分区注册表`);
      });
    const evidence = definitions.stageCompletionEvidence(definition, {
      mode: 'selection_quarterly', ok: true, stageComplete: true, market: 'HK',
    }, { mode: 'selection_quarterly', market: 'HK' });
    assert.strictEqual(evidence, true, '选股模式的市场级完成证据必须被认可');
    const mismatched = definitions.stageCompletionEvidence(definition, {
      mode: 'selection_quarterly', ok: true, stageComplete: true, market: 'CN',
    }, { mode: 'selection_quarterly', market: 'HK' });
    assert.strictEqual(mismatched, false, '市场不一致不得当作完成');
  });

  // ---------- SSV-01：模式必须被识别，不能静默回落 ----------
  await check('SSV-01 财务任务对未知模式直接拒绝，不回落成转债默认流程', async () => {
    const runner = require('../services/companyFinancialIncrementalSync');
    const error = await runner.runCompanyFinancialIncrementalSync('test', { mode: 'not_a_real_mode' })
      .then(() => null).catch(caught => caught);
    assert.ok(error, '未知模式必须抛错');
    assert.strictEqual(error.code, 'UNKNOWN_MODE');
    assert.ok(/not_a_real_mode/.test(error.message));
  });

  await check('SSV-01 补齐模式已登记发布契约且按续批语义完成', async () => {
    const definitions = require('../services/jobDefinitions');
    const phase = definitions.getJobDefinition('company_financial_incremental_sync').datasetPublicationByMode.selection_inputs;
    assert.ok(phase, 'selection_inputs 必须有阶段契约');
    assert.deepStrictEqual(phase.publish, []);
    assert.strictEqual(phase.requireStageComplete, true);
  });

  // ---------- SSV-03 / SSV-05：服务层反例（stub 仓储与事务） ----------
  await runServiceCases();

  // ---------- SSV-08：回测权重 ----------
  await runBacktestCases();

  const pass = tests.filter(item => item[0] === 'PASS').length;
  const fail = tests.length - pass;
  console.log(`PASS=${pass} FAIL=${fail}`);
  process.exit(fail ? 1 : 0);
}

// ===== 服务层：用可控仓储复现"缺 PE 未阻断"和"改值仍复用旧快照" =====
async function runServiceCases() {
  const universe = [
    { instrument_id: 1, code: '600001.SH', name: '甲', market: 'CN', currency_code: 'CNY', list_date: '2010-01-01', company_id: 11, pb: 1.2, pe_static: 10, pe_ttm: 9, price: 10, price_date: '2026-09-30', risk_warning: false, suspend_type: null },
    { instrument_id: 2, code: '600002.SH', name: '乙', market: 'CN', currency_code: 'CNY', list_date: '2010-01-01', company_id: 12, pb: 1.1, pe_static: 9, pe_ttm: 8, price: 10, price_date: '2026-09-30', risk_warning: false, suspend_type: null },
    // 第 3 只：四项通过（PB/股息/净资产都在范围内）但静态 PE 缺失 → 排名输入未知
    { instrument_id: 3, code: '600003.SH', name: '丙', market: 'CN', currency_code: 'CNY', list_date: '2010-01-01', company_id: 13, pb: 1.0, pe_static: null, pe_ttm: null, price: 10, price_date: '2026-09-30', risk_warning: false, suspend_type: null },
  ];
  const equity = new Map([['11', { amount: 5e10, currency: 'CNY', periodEnd: '2025-12-31', announcedAt: '2026-03-20', reportId: 101 }]]);
  ['12', '13'].forEach(key => equity.set(key, { amount: 6e10, currency: 'CNY', periodEnd: '2025-12-31', announcedAt: '2026-03-20', reportId: 100 + Number(key) }));
  const annual = new Map();
  equity.forEach((_, key) => annual.set(key, Array.from({ length: 11 }, (_, index) => ({
    year: 2015 + index, periodEnd: `${2015 + index}-12-31`, profit: 1e9, currency: 'CNY',
  }))));
  const dividendsByCompany = new Map();
  annual.forEach((_, key) => dividendsByCompany.set(key, Array.from({ length: 11 }, (_, index) => ({
    year: 2015 + index, dividend: 1e8, eventCount: 1, dividendKnown: true,
  }))));
  const industries = new Map([['11', { code: 'I1', name: '行业1', system: 'SW2021', version: '2021' }],
    ['12', { code: 'I2', name: '行业2', system: 'SW2021', version: '2021' }],
    ['13', { code: 'I3', name: '行业3', system: 'SW2021', version: '2021' }]]);

  const state = { runs: [], candidates: [], members: [], pbOverrides: {} };
  const repositoryPath = path.join(__dirname, '..', 'repositories', 'stockSelectionRepository.js');
  stub(repositoryPath, {
    MARKET_CONFIG: require('../repositories/stockSelectionRepository').MARKET_CONFIG,
    loadMarketValuation: async () => ({ benchmarkCode: 'CSIALL', valuationMethod: 'market_cap_weighted', tradeDate: '2026-09-30', pb: 1.5, pe: 15 }),
    loadUniverse: async () => universe.map(row => Object.assign({}, row, state.pbOverrides[row.instrument_id] || {})),
    loadPbWindow: async () => ({
      byInstrument: new Map(universe.map(row => [String(row.instrument_id), { maxPb: 2, coveredDays: 900, expectedDays: 900, gapDays: 0 }])),
      marketDays: 900, calendarDays: 900,
    }),
    loadEquityFacts: async () => equity,
    loadAnnualProfits: async () => annual,
    loadDividendWindow: async () => new Map(universe.map(row => [String(row.instrument_id), { ttmPerShare: 0.5, count: 1, currency: 'CNY', totalCash: 1e8, shareUnitUnverified: false }])),
    loadAnnualDividends: async () => dividendsByCompany,
    loadIndustries: async () => industries,
    loadFxRatesForPairs: async () => new Map(),
    upsertStrategy: async () => 1,
    findRunByIdempotencyKey: async () => null,
    nextRevision: async () => 1,
    insertRun: async (tx, run) => { state.runs.push(run); return state.runs.length; },
    insertCandidates: async (tx, runId, rows) => { state.candidates.push({ runId, rows }); },
    insertMembers: async (tx, runId, members) => { state.members.push({ runId, members }); },
    publishRun: async () => ({ published: true }),
    findRun: async () => ({ run_id: 1, market: 'CN', quality_status: 'partial', business_status: 'insufficient_data', selected_count: 0, published_at: null }),
  });
  stub(path.join(__dirname, '..', 'db', 'transaction.js'), {
    withTransaction: async fn => fn({ query: async () => ({ rows: [] }) }),
  });

  // 前面的用例可能已经加载过服务（并绑定了真实仓储），这里必须清掉模块缓存再重新加载，
  // 否则 stub 只换掉了缓存入口、服务里持有的仍是真实仓储引用，用例会真的去连数据库。
  const servicePath = require.resolve('../services/stockSelectionService');
  delete require.cache[servicePath];
  const service = require('../services/stockSelectionService');

  await check('SSV-03 四项通过但静态 PE 缺失的对象必须阻断正式发布', async () => {
    state.runs.length = 0;
    const computed = await service.computeSelection({ market: 'CN', asOfDate: '2026-09-30', positionRatio: 1 });
    assert.strictEqual(computed.quality.rankBlockedCount, 1, '缺 PE 的对象必须计入排名受阻');
    assert.ok(computed.quality.pendingCount >= 1, '待补计数必须包含缺 PE 对象');
    assert.strictEqual(computed.quality.publishable, false, '存在可能改变排名的未知输入时不得发布');
    assert.ok(computed.quality.reasons.includes('pending_objects_in_ranking_pool'));
  });

  await check('SSV-03 明确不符合（FAIL）的对象不会被当成待补误阻断', async () => {
    const computed = await service.computeSelection({ market: 'CN', asOfDate: '2026-09-30', positionRatio: 1 });
    assert.strictEqual(computed.quality.failures, 0, '样本里没有被硬过滤排除的对象');
    // 把 PB 调到 2.0（>1.5）后，该对象是明确不符合，不应进入待补
    state.pbOverrides[3] = { pb: 2.0, pe_static: 9 };
    const after = await service.computeSelection({ market: 'CN', asOfDate: '2026-09-30', positionRatio: 1 });
    assert.strictEqual(after.quality.rankBlockedCount, 0, '已明确不符合者不再算排名待补');
    assert.ok(after.quality.failures >= 1);
    state.pbOverrides[3] = {};
  });

  await check('SSV-05 个股 PB 从 1.2 改成 0.81（行数不变）必须产生新输入哈希', async () => {
    state.pbOverrides[1] = {};
    const before = await service.computeAndPersist({ market: 'CN', asOfDate: '2026-09-30', runKind: 'preview', positionRatio: 1 });
    const beforeHash = state.runs[state.runs.length - 1].inputHash;
    state.pbOverrides[1] = { pb: 0.81 };
    const after = await service.computeAndPersist({ market: 'CN', asOfDate: '2026-09-30', runKind: 'preview', positionRatio: 1 });
    const afterHash = state.runs[state.runs.length - 1].inputHash;
    assert.notStrictEqual(afterHash, beforeHash, '值变化必须改变输入哈希，不能复用旧快照');
    assert.strictEqual(before.reused, false);
    assert.strictEqual(after.reused, false);
    state.pbOverrides[1] = {};
  });

  await check('SSV-05 同输入重复执行仍然命中幂等（不会每次新建）', async () => {
    const first = await service.computeAndPersist({ market: 'CN', asOfDate: '2026-09-30', runKind: 'preview', positionRatio: 1 });
    const hash = state.runs[state.runs.length - 1].inputHash;
    // 模拟"该哈希已存在"：直接让仓储按当前哈希命中
    const repoModule = require(repositoryPath);
    const originalFind = repoModule.findRunByIdempotencyKey;
    repoModule.findRunByIdempotencyKey = async () => 42;
    const second = await service.computeAndPersist({ market: 'CN', asOfDate: '2026-09-30', runKind: 'preview', positionRatio: 1 });
    repoModule.findRunByIdempotencyKey = originalFind;
    assert.strictEqual(second.reused, true);
    assert.strictEqual(second.runId, 42);
    assert.ok(hash);
    assert.ok(first);
  });
}

// ===== 回测：4 只入选必须保留 26/30 现金 =====
async function runBacktestCases() {
  const calendar = ['2026-03-31', '2026-04-01', '2026-06-30', '2026-07-01', '2026-09-30', '2026-10-01'];
  const members = [1, 2, 3, 4].map(id => ({
    instrumentId: id, code: '60010' + id + '.SH', name: '样本' + id, slotNo: id,
    weightInMarketBudget: 1 / 30, weightInEquityTarget: 1 / 30,
    industry: { code: 'I' + id, name: 'I', system: 'SW2021', version: '2021' },
  }));
  const gate = { eligible: true, status: 'eligible' };
  const computeState = { gate };

  stub(path.join(__dirname, '..', 'services', 'stockSelectionService.js'), {
    STRATEGY_VERSION: 'v1',
    quarterOf: date => `${String(date).slice(0, 4)}Q${Math.ceil(Number(String(date).slice(5, 7)) / 3)}`,
    quarterEndDate: quarter => {
      const year = quarter.slice(0, 4), q = Number(quarter.slice(5));
      const days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      return `${year}-${String(q * 3).padStart(2, '0')}-${days[q * 3 - 1]}`;
    },
    computeSelection: async () => ({
      gate: computeState.gate,
      quality: { publishable: true, pendingCount: 0 },
      portfolio: { members: computeState.gate.eligible ? members : [] },
      params: { slotsPerMarket: 30 },
      positionRatio: 1,
    }),
  });

  const prices = new Map();
  calendar.forEach(day => members.forEach(member => prices.set(`${member.instrumentId}|${day}`, 1)));
  const captured = { periods: [] };
  stub(path.join(__dirname, '..', 'repositories', 'stockSelectionRepository.js'), {
    loadCalendar: async () => calendar,
    loadOpenPrices: async () => prices,
    loadBenchmarkCloses: async () => new Map(calendar.map(day => [day, 100])),
    loadDividendCash: async () => new Map(),
    upsertStrategy: async () => 1,
    insertBacktest: async () => 7,
    insertBacktestPeriods: async (tx, id, periods) => { captured.periods = periods; return { rowCount: periods.length }; },
  });
  stub(path.join(__dirname, '..', 'db', 'transaction.js'), {
    withTransaction: async fn => fn({ query: async () => ({ rows: [] }) }),
  });

  const backtest = require('../services/stockSelectionBacktest');

  await check('SSV-08 只入选 4 只时必须保留约 86.67% 现金，不得变成满仓', async () => {
    computeState.gate = { eligible: true, status: 'eligible' };
    const result = await backtest.runBacktest({
      market: 'CN', startDate: '2026-01-01', endDate: '2026-10-01',
      costs: { buyBps: 0, sellBps: 0 },
    });
    assert.strictEqual(result.status, 'partial', '样本应可评估（有执行价、无未知输入）');
    assert.ok(captured.periods.length >= 1, '必须写出收益序列');
    const first = captured.periods[0];
    // 4 只 × 1/30 = 13.33% 股票，其余 26/30 ≈ 86.67% 留现金（方案 6.1）。
    assert.ok(Math.abs(first.cashWeight - 26 / 30) < 1e-6,
      `首个调仓点现金占比应为 ${(26 / 30).toFixed(4)}，实际 ${first.cashWeight}`);
    assert.strictEqual(first.unpricedCount, 0);
    assert.ok(Math.abs(first.nav - 1) < 1e-9, '价格不变、零费用时净值应为 1');
  });

  await check('SSV-08 市场正常关闭（PB≥2）应按现金策略可还原，不判 not_evaluable', async () => {
    computeState.gate = { eligible: false, status: 'market_closed' };
    const result = await backtest.runBacktest({
      market: 'CN', startDate: '2026-01-01', endDate: '2026-10-01',
      costs: { buyBps: 0, sellBps: 0 },
    });
    assert.notStrictEqual(result.status, 'not_evaluable', '正常关闭是可还原的现金区间');
    assert.strictEqual(result.status, 'partial');
    assert.ok(captured.periods.length >= 1);
    captured.periods.forEach(period => {
      assert.ok(Math.abs(period.cashWeight - 1) < 1e-9, '市场关闭期间必须 100% 现金');
    });
  });

  await check('SSV-08 市场数据缺失仍然不可还原', async () => {
    computeState.gate = { eligible: false, status: 'data_missing' };
    const result = await backtest.runBacktest({
      market: 'CN', startDate: '2026-01-01', endDate: '2026-10-01',
      costs: { buyBps: 0, sellBps: 0 },
    });
    assert.strictEqual(result.status, 'not_evaluable');
    assert.strictEqual(result.diagnostics.missing.reason, 'point_in_time_inputs_incomplete');
  });
}

main().catch(error => { console.error(error); process.exit(1); });

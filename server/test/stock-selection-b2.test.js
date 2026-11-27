// Batch 2 纯函数与适配层回归（B2-1 原因码短路 + B2-2 轻量财报 + B2-3 端点分流/断档）。
// 不联网、不写业务库；需要外部接口的地方全部注入替身。
'use strict';
process.env.NODE_ENV = 'test';

const assert = require('assert');

const tests = [];
async function check(name, fn) {
  try { await fn(); tests.push(['PASS', name]); console.log('  [PASS] ' + name); }
  catch (error) {
    const detail = String(error && (error.stack || error.message || error)).split('\n').slice(0, 3).join(' | ');
    tests.push(['FAIL', name + ' :: ' + detail]); console.log('  [FAIL] ' + name + ' :: ' + detail);
  }
}

const RULES = require('../domain/stockSelectionRules');
const V2 = require('../domain/stockSelectionRulesV2');
const GRAHAM = require('../domain/stockSelectionGrahamRules');
const SERVICE = require('../services/stockSelectionService');

function baseFacts(overrides = {}) {
  return Object.assign({
    instrumentId: 1, companyId: 1, code: '991001.SH', name: 'B2', market: 'CN',
    pb: 1.2, peTtm: 10, price: 10, priceCurrency: 'CNY',
    equity: { amount: 2e10, currency: 'CNY', periodEnd: '2025-12-31' },
    fx: {},
    dividend: { ttmPerShare: 0.5, count: 1, currency: 'CNY', verifiedZero: false },
    annual: {
      latestYear: 2025,
      years: Array.from({ length: 11 }, (_, index) => ({ year: 2015 + index, profit: 1e9, dividend: 1e8, complete: true })),
      currency: 'CNY',
    },
    pbWindow: { maxPb: 1.01, coveredDays: 5, expectedDays: 1000, gapDays: 995 },
    suspended: false, delistedAtTargetDate: false, riskWarning: null,
  }, overrides);
}

function evaluatedItem(overrides = {}) {
  return Object.assign({
    code: '991000.SH', name: 'B2', companyId: 1, instrumentId: 1,
    filterStatus: RULES.STATUS.PASS, rankReady: true, industry: null,
    rules: { R01: { status: RULES.STATUS.PASS }, R02: { status: RULES.STATUS.PASS },
      R04: { status: RULES.STATUS.PASS }, R05: { status: RULES.STATUS.PASS } },
    deterministicElimination: { eliminated: false },
    exclusionReasons: [],
  }, overrides);
}

async function main() {
  console.log('A. B2-1 原因码短路');

  await check('A 类 FAIL 短路无关 PENDING，单规则诊断原样保留', () => {
    const result = RULES.evaluateInstrument(baseFacts({
      pb: -1,
      dividend: { ttmPerShare: null, count: 0, verifiedZero: false },
    }));
    assert.strictEqual(result.rules.R01.status, RULES.STATUS.FAIL);
    assert.strictEqual(result.rules.R04.status, RULES.STATUS.PENDING, '单规则缺口必须原样保留');
    assert.strictEqual(result.filterStatus, RULES.STATUS.FAIL, '确定性 FAIL 不得被其它规则 PENDING 拉回待补');
    assert.strictEqual(result.deterministicElimination.eliminated, true);
  });

  await check('A 类客观不适用白名单短路；未列出的 NOT_APPLICABLE 不短路', () => {
    const whitelisted = RULES.aggregateRuleStatus({
      R01: { status: RULES.STATUS.PASS },
      R02: { status: RULES.STATUS.NOT_APPLICABLE, reason: 'pb_window_empty' },
      R04: { status: RULES.STATUS.PENDING },
      R05: { status: RULES.STATUS.PASS },
    });
    assert.strictEqual(whitelisted.status, RULES.STATUS.NOT_APPLICABLE, '白名单内客观不适用可短路');
    const unverified = RULES.deterministicEliminationOf({
      R01: { status: RULES.STATUS.PASS },
      R02: { status: RULES.STATUS.NOT_APPLICABLE, reason: 'history_coverage_unknown' },
      R04: { status: RULES.STATUS.PENDING },
      R05: { status: RULES.STATUS.PASS },
    });
    assert.strictEqual(unverified.eliminated, false, '未核实前置不得被当成确定性淘汰');
    const aggregate = RULES.aggregateRuleStatus({
      R01: { status: RULES.STATUS.PASS },
      R02: { status: RULES.STATUS.NOT_APPLICABLE, reason: 'history_coverage_unknown' },
      R04: { status: RULES.STATUS.PENDING },
      R05: { status: RULES.STATUS.PASS },
    });
    assert.strictEqual(aggregate.status, RULES.STATUS.PENDING, 'B 类不与 PENDING 竞争时仍应阻断');
  });

  await check('V2 的 history_calendar_unverified 不得短路 PENDING', () => {
    const result = V2.evaluateInstrumentV2({
      instrumentId: 2, companyId: 2, code: '992002.SH', name: 'B2V2', market: 'CN',
      pb: 1.2, peTtm: 10, price: 10, priceCurrency: 'CNY',
      equity: { amount: 2e10, currency: 'CNY', periodEnd: '2025-12-31' },
      fx: {},
      dividend: { ttmPerShare: null, count: 0, verifiedZero: false },
      annual: {
        latestYear: 2025,
        years: Array.from({ length: 11 }, (_, index) => ({ year: 2015 + index, profit: 1e9, dividend: 1e8, complete: true })),
        currency: 'CNY',
      },
      pbWindow: {
        minPb: 0.2, maxPb: 0.8, positiveDays: 100, expectedDays: 100, gapDays: 0,
        calendarComplete: false,
      },
    });
    assert.strictEqual(result.rules.R02.reason, 'history_calendar_unverified');
    assert.strictEqual(result.rules.R04.status, V2.STATUS.PENDING);
    assert.strictEqual(result.filterStatus, V2.STATUS.PENDING, '日历未核实必须继续阻断，不能被 N/A 短路');
    assert.strictEqual(result.deterministicElimination.eliminated, false);
  });

  await check('同冻结输入下，A 类淘汰标的不改变其它候选名次/席位/权重', () => {
    const clean = [
      { instrumentId: 11, code: '600001.SH', filterStatus: 'PASS', rankReady: true, currentPb: 0.8, currentPe: 8, profitStatus: 'profit' },
      { instrumentId: 12, code: '600002.SH', filterStatus: 'PASS', rankReady: true, currentPb: 1.0, currentPe: 12, profitStatus: 'profit' },
      { instrumentId: 13, code: '600003.SH', filterStatus: 'PASS', rankReady: true, currentPb: 1.2, currentPe: 15, profitStatus: 'profit' },
    ].map(item => Object.assign(item, {
      dividendYield: 0.05,
      industry: { code: item.code === '600001.SH' ? '801010' : item.code === '600002.SH' ? '801020' : '801030', name: '测试行业', system: 'SW2021', version: '2021' },
    }));
    const withEliminated = clean.concat([{
      instrumentId: 14, code: '600004.SH', filterStatus: 'FAIL', rankReady: false,
      currentPb: 0.5, currentPe: 5, profitStatus: 'profit', dividendYield: 0.1,
      deterministicElimination: { eliminated: true },
    }]);
    const before = RULES.rankCandidates(clean);
    const after = RULES.rankCandidates(withEliminated);
    assert.deepStrictEqual(after.ranked.map(item => item.instrumentId), before.ranked.map(item => item.instrumentId));
    assert.deepStrictEqual(after.ranked.map(item => item.totalScore), before.ranked.map(item => item.totalScore));
    assert.deepStrictEqual(after.ranked.map(item => item.selectionOrder), before.ranked.map(item => item.selectionOrder));
    const portfolio = ranked => SERVICE.PORTFOLIO.buildPortfolio({
      ranked, anomalyById: {}, positionRatio: 1, slots: 3, industryLimitRatio: 0.2, params: {},
    });
    const beforePortfolio = portfolio(before.ranked);
    const afterPortfolio = portfolio(after.ranked);
    assert.deepStrictEqual(
      afterPortfolio.members.map(item => ({ slotNo: item.slotNo, weight: item.weightInMarketBudget, invested: item.weightInInvestedEquity })),
      beforePortfolio.members.map(item => ({ slotNo: item.slotNo, weight: item.weightInMarketBudget, invested: item.weightInInvestedEquity })),
      'A 类淘汰标的不改变正式组合席位与权重',
    );
  });

  await check('格雷厄姆按自身 G01 合同独立判定，不套用四项规则白名单', () => {
    const fail = GRAHAM.evaluateGrahamCandidate({
      fsTableType: 'non_financial', hasBalanceReport: true,
      currentAssets: '100', currentLiabilities: '80', totalMarketCap: '50', balanceCurrency: 'CNY', valuationCurrency: 'CNY',
    });
    assert.strictEqual(fail.status, RULES.STATUS.FAIL);
    assert.strictEqual(SERVICE.isDeterministicallyEliminated({ rules: { G01: fail.g01 }, filterStatus: 'FAIL' }), true);
    const pending = GRAHAM.evaluateGrahamCandidate({
      fsTableType: 'non_financial', hasBalanceReport: true,
      currentAssets: null, currentLiabilities: '80', totalMarketCap: '50',
    });
    assert.strictEqual(pending.status, RULES.STATUS.PENDING);
    assert.strictEqual(SERVICE.isDeterministicallyEliminated({ rules: { G01: pending.g01 }, filterStatus: 'PENDING' }), false);
    assert.strictEqual(SERVICE.industryRequiredOf({ rules: { G01: pending.g01 }, filterStatus: 'PENDING' }), true);
  });

  await check('行业补采收窄：A 类淘汰与 RISK 不入队，PASS/PENDING 才入队', () => {
    const computed = {
      evaluated: [
        evaluatedItem({ code: 'A', deterministicElimination: { eliminated: true }, filterStatus: 'FAIL' }),
        evaluatedItem({ code: 'B', filterStatus: 'RISK', deterministicElimination: { eliminated: false } }),
        evaluatedItem({ code: 'C', filterStatus: 'PENDING', rankReady: false, deterministicElimination: { eliminated: false } }),
        evaluatedItem({ code: 'D', filterStatus: 'PASS', deterministicElimination: { eliminated: false } }),
      ],
      anomalyById: {},
    };
    const { gaps } = SERVICE.gapsFromComputed(computed);
    const codes = gaps.map(gap => gap.code);
    assert.deepStrictEqual(codes.sort(), ['C', 'D'], '只有 PENDING/PASS 需要行业补齐');
    gaps.forEach(gap => assert.ok(gap.domains.includes('industry')));
  });

  await check('B 类 NOT_APPLICABLE 仍保留缺口原因，不被当成已淘汰', () => {
    const computed = {
      evaluated: [evaluatedItem({
        code: 'E', filterStatus: RULES.STATUS.NOT_APPLICABLE,
        deterministicElimination: { eliminated: false },
        rules: { R02: { status: RULES.STATUS.NOT_APPLICABLE, reason: 'history_coverage_unknown' } },
      })],
      anomalyById: {},
    };
    const { gaps } = SERVICE.gapsFromComputed(computed);
    assert.strictEqual(gaps.length, 0, '纯 NOT_APPLICABLE 不是采集缺口；但也不得被判成 A 类淘汰');
  });

  console.log('B. B2-2 轻量财报双态合同');

  await check('selection_core 只发核心批次（12 年从 28 次降至 2 次）', async () => {
    const calls = [];
    const officialPath = require.resolve('../services/lixingerOfficial');
    const original = require.cache[officialPath];
    require.cache[officialPath] = {
      id: officialPath, filename: officialPath, loaded: true,
      exports: { ...require('../services/lixingerOfficial'),
        callEndpoint: async (endpoint, params) => { calls.push({ endpoint, params }); return { rows: [] }; } },
    };
    const adapterPath = require.resolve('../dataAccess/adapters/lixingerDatasetAdapter');
    delete require.cache[adapterPath];
    const adapter = require(adapterPath);
    try {
      await adapter.resolveFinancialReports({
        tsCode: '600519.SH', startDate: '2014-01-01', endDate: '2025-12-31',
        kinds: ['income', 'balance', 'cashflow', 'indicator'],
        options: { fsTableType: 'non_financial', profile: 'selection_core' },
      });
      assert.strictEqual(calls.length, 2, 'selection_core 12 年只应请求 2 个核心批次');
      calls.forEach(call => {
        assert.ok(call.params.metricsList.length <= 128);
        assert.ok(call.params.metricsList.every(code => !/\.(?:t_y2y|t_c2c|c|c_y2y|c_c2y|c_c2c)$/.test(code)),
          'selection_core 不得请求原生比较值/单季批次');
      });
    } finally {
      if (original) require.cache[officialPath] = original; else delete require.cache[officialPath];
      delete require.cache[adapterPath];
    }
  });

  await check('core_complete=false 时数据层拒绝落标准层', async () => {
    const adapterPath = require.resolve('../dataAccess/adapters/lixingerDatasetAdapter');
    const original = require.cache[adapterPath];
    const adapterModule = require(adapterPath);
    const originalFn = adapterModule.resolveFinancialReports;
    adapterModule.resolveFinancialReports = async () => ({
      balance: [{
        ts_code: '600519.SH', end_date: '20251231', ann_date: '20260301', source_code: 'lixinger_official',
        __statement_coverage: { core_complete: false, full_statements_complete: false, complete: false },
      }],
      income: [], cashflow: [], indicator: [],
    });
    const datasetsPath = require.resolve('../dataAccess/marketDatasets');
    delete require.cache[datasetsPath];
    const datasets = require(datasetsPath);
    try {
      await assert.rejects(
        datasets.readFinancialReportRows({
          tsCode: '600519.SH', kinds: ['balance'], startDate: '2024-01-01', endDate: '2025-12-31',
          fsTableType: 'non_financial', profile: 'selection_core',
        }),
        error => error.code === 'FINANCIAL_CORE_INCOMPLETE',
      );
    } finally {
      adapterModule.resolveFinancialReports = originalFn;
      if (original) require.cache[adapterPath] = original;
      delete require.cache[datasetsPath];
    }
  });

  await check('批量 fsTableType：只对缺失代码按 ≤100 只/批查档案', async () => {
    const inputs = require('../services/stockSelectionInputsSync');
    const calls = [];
    const result = await inputs.resolveBatchFsTableTypes({
      codes: ['600519.SH', '000001.SZ', '00700.HK'],
      deps: {
        loadFsTableTypes: async () => new Map([['600519.SH', 'non_financial']]),
        readCnCompanyProfiles: async ({ codes }) => { calls.push({ market: 'CN', codes }); return codes.map(code => ({ code, fsTableType: 'bank' })); },
        readCompanyProfiles: async ({ codes }) => { calls.push({ market: 'HK', codes }); return codes.map(code => ({ code, fsTableType: 'non_financial' })); },
      },
    });
    assert.strictEqual(result.get('600519.SH'), 'non_financial');
    assert.strictEqual(result.get('000001.SZ'), 'bank');
    assert.strictEqual(result.get('00700.HK'), 'non_financial');
    assert.strictEqual(calls.length, 2, '本地已核实的代码不得再查档案');
    assert.deepStrictEqual(calls.find(call => call.market === 'CN').codes, ['000001.SZ']);
    assert.deepStrictEqual(calls.find(call => call.market === 'HK').codes, ['00700.HK']);
  });

  console.log('C. B2-3 港股端点分流与断档');

  await check('港股非金融/银行按 fsTableType 分流；未知类型留缺口不硬发', async () => {
    const calls = [];
    const officialPath = require.resolve('../services/lixingerOfficial');
    const original = require.cache[officialPath];
    require.cache[officialPath] = {
      id: officialPath, filename: officialPath, loaded: true,
      exports: { ...require('../services/lixingerOfficial'),
        callEndpoint: async (endpoint, params) => {
          calls.push({ endpoint, params });
          return { rows: params.stockCodes.map(code => ({ stockCode: code, date: params.date, pb: 1.1, pe_ttm: 9, mc: 1e10 })) };
        } },
    };
    const adapterPath = require.resolve('../dataAccess/adapters/lixingerDatasetAdapter');
    delete require.cache[adapterPath];
    const adapter = require(adapterPath);
    try {
      const detail = await adapter.resolveValuationRowsDetailed({
        codes: ['00700.HK', '00939.HK', '09999.HK'], tradeDate: '2026-11-04',
        options: { fsTableTypes: new Map([['00700.HK', 'non_financial'], ['00939.HK', 'bank']]) },
      });
      const endpoints = calls.map(call => call.endpoint).sort();
      assert.deepStrictEqual(endpoints, ['hk/company/fundamental/bank', 'hk/company/fundamental/non_financial']);
      assert.deepStrictEqual(detail.gaps.unknownTypeCodes, ['09999.HK'], '未知类型不得硬发非金融端点');
      assert.strictEqual(detail.gaps.missingCodes.length, 0);
    } finally {
      if (original) require.cache[officialPath] = original; else delete require.cache[officialPath];
      delete require.cache[adapterPath];
    }
  });

  await check('逐证券核对 trade_date 与必需字段；漏返回/日期不符/字段不齐进入缺口', async () => {
    const officialPath = require.resolve('../services/lixingerOfficial');
    const original = require.cache[officialPath];
    require.cache[officialPath] = {
      id: officialPath, filename: officialPath, loaded: true,
      exports: { ...require('../services/lixingerOfficial'),
        callEndpoint: async (endpoint, params) => ({
          rows: params.stockCodes
            .filter(code => code !== '00003')
            .map(code => code === '00002'
              ? { stockCode: code, date: '2026-11-03', pb: 1.1, pe_ttm: 9, mc: 1e10 } // 日期不符
              : { stockCode: code, date: params.date, pb: null, pe_ttm: 9, mc: 1e10 }), // pb 缺失
        }) },
    };
    const adapterPath = require.resolve('../dataAccess/adapters/lixingerDatasetAdapter');
    delete require.cache[adapterPath];
    const adapter = require(adapterPath);
    try {
      const detail = await adapter.resolveValuationRowsDetailed({
        codes: ['00001.HK', '00002.HK', '00003.HK'], tradeDate: '2026-11-04',
        options: { fsTableTypes: new Map([
          ['00001.HK', 'non_financial'], ['00002.HK', 'non_financial'], ['00003.HK', 'non_financial'],
        ]) },
      });
      assert.deepStrictEqual(detail.gaps.fieldIncompleteCodes, ['00001.HK']);
      assert.deepStrictEqual(detail.gaps.dateMismatchCodes, ['00002.HK']);
      assert.deepStrictEqual(detail.gaps.missingCodes, ['00003.HK']);
      assert.strictEqual(detail.businessComplete, false, '业务覆盖不完整不得只看请求 complete');
    } finally {
      if (original) require.cache[officialPath] = original; else delete require.cache[officialPath];
      delete require.cache[adapterPath];
    }
  });

  await check('尾部仅缺 1–5 天时只补断档段，不重拉 11 年历史', async () => {
    const inputs = require('../services/stockSelectionInputsSync');
    const calendar = ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05',
      '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10'];
    const covered = new Set(calendar.slice(0, 7));
    const segments = inputs.missingDateSegments({
      expected: calendar, covered, startDate: '2015-11-10', endDate: '2026-11-10',
    });
    assert.deepStrictEqual(segments, [{ startDate: '2026-11-08', endDate: '2026-11-10' }]);
  });

  await check('collectHkMarketData 只请求本地未覆盖的尾部段', async () => {
    const repoPath = require.resolve('../repositories/stockSelectionRepository');
    const storePath = require.resolve('../services/convertibleBondAnalysisStore');
    const originalRepo = require.cache[repoPath];
    const originalStore = require.cache[storePath];
    const saved = [];
    require.cache[repoPath] = {
      id: repoPath, filename: repoPath, loaded: true,
      exports: {
        upsertDailyValuationRows: async ({ rows }) => { saved.push(['valuation', rows]); return rows.length; },
        upsertDailyBarRows: async ({ rows }) => { saved.push(['bars', rows]); return rows.length; },
      },
    };
    require.cache[storePath] = {
      id: storePath, filename: storePath, loaded: true,
      exports: { sourceIds: async () => ({ lixinger_official: 9, tencent: 3 }) },
    };
    const servicePath = require.resolve('../services/stockSelectionInputsSync');
    delete require.cache[servicePath];
    const inputs = require(servicePath);
    const calls = [];
    const calendar = ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05',
      '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10'];
    const covered = new Set(calendar.slice(0, 7));
    try {
      const result = await inputs.collectHkMarketData(
        { code: '00700.HK' }, '2026-11-10', null, {
          fsTableType: 'non_financial',
          readMeta: async () => ({ instrument_id: 1, ts_code: '00700.HK', market: 'HK', currency_code: 'HKD' }),
          loadHkCoverageDates: async () => ({ valuation: covered, bars: covered }),
          loadHkTradeCalendar: async () => calendar,
          datasets: {
            readStockValuationSeriesBatch: async ({ startDate, endDate }) => {
              calls.push(['valuation', startDate, endDate]);
              return [{ ts_code: '00700.HK', trade_date: endDate.replace(/-/g, ''), pb: 1.1, pe_ttm: 9, total_mv: 1000 }];
            },
            readStockDailySeries: async ({ startDate, endDate }) => {
              calls.push(['bars', startDate, endDate]);
              return [{ ts_code: '00700.HK', trade_date: endDate.replace(/-/g, ''), close: 50, source_code: 'lixinger_official' }];
            },
          },
        },
      );
      const valuationCall = calls.find(call => call[0] === 'valuation');
      assert.strictEqual(valuationCall[1], '2026-11-08', '估值只补尾部 3 天');
      assert.strictEqual(valuationCall[2], '2026-11-10');
      const barCall = calls.find(call => call[0] === 'bars');
      assert.strictEqual(barCall[1], '2026-11-08', '行情只补尾部 3 天');
      assert.strictEqual(result.valuations, 1);
    } finally {
      if (originalRepo) require.cache[repoPath] = originalRepo; else delete require.cache[repoPath];
      if (originalStore) require.cache[storePath] = originalStore; else delete require.cache[storePath];
      delete require.cache[servicePath];
    }
  });

  const failed = tests.filter(item => item[0] === 'FAIL').length;
  console.log(`\n==== Batch 2 结果: ${tests.length - failed}/${tests.length} 通过 ====`);
  if (failed) {
    tests.filter(item => item[0] === 'FAIL').forEach(item => console.log('  - ' + item[1]));
    process.exit(1);
  }
}

main().catch(error => { console.error(error && (error.stack || error.message)); process.exit(1); });

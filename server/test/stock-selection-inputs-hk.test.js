// 港股选股补齐专项测试（不连数据库、不调外部接口）。
// 覆盖 2026-11-05 新增的三件事：
//  1) 港股估值缺口由选股补齐自己补（A 股仍不补，等共享行情任务）；
//  2) 估值/股息率/总市值的单位从数据层口径换算为标准层口径，币种随行写入；
//  3) 恒生成分股先补行情再审计（没有行情的证券根本不进选股池）。
'use strict';
const assert = require('assert');
const path = require('path');

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

const SERVICE = '../services/stockSelectionInputsSync';
const REPO = '../repositories/stockSelectionRepository';
const DATASETS = '../dataAccess/marketDatasets';
const STORE = '../services/convertibleBondAnalysisStore';
const SELECTION = '../services/stockSelectionService';

/** 造一套可控依赖，返回调用记录。 */
function buildEnv(options = {}) {
  const calls = { valuations: [], bars: [], fetchedValuationCodes: [], fetchedBarCodes: [], savedQueue: null };

  const repoStub = {
    readInputGapQueue: async () => null,
    saveInputGapQueue: async arg => { calls.savedQueue = arg && arg.payload !== undefined ? arg.payload : arg; return 1; },
    findInstrumentMeta: async ({ tsCode }) => ({
      instrument_id: Number(String(tsCode).replace(/\D/g, '').slice(-4)) || 1,
      ts_code: tsCode, name: '测试', market: 'HK', currency_code: 'HKD', raw_data: {},
    }),
    // F-11：批量快照落库前需要把证券代码绑定到 instrument_id（不逐股查档案）。
    resolveInstrumentsByCodes: async ({ codes = [] } = {}) => codes.map((code, index) => ({
      instrument_id: Number(String(code).replace(/\D/g, '').slice(-4)) || (9000 + index),
      code, name: '测试', market: 'HK',
    })),
    listCodesWithRecentBars: async () => new Set(options.coveredCodes || []),
    // 断档补采只覆盖夹具声明的日期范围，避免回退到 11 年逐日估算。
    loadHkCoverageDates: async () => ({
      valuation: new Set(options.coveredValuationDates || []),
      bars: new Set(options.coveredBarDates || []),
    }),
    loadHkTradeCalendar: async () => options.calendar || [],
    upsertDailyValuationRows: async ({ rows, sourceId }) => { calls.valuations.push({ rows, sourceId }); return rows.length; },
    upsertDailyBarRows: async ({ rows, sourceId }) => { calls.bars.push({ rows, sourceId }); return rows.length; },
  };

  const datasetsStub = {
    readIndexConstituents: async () => (options.constituents || [
      { code: '00001.HK', name: '长和' }, { code: '00002.HK', name: '中电控股' },
    ]),
    readMutualMarketCompanies: async () => (options.mutualMarketCompanies || []),
    // 财报类型未知时批量补查；默认给非金融，保持既有用例语义不变。
    // 支持传函数（按 codes 动态返回）或固定数组（既有用例）。
    readCompanyProfiles: async ({ codes = [] } = {}) => {
      if (options.companyProfiles === undefined) {
        return codes.map(code => ({ code, name: null, fsTableType: 'non_financial' }));
      }
      return typeof options.companyProfiles === 'function'
        ? options.companyProfiles(codes)
        : options.companyProfiles;
    },
    readStockValuationSeriesBatch: async ({ codes }) => {
      calls.fetchedValuationCodes.push(...codes);
      // 官方真实返回的 trade_date 是紧凑格式（2026-11-05 实测：估值与日线都给 20261104），
      // 夹具按真实返回造，避免"日期归一漏了也能过"。
      return options.valuationRows || [
        { ts_code: codes[0], trade_date: '20261104', pe: null, pe_ttm: 9.5, pb: 0.8, dv_ttm: 5, total_mv: 1000, circ_mv: null, currency: 'HKD' },
      ];
    },
    readStockDailySeries: async ({ tsCode }) => {
      calls.fetchedBarCodes.push(tsCode);
      return options.barRows || [
        { ts_code: tsCode, trade_date: '20261104', close: 50, open: 49, high: 51, low: 48, vol: 100, amount: 5000, source_code: 'lixinger_official' },
        { ts_code: tsCode, trade_date: '2026-11-03', close: 49.5, source_code: 'tencent' },
      ];
    },
    // 财报/分红：本用例只验证估值与行情，返回空即不进 persistCollectedData。
    readFinancialReportRows: async () => null,
    readDividendRows: async () => [],
    ...(options.datasets || {}),
  };

  const storeStub = { sourceIds: async () => ({ lixinger_official: 9, tencent: 3, tushare: 1 }) };

  const gapSets = options.gaps || {};
  let auditCall = 0;
  const selectionStub = {
    auditInputs: async () => {
      auditCall += 1;
      // 第一次审计返回缺口，第二次（补齐后）返回剩余缺口，便于验证队列与完成判定。
      const gaps = auditCall === 1 ? (gapSets.before || []) : (gapSets.after || []);
      return { gaps, coverage: { universeCount: 2 }, domainCounts: {} };
    },
    auditInputsForCodes: options.auditInputsForCodes || (async ({ codes = [] }) => ({
      gaps: [], evaluatedCodes: codes, universeCount: codes.length,
    })),
  };

  stub(REPO, repoStub);
  stub(DATASETS, datasetsStub);
  stub(STORE, storeStub);
  stub(SELECTION, selectionStub);
  const servicePath = require.resolve(SERVICE);
  delete require.cache[servicePath];
  const service = require(SERVICE);
  return { service, calls };
}

async function main() {
  await check('港股估值缺口：本任务自己补，单位按标准层换算且写入币种', async () => {
    const { service, calls } = buildEnv({
      gaps: {
        before: [{ code: '00001.HK', domains: ['valuation'], reasons: ['R01:pb_unavailable'] }],
        after: [],
      },
    });
    const result = await service.syncSelectionInputs({ market: 'HK', asOfDate: '2026-11-04' });
    assert.deepStrictEqual(calls.fetchedValuationCodes, ['00001.HK'], '港股估值缺口必须真的去取估值序列');
    const written = calls.valuations.flatMap(item => item.rows);
    assert.strictEqual(written.length, 1);
    assert.strictEqual(written[0].dividendYield, 0.05, 'dv_ttm 百分数点必须换成小数');
    assert.strictEqual(written[0].totalMarketCap, 10000000, 'total_mv 万元必须换成元');
    assert.strictEqual(written[0].currencyCode, 'HKD', '港股必须写入 HKD，不能当人民币');
    assert.strictEqual(written[0].tradeDate, '2026-11-04', '官方紧凑日期 20261104 必须归一成标准层日期');
    assert.strictEqual(calls.valuations[0].sourceId, 9, '来源必须记在官方名下');
    assert.strictEqual(result.valuationProcessed, 1);
  });

  await check('F-11 港股目标日多端点批量估值快照：仅缺目标日估值不逐股拉序列', async () => {
    const valuationGap = (code, reason) => ({ code, name: code, domains: ['valuation'], reasons: [reason] });
    const gapsBefore = [
      valuationGap('00001.HK', 'R01:pb_unavailable'),
      valuationGap('00939.HK', 'R01:pb_unavailable'),
      valuationGap('09999.HK', 'R01:pb_unavailable'),
      valuationGap('00002.HK', 'R02:history_coverage_unknown'),
      valuationGap('00003.HK', 'R01:pb_unavailable'),
      valuationGap('00004.HK', 'R01:pb_unavailable'),
      valuationGap('00005.HK', 'R01:pb_unavailable'),
    ];
    const fsTypeByCode = {
      '00001.HK': 'non_financial', '00939.HK': 'bank',
      '00002.HK': 'non_financial', '00003.HK': 'non_financial',
      '00004.HK': 'non_financial', '00005.HK': 'non_financial', '09999.HK': null,
    };
    const snapshotCalls = [];
    const snapshotRows = [
      { ts_code: '00001.HK', trade_date: '2026-11-04', pb: 0.8, pe_ttm: 9, dv_ttm: 5, total_mv: 1000, circ_mv: null, currency: 'HKD' },
      { ts_code: '00939.HK', trade_date: '2026-11-04', pb: 0.6, pe_ttm: 5, dv_ttm: 6, total_mv: 2000, circ_mv: null, currency: 'HKD' },
      { ts_code: '00002.HK', trade_date: '2026-11-04', pb: 0.5, pe_ttm: 4, dv_ttm: 7, total_mv: 3000, circ_mv: null, currency: 'HKD' },
      // 00003 漏返回；00004 日期不符；00005 字段不齐（pb 缺失）。
      { ts_code: '00004.HK', trade_date: '2026-11-03', pb: 0.9, pe_ttm: 8, total_mv: 4000, currency: 'HKD' },
      { ts_code: '00005.HK', trade_date: '2026-11-04', pb: null, pe_ttm: 8, total_mv: 5000, currency: 'HKD' },
    ];
    const stillGap = new Set(['00002.HK', '00003.HK', '00004.HK', '00005.HK', '09999.HK']);
    const { service, calls } = buildEnv({
      coveredCodes: ['00001.HK', '00939.HK', '00002.HK', '00003.HK', '00004.HK', '00005.HK'],
      coveredValuationDates: ['2026-11-03'], coveredBarDates: ['2026-11-03'],
      calendar: ['2026-11-03', '2026-11-04'],
      constituents: gapsBefore.map(gap => ({ code: gap.code, name: gap.code })),
      companyProfiles: codes => codes.map(code => ({ code, fsTableType: fsTypeByCode[code] || null })),
      gaps: { before: gapsBefore, after: gapsBefore.filter(gap => stillGap.has(gap.code)) },
      datasets: {
        readValuationSnapshotDetailed: async ({ codes, tradeDate, fsTableTypes }) => {
          snapshotCalls.push({ codes: codes.slice(), tradeDate, fsTableTypes });
          return {
            rows: snapshotRows.filter(row => codes.includes(row.ts_code)),
            complete: true, planned: 1, attempted: 1, succeeded: 1, failed: 0, notAttempted: 0, emptyBatches: 0,
            gaps: {
              missingCodes: ['00003.HK'], dateMismatchCodes: ['00004.HK'],
              fieldIncompleteCodes: ['00005.HK'], unknownTypeCodes: [],
            },
            businessComplete: false,
          };
        },
      },
      auditInputsForCodes: async ({ codes = [] }) => ({
        gaps: gapsBefore.filter(gap => stillGap.has(gap.code) && codes.includes(gap.code)),
        evaluatedCodes: codes,
        universeCount: codes.length,
      }),
    });
    const result = await service.syncSelectionInputs({ market: 'HK', asOfDate: '2026-11-04' });

    // 1) 多端点批量快照被实际调用（一次），且已按 fsTableType 分组路由。
    assert.strictEqual(snapshotCalls.length, 1, '目标日估值必须走一次多端点批量快照，而不是逐股序列');
    assert.deepStrictEqual(snapshotCalls[0].codes.slice().sort(),
      ['00001.HK', '00002.HK', '00003.HK', '00004.HK', '00005.HK', '00939.HK'],
      '未知类型不得硬发非金融端点，应排除在快照请求之外');
    assert.strictEqual(snapshotCalls[0].tradeDate, '2026-11-04');
    assert.ok(snapshotCalls[0].fsTableTypes instanceof Map, '必须透传按代码解析的 fsTableType');
    assert.strictEqual(snapshotCalls[0].fsTableTypes.get('00939.HK'), 'bank', '银行必须路由到 bank 端点组');

    // 2) 快照落库正确：三只齐备的港股写入目标日估值。
    const snapshotWritten = calls.valuations[0].rows.map(row => row.instrumentId);
    assert.strictEqual(snapshotWritten.length, 5, '快照返回的 5 行必须一次性落库（含日期不符/字段不齐行照常保留原文）');
    const snapshotTradeDates = calls.valuations[0].rows.map(row => row.tradeDate);
    assert.ok(snapshotTradeDates.includes('2026-11-04'));

    // 3) 仅缺目标日估值的港股不再逐股拉 11 年序列；历史/漏码/日期不符/字段不齐才续补。
    assert.ok(!calls.fetchedValuationCodes.includes('00001.HK'), '目标日已补齐的港股不得再逐股拉序列');
    assert.ok(!calls.fetchedValuationCodes.includes('00939.HK'), '银行目标日已补齐不得再逐股拉序列');
    assert.deepStrictEqual(calls.fetchedValuationCodes.slice().sort(),
      ['00002.HK', '00003.HK', '00004.HK', '00005.HK'],
      '只有历史断档/漏码/日期不符/字段不齐的港股才回退序列');

    // 4) 未知类型/漏码/日期不符/字段不齐仍留在剩余缺口队列中。
    assert.strictEqual(result.remainingValuation, 5, '未知类型与未补齐的港股必须继续留在剩余缺口');
    const remainingCodes = calls.savedQueue.gaps.map(gap => gap.code).sort();
    assert.deepStrictEqual(remainingCodes,
      ['00002.HK', '00003.HK', '00004.HK', '00005.HK', '09999.HK'],
      '剩余缺口队列必须包含未知类型与未补齐目标日估值的港股');
  });

  await check('F-14 批量已查档案仍无类型时，collectOne 不再单只重查档案', async () => {
    let profileCalls = 0;
    const { service } = buildEnv({});
    const result = await service.collectOne(
      { code: '09999.HK', name: '09999.HK', domains: ['financial_reports'] },
      '2026-11-04', null,
      {
        fsTableTypeByCode: new Map(),
        fsTableTypeChecked: new Set(['09999.HK']),
        datasets: {
          readCompanyProfiles: async () => { profileCalls += 1; return [{ code: '09999.HK', fsTableType: 'non_financial' }]; },
          readFinancialReportRows: async () => null,
          readDividendRows: async () => [],
        },
      },
    );
    assert.strictEqual(profileCalls, 0, '批量已核对过档案仍无类型时不得再为同一只港股发单只档案');
    assert.strictEqual(result.reason, 'source_returned_empty');
  });

  await check('A 股估值缺口不进本任务：保持原有边界（等共享行情任务）', async () => {
    const { service, calls } = buildEnv({
      gaps: {
        before: [{ code: '600519.SH', domains: ['valuation'], reasons: ['R01:pb_unavailable'] }],
        after: [{ code: '600519.SH', domains: ['valuation'], reasons: ['R01:pb_unavailable'] }],
      },
    });
    const result = await service.syncSelectionInputs({ market: 'CN', asOfDate: '2026-11-04' });
    assert.deepStrictEqual(calls.fetchedValuationCodes, [], 'A 股不应由选股补齐去取估值');
    assert.strictEqual(result.valuationProcessed, 0);
    assert.strictEqual(result.remainingValuation, 1, 'A 股估值缺口仍要如实记为剩余');
  });

  await check('目标池行情：只补没有近期行情的成分股，已有行情的跳过', async () => {
    const { service, calls } = buildEnv({ coveredCodes: ['00001.HK'] });
    const pool = await service.syncHkTargetPoolBars({ asOfDate: '2026-11-04', maxCodes: 10 });
    assert.strictEqual(pool.targetCount, 2);
    assert.strictEqual(pool.pending, 1, '已有近 60 天行情的成分不再列为待补');
    assert.deepStrictEqual(calls.fetchedBarCodes, ['00002.HK'], '只应请求缺行情的成分');
    assert.ok(pool.succeeded >= 1, '补到的行情必须计入成功');
  });

  await check('目标池行情：官方与腾讯混用时按来源分别落库', async () => {
    const { service, calls } = buildEnv({ coveredCodes: [] });
    await service.syncHkTargetPoolBars({ asOfDate: '2026-11-04', maxCodes: 1 });
    const bySource = calls.bars.map(item => item.sourceId).sort();
    assert.deepStrictEqual(bySource, [3, 9], '官方与腾讯的行必须各自记来源，不能一律记官方');
    const dates = calls.bars.flatMap(item => item.rows.map(row => row.tradeDate)).sort();
    assert.deepStrictEqual(dates, ['2026-11-03', '2026-11-04'], 'YYYYMMDD 与 YYYY-MM-DD 都要归一成日期');
  });

  await check('港股补齐会先补目标池行情，再审计缺口', async () => {
    const { service, calls } = buildEnv({
      coveredCodes: [],
      gaps: { before: [{ code: '00001.HK', domains: ['valuation'], reasons: ['R01:pb_unavailable'] }], after: [] },
    });
    const result = await service.syncSelectionInputs({ market: 'HK', asOfDate: '2026-11-04', batchLimit: 5 });
    assert.ok(result.targetPool, '港股补齐必须回报目标池结果');
    assert.strictEqual(result.targetPool.processed, 2, '两个成分都缺行情，都应在本次补');
    assert.ok(calls.fetchedBarCodes.length >= 2, '目标池行情必须先于缺口审计执行');
  });

  await check('港股目标池：恒生成分与港股通合并去重，只认互联互通标记为真的标的', async () => {
    const { service } = buildEnv({
      constituents: [{ code: '00001.HK', name: '长和' }, { code: '00700.HK', name: '腾讯控股' }],
      mutualMarketCompanies: [
        { code: '00700.HK', name: '腾讯控股', mutualMarketFlag: true },
        { code: '00005.HK', name: '汇丰控股', mutualMarketFlag: true },
        { code: '01448.HK', name: '福寿园', mutualMarketFlag: false },
      ],
    });
    const pool = await service.resolveHkTargetPool({ asOfDate: '2026-11-04' });
    assert.deepStrictEqual(pool.codes.slice().sort(), ['00001.HK', '00005.HK', '00700.HK'], '两边来源要合并去重');
    assert.strictEqual(pool.hsiCount, 2, '恒生成分数量如实回报');
    assert.strictEqual(pool.mutualMarketCount, 2, '只统计标记为真的港股通标的，false 不入池也不计数');
    assert.strictEqual(pool.overlapCount, 1, '两边都有的标的只算一次并计入重叠');
  });

  await check('港股目标池：六类财报类型全部纳入，只有类型未知才排除', async () => {
    const { service } = buildEnv({
      constituents: [{ code: '00001.HK', name: '长和' }],
      companyProfiles: [{ code: '00001.HK', fsTableType: 'non_financial' }],
      mutualMarketCompanies: [
        { code: '00700.HK', name: '腾讯控股', mutualMarketFlag: true, fsTableType: 'non_financial' },
        { code: '00939.HK', name: '建设银行', mutualMarketFlag: true, fsTableType: 'bank' },
        { code: '01299.HK', name: '友邦保险', mutualMarketFlag: true, fsTableType: 'insurance' },
        { code: '06030.HK', name: '中信证券', mutualMarketFlag: true, fsTableType: 'security' },
        { code: '09999.HK', name: '类型未知', mutualMarketFlag: true, fsTableType: null },
      ],
    });
    const pool = await service.resolveHkTargetPool({ asOfDate: '2026-11-04' });
    assert.deepStrictEqual(pool.codes.slice().sort(), ['00001.HK', '00700.HK', '00939.HK', '01299.HK', '06030.HK'],
      '银行/保险/证券都要入池，只有类型未知的排除');
    assert.strictEqual(pool.excludedCount, 1, '未知类型必须如实计数');
    assert.deepStrictEqual(pool.excludedByType, { unknown: 1 });
    assert.strictEqual(pool.fsTableTypes.length, 6, '支持的财报类型要列全');
  });

  await check('港股财报：金融类型走对应端点且按该类型科目分批', async () => {
    const calls = [];
    stub('../services/lixingerOfficial', {
      callEndpoint: async (endpoint, params) => {
        calls.push({ endpoint, metricsList: params.metricsList || [] });
        return { rows: [] };
      },
    });
    const adapterPath = require.resolve('../dataAccess/adapters/lixingerDatasetAdapter');
    delete require.cache[adapterPath];
    const adapter = require(adapterPath);
    await adapter.resolveFinancialReports({
      tsCode: '00939.HK', startDate: '2024-01-01', endDate: '2026-11-04',
      kinds: ['income', 'balance', 'cashflow', 'indicator'], options: { fsTableType: 'bank' },
    });
    assert.ok(calls.length >= 2, '金融类型目录必须按上限分批');
    assert.strictEqual(calls[0].endpoint, 'hk/company/fs/bank', '银行必须走银行端点，不能套非金融端点');
    const metrics = calls[0].metricsList;
    assert.ok(metrics.includes('q.ps.npatoshopc.t_o'), '普通股净利润必须取原始值');
    assert.ok(metrics.includes('q.bs.tetoshopc.t_o'), '普通股权益必须取原始值');
    assert.ok(metrics.includes('q.bs.ta.t_o'), '总资产必须取原始值');
    assert.ok(!metrics.includes('q.ps.toi.t_o'), '金融类不发营业总收入，避免整批被判非法');
    const bankCodes = new Set(require('../dataAccess/lixingerReportMetrics').metricsOfType('HK', 'bank')
      .map(item => item.code));
    assert.ok(calls.every(call => call.endpoint === 'hk/company/fs/bank'
      && call.metricsList.length <= 128 && call.metricsList.every(metric => {
        const base = String(metric).replace(/^q\./, '').replace(/\.(?:t(?:_o)?|t_(?:y2y|c2c)|c(?:_o)?|c_(?:y2y|c2c))$/, '');
        return bankCodes.has(base);
      })));

    calls.length = 0;
    await adapter.resolveFinancialReports({
      tsCode: '00700.HK', startDate: '2024-01-01', endDate: '2026-11-04',
      kinds: ['income', 'balance'], options: { fsTableType: 'non_financial' },
    });
    assert.strictEqual(calls[0].endpoint, 'hk/company/fs/non_financial', '非金融仍走原端点');
    assert.ok(calls[0].metricsList.includes('q.ps.toi.t_o'), '非金融保留营业总收入原始值');
  });

  await check('财报分批：不同公告版本不能混拼，仅有扩展科目也必须保留并标明缺批', async () => {
    let batch = 0;
    stub('../services/lixingerOfficial', {
      callEndpoint: async () => {
        const n = batch++;
        const make = (reportDate, q, standardDate = '2025-12-31') => ({
          standardDate, date: standardDate, reportDate, reportType: 'annual_report',
          stockCode: '600519', currency: 'CNY', q,
        });
        if (n === 0) return { rows: [
          make('2026-03-01', { bs: { ta: { t: 100 } } }),
          make('2026-04-01', { bs: { ta: { t: 200 } } }),
        ] };
        if (n === 1) return { rows: [
          make('2026-03-01', { bs: { capr: { t: 10 } } }),
          make('2026-04-01', { bs: { capr: { t: 20 } } }),
          make('2025-03-01', { bs: { capr: { t: 30 } } }, '2024-12-31'),
        ] };
        return { rows: [make('2026-04-01', {})] };
      },
    });
    const adapterPath = require.resolve('../dataAccess/adapters/lixingerDatasetAdapter');
    delete require.cache[adapterPath];
    const adapter = require(adapterPath);
    const reports = await adapter.resolveFinancialReports({
      tsCode: '600519.SH', startDate: '2024-01-01', endDate: '2025-12-31', kinds: ['balance'],
      options: { fsTableType: 'non_financial' },
    });
    assert.strictEqual(reports.balance.length, 3, '两份版本和仅有扩展字段的报告都应保留');
    const first = reports.balance.find(row => row.ann_date === '20260301');
    const revised = reports.balance.find(row => row.ann_date === '20260401');
    const partial = reports.balance.find(row => row.end_date === '20241231');
    assert.strictEqual(first.total_assets, 100);
    assert.strictEqual(first.update_flag, null, '来源未提供重述标志，不得造出未重述');
    assert.strictEqual(first.__statement_metrics['bs.capr'], 10);
    assert.strictEqual(revised.total_assets, 200);
    assert.strictEqual(revised.__statement_metrics['bs.capr'], 20);
    assert.strictEqual(first.__statement_coverage.complete, false, '缺失分批的版本不得标为完整');
    assert.strictEqual(revised.__statement_coverage.complete, true);
    assert.strictEqual(partial.__statement_metrics['bs.capr'], 30);
    assert.strictEqual(partial.__statement_coverage.complete, false);
  });

  await check('港股金融标准事实不能用普通股专属科目冒充归母合计', async () => {
    const calls = [];
    let includeParentEquity = true;
    stub('../services/lixingerOfficial', {
      callEndpoint: async (endpoint, params) => {
        calls.push({ endpoint, metrics: params.metricsList });
        return { rows: [{ date: '2025-12-31', standardDate: '2025-12-31', reportDate: '2026-03-01',
          reportType: 'annual_report', currency: 'USD', q: {
            ps: { oi: { t: 7, t_o: 1 }, npatoshopc: { t: 350, t_o: 45 }, npatshaoehopc: { t: 428, t_o: 55 } },
            bs: { ta: { t: 15, t_o: 2 }, tl: { t: 900 }, tetoshopc: { t: 3509, t_o: 451 }, tetshaoehopc: { t: 4287, t_o: includeParentEquity ? 551 : null } },
          } }] };
      },
    });
    const adapterPath = require.resolve('../dataAccess/adapters/lixingerDatasetAdapter');
    delete require.cache[adapterPath];
    const adapter = require(adapterPath);
    const read = fsTableType => adapter.resolveFinancialReports({ tsCode: '00005.HK',
      startDate: '2025-01-01', endDate: '2025-12-31', kinds: ['income', 'balance'], options: { fsTableType } });
    const bank = await read('bank');
    assert.strictEqual(bank.income[0].n_income_attr_p, 55);
    assert.strictEqual(bank.balance[0].total_hldr_eqy_exc_min_int, 551);
    assert.strictEqual(bank.balance[0].total_liab, null, '原始值缺失不能回退换算后的 .t');
    assert.strictEqual(bank.balance[0].__statement_metrics['bs.tl'], undefined);
    assert.strictEqual(bank.balance[0].__statement_coverage.value_basis, 'source_original_t_o');
    assert.ok(calls[0].metrics.includes('q.ps.npatshaoehopc.t_o'));
    assert.ok(calls[0].metrics.includes('q.bs.tetshaoehopc.t_o'));
    assert.strictEqual(bank.income[0].__statement_metrics['ps.npatoshopc'], 45);
    const insuranceStart = calls.length;
    const insurance = await read('insurance');
    assert.strictEqual(insurance.income[0].n_income_attr_p, undefined);
    assert.strictEqual(insurance.balance[0].total_hldr_eqy_exc_min_int, 551);
    assert.ok(!calls[insuranceStart].metrics.includes('q.ps.npatshaoehopc.t_o'));
    assert.ok(calls[insuranceStart].metrics.includes('q.bs.tetshaoehopc.t_o'));
    assert.strictEqual(insurance.balance[0].__statement_metrics['bs.tetoshopc'], 451);
    assert.strictEqual((await read('security')).balance[0].total_hldr_eqy_exc_min_int, 551);
    includeParentEquity = false;
    const withoutParent = (await read('security')).balance[0];
    assert.strictEqual(withoutParent.total_hldr_eqy_exc_min_int, null, '不能用普通股金额或换算后的金额填归母合计');
    assert.strictEqual(withoutParent.__statement_metrics['bs.tetoshopc'], 451);
  });

  await check('港股通清单接口：按 isMutualMarketAhFlag 取数并解析每手股数与财报类型', async () => {
    let captured = null;
    stub('../services/lixingerOfficial', {
      callEndpoint: async (endpoint, params) => {
        captured = { endpoint, params };
        return {
          rows: [
            { stockCode: '700', name: '腾讯控股', mutualMarketFlag: true, mutualMarkets: ['ah'], sharesPerLot: 100, fsTableType: 'non_financial', listingStatus: 'normally_listed', ipoDate: '2004-06-16T00:00:00+08:00' },
            { stockCode: '00700', name: '腾讯控股（重复）', mutualMarketFlag: true },
            { stockCode: '1448', name: '福寿园', mutualMarketFlag: false, sharesPerLot: 1000 },
          ],
        };
      },
    });
    const adapterPath = require.resolve('../dataAccess/adapters/lixingerDatasetAdapter');
    delete require.cache[adapterPath];
    const adapter = require(adapterPath);
    const rows = await adapter.resolveMutualMarketCompanies({});
    assert.strictEqual(captured.endpoint, 'hk/company', '必须走港股公司信息接口');
    assert.strictEqual(captured.params.isMutualMarketAhFlag, true, '必须显式按互联互通筛选，不能拉全市场再过滤');
    assert.deepStrictEqual(rows.map(row => row.code), ['00700.HK', '01448.HK'], '补足 5 位并去重');
    assert.strictEqual(rows[0].sharesPerLot, 100, '每手股数要保留');
    assert.strictEqual(rows[0].fsTableType, 'non_financial', '财报类型要保留，供财报端点选择');
    assert.strictEqual(rows[0].ipoDate, '2004-06-16');
    assert.strictEqual(rows[1].mutualMarketFlag, false, '标记为假的要如实保留，由调用方决定是否入池');
  });

  await check('指数成分接口：把 constituents 解析成规范港股代码', async () => {
    stub('../services/lixingerOfficial', {
      callEndpoint: async () => ({
        rows: [{
          stockCode: 'HSI',
          constituents: [
            { stockCode: '1', stockName: { cmn_hans_cn: '长和' } },
            { stockCode: '00001', stockName: { cmn_hans_cn: '长和（重复）' } },
            { stockCode: '700', stockName: { en: 'TENCENT' } },
          ],
        }],
      }),
    });
    const adapterPath = require.resolve('../dataAccess/adapters/lixingerDatasetAdapter');
    delete require.cache[adapterPath];
    const adapter = require(adapterPath);
    const rows = await adapter.resolveIndexConstituents({ indexCode: 'hsi', date: '2026-11-04' });
    assert.deepStrictEqual(rows.map(row => row.code), ['00001.HK', '00700.HK'], '必须补足 5 位并去重');
    assert.strictEqual(rows[0].name, '长和');
    assert.strictEqual(rows[1].name, 'TENCENT', '没有中文名时回退英文名');
    assert.strictEqual(rows[0].source_code, 'lixinger_official');
  });

  const pass = tests.filter(item => item[0] === 'PASS').length;
  const fail = tests.length - pass;
  console.log(`PASS=${pass} FAIL=${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch(error => { console.error(error); process.exit(1); });

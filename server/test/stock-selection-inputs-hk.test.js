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
    saveInputGapQueue: async payload => { calls.savedQueue = payload; return 1; },
    findInstrumentMeta: async ({ tsCode }) => ({
      instrument_id: Number(String(tsCode).replace(/\D/g, '').slice(-4)) || 1,
      ts_code: tsCode, name: '测试', market: 'HK', currency_code: 'HKD', raw_data: {},
    }),
    listCodesWithRecentBars: async () => new Set(options.coveredCodes || []),
    upsertDailyValuationRows: async ({ rows, sourceId }) => { calls.valuations.push({ rows, sourceId }); return rows.length; },
    upsertDailyBarRows: async ({ rows, sourceId }) => { calls.bars.push({ rows, sourceId }); return rows.length; },
  };

  const datasetsStub = {
    readIndexConstituents: async () => (options.constituents || [
      { code: '00001.HK', name: '长和' }, { code: '00002.HK', name: '中电控股' },
    ]),
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

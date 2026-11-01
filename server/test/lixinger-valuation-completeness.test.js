// 估值批次完整性（审查 R2-001）与来源切换三层验收（S-002）的确定性回归。
//
// 方式：注入 callEndpoint 与 tushareQuery，不发网络、不连数据库；
// 覆盖"全成功 / 1·2·3 个段失败 / 失败在首段·中段·尾段 / 成功空批 / 控制错误 / 备源完整·部分·不可用"。
// 运行：node server/test/lixinger-valuation-completeness.test.js
process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
process.env.PGDATABASE = process.env.PGTESTDATABASE || 'portfolio_test';
process.env.LIXINGER_TOKEN = process.env.LIXINGER_TOKEN || 'test-token-never-stored';

const assert = require('assert');

// 先加载并替换底层传输，再加载适配层/数据层（它们按解构早绑定，必须在 patch 之后 require）。
const official = require('../services/lixingerOfficial');
const tushare = require('../services/tushare');

let officialHandler = async () => ({ rows: [] });
official.callEndpoint = (endpointKey, params, options) => officialHandler(endpointKey, params, options);

let tushareHandler = async () => ({ fields: [], items: [] });
tushare.tushareQuery = (...args) => tushareHandler(...args);

const adapter = require('../dataAccess/adapters/lixingerDatasetAdapter');
const datasets = require('../dataAccess/marketDatasets');

const CODE = '600519.SH';
const RANGE_START = '1990-01-01';
const RANGE_END = '2026-10-30';

function valuationRows(params, count = 1) {
  const start = String(params.startDate || '');
  return Array.from({ length: count }, (_, index) => ({
    stockCode: String(params.stockCodes && params.stockCodes[0]),
    date: `${start.slice(0, 4)}-12-31`,
    pe_ttm: 20 + index, pb: 5, dyr: 0.02, mc: 1e12, cmc: 9e11,
  }));
}

// 按批次计划执行：handler 决定哪些段失败，记录每次真实调用以便证明"失败后仍尝试后续段"。
function seriesFetch({ failingStarts = [], errorCode = 'UPSTREAM_ERROR', rowsPerCall = 1, empty = false } = {}) {
  const calls = [];
  const handler = async (endpointKey, params) => {
    calls.push(params.startDate);
    if (failingStarts.includes(params.startDate)) {
      const error = new Error('上游失败');
      error.code = errorCode;
      error.retryable = errorCode !== 'POLICY_NOT_CONFIGURED';
      throw error;
    }
    return { rows: empty ? [] : valuationRows(params, rowsPerCall) };
  };
  return { handler, calls };
}

const cases = [];
function check(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    cases.push(['PASS', name]);
    console.log('  [PASS] ' + name);
  }).catch(error => {
    cases.push(['FAIL', name + ' :: ' + (error && error.message)]);
    console.log('  [FAIL] ' + name + ' :: ' + (error && error.message));
  });
}

(async () => {
  console.log('A. 历史区间：单证券 × 日期段');

  await check('全部段成功：complete=true 且段数与计划一致', async () => {
    const { handler, calls } = seriesFetch({ rowsPerCall: 2 });
    officialHandler = handler;
    const detail = await adapter.resolveValuationSeriesDetailed({ codes: [CODE], startDate: RANGE_START, endDate: RANGE_END });
    assert.strictEqual(detail.planned, 4, '1990→2026 按 10 年分段应为 4 段');
    assert.strictEqual(detail.attempted, 4);
    assert.strictEqual(detail.failed, 0);
    assert.strictEqual(detail.complete, true);
    assert.strictEqual(detail.rows.length, 8);
    assert.strictEqual(calls.length, 4);
  });

  await check('中段失败：后续段仍然尝试（不再跳过该证券余下区间）', async () => {
    const { handler, calls } = seriesFetch({ failingStarts: ['2001-01-01'] });
    officialHandler = handler;
    const detail = await adapter.resolveValuationSeriesDetailed({ codes: [CODE], startDate: RANGE_START, endDate: RANGE_END });
    assert.strictEqual(calls.length, 4, '第 2 段失败后第 3、4 段必须继续请求');
    assert.deepStrictEqual(calls, ['1990-01-01', '2001-01-01', '2012-01-01', '2023-01-01'], '分段边界：1990 起每 10 年一段');
    assert.strictEqual(detail.failed, 1);
    assert.strictEqual(detail.succeeded, 3);
    assert.strictEqual(detail.complete, false);
    assert.strictEqual(detail.rows.length, 3, '成功段的行必须保留（失败不能整段丢弃）');
    assert.strictEqual(detail.failures[0].code, 'UPSTREAM_ERROR');
    assert.strictEqual(detail.failures[0].retryable, true);
    assert.strictEqual(detail.failures[0].from, '2001-01-01');
  });

  await check('首段失败：仍尝试其余段并记录未完成', async () => {
    const { handler, calls } = seriesFetch({ failingStarts: ['1990-01-01'] });
    officialHandler = handler;
    const detail = await adapter.resolveValuationSeriesDetailed({ codes: [CODE], startDate: RANGE_START, endDate: RANGE_END });
    assert.strictEqual(calls.length, 4);
    assert.strictEqual(detail.failed, 1);
    assert.strictEqual(detail.complete, false);
  });

  await check('三段失败也不能被"累计三次"门槛吞掉', async () => {
    const { handler } = seriesFetch({ failingStarts: ['1990-01-01', '2001-01-01', '2012-01-01'] });
    officialHandler = handler;
    const detail = await adapter.resolveValuationSeriesDetailed({ codes: [CODE], startDate: RANGE_START, endDate: RANGE_END });
    assert.strictEqual(detail.failed, 3);
    assert.strictEqual(detail.complete, false);
    assert.strictEqual(detail.rows.length, 1, '唯一成功段的行保留');
  });

  await check('控制错误（POLICY_NOT_CONFIGURED）立即上抛，不继续请求后续段', async () => {
    const { handler, calls } = seriesFetch({ failingStarts: ['1990-01-01'], errorCode: 'POLICY_NOT_CONFIGURED' });
    officialHandler = handler;
    await assert.rejects(
      adapter.resolveValuationSeriesDetailed({ codes: [CODE], startDate: RANGE_START, endDate: RANGE_END }),
      error => error.code === 'POLICY_NOT_CONFIGURED',
    );
    assert.strictEqual(calls.length, 1, '控制类错误必须立刻交回上层');
  });

  await check('成功空批：complete=true 但单独记 emptyBatches，不当作失败', async () => {
    const { handler } = seriesFetch({ empty: true });
    officialHandler = handler;
    const detail = await adapter.resolveValuationSeriesDetailed({ codes: [CODE], startDate: RANGE_START, endDate: RANGE_END });
    assert.strictEqual(detail.emptyBatches, 4);
    assert.strictEqual(detail.failed, 0);
    assert.strictEqual(detail.complete, true);
    assert.strictEqual(detail.rows.length, 0);
  });

  await check('数组入口在部分失败时抛 PARTIAL_RESULT，并带回已取到的行', async () => {
    const { handler } = seriesFetch({ failingStarts: ['2001-01-01'] });
    officialHandler = handler;
    await assert.rejects(
      adapter.resolveValuationSeries({ codes: [CODE], startDate: RANGE_START, endDate: RANGE_END }),
      error => error.code === 'PARTIAL_RESULT' && error.partialRows.length === 3 && error.failures.length === 1,
    );
  });

  console.log('B. 按日快照：按代码批');

  await check('101 只分 2 批；第 1 批失败时保留第 2 批的行且标记未取全', async () => {
    const codes = Array.from({ length: 101 }, (_, index) => `6${String(index).padStart(5, '0')}.SH`);
    let batchNo = 0;
    officialHandler = async (endpointKey, params) => {
      batchNo += 1;
      if (batchNo === 1) {
        const error = new Error('上游 500'); error.code = 'UPSTREAM_5XX'; error.retryable = true; throw error;
      }
      return { rows: params.stockCodes.map(code => ({ stockCode: code, date: params.date, pe_ttm: 10, pb: 2, mc: 1e10 })) };
    };
    const detail = await adapter.resolveValuationRowsDetailed({ codes, tradeDate: '2026-10-30' });
    assert.strictEqual(detail.planned, 2);
    assert.strictEqual(detail.failed, 1);
    assert.strictEqual(detail.complete, false);
    assert.strictEqual(detail.rows.length, 1, '第 2 批（1 只）的行必须保留');
    assert.strictEqual(detail.rows[0].ts_code, codes[100], '第二行应来自第 2 批的证券');
  });

  await check('快照数组入口部分失败同样抛 PARTIAL_RESULT', async () => {
    const codes = Array.from({ length: 101 }, (_, index) => `6${String(index).padStart(5, '0')}.SH`);
    let batchNo = 0;
    officialHandler = async () => {
      batchNo += 1;
      if (batchNo === 1) { const error = new Error('上游失败'); error.code = 'UPSTREAM_ERROR'; throw error; }
      return { rows: [] };
    };
    await assert.rejects(adapter.resolveValuationRows({ codes, tradeDate: '2026-10-30' }), error => error.code === 'PARTIAL_RESULT');
  });

  console.log('C. 数据层消费：失败保留与业务覆盖');

  await check('readStockValuationSeriesBatch 部分失败抛错并带 partialRows', async () => {
    const { handler } = seriesFetch({ failingStarts: ['2012-01-01'] });
    officialHandler = handler;
    await assert.rejects(
      datasets.readStockValuationSeriesBatch({ codes: [CODE], startDate: RANGE_START, endDate: RANGE_END }),
      error => error.code === 'PARTIAL_RESULT' && error.partialRows.length === 3
        && error.partialRows.every(row => row.source_code === adapter.SOURCE),
    );
  });

  await check('readStockValuationSeriesDetailed 同时给出成功行与失败区间', async () => {
    const { handler } = seriesFetch({ failingStarts: ['2012-01-01'] });
    officialHandler = handler;
    const detail = await datasets.readStockValuationSeriesDetailed({ codes: [CODE], startDate: RANGE_START, endDate: RANGE_END });
    assert.strictEqual(detail.complete, false);
    assert.strictEqual(detail.rows.length, 3);
    assert.strictEqual(detail.failures.length, 1);
  });

  await check('备份来源失败不能丢掉已取到的官方行', async () => {
    officialHandler = async (endpointKey, params) => {
      if (String(params.startDate) === '1990-01-01') {
        const error = new Error('上游失败'); error.code = 'UPSTREAM_ERROR'; throw error;
      }
      return { rows: valuationRows(params) };
    };
    tushareHandler = async () => { throw new Error('备源不可用'); };
    const rows = await datasets.readStockValuationHistory({ tsCode: CODE, startDate: RANGE_START, endDate: RANGE_END });
    assert.strictEqual(rows.length, 3, '官方成功段的行必须照常返回');
    assert.ok(rows.every(row => row.source_code === adapter.SOURCE));
    assert.ok(rows.every(row => row.backup_unavailable === true), '备源不可用要标出来');
    assert.ok(rows.every(row => Array.isArray(row.missing_fields)));
  });

  await check('官方只覆盖部分日期时按日期择优，缺的日期用备源并标回来源', async () => {
    officialHandler = async () => ({ rows: [{ stockCode: '600519', date: '2026-10-29', pe_ttm: 21, pb: 6, dyr: 0.03, mc: 2e12, cmc: 1.8e12 }] });
    tushareHandler = async () => ({
      fields: ['ts_code', 'trade_date', 'pe', 'pe_ttm', 'pb', 'dv_ttm', 'total_mv', 'circ_mv', 'close', 'total_share', 'float_share', 'free_share'],
      items: [
        ['600519.SH', '20261028', 19, 20, 5, 2, 1e8, 9e7, 1400, 125600, 125600, 125600],
        ['600519.SH', '20261029', 19, 20, 5, 2, 1e8, 9e7, 1410, 125600, 125600, 125600],
      ],
    });
    const rows = await datasets.readStockValuationHistory({ tsCode: CODE, startDate: '2026-10-01', endDate: '2026-10-30' });
    const officialDay = rows.find(row => String(row.trade_date) === '20261029' || String(row.trade_date) === '2026-10-29');
    const backupDay = rows.find(row => String(row.trade_date) === '20261028' || String(row.trade_date) === '2026-10-28');
    assert.ok(officialDay && backupDay, '两天的行都应存在');
    assert.strictEqual(officialDay.source_code, adapter.SOURCE, '官方覆盖的日期必须标官方来源');
    assert.strictEqual(officialDay.pe_ttm, 21, '官方有值必须用官方值（不是只换标签）');
    assert.strictEqual(backupDay.source_code, 'tushare', '官方没覆盖的日期标备源');
  });

  const failed = cases.filter(item => item[0] === 'FAIL');
  console.log(`\n==== 估值完整性结果: ${cases.length - failed.length}/${cases.length} 通过 ====`);
  if (failed.length) {
    failed.forEach(item => console.log('  - ' + item[1]));
    process.exit(1);
  }
  console.log('全部通过 ✅');
})().catch(error => {
  console.error('lixinger-valuation-completeness.test.js 失败:', (error && error.stack) || error);
  process.exit(1);
});

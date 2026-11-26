// persistCollectedData 原始报文写入循环的纯单测（不连真实 PostgreSQL）。
//
// 回归背景（2026-11-27 二轮独立验收 Step 3）：`shouldPersistRawDataset(dataset, row)` 曾被写进
// `for (const [dataset, rows] of ...)` 的外层、却在 `for (const row of rows)` 之外，
// 引用了循环变量 `row`，生产一执行 persistCollectedData 就抛 `ReferenceError: row is not defined`。
// 这里用假 client + 假仓储直接跑通写入循环，钉住「逐行判断」这个作用域：
//   - 理杏仁官方且带 __statement_coverage.audit 的 balance 行 → 停写转换报文（已有真实应答留证）
//   - 备源（tushare）balance 行 → 保留
//   - dividends 行 → 保留（不在 STATEMENT_DATASETS 内）
process.env.NODE_ENV = 'test';

const assert = require('assert');

const rawRecords = [];
const finishCalls = [];
const client = { query: async () => ({ rows: [] }) };

const projectionPath = require.resolve('../repositories/stockProjectionRepository');
require.cache[projectionPath] = {
  id: projectionPath, filename: projectionPath, loaded: true,
  exports: {
    sourceIds: async () => ({ tushare: 1, lixinger_official: 2 }),
    ensureMaster: async () => ({ instrumentId: 11, companyId: 22, currency: 'CNY' }),
    createIngestionRun: async () => 99,
    insertRawRecord: async (record, _client) => { rawRecords.push(record); },
    syncReportRows: async () => {},
    upsertDailyBar: async () => {},
    upsertAdjustmentFactor: async () => {},
    upsertDailyValuation: async () => {},
    upsertShareCapital: async () => {},
    orderDividendBatchForUpsert: rows => rows.slice(),
    dividendBatchPeersOf: () => [],
    officialDividendSourceKey: (row, code) => `${code}:${row.end_date}:official`,
    resolveDefaultDividendSourceKey: async (client2, { row, fallbackCode }) => `${fallbackCode}:${row.end_date}:default`,
    upsertCorporateAction: async () => 'key',
    resolveEarningsGuidanceSourceKey: async ({ row, fallbackCode }) => `${fallbackCode}:${row.end_date}:guidance`,
    upsertEarningsGuidance: async () => {},
    upsertFinancialCursor: async () => {},
    insertQualityIssue: async () => {},
    finishIngestionRun: async payload => { finishCalls.push(payload); },
  },
};

const transactionPath = require.resolve('../db/transaction');
require.cache[transactionPath] = {
  id: transactionPath, filename: transactionPath, loaded: true,
  exports: { withTransaction: fn => fn(client) },
};

const { persistCollectedData } = require('../services/financialDataArchitecture');

(async () => {
  const upstreamBalance = {
    source_code: 'lixinger_official',
    end_date: '20251231',
    __statement_coverage: { audit: { request_hash: 'req-1', content_hash: 'content-1' } },
  };
  const backupBalance = { source_code: 'tushare', end_date: '20241231' };
  const dividend = {
    source_code: 'tushare', end_date: '20251231', ann_date: '20260401',
    div_proc: '实施', cash_div_tax: 1, base_share: 1, currency: 'CNY',
  };

  const master = await persistCollectedData(
    { ts_code: '600519.SH', collection_context: { caller: 'test' } },
    { balance: [upstreamBalance, backupBalance], dividends: [dividend] },
  );

  assert.strictEqual(master.instrumentId, 11, '应返回主档信息');

  const balanceRecords = rawRecords.filter(r => r.datasetCode === 'balance');
  assert.strictEqual(balanceRecords.length, 1,
    `同一批混合来源的 balance 只应写备源行 1 条，实际 ${balanceRecords.length} 条`);
  assert.deepStrictEqual(balanceRecords[0].payload, backupBalance,
    '跳过的必须是已带 audit 的理杏仁行，保留的是无 audit 的备源行');

  const dividendRecords = rawRecords.filter(r => r.datasetCode === 'dividends');
  assert.strictEqual(dividendRecords.length, 1, '非财报数据集（dividends）必须照常写原始报文');

  assert.strictEqual(rawRecords.length, 2, `原始报文总条数应为 2，实际 ${rawRecords.length}`);
  assert.strictEqual(finishCalls.length, 1, '必须收口一次批次');
  assert.strictEqual(finishCalls[0].rowCount, 2,
    `批次 rowCount 按实际落库行计（2），实际 ${finishCalls[0].rowCount}`);

  // 第二批：只有理杏仁留证行 → 一条都不写，也不能抛错（rowCount 允许为 0）。
  rawRecords.length = 0;
  finishCalls.length = 0;
  await persistCollectedData(
    { ts_code: '600519.SH' },
    { balance: [upstreamBalance] },
  );
  assert.strictEqual(rawRecords.length, 0, '已具备上游留证的财报行不得再写转换报文副本');
  assert.strictEqual(finishCalls[0].rowCount, 0, '无实际落库行时 rowCount 为 0');

  console.log('financial-data-architecture persist raw：逐行判断作用域正确，混合来源与纯留证批次均通过');
})().catch(error => {
  console.error(String(error && error.stack ? error.stack : error));
  process.exit(1);
});

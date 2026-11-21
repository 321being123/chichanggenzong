const assert = require('assert');
const fs = require('fs');
const path = require('path');

const storageRetention = require('../services/storageRetention');
const repository = require('../repositories/storageRetentionRepository');
const { JOB_DEFINITIONS } = require('../services/jobDefinitions');

(async () => {
  // 1. 任务定义与契约必须显式声明零外采、无数据集生产/消费
  const def = JOB_DEFINITIONS.find(item => item.jobCode === 'storage_retention');
  assert(def, '缺少 storage_retention 任务定义');
  assert.strictEqual(def.hour, 2);
  assert.strictEqual(def.minute, 15);
  assert.strictEqual(def.mayConsumeQuota, false);
  assert.strictEqual(def.dataDatePolicy, 'none');
  assert.deepStrictEqual(def.externalApis, []);
  assert.deepStrictEqual(def.producesDatasets, []);
  assert.strictEqual(def.maxExternalCallsPerRun, 0);

  // 2. 迁移 207 必须幂等覆盖四张外键子表的 raw_record_id 部分索引
  const migrationSql = fs.readFileSync(
    path.join(__dirname, '..', 'db', 'migrations', 'era16RawRecordRefIndexes.js'),
    'utf8'
  );
  for (const indexName of [
    'ix_event_documents_raw_record_id',
    'ix_fundamental_financial_reports_raw_record_id',
    'ix_market_instrument_trade_rules_raw_record_id',
    'ix_market_repo_daily_rates_raw_record_id',
  ]) {
    assert(migrationSql.includes(`CREATE INDEX IF NOT EXISTS ${indexName}`), `缺少幂等索引 ${indexName}`);
  }

  // 3. 服务层参数边界校验与仓储调用契约
  const originalDeleteRaw = repository.deleteExpiredUnreferencedRawRecords;
  const originalDeleteRuns = repository.deleteStalePartialSelectionRuns;
  const calls = [];
  try {
    repository.deleteExpiredUnreferencedRawRecords = async (params) => {
      calls.push({ kind: 'raw', ...params });
      return 42;
    };
    repository.deleteStalePartialSelectionRuns = async (params) => {
      calls.push({ kind: 'selection', ...params });
      return 3;
    };

    const resDefault = await storageRetention.purgeStorageData();
    assert.strictEqual(resDefault.ok, true);
    assert.strictEqual(resDefault.rawRetentionDays, 7);
    assert.strictEqual(resDefault.selectionPartialRetentionDays, 1);
    assert.strictEqual(resDefault.deletedRawRecords, 42);
    assert.strictEqual(resDefault.deletedSelectionRuns, 3);
    assert.deepStrictEqual(calls[0].datasetCodes, ['lixinger_response', 'income', 'balance', 'indicators', 'cashflow']);

    // 边界夹紧：下限 1 天、上限 365/90 天
    const resClamped = await storageRetention.purgeStorageData({
      rawRetentionDays: 0,
      selectionPartialRetentionDays: 999,
      rawBatchSize: 10,
      selectionBatchSize: 9999,
    });
    assert.strictEqual(resClamped.rawRetentionDays, 1);
    assert.strictEqual(resClamped.selectionPartialRetentionDays, 90);
    assert.strictEqual(calls[2].batchSize, 100);
    assert.strictEqual(calls[3].batchSize, 500);
  } finally {
    repository.deleteExpiredUnreferencedRawRecords = originalDeleteRaw;
    repository.deleteStalePartialSelectionRuns = originalDeleteRuns;
  }

  console.log('storage-retention.test.js passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

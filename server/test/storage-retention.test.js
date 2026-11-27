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
  const originalPruneRuns = repository.pruneStaleSelectionRuns;
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
    repository.pruneStaleSelectionRuns = async (params) => {
      calls.push({ kind: 'graded', ...params });
      return { dryRun: params.dryRun, retentionDays: {}, deleted: { daily: 1, personal: 0, ephemeral: 0 }, total: 1 };
    };

    const resDefault = await storageRetention.purgeStorageData();
    assert.strictEqual(resDefault.ok, true);
    assert.strictEqual(resDefault.rawRetentionDays, 7);
    assert.strictEqual(resDefault.selectionPartialRetentionDays, 1);
    assert.strictEqual(resDefault.deletedRawRecords, 42);
    assert.strictEqual(resDefault.deletedSelectionRuns, 3);
    assert.deepStrictEqual(calls[0].datasetCodes, ['lixinger_response', 'income', 'balance', 'indicators', 'cashflow']);
    assert.deepStrictEqual(resDefault.selectionRetentionDays, { daily: 30, personal: 14, ephemeral: 7 });
    assert.strictEqual(resDefault.selectionRetention.total, 1);
    // F-12 红线：默认只跑只读分级盘点，绝不自动真删存量。
    assert.strictEqual(resDefault.selectionRetention.dryRun, true, '默认 purgeStorageData 必须是 dry-run（0 真删）');
    const defaultGraded = calls.filter(item => item.kind === 'graded').pop();
    assert.strictEqual(defaultGraded.dryRun, true, '默认 graded 清理调用必须透传 dryRun=true');
    assert.deepStrictEqual(resDefault.protectedDatasets, ['dividends']);

    // 边界夹紧：下限 1 天、上限 365/90 天
    const resClamped = await storageRetention.purgeStorageData({
      rawRetentionDays: 0,
      selectionPartialRetentionDays: 999,
      selectionDailyRetentionDays: 0,
      selectionPersonalRetentionDays: 9999,
      selectionEphemeralRetentionDays: 0,
      rawBatchSize: 10,
      selectionBatchSize: 9999,
    });
    assert.strictEqual(resClamped.rawRetentionDays, 1);
    assert.strictEqual(resClamped.selectionPartialRetentionDays, 90);
    assert.deepStrictEqual(resClamped.selectionRetentionDays, { daily: 1, personal: 365, ephemeral: 1 });
    const rawCalls = calls.filter(item => item.kind === 'raw');
    const partialCalls = calls.filter(item => item.kind === 'selection');
    assert.strictEqual(rawCalls[1].batchSize, 100);
    assert.strictEqual(partialCalls[1].batchSize, 500);

    // 分红原文红线：显式传入 dividends 必须在任何删除前失败关闭。
    const before = calls.length;
    await assert.rejects(
      () => storageRetention.purgeStorageData({ datasetCodes: ['income', 'dividends'] }),
      error => error.code === 'RAW_RECORD_PROTECTED_DATASET'
    );
    assert.strictEqual(calls.length, before, '受保护数据集被拒绝时不得执行任何仓储删除');
    assert.ok(!storageRetention.DEFAULT_PRUNE_DATASETS.includes('dividends'), 'dividends 不得进入常规清理白名单');

    // dry-run 透传：只盘点，不删除。
    await storageRetention.purgeStorageData({ selectionDryRun: true });
    assert.strictEqual(calls[calls.length - 1].kind, 'graded');
    assert.strictEqual(calls[calls.length - 1].dryRun, true);
    // 显式关闭 dry-run 时才允许真实删除（生产存量清理仍需单独授权）。
    await storageRetention.purgeStorageData({ selectionDryRun: false });
    assert.strictEqual(calls[calls.length - 1].kind, 'graded');
    assert.strictEqual(calls[calls.length - 1].dryRun, false, '显式 selectionDryRun:false 才透传真实删除');

    // P0-2：生产先部署后回填阶段（读开关未开启）不得自动跑每周对账。
    const pbSync = require('../services/pbProjectionSync');
    const originalReconcile = pbSync.reconcilePbProjectionSample;
    let reconcileCalls = 0;
    pbSync.reconcilePbProjectionSample = async () => { reconcileCalls += 1; return { ok: true }; };
    const oldReadEnabled = process.env.PB_PROJECTION_READ_ENABLED;
    process.env.PB_PROJECTION_READ_ENABLED = '0';
    try {
      const gated = await storageRetention.purgeStorageData({ pbProjectionReconcile: '1' });
      assert.deepStrictEqual(gated.pbProjectionReconcile, { skipped: true, reason: 'disabled_by_config' },
        '投影读开关关闭时对账必须跳过');
      assert.strictEqual(reconcileCalls, 0, '未回填阶段不得触发投影对账');
    } finally {
      pbSync.reconcilePbProjectionSample = originalReconcile;
      if (oldReadEnabled === undefined) delete process.env.PB_PROJECTION_READ_ENABLED;
      else process.env.PB_PROJECTION_READ_ENABLED = oldReadEnabled;
    }
  } finally {
    repository.deleteExpiredUnreferencedRawRecords = originalDeleteRaw;
    repository.deleteStalePartialSelectionRuns = originalDeleteRuns;
    repository.pruneStaleSelectionRuns = originalPruneRuns;
  }

  // P0-2：生产未显式设置读开关时必须默认关闭，先安全部署/回填，再显式置 1。
  {
    const { projectionReadEnabled } = require('../domain/pbProjectionConfig');
    const oldNodeEnv = process.env.NODE_ENV;
    const oldReadEnabled = process.env.PB_PROJECTION_READ_ENABLED;
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.PB_PROJECTION_READ_ENABLED;
      assert.strictEqual(projectionReadEnabled(), false, '生产未显式设置投影读开关必须默认关闭');
      process.env.PB_PROJECTION_READ_ENABLED = '1';
      assert.strictEqual(projectionReadEnabled(), true, '回填验收后显式置 1 必须开启投影读');
      process.env.PB_PROJECTION_READ_ENABLED = '0';
      assert.strictEqual(projectionReadEnabled(), false, '生产置 0 必须回退原查询');
      process.env.NODE_ENV = 'development';
      delete process.env.PB_PROJECTION_READ_ENABLED;
      assert.strictEqual(projectionReadEnabled(), true, '非生产未设置时默认开启便于本地验证');
    } finally {
      if (oldNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldNodeEnv;
      if (oldReadEnabled === undefined) delete process.env.PB_PROJECTION_READ_ENABLED;
      else process.env.PB_PROJECTION_READ_ENABLED = oldReadEnabled;
    }
  }

  console.log('storage-retention.test.js passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

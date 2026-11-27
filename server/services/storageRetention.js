const repository = require('../repositories/storageRetentionRepository');

// 常规原文清理白名单。`dividends` 永远不在这里：原选股方案第 8 节要求用 `ops.raw_records`
// 中的分红原文还原每次状态/金额修订，历史计算不能依赖被清理后的当前投影。
const DEFAULT_PRUNE_DATASETS = Object.freeze([
  'lixinger_response',
  'income',
  'balance',
  'indicators',
  'cashflow',
]);

// 受保护、不得进入常规原文清理的数据集（测试锁定，调用方显式传入也拒绝）。
const PROTECTED_RAW_DATASETS = Object.freeze(['dividends']);

function clampInt(value, fallback, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(Math.max(Math.trunc(num), min), max);
}

function booleanOption(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());
}

function assertNoProtectedDatasets(datasetCodes) {
  const blocked = datasetCodes.filter(code => PROTECTED_RAW_DATASETS.includes(String(code).toLowerCase()));
  if (blocked.length) {
    const error = new Error(`受保护数据集不得进入常规原文清理：${blocked.join(', ')}（分红原文用于历史修订还原）`);
    error.code = 'RAW_RECORD_PROTECTED_DATASET';
    throw error;
  }
}

// 定期清理超出保留窗口且无业务外键引用的原始报文、过期未发布的 partial 日/周选股试算，
// 以及按 D-3 授权分级留存的过期无引用选股批次（正式发布与被引用批次永久保留）。
async function purgeStorageData(options = {}) {
  const rawRetentionDays = clampInt(
    options.rawRetentionDays ?? process.env.RAW_RECORDS_RETENTION_DAYS,
    7,
    1,
    365
  );
  const selectionPartialRetentionDays = clampInt(
    options.selectionPartialRetentionDays ?? process.env.SELECTION_PARTIAL_RETENTION_DAYS,
    1,
    1,
    90
  );
  const dailyRetentionDays = clampInt(
    options.selectionDailyRetentionDays ?? process.env.SELECTION_DAILY_RETENTION_DAYS,
    30,
    1,
    365
  );
  const personalRetentionDays = clampInt(
    options.selectionPersonalRetentionDays ?? process.env.SELECTION_PERSONAL_RETENTION_DAYS,
    14,
    1,
    365
  );
  const ephemeralRetentionDays = clampInt(
    options.selectionEphemeralRetentionDays ?? process.env.SELECTION_EPHEMERAL_RETENTION_DAYS,
    7,
    1,
    365
  );
  const datasetCodes = Array.isArray(options.datasetCodes) && options.datasetCodes.length
    ? options.datasetCodes.map(String)
    : [...DEFAULT_PRUNE_DATASETS];
  assertNoProtectedDatasets(datasetCodes);

  const deletedRawRecords = await repository.deleteExpiredUnreferencedRawRecords({
    datasetCodes,
    retentionDays: rawRetentionDays,
    batchSize: clampInt(options.rawBatchSize, 2000, 100, 10000),
    maxBatches: clampInt(options.rawMaxBatches, 50, 1, 500),
  }, options.client);

  const deletedSelectionRuns = await repository.deleteStalePartialSelectionRuns({
    retentionDays: selectionPartialRetentionDays,
    batchSize: clampInt(options.selectionBatchSize, 50, 10, 500),
    maxBatches: clampInt(options.selectionMaxBatches, 20, 1, 200),
  }, options.client);

  const selectionRetentionEnabled = booleanOption(
    options.selectionRunRetentionEnabled ?? process.env.SELECTION_RUN_RETENTION_ENABLED, true);
  const selectionRetention = selectionRetentionEnabled
    ? await repository.pruneStaleSelectionRuns({
      dailyRetentionDays,
      personalRetentionDays,
      ephemeralRetentionDays,
      batchSize: clampInt(options.selectionBatchSize, 50, 10, 500),
      maxBatches: clampInt(options.selectionMaxBatches, 20, 1, 200),
      dryRun: booleanOption(options.selectionDryRun ?? process.env.SELECTION_RETENTION_DRY_RUN, false),
    }, options.client)
    : { skipped: true, reason: 'disabled_by_config' };

  return {
    ok: true,
    rawRetentionDays,
    selectionPartialRetentionDays,
    selectionRetentionDays: { daily: dailyRetentionDays, personal: personalRetentionDays, ephemeral: ephemeralRetentionDays },
    // 受保护数据集不进入清理；返回值显式列出，便于运维核对口径。
    protectedDatasets: [...PROTECTED_RAW_DATASETS],
    deletedRawRecords,
    deletedSelectionRuns,
    selectionRetention,
  };
}

/** 只读容量核算（B3-2）：不写库、不删行、不执行 VACUUM FULL；供盘点与回归直接调用。 */
async function measureSelectionStorage(options = {}) {
  return repository.measureSelectionStorage(options, options.client);
}

module.exports = {
  DEFAULT_PRUNE_DATASETS,
  PROTECTED_RAW_DATASETS,
  assertNoProtectedDatasets,
  measureSelectionStorage,
  purgeStorageData,
};

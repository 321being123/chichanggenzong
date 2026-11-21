const repository = require('../repositories/storageRetentionRepository');

const DEFAULT_PRUNE_DATASETS = Object.freeze([
  'lixinger_response',
  'income',
  'balance',
  'indicators',
  'cashflow',
]);

function clampInt(value, fallback, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(Math.max(Math.trunc(num), min), max);
}

// 定期清理超出保留窗口且无业务外键引用的原始报文，以及过期未发布的 partial 日/周选股试算。
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
  const datasetCodes = Array.isArray(options.datasetCodes) && options.datasetCodes.length
    ? options.datasetCodes.map(String)
    : [...DEFAULT_PRUNE_DATASETS];

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

  return {
    ok: true,
    rawRetentionDays,
    selectionPartialRetentionDays,
    deletedRawRecords,
    deletedSelectionRuns,
  };
}

module.exports = {
  DEFAULT_PRUNE_DATASETS,
  purgeStorageData,
};

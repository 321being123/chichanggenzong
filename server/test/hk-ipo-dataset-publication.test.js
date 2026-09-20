// 动态信号发布门禁：失败或未知不能把旧快照重新发布成“本次成功”。
const assert = require('assert');
const { publishDatasetSnapshot } = require('../services/datasetPartitionRegistry');

let insertCalls = 0;
async function executor(sql) {
  const text = String(sql);
  if (text.includes('COUNT(*)::int AS row_count')) return { rows: [{ row_count: 2 }] };
  if (text.includes('MAX(data_date)::text AS data_as_of')) return { rows: [{ data_as_of: '2026-09-20' }] };
  if (text.includes('INSERT INTO ops.dataset_partitions')) {
    insertCalls += 1;
    return { rows: [{ dataset_code: 'hk_ipo_subscription_signals', status: 'published' }] };
  }
  throw new Error('未预期的 SQL：' + text.slice(0, 100));
}

(async () => {
  const rejected = await publishDatasetSnapshot('hk_ipo_subscription_signals', {
    partitionKey: '2026-09-20',
    diagnostics: { query_status: 'failed', coverage_status: 'unknown' },
  }, executor);
  assert.strictEqual(rejected.published, false);
  assert.strictEqual(rejected.reason, 'dynamic_signal_degraded');
  assert.strictEqual(insertCalls, 0, '动态来源失败时不得写入已发布分区');

  const published = await publishDatasetSnapshot('hk_ipo_subscription_signals', {
    partitionKey: '2026-09-20',
    diagnostics: { query_status: 'success', coverage_status: 'verified_no_change' },
  }, executor);
  assert.strictEqual(published.published, true);
  assert.strictEqual(insertCalls, 1);
  console.log('OK hk-ipo-dataset-publication: 动态信号失败保留旧事实、成功空结果可带证据发布');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

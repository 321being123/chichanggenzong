const assert = require('assert');
const { readSnapshot, publishDatasetSnapshot } = require('../services/datasetPartitionRegistry');

const calls = [];
async function executor(sql, params) {
  const text = String(sql);
  calls.push({ text, params });
  if (text.includes('COUNT(*)::int AS row_count')) return { rows: [{ row_count: 9 }] };
  if (text.includes('MAX(COALESCE(f_ann_date,announced_at,period_end))')) return { rows: [{ data_as_of: '2026-10-31' }] };
  if (text.includes('INSERT INTO ops.dataset_partitions')) {
    return { rows: [{ dataset_code: 'stock_financial_reports', scope_key: params[1], status: 'published' }] };
  }
  throw new Error('未预期的 SQL：' + text.slice(0, 180));
}

(async () => {
  const snapshot = await readSnapshot('stock_financial_reports', { market: 'HK' }, executor);
  assert.strictEqual(snapshot.scopeKey, 'HK', '港股财报快照必须返回 HK 分区');
  assert.match(calls[0].text, /LIKE '\%\.HK'/, '港股财报快照必须使用港股代码过滤');
  assert.doesNotMatch(calls[0].text, /\^\[0-9\]\{6\}\[\.\]\(SH\|SZ\|BJ\)/, '港股财报快照不得退回 A 股过滤');

  calls.length = 0;
  const published = await publishDatasetSnapshot('stock_financial_reports', {
    market: 'HK', partitionKey: '2026-10-31', dataAsOf: '2026-10-31', rowCount: 9,
  }, executor);
  assert.strictEqual(published.published, true);
  assert.strictEqual(published.scopeKey, 'HK');
  const insert = calls.find(call => call.text.includes('INSERT INTO ops.dataset_partitions'));
  assert.ok(insert, '港股财报发布必须写入分区');
  assert.strictEqual(insert.params[1], 'HK', '港股财报发布不得写入 CN 分区');
  console.log('OK dataset-partition-market-scope: 港股财报快照与发布均保持 HK 分区');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

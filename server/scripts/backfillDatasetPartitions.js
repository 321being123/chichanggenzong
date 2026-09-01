#!/usr/bin/env node
// 为已存在的非核心数据集补齐 ops.dataset_partitions 元数据，不调用外部接口。
require('dotenv').config();

const { pool, runMigrations } = require('../db');
const { DATASET_PARTITION_REGISTRY, readSnapshot, publishDatasetSnapshot } = require('../services/datasetPartitionRegistry');

const APPLY = process.argv.includes('--apply');
const CONFIRM = process.argv.includes('--confirm-production');
const JSON_OUTPUT = process.argv.includes('--json');

async function main() {
  if (APPLY && process.env.NODE_ENV === 'production' && !CONFIRM) {
    throw new Error('生产执行必须同时传入 --confirm-production');
  }
  await runMigrations();
  const client = await pool.connect();
  const datasets = Object.keys(DATASET_PARTITION_REGISTRY);
  const output = { mode: APPLY ? 'apply' : 'dry-run', total: datasets.length, published: 0, skipped: 0, datasets: [] };
  try {
    if (APPLY) await client.query('BEGIN');
    for (const datasetCode of datasets) {
      const snapshot = await readSnapshot(datasetCode, client.query.bind(client));
      if (!snapshot.dataAsOf || snapshot.rowCount <= 0) {
        output.skipped += 1;
        output.datasets.push({ ...snapshot, reason: 'empty_or_no_date' });
        continue;
      }
      if (APPLY) {
        const published = await publishDatasetSnapshot(datasetCode, {}, client.query.bind(client));
        output.published += published.published ? 1 : 0;
        output.datasets.push(published);
      } else {
        output.datasets.push({ ...snapshot, published: false, reason: 'dry_run' });
      }
    }
    if (APPLY) await client.query('COMMIT');
    if (JSON_OUTPUT) console.log(JSON.stringify(output, null, 2));
    else console.log(`数据集分区回填（${output.mode}）：${output.published}/${output.total} 个数据集已发布，跳过 ${output.skipped} 个。`);
  } catch (error) {
    if (APPLY) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(error => {
  console.error(`数据集分区回填失败：${error.message}`);
  process.exitCode = 1;
});

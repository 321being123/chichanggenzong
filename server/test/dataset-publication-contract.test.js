const assert = require('assert');
const { pool } = require('../db/connection');
const { publishJobDatasets } = require('../services/datasetPartitionRegistry');

(async () => {
  const originalQuery = pool.query;
  let queryCount = 0;
  let queryArgs = null;
  try {
    pool.query = async (sql, params) => {
      queryCount += 1;
      queryArgs = { sql, params };
      return { rows: [{
        dataset_code: 'ipo_history', scope_key: 'GLOBAL', status: 'published', is_stale: false,
        diagnostics: { quality_status: 'passed' },
      }] };
    };

    const predictionReady = await publishJobDatasets('ipo_history_sync', '2026-09-22', {
      ok: true, mode: 'prediction_ready', stageComplete: true,
      publishDatasets: false, publishDatasetCodes: [],
    });
    assert.deepStrictEqual(predictionReady, [], '16:30 阶段不要求核心分区提前发布');
    assert.strictEqual(queryCount, 0, '预测准备阶段不得查询尚未发布的核心分区');

    await assert.rejects(() => publishJobDatasets('ipo_history_sync', '2026-09-22', {
      ok: true, mode: 'prediction_ready', stageComplete: false,
      publishDatasets: false, publishDatasetCodes: [],
    }), /阶段仍有未完成对象/);

    const enrichment = await publishJobDatasets('ipo_history_sync', '2026-09-22', {
      ok: true, mode: 'enrichment', stageComplete: true,
      publishDatasets: false, publishDatasetCodes: [],
    });
    assert.deepStrictEqual(enrichment, [], '19:35 阶段只核对核心分区，不重新发布它');
    assert.deepStrictEqual(queryArgs.params, [['ipo_history'], ['GLOBAL'], '2026-09-22']);
    assert.match(queryArgs.sql, /scope_key=ANY/);
    assert.match(queryArgs.sql, /SELECT dataset_code,scope_key/);

    pool.query = async () => ({ rows: [{
      dataset_code: 'ipo_history', scope_key: 'CN', status: 'published', is_stale: false,
      diagnostics: { quality_status: 'passed' },
    }] });
    await assert.rejects(() => publishJobDatasets('ipo_history_sync', '2026-09-22', {
      ok: true, mode: 'enrichment', stageComplete: true,
      publishDatasets: false, publishDatasetCodes: [],
    }), /分区未发布或质量未通过/);

    await assert.rejects(() => publishJobDatasets('ipo_history_sync', '2026-09-22', {
      ok: true, mode: 'unknown-stage', stageComplete: true,
      publishDatasetCodes: [],
    }), /未声明/);
  } finally {
    pool.query = originalQuery;
  }
  console.log('OK dataset-publication-contract: IPO 阶段和分区作用域契约通过');
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

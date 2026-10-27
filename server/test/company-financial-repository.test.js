const assert = require('assert');
const { pool } = require('../db/connection');
const { withTransaction } = require('../db/transaction');
const repo = require('../repositories/companyFinancialRepository');
const projection = require('../repositories/stockProjectionRepository');
const service = require('../services/companyFinancialIncrementalSync');

(async () => {
  const targets = await service.listCurrentBondUnderlyingTargets(pool, '2026-08-28');
  assert(targets.length, '隔离测试库需有可转债正股样本');
  const target = targets[0];
  const scope = `financial-repo-test:${process.pid}:${Date.now()}`;
  const sentinel = new Error('模拟后续写入失败');
  let runId;
  await assert.rejects(withTransaction(async tx => {
    const source = await repo.readTushareSource({}, tx);
    assert(source, '隔离测试库缺少 Tushare 来源登记');
    runId = await projection.createIngestionRun({ sourceId: source.source_id,
      datasetCode: 'stock_financial_reports', requestRange: { test: true } }, tx);
    await repo.writeFinancialHistoryCursor({ companyId: target.companyId, instrumentId: target.instrumentId,
      scope, historyStart: '2000-01-01' }, tx);
    await repo.finishFinancialIngestion({ runId, status: 'succeeded', rowCount: 1, errorMessage: '' }, tx);
    throw sentinel;
  }), error => error === sentinel);
  const run = await pool.query('SELECT 1 FROM ops.ingestion_runs WHERE run_id=$1', [runId]);
  const cursor = await pool.query('SELECT 1 FROM ops.sync_cursors WHERE scope_key=$1', [scope]);
  assert.strictEqual(run.rowCount, 0, '采集记录必须随事务回滚');
  assert.strictEqual(cursor.rowCount, 0, '历史游标必须随事务回滚');
  await pool.end();
  console.log('公司财务仓储：真实 PostgreSQL 事务回滚通过');
})().catch(async error => { console.error(error); await pool.end().catch(() => {}); process.exitCode = 1; });

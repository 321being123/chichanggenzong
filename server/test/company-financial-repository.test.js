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
  const marketSentinel = new Error('市场水位测试回滚');
  await assert.rejects(withTransaction(async tx => {
    const source = await repo.readTushareSource({}, tx);
    const version = `market-watermark-${process.pid}-${Date.now()}`;
    const beforeCn = await repo.readLatestFinancialData({ market: 'CN' }, tx);
    const beforeHk = await repo.readLatestFinancialData({ market: 'HK' }, tx);
    await tx.query(`
      INSERT INTO fundamental.financial_reports
        (company_id,report_kind,period_end,period_type,statement_scope,announced_at,source_id,source_version,report_type,is_current_version,raw_payload)
      VALUES
        ($1,'income','2099-12-31','annual','consolidated','2099-12-31',$2,$3,'1',true,$4::jsonb),
        ($1,'income','2099-11-30','annual','consolidated','2099-11-30',$2,$3 || '-hk','1',true,$5::jsonb),
        ($1,'income','2100-01-01','annual','consolidated','2100-01-01',$2,$3 || '-non-current','2',true,$6::jsonb)
    `, [target.companyId, source.source_id, version, JSON.stringify({ ts_code: '600000.SH' }), JSON.stringify({ ts_code: '00700.HK' }), JSON.stringify({ ts_code: '600000.SH' })]);
    const cn = await repo.readLatestFinancialData({ market: 'CN' }, tx);
    const hk = await repo.readLatestFinancialData({ market: 'HK' }, tx);
    assert.strictEqual(cn.data_as_of, '2099-12-31', 'A股水位不得被港股报告改变');
    assert.strictEqual(hk.data_as_of, '2099-11-30', '港股水位必须只看港股报告');
    assert.strictEqual(Number(cn.row_count), Number(beforeCn.row_count) + 1, 'A股行数必须只计A股当前合并报表');
    assert.strictEqual(Number(hk.row_count), Number(beforeHk.row_count) + 1, '港股行数必须只计港股当前合并报表');
    throw marketSentinel;
  }), error => error === marketSentinel);
  await pool.end();
  console.log('公司财务仓储：真实 PostgreSQL 事务回滚通过');
})().catch(async error => { console.error(error); await pool.end().catch(() => {}); process.exitCode = 1; });

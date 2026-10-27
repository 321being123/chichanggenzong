// 公司财务同步的数据访问；事务由调用方传入并管理。
const { pool } = require('../db');

async function listBondUnderlyingRows(params = {}, tx) {
  const { rows } = await (tx || pool).query(`
    WITH market_day AS (
      SELECT MAX(trade_date) FILTER (WHERE $1::date IS NULL OR trade_date <= $1::date) AS trade_date FROM market.convertible_bond_daily_metrics
    )
    SELECT DISTINCT s.instrument_id,s.canonical_code AS ts_code,p.stock_instrument_id,ci.company_id
      FROM market_day md
      JOIN market.convertible_bond_daily_metrics dm ON dm.trade_date=md.trade_date
      JOIN core.instruments i ON i.instrument_id=dm.instrument_id AND i.asset_class='convertible_bond'
      JOIN fundamental.convertible_bond_profiles p ON p.instrument_id=i.instrument_id
      LEFT JOIN fundamental.convertible_bond_issuance iss ON iss.instrument_id=i.instrument_id
      JOIN core.instruments s ON s.instrument_id=p.stock_instrument_id AND s.asset_class='stock'
      JOIN core.company_instruments ci ON ci.instrument_id=s.instrument_id
     WHERE ($1::date IS NULL OR md.trade_date <= $1::date)
       AND i.status='listed'
       AND (iss.issue_type IS NULL OR iss.issue_type NOT IN ('定向','私募'))
       AND (i.delist_date IS NULL OR i.delist_date>md.trade_date)
       AND (p.maturity_date IS NULL OR p.maturity_date>=md.trade_date)
    UNION
    SELECT DISTINCT s.instrument_id,s.canonical_code AS ts_code,p.stock_instrument_id,ci.company_id
      FROM core.instruments i
      JOIN fundamental.convertible_bond_profiles p ON p.instrument_id=i.instrument_id
      LEFT JOIN fundamental.convertible_bond_issuance iss ON iss.instrument_id=i.instrument_id
      JOIN core.instruments s ON s.instrument_id=p.stock_instrument_id AND s.asset_class='stock'
      JOIN core.company_instruments ci ON ci.instrument_id=s.instrument_id
     WHERE (i.list_date IS NULL OR i.list_date>=CURRENT_DATE)
       AND COALESCE(i.status,'') NOT IN ('cancelled','canceled')
       AND (iss.issue_type IS NULL OR iss.issue_type NOT IN ('定向','私募'))
    ORDER BY 2
  `, [params.targetTradeDate || null]);
  return rows;
}

async function listCompanyReportRows(params, tx) {
  const { rows } = await (tx || pool).query(
    `SELECT company_id,report_kind,period_end::text AS period_end,announced_at::text AS announced_at,
            f_ann_date::text AS f_ann_date,report_type,is_current_version
       FROM fundamental.financial_reports
      WHERE company_id=ANY($1::bigint[]) AND is_current_version=true
      ORDER BY company_id,period_end DESC,announced_at DESC NULLS LAST`, [params.companyIds]
  );
  return rows;
}

async function listFinancialCursors(params, tx) {
  const { rows } = await (tx || pool).query(
    `SELECT scope_key,last_success_date,last_source_update,last_attempt_at,last_error,retry_count
       FROM ops.sync_cursors WHERE dataset_code=$2 AND scope_key=ANY($1::text[])`, [params.scopes, params.datasetCode]
  );
  return rows;
}

async function readTushareSource(_params, tx) {
  const { rows } = await (tx || pool).query("SELECT source_id FROM ops.data_sources WHERE source_code='tushare' LIMIT 1");
  return rows[0];
}

async function writeFinancialHistoryCursor(params, tx) {
  await tx.query(
    `INSERT INTO ops.sync_cursors(company_id,instrument_id,scope_key,dataset_code,last_success_date,last_source_update,last_attempt_at,last_error)
     VALUES($1,$2,$3,'financial_history',$4,now(),now(),'') ON CONFLICT(scope_key,dataset_code)
     DO UPDATE SET last_success_date=LEAST(sync_cursors.last_success_date,EXCLUDED.last_success_date),last_source_update=now(),last_attempt_at=now(),last_error='',updated_at=now()`,
    [params.companyId, params.instrumentId, params.scope, params.historyStart]);
}

async function finishFinancialIngestion(params, tx) {
  await tx.query(
    `UPDATE ops.ingestion_runs SET status=$2,row_count=$3,error_message=$4,finished_at=now() WHERE run_id=$1`,
    [params.runId, params.status, params.rowCount, params.errorMessage]);
}

async function readLatestFinancialData(_params, tx) {
  const { rows } = await (tx || pool).query(
    `SELECT MAX(COALESCE(f_ann_date,announced_at,period_end))::text AS data_as_of,
            COUNT(*) FILTER (WHERE report_type='1' AND is_current_version=true)::int AS row_count
       FROM fundamental.financial_reports`
  );
  return rows[0];
}

async function markFinancialSyncPending(params, tx) {
  await (tx || pool).query(
    `INSERT INTO ops.sync_cursors(company_id,instrument_id,scope_key,dataset_code,last_attempt_at,last_error,retry_count)
     VALUES($1,$2,$3,'financial',now(),$4,1)
     ON CONFLICT(scope_key,dataset_code) DO UPDATE SET last_attempt_at=now(),last_error=EXCLUDED.last_error,retry_count=ops.sync_cursors.retry_count+1,updated_at=now()`,
    [params.companyId, params.instrumentId, params.scope, params.message]);
}

async function findStockTargetRows(params, tx) {
  const { rows } = await (tx || pool).query(`SELECT i.instrument_id,ci.company_id,i.list_date::text AS list_date
    FROM core.instruments i JOIN core.company_instruments ci USING(instrument_id)
    WHERE i.canonical_code=$1 AND i.asset_class='stock'`, [params.tsCode]);
  return rows;
}

module.exports = { listBondUnderlyingRows, listCompanyReportRows, listFinancialCursors, readTushareSource,
  writeFinancialHistoryCursor, finishFinancialIngestion, readLatestFinancialData, markFinancialSyncPending, findStockTargetRows };

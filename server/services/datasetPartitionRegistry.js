// 非核心任务产出数据集的统一分区登记。
// SQL 全部来自本文件的白名单，任务只传数据集代码，不允许拼接外部 SQL。
const { pool } = require('../db/connection');
const { publishDatasetPartition } = require('./datasetPartitions');
const { getJobDefinition } = require('./jobDefinitions');

const DATE_TEXT = (column) => `MAX(CASE WHEN ${column}::text ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN ${column}::date END)::text`;

const DATASET_PARTITION_REGISTRY = Object.freeze({
  account_daily_prices: { scopeKey: 'GLOBAL', table: 'public.daily_prices', countSql: 'SELECT COUNT(*)::int AS row_count', dataAsOfSql: `SELECT ${DATE_TEXT('date')} AS data_as_of` },
  hk_fx_rate: { scopeKey: 'GLOBAL', table: 'market.fx_rates', countSql: 'SELECT COUNT(*)::int AS row_count', dataAsOfSql: 'SELECT MAX(rate_date)::text AS data_as_of' },
  nav_snapshot: { scopeKey: 'GLOBAL', table: 'public.nav_history', countSql: 'SELECT COUNT(*)::int AS row_count', dataAsOfSql: `SELECT ${DATE_TEXT('date')} AS data_as_of` },
  index_daily: { scopeKey: 'GLOBAL', table: 'public.index_history', countSql: 'SELECT COUNT(*)::int AS row_count', dataAsOfSql: `SELECT ${DATE_TEXT('date')} AS data_as_of` },
  ipo_calendar: { scopeKey: 'GLOBAL', table: 'public.ipo_reports', countSql: 'SELECT COUNT(*)::int AS row_count', dataAsOfSql: `SELECT ${DATE_TEXT('report_date')} AS data_as_of` },
  bond_master: { scopeKey: 'CN', table: 'public.bond_unified', whereSql: "WHERE status='listed'", countSql: 'SELECT COUNT(*)::int AS row_count', dataAsOfStandaloneSql: "SELECT MAX(last_success_date)::text AS data_as_of FROM ops.sync_cursors WHERE scope_key='convertible_bond_universe' AND dataset_code IN ('cb_basic_cb_daily','cb_issue')" },
  stock_financial_reports: { scopeKey: 'CN', table: 'fundamental.financial_reports', whereSql: "WHERE report_type='1' AND is_current_version=true", countSql: 'SELECT COUNT(*)::int AS row_count', dataAsOfSql: "SELECT MAX(COALESCE(f_ann_date,announced_at,period_end))::text AS data_as_of" },
  stock_suspend_calendar: { scopeKey: 'CN', table: 'market.stock_suspend_calendar', countSql: 'SELECT COUNT(*)::int AS row_count', dataAsOfSql: 'SELECT MAX(trade_date)::text AS data_as_of' },
  bond_redemption_events: { scopeKey: 'CN', table: 'event.convertible_bond_call_events', countSql: 'SELECT COUNT(*)::int AS row_count', dataAsOfSql: 'SELECT MAX(announced_at)::text AS data_as_of' },
  bond_motive_inputs: { scopeKey: 'CN', table: 'fundamental.convertible_bond_holder_positions', countSql: 'SELECT COUNT(*)::int AS row_count', dataAsOfSql: 'SELECT MAX(report_date)::text AS data_as_of' },
  bond_motive_scores: { scopeKey: 'CN', table: 'analytics.convertible_bond_revision_motive_daily', countSql: 'SELECT COUNT(*)::int AS row_count', dataAsOfSql: 'SELECT MAX(trade_date)::text AS data_as_of' },
  bond_announcement_facts: { scopeKey: 'CN', table: 'event.convertible_bond_revision_events', countSql: 'SELECT COUNT(*)::int AS row_count', dataAsOfSql: 'SELECT MAX(announced_at)::text AS data_as_of' },
  market_volatility: { scopeKey: 'GLOBAL', table: 'market.market_valuation_daily', countSql: 'SELECT COUNT(*)::int AS row_count', dataAsOfSql: 'SELECT MAX(trade_date)::text AS data_as_of' },
  ipo_history: { scopeKey: 'GLOBAL', table: 'public.ipo_history', countSql: 'SELECT COUNT(*)::int AS row_count', dataAsOfSql: `SELECT MAX(CASE WHEN updated_at::text ~ '^\\d{4}-\\d{2}-\\d{2}' THEN updated_at::date END) AS data_as_of` },
  stock_analysis_snapshot: { scopeKey: 'CN', table: 'analytics.analysis_snapshots', whereSql: "WHERE snapshot_type='stock_analysis'", countSql: 'SELECT COUNT(*)::int AS row_count', dataAsOfSql: 'SELECT MAX(as_of_date)::text AS data_as_of' },
  bond_safety_snapshot: { scopeKey: 'CN', snapshotSql: `SELECT row_count,COALESCE(source_updated_at,refreshed_at)::date::text AS data_as_of
    FROM bond_safety_snapshots WHERE publication_status='published' ORDER BY id DESC LIMIT 1`, table: 'bond_safety_snapshots' },
  hk_trade_rules: { scopeKey: 'HK', table: 'market.instrument_trade_rules', countSql: 'SELECT COUNT(*)::int AS row_count', dataAsOfSql: 'SELECT MAX(valid_from)::text AS data_as_of' },
  arbitrage_cases: { scopeKey: 'GLOBAL', table: 'event.arbitrage_cases', countSql: 'SELECT COUNT(*)::int AS row_count', dataAsOfSql: 'SELECT MAX(announced_at)::text AS data_as_of' },
  trade_calendar: { scopeKey: 'GLOBAL', table: 'market.trade_calendar', countSql: 'SELECT COUNT(*)::int AS row_count', dataAsOfSql: 'SELECT MAX(trade_date)::text AS data_as_of' },
});

function dateValue(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const pad = part => String(part).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  const text = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

async function readSnapshot(datasetCode, executor = pool.query.bind(pool)) {
  const definition = DATASET_PARTITION_REGISTRY[datasetCode];
  if (!definition) return { published: false, reason: 'not_registered', datasetCode };
  if (definition.snapshotSql) {
    const result = await executor(definition.snapshotSql);
    const row = result.rows[0] || {};
    return { published: false, datasetCode, scopeKey: definition.scopeKey, rowCount: Number(row.row_count || 0), dataAsOf: dateValue(row.data_as_of) };
  }
  const from = ` FROM ${definition.table} ${definition.whereSql || ''}`;
  const countResult = await executor(`${definition.countSql}${from}`);
  const dateResult = definition.dataAsOfStandaloneSql
    ? await executor(definition.dataAsOfStandaloneSql)
    : await executor(definition.dataAsOfSql + from);
  const rowCount = Number(countResult.rows[0]?.row_count || 0);
  const dataAsOf = dateValue(dateResult.rows[0]?.data_as_of);
  return { published: false, datasetCode, scopeKey: definition.scopeKey, rowCount, dataAsOf };
}

async function publishDatasetSnapshot(datasetCode, options = {}, executor = pool.query.bind(pool)) {
  const snapshot = await readSnapshot(datasetCode, executor);
  const dataAsOf = dateValue(options.dataAsOf) || snapshot.dataAsOf;
  const rowCount = Number.isFinite(Number(options.rowCount)) ? Number(options.rowCount) : snapshot.rowCount;
  if (!dataAsOf || rowCount <= 0) return { ...snapshot, reason: 'empty_or_no_date' };
  const partitionKey = dateValue(options.partitionKey) || snapshot.dataAsOf;
  const published = await publishDatasetPartition(datasetCode, snapshot.scopeKey, {
    partitionKey,
    dataAsOf,
    rowCount,
    sourceId: options.sourceId || null,
    diagnostics: {
      registry: true,
      table: DATASET_PARTITION_REGISTRY[datasetCode].table,
      reason: options.reason || 'snapshot',
      ...(options.diagnostics || {}),
    },
  }, executor);
  return { ...snapshot, dataAsOf, rowCount, published: Boolean(published), partitionKey };
}

async function publishJobDatasets(jobCode, businessDate, result) {
  if (result && (result.ok === false || result.publishDatasets === false)) return [];
  const definition = getJobDefinition(jobCode);
  const datasets = (definition.producesDatasets || []).filter(code => DATASET_PARTITION_REGISTRY[code]);
  const results = await Promise.all(datasets.map(async datasetCode => {
    try {
      const diagnostics = result && result.datasetDiagnostics && result.datasetDiagnostics[datasetCode] || {};
      const publication = await publishDatasetSnapshot(datasetCode, {
        partitionKey: businessDate,
        dataAsOf: result && (result.dataAsOf || result.data_as_of),
        rowCount: diagnostics.partition_row_count,
        diagnostics,
        reason: `job:${jobCode}`,
      });
      if (definition.strictDatasetPublication && !publication.published) {
        throw new Error(`${datasetCode} 数据分区未发布：${publication.reason || 'unknown'}`);
      }
      return publication;
    } catch (error) {
      if (definition.strictDatasetPublication) throw error;
      console.warn(`[dataset-partition] ${datasetCode} 发布失败：${error.message}`);
      return { published: false, datasetCode, reason: 'publish_error', error: error.message };
    }
  }));
  return results;
}

async function areJobDatasetsPublished(jobCode, businessDate) {
  const definition = getJobDefinition(jobCode);
  const datasets = (definition.producesDatasets || []).filter(code => DATASET_PARTITION_REGISTRY[code]);
  if (!datasets.length) return true;
  const partitionKey = dateValue(businessDate);
  if (!partitionKey) return false;
  const { rows } = await pool.query(
    `SELECT dataset_code,status,is_stale,diagnostics
       FROM ops.dataset_partitions
      WHERE dataset_code=ANY($1::text[]) AND partition_key=$2::date`,
    [datasets, partitionKey]
  );
  const byCode = new Map(rows.map(row => [row.dataset_code, row]));
  return datasets.every(code => {
    const row = byCode.get(code);
    if (!row || row.status !== 'published' || row.is_stale) return false;
    if (code === 'ipo_history') return row.diagnostics && row.diagnostics.quality_status === 'passed';
    return true;
  });
}

module.exports = { DATASET_PARTITION_REGISTRY, readSnapshot, publishDatasetSnapshot, publishJobDatasets, areJobDatasetsPublished };

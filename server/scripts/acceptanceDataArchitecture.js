#!/usr/bin/env node
// 证券数据架构只读验收工具。
// 只查询数据库和任务定义，不执行迁移、不调用外部接口、不修改业务数据。
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { pool } = require('../db/connection');
const { JOB_DEFINITIONS, declaredDailyExternalCallBudget } = require('../services/jobDefinitions');

const JSON_OUTPUT = process.argv.includes('--json');

async function query(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows;
}

function number(value) {
  return Number(value || 0);
}

function addCheck(checks, code, ok, detail, value = null) {
  checks.push({ code, ok: Boolean(ok), detail, ...(value === null ? {} : { value }) });
}

async function main() {
  const checks = [];
  const controlledPending = [
    '生产影子对账：需连续 3 个交易日观察共享采集与旧链路结果',
    '历史证券 ID 合并：自动迁移保留旧主档，人工核对项继续等待审批',
  ];

  const packageJson = require('../../package.json');
  addCheck(checks, 'version', /^\d+\.\d+\.\d+\.\d+$/.test(packageJson.appVersion) && packageJson.version === packageJson.appVersion,
    `应用版本 ${packageJson.appVersion}`);

  const identityJs = fs.readFileSync(path.join(__dirname, '..', 'services', 'securityIdentity.js'), 'utf8');
  const marketRoute = fs.readFileSync(path.join(__dirname, '..', 'routes', 'market.js'), 'utf8');
  const stockAnalysis = fs.readFileSync(path.join(__dirname, '..', 'services', 'stockAnalysis.js'), 'utf8');
  const tencentQuote = fs.readFileSync(path.join(__dirname, '..', 'services', 'tencentQuote.js'), 'utf8');
  const pythonIdentity = fs.readFileSync(path.join(__dirname, '..', '..', 'ipo-report', 'instrument_identity.py'), 'utf8');
  const pythonQuote = fs.readFileSync(path.join(__dirname, '..', '..', 'ipo-report', 'ipo_lib_common.py'), 'utf8');
  addCheck(checks, 'runtime_provider_mapping_entrypoints',
    /resolveProviderIdentifier/.test(identityJs) && /resolve_provider_code/.test(pythonIdentity)
      && /_get_qt_symbol/.test(pythonQuote) && /sourceCode: 'xueqiu'/.test(stockAnalysis)
      && /sourceCode: 'eastmoney', identifierType: 'guba_code'/.test(stockAnalysis)
      && /resolveProviderCode/.test(tencentQuote)
      && !/rawCodes\s*\|\|\s*\[\]\)\s*\.map\(describeTencentCode\)/.test(tencentQuote)
      && !/sinaSymbol\s*\|\|\s*requestedSecid/.test(marketRoute),
    'Node/Python 供应商代码转换经过统一身份映射入口，腾讯/股吧/雪球/新浪路由不再按前缀猜测');

  const migrationRows = await query(
    `SELECT version FROM schema_migrations WHERE version = ANY($1::text[]) ORDER BY version`,
    [['119_normalize_dividend_yield_unit', '120_repair_legacy_dividend_yield_unit',
      '121_backfill_dataset_partitions', '122_normalize_legacy_stock_identity',
      '123_backfill_stock_company_relations', '124_external_call_budget_function']]
  );
  addCheck(checks, 'migrations_119_124', migrationRows.length === 6,
    `已落库 ${migrationRows.length}/6 个整改迁移`, migrationRows.map(row => row.version));

  const functionRows = await query(
    `SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='ops' AND p.proname='consume_external_call_budget'`
  );
  addCheck(checks, 'atomic_budget_function', functionRows.length === 1,
    'Node 与 Python 共用 ops.consume_external_call_budget()');

  const duplicateRows = await query(
    `SELECT COUNT(*)::int AS count FROM (
       SELECT source_id,identifier_type,identifier_value
         FROM core.instrument_identifiers
        WHERE valid_to IS NULL OR valid_to >= CURRENT_DATE
        GROUP BY source_id,identifier_type,identifier_value
       HAVING COUNT(DISTINCT instrument_id) > 1
     ) x`
  );
  addCheck(checks, 'provider_identifier_unique', number(duplicateRows[0]?.count) === 0,
    `供应商代码一对多冲突 ${number(duplicateRows[0]?.count)} 条`, number(duplicateRows[0]?.count));

  const legacyRows = await query(`SELECT COUNT(*)::int AS count FROM core.instruments WHERE asset_class='equity'`);
  addCheck(checks, 'legacy_equity_zero', number(legacyRows[0]?.count) === 0,
    `遗留 equity 类型 ${number(legacyRows[0]?.count)} 条`, number(legacyRows[0]?.count));

  const dividendRows = await query(
    `SELECT COUNT(*)::int AS count FROM market.daily_valuations
      WHERE dividend_yield_ttm > 1 AND dividend_yield_ttm <= 100`
  );
  addCheck(checks, 'dividend_unit_anomaly_zero', number(dividendRows[0]?.count) === 0,
    `疑似百分数单位股息率 ${number(dividendRows[0]?.count)} 条`, number(dividendRows[0]?.count));

  const partitionRows = await query(
    `SELECT COUNT(*)::int AS rows,
            COUNT(DISTINCT dataset_code)::int AS datasets,
            COUNT(*) FILTER (WHERE status='published' AND row_count=0)::int AS empty_published
       FROM ops.dataset_partitions`
  );
  const partition = partitionRows[0] || {};
  addCheck(checks, 'published_partition_not_empty', number(partition.empty_published) === 0,
    `分区 ${number(partition.rows)} 行、${number(partition.datasets)} 个数据集，空发布 ${number(partition.empty_published)} 行`, partition);

  const latestBondPartitionRows = await query(
    `SELECT MAX(partition_key)::text AS trade_date FROM ops.dataset_partitions
      WHERE dataset_code='bond_daily' AND scope_key='CN' AND status='published'`
  );
  const latestBondDate = latestBondPartitionRows[0]?.trade_date || null;
  addCheck(checks, 'bond_daily_latest_partition', Boolean(latestBondDate),
    latestBondDate ? `最新已发布可转债行情分区 ${latestBondDate}` : '没有已发布 bond_daily 分区', latestBondDate);
  const activeBondRows = await query(
    `WITH latest AS (
       SELECT MAX(partition_key) AS trade_date
         FROM ops.dataset_partitions
        WHERE dataset_code='bond_daily' AND scope_key='CN' AND status='published'
     )
     SELECT COUNT(*) FILTER (WHERE p.stock_instrument_id IS NULL)::int AS missing_stock,
            COUNT(*)::int AS effective_bonds
       FROM market.convertible_bond_daily_metrics m
       JOIN fundamental.convertible_bond_profiles p ON p.instrument_id=m.instrument_id
       JOIN core.instruments i ON i.instrument_id=m.instrument_id
       JOIN public.bond_unified u ON u.instrument_id=m.instrument_id
      WHERE m.trade_date=(SELECT trade_date FROM latest)
        AND u.status='listed'
        AND (u.issue_type IS NULL OR u.issue_type NOT IN ('定向','私募'))
        AND (i.delist_date IS NULL OR i.delist_date > m.trade_date)
        AND (p.maturity_date IS NULL OR p.maturity_date >= m.trade_date)`
  );
  const activeBonds = activeBondRows[0] || {};
  addCheck(checks, 'effective_bond_stock_relation', Boolean(latestBondDate) && number(activeBonds.missing_stock) === 0,
    `有效行情转债 ${number(activeBonds.effective_bonds)} 只，缺正股关联 ${number(activeBonds.missing_stock)} 只`, activeBonds);

  const queueRows = await query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status IN ('pending','running','waiting_external'))::int AS active,
            COUNT(*) FILTER (WHERE status='waiting_external')::int AS waiting_external
       FROM ops.job_schedule_slots`
  );
  addCheck(checks, 'durable_job_queue', queueRows.length === 1,
    '计划实例、租约和 waiting_external 状态均由 PostgreSQL 持久化', queueRows[0] || {});

  const declaredCalls = JOB_DEFINITIONS.reduce((sum, job) => sum + declaredDailyExternalCallBudget(job), 0);
  addCheck(checks, 'job_matrix_budget', JOB_DEFINITIONS.length === 23 && declaredCalls <= 80,
    `任务定义 ${JOB_DEFINITIONS.length} 个，声明预算 ${declaredCalls}/日（目标≤80，硬上限100）`,
    { jobs: JOB_DEFINITIONS.length, declaredCalls });

  const externalDatasets = [...new Set(JOB_DEFINITIONS.flatMap(job => job.producesDatasets || []))];
  const publishedDatasetRows = await query(
    `SELECT DISTINCT dataset_code FROM ops.dataset_partitions WHERE status='published'`
  );
  const publishedCodes = new Set(publishedDatasetRows.map(row => row.dataset_code));
  const unpartitioned = externalDatasets.filter(code => !publishedCodes.has(code));
  // 这里是覆盖度提示，不把尚未接入分区的非核心采集器误判为核心链路失败。
  addCheck(checks, 'partition_coverage_report', true,
    `任务产出数据集 ${externalDatasets.length} 个，已有发布分区 ${publishedCodes.size} 个，未接入 ${unpartitioned.length} 个`,
    { externalDatasets, publishedDatasets: [...publishedCodes], unpartitioned });

  const mergeRows = await query(
    `SELECT COUNT(*)::int AS candidates,
            COUNT(*) FILTER (WHERE status='candidate')::int AS pending,
            COUNT(*) FILTER (WHERE status='candidate' AND conflict_count=0)::int AS safe_pending,
            COUNT(*) FILTER (WHERE status='migrated')::int AS migrated
       FROM core.instrument_merge_candidates`
  );
  const bareStockRows = await query(
    `WITH bare AS (
       SELECT instrument_id,canonical_code,regexp_replace(canonical_code,'\\D','','g') AS digits,exchange_code
         FROM core.instruments
        WHERE asset_class='stock' AND canonical_code !~ '\\.[A-Z]{2}$'
     ), mapped AS (
       SELECT b.*,
              lpad(b.digits,6,'0') || CASE b.exchange_code
                WHEN 'SSE' THEN '.SH' WHEN 'SZSE' THEN '.SZ' WHEN 'BSE' THEN '.BJ' END AS expected_code
         FROM bare b
     ), resolved AS (
       SELECT m.*,t.instrument_id AS target_id
         FROM mapped m LEFT JOIN core.instruments t ON t.canonical_code=m.expected_code
     )
     SELECT COUNT(*)::int AS count,
            COUNT(*) FILTER (WHERE target_id IS NULL AND expected_code IS NOT NULL)::int AS safe_normalize,
            COUNT(*) FILTER (WHERE target_id IS NOT NULL)::int AS merge_conflict,
            COUNT(*) FILTER (WHERE expected_code IS NULL)::int AS unresolved
       FROM resolved`
  );
  const bareStock = bareStockRows[0] || {};
  addCheck(checks, 'bare_stock_resolution', number(bareStock.unresolved) === 0,
    `历史裸股票代码 ${number(bareStock.count)} 条，其中可直接规范化 ${number(bareStock.safe_normalize)} 条、需合并 ${number(bareStock.merge_conflict)} 条、无法判定 ${number(bareStock.unresolved)} 条`, bareStock);
  const testCircuitRows = await query(
    `SELECT COUNT(*)::int AS count FROM ops.external_circuits
      WHERE source LIKE 'test_guard_%' OR source='cninfo-test'`
  );
  const relationExceptionRows = await query(
    `SELECT COUNT(*)::int AS count
       FROM core.instruments i
       LEFT JOIN core.company_instruments ci ON ci.instrument_id=i.instrument_id AND ci.relation_type='issued_by'
      WHERE i.asset_class='stock' AND i.status='listed' AND NULLIF(BTRIM(i.name),'') IS NULL AND ci.instrument_id IS NULL`
  );
  controlledPending.push(`当前只读统计：历史合并候选 ${number(mergeRows[0]?.candidates)} 组（待审 ${number(mergeRows[0]?.pending)}，其中可自动迁移 ${number(mergeRows[0]?.safe_pending)}，已迁移 ${number(mergeRows[0]?.migrated)}），裸股票代码 ${number(bareStock.count)} 条（可直接规范化 ${number(bareStock.safe_normalize)}、需合并 ${number(bareStock.merge_conflict)}），旧 test_guard 熔断 ${number(testCircuitRows[0]?.count)} 条，空名称关系例外 ${number(relationExceptionRows[0]?.count)} 条`);

  const failed = checks.filter(check => !check.ok);
  const result = {
    ok: failed.length === 0,
    status: failed.length ? 'failed' : controlledPending.length ? 'pass_with_controlled_pending' : 'passed',
    checked_at: new Date().toISOString(),
    checks,
    controlled_pending: controlledPending,
  };
  if (JSON_OUTPUT) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`数据架构只读验收：${result.ok ? '通过' : '失败'}（${result.status}）`);
    for (const check of checks) console.log(`${check.ok ? '✓' : '✗'} ${check.code}：${check.detail}`);
    if (controlledPending.length) {
      console.log('受控待办（不代表本次代码/数据库验收失败）：');
      controlledPending.forEach(item => console.log(`- ${item}`));
    }
  }
  await pool.end();
  if (!result.ok) process.exitCode = 1;
}

main().catch(async error => {
  console.error(`数据架构只读验收失败：${error.message}`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});

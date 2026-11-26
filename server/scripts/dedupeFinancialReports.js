#!/usr/bin/env node
// 财报重复副本清理 + 版本键归一（2026-11-26 事故整改的数据侧）。
//
// 事故：financial_reports 原来用「整条 payload 的哈希」当 source_version，而采集适配器
// 每次返回的字段个数、覆盖标记、对比数据都在变，于是每次重采都被判成新版本插入新行。
// 结果：216 万行里只有约 118 万份真实报告，其余是同一份报告的重复副本；表涨到 9.4GB，
// 全市场选股从 1 分钟级恶化到 8 分钟以上，company_financial_incremental_sync 与
// stock_analysis_refresh 连续触发 30 分钟任务超时。
//
// 代码侧已把版本键改成业务身份（server/repositories/stockProjectionRepository.js 的
// reportIdentityVersion）。本脚本处理存量：
//   1) 同一业务身份只保留最完整的一行，其余删除；删除前把明细 financial_facts 与
//      六张科目宽表的数据并到保留行（外键为 ON DELETE CASCADE，不会留下孤儿行）
//   2) update_flag 的空值与 '0' 归一为 '0'（两者语义都是"未更正"）
//   3) 按业务身份重算全部行的 source_version，让后续重采就地更新而不是新增
//   4) 重算 is_current_version（沿用代码同一套排名规则）
//
// 用法（先 dry-run 看清规模）：
//   node server/scripts/dedupeFinancialReports.js                          # 只统计
//   node server/scripts/dedupeFinancialReports.js --apply                  # 执行
//   node server/scripts/dedupeFinancialReports.js --apply --batch=2000     # 每批组数
//   node server/scripts/dedupeFinancialReports.js --apply --skip-version   # 只删重复
//
// 幂等：重复运行结果一致；每批一个事务，中断后重跑会从剩余重复组继续。
// 脚本不执行 VACUUM FULL（长时间锁表），结束时打印建议命令由运维在低峰手动执行。

const { pool } = require('../db');
const { normalizeUpdateFlag, reportIdentityVersion } = require('../repositories/stockProjectionRepository');

const APPLY = process.argv.includes('--apply');
const SKIP_VERSION = process.argv.includes('--skip-version');
const argOf = (name, fallback) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  const value = hit ? Number(hit.split('=')[1]) : NaN;
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
};
const GROUP_BATCH = argOf('batch', 2000);
const VERSION_BATCH = argOf('version-batch', 5000);

const WIDE_TABLES = [
  'fundamental.statement_balance_cas',
  'fundamental.statement_income_cas',
  'fundamental.statement_cashflow_cas',
  'fundamental.statement_balance_hkfrs',
  'fundamental.statement_income_hkfrs',
  'fundamental.statement_cashflow_hkfrs',
];
// 宽表里由报告本体决定的列：合并时保留保留行自己的值，只搬科目数据列。
const WIDE_IDENTITY_COLUMNS = new Set([
  'statement_id', 'report_id', 'company_id', 'period_end', 'period_type', 'announced_at',
  'currency_code', 'accounting_standard', 'source_id', 'source_version', 'raw_record_id', 'ingested_at',
]);

const log = (...args) => console.log('[dedupe]', ...args);
const asNumber = value => Number(value);

// 与 syncReportRows 取币种的口径一致：行内自带币种优先，否则按证券市场兜底
// （A 股 CNY / 港股 HKD）。口径不一致会让清理后的版本键与下一次采集算出的不同，
// 于是又插一行新行，清理就白做了。
function currencyOf(declaredCurrency, tsCode) {
  const declared = String(declaredCurrency || '').trim().toUpperCase();
  if (declared) return declared;
  if (/\.HK$/i.test(tsCode)) return 'HKD';
  if (/^[0-9]{6}\.(SH|SZ|BJ)$/i.test(tsCode)) return 'CNY';
  return '';
}

// 与 syncReportRows 的 targetScope 规则一致：合并报表口径固定 consolidated。
function scopeOf(reportType, statementScope) {
  if (String(reportType || '') === '1') return 'consolidated';
  return String(statementScope || 'consolidated');
}

async function wideTableDataColumns(client, table) {
  const { rows } = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = split_part($1, '.', 1) AND table_name = split_part($1, '.', 2)
      ORDER BY ordinal_position`, [table]);
  return rows.map(r => r.column_name).filter(name => !WIDE_IDENTITY_COLUMNS.has(name));
}

async function buildPlan(client) {
  log('构建重复组计划（全表扫描一次，大表约需 1-2 分钟）…');
  await client.query('DROP TABLE IF EXISTS tmp_ident');
  await client.query('DROP TABLE IF EXISTS tmp_plan');
  await client.query(`
    CREATE TEMP TABLE tmp_ident AS
    SELECT report_id, company_id, report_kind, period_end, source_id,
           COALESCE(report_type,'') AS rt, COALESCE(comp_type,'') AS ct,
           COALESCE(NULLIF(update_flag,''),'0') AS uf,
           announced_at, f_ann_date, COALESCE(statement_scope,'consolidated') AS sc,
           COALESCE((raw_payload->'__statement_coverage'->>'complete')::boolean, false) AS complete,
           pg_column_size(raw_payload) AS len, ingested_at, is_current_version
      FROM fundamental.financial_reports`);
  await client.query(`
    CREATE TEMP TABLE tmp_plan AS
    SELECT keep_id, report_id AS dup_id FROM (
      SELECT report_id,
             first_value(report_id) OVER w AS keep_id,
             row_number() OVER w AS rn
        FROM tmp_ident
      WINDOW w AS (PARTITION BY company_id, report_kind, period_end, source_id, rt, ct, uf,
                                announced_at, f_ann_date, sc
                   ORDER BY complete DESC, is_current_version DESC, len DESC, ingested_at DESC, report_id DESC)
    ) x WHERE rn > 1`);
  await client.query('CREATE INDEX ON tmp_plan(keep_id)');
  const { rows } = await client.query(
    'SELECT count(*)::int AS dups, count(DISTINCT keep_id)::int AS groups FROM tmp_plan');
  log(`重复组 ${rows[0].groups} 个，待删除 ${rows[0].dups} 行`);
  return rows[0];
}

async function mergeFacts(client) {
  await client.query(`
    INSERT INTO fundamental.financial_facts(report_id, statement_type, metric_code, numeric_value, unit_code, currency_code, source_field)
    SELECT p.keep_id, f.statement_type, f.metric_code, f.numeric_value, f.unit_code, f.currency_code, f.source_field
      FROM tmp_batch p
      JOIN fundamental.financial_facts f ON f.report_id = p.dup_id
    ON CONFLICT (report_id, metric_code) DO NOTHING`);
}

// 科目宽表合并，两步都走集合语句：先把被删行独有的科目值补进保留行的空列，
// 再把"保留行根本没有宽表行"的情形整行改指向保留行。
async function mergeWideTables(client, columnsByTable) {
  for (const table of WIDE_TABLES) {
    const columns = columnsByTable[table];
    if (!columns.length) continue;
    const assignments = columns.map(col => `${col} = COALESCE(k.${col}, rep.${col})`).join(', ');
    await client.query(`
      WITH rep AS (
        SELECT DISTINCT ON (p.keep_id) p.keep_id, w.*
          FROM tmp_batch p
          JOIN ${table} w ON w.report_id = p.dup_id
         WHERE EXISTS (SELECT 1 FROM ${table} k WHERE k.report_id = p.keep_id)
         ORDER BY p.keep_id, w.report_id DESC
      )
      UPDATE ${table} k SET ${assignments}
        FROM rep WHERE k.report_id = rep.keep_id`);
    await client.query(`
      WITH rep AS (
        SELECT DISTINCT ON (p.keep_id) p.keep_id, w.report_id AS src_id
          FROM tmp_batch p
          JOIN ${table} w ON w.report_id = p.dup_id
         WHERE NOT EXISTS (SELECT 1 FROM ${table} k WHERE k.report_id = p.keep_id)
         ORDER BY p.keep_id, w.report_id DESC
      )
      UPDATE ${table} w SET report_id = rep.keep_id
        FROM rep WHERE w.report_id = rep.src_id`);
  }
}

async function runDeletions(client) {
  const columnsByTable = {};
  for (const table of WIDE_TABLES) columnsByTable[table] = await wideTableDataColumns(client, table);
  await client.query('DROP TABLE IF EXISTS tmp_batch');
  await client.query('CREATE TEMP TABLE tmp_batch(keep_id bigint, dup_id bigint)');
  let cursor = 0;
  let deleted = 0;
  let groups = 0;
  for (;;) {
    // 按保留行（keep_id）整批取，避免把同一组切到两批里
    const { rows: keepRows } = await client.query(
      'SELECT DISTINCT keep_id FROM tmp_plan WHERE keep_id > $1 ORDER BY keep_id LIMIT $2',
      [cursor, GROUP_BATCH]);
    if (!keepRows.length) break;
    const keepIds = keepRows.map(r => asNumber(r.keep_id));
    cursor = keepIds[keepIds.length - 1];
    await client.query('TRUNCATE tmp_batch');
    await client.query(
      'INSERT INTO tmp_batch(keep_id, dup_id) SELECT keep_id, dup_id FROM tmp_plan WHERE keep_id = ANY($1::bigint[])',
      [keepIds]);
    await client.query('BEGIN');
    try {
      await mergeFacts(client);
      await mergeWideTables(client, columnsByTable);
      const { rowCount } = await client.query(
        'DELETE FROM fundamental.financial_reports WHERE report_id IN (SELECT dup_id FROM tmp_batch)');
      await client.query('COMMIT');
      deleted += rowCount;
      groups += keepIds.length;
      log(`已删除 ${deleted} 行（本批 ${rowCount} 行 / ${keepIds.length} 组），游标 ${cursor}`);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
  }
  return { deleted, groups };
}

async function normalizeUpdateFlagColumn(client) {
  let cursor = 0;
  let total = 0;
  for (;;) {
    const { rows } = await client.query(`
      UPDATE fundamental.financial_reports SET update_flag = '0'
       WHERE report_id IN (
         SELECT report_id FROM fundamental.financial_reports
          WHERE report_id > $1
            AND COALESCE(NULLIF(update_flag,''),'0') = '0'
            AND update_flag IS DISTINCT FROM '0'
          ORDER BY report_id LIMIT 20000)
      RETURNING report_id`, [cursor]);
    if (!rows.length) break;
    cursor = Math.max(...rows.map(r => asNumber(r.report_id)));
    total += rows.length;
    log(`update_flag 归一：累计 ${total} 行，游标 ${cursor}`);
  }
  return total;
}

// 按业务身份重算版本键。必须用 JS 计算（与写入路径同一函数）：币种兜底依赖证券市场，
// 在 SQL 里复刻容易和写入路径错开，那会导致下次采集又插新行。
async function rewriteVersions(client) {
  let cursor = 0;
  let total = 0;
  for (;;) {
    const { rows } = await client.query(`
      SELECT report_id, company_id, report_kind, source_id,
             to_char(period_end,'YYYY-MM-DD') AS period_end,
             COALESCE(raw_payload->>'ts_code','') AS ts_code,
             COALESCE(raw_payload->>'currency','') AS currency,
             COALESCE(report_type,'') AS report_type, COALESCE(comp_type,'') AS comp_type,
             COALESCE(NULLIF(update_flag,''),'0') AS update_flag,
             to_char(announced_at,'YYYY-MM-DD') AS announced_at,
             to_char(f_ann_date,'YYYY-MM-DD') AS f_ann_date,
             COALESCE(statement_scope,'') AS statement_scope,
             source_version
        FROM fundamental.financial_reports
       WHERE report_id > $1
       ORDER BY report_id LIMIT $2`, [cursor, VERSION_BATCH]);
    if (!rows.length) break;
    const tuples = [];
    const params = [];
    let i = 0;
    for (const row of rows) {
      cursor = asNumber(row.report_id);
      const tsCode = String(row.ts_code || '').trim().toUpperCase();
      const version = reportIdentityVersion({
        companyId: row.company_id,
        kind: row.report_kind,
        periodEnd: row.period_end || '',
        sourceId: row.source_id,
        tsCode,
        reportType: row.report_type,
        compType: row.comp_type,
        updateFlag: normalizeUpdateFlag(row.update_flag),
        announcedAt: row.announced_at || '',
        fAnnDate: row.f_ann_date || '',
        currency: currencyOf(row.currency, tsCode),
        scope: scopeOf(row.report_type, row.statement_scope),
      });
      if (version === row.source_version) continue;
      tuples.push(`($${++i}::bigint, $${++i}::text)`);
      params.push(cursor, version);
    }
    if (tuples.length) {
      await client.query(`
        UPDATE fundamental.financial_reports r SET source_version = v.version
          FROM (VALUES ${tuples.join(',')}) AS v(report_id, version)
         WHERE r.report_id = v.report_id`, params);
      total += tuples.length;
      log(`版本键重算：累计 ${total} 行，游标 ${cursor}`);
    }
  }
  return total;
}

async function syncWideTableVersions(client) {
  let total = 0;
  for (const table of WIDE_TABLES) {
    const { rowCount } = await client.query(`
      UPDATE ${table} w SET source_version = r.source_version
        FROM fundamental.financial_reports r
       WHERE w.report_id = r.report_id
         AND w.source_version IS DISTINCT FROM r.source_version`);
    total += rowCount;
    log(`${table} 版本同步 ${rowCount} 行`);
  }
  return total;
}

async function recomputeCurrentVersion(client) {
  let cursor = 0;
  let total = 0;
  for (;;) {
    const { rows: companies } = await client.query(`
      SELECT DISTINCT company_id FROM fundamental.financial_reports
       WHERE company_id > $1 ORDER BY company_id LIMIT 200`, [cursor]);
    if (!companies.length) break;
    const ids = companies.map(c => c.company_id);
    cursor = ids[ids.length - 1];
    const { rowCount } = await client.query(`
      WITH ranked AS (
        SELECT report_id,
               row_number() OVER (
                 PARTITION BY company_id, report_kind, period_end,
                   COALESCE(statement_scope,'consolidated'),
                   CASE
                     WHEN upper(COALESCE(raw_payload->>'ts_code','')) LIKE '%.HK' THEN 'HK'
                     WHEN upper(COALESCE(raw_payload->>'ts_code','')) ~ '^[0-9]{6}[.](SH|SZ|BJ)$' THEN 'CN'
                     ELSE 'UNKNOWN'
                   END
                 ORDER BY CASE WHEN COALESCE((raw_payload->'__statement_coverage'->>'complete')::boolean, true) THEN 0 ELSE 1 END,
                   CASE WHEN report_type='1' THEN 0 ELSE 1 END,
                   announced_at DESC NULLS LAST, ingested_at DESC, report_id DESC) rn
          FROM fundamental.financial_reports
         WHERE company_id = ANY($1::bigint[])
      )
      UPDATE fundamental.financial_reports r SET is_current_version = (ranked.rn = 1)
        FROM ranked
       WHERE r.report_id = ranked.report_id
         AND r.is_current_version IS DISTINCT FROM (ranked.rn = 1)`, [ids]);
    total += rowCount;
    log(`is_current_version 重算：200 家公司改动 ${rowCount} 行，游标 ${cursor}`);
  }
  return total;
}

async function main() {
  log(`模式=${APPLY ? 'APPLY（会改数据）' : 'DRY-RUN（只统计）'} 组批=${GROUP_BATCH}`);
  const client = await pool.connect();
  try {
    await client.query("SET statement_timeout = '0'");
    await client.query("SET lock_timeout = '30s'");
    const plan = await buildPlan(client);
    if (!APPLY) {
      const { rows } = await client.query(`
        SELECT pg_size_pretty(COALESCE(sum(pg_column_size(r.raw_payload)),0)::bigint) AS payload_bytes,
               count(*)::int AS dups
          FROM tmp_plan p JOIN fundamental.financial_reports r ON r.report_id = p.dup_id`);
      log(`被删副本的 JSONB 合计约 ${rows[0].payload_bytes}，删完需 VACUUM FULL 才能把空间还给系统`);
      log('以上是预览，未改动任何数据。确认后加 --apply 执行。');
      return;
    }
    if (plan.dups) {
      const del = await runDeletions(client);
      log(`删除完成：${del.deleted} 行 / ${del.groups} 组`);
    } else {
      log('没有重复组，跳过删除。');
    }
    log(`update_flag 归一完成：${await normalizeUpdateFlagColumn(client)} 行`);
    if (!SKIP_VERSION) {
      log(`版本键重算完成：${await rewriteVersions(client)} 行`);
      log(`宽表版本同步完成：${await syncWideTableVersions(client)} 行`);
    }
    log(`is_current_version 重算完成：${await recomputeCurrentVersion(client)} 行`);
    const { rows: after } = await client.query(
      `SELECT count(*)::int AS rows, pg_size_pretty(pg_total_relation_size('fundamental.financial_reports')) AS size
         FROM fundamental.financial_reports`);
    log(`当前：${after[0].rows} 行 / ${after[0].size}`);
    log('低峰手工回收空间（会锁表，需空闲磁盘 ≥ 表大小）：');
    log("  sudo -u postgres psql -d portfolio -c 'VACUUM (FULL, ANALYZE) fundamental.financial_reports;'");
    log("  sudo -u postgres psql -d portfolio -c 'VACUUM (ANALYZE) fundamental.financial_facts;'");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(e => {
  console.error('[dedupe] 失败：', e && e.stack ? e.stack : e);
  process.exit(1);
});

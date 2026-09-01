#!/usr/bin/env node
// 证券历史 ID 合并审计工具。
// 默认只读；--write-candidates 仅把候选和影响量写入审计表，绝不删除或改写旧 ID。
const { pool, runMigrations } = require('../db');

const WRITE = process.argv.includes('--write-candidates');
const JSON_OUTPUT = process.argv.includes('--json');

function ident(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_]/g, '');
}

async function referenceColumns() {
  const { rows } = await pool.query(`
    SELECT source_ns.nspname AS table_schema,source_rel.relname AS table_name,source_att.attname AS column_name
      FROM pg_constraint con
      JOIN pg_class source_rel ON source_rel.oid=con.conrelid
      JOIN pg_namespace source_ns ON source_ns.oid=source_rel.relnamespace
      JOIN pg_class target_rel ON target_rel.oid=con.confrelid
      JOIN pg_namespace target_ns ON target_ns.oid=target_rel.relnamespace
      JOIN LATERAL unnest(con.conkey) AS key(attnum) ON true
      JOIN pg_attribute source_att ON source_att.attrelid=source_rel.oid AND source_att.attnum=key.attnum
     WHERE con.contype='f' AND target_ns.nspname='core' AND target_rel.relname='instruments'
       AND source_ns.nspname NOT IN ('pg_catalog','information_schema')
       AND source_rel.relname NOT LIKE '%_bak%'
       AND NOT (source_ns.nspname='core' AND source_rel.relname='instrument_merge_candidates')
     ORDER BY source_ns.nspname,source_rel.relname,source_att.attname`);
  return rows;
}

async function impactFor(candidate, columns) {
  const impact = {};
  let total = 0;
  for (const column of columns) {
    const schema = ident(column.table_schema);
    const table = ident(column.table_name);
    const field = ident(column.column_name);
    if (!schema || !table || !field) continue;
    const result = await pool.query(
      `SELECT count(*)::int AS count FROM "${schema}"."${table}" WHERE "${field}"=$1`,
      [candidate.duplicate_instrument_id]
    );
    const count = Number(result.rows[0]?.count || 0);
    if (count) impact[`${schema}.${table}.${field}`] = count;
    total += count;
  }
  return { impact, total };
}

async function loadCandidates() {
  const { rows } = await pool.query(`
    SELECT p.instrument_id AS primary_instrument_id,
           d.instrument_id AS duplicate_instrument_id,
           p.canonical_code AS primary_code,d.canonical_code AS duplicate_code,
           p.name AS primary_name,d.name AS duplicate_name,
           p.asset_class,p.market
      FROM core.instruments p
      JOIN core.instruments d
        ON p.instrument_id<d.instrument_id
       AND p.asset_class=d.asset_class
       AND p.market=d.market
       AND regexp_replace(p.canonical_code,'\\D','','g')=regexp_replace(d.canonical_code,'\\D','','g')
     WHERE p.canonical_code<>d.canonical_code
     ORDER BY p.asset_class,p.market,p.canonical_code,d.canonical_code`);
  return rows;
}

async function main() {
  await runMigrations();
  const columns = await referenceColumns();
  const rows = await loadCandidates();
  const result = [];
  for (const row of rows) {
    const { impact, total } = await impactFor(row, columns);
    const sameName = String(row.primary_name || '').trim() && String(row.primary_name || '').trim() === String(row.duplicate_name || '').trim();
    result.push({
      primary_instrument_id: Number(row.primary_instrument_id),
      duplicate_instrument_id: Number(row.duplicate_instrument_id),
      primary_code: row.primary_code,
      duplicate_code: row.duplicate_code,
      asset_class: row.asset_class,
      market: row.market,
      reason: sameName ? '同市场同类型同数字代码且名称一致' : '同市场同类型数字代码重复，名称需人工核对',
      impact_counts: impact,
      conflict_count: sameName ? 0 : 1,
      total_references: total,
    });
  }
  if (WRITE && result.length) {
    await pool.query('BEGIN');
    try {
      for (const row of result) {
        await pool.query(`
          INSERT INTO core.instrument_merge_candidates
            (primary_instrument_id,duplicate_instrument_id,reason,impact_counts,conflict_count,status,generated_at)
          VALUES($1,$2,$3,$4::jsonb,$5,'candidate',now())
          ON CONFLICT(primary_instrument_id,duplicate_instrument_id) DO UPDATE SET
            reason=EXCLUDED.reason,impact_counts=EXCLUDED.impact_counts,
            conflict_count=EXCLUDED.conflict_count,generated_at=now()`,
          [row.primary_instrument_id,row.duplicate_instrument_id,row.reason,JSON.stringify(row.impact_counts),row.conflict_count]
        );
      }
      await pool.query('COMMIT');
    } catch (error) {
      await pool.query('ROLLBACK');
      throw error;
    }
  }
  const summary = {
    mode: WRITE ? 'write-candidates' : 'dry-run',
    candidate_count: result.length,
    safe_name_matches: result.filter(row => row.conflict_count === 0).length,
    manual_review_required: result.filter(row => row.conflict_count > 0).length,
    total_references: result.reduce((sum,row) => sum + row.total_references, 0),
    candidates: result,
  };
  if (JSON_OUTPUT) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`证券历史 ID 合并审计（${summary.mode}）：候选 ${summary.candidate_count} 组，名称一致 ${summary.safe_name_matches} 组，需人工核对 ${summary.manual_review_required} 组，受影响引用 ${summary.total_references} 行。`);
    if (result.length) for (const row of result.slice(0, 20)) console.log(`- ${row.primary_code} ← ${row.duplicate_code}：${row.reason}；引用 ${row.total_references} 行`);
    if (result.length > 20) console.log(`…其余 ${result.length - 20} 组请使用 --json 导出`);
  }
  await pool.end();
}

main().catch(async error => {
  console.error(`证券历史 ID 审计失败：${error.message}`);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});

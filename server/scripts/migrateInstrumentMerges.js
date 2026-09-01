#!/usr/bin/env node
// 历史证券 ID 分批迁移工具。
// 默认只生成计划；--apply 才会在一个事务中更新外键并把旧主档标记为 merged。
// 不删除 core.instruments，也不处理名称冲突组；冲突项继续留在候选表等待人工映射。
const { pool, runMigrations } = require('../db');

const APPLY = process.argv.includes('--apply');
const CONFIRM = process.argv.includes('--confirm-production');
const JSON_OUTPUT = process.argv.includes('--json');

function ident(value) {
  const text = String(value || '');
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(text)) throw new Error(`非法数据库标识：${text}`);
  return `"${text}"`;
}

function tableName(schema, table) {
  return `${ident(schema)}.${ident(table)}`;
}

function asNumber(value) {
  return Number(value || 0);
}

async function loadPlan(client) {
  const { rows } = await client.query(`
    WITH stock AS (
      SELECT instrument_id,canonical_code,name,asset_class,market,exchange_code,
             regexp_replace(canonical_code,'\\D','','g') AS digits
        FROM core.instruments
       WHERE asset_class='stock' AND market='CN'
    ), candidate_groups AS (
      SELECT DISTINCT regexp_replace(p.canonical_code,'\\D','','g') AS digits
        FROM core.instrument_merge_candidates c
        JOIN core.instruments p ON p.instrument_id=c.primary_instrument_id
       WHERE c.status='candidate'
    ), conflict_groups AS (
      SELECT DISTINCT regexp_replace(p.canonical_code,'\\D','','g') AS digits
        FROM core.instrument_merge_candidates c
        JOIN core.instruments p ON p.instrument_id=c.primary_instrument_id
       WHERE c.status='candidate' AND c.conflict_count>0
    ), targets AS (
      SELECT s.digits,
             MIN(s.instrument_id) FILTER (WHERE s.canonical_code ~ '^\\d{6}\\.(SH|SZ|BJ)$') AS target_id,
             COUNT(*) FILTER (WHERE s.canonical_code ~ '^\\d{6}\\.(SH|SZ|BJ)$') AS exact_count
        FROM stock s
       GROUP BY s.digits
    )
    SELECT s.instrument_id AS old_id,s.canonical_code AS old_code,s.name AS old_name,
           t.target_id,new.canonical_code AS target_code,new.name AS target_name,
           s.digits
      FROM stock s
      JOIN targets t ON t.digits=s.digits AND t.exact_count=1 AND t.target_id IS NOT NULL
      JOIN core.instruments new ON new.instrument_id=t.target_id
      JOIN candidate_groups cg ON cg.digits=s.digits
      LEFT JOIN conflict_groups x ON x.digits=s.digits
     WHERE s.instrument_id<>t.target_id AND x.digits IS NULL
     ORDER BY s.digits,s.instrument_id`);
  const { rows: stats } = await client.query(`
    WITH stock AS (
      SELECT regexp_replace(canonical_code,'\\D','','g') AS digits
        FROM core.instruments WHERE asset_class='stock' AND market='CN'
    ), groups AS (
      SELECT regexp_replace(canonical_code,'\\D','','g') AS digits,COUNT(*) AS total,
             COUNT(*) FILTER (WHERE canonical_code ~ '^\\d{6}\\.(SH|SZ|BJ)$') AS exact_count
        FROM core.instruments
       WHERE asset_class='stock' AND market='CN'
       GROUP BY digits
    )
    SELECT
      (SELECT COUNT(*) FROM core.instrument_merge_candidates WHERE status='candidate')::int AS candidate_rows,
      (SELECT COUNT(*) FROM core.instrument_merge_candidates WHERE status='candidate' AND conflict_count>0)::int AS manual_rows,
      (SELECT COUNT(*) FROM groups WHERE total>1)::int AS duplicate_groups,
      (SELECT COUNT(*) FROM groups WHERE total>1 AND exact_count=0)::int AS unresolved_groups,
      (SELECT COUNT(*) FROM groups WHERE total>1 AND exact_count=1)::int AS exact_target_groups`);
  return { maps: rows, stats: stats[0] || {} };
}

async function loadForeignKeys(client) {
  const { rows } = await client.query(`
    SELECT DISTINCT source_ns.nspname AS table_schema,source_rel.relname AS table_name,
           source_att.attname AS column_name
      FROM pg_constraint con
      JOIN pg_class source_rel ON source_rel.oid=con.conrelid
      JOIN pg_namespace source_ns ON source_ns.oid=source_rel.relnamespace
      JOIN pg_class target_rel ON target_rel.oid=con.confrelid
      JOIN pg_namespace target_ns ON target_ns.oid=target_rel.relnamespace
      JOIN LATERAL unnest(con.conkey) AS key(attnum) ON true
      JOIN pg_attribute source_att ON source_att.attrelid=source_rel.oid AND source_att.attnum=key.attnum
     WHERE con.contype='f' AND target_ns.nspname='core' AND target_rel.relname='instruments'
       AND source_ns.nspname NOT IN ('pg_catalog','information_schema')
       AND NOT (source_ns.nspname='core' AND source_rel.relname='instrument_merge_candidates')
     ORDER BY 1,2,3`);
  return rows;
}

async function loadUniqueIndexes(client, foreignKeys) {
  const tableKeys = new Set(foreignKeys.map(row => `${row.table_schema}.${row.table_name}`));
  if (!tableKeys.size) return [];
  const { rows } = await client.query(`
    SELECT n.nspname AS table_schema,c.relname AS table_name,
           idx.indexrelid::regclass::text AS index_name,
           pg_get_expr(idx.indpred,idx.indrelid) AS predicate,
           pg_get_expr(idx.indexprs,idx.indrelid) AS expressions,
           array_agg(a.attname ORDER BY k.ord) AS columns
      FROM pg_index idx
      JOIN pg_class c ON c.oid=idx.indrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN LATERAL unnest(idx.indkey) WITH ORDINALITY AS k(attnum,ord) ON k.attnum>0
      JOIN pg_attribute a ON a.attrelid=idx.indrelid AND a.attnum=k.attnum
     WHERE idx.indisunique
       AND (n.nspname,c.relname) IN (${[...tableKeys].map((_, i) => `($${i * 2 + 1},$${i * 2 + 2})`).join(',')})
     GROUP BY n.nspname,c.relname,idx.indexrelid,idx.indpred,idx.indexprs
     ORDER BY 1,2,3`, [...tableKeys].flatMap(key => key.split('.')));
  return rows;
}

async function createTempMap(client, maps) {
  await client.query(`CREATE TEMP TABLE tmp_instrument_merge_map(
    old_id BIGINT PRIMARY KEY,new_id BIGINT NOT NULL,old_code TEXT NOT NULL,target_code TEXT NOT NULL
  ) ON COMMIT DROP`);
  for (let offset = 0; offset < maps.length; offset += 500) {
    const batch = maps.slice(offset, offset + 500);
    const values = [];
    const params = [];
    batch.forEach((row, index) => {
      const n = index * 4;
      values.push(`($${n + 1},$${n + 2},$${n + 3},$${n + 4})`);
      params.push(row.old_id, row.target_id, row.old_code, row.target_code);
    });
    await client.query(
      `INSERT INTO tmp_instrument_merge_map(old_id,new_id,old_code,target_code) VALUES ${values.join(',')}`,
      params
    );
  }
}

function equality(columns, leftAlias, rightAlias) {
  return columns.map(column => `${leftAlias}.${ident(column)} IS NOT DISTINCT FROM ${rightAlias}.${ident(column)}`).join(' AND ');
}

async function findBlockedMappings(client, foreignKeys, uniqueIndexes) {
  const blocked = new Map();
  const fkByTable = new Map();
  foreignKeys.forEach(fk => {
    const key = `${fk.table_schema}.${fk.table_name}`;
    const list = fkByTable.get(key) || [];
    list.push(fk.column_name);
    fkByTable.set(key, list);
  });
  for (const index of uniqueIndexes) {
    const indexColumns = Array.isArray(index.columns)
      ? index.columns
      : String(index.columns || '').replace(/^\{|\}$/g, '').split(',').filter(Boolean).map(value => value.replace(/^"|"$/g, ''));
    const fkColumns = fkByTable.get(`${index.table_schema}.${index.table_name}`) || [];
    for (const fkColumn of fkColumns) {
      if (!indexColumns.includes(fkColumn)) continue;
      if (index.predicate || index.expressions) {
        const table = tableName(index.table_schema, index.table_name);
        const unsafe = await client.query(`
          SELECT m.old_id
            FROM ${table} d
            JOIN tmp_instrument_merge_map m ON d.${ident(fkColumn)}=m.old_id`);
        unsafe.rows.forEach(row => blocked.set(String(row.old_id), `${index.index_name}:表达式/部分唯一索引需人工确认`));
        continue;
      }
      const otherColumns = indexColumns.filter(column => column !== fkColumn);
      const table = tableName(index.table_schema, index.table_name);
      const dKey = equality(otherColumns, 'd', 't');
      const groupKey = ['m.new_id', ...otherColumns.map(column => `d.${ident(column)}`)].join(',');
      const groupSelect = ['m.new_id', ...otherColumns.map(column => `d.${ident(column)}`), 'array_agg(m.old_id) AS old_ids'].join(',');
      const existing = await client.query(`
        SELECT DISTINCT m.old_id
          FROM ${table} d
          JOIN tmp_instrument_merge_map m ON d.${ident(fkColumn)}=m.old_id
          JOIN ${table} t ON t.${ident(fkColumn)}=m.new_id
         WHERE ${dKey || 'TRUE'}`);
      existing.rows.forEach(row => blocked.set(String(row.old_id), `${index.index_name}:目标已有相同唯一键`));
      const grouped = await client.query(`
        SELECT ${groupSelect}
          FROM ${table} d
          JOIN tmp_instrument_merge_map m ON d.${ident(fkColumn)}=m.old_id
         GROUP BY ${groupKey}
        HAVING COUNT(*)>1`);
      grouped.rows.forEach(row => {
        (row.old_ids || []).forEach(oldId => blocked.set(String(oldId), `${index.index_name}:多个旧记录映射到同一唯一键`));
      });
    }
  }
  if (blocked.size) {
    await client.query('DELETE FROM tmp_instrument_merge_map WHERE old_id = ANY($1::bigint[])', [[...blocked.keys()].map(Number)]);
  }
  return blocked;
}

// company_instruments 是公司与证券的关系表，同一公司、关系类型下的旧/新证券记录
// 语义上是同一条关系。迁移时只删除这类确定重复关系，其他唯一冲突仍全部阻塞。
async function deduplicateCompanyRelations(client) {
  const result = await client.query(`
    DELETE FROM core.company_instruments old
     USING tmp_instrument_merge_map m, core.company_instruments target
    WHERE old.instrument_id=m.old_id
      AND target.instrument_id=m.new_id
      AND target.company_id=old.company_id
      AND target.relation_type=old.relation_type`);
  return result.rowCount || 0;
}

async function applyMappings(client, foreignKeys) {
  let updatedReferences = 0;
  for (const fk of foreignKeys) {
    const result = await client.query(
      `UPDATE ${tableName(fk.table_schema, fk.table_name)} d
          SET ${ident(fk.column_name)}=m.new_id
         FROM tmp_instrument_merge_map m
        WHERE d.${ident(fk.column_name)}=m.old_id`,
    );
    updatedReferences += result.rowCount || 0;
  }
  const instruments = await client.query(`
    UPDATE core.instruments i
       SET status='merged',
           raw_data=i.raw_data || jsonb_build_object('merged_into',m.new_id,'merged_at',now()),
           updated_at=now()
      FROM tmp_instrument_merge_map m
     WHERE i.instrument_id=m.old_id`);
  const candidates = await client.query(`
    UPDATE core.instrument_merge_candidates c
       SET status='migrated',reviewed_at=now(),
           notes=CASE WHEN notes='' THEN 'migrated_to:'||m.new_id::text ELSE notes||';migrated_to:'||m.new_id::text END
      FROM tmp_instrument_merge_map m
     WHERE c.status='candidate' AND c.conflict_count=0
       AND (c.primary_instrument_id=m.old_id OR c.duplicate_instrument_id=m.old_id)`);
  return { updatedReferences, migratedInstruments: instruments.rowCount || 0, migratedCandidates: candidates.rowCount || 0 };
}

async function main() {
  if (APPLY && process.env.NODE_ENV === 'production' && !CONFIRM) {
    throw new Error('生产执行必须同时传入 --confirm-production');
  }
  await runMigrations();
  const client = await pool.connect();
  try {
    const plan = await loadPlan(client);
    const foreignKeys = await loadForeignKeys(client);
    const uniqueIndexes = await loadUniqueIndexes(client, foreignKeys);
    const output = {
      mode: APPLY ? 'apply' : 'dry-run',
      candidate_rows: asNumber(plan.stats.candidate_rows),
      manual_review_rows: asNumber(plan.stats.manual_rows),
      duplicate_groups: asNumber(plan.stats.duplicate_groups),
      unresolved_groups: asNumber(plan.stats.unresolved_groups),
      exact_target_groups: asNumber(plan.stats.exact_target_groups),
      planned_instruments: plan.maps.length,
      blocked_instruments: 0,
      blocked_samples: [],
    };
    await client.query('BEGIN');
    await createTempMap(client, plan.maps);
    output.deduplicated_company_relations = await deduplicateCompanyRelations(client);
    const blocked = await findBlockedMappings(client, foreignKeys, uniqueIndexes);
    output.blocked_instruments = blocked.size;
    output.blocked_reason_counts = [...blocked.values()].reduce((counts, reason) => {
      counts[reason] = (counts[reason] || 0) + 1;
      return counts;
    }, {});
    output.blocked_samples = [...blocked.entries()].slice(0, 20).map(([old_id, reason]) => ({ old_id: Number(old_id), reason }));
    const remaining = await client.query('SELECT COUNT(*)::int AS count FROM tmp_instrument_merge_map');
    output.eligible_instruments = asNumber(remaining.rows[0]?.count);
    if (APPLY) {
      const applied = await applyMappings(client, foreignKeys);
      Object.assign(output, applied);
    }
    await client.query('ROLLBACK');
    if (APPLY) {
      await client.query('BEGIN');
      await createTempMap(client, plan.maps);
      output.deduplicated_company_relations = await deduplicateCompanyRelations(client);
      await findBlockedMappings(client, foreignKeys, uniqueIndexes);
      const applied = await applyMappings(client, foreignKeys);
      Object.assign(output, applied);
      await client.query('COMMIT');
    }
    if (JSON_OUTPUT) console.log(JSON.stringify(output, null, 2));
    else console.log(`历史证券 ID 迁移（${output.mode}）：计划 ${output.planned_instruments} 条，可迁移 ${output.eligible_instruments} 条，阻塞 ${output.blocked_instruments} 条，实际迁移 ${output.migratedInstruments || 0} 条；人工冲突 ${output.manual_review_rows} 条。`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(error => {
  console.error(`历史证券 ID 迁移失败：${error.message}`);
  process.exitCode = 1;
});

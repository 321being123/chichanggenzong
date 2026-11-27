const { pool } = require('../db/connection');

// 数据库存储保留清理仓储：按小批次删除超期未引用原始报文与历史未发布 partial 选股试算运行。

async function deleteExpiredUnreferencedRawRecords({
  datasetCodes,
  retentionDays,
  batchSize = 2000,
  maxBatches = 50,
}, client = pool) {
  let deleted = 0;
  for (let i = 0; i < maxBatches; i++) {
    const result = await client.query(
      `WITH doomed AS (
         SELECT r.raw_record_id
           FROM ops.raw_records r
          WHERE r.dataset_code = ANY($1::text[])
            AND r.ingested_at < now() - make_interval(days => $2)
            AND NOT EXISTS (SELECT 1 FROM fundamental.financial_reports fr WHERE fr.raw_record_id = r.raw_record_id)
            AND NOT EXISTS (SELECT 1 FROM event.documents d WHERE d.raw_record_id = r.raw_record_id)
            AND NOT EXISTS (SELECT 1 FROM market.repo_daily_rates rr WHERE rr.raw_record_id = r.raw_record_id)
            AND NOT EXISTS (SELECT 1 FROM market.instrument_trade_rules tr WHERE tr.raw_record_id = r.raw_record_id)
          LIMIT $3
       )
       DELETE FROM ops.raw_records r
        USING doomed d
        WHERE r.raw_record_id = d.raw_record_id`,
      [datasetCodes, retentionDays, batchSize]
    );
    const count = result.rowCount || 0;
    deleted += count;
    if (count < batchSize) break;
  }
  return deleted;
}

async function deleteStalePartialSelectionRuns({
  retentionDays,
  batchSize = 50,
  maxBatches = 20,
}, client = pool) {
  let deleted = 0;
  for (let i = 0; i < maxBatches; i++) {
    const result = await client.query(
      `WITH doomed AS (
         SELECT r.run_id
           FROM analytics.stock_selection_runs r
          WHERE r.run_kind IN ('daily', 'weekly')
            AND r.quality_status = 'partial'
            AND r.created_at < now() - make_interval(days => $1)
            AND NOT EXISTS (SELECT 1 FROM analytics.stock_selection_publications p WHERE p.run_id = r.run_id)
            AND NOT EXISTS (SELECT 1 FROM analytics.stock_selection_publication_events e
                             WHERE e.from_run_id = r.run_id OR e.to_run_id = r.run_id)
            AND NOT EXISTS (SELECT 1 FROM analytics.stock_selection_backtest_periods bp WHERE bp.run_id = r.run_id)
            AND NOT EXISTS (SELECT 1 FROM analytics.stock_selection_runs r2
                             WHERE r2.supersedes_run_id = r.run_id OR r2.source_daily_run_id = r.run_id)
          LIMIT $2
       )
       DELETE FROM analytics.stock_selection_runs r
        USING doomed d
        WHERE r.run_id = d.run_id`,
      [retentionDays, batchSize]
    );
    const count = result.rowCount || 0;
    deleted += count;
    if (count < batchSize) break;
  }
  return deleted;
}

/**
 * 选股批次分级留存（B3-2，D-3 已获用户授权）：
 * - `weekly` / `quarterly` 正式发布批次永不进本清理；
 * - 任何已发布批次、被发布指针/发布事件/历史回测/其他 run 的 `supersedes_run_id` 或
 *   `source_daily_run_id` 引用的批次一律永久保留（`NOT EXISTS` 逐项反查）；
 * - 过期无引用：非影子 `daily`（默认 30 天）、中间 `personal`（默认 14 天，必须存在同源同主体更新批次）、
 *   `preview` 与影子批次（默认 7 天）。
 * 只按小批次删除，不执行 `VACUUM FULL`；dryRun 只统计不删除。
 */
async function countStaleSelectionRunsByClass({
  dailyRetentionDays,
  personalRetentionDays,
  ephemeralRetentionDays,
}, client = pool) {
  const { rows } = await client.query(
    `WITH doomed AS (
       SELECT 'daily'::text AS class, r.run_id
         FROM analytics.stock_selection_runs r
        WHERE r.run_kind = 'daily' AND r.is_shadow = false
          AND r.created_at < now() - make_interval(days => $1)
          AND r.published_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM analytics.stock_selection_publications p WHERE p.run_id = r.run_id)
          AND NOT EXISTS (SELECT 1 FROM analytics.stock_selection_publication_events e
                           WHERE e.from_run_id = r.run_id OR e.to_run_id = r.run_id)
          AND NOT EXISTS (SELECT 1 FROM analytics.stock_selection_backtest_periods bp WHERE bp.run_id = r.run_id)
          AND NOT EXISTS (SELECT 1 FROM analytics.stock_selection_runs ref
                           WHERE ref.supersedes_run_id = r.run_id OR ref.source_daily_run_id = r.run_id)
       UNION ALL
       SELECT 'ephemeral'::text AS class, r.run_id
         FROM analytics.stock_selection_runs r
        WHERE (r.run_kind = 'preview' OR r.is_shadow = true)
          AND r.created_at < now() - make_interval(days => $3)
          AND r.published_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM analytics.stock_selection_publications p WHERE p.run_id = r.run_id)
          AND NOT EXISTS (SELECT 1 FROM analytics.stock_selection_publication_events e
                           WHERE e.from_run_id = r.run_id OR e.to_run_id = r.run_id)
          AND NOT EXISTS (SELECT 1 FROM analytics.stock_selection_backtest_periods bp WHERE bp.run_id = r.run_id)
          AND NOT EXISTS (SELECT 1 FROM analytics.stock_selection_runs ref
                           WHERE ref.supersedes_run_id = r.run_id OR ref.source_daily_run_id = r.run_id)
       UNION ALL
       SELECT 'personal'::text AS class, r.run_id
         FROM analytics.stock_selection_runs r
        WHERE r.run_kind = 'personal'
          AND r.created_at < now() - make_interval(days => $2)
          AND r.published_at IS NULL
          AND EXISTS (SELECT 1 FROM analytics.stock_selection_runs newer
                       WHERE newer.run_kind = 'personal'
                         AND newer.supersedes_run_id IS NOT DISTINCT FROM r.supersedes_run_id
                         AND COALESCE(newer.owner_subject_id::text, '') = COALESCE(r.owner_subject_id::text, '')
                         AND COALESCE(newer.owner_username, '') = COALESCE(r.owner_username, '')
                         AND (newer.created_at, newer.run_id) > (r.created_at, r.run_id))
          AND NOT EXISTS (SELECT 1 FROM analytics.stock_selection_request_bindings b WHERE b.run_id = r.run_id)
          AND NOT EXISTS (SELECT 1 FROM analytics.stock_selection_publications p WHERE p.run_id = r.run_id)
          AND NOT EXISTS (SELECT 1 FROM analytics.stock_selection_publication_events e
                           WHERE e.from_run_id = r.run_id OR e.to_run_id = r.run_id)
          AND NOT EXISTS (SELECT 1 FROM analytics.stock_selection_backtest_periods bp WHERE bp.run_id = r.run_id)
          AND NOT EXISTS (SELECT 1 FROM analytics.stock_selection_runs ref
                           WHERE ref.supersedes_run_id = r.run_id OR ref.source_daily_run_id = r.run_id)
     )
     SELECT class, COUNT(*)::int AS run_count FROM doomed GROUP BY class`,
    [dailyRetentionDays, personalRetentionDays, ephemeralRetentionDays]
  );
  const counts = { daily: 0, personal: 0, ephemeral: 0 };
  rows.forEach(row => { counts[row.class] = Number(row.run_count || 0); });
  return counts;
}

async function deleteStaleDailySelectionRuns({ retentionDays, batchSize = 50, maxBatches = 20 }, client = pool) {
  let deleted = 0;
  for (let i = 0; i < maxBatches; i++) {
    const result = await client.query(
      `WITH doomed AS (
         SELECT r.run_id
           FROM analytics.stock_selection_runs r
          WHERE r.run_kind = 'daily' AND r.is_shadow = false
            AND r.created_at < now() - make_interval(days => $1)
            AND r.published_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM analytics.stock_selection_publications p WHERE p.run_id = r.run_id)
            AND NOT EXISTS (SELECT 1 FROM analytics.stock_selection_publication_events e
                             WHERE e.from_run_id = r.run_id OR e.to_run_id = r.run_id)
            AND NOT EXISTS (SELECT 1 FROM analytics.stock_selection_backtest_periods bp WHERE bp.run_id = r.run_id)
            AND NOT EXISTS (SELECT 1 FROM analytics.stock_selection_runs ref
                             WHERE ref.supersedes_run_id = r.run_id OR ref.source_daily_run_id = r.run_id)
          LIMIT $2
       )
       DELETE FROM analytics.stock_selection_runs r USING doomed d WHERE r.run_id = d.run_id`,
      [retentionDays, batchSize]
    );
    const count = result.rowCount || 0;
    deleted += count;
    if (count < batchSize) break;
  }
  return deleted;
}

async function deleteStaleEphemeralSelectionRuns({ retentionDays, batchSize = 50, maxBatches = 20 }, client = pool) {
  let deleted = 0;
  for (let i = 0; i < maxBatches; i++) {
    const result = await client.query(
      `WITH doomed AS (
         SELECT r.run_id
           FROM analytics.stock_selection_runs r
          WHERE (r.run_kind = 'preview' OR r.is_shadow = true)
            AND r.created_at < now() - make_interval(days => $1)
            AND r.published_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM analytics.stock_selection_publications p WHERE p.run_id = r.run_id)
            AND NOT EXISTS (SELECT 1 FROM analytics.stock_selection_publication_events e
                             WHERE e.from_run_id = r.run_id OR e.to_run_id = r.run_id)
            AND NOT EXISTS (SELECT 1 FROM analytics.stock_selection_backtest_periods bp WHERE bp.run_id = r.run_id)
            AND NOT EXISTS (SELECT 1 FROM analytics.stock_selection_runs ref
                             WHERE ref.supersedes_run_id = r.run_id OR ref.source_daily_run_id = r.run_id)
          LIMIT $2
       )
       DELETE FROM analytics.stock_selection_runs r USING doomed d WHERE r.run_id = d.run_id`,
      [retentionDays, batchSize]
    );
    const count = result.rowCount || 0;
    deleted += count;
    if (count < batchSize) break;
  }
  return deleted;
}

async function deleteStalePersonalSelectionRuns({ retentionDays, batchSize = 50, maxBatches = 20 }, client = pool) {
  let deleted = 0;
  for (let i = 0; i < maxBatches; i++) {
    const result = await client.query(
      `WITH doomed AS (
         SELECT r.run_id
           FROM analytics.stock_selection_runs r
          WHERE r.run_kind = 'personal'
            AND r.created_at < now() - make_interval(days => $1)
            AND r.published_at IS NULL
            AND EXISTS (SELECT 1 FROM analytics.stock_selection_runs newer
                         WHERE newer.run_kind = 'personal'
                           AND newer.supersedes_run_id IS NOT DISTINCT FROM r.supersedes_run_id
                           AND COALESCE(newer.owner_subject_id::text, '') = COALESCE(r.owner_subject_id::text, '')
                           AND COALESCE(newer.owner_username, '') = COALESCE(r.owner_username, '')
                           AND (newer.created_at, newer.run_id) > (r.created_at, r.run_id))
            AND NOT EXISTS (SELECT 1 FROM analytics.stock_selection_request_bindings b WHERE b.run_id = r.run_id)
            AND NOT EXISTS (SELECT 1 FROM analytics.stock_selection_publications p WHERE p.run_id = r.run_id)
            AND NOT EXISTS (SELECT 1 FROM analytics.stock_selection_publication_events e
                             WHERE e.from_run_id = r.run_id OR e.to_run_id = r.run_id)
            AND NOT EXISTS (SELECT 1 FROM analytics.stock_selection_backtest_periods bp WHERE bp.run_id = r.run_id)
            AND NOT EXISTS (SELECT 1 FROM analytics.stock_selection_runs ref
                             WHERE ref.supersedes_run_id = r.run_id OR ref.source_daily_run_id = r.run_id)
          LIMIT $2
       )
       DELETE FROM analytics.stock_selection_runs r USING doomed d WHERE r.run_id = d.run_id`,
      [retentionDays, batchSize]
    );
    const count = result.rowCount || 0;
    deleted += count;
    if (count < batchSize) break;
  }
  return deleted;
}

async function pruneStaleSelectionRuns({
  dailyRetentionDays,
  personalRetentionDays,
  ephemeralRetentionDays,
  batchSize = 50,
  maxBatches = 20,
  dryRun = false,
}, client = pool) {
  const retentionDays = {
    daily: dailyRetentionDays, personal: personalRetentionDays, ephemeral: ephemeralRetentionDays,
  };
  if (dryRun) {
    const counts = await countStaleSelectionRunsByClass({
      dailyRetentionDays, personalRetentionDays, ephemeralRetentionDays,
    }, client);
    return {
      dryRun: true,
      retentionDays,
      deleted: counts,
      total: counts.daily + counts.personal + counts.ephemeral,
    };
  }
  const daily = await deleteStaleDailySelectionRuns({ retentionDays: dailyRetentionDays, batchSize, maxBatches }, client);
  const personal = await deleteStalePersonalSelectionRuns({ retentionDays: personalRetentionDays, batchSize, maxBatches }, client);
  const ephemeral = await deleteStaleEphemeralSelectionRuns({ retentionDays: ephemeralRetentionDays, batchSize, maxBatches }, client);
  return {
    dryRun: false,
    retentionDays,
    deleted: { daily, personal, ephemeral },
    total: daily + personal + ephemeral,
  };
}

/**
 * 容量三口径（B3-2）：① 候选明细/行的 `pg_column_size`；② 表内死元组与可复用空间；
 * ③ 明确不执行 `VACUUM FULL`（物理文件收缩只由 PostgreSQL 常规 vacuum 复用空间完成）。
 * 只读，不写库、不删行。
 */
async function measureSelectionStorage({ runId = null } = {}, client = pool) {
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS candidate_rows,
            COALESCE(SUM(pg_column_size(c.*)), 0)::bigint AS candidate_row_bytes,
            COALESCE(SUM(pg_column_size(c.detail)), 0)::bigint AS detail_bytes,
            COALESCE(AVG(pg_column_size(c.detail)), 0)::numeric(14,1) AS avg_detail_bytes,
            COALESCE(MAX(pg_column_size(c.detail)), 0)::int AS max_detail_bytes
       FROM analytics.stock_selection_candidates c
      WHERE ($1::bigint IS NULL OR c.run_id = $1)`, [runId]);
  const stats = await client.query(
    `SELECT pg_total_relation_size('analytics.stock_selection_candidates') AS total_bytes,
            pg_relation_size('analytics.stock_selection_candidates') AS heap_bytes,
            s.n_live_tup::bigint AS live_tuples,
            s.n_dead_tup::bigint AS dead_tuples,
            s.last_vacuum, s.last_autovacuum
       FROM pg_stat_user_tables s
      WHERE s.schemaname = 'analytics' AND s.relname = 'stock_selection_candidates'`);
  const row = rows[0] || {};
  const table = stats.rows[0] || {};
  const live = Number(table.live_tuples || 0);
  const dead = Number(table.dead_tuples || 0);
  return {
    runId: runId === null || runId === undefined ? null : Number(runId),
    candidateRows: Number(row.candidate_rows || 0),
    candidateRowBytes: Number(row.candidate_row_bytes || 0),
    detailBytes: Number(row.detail_bytes || 0),
    avgDetailBytes: Number(row.avg_detail_bytes || 0),
    maxDetailBytes: Number(row.max_detail_bytes || 0),
    table: {
      totalBytes: Number(table.total_bytes || 0),
      heapBytes: Number(table.heap_bytes || 0),
      liveTuples: live,
      deadTuples: dead,
      deadTupleRatio: live + dead > 0 ? dead / (live + dead) : null,
      lastVacuum: table.last_vacuum || null,
      lastAutovacuum: table.last_autovacuum || null,
    },
    vacuumFull: false,
    note: '删行只回收表内可复用空间；本能力不安排 VACUUM FULL 整表重写，根盘物理余量需另行只读核对。',
  };
}

module.exports = {
  deleteExpiredUnreferencedRawRecords,
  deleteStalePartialSelectionRuns,
  countStaleSelectionRunsByClass,
  pruneStaleSelectionRuns,
  measureSelectionStorage,
};

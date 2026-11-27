#!/usr/bin/env node
'use strict';
/**
 * 阶段 4：存量冗余 analytics.stock_selection_candidates 清理（方案第 7 章）。
 *
 * 只删除历史 daily / weekly（可选 quarterly / personal）批次中「未入选 portfolio_members」的被淘汰行；
 * 每期入选的 ≤30 行 candidates 与全部 portfolio_members 必须 100% 保留。
 *
 * 安全边界：
 * - 默认 dry-run：只打印可删除行数、保留行数与关联 run 数，不写库。
 * - 真正删除必须显式 --execute；NODE_ENV=production 时还必须 --allow-production。
 * - 清理后强制完整性校验：portfolio_members LEFT JOIN candidates 的断链数必须为 0。
 * - 不执行 CREATE EXTENSION；物理空间回收（VACUUM FULL / 精简表原子交换）由运维窗口独立执行。
 *
 * 示例：
 *   node server/scripts/pruneSelectionCandidates.js
 *   node server/scripts/pruneSelectionCandidates.js --execute --include-kinds=daily,weekly
 *   node server/scripts/pruneSelectionCandidates.js --execute --allow-production
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { pool } = require('../db/connection');

const DEFAULT_KINDS = Object.freeze(['daily', 'weekly']);
const ALLOWED_KINDS = Object.freeze(['daily', 'weekly', 'quarterly', 'personal']);
const DEFAULT_BATCH_SIZE = 25;

function parseArgs(argv) {
  const options = { execute: false, allowProduction: false, kinds: [...DEFAULT_KINDS], batchSize: DEFAULT_BATCH_SIZE };
  for (const arg of argv) {
    if (arg === '--execute') options.execute = true;
    else if (arg === '--dry-run') options.execute = false;
    else if (arg === '--allow-production') options.allowProduction = true;
    else if (arg.startsWith('--include-kinds=')) {
      const kinds = arg.split('=')[1].split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
      if (!kinds.length) throw new Error('--include-kinds 不能为空');
      const invalid = kinds.filter(kind => !ALLOWED_KINDS.includes(kind));
      if (invalid.length) throw new Error(`--include-kinds 含不支持的批次类型：${invalid.join(',')}`);
      options.kinds = [...new Set(kinds)];
    } else if (arg.startsWith('--batch-size=')) {
      const size = Number(arg.split('=')[1]);
      if (!Number.isInteger(size) || size <= 0) throw new Error('--batch-size 必须是正整数');
      options.batchSize = size;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return options;
}

// 唯一的删除口径：候选行所在 run 的同一 instrument_id 不在 portfolio_members 中（被淘汰）。
const PRUNABLE_PREDICATE = `NOT EXISTS (
  SELECT 1 FROM analytics.stock_selection_portfolio_members m
   WHERE m.run_id = c.run_id AND m.instrument_id = c.instrument_id
)`;

async function listRuns(kinds, client = pool) {
  const { rows } = await client.query(
    `SELECT run_id, run_kind, market, as_of_date::text AS as_of_date
       FROM analytics.stock_selection_runs
      WHERE run_kind = ANY($1::text[])
      ORDER BY as_of_date ASC, run_id ASC`,
    [kinds],
  );
  return rows.map(row => ({ ...row, run_id: Number(row.run_id) }));
}

async function summarize(runs, client = pool) {
  const runIds = runs.map(row => row.run_id);
  if (!runIds.length) return { runCount: 0, pruneRows: 0, keepRows: 0 };
  const { rows } = await client.query(
    `SELECT
        COUNT(*) FILTER (WHERE ${PRUNABLE_PREDICATE})::int AS prune_rows,
        COUNT(*) FILTER (WHERE NOT ${PRUNABLE_PREDICATE})::int AS keep_rows
       FROM analytics.stock_selection_candidates c
      WHERE c.run_id = ANY($1::bigint[])`,
    [runIds],
  );
  return {
    runCount: runIds.length,
    pruneRows: Number(rows[0] && rows[0].prune_rows || 0),
    keepRows: Number(rows[0] && rows[0].keep_rows || 0),
  };
}

// portfolio_members 每行都必须能在 candidates 中找到同一 (run_id, instrument_id)；
// 断链数 > 0 说明清理越界，必须立即停止并人工核对。
async function brokenMemberCount(client = pool) {
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS broken
       FROM analytics.stock_selection_portfolio_members m
       LEFT JOIN analytics.stock_selection_candidates c
         ON c.run_id = m.run_id AND c.instrument_id = m.instrument_id
      WHERE c.run_id IS NULL`,
  );
  return Number(rows[0] && rows[0].broken || 0);
}

async function pruneRuns(runs, batchSize, client = pool) {
  let deleted = 0;
  let batches = 0;
  for (let offset = 0; offset < runs.length; offset += batchSize) {
    const batch = runs.slice(offset, offset + batchSize).map(row => row.run_id);
    const tx = await client.connect();
    try {
      await tx.query('BEGIN');
      const result = await tx.query(
        `DELETE FROM analytics.stock_selection_candidates c
          WHERE c.run_id = ANY($1::bigint[]) AND ${PRUNABLE_PREDICATE}`,
        [batch],
      );
      await tx.query('COMMIT');
      deleted += Number(result.rowCount || 0);
      batches += 1;
      console.log(`[prune] 批次 ${batches}：run ${batch.length} 个，删除 ${result.rowCount} 行`);
    } catch (error) {
      await tx.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      tx.release();
    }
  }
  return { deleted, batches };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log([
      '用法：node server/scripts/pruneSelectionCandidates.js [--execute] [--allow-production]',
      '      [--include-kinds=daily,weekly,quarterly,personal] [--batch-size=25]',
      '默认 dry-run，只打印统计；真正删除需要 --execute；NODE_ENV=production 还需要 --allow-production。',
    ].join('\n'));
    return 0;
  }
  if (options.execute && String(process.env.NODE_ENV || '').toLowerCase() === 'production' && !options.allowProduction) {
    throw new Error('生产环境清理必须显式传 --allow-production（需用户单独书面授权）');
  }
  const before = await brokenMemberCount();
  if (before > 0) {
    console.error(`[prune] 中止：清理前已存在 ${before} 条 portfolio_members 断链，先修复数据完整性问题。`);
    return 3;
  }
  const runs = await listRuns(options.kinds);
  const summary = await summarize(runs);
  console.log(`[prune] 批次类型：${options.kinds.join(',')}；关联 run：${summary.runCount}；`
    + `可删除被淘汰行：${summary.pruneRows}；保留入选行：${summary.keepRows}`);
  if (!options.execute) {
    console.log('[prune] dry-run：未写库。确认无误后追加 --execute 执行删除。');
    return 0;
  }
  if (!summary.pruneRows) {
    console.log('[prune] 没有可删除的冗余候选行，跳过写库。');
    return 0;
  }
  const result = await pruneRuns(runs, options.batchSize);
  console.log(`[prune] 完成：${result.batches} 个批次，共删除 ${result.deleted} 行。`);
  const after = await brokenMemberCount();
  if (after !== 0) {
    console.error(`[prune] 完整性校验失败：portfolio_members JOIN candidates 断链 ${after} 条（期望 0），请立即人工核对。`);
    return 2;
  }
  console.log('[prune] 完整性校验通过：portfolio_members JOIN candidates 断链 0 条。');
  console.log('[prune] 物理空间回收（VACUUM FULL / 精简表原子交换）请在运维窗口独立执行，本脚本不执行 CREATE EXTENSION。');
  return 0;
}

if (require.main === module) {
  main()
    .then(code => { process.exitCode = code; })
    .catch(error => {
      console.error('[prune] 执行失败：', error && error.message || error);
      process.exitCode = 1;
    })
    .finally(() => pool.end().catch(() => {}));
}

module.exports = { main, parseArgs, PRUNABLE_PREDICATE, brokenMemberCount, summarize };

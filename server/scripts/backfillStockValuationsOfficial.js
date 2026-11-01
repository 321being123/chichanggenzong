#!/usr/bin/env node
// 全市场逐只估值的历史段改用理杏仁官方口径（market.daily_valuations）。
//
// 背景：`daily_valuations` 的官方行目前只有转债正股任务落的那一批（生产 2026-10-29 共 5570 行），
// 更早的日期全部是 Tushare 写入——读取端虽然已经「官方优先」，但官方不存在时仍会读到旧来源数值。
// 本脚本按证券把官方区间估值补进来，让历史日期也有官方行。
//
// 关键约束（不能省）：
//   1. **只补现有分区已有 (证券, 交易日)**：不新增日期分区。加了日期会连带改变
//      「全市场总市值按日聚合」「M2 市值比月末采样」等下游口径，那是另一件事。
//   2. **只回官方、不回落备源**：官方没数据就是没数据，不得把 Tushare 的值按官方名义写入。
//   3. **不删旧行**：读取端已按「官方优先」择一，旧行保留可回溯；要清理另立任务。
//   4. 官方区间接口有 ≤10 年跨度限制，适配层已按段自动拆分，本脚本传整段即可。
//
// 用法：
//   node server/scripts/backfillStockValuationsOfficial.js                     预演（1 批抽样实取，其余只统计）
//   node server/scripts/backfillStockValuationsOfficial.js --apply             全量写入
//   node server/scripts/backfillStockValuationsOfficial.js --since=2025-01-01  只处理该区间
//   node server/scripts/backfillStockValuationsOfficial.js --offset=200 --limit-codes=200   断点续跑/分批
'use strict';

const { pool } = require('../db/connection');
const { readStockValuationSeriesBatch } = require('../dataAccess/marketDatasets');
const store = require('../services/convertibleBondAnalysisStore');

const APPLY = process.argv.includes('--apply');
const withDefault = (name, fallback) => {
  const hit = process.argv.find(arg => arg.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
};
const SINCE = withDefault('since', '1991-01-01');
const UNTIL = withDefault('until', '2099-12-31');
const OFFSET = Math.max(Number(withDefault('offset', '0')) || 0, 0);
const LIMIT_CODES = Math.max(Number(withDefault('limit-codes', '0')) || 0, 0);
const SAMPLE_BATCHES = Math.max(Number(withDefault('sample', '1')) || 0, 0);
const CHUNK = 100; // 官方 stockCodes 一次最多 100 个

const chunk = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};
const key = (instrumentId, day) => `${instrumentId}|${day}`;

async function officialSourceId() {
  const { rows } = await pool.query("SELECT source_id FROM ops.data_sources WHERE source_code='lixinger_official'");
  if (!rows[0]) throw new Error('未登记来源 lixinger_official，无法回填');
  return rows[0].source_id;
}

// 候选：在目标区间内仍有 Tushare 行的证券（官方行已存在也无妨，写库是 upsert 幂等）。
async function listTargets() {
  const { rows } = await pool.query(
    `SELECT DISTINCT v.instrument_id, i.canonical_code
       FROM market.daily_valuations v
       JOIN core.instruments i ON i.instrument_id = v.instrument_id
       JOIN ops.data_sources s ON s.source_id = v.source_id
      WHERE s.source_code = 'tushare' AND v.trade_date BETWEEN $1::date AND $2::date
      ORDER BY v.instrument_id`,
    [SINCE, UNTIL],
  );
  return rows;
}

// 该批已有的分区键与日期范围：只保留落在其中的 (证券, 交易日)，不扩日期。
async function loadExistingPartitions(instrumentIds) {
  const { rows } = await pool.query(
    `SELECT v.instrument_id, v.trade_date::text AS day, s.source_code
       FROM market.daily_valuations v
       JOIN ops.data_sources s ON s.source_id = v.source_id
      WHERE v.instrument_id = ANY($1::bigint[]) AND v.trade_date BETWEEN $2::date AND $3::date`,
    [instrumentIds, SINCE, UNTIL],
  );
  const targets = new Set();
  const covered = new Set();
  let first = null;
  let last = null;
  for (const row of rows) {
    if (row.source_code === 'tushare') {
      targets.add(key(row.instrument_id, row.day));
      if (!first || row.day < first) first = row.day;
      if (!last || row.day > last) last = row.day;
    } else if (row.source_code === 'lixinger_official') {
      covered.add(key(row.instrument_id, row.day));
    }
  }
  return { targets, covered, first, last };
}

async function main() {
  const sourceId = await officialSourceId();
  const all = await listTargets();
  const sliced = LIMIT_CODES ? all.slice(OFFSET, OFFSET + LIMIT_CODES) : all.slice(OFFSET);
  console.log(`${APPLY ? '实际写入' : '只读预演'}；区间 ${SINCE} ~ ${UNTIL}；候选证券 ${all.length} 只，本次处理 ${sliced.length} 只（offset=${OFFSET}${LIMIT_CODES ? `, limit=${LIMIT_CODES}` : ''}）`);

  const batches = chunk(sliced, CHUNK);
  console.log(`分批 ${batches.length} 批（每批 ${CHUNK} 只）；预计官方请求 ${batches.length} 批 × 每批按 ≤10 年分段数`);

  let writtenRows = 0;
  let skippedCovered = 0;
  let fetchedRows = 0;
  let processedBatches = 0;
  let emptyBatches = 0;
  const startedAt = Date.now();

  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    const ids = batch.map(item => item.instrument_id);
    const { targets, covered, first, last } = await loadExistingPartitions(ids);
    if (!targets.size) {
      console.log(`[${index + 1}/${batches.length}] 无 Tushare 分区，跳过`);
      continue;
    }
    // 预演只抽样前 N 批真正发请求，其余仅统计，避免为了看一眼花掉整轮额度。
    if (!APPLY && processedBatches >= SAMPLE_BATCHES) continue;

    const instrumentMap = new Map(batch.map(item => [item.canonical_code, item.instrument_id]));
    const rows = await readStockValuationSeriesBatch({
      codes: batch.map(item => item.canonical_code),
      startDate: first,
      endDate: last,
    });
    fetchedRows += rows.length;
    // 官方返回空但该批确实有目标分区：不能当成「没有数据」静默过去（数据层包装会吞异常），
    // 记为可疑批次，最后汇总时非零退出，交给人工判断是权限、额度还是真实无值。
    if (!rows.length) emptyBatches += 1;

    const keep = [];
    let coveredHit = 0;
    for (const row of rows) {
      const instrumentId = instrumentMap.get(row.ts_code);
      const day = String(row.trade_date || '').slice(0, 10);
      if (!instrumentId || !targets.has(key(instrumentId, day))) continue;
      if (covered.has(key(instrumentId, day))) { coveredHit += 1; continue; }
      keep.push(row);
    }
    skippedCovered += coveredHit;

    if (!APPLY) {
      const sample = keep.slice(0, 3).map(row => `${row.ts_code} ${row.trade_date} pe_ttm=${row.pe_ttm} total_mv=${row.total_mv}`);
      console.log(`[${index + 1}/${batches.length}] 抽样：官方返回 ${rows.length} 行，命中现有分区 ${keep.length} 行（已有官方 ${coveredHit} 行跳过）`);
      sample.forEach(line => console.log(`    ${line}`));
      processedBatches += 1;
      continue;
    }

    if (keep.length) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await store.saveFullStockMarketPartition(client, instrumentMap, [], keep, sourceId);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
      writtenRows += keep.length;
    }
    processedBatches += 1;
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`[${index + 1}/${batches.length}] 官方 ${rows.length} 行 → 写入 ${keep.length} 行（跳过已有官方 ${coveredHit}）累计 ${writtenRows} 行，用时 ${elapsed}s`);
  }

  console.log(`\n汇总：处理批次 ${processedBatches}/${batches.length}，官方返回 ${fetchedRows} 行，${APPLY ? `写入 ${writtenRows} 行` : '未写库（预演）'}，已有官方跳过 ${skippedCovered} 行`);
  if (emptyBatches) console.warn(`⚠️ 有 ${emptyBatches} 批官方返回 0 行（该批存在目标分区），可能是权限/额度或区间无效，需人工核对，不能当作「本来就没有数据」`);
  if (!APPLY) console.log('预演结束：只抽样实取了前若干批，未写库。加 --apply 才全量写入。');
  await pool.end();
  if (APPLY && emptyBatches) process.exit(2);
}

main().catch(async error => {
  console.error('回填失败：', error && error.message ? error.message : error);
  try { await pool.end(); } catch (_) { /* 已关闭 */ }
  process.exit(1);
});

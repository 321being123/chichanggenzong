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
//   node server/scripts/backfillStockValuationsOfficial.js                     预演（按需范围，抽样 1 批实取）
//   node server/scripts/backfillStockValuationsOfficial.js --apply             按需范围全量写入
//   node server/scripts/backfillStockValuationsOfficial.js --scope=all --apply  全市场（谨慎：59.7 万行）
//   node server/scripts/backfillStockValuationsOfficial.js --since=2025-06-19  只处理该区间（转债分析回看 500 天）
//   node server/scripts/backfillStockValuationsOfficial.js --offset=200 --limit-codes=200   断点续跑/分批
'use strict';

const { pool } = require('../db/connection');
const { readStockValuationSeriesBatch } = require('../dataAccess/marketDatasets');
const store = require('../services/convertibleBondAnalysisStore');
const { resolveCanonicalCode } = require('../services/securityIdentity');

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
// 默认只补「有人看的」证券：当前仍在交易的上市可转债正股 ∪ 持仓 ∪ 自选 ∪ 已分析过。全市场要显式 --scope=all。
// 理由：daily_valuations 的历史行只有两处按天回看——个股分析（读全部历史）与转债分析（回看 500 天）；
// 其余消费方（债券安全性、转债列表、下修服务、全市场总市值）只要当日或最近一条，补历史对它们没有增量。
// 转债口径：`bond_unified.status='listed'` 不可靠（生产列出 1080 只，历史摘牌的没更新状态），
// 用户要求只算「当前上市的」——以最近交易日仍有转债行情为准（生产 2026-10-30 实测 311 只）。
const SCOPE = withDefault('scope', 'watched');
const CHUNK = 100; // 官方 stockCodes 一次最多 100 个

// 持仓/自选的代码是无后缀格式（生产实测 105 行持仓全部如此，且混着 5 位港股代码），
// 直接和 canonical_code 做字符串匹配会 0 命中或跨市场误配（000001 既像 A 股也像港股）。
// 统一走 securityIdentity 归一，再把结果作为参数传进 SQL，不猜后缀。
async function watchedCodes() {
  const { rows } = await pool.query(`
    SELECT DISTINCT code FROM public.positions WHERE code IS NOT NULL
    UNION SELECT DISTINCT ts_code FROM public.stock_watchlist WHERE ts_code IS NOT NULL`);
  const out = [];
  let unresolved = 0;
  for (const row of rows) {
    const raw = row.code || row.ts_code;
    try {
      const canonical = await resolveCanonicalCode(raw, 'stock');
      if (canonical) out.push(canonical); else unresolved += 1;
    } catch (_) { unresolved += 1; }
  }
  if (unresolved) console.log(`持仓/自选中 ${unresolved} 个代码未能解析成标准代码（多为港股或无对应证券），已跳过`);
  return out;
}

const WATCHED_SCOPE_SQL = `
  WITH active_cb AS (
    SELECT DISTINCT b.instrument_id
      FROM market.daily_bars b
      JOIN core.instruments i ON i.instrument_id = b.instrument_id AND i.asset_class = 'convertible_bond'
     WHERE b.trade_date = (
       SELECT max(v.trade_date) FROM market.daily_bars v
         JOIN core.instruments j ON j.instrument_id = v.instrument_id AND j.asset_class = 'convertible_bond')
  ), scope AS (
    SELECT si.canonical_code AS c
      FROM active_cb a
      JOIN fundamental.convertible_bond_profiles p ON p.instrument_id = a.instrument_id
      JOIN core.instruments si ON si.instrument_id = p.stock_instrument_id
    UNION SELECT i.canonical_code FROM analytics.stock_overview_latest l
            JOIN core.instruments i ON i.instrument_id = l.instrument_id
    UNION SELECT unnest($3::text[])
  )
  SELECT DISTINCT v.instrument_id, i.canonical_code
    FROM market.daily_valuations v
    JOIN core.instruments i ON i.instrument_id = v.instrument_id
    JOIN ops.data_sources s ON s.source_id = v.source_id
    JOIN scope ON scope.c = i.canonical_code
   WHERE s.source_code = 'tushare' AND v.trade_date BETWEEN $1::date AND $2::date
   ORDER BY v.instrument_id`;

const ALL_SCOPE_SQL = `
  SELECT DISTINCT v.instrument_id, i.canonical_code
    FROM market.daily_valuations v
    JOIN core.instruments i ON i.instrument_id = v.instrument_id
    JOIN ops.data_sources s ON s.source_id = v.source_id
   WHERE s.source_code = 'tushare' AND v.trade_date BETWEEN $1::date AND $2::date
   ORDER BY v.instrument_id`;

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
// scope=watched（默认）只取「转债正股 ∪ 持仓 ∪ 自选 ∪ 已分析过」；scope=all 取全市场。
async function listTargets() {
  if (SCOPE !== 'watched' && SCOPE !== 'all') {
    throw new Error(`未知 scope：${SCOPE}（可选 watched / all）`);
  }
  const sql = SCOPE === 'watched' ? WATCHED_SCOPE_SQL : ALL_SCOPE_SQL;
  const params = [SINCE, UNTIL];
  if (SCOPE === 'watched') params.push(await watchedCodes());
  const { rows } = await pool.query(sql, params);
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
  console.log(`${APPLY ? '实际写入' : '只读预演'}；范围 ${SCOPE === 'watched' ? '按需（上市转债正股∪持仓∪自选∪已分析）' : '全市场'}；区间 ${SINCE} ~ ${UNTIL}；候选证券 ${all.length} 只，本次处理 ${sliced.length} 只（offset=${OFFSET}${LIMIT_CODES ? `, limit=${LIMIT_CODES}` : ''}）`);

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
      // 适配层返回的日期是 YYYYMMDD（无横线），分区键是 YYYY-MM-DD：不归一化会一条都对不上，
      // 表现成「官方有数据但命中 0 行」（2026-11-01 生产预演实测）。
      const digits = String(row.trade_date || '').replace(/-/g, '').slice(0, 8);
      const day = /^\d{8}$/.test(digits) ? `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}` : null;
      if (!instrumentId || !day || !targets.has(key(instrumentId, day))) continue;
      if (covered.has(key(instrumentId, day))) { coveredHit += 1; continue; }
      keep.push({ ...row, trade_date: day });
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

#!/usr/bin/env node
// 指数估值切换：沪深300（000300）与恒生指数（HSI）整段改用理杏仁官方市值加权口径。
//
// 背景：这两个指数的估值原先分别来自 Tushare `index_dailybasic`（沪深300）与
// 恒指官网文件 / 手工加权 CSV（恒指），而官方接口现在都能取到。两种来源的算法不同
// （官方 mcw＝个股 PE 按市值加权平均，旧来源是整体法或另一口径），同一指标掺着两条
// 来源会让趋势与分位漂移，所以本脚本按「整段替换」处理：先回填官方全历史，再删除被
// 官方覆盖到的旧口径行，最后重算受影响的格雷厄姆指数。
//
// 用法：
//   node server/scripts/backfillIndexValuationOfficial.js               预演（只读，不写库）
//   node server/scripts/backfillIndexValuationOfficial.js --apply       执行
//   node server/scripts/backfillIndexValuationOfficial.js --only=CSI300 只处理沪深300
//   node server/scripts/backfillIndexValuationOfficial.js --keep-legacy 回填但不删旧口径行
'use strict';
const { pool } = require('../db/connection');
const marketYieldRepository = require('../repositories/marketYieldRepository');
const marketVolatilitySync = require('../jobs/marketVolatilitySync');

const APPLY = process.argv.includes('--apply');
const KEEP_LEGACY = process.argv.includes('--keep-legacy');
const ONLY = (process.argv.find(arg => arg.startsWith('--only=')) || '').split('=')[1] || null;
const CHUNK_YEARS = 5;

const TARGETS = [
  {
    benchmark: 'CSI300', indexCode: '000300', since: '2005-04-01', market: 'cn',
    legacyTables: [
      // 沪深300 估值只有 Tushare 一条旧来源；官方覆盖自指数发布日 2005-04-08 起，与旧来源同日对齐。
      { table: 'index_valuation_history', predicate: alias => `${alias}.index_code='CSI300'`, sources: ['tushare_index_dailybasic'] },
    ],
  },
  {
    benchmark: 'HSI', indexCode: 'HSI', since: '2000-01-01', market: 'hk',
    legacyTables: [
      // 恒指旧来源两套：手工加权 CSV（与官方 mcw 同日数值一致）与恒指官网文件（整体法，比官方高 7%~27%）。
      { table: 'index_valuation_history', predicate: alias => `${alias}.index_code='HSI'`, sources: ['hsi_official', 'user_supplied_weighted_csv'] },
      { table: 'market_valuation_daily', predicate: alias => `${alias}.market_code='HK' AND ${alias}.benchmark_code='HSI'`, sources: ['hsi_official', 'hsi_weighted_manual'] },
    ],
  },
];

const dateStr = d => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(d);

function chunks(since, end, years = CHUNK_YEARS) {
  const out = [];
  let startYear = Number(since.slice(0, 4));
  const endYear = Number(end.slice(0, 4));
  let cursor = since;
  while (startYear <= endYear) {
    const lastYear = Math.min(endYear, startYear + years - 1);
    out.push([cursor, lastYear === endYear ? end : `${lastYear}-12-31`]);
    startYear = lastYear + 1;
    cursor = `${startYear}-01-01`;
  }
  return out;
}

async function sourceStats(table, predicate) {
  const { rows } = await pool.query(
    `SELECT t.source_code, count(*)::int AS n, min(t.trade_date)::text AS mn, max(t.trade_date)::text AS mx
       FROM market.${table} t WHERE ${predicate('t')} GROUP BY t.source_code ORDER BY t.source_code`);
  return rows;
}

async function main() {
  const today = dateStr(new Date());
  const targets = TARGETS.filter(t => !ONLY || t.benchmark === ONLY);
  if (!targets.length) throw new Error(`--only 只支持 ${TARGETS.map(t => t.benchmark).join('/')}`);

  console.log(`模式：${APPLY ? '执行（会写库）' : '预演（只读）'}${KEEP_LEGACY ? '、保留旧口径行' : ''}`);
  for (const target of targets) {
    console.log(`\n=== ${target.benchmark}（${target.indexCode}，请求起点 ${target.since}）===`);
    for (const spec of target.legacyTables) {
      console.log(`  ${spec.table} 现有来源:`, JSON.stringify(await sourceStats(spec.table, spec.predicate)));
    }
    if (!APPLY) continue;

    // 1) 回填官方全历史（5 年一段：官方单次区间过长会返回空）
    const { readIndexValuationSeries } = require('../dataAccess/marketDatasets');
    let written = 0;
    for (const [start, end] of chunks(target.since, today)) {
      const rows = await readIndexValuationSeries({
        indexCode: target.indexCode, market: target.market, startDate: start, endDate: end, allowFallback: false,
      });
      const kept = (rows || []).filter(row => row.day && row.pe > 0);
      if (!kept.length) { console.log(`  ${start}~${end} 官方无数据，跳过`); continue; }
      if (target.benchmark === 'HSI') {
        for (const row of kept) {
          await marketYieldRepository.saveHsiMarketValuation(row.day, row.pe, row.raw, 'lixinger_official');
          await marketYieldRepository.saveHsiIndexHistory(row.day, row.pe, row.raw, 'lixinger_official');
        }
      } else {
        await marketYieldRepository.saveCsi300Valuations(kept);
      }
      written += kept.length;
      console.log(`  ${start}~${end} 写入 ${kept.length} 条`);
    }
    console.log(`  回填合计 ${written} 条`);
    for (const spec of target.legacyTables) {
      console.log(`  ${spec.table} 回填后来源:`, JSON.stringify(await sourceStats(spec.table, spec.predicate)));
    }

    // 2) 删除「官方已有同日数据」的旧口径行：只删被覆盖的日期，官方没有的日期保留，
    //    残留会打印出来交人工判断，不做静默抹除。
    if (!KEEP_LEGACY) {
      for (const spec of target.legacyTables) {
        const del = await pool.query(
          `DELETE FROM market.${spec.table} t
            WHERE ${spec.predicate('t')} AND t.source_code = ANY($1)
              AND EXISTS (SELECT 1 FROM market.${spec.table} o
                           WHERE ${spec.predicate('o')} AND o.trade_date = t.trade_date
                             AND o.source_code = 'lixinger_official')`, [spec.sources]);
        console.log(`  ${spec.table} 删除被官方覆盖的旧口径行 ${del.rowCount || 0} 条`);
        const left = await pool.query(
          `SELECT t.source_code, count(*)::int AS n, min(t.trade_date)::text AS mn, max(t.trade_date)::text AS mx
             FROM market.${spec.table} t WHERE ${spec.predicate('t')} AND t.source_code = ANY($1) GROUP BY t.source_code`,
          [spec.sources]);
        if (left.rows.length) console.log(`  ${spec.table} 仍保留的旧口径行（官方无同日数据）:`, JSON.stringify(left.rows));
      }
    }
  }

  if (!APPLY) {
    console.log('\n预演结束：未写库、未删行、未重算。加 --apply 执行。');
    await pool.end();
    return;
  }

  // 3) 格雷厄姆指数整段重算（恒指用美股 10 年期做无风险利率，实际从 2012 年起）
  const recalculated = await marketVolatilitySync.calculateGraham(pool, '2000-01-01');
  console.log(`\n格雷厄姆重算：${recalculated} 条`);
  const { rows: summary } = await pool.query(
    `SELECT benchmark_code, count(*)::int AS n, min(trade_date)::text AS mn, max(trade_date)::text AS mx,
            round(max(pe), 4) AS max_pe
       FROM analytics.graham_index_daily GROUP BY 1 ORDER BY 1`);
  console.log('格雷厄姆现况:', JSON.stringify(summary));
  await pool.end();
}

main().catch(async error => {
  console.error('执行失败：', error && error.message);
  try { await pool.end(); } catch (_) { /* ignore */ }
  process.exit(1);
});

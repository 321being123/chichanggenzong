// 一次性回填：中证系指数 PE 改用理杏仁官方「总市值加权」口径（--benchmark 选基准）。
//
// 背景：`market.market_valuation_daily` 里这些基准原本只有中证指数官网（csindex，整体法：
// Σ总市值 ÷ Σ净利润）一条序列；理杏仁 `cn/index/fundamental` 的 `pe_ttm.mcw` 是页面上的
// 「总市值加权」。两者同一天数值不同且差距随时间变化（CSIALL 2011 −17.6% → 2026-08 +18.7%），
// 所以换源不是平移，必须整段替换并按新序列重算格雷厄姆指数（analytics.graham_index_daily）。
//
// 用法：
//   node server/scripts/backfillCsiAllPeOfficial.js                              # CSIALL 只打印计划（默认只读）
//   node server/scripts/backfillCsiAllPeOfficial.js --apply                      # CSIALL 真正写入
//   node server/scripts/backfillCsiAllPeOfficial.js --benchmark=CSI300           # 沪深300 只读预演
//   node server/scripts/backfillCsiAllPeOfficial.js --benchmark=CSI300 --apply   # 沪深300 真正写入
//
// 参数：--benchmark=CSIALL（默认）|CSI300；--since=YYYY-MM-DD（默认按基准起点）；--keep-before（保留起点前的旧行）
const { pool } = require('../db/connection');

const APPLY = process.argv.includes('--apply');
const BENCHMARK = (process.argv.find(arg => arg.startsWith('--benchmark=')) || '--benchmark=CSIALL').split('=')[1];

// 起点必须与 marketVolatilitySync.CSI_OFFICIAL_PE_SINCE 一致，否则回填与日常增量会互相打架。
const BENCHMARKS = Object.freeze({
  CSIALL: { indexCode: '000985', since: '2011-08-01' },
  CSI300: { indexCode: '000300', since: '2005-04-08' },
});
const TARGET = BENCHMARKS[BENCHMARK];
if (!TARGET) {
  console.error(`未知基准：${BENCHMARK}（可选 ${Object.keys(BENCHMARKS).join(' / ')}）`);
  process.exit(1);
}
const { indexCode: INDEX_CODE } = TARGET;
const SINCE = (process.argv.find(arg => arg.startsWith('--since=')) || `--since=${TARGET.since}`).split('=')[1];
const KEEP_BEFORE = process.argv.includes('--keep-before');

async function summary(label) {
  const bySource = await pool.query(`SELECT source_code, count(*)::int AS n, min(trade_date)::text AS first, max(trade_date)::text AS last
    FROM market.market_valuation_daily WHERE market_code='CN' AND benchmark_code=$1 GROUP BY 1 ORDER BY 1`, [BENCHMARK]);
  console.log(`\n[${label}] ${BENCHMARK} 分来源：`);
  for (const row of bySource.rows) console.log(`  ${row.source_code.padEnd(20)} ${String(row.n).padStart(5)} 行  ${row.first} ~ ${row.last}`);
  const samples = await pool.query(`SELECT trade_date::text AS d, source_code, round(pe, 2) AS pe
    FROM market.market_valuation_daily WHERE market_code='CN' AND benchmark_code=$1
      AND trade_date IN ('2005-04-08','2011-08-02','2015-01-05','2020-01-02','2025-01-02','2026-08-18',(SELECT max(trade_date) FROM market.market_valuation_daily WHERE market_code='CN' AND benchmark_code=$1))
    ORDER BY trade_date, source_code`, [BENCHMARK]);
  console.log(`[${label}] 抽样：`);
  for (const row of samples.rows) console.log(`  ${row.d}  ${row.source_code.padEnd(20)} ${row.pe}`);
  const graham = await pool.query(`SELECT trade_date::text AS d, round(pe, 2) AS pe, round(graham_index_pct, 3) AS graham
    FROM analytics.graham_index_daily WHERE market_code='CN' AND benchmark_code=$1
    ORDER BY trade_date DESC LIMIT 3`, [BENCHMARK]);
  console.log(`[${label}] 格雷厄姆最近 3 行：`);
  for (const row of graham.rows) console.log(`  ${row.d}  pe=${row.pe}  graham=${row.graham}`);
}

(async () => {
  console.log(`${BENCHMARK} 换源：${APPLY ? '实际写入' : '只读预演（加 --apply 才写）'}；官方指数 ${INDEX_CODE}；起点 ${SINCE}；${KEEP_BEFORE ? '保留起点前旧行' : '删除起点前旧行'}`);
  await summary('切换前');

  if (!APPLY) {
    const pre = await pool.query(`SELECT count(*)::int AS n FROM market.market_valuation_daily
      WHERE market_code='CN' AND benchmark_code=$1 AND source_code='csindex'`, [BENCHMARK]);
    const preGraham = await pool.query(`SELECT count(*)::int AS n FROM analytics.graham_index_daily
      WHERE market_code='CN' AND benchmark_code=$1 AND trade_date < $2::date`, [BENCHMARK, SINCE]);
    console.log(`\n${BENCHMARK} 的中证(csindex)旧行：${pre.rows[0].n} 条（预演：会被全部删除）、起点前格雷厄姆旧行：${preGraham.rows[0].n} 条`);
    console.log('\n预演结束：未调用外部接口、未写库。');
    await pool.end();
    return;
  }

  const marketVolatilitySync = require('../jobs/marketVolatilitySync');
  const written = await marketVolatilitySync.syncCsiPeFromOfficial(BENCHMARK, INDEX_CODE, { fullSince: SINCE });
  console.log(`\n官方口径写入：${written} 条`);

  // 中证（整体法）与官方（总市值加权）不是同一算法，掺在一条序列里会失真：
  // 该基准的中证旧行全部删除，只留官方；官方首日之前的格雷厄姆行同时清掉，序列从官方首日算起。
  if (!KEEP_BEFORE) {
    const firstOfficial = await pool.query(`SELECT min(trade_date)::text AS d FROM market.market_valuation_daily
      WHERE market_code='CN' AND benchmark_code=$1 AND source_code='lixinger_official'`, [BENCHMARK]);
    const firstDay = firstOfficial.rows[0] && firstOfficial.rows[0].d;
    if (firstDay) {
      const droppedPe = await pool.query(`DELETE FROM market.market_valuation_daily
        WHERE market_code='CN' AND benchmark_code=$1 AND source_code='csindex'`, [BENCHMARK]);
      const droppedGraham = await pool.query(`DELETE FROM analytics.graham_index_daily
        WHERE market_code='CN' AND benchmark_code=$1 AND trade_date < $2::date`, [BENCHMARK, firstDay]);
      console.log(`\n删除 ${BENCHMARK} 中证旧行 ${droppedPe.rowCount || 0} 条；官方首日 ${firstDay} 之前的格雷厄姆旧行 ${droppedGraham.rowCount || 0} 条`);
    }
  }

  const recalculated = await marketVolatilitySync.calculateGraham(pool, SINCE);
  console.log(`格雷厄姆重算（${SINCE} 起）：${recalculated} 条`);

  // 格雷厄姆序列必须与官方 PE 一一对应：旧口径时代有些日期（含休市日）中证有值、理杏仁没有，
  // 重算窗口不会删掉这些行，会留下带着旧口径数值的孤立点，这里一并清掉。
  const orphan = await pool.query(`DELETE FROM analytics.graham_index_daily g
    WHERE g.market_code='CN' AND g.benchmark_code=$1
      AND NOT EXISTS (SELECT 1 FROM market.market_valuation_daily v
        WHERE v.benchmark_code=$1 AND v.source_code='lixinger_official' AND v.trade_date=g.trade_date)`, [BENCHMARK]);
  console.log(`\n清理无官方 PE 对应的格雷厄姆孤立行：${orphan.rowCount || 0} 条`);

  await summary('切换后');
  await pool.end();
})().catch(async error => {
  console.error('回填失败：', error && error.message ? error.message : error);
  try { await pool.end(); } catch (_) { /* 连接已关闭 */ }
  process.exit(1);
});

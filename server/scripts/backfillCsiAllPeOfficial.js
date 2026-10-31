// 一次性回填：A股全市场 PE（中证全指 000985）改用理杏仁官方「总市值加权」口径。
//
// 背景：`market.market_valuation_daily` 里 CSIALL 原本只有中证指数官网（csindex，整体法：
// Σ总市值 ÷ Σ净利润）一条序列；理杏仁 `cn/index/fundamental` 的 `pe_ttm.mcw` 是页面上的
// 「总市值加权」。两者同一天数值不同且差距随时间变化（2011 −17.6% → 2026-08 +18.7%），
// 所以换源不是平移，必须整段替换并按新序列重算格雷厄姆指数（analytics.graham_index_daily）。
//
// 用法：
//   node server/scripts/backfillCsiAllPeOfficial.js            # 只打印计划（默认只读）
//   node server/scripts/backfillCsiAllPeOfficial.js --apply    # 真正写入
//
// 参数：--since=2011-08-01（默认），--keep-before（保留 2011-08-01 之前的中证旧行）
const { pool } = require('../db/connection');

const APPLY = process.argv.includes('--apply');
const SINCE = (process.argv.find(arg => arg.startsWith('--since=')) || '--since=2011-08-01').split('=')[1];
const KEEP_BEFORE = process.argv.includes('--keep-before');

async function summary(label) {
  const bySource = await pool.query(`SELECT source_code, count(*)::int AS n, min(trade_date)::text AS first, max(trade_date)::text AS last
    FROM market.market_valuation_daily WHERE market_code='CN' AND benchmark_code='CSIALL' GROUP BY 1 ORDER BY 1`);
  console.log(`\n[${label}] CSIALL 分来源：`);
  for (const row of bySource.rows) console.log(`  ${row.source_code.padEnd(20)} ${String(row.n).padStart(5)} 行  ${row.first} ~ ${row.last}`);
  const samples = await pool.query(`SELECT trade_date::text AS d, source_code, round(pe, 2) AS pe
    FROM market.market_valuation_daily WHERE market_code='CN' AND benchmark_code='CSIALL'
      AND trade_date IN ('2011-08-02','2015-01-05','2020-01-02','2025-01-02','2026-08-18',(SELECT max(trade_date) FROM market.market_valuation_daily WHERE market_code='CN' AND benchmark_code='CSIALL'))
    ORDER BY trade_date, source_code`);
  console.log(`[${label}] 抽样：`);
  for (const row of samples.rows) console.log(`  ${row.d}  ${row.source_code.padEnd(20)} ${row.pe}`);
  const graham = await pool.query(`SELECT trade_date::text AS d, round(pe, 2) AS pe, round(graham_index_pct, 3) AS graham
    FROM analytics.graham_index_daily WHERE market_code='CN' AND benchmark_code='CSIALL'
    ORDER BY trade_date DESC LIMIT 3`);
  console.log(`[${label}] 格雷厄姆最近 3 行：`);
  for (const row of graham.rows) console.log(`  ${row.d}  pe=${row.pe}  graham=${row.graham}`);
}

(async () => {
  console.log(`全市场 PE 换源：${APPLY ? '实际写入' : '只读预演（加 --apply 才写）'}；起点 ${SINCE}；${KEEP_BEFORE ? '保留起点前旧行' : '删除起点前旧行'}`);
  await summary('切换前');

  if (!APPLY) {
    const pre = await pool.query(`SELECT count(*)::int AS n FROM market.market_valuation_daily
      WHERE market_code='CN' AND benchmark_code='CSIALL' AND source_code='csindex'`);
    const preGraham = await pool.query(`SELECT count(*)::int AS n FROM analytics.graham_index_daily
      WHERE market_code='CN' AND benchmark_code='CSIALL' AND trade_date < $1::date`, [SINCE]);
    console.log(`\nCSIALL 的中证(csindex)旧行：${pre.rows[0].n} 条（预演：会被全部删除）、起点前格雷厄姆旧行：${preGraham.rows[0].n} 条`);
    console.log('\n预演结束：未调用外部接口、未写库。');
    await pool.end();
    return;
  }

  if (!APPLY) {
    console.log('\n预演结束：未调用外部接口、未写库。');
    await pool.end();
    return;
  }

  const marketVolatilitySync = require('../jobs/marketVolatilitySync');
  const written = await marketVolatilitySync.syncCsiPeFromOfficial('CSIALL', '000985', { fullSince: SINCE });
  console.log(`\n官方口径写入：${written} 条`);

  // 中证（整体法）与官方（总市值加权）不是同一算法，掺在一条序列里会失真：
  // CSIALL 的中证旧行全部删除，只留官方；官方首日之前的格雷厄姆行同时清掉，序列从官方首日算起。
  if (!KEEP_BEFORE) {
    const firstOfficial = await pool.query(`SELECT min(trade_date)::text AS d FROM market.market_valuation_daily
      WHERE market_code='CN' AND benchmark_code='CSIALL' AND source_code='lixinger_official'`);
    const firstDay = firstOfficial.rows[0] && firstOfficial.rows[0].d;
    if (firstDay) {
      const droppedPe = await pool.query(`DELETE FROM market.market_valuation_daily
        WHERE market_code='CN' AND benchmark_code='CSIALL' AND source_code='csindex'`);
      const droppedGraham = await pool.query(`DELETE FROM analytics.graham_index_daily
        WHERE market_code='CN' AND benchmark_code='CSIALL' AND trade_date < $1::date`, [firstDay]);
      console.log(`\n删除 CSIALL 中证旧行 ${droppedPe.rowCount || 0} 条；官方首日 ${firstDay} 之前的格雷厄姆旧行 ${droppedGraham.rowCount || 0} 条`);
    }
  }

  const recalculated = await marketVolatilitySync.calculateGraham(pool, SINCE);
  console.log(`格雷厄姆重算（${SINCE} 起）：${recalculated} 条`);

  await summary('切换后');
  await pool.end();
})().catch(async error => {
  console.error('回填失败：', error && error.message ? error.message : error);
  try { await pool.end(); } catch (_) { /* 连接已关闭 */ }
  process.exit(1);
});

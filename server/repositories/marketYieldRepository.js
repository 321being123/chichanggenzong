const { pool } = require('../db/connection');

// sourceCode 由取数方决定：理杏仁官方优先时写 lixinger_official，回退时仍写 chinabond。
async function saveChinaYield(row, sourceCode = 'chinabond') {
  if (!row || !row.workTime || !Number.isFinite(Number(row.tenYear))) return { rowCount: 0, rows: [] };
  return pool.query(`INSERT INTO market.sovereign_yield_daily(market_code,tenor_years,trade_date,yield_pct,source_code,source_date,raw_payload)
    VALUES('CN',10,$1,$2,$4,$1,$3) ON CONFLICT(market_code,tenor_years,trade_date,source_code) DO UPDATE SET yield_pct=EXCLUDED.yield_pct,raw_payload=EXCLUDED.raw_payload,ingested_at=now()`, [row.workTime, row.tenYear, JSON.stringify(row), sourceCode]);
}

async function saveHsiMarketValuation(day, pe, row, sourceCode = 'hsi_official') {
  return pool.query(`INSERT INTO market.market_valuation_daily(market_code,benchmark_code,trade_date,pe,source_code,source_date,raw_payload)
      VALUES('HK','HSI',$1,$2,$4,$1,$3) ON CONFLICT(market_code,benchmark_code,trade_date,source_code) DO UPDATE SET pe=EXCLUDED.pe,raw_payload=EXCLUDED.raw_payload,ingested_at=now()`, [day, pe, JSON.stringify(row), sourceCode]);
}

async function saveHsiIndexHistory(day, pe, row, sourceCode = 'hsi_official') {
  return pool.query(`INSERT INTO market.index_valuation_history(index_code,valuation_method,trade_date,pe_ttm,source_code,raw_payload)
      VALUES('HSI','market_cap_weighted',$1,$2,$4,$3)
      ON CONFLICT(index_code,valuation_method,trade_date,source_code) DO UPDATE SET
        pe_ttm=EXCLUDED.pe_ttm,raw_payload=EXCLUDED.raw_payload,ingested_at=now()`, [day, pe, JSON.stringify(row), sourceCode]);
}

// 水位按来源分开看：来源一换（csindex → lixinger_official）就自然走全量回填，
// 不会拿旧来源的最大日期当自己的水位。
async function readCsiWatermark(benchmark, sourceCode = 'csindex') {
  return pool.query(`SELECT max(trade_date)::text AS mx FROM market.market_valuation_daily WHERE market_code='CN' AND benchmark_code=$1 AND source_code=$2`, [benchmark, sourceCode]);
}

// 中证系指数 PE 落 market_valuation_daily：来源由取数方传入。
// 沪深300（CSI300）仍是中证官网 csindex；A股全市场（CSIALL）只认理杏仁官方 lixinger_official——
// 两者算法不同（整体法 vs 总市值加权），**同一基准不允许两来源并存**，中证旧行已按一次性脚本清理。
async function saveCsiValuations(benchmark, kept, sourceCode = 'csindex') {
  const values = [], params = []; let p = 1;
  for (const k of kept) {
    values.push(`('CN',$${p},$${p+1},$${p+2},$${p+3},$${p+1},$${p+4})`);
    params.push(benchmark, k.day, k.pe, sourceCode, JSON.stringify(k.raw));
    p += 5;
  }
  await pool.query(`INSERT INTO market.market_valuation_daily(market_code,benchmark_code,trade_date,pe,source_code,source_date,raw_payload)
    VALUES ${values.join(',')} ON CONFLICT(market_code,benchmark_code,trade_date,source_code) DO UPDATE SET pe=EXCLUDED.pe,raw_payload=EXCLUDED.raw_payload,ingested_at=now()`, params);
}

async function readUsYieldWatermark(source) {
  return pool.query(`SELECT max(trade_date)::text AS mx
    FROM market.sovereign_yield_daily
    WHERE market_code='US' AND tenor_years=10 AND source_code=$1`, [source]);
}

async function saveUsYieldBatch(batch, source) {
  const values = [], params = [];
  let p = 1;
  for (const row of batch) {
    values.push(`('US',10,$${p},$${p + 1},'${source}',$${p},$${p + 2})`);
    params.push(row.day, row.yieldPct, JSON.stringify(row.raw));
    p += 3;
  }
  if (!values.length) return;
  await pool.query(`INSERT INTO market.sovereign_yield_daily
    (market_code,tenor_years,trade_date,yield_pct,source_code,source_date,raw_payload)
    VALUES ${values.join(',')}
    ON CONFLICT(market_code,tenor_years,trade_date,source_code) DO UPDATE SET
      yield_pct=EXCLUDED.yield_pct,source_date=EXCLUDED.source_date,
      raw_payload=EXCLUDED.raw_payload,ingested_at=now()`, params);
}

async function readMoneyWatermark() {
  return pool.query(`SELECT max(month)::text AS mx FROM market.money_supply_monthly WHERE market_code='CN'`);
}

async function saveMoneySupply(kept, sourceCode = 'nbs_via_tushare') {
  const values = [], params = []; let p = 1;
  for (const k of kept) {
    values.push(`('CN',$${p},$${p+1},'${sourceCode}',$${p+2})`);
    params.push(k.month, k.m2, JSON.stringify({
      ...k.row,
      source: 'https://data.stats.gov.cn/',
      fiscalReference: 'https://gks.mof.gov.cn/tongjishuju/',
      transport: 'tushare.cn_m',
      unit: '100m CNY',
      m1DefinitionVersion: String(k.row.month) >= '202501' ? '2025_revised' : 'pre_2025',
    }));
    p += 3;
  }
  await pool.query(`INSERT INTO market.money_supply_monthly
    (market_code,month,m2_100m_yuan,source_code,raw_payload)
    VALUES ${values.join(',')}
    ON CONFLICT(market_code,month,source_code) DO UPDATE SET
      m2_100m_yuan=EXCLUDED.m2_100m_yuan,raw_payload=EXCLUDED.raw_payload,ingested_at=now()`, params);
}

async function readCsi300Watermark() {
  return pool.query(`SELECT max(trade_date)::text AS mx FROM market.index_valuation_history WHERE index_code='CSI300' AND source_code='tushare_index_dailybasic'`);
}

async function saveCsi300Valuations(kept, sourceCode = 'tushare_index_dailybasic') {
  const values = [], params = []; let p = 1;
  for (const row of kept) {
    const { day, pe, pb } = row;
    values.push(`('CSI300','market_cap_weighted',$${p},$${p+1},$${p+2},$${p+3},'${sourceCode}',$${p+4})`);
    params.push(day, Number((row.raw && (row.raw.total_mv ?? row.raw.mc)) || row.marketCap) || null, pe > 0 ? pe : null, pb > 0 ? pb : null, JSON.stringify(row.raw));
    p += 5;
  }
  await pool.query(`INSERT INTO market.index_valuation_history
    (index_code,valuation_method,trade_date,market_cap,pe_ttm,pb,source_code,raw_payload)
    VALUES ${values.join(',')}
    ON CONFLICT(index_code,valuation_method,trade_date,source_code) DO UPDATE SET
      market_cap=EXCLUDED.market_cap,pe_ttm=EXCLUDED.pe_ttm,pb=EXCLUDED.pb,
      raw_payload=EXCLUDED.raw_payload,ingested_at=now()`, params);
}

async function readM2Inputs() {
  return pool.query(`
    SELECT
      (SELECT max(month)::text FROM market.money_supply_monthly WHERE market_code='CN') AS m2_month,
      (SELECT max(trade_date)::text FROM market.a_share_market_cap_daily WHERE source_code='tushare_daily_basic') AS cap_date`);
}

async function calculateM2MarketCap(executor = pool.query.bind(pool)) {
  return executor(`INSERT INTO analytics.m2_market_cap_daily
    (trade_date,m2_month,m2_100m_yuan,total_market_cap_100m_yuan,ratio_pct,data_status)
    SELECT c.trade_date,m.month,m.m2_100m_yuan,c.total_market_cap_100m_yuan,
      m.m2_100m_yuan/c.total_market_cap_100m_yuan*100,
      CASE WHEN date_trunc('month',c.trade_date) <= (m.month + INTERVAL '2 months') THEN 'normal' ELSE 'carried_forward' END
    FROM market.a_share_market_cap_daily c
    JOIN LATERAL (
      SELECT month,m2_100m_yuan FROM market.money_supply_monthly
      WHERE market_code='CN' AND month <= date_trunc('month',c.trade_date)
      ORDER BY month DESC LIMIT 1
    ) m ON true
    WHERE c.source_code='tushare_daily_basic'
    ON CONFLICT(trade_date,formula_version) DO UPDATE SET
      m2_month=EXCLUDED.m2_month,m2_100m_yuan=EXCLUDED.m2_100m_yuan,
      total_market_cap_100m_yuan=EXCLUDED.total_market_cap_100m_yuan,
      ratio_pct=EXCLUDED.ratio_pct,data_status=EXCLUDED.data_status,calculated_at=now()`);
}

async function listMarketCapDates() {
  return pool.query(`SELECT to_char(trade_date,'YYYYMMDD') AS day
    FROM market.a_share_market_cap_daily WHERE source_code='tushare_daily_basic'`);
}

async function saveMarketCap({ day, totalYi, securityCount, fromUnified, sourceCode = 'tushare_daily_basic' }) {
  return pool.query(`INSERT INTO market.a_share_market_cap_daily
      (trade_date,total_market_cap_100m_yuan,security_count,source_code,raw_payload)
      VALUES($1,$2,$3,$5,$4)
      ON CONFLICT(trade_date,source_code) DO UPDATE SET
        total_market_cap_100m_yuan=EXCLUDED.total_market_cap_100m_yuan,
        security_count=EXCLUDED.security_count,raw_payload=EXCLUDED.raw_payload,ingested_at=now()`, [day, totalYi, securityCount, JSON.stringify({
    upstreamUnit: fromUnified ? 'CNY' : '10000 CNY',
    storedUnit: '100m CNY',
    sourceCode,
    securityCount,
    source: fromUnified ? 'unified_daily_valuations' : sourceCode,
  }), sourceCode]);
}

const SUBDATASET_QUERIES = Object.freeze({
  cn_yield: "SELECT max(trade_date)::text AS data_as_of FROM market.sovereign_yield_daily WHERE market_code='CN' AND tenor_years=10 AND source_code IN ('chinabond','lixinger_official')",
  csi300_pe: "SELECT max(trade_date)::text AS data_as_of FROM market.market_valuation_daily WHERE market_code='CN' AND benchmark_code='CSI300' AND source_code IN ('csindex','lixinger_official','tushare_index_dailybasic')",
  csi_all_pe: "SELECT max(trade_date)::text AS data_as_of FROM market.market_valuation_daily WHERE market_code='CN' AND benchmark_code='CSIALL' AND source_code='lixinger_official'",
  hsi_pe: "SELECT max(trade_date)::text AS data_as_of FROM market.market_valuation_daily WHERE market_code='HK' AND benchmark_code='HSI' AND source_code IN ('hsi_official','lixinger_official')",
  us_treasury_yield: "SELECT max(trade_date)::text AS data_as_of FROM market.sovereign_yield_daily WHERE market_code='US' AND tenor_years=10 AND source_code='tushare_us_tycr'",
  m2: "SELECT max(month)::text AS data_as_of FROM market.money_supply_monthly WHERE market_code='CN'",
  a_share_market_cap: "SELECT max(trade_date)::text AS data_as_of FROM market.a_share_market_cap_daily WHERE source_code IN ('tushare_daily_basic','lixinger_official')",
  m2_market_cap: "SELECT max(trade_date)::text AS data_as_of FROM analytics.m2_market_cap_daily WHERE data_status='normal'",
  graham_csi300: "SELECT max(trade_date)::text AS data_as_of FROM analytics.graham_index_daily WHERE market_code='CN' AND benchmark_code='CSI300'",
  graham_csi_all: "SELECT max(trade_date)::text AS data_as_of FROM analytics.graham_index_daily WHERE market_code='CN' AND benchmark_code='CSIALL'",
});

async function readSubdatasetFreshness(code) {
  const sql = SUBDATASET_QUERIES[code];
  if (!sql) throw new Error(`未知市场周期数据集: ${code}`);
  return pool.query(sql);
}

async function countChinaYield() {
  return pool.query("SELECT count(*)::int AS n FROM market.sovereign_yield_daily WHERE market_code='CN' AND source_code='chinabond'");
}

async function countMarketCap() {
  return pool.query("SELECT count(*)::int AS n FROM market.a_share_market_cap_daily WHERE source_code='tushare_daily_basic'");
}

module.exports = { saveChinaYield, saveHsiMarketValuation, saveHsiIndexHistory, readCsiWatermark, saveCsiValuations, readUsYieldWatermark, saveUsYieldBatch, readMoneyWatermark, saveMoneySupply, readCsi300Watermark, saveCsi300Valuations, readM2Inputs, calculateM2MarketCap, listMarketCapDates, saveMarketCap, readSubdatasetFreshness, countChinaYield, countMarketCap };

// 市场周期数据仓储（批次3，从 routes/marketVolatility 迁入的 SQL）。
// 合同：method(params, tx)；只做账户存在性、首页配置与策略保存状态的读写。
// 动态表名/列名一律改为固定 SQL 常量 + metric 分派，仓储内不再拼接标识符。
const { pool } = require('../db');

// 账户存在性（权限判定语义仍由路由决定，这里只回答“有没有这行”）
async function accountExists(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(
    'SELECT 1 FROM accounts WHERE username=$1 AND account_name=$2 LIMIT 1',
    [params.username, params.accountName],
  );
  return rows.length > 0;
}

// 首页周期配置（单行 setting_key）
async function readHomeSetting(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(
    `SELECT metric_code AS metric,market_code AS market,benchmark_code AS benchmark,
            reference_username,reference_account
       FROM analytics.market_cycle_home_setting
      WHERE setting_key='market_cycle_home' LIMIT 1`,
  );
  return rows[0] || null;
}

// 各指标表的水位（用于条件请求）。四条固定语句覆盖 graham / m2 / pe-pb / 其余指数估值。
const WATERMARK_SQL = {
  graham: `SELECT COALESCE(MAX(trade_date)::text, '1900-01-01') AS latest_date,
                  COALESCE(MAX(calculated_at)::text, '') AS latest_calculated
             FROM analytics.graham_index_daily WHERE market_code=$1 AND benchmark_code=$2`,
  m2: `SELECT COALESCE(MAX(trade_date)::text, '1900-01-01') AS latest_date,
              COALESCE(MAX(calculated_at)::text, '') AS latest_calculated
         FROM analytics.m2_market_cap_daily`,
  'valuation-ingested': `SELECT COALESCE(MAX(trade_date)::text, '1900-01-01') AS latest_date,
                                COALESCE(MAX(ingested_at)::text, '') AS latest_calculated
                           FROM market.index_valuation_history
                          WHERE index_code=$1 AND valuation_method='market_cap_weighted'`,
  'valuation-calculated': `SELECT COALESCE(MAX(trade_date)::text, '1900-01-01') AS latest_date,
                                  COALESCE(MAX(calculated_at)::text, '') AS latest_calculated
                             FROM market.index_valuation_history
                            WHERE index_code=$1 AND valuation_method='market_cap_weighted'`,
};

async function readMetricWatermark(params, tx) {
  const runner = tx || pool;
  const metric = String(params.metric || '');
  if (metric === 'graham') {
    const { rows } = await runner.query(WATERMARK_SQL.graham, [params.market, params.benchmark]);
    return rows[0] || null;
  }
  if (metric === 'm2_market_cap') {
    const { rows } = await runner.query(WATERMARK_SQL.m2);
    return rows[0] || null;
  }
  const sql = metric === 'pe' || metric === 'pb'
    ? WATERMARK_SQL['valuation-ingested']
    : WATERMARK_SQL['valuation-calculated'];
  const { rows } = await runner.query(sql, [params.benchmark]);
  return rows[0] || null;
}

// 该账户是否已保存当前页面口径的仓位边界（graham 与其他指标分表）
async function hasSavedStrategy(params, tx) {
  const runner = tx || pool;
  const isGraham = params.metric === 'graham';
  const { rows } = isGraham
    ? await runner.query(
      `SELECT 1 FROM analytics.graham_strategy_settings
        WHERE username=$1 AND account_name=$2 AND market_code=$3 AND benchmark_code=$4 AND is_current LIMIT 1`,
      [params.username, params.accountName, params.market, params.benchmark],
    )
    : await runner.query(
      `SELECT 1 FROM analytics.market_cycle_strategy_settings
        WHERE username=$1 AND account_name=$2 AND metric_code=$3 AND market_code=$4 AND benchmark_code=$5 AND is_current LIMIT 1`,
      [params.username, params.accountName, params.metric, params.market, params.benchmark],
    );
  return rows.length > 0;
}

async function upsertHomeSetting(params, tx) {
  const runner = tx || pool;
  await runner.query(
    `INSERT INTO analytics.market_cycle_home_setting
      (setting_key,metric_code,market_code,benchmark_code,reference_username,reference_account,updated_by,updated_at)
      VALUES('market_cycle_home',$1,$2,$3,$4,$5,$4,now())
      ON CONFLICT(setting_key) DO UPDATE SET metric_code=EXCLUDED.metric_code,market_code=EXCLUDED.market_code,
        benchmark_code=EXCLUDED.benchmark_code,reference_username=EXCLUDED.reference_username,
        reference_account=EXCLUDED.reference_account,updated_by=EXCLUDED.updated_by,updated_at=now()`,
    [params.metric, params.market, params.benchmark, params.username, params.accountName],
  );
}

// 手动导入的联邦基金利率（US 10Y）：整批写入，调用方负责事务边界。
async function upsertSovereignYield(params, tx) {
  const runner = tx || pool;
  const rows = params.rows || [];
  const sourceName = params.sourceName || '';
  for (const row of rows) {
    await runner.query(
      `INSERT INTO market.sovereign_yield_daily(market_code,tenor_years,trade_date,yield_pct,source_code,source_date,raw_payload)
       VALUES('US',10,$1,$2,'manual_fed_funds',$3,$4)
       ON CONFLICT(market_code,tenor_years,trade_date,source_code) DO UPDATE
         SET yield_pct=EXCLUDED.yield_pct,source_date=EXCLUDED.source_date,
             raw_payload=EXCLUDED.raw_payload,ingested_at=now()`,
      [row.tradeDate, row.yieldPct, row.sourceDate,
        JSON.stringify({ source: sourceName, sourceDate: row.sourceDate, rate: row.yieldPct })],
    );
  }
  return rows.length;
}

module.exports = {
  accountExists,
  hasSavedStrategy,
  readHomeSetting,
  readMetricWatermark,
  upsertHomeSetting,
  upsertSovereignYield,
};

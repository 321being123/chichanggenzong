const { pool, loadAccountSummary } = require('../db');

const METRICS = {
  pe: { direction: 'lower_is_cheaper', label: '市盈率（PE-TTM）' },
  pb: { direction: 'lower_is_cheaper', label: '市净率（PB）' },
  m2_market_cap: { direction: 'higher_is_cheaper', label: 'M2与股市市值比' },
};
const INDEX_NAMES = { CSI300: '沪深300', CSIALL: '中证全指', HSI: '恒生指数', ASHARE: '中证全指' };

function validMetric(metric) {
  return Object.prototype.hasOwnProperty.call(METRICS, metric);
}

function rangeCutoff(range, now) {
  const years = { '1y': 1, '3y': 3, '5y': 5, '10y': 10, '20y': 20, all: null }[range];
  if (years == null) return null;
  const date = new Date(now || Date.now());
  date.setUTCFullYear(date.getUTCFullYear() - years);
  return date.toISOString().slice(0, 10);
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index), upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function metricStats(rows) {
  const values = (rows || []).map(row => Number(row.value)).filter(Number.isFinite).sort((a, b) => a - b);
  if (!values.length) return null;
  const current = values[values.length - 1];
  const latestValue = Number((rows || []).at(-1)?.value);
  const less = values.filter(value => value < latestValue).length;
  const equal = values.filter(value => value === latestValue).length;
  return {
    count: values.length,
    min: values[0],
    p20: percentile(values, 0.2),
    p50: percentile(values, 0.5),
    p80: percentile(values, 0.8),
    max: current,
    percentile: Number(((less + equal * 0.5) / values.length * 100).toFixed(2)),
  };
}

function metricLadder(lower, upper, direction) {
  const low = Number(lower), high = Number(upper);
  if (!Number.isFinite(low) || !Number.isFinite(high) || low <= 0 || high <= low) return [];
  return Array.from({ length: 7 }, (_, index) => ({
    value: Number((low + (high - low) * index / 6).toFixed(6)),
    position: direction === 'lower_is_cheaper' ? 80 - index * 10 : 20 + index * 10,
  }));
}

function metricRecommendedPosition(value, lower, upper, direction) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const rows = metricLadder(lower, upper, direction);
  if (!rows.length) return null;
  if (direction === 'lower_is_cheaper') {
    for (const row of rows) if (number <= row.value) return row.position;
    return 20;
  }
  for (let index = rows.length - 1; index >= 0; index--) if (number >= rows[index].value) return rows[index].position;
  return 20;
}

async function metricRows(metric, market, benchmark) {
  if (metric === 'm2_market_cap') {
    const { rows } = await pool.query(`SELECT trade_date::text AS date, ratio_pct::float8 AS value,
      m2_100m_yuan::float8 AS m2_100m_yuan, total_market_cap_100m_yuan::float8 AS total_market_cap_100m_yuan,
      m2_month::text AS m2_month, data_status
      FROM analytics.m2_market_cap_daily ORDER BY trade_date`);
    return rows;
  }
  const field = metric === 'pe' ? 'pe_ttm' : 'pb';
  if (market === 'CN' && benchmark === 'CSIALL') {
    if (metric === 'pb') return [];
    const { rows } = await pool.query(`SELECT DISTINCT ON (trade_date) trade_date::text AS date, pe::float8 AS value,
      'normal'::text AS data_status FROM market.market_valuation_daily
      WHERE market_code='CN' AND benchmark_code='CSIALL' AND pe > 0
      ORDER BY trade_date, CASE WHEN source_code='csindex' THEN 0 ELSE 1 END`);
    return rows;
  }
  const { rows } = await pool.query(`SELECT DISTINCT ON (trade_date) trade_date::text AS date,
    ${field}::float8 AS value, close::float8 AS close, market_cap::float8 AS market_cap, 'normal'::text AS data_status
    FROM market.index_valuation_history
    WHERE index_code=$1 AND valuation_method='market_cap_weighted' AND ${field} > 0
    ORDER BY trade_date, CASE WHEN source_code='tushare_index_dailybasic' THEN 0 WHEN source_code='user_supplied_weighted_csv' THEN 1 ELSE 2 END`,
  [benchmark]);
  return rows;
}

async function loadRows(metric, market, benchmark) {
  return metricRows(metric, market, benchmark);
}

async function getSetting(username, account, metric, market, benchmark) {
  if (!username || !account) return null;
  const { rows } = await pool.query(`SELECT lower_boundary::float8 AS lower, upper_boundary::float8 AS upper, version
    FROM analytics.market_cycle_strategy_settings
    WHERE username=$1 AND account_name=$2 AND metric_code=$3 AND market_code=$4 AND benchmark_code=$5 AND is_current
    LIMIT 1`, [username, account, metric, market, benchmark]);
  return rows[0] || null;
}

async function actualPosition(username, account) {
  if (!username || !account) return null;
  const data = await loadAccountSummary(username, account);
  let equity = 0, total = Number(data.cash) || 0;
  for (const row of data.positions || []) {
    const value = Number(row.price || 0) * Number(row.quantity || 0) * (row.subtype === '港股' ? Number(data.hkRate || 0) : 1);
    total += value;
    if (row.type === '股权') equity += value;
  }
  return total > 0 ? Number((equity / total * 100).toFixed(2)) : null;
}

async function getOverview(username, account, metric, market, benchmark, rowsOverride = null) {
  if (!validMetric(metric)) return null;
  const rows = rowsOverride || await metricRows(metric, market, benchmark);
  const current = rows.at(-1) || null;
  if (!current) return { metric, market, benchmark, direction: METRICS[metric].direction, current: null };
  const stats = metricStats(rows);
  const saved = await getSetting(username, account, metric, market, benchmark);
  const setting = saved || { lower: stats.p20, upper: stats.p80, version: 0, isDefault: true };
  setting.ladder = metricLadder(setting.lower, setting.upper, METRICS[metric].direction);
  const recommendedPosition = metricRecommendedPosition(current.value, setting.lower, setting.upper, METRICS[metric].direction);
  const [actual, pointResult] = await Promise.all([
    actualPosition(username, account),
    pool.query('SELECT close::float8 AS value, date::text AS trade_date FROM index_history WHERE name=$1 ORDER BY date DESC LIMIT 1', [INDEX_NAMES[benchmark]]),
  ]);
  const delta = actual == null || recommendedPosition == null ? null : Number((actual - recommendedPosition).toFixed(2));
  return {
    metric, market, benchmark, direction: METRICS[metric].direction,
    current, stats, setting, recommendedPosition, actualPosition: actual,
    indexName: INDEX_NAMES[benchmark], indexPoint: pointResult.rows[0] || null,
    deviation: delta == null ? null : { value: delta, status: Math.abs(delta) <= 5 ? '符合' : delta > 0 ? '偏高' : '偏低' },
  };
}

async function getHistory(metric, market, benchmark, range, rowsOverride = null) {
  const rows = rowsOverride || await metricRows(metric, market, benchmark);
  const cutoff = rangeCutoff(range);
  return cutoff ? rows.filter(row => row.date >= cutoff) : rows;
}

async function saveSetting(username, account, metric, market, benchmark, lower, upper, version) {
  const direction = METRICS[metric]?.direction;
  const ladder = metricLadder(lower, upper, direction);
  if (!ladder.length) { const error = new Error('边界值必须大于0，且最高边界必须大于最低边界'); error.status = 400; throw error; }
  const previous = await getSetting(username, account, metric, market, benchmark);
  if (previous && Number(version) !== Number(previous.version)) { const error = new Error('设置已被其他页面更新，请刷新后重试'); error.conflict = true; throw error; }
  if (!previous && Number(version || 0) !== 0) { const error = new Error('设置版本错误，请刷新后重试'); error.conflict = true; throw error; }
  const nextVersion = (previous ? previous.version : 0) + 1;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE analytics.market_cycle_strategy_settings SET is_current=false
      WHERE username=$1 AND account_name=$2 AND metric_code=$3 AND market_code=$4 AND benchmark_code=$5 AND is_current`,
    [username, account, metric, market, benchmark]);
    await client.query(`INSERT INTO analytics.market_cycle_strategy_settings
      (username,account_name,metric_code,market_code,benchmark_code,lower_boundary,upper_boundary,version)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [username, account, metric, market, benchmark, lower, upper, nextVersion]);
    await client.query('COMMIT');
    return { lower: Number(lower), upper: Number(upper), version: nextVersion, ladder };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  METRICS, validMetric, rangeCutoff, metricStats, metricLadder, metricRecommendedPosition,
  loadRows, getOverview, getHistory, saveSetting,
};

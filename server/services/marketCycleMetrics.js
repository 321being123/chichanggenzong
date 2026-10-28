const { loadAccountSummary } = require('../db');
const marketStrategyRepository = require('../repositories/marketStrategyRepository');
const CoreDate = require('../../public/shared/core-date.js');

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
  const businessDate = CoreDate.todayInZone('Asia/Shanghai', now == null ? new Date() : now);
  return businessDate ? CoreDate.subtractYears(businessDate, years) : null;
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

const metricRows = marketStrategyRepository.metricRows;

async function loadRows(metric, market, benchmark) {
  return metricRows(metric, market, benchmark);
}

async function getSetting(username, account, metric, market, benchmark) {
  if (!username || !account) return null;
  const { rows } = await marketStrategyRepository.readSetting(username, account, metric, market, benchmark);
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
    marketStrategyRepository.readIndexPoint(INDEX_NAMES[benchmark]),
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
  await marketStrategyRepository.writeSetting(username, account, metric, market, benchmark, lower, upper, nextVersion);
  return { lower: Number(lower), upper: Number(upper), version: nextVersion, ladder };
}

module.exports = {
  METRICS, validMetric, rangeCutoff, metricStats, metricLadder, metricRecommendedPosition,
  loadRows, getOverview, getHistory, saveSetting,
};

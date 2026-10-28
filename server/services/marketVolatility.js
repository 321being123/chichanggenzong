const { loadAccountSummary } = require('../db');
const grahamStrategyRepository = require('../repositories/grahamStrategyRepository');
const marketStrategyRepository = require('../repositories/marketStrategyRepository');
const cycleMetrics = require('./marketCycleMetrics');

const BENCHMARKS = { CN: ['CSI300', 'CSIALL'], HK: ['HSI'] };
const INDEX_NAMES = { CSI300: '沪深300', CSIALL: '中证全指', HSI: '恒生指数' };

function validMarketBenchmark(market, benchmark) {
  return !!(BENCHMARKS[market] || []).includes(benchmark);
}
function ladder(lower, upper) {
  const l = Number(lower); const u = Number(upper);
  if (!Number.isFinite(l) || !Number.isFinite(u) || l <= 0 || u <= l) return [];
  return Array.from({ length: 7 }, (_, i) => ({ value: Number((l + (u - l) * i / 6).toFixed(4)), position: 20 + i * 10 }));
}
function recommendedPosition(index, lower, upper) {
  const v = Number(index);
  if (!Number.isFinite(v) || v <= 0) return 20;
  const levels = ladder(lower, upper);
  if (!levels.length || v < levels[0].value) return 20;
  for (let i = levels.length - 1; i >= 0; i--) if (v >= levels[i].value) return levels[i].position;
  return 20;
}
function boundaries(lower, upper) {
  const l = Number(lower); const u = Number(upper);
  if (!Number.isFinite(l) || !Number.isFinite(u) || l <= 0 || u <= l) return null;
  return { lower: Number(l.toFixed(4)), upper: Number(u.toFixed(4)) };
}
function accountPosition(rows, cashBase, hkRate) {
  let equity = 0, total = Number(cashBase) || 0, hasUs = false;
  for (const row of rows || []) {
    const value = Number(row.price || 0) * Number(row.quantity || 0);
    const isHk = row.subtype === '港股';
    const converted = isHk ? value * (Number(hkRate) || 0) : value;
    total += converted;
    if (row.type === '股权') equity += converted;
    if (row.subtype === '美股') hasUs = true;
  }
  return { actualPosition: total > 0 ? Number((equity / total * 100).toFixed(2)) : null, hasUs };
}
function deviation(actual, recommended) {
  if (actual == null || recommended == null) return null;
  const delta = Number((actual - recommended).toFixed(2));
  return { value: delta, status: Math.abs(delta) <= 5 ? '符合' : delta > 0 ? '偏高' : '偏低' };
}

async function getSetting(username, account, market, benchmark) {
  const { rows } = await grahamStrategyRepository.readSetting(username, account, market, benchmark);
  return rows[0] || null;
}
async function getAccountPosition(username, account) {
  const data = await loadAccountSummary(username, account);
  return accountPosition(data.positions || [], data.cash, data.hkRate);
}
async function loadRows(market, benchmark) {
  const { rows } = await grahamStrategyRepository.listGrahamRows(market, benchmark);
  return rows;
}
async function getOverview(username, account, market, benchmark, rowsOverride = null) {
  const [setting, latestRows, position, indexPoint] = await Promise.all([
    username && account ? getSetting(username, account, market, benchmark) : null,
    rowsOverride ? Promise.resolve({ rows: rowsOverride.slice(-1) }) : grahamStrategyRepository.latestGrahamRow(market, benchmark),
    username && account ? getAccountPosition(username, account) : Promise.resolve({ actualPosition: null, hasUs: false }),
    marketStrategyRepository.readIndexPoint(INDEX_NAMES[benchmark])
  ]);
  const current = latestRows.rows[0] || null;
  const recommended = setting && current && current.data_status !== 'missing' ? recommendedPosition(current.graham_index_pct, setting.lower, setting.upper) : null;
  return { market, benchmark, current, indexPoint: indexPoint.rows[0] || null, setting: setting && { ...setting, ladder: ladder(setting.lower, setting.upper) }, recommendedPosition: recommended,
    actualPosition: position.actualPosition, deviation: deviation(position.actualPosition, recommended), hasUsPosition: position.hasUs };
}
async function getHistory(market, benchmark, range, rowsOverride = null) {
  const cutoffDate = cycleMetrics.rangeCutoff(range);
  const { rows } = rowsOverride ? { rows: rowsOverride.map(row => ({ date: row.trade_date, value: row.graham_index_pct, pe: row.pe,
    sovereign_yield_pct: row.sovereign_yield_pct, data_status: row.data_status })) } : await grahamStrategyRepository.readGrahamHistory(market, benchmark, cutoffDate);
  if (!cutoffDate) return rows;
  if (rowsOverride) return rows.filter(row => String(row.date || '').slice(0, 10) >= cutoffDate);
  return rows;
}
async function saveSetting(username, account, market, benchmark, lowerBoundary, upperBoundary, version) {
  const previous = await getSetting(username, account, market, benchmark);
  if (previous && Number(version) !== Number(previous.version)) { const err = new Error('设置已被其他页面更新，请刷新后重试'); err.conflict = true; throw err; }
  if (!previous && Number(version || 0) !== 0) { const err = new Error('设置版本错误，请刷新后重试'); err.conflict = true; throw err; }
  const pair = boundaries(lowerBoundary, upperBoundary);
  if (!pair) { const err = new Error('边界值必须大于 0'); err.status = 400; throw err; }
  const nextVersion = (previous ? previous.version : 0) + 1;
  await grahamStrategyRepository.writeSetting(username, account, market, benchmark, pair, nextVersion);
  return { ...pair, version: nextVersion, ladder: ladder(pair.lower, pair.upper) };
}
module.exports = { BENCHMARKS, validMarketBenchmark, ladder, recommendedPosition, boundaries, accountPosition, deviation, loadRows, getOverview, getHistory, saveSetting };

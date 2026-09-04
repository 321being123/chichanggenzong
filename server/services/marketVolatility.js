const { pool, loadAccountSummary } = require('../db');

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
  const { rows } = await pool.query(
    `SELECT lower_boundary_pct::float8 AS lower, upper_boundary_pct::float8 AS upper, version
     FROM analytics.graham_strategy_settings WHERE username=$1 AND account_name=$2 AND market_code=$3 AND benchmark_code=$4 AND is_current
     LIMIT 1`, [username, account, market, benchmark]
  );
  return rows[0] || null;
}
async function getAccountPosition(username, account) {
  const data = await loadAccountSummary(username, account);
  return accountPosition(data.positions || [], data.cash, data.hkRate);
}
async function loadRows(market, benchmark) {
  const { rows } = await pool.query(`SELECT trade_date::text AS trade_date, pe::float8 AS pe, earnings_yield_pct::float8 AS earnings_yield_pct,
                       sovereign_yield_pct::float8 AS sovereign_yield_pct, sovereign_yield_date::text AS sovereign_yield_date,
                       graham_index_pct::float8 AS graham_index_pct, data_status
                FROM analytics.graham_index_daily WHERE market_code=$1 AND benchmark_code=$2 ORDER BY trade_date`, [market, benchmark]);
  return rows;
}
async function getOverview(username, account, market, benchmark, rowsOverride = null) {
  const [setting, latestRows, position, indexPoint] = await Promise.all([
    username && account ? getSetting(username, account, market, benchmark) : null,
    rowsOverride ? Promise.resolve({ rows: rowsOverride.slice(-1) }) : pool.query(`SELECT trade_date::text AS trade_date, pe::float8 AS pe, earnings_yield_pct::float8 AS earnings_yield_pct,
                       sovereign_yield_pct::float8 AS sovereign_yield_pct, sovereign_yield_date::text AS sovereign_yield_date,
                       graham_index_pct::float8 AS graham_index_pct, data_status
                FROM analytics.graham_index_daily WHERE market_code=$1 AND benchmark_code=$2
                ORDER BY trade_date DESC LIMIT 1`, [market, benchmark]),
    username && account ? getAccountPosition(username, account) : Promise.resolve({ actualPosition: null, hasUs: false }),
    pool.query('SELECT close::float8 AS value, date::text AS trade_date FROM index_history WHERE name=$1 ORDER BY date DESC LIMIT 1', [INDEX_NAMES[benchmark]])
  ]);
  const current = latestRows.rows[0] || null;
  const recommended = setting && current && current.data_status !== 'missing' ? recommendedPosition(current.graham_index_pct, setting.lower, setting.upper) : null;
  return { market, benchmark, current, indexPoint: indexPoint.rows[0] || null, setting: setting && { ...setting, ladder: ladder(setting.lower, setting.upper) }, recommendedPosition: recommended,
    actualPosition: position.actualPosition, deviation: deviation(position.actualPosition, recommended), hasUsPosition: position.hasUs };
}
async function getHistory(market, benchmark, range, rowsOverride = null) {
  const years = { '1y': 1, '3y': 3, '5y': 5, '10y': 10, '20y': 20, all: null }[range];
  const params = [market, benchmark];
  let cutoff = '';
  if (years) { params.push(years); cutoff = "AND trade_date >= CURRENT_DATE - ($3::text || ' years')::interval"; }
  const { rows } = rowsOverride ? { rows: rowsOverride.map(row => ({ date: row.trade_date, value: row.graham_index_pct, pe: row.pe,
    sovereign_yield_pct: row.sovereign_yield_pct, data_status: row.data_status })) } : await pool.query(`SELECT trade_date::text AS date, graham_index_pct::float8 AS value, pe::float8 AS pe,
    sovereign_yield_pct::float8 AS sovereign_yield_pct, data_status
    FROM analytics.graham_index_daily WHERE market_code=$1 AND benchmark_code=$2 ${cutoff} ORDER BY trade_date`, params);
  if (!cutoff || !rowsOverride) return rows;
  const cutoffDate = new Date(); cutoffDate.setUTCFullYear(cutoffDate.getUTCFullYear() - years);
  const cutoffText = cutoffDate.toISOString().slice(0, 10);
  return rows.filter(row => String(row.date || '').slice(0, 10) >= cutoffText);
}
async function saveSetting(username, account, market, benchmark, lowerBoundary, upperBoundary, version) {
  const previous = await getSetting(username, account, market, benchmark);
  if (previous && Number(version) !== Number(previous.version)) { const err = new Error('设置已被其他页面更新，请刷新后重试'); err.conflict = true; throw err; }
  if (!previous && Number(version || 0) !== 0) { const err = new Error('设置版本错误，请刷新后重试'); err.conflict = true; throw err; }
  const pair = boundaries(lowerBoundary, upperBoundary);
  if (!pair) { const err = new Error('边界值必须大于 0'); err.status = 400; throw err; }
  const nextVersion = (previous ? previous.version : 0) + 1;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE analytics.graham_strategy_settings SET is_current=false WHERE username=$1 AND account_name=$2 AND market_code=$3 AND benchmark_code=$4 AND is_current`, [username, account, market, benchmark]);
    await client.query(`INSERT INTO analytics.graham_strategy_settings(username,account_name,market_code,benchmark_code,lower_boundary_pct,upper_boundary_pct,version)
      VALUES($1,$2,$3,$4,$5,$6,$7)`, [username, account, market, benchmark, pair.lower, pair.upper, nextVersion]);
    await client.query('COMMIT');
    return { ...pair, version: nextVersion, ladder: ladder(pair.lower, pair.upper) };
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}
module.exports = { BENCHMARKS, validMarketBenchmark, ladder, recommendedPosition, boundaries, accountPosition, deviation, loadRows, getOverview, getHistory, saveSetting };

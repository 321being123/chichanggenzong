const { pool } = require('../db');

async function readSetting(username, account, market, benchmark) {
  return pool.query(`SELECT lower_boundary_pct::float8 AS lower, upper_boundary_pct::float8 AS upper, version
     FROM analytics.graham_strategy_settings WHERE username=$1 AND account_name=$2 AND market_code=$3 AND benchmark_code=$4 AND is_current
     LIMIT 1`, [username, account, market, benchmark]);
}

async function listGrahamRows(market, benchmark) {
  return pool.query(`SELECT trade_date::text AS trade_date, pe::float8 AS pe, earnings_yield_pct::float8 AS earnings_yield_pct,
                       sovereign_yield_pct::float8 AS sovereign_yield_pct, sovereign_yield_date::text AS sovereign_yield_date,
                       graham_index_pct::float8 AS graham_index_pct, data_status
                FROM analytics.graham_index_daily WHERE market_code=$1 AND benchmark_code=$2 ORDER BY trade_date`, [market, benchmark]);
}

async function latestGrahamRow(market, benchmark) {
  return pool.query(`SELECT trade_date::text AS trade_date, pe::float8 AS pe, earnings_yield_pct::float8 AS earnings_yield_pct,
                       sovereign_yield_pct::float8 AS sovereign_yield_pct, sovereign_yield_date::text AS sovereign_yield_date,
                       graham_index_pct::float8 AS graham_index_pct, data_status
                FROM analytics.graham_index_daily WHERE market_code=$1 AND benchmark_code=$2
                ORDER BY trade_date DESC LIMIT 1`, [market, benchmark]);
}

async function readGrahamHistory(market, benchmark, cutoffDate) {
  const params = [market, benchmark];
  let cutoff = '';
  if (cutoffDate) { params.push(cutoffDate); cutoff = 'AND trade_date >= $3::date'; }
  return pool.query(`SELECT trade_date::text AS date, graham_index_pct::float8 AS value, pe::float8 AS pe,
    sovereign_yield_pct::float8 AS sovereign_yield_pct, data_status
    FROM analytics.graham_index_daily WHERE market_code=$1 AND benchmark_code=$2 ${cutoff} ORDER BY trade_date`, params);
}

async function writeSetting(username, account, market, benchmark, pair, nextVersion) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE analytics.graham_strategy_settings SET is_current=false WHERE username=$1 AND account_name=$2 AND market_code=$3 AND benchmark_code=$4 AND is_current`, [username, account, market, benchmark]);
    await client.query(`INSERT INTO analytics.graham_strategy_settings(username,account_name,market_code,benchmark_code,lower_boundary_pct,upper_boundary_pct,version)
      VALUES($1,$2,$3,$4,$5,$6,$7)`, [username, account, market, benchmark, pair.lower, pair.upper, nextVersion]);
    await client.query('COMMIT');
    return;
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

module.exports = { readSetting, listGrahamRows, latestGrahamRow, readGrahamHistory, writeSetting };

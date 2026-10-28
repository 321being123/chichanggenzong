const { pool } = require('../db');

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


async function readSetting(username, account, metric, market, benchmark) {
  return pool.query(`SELECT lower_boundary::float8 AS lower, upper_boundary::float8 AS upper, version
    FROM analytics.market_cycle_strategy_settings
    WHERE username=$1 AND account_name=$2 AND metric_code=$3 AND market_code=$4 AND benchmark_code=$5 AND is_current
    LIMIT 1`, [username, account, metric, market, benchmark]);
}

async function readIndexPoint(name) {
  return pool.query('SELECT close::float8 AS value, date::text AS trade_date FROM index_history WHERE name=$1 ORDER BY date DESC LIMIT 1', [name]);
}

async function writeSetting(username, account, metric, market, benchmark, lower, upper, nextVersion) {
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
    return;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { metricRows, readSetting, readIndexPoint, writeSetting };

const { pool } = require('../db/connection');

async function latestAnalysisDate() {
  return pool.query(`SELECT max(NULLIF(snapshot.payload->>'latest_market_trade_date','')::date)::text AS data_as_of
       FROM analytics.stock_overview_latest latest
       JOIN LATERAL (
         SELECT payload FROM analytics.analysis_snapshots
          WHERE instrument_id=latest.instrument_id AND as_of_date=latest.as_of_date AND snapshot_type='stock_analysis'
          ORDER BY created_at DESC LIMIT 1
       ) snapshot ON true`);
}

async function listActiveUsers() {
  return pool.query('SELECT username FROM users WHERE status=$1', ['active']);
}

module.exports = { latestAnalysisDate, listActiveUsers };

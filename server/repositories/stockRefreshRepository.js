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


function verifiedStockDataDateQuery1(executor, ...args) { return executor(`SELECT COUNT(*)::int AS expected_count,
      (SELECT COUNT(*) FROM market.trade_calendar WHERE exchange='SSE'
        AND trade_date>$2::date AND trade_date<=$3::date)::int AS calendar_count,
      ($3::date-$2::date)::int AS calendar_days,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM market.stock_suspend_calendar s
        WHERE s.instrument_id=i.instrument_id AND s.trade_date=c.trade_date AND s.suspend_type='S'))::int AS suspended_count
    FROM market.trade_calendar c CROSS JOIN core.instruments i
    WHERE i.canonical_code=$1 AND c.exchange='SSE' AND c.is_open
      AND c.trade_date>$2::date AND c.trade_date<=$3::date`, ...args); }

function activeStockScopeQuery1(executor, ...args) { return executor(`SELECT canonical_code,delist_date::text FROM core.instruments
    WHERE canonical_code=ANY($1::text[]) AND status='delisted' AND delist_date<=$2::date`, ...args); }

module.exports = {
  verifiedStockDataDateQuery1, activeStockScopeQuery1, latestAnalysisDate, listActiveUsers };

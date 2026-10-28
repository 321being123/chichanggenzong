const { pool } = require('../db/connection');

// 自 server/jobs/convertibleBondRefresh.js 抽取的 SQL 执行函数：语句原样搬迁，返回 pg 原始结果（rows/rowCount），调用方零改动。
async function select_analytics_convertible_bond_valuation_daily(params, client = pool) {
  return client.query(`SELECT COUNT(*)::int AS count FROM analytics.convertible_bond_valuation_daily WHERE trade_date=$1::date`, params);
}

async function select_analytics_convertible_bond_valuation_models(params, client = pool) {
  return client.query(`SELECT model_version FROM analytics.convertible_bond_valuation_models WHERE is_active LIMIT 1`);
}

async function update_ops_sync_cursors(params, client = pool) {
  return client.query(`UPDATE ops.sync_cursors
          SET last_attempt_at=now(), last_error=$1, retry_count=retry_count+1, updated_at=now()
        WHERE scope_key='convertible_bond_valuation' AND dataset_code='daily_valuation'`, params);
}

async function select_fundamental_convertible_bond_profiles(params, client = pool) {
  return client.query(`SELECT COUNT(*)::int AS count FROM fundamental.convertible_bond_profiles`);
}

async function select_market_convertible_bond_daily_metrics(params, client = pool) {
  return client.query(`SELECT
       COALESCE((SELECT MAX(trade_date) >= $1::date FROM market.convertible_bond_daily_metrics), false) AS cycle_complete,
       COALESCE((SELECT MAX(trade_date) >= $1::date FROM analytics.convertible_bond_valuation_daily), false) AS valuation_complete,
       COALESCE((SELECT MAX(trade_date) >= $1::date FROM analytics.convertible_bond_list_metrics_daily), false) AS list_complete,
       COALESCE((SELECT last_success_date >= $1::date FROM ops.sync_cursors
                  WHERE scope_key='convertible_bond_universe' AND dataset_code='cb_basic_cb_daily'), false) AS universe_complete,
       COALESCE((SELECT COUNT(*) FROM ops.data_quality_issues
                  WHERE issue_type='snapshot_input_mismatch' AND status='open'), 0)::int AS open_conv_price_issues,
       COALESCE((SELECT COUNT(*) FROM (
           SELECT DISTINCT ON (s.instrument_id)
                  (s.payload->'basic'->>'convert_price')::numeric AS snap_price, p.current_conv_price
             FROM analytics.analysis_snapshots s
             JOIN fundamental.convertible_bond_profiles p ON p.instrument_id = s.instrument_id
            WHERE s.snapshot_type='convertible_bond_analysis'
            ORDER BY s.instrument_id, s.as_of_date DESC, s.created_at DESC
         ) t WHERE t.snap_price IS NOT NULL AND t.current_conv_price IS NOT NULL
             AND abs(t.snap_price - t.current_conv_price) > 0.001), 0)::int AS stale_snapshots`, params);
}

async function with_market_convertible_bond_daily_metrics(params, client = pool) {
  return client.query(`
      WITH market_date AS (
        SELECT MAX(trade_date)::date AS trade_date FROM market.convertible_bond_daily_metrics
      ), eligible AS (
        SELECT p.instrument_id
          FROM fundamental.convertible_bond_profiles p
          JOIN core.instruments i ON i.instrument_id=p.instrument_id
          LEFT JOIN fundamental.convertible_bond_issuance iss ON iss.instrument_id=p.instrument_id
          JOIN public.bond_unified u ON u.instrument_id=i.instrument_id
          JOIN market.convertible_bond_daily_metrics dm
            ON dm.instrument_id=p.instrument_id AND dm.trade_date=(SELECT trade_date FROM market_date)
         WHERE i.asset_class='convertible_bond' AND i.status='listed' AND u.status='listed'
           AND (iss.issue_type IS NULL OR iss.issue_type NOT IN ('定向','私募'))
           AND (i.list_date IS NULL OR i.list_date <= (SELECT trade_date FROM market_date))
           AND (i.delist_date IS NULL OR i.delist_date > (SELECT trade_date FROM market_date))
           AND (u.maturity_date IS NULL OR u.maturity_date >= (SELECT trade_date FROM market_date))
           AND (u.conv_end_date IS NULL OR u.conv_end_date >= (SELECT trade_date FROM market_date))
           AND (u.conv_stop_date IS NULL OR u.conv_stop_date > (SELECT trade_date FROM market_date))
      ), calculated AS (
        SELECT COUNT(DISTINCT instrument_id)::int AS count
          FROM analytics.convertible_bond_trigger_daily
         WHERE trigger_type='call' AND formula_version='call-v1'
           AND trade_date=(SELECT trade_date FROM market_date)
      )
      SELECT (SELECT trade_date::text FROM market_date) AS trade_date,
             (SELECT COUNT(*)::int FROM eligible) AS eligible_count,
             calculated.count AS calculated_count
        FROM calculated`);
}

async function select_market_convertible_bond_daily_metrics_1(params, client = pool) {
  return client.query(`
      SELECT
        (SELECT MAX(trade_date)::text FROM market.convertible_bond_daily_metrics) AS market_date,
        (SELECT MAX(trade_date)::text FROM analytics.convertible_bond_trigger_daily
          WHERE trigger_type='reset' AND formula_version='reset-v2') AS state_date,
        (SELECT MAX(trade_date)::text FROM analytics.convertible_bond_revision_motive_daily
           WHERE model_version=$2) AS motive_date,
        (SELECT COALESCE(bool_and(COALESCE(diagnostics->>'calculation_logic_version','') = $1), false)
           FROM analytics.convertible_bond_trigger_daily
          WHERE trigger_type='reset' AND formula_version='reset-v2'
            AND trade_date=(SELECT MAX(trade_date) FROM market.convertible_bond_daily_metrics)) AS logic_version_current,
        (SELECT last_success_date::text FROM ops.sync_cursors
          WHERE scope_key='convertible_bond_announcement_history' AND dataset_code='official_announcements') AS announcement_date,
        (SELECT COUNT(*)::int FROM (
           SELECT DISTINCT ON (instrument_id)
                  instrument_id,parser_version,valid_until,next_eligible_date,raw_payload
             FROM analytics.convertible_bond_announcement_history
            WHERE fact_type='no_revision'
            ORDER BY instrument_id,announced_at DESC,fact_id DESC
        ) latest_no_revision
         WHERE ((parser_version IS DISTINCT FROM '7'
                 AND (next_eligible_date IS NULL
                      OR NOT COALESCE((raw_payload->>'lock_declared')::boolean,false)))
                OR (next_eligible_date IS NULL
                    AND NOT (COALESCE((raw_payload->>'no_revision_evidence')::boolean,false)
                             OR COALESCE((raw_payload->>'lock_declared')::boolean,false)))
                OR (parser_version = '7'
                    AND EXISTS (
                      SELECT 1 FROM fundamental.convertible_bond_profiles maturity_profile
                       WHERE maturity_profile.instrument_id=latest_no_revision.instrument_id
                         AND (latest_no_revision.next_eligible_date=maturity_profile.maturity_date
                              OR latest_no_revision.valid_until=maturity_profile.maturity_date)
                    )
                    AND COALESCE(raw_payload->'reparse'->>'status','') <> 'maturity_checked'))
           AND COALESCE(raw_payload->'reparse'->>'status','') <> 'failed') AS pending_parse,
        (SELECT COUNT(*)::int FROM ops.sync_cursors
          WHERE scope_key='convertible_bond_announcement_history' AND dataset_code='official_announcements'
            AND NULLIF(last_error,'') IS NOT NULL) AS announcement_errors,
        (SELECT MAX(trade_date)::text FROM market.trade_calendar
          WHERE exchange='SSE' AND is_open
             AND trade_date <= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date) AS expected_date`, params);
}

module.exports = {
  select_analytics_convertible_bond_valuation_daily,
  select_analytics_convertible_bond_valuation_models,
  update_ops_sync_cursors,
  select_fundamental_convertible_bond_profiles,
  select_market_convertible_bond_daily_metrics,
  with_market_convertible_bond_daily_metrics,
  select_market_convertible_bond_daily_metrics_1,
};

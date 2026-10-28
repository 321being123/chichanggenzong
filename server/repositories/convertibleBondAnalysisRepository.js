const { pool } = require('../db/connection');

// 自 server/services/convertibleBondAnalysis.js 迁入的数据读写函数（只做标准事实读写，业务判定仍留在服务层）。

async function getResetNetAssetFloor(instrumentId, asOf) {
  const { rows } = await pool.query(
    `SELECT CASE WHEN net_asset_floor_applicable THEN true
                 WHEN parse_status='complete' THEN false ELSE NULL END AS applicable
       FROM fundamental.convertible_bond_terms
      WHERE instrument_id=$1 AND term_type='reset' AND effective_from<=$2::date
        AND (effective_to IS NULL OR effective_to>$2::date)
      ORDER BY effective_from DESC LIMIT 1`, [instrumentId, asOf]);
  return rows[0]?.applicable ?? null;
}

async function select_fundamental_convertible_bond_profiles(params, client = pool) {
  return client.query(`SELECT p.*,i.canonical_code,s.canonical_code AS stock_code,s.name AS stock_name,
            i.delist_date::text AS instrument_delist_date
       FROM fundamental.convertible_bond_profiles p
       JOIN core.instruments i USING(instrument_id)
       LEFT JOIN core.instruments s ON s.instrument_id=p.stock_instrument_id
      WHERE i.canonical_code=$1`, params);
}

async function select_market_convertible_bond_daily_metrics(params, client = pool) {
  return client.query(`SELECT MAX(trade_date)::text AS date FROM market.convertible_bond_daily_metrics WHERE instrument_id=$1`, params);
}

async function select_fundamental_financial_reports(params, client = pool) {
  return client.query(`SELECT r.report_kind,r.period_end::text,r.raw_payload FROM fundamental.financial_reports r
      JOIN core.company_instruments ci ON ci.company_id=r.company_id
      WHERE ci.instrument_id=$1 AND r.announced_at<=$2::date AND r.period_end<=$2::date
      ORDER BY r.period_end DESC,r.announced_at DESC`, params);
}

async function select_market_trade_calendar(params, client = pool) {
  return client.query(`SELECT trade_date::text AS cal_date,CASE WHEN is_open THEN '1' ELSE '0' END AS is_open FROM market.trade_calendar
      WHERE exchange='SSE' AND trade_date>=$1::date ORDER BY trade_date`, params);
}

async function select_event_company_events(params, client = pool) {
  return client.query(`SELECT e.event_date::text,e.title,e.details FROM event.company_events e
    JOIN core.company_instruments ci ON ci.company_id=e.company_id
    WHERE ci.instrument_id=$1 AND e.event_date<=$2::date AND e.title LIKE '%回售%'`, params);
}

async function select_analytics_convertible_bond_revision_latest(params, client = pool) {
  return client.query(`SELECT trigger_price,matched_days,trigger_required_days,required_days,calculated_status,
    business_status,data_status,no_revision_valid_until::text,next_eligible_date::text
    FROM analytics.convertible_bond_revision_latest WHERE instrument_id=$1 AND trade_date=$2::date AND formula_version='reset-v2'`, params);
}

async function insert_analytics_analysis_snapshots(params, client = pool) {
  return client.query(`INSERT INTO analytics.analysis_snapshots(instrument_id,as_of_date,snapshot_type,formula_bundle_version,payload,source_watermark)
     VALUES($1,$2,'convertible_bond_analysis',$3,$4::jsonb,$5::jsonb)
     ON CONFLICT(instrument_id,as_of_date,snapshot_type,formula_bundle_version) DO UPDATE SET payload=EXCLUDED.payload,
       source_watermark=EXCLUDED.source_watermark,created_at=now()`, params);
}

async function select_fundamental_convertible_bond_terms(params, client = pool) {
  return client.query(`SELECT DISTINCT ON (term_type) term_type, clause_text
     FROM fundamental.convertible_bond_terms
     WHERE instrument_id = $1
       AND effective_from <= $2::date
       AND (effective_to IS NULL OR effective_to > $2::date)
     ORDER BY term_type, effective_from DESC`, params);
}

async function select_core_instruments(params, client = pool) {
  return client.query(`SELECT s.payload,s.created_at,s.formula_bundle_version,s.source_watermark,
            p.current_conv_price,p.source_updated_at,p.updated_at AS profile_updated_at,
            p.stock_instrument_id,p.newest_rating AS profile_rating,p.raw_payload->'analysis_inputs' AS analysis_inputs,
            i.instrument_id,i.status,i.delist_date
     FROM core.instruments i JOIN analytics.analysis_snapshots s ON s.instrument_id=i.instrument_id
     LEFT JOIN fundamental.convertible_bond_profiles p ON p.instrument_id=i.instrument_id
     WHERE i.canonical_code=$1 AND s.snapshot_type='convertible_bond_analysis'
     ORDER BY s.as_of_date DESC,s.created_at DESC LIMIT 1`, params);
}

async function select_market_daily_bars(params, client = pool) {
  return client.query(`SELECT (SELECT max(trade_date) FROM market.daily_bars WHERE instrument_id=$1) AS bond_date,
            (SELECT max(change_date) FROM fundamental.convertible_bond_price_changes WHERE instrument_id=$1) AS conv_change_date,
            (SELECT max(trade_date) FROM market.daily_bars WHERE instrument_id=$2) AS stock_date,
            (SELECT max(period_end) FROM fundamental.financial_reports fr
               JOIN core.company_instruments ci ON ci.company_id=fr.company_id
               WHERE ci.instrument_id=$2) AS report_end_date`, params);
}

module.exports = {
  getResetNetAssetFloor,
  select_fundamental_convertible_bond_profiles,
  select_market_convertible_bond_daily_metrics,
  select_fundamental_financial_reports,
  select_market_trade_calendar,
  select_event_company_events,
  select_analytics_convertible_bond_revision_latest,
  insert_analytics_analysis_snapshots,
  select_fundamental_convertible_bond_terms,
  select_core_instruments,
  select_market_daily_bars,
};

const { pool } = require('../db/connection');

// 自 server/services/repoDailyRates.js 抽取的 SQL 执行函数：语句原样搬迁，返回 pg 原始结果（rows/rowCount），调用方零改动。
async function select_nav_history(params, client = pool) {
  return client.query(`SELECT MIN(anchor_date)::text AS start_date FROM (SELECT MAX(n.date) AS anchor_date FROM nav_history n JOIN accounts a ON a.username=n.username AND a.account_name=n.account_name
      WHERE a.cash_income_policy->>'enabled'='true' AND (n.is_locked OR n.snapshot_source='imported') AND n.date <= $1 GROUP BY a.id) anchors`, params);
}

async function select_ops_data_sources(params, client = pool) {
  return client.query(`SELECT source_id FROM ops.data_sources WHERE source_code='tushare'`);
}

async function select_market_repo_daily_rates(params, client = pool) {
  return client.query(`SELECT trade_date::text FROM market.repo_daily_rates WHERE instrument_id=$1 AND quality_status='passed' AND trade_date BETWEEN $2 AND $3`, params);
}

async function insert_ops_raw_records(params, client = pool) {
  return client.query(`INSERT INTO ops.raw_records(source_id,dataset_code,source_key,payload,payload_hash)
            VALUES($1,'repo_daily_rates',$2,$3,$4) ON CONFLICT(source_id,dataset_code,source_key,payload_hash)
            DO UPDATE SET ingested_at=now() RETURNING raw_record_id`, params);
}

async function insert_market_repo_daily_rates(params, client = pool) {
  return client.query(`INSERT INTO market.repo_daily_rates(instrument_id,trade_date,source_id,tenor_days,weighted_annual_rate,close_annual_rate,unit,raw_record_id,quality_status,source_revision)
            VALUES($1,$2,$3,1,$4,$5,'annual_decimal',$6,'passed',$7)
            ON CONFLICT(instrument_id,trade_date,source_id) DO UPDATE SET weighted_annual_rate=EXCLUDED.weighted_annual_rate,
            close_annual_rate=EXCLUDED.close_annual_rate,raw_record_id=EXCLUDED.raw_record_id,source_revision=EXCLUDED.source_revision,ingested_at=now()`, params);
}

module.exports = {
  select_nav_history,
  select_ops_data_sources,
  select_market_repo_daily_rates,
  insert_ops_raw_records,
  insert_market_repo_daily_rates,
};

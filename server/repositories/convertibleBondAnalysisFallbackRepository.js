const { pool } = require('../db/connection');

// 自 server/services/convertibleBondAnalysisFallback.js 抽取的 SQL 执行函数：语句原样搬迁，返回 pg 原始结果（rows/rowCount），调用方零改动。
async function select_data(params, client = pool) {
  return client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, params);
}

async function select_ops_raw_records(params, client = pool) {
  return client.query(`SELECT raw_record_id,payload FROM ops.raw_records WHERE dataset_code=$1 AND source_key=$2 ORDER BY raw_record_id DESC LIMIT 1`, params);
}

async function insert_ops_raw_records(params, client = pool) {
  return client.query(`INSERT INTO ops.raw_records(source_id,dataset_code,source_key,payload,payload_hash)
      SELECT source_id,$1,$2,$3::jsonb,$4 FROM ops.data_sources WHERE source_code='tushare'
      ON CONFLICT(source_id,dataset_code,source_key,payload_hash) DO UPDATE SET payload=EXCLUDED.payload RETURNING raw_record_id`, params);
}

async function select_fundamental_convertible_bond_fund_holdings(params, client = pool) {
  return client.query(`SELECT raw_payload FROM fundamental.convertible_bond_fund_holdings WHERE instrument_id=$1 AND report_date=$2::date FOR UPDATE`, params);
}

async function select_fundamental_convertible_bond_ratings(params, client = pool) {
  return client.query(`SELECT source_id,rating,rating_outlook,announced_at::text,raw_payload FROM fundamental.convertible_bond_ratings WHERE instrument_id=$1 AND rating_date=$2::date AND rating_company=$3 FOR UPDATE`, params);
}

async function select_fundamental_convertible_bond_price_changes(params, client = pool) {
  return client.query(`SELECT change_date::text,price_before,price_after FROM fundamental.convertible_bond_price_changes WHERE instrument_id=$1`, params);
}

async function select_fundamental_convertible_bond_coupon_schedule(params, client = pool) {
  return client.query(`SELECT interest_year,coupon_rate FROM fundamental.convertible_bond_coupon_schedule WHERE instrument_id=$1`, params);
}

async function insert_fundamental_convertible_bond_coupon_schedule(params, client = pool) {
  return client.query(`INSERT INTO fundamental.convertible_bond_coupon_schedule(instrument_id,interest_year,coupon_rate,pay_date,pre_tax_interest,after_tax_interest,source_id)
          VALUES($1,$2,$3,$4,$3,$5,$6) ON CONFLICT(instrument_id,interest_year) DO NOTHING`, params);
}

module.exports = {
  select_data,
  select_ops_raw_records,
  insert_ops_raw_records,
  select_fundamental_convertible_bond_fund_holdings,
  select_fundamental_convertible_bond_ratings,
  select_fundamental_convertible_bond_price_changes,
  select_fundamental_convertible_bond_coupon_schedule,
  insert_fundamental_convertible_bond_coupon_schedule,
};

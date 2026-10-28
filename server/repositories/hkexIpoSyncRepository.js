const { pool } = require('../db/connection');

// 自 server/services/hkexIpoSync.js 抽取的 SQL 执行函数：语句原样搬迁，返回 pg 原始结果（rows/rowCount），调用方零改动。
async function select_ops_data_sources(params, client = pool) {
  return client.query(`SELECT source_id FROM ops.data_sources WHERE source_code='hkex_announcements' LIMIT 1`);
}

async function insert_ops_ingestion_runs(params, client = pool) {
  return client.query(`INSERT INTO ops.ingestion_runs(source_id,dataset_code,request_range,status)
     VALUES($1,'hkex_ipo_history_report',$2::jsonb,'running') RETURNING run_id`, params);
}

async function insert_ops_raw_records(params, client = pool) {
  return client.query(`INSERT INTO ops.raw_records(run_id,source_id,dataset_code,source_key,source_updated_at,payload,payload_hash)
         VALUES($1,$2,'hkex_ipo_history_report',$3,now(),$4::jsonb,$5)
         ON CONFLICT(source_id,dataset_code,source_key,payload_hash) DO UPDATE SET run_id=EXCLUDED.run_id,ingested_at=now()`, params);
}

async function update_ops_ingestion_runs(params, client = pool) {
  return client.query(`UPDATE ops.ingestion_runs SET status=$2,row_count=$3,error_message=$4,finished_at=now() WHERE run_id=$1`, params);
}

async function update_ops_ingestion_runs_1(params, client = pool) {
  return client.query(`UPDATE ops.ingestion_runs SET status='failed',error_message=$2,finished_at=now() WHERE run_id=$1`, params);
}

module.exports = {
  select_ops_data_sources,
  insert_ops_ingestion_runs,
  insert_ops_raw_records,
  update_ops_ingestion_runs,
  update_ops_ingestion_runs_1,
};

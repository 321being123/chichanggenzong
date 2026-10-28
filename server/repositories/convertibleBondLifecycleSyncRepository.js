const { pool } = require('../db/connection');



// 自 server/services/convertibleBondLifecycleSync.js 迁入的数据读写函数（只做标准事实读写，业务判定仍留在服务层）。

async function sourceIds(client) {
  const { rows } = await client.query("SELECT source_id,source_code FROM ops.data_sources WHERE source_code IN ('tushare','cninfo','sse','szse')");
  return Object.fromEntries(rows.map(row => [row.source_code, row.source_id]));
}

async function insert_fundamental_convertible_bond_profiles(params, client = pool) {
  return client.query(`INSERT INTO fundamental.convertible_bond_profiles
       (instrument_id,bond_full_name,bond_short_name,cb_type,issue_price,issue_size,source_id,raw_payload,source_updated_at)
     VALUES($1,$2,$2,'CB',$3,$4,$5,$6::jsonb,now())
     ON CONFLICT(instrument_id) DO UPDATE SET
       bond_full_name=CASE WHEN EXCLUDED.bond_full_name<>'' THEN EXCLUDED.bond_full_name ELSE fundamental.convertible_bond_profiles.bond_full_name END,
       -- 公告解析出的简称常带「可转换公司」等体裁残留（如「国科转债2、可转换公司」），
       -- 只在现有简名为空时写入，已由 cb_basic 官方简称填充的主档不被降级覆盖。
       bond_short_name=CASE WHEN COALESCE(BTRIM(fundamental.convertible_bond_profiles.bond_short_name),'')=''
                            THEN EXCLUDED.bond_short_name
                            ELSE fundamental.convertible_bond_profiles.bond_short_name END,
       issue_price=COALESCE(fundamental.convertible_bond_profiles.issue_price,EXCLUDED.issue_price),
       issue_size=COALESCE(fundamental.convertible_bond_profiles.issue_size,EXCLUDED.issue_size),
       raw_payload=fundamental.convertible_bond_profiles.raw_payload || EXCLUDED.raw_payload,updated_at=now()`, params);
}

async function insert_event_instrument_events(params, client = pool) {
  return client.query(`INSERT INTO event.instrument_events(instrument_id,event_type,event_date,source_id,source_key,details,source_updated_at)
     VALUES($1,$2,$3::date,$4,$5,$6::jsonb,now())
     ON CONFLICT(instrument_id,event_type,event_date) DO UPDATE SET
       source_id=CASE WHEN $7::boolean THEN EXCLUDED.source_id ELSE event.instrument_events.source_id END,
       source_key=CASE WHEN $7::boolean THEN EXCLUDED.source_key ELSE event.instrument_events.source_key END,
       details=event.instrument_events.details || EXCLUDED.details,source_updated_at=now(),updated_at=now()`, params);
}

async function insert_ops_raw_records(params, client = pool) {
  return client.query(`INSERT INTO ops.raw_records(run_id,source_id,dataset_code,source_key,payload,payload_hash)
     VALUES($1,$2,'cb_issue',$3,$4::jsonb,$5)
     ON CONFLICT(source_id,dataset_code,source_key,payload_hash) DO NOTHING`, params);
}

async function insert_fundamental_convertible_bond_issuance(params, client = pool) {
  return client.query(`INSERT INTO fundamental.convertible_bond_issuance
       (instrument_id,issue_type,issue_price_yuan,issue_size_100m_yuan,shareholder_allotment_ratio_yuan_per_share,
        online_size_100m_yuan,offline_size_100m_yuan,online_purchase_accounts_10k,shareholder_allotment_quantity,source_id,source_updated_at,raw_payload)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),$11::jsonb)
     ON CONFLICT(instrument_id) DO UPDATE SET
       issue_type=COALESCE(EXCLUDED.issue_type,fundamental.convertible_bond_issuance.issue_type),
       issue_price_yuan=COALESCE(EXCLUDED.issue_price_yuan,fundamental.convertible_bond_issuance.issue_price_yuan),
       issue_size_100m_yuan=COALESCE(EXCLUDED.issue_size_100m_yuan,fundamental.convertible_bond_issuance.issue_size_100m_yuan),
       shareholder_allotment_ratio_yuan_per_share=COALESCE(EXCLUDED.shareholder_allotment_ratio_yuan_per_share,fundamental.convertible_bond_issuance.shareholder_allotment_ratio_yuan_per_share),
       online_size_100m_yuan=COALESCE(EXCLUDED.online_size_100m_yuan,fundamental.convertible_bond_issuance.online_size_100m_yuan),
       offline_size_100m_yuan=COALESCE(EXCLUDED.offline_size_100m_yuan,fundamental.convertible_bond_issuance.offline_size_100m_yuan),
       online_purchase_accounts_10k=COALESCE(EXCLUDED.online_purchase_accounts_10k,fundamental.convertible_bond_issuance.online_purchase_accounts_10k),
       shareholder_allotment_quantity=COALESCE(EXCLUDED.shareholder_allotment_quantity,fundamental.convertible_bond_issuance.shareholder_allotment_quantity),
       raw_payload=fundamental.convertible_bond_issuance.raw_payload || EXCLUDED.raw_payload,source_updated_at=now(),updated_at=now()`, params);
}

async function update_core_instruments(params, client = pool) {
  return client.query(`UPDATE core.instruments SET list_date=$2::date,status=CASE WHEN $2::date>CURRENT_DATE THEN 'pending_listing' ELSE 'listed' END,updated_at=now()
        WHERE instrument_id=$1 AND (list_date IS NULL OR list_date<>$2::date)`, params);
}

async function select_ops_sync_cursors(params, client = pool) {
  return client.query(`SELECT last_success_date::text FROM ops.sync_cursors WHERE scope_key='convertible_bond_lifecycle' AND dataset_code='cb_issue'`);
}

async function insert_ops_ingestion_runs(params, client = pool) {
  return client.query(`INSERT INTO ops.ingestion_runs(source_id,dataset_code,request_range,status)
       VALUES($1,'bond_lifecycle',$2::jsonb,'running') RETURNING run_id`, params);
}

async function with_jsonb_to_recordset(params, client = pool) {
  return client.query(`WITH expected AS (
           SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(code text,event_type text,event_date date)
         )
         SELECT x.code,x.event_type,x.event_date::text
           FROM expected x
           LEFT JOIN core.instruments i ON i.canonical_code=x.code
           LEFT JOIN event.instrument_events e ON e.instrument_id=i.instrument_id
             AND e.event_type=x.event_type AND e.event_date=x.event_date
          WHERE e.event_id IS NULL`, params);
}

async function insert_ops_sync_cursors(params, client = pool) {
  return client.query(`INSERT INTO ops.sync_cursors(scope_key,dataset_code,last_success_date,last_source_update,last_attempt_at,last_error,retry_count)
         VALUES('convertible_bond_lifecycle','cb_issue',$1,now(),now(),'',0)
         ON CONFLICT(scope_key,dataset_code) DO UPDATE SET last_success_date=EXCLUDED.last_success_date,last_source_update=now(),
           last_attempt_at=now(),last_error='',retry_count=0,updated_at=now()`, params);
}

async function update_ops_ingestion_runs(params, client = pool) {
  return client.query(`UPDATE ops.ingestion_runs SET status='success',row_count=$2,finished_at=now() WHERE run_id=$1`, params);
}

async function update_ops_ingestion_runs_1(params, client = pool) {
  return client.query(`UPDATE ops.ingestion_runs SET status='failed',error_message=$2,finished_at=now() WHERE run_id=$1`, params);
}

module.exports = {
  sourceIds,
  insert_fundamental_convertible_bond_profiles,
  insert_event_instrument_events,
  insert_ops_raw_records,
  insert_fundamental_convertible_bond_issuance,
  update_core_instruments,
  select_ops_sync_cursors,
  insert_ops_ingestion_runs,
  with_jsonb_to_recordset,
  insert_ops_sync_cursors,
  update_ops_ingestion_runs,
  update_ops_ingestion_runs_1,
};

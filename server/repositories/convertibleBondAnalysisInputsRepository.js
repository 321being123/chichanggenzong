const { pool } = require('../db/connection');

// 自 server/services/convertibleBondAnalysisInputs.js 迁入的数据读写函数（只做标准事实读写，业务判定仍留在服务层）。

async function persistBondInputs(bond,state) {
  // 人工留证的终态优先于已启动Runner的旧快照，避免续批将刚登记的证据覆盖掉。
  await pool.query(`UPDATE fundamental.convertible_bond_profiles SET raw_payload=raw_payload||jsonb_build_object('analysis_inputs',
    $2::jsonb || CASE WHEN (raw_payload->'analysis_inputs') ? 'terminal_gaps' THEN jsonb_build_object('terminal_gaps',
      COALESCE($2::jsonb->'terminal_gaps','{}'::jsonb)||(raw_payload->'analysis_inputs'->'terminal_gaps')) ELSE '{}'::jsonb END),updated_at=now()
    WHERE instrument_id=$1`,[bond.instrument_id,JSON.stringify(state)]);
}

async function readDocuments(bond,targetDate) {
  const {rows}=await pool.query(`SELECT DISTINCT d.document_id,d.url,d.title,d.content_hash,d.announced_at::text AS event_date,
    ds.source_code AS source,d.raw_payload FROM event.documents d
    JOIN ops.data_sources ds USING(source_id) JOIN core.company_instruments ci USING(company_id)
    JOIN core.instruments i ON i.instrument_id=ci.instrument_id
    WHERE i.canonical_code=$1 AND d.announced_at<=$2::date AND d.url<>'' ORDER BY event_date DESC`,[bond.stock_code,targetDate]);
  return rows;
}

async function readRatingHistory(bond,targetDate) {
  if(!bond.instrument_id)return [];
  const {rows}=await pool.query(`SELECT rating_date::text,announced_at::text,rating_company,rating,rating_outlook,raw_payload
    FROM fundamental.convertible_bond_ratings WHERE instrument_id=$1 AND rating_date<=$2::date
      AND (announced_at IS NULL OR announced_at<=$2::date) ORDER BY rating_date DESC,announced_at DESC`,[bond.instrument_id,targetDate]);
  return rows;
}

async function select_ops_sync_cursors(params, client = pool) {
  return client.query(`SELECT last_success_date::text FROM ops.sync_cursors WHERE scope_key=$1 AND dataset_code='official_documents'`, params);
}

async function select_fundamental_convertible_bond_profiles(params, client = pool) {
  return client.query(`SELECT MIN(p.value_date)::text AS date FROM fundamental.convertible_bond_profiles p
    JOIN core.instruments s ON s.instrument_id=p.stock_instrument_id WHERE s.canonical_code=$1`, params);
}

async function with_ops_raw_records(params, client = pool) {
  return client.query(`WITH saved AS (
      INSERT INTO ops.raw_records(source_id,dataset_code,source_key,payload,payload_hash)
      SELECT source_id,'official_company_announcements',source_key,payload,payload_hash FROM
      jsonb_to_recordset($1::jsonb) AS r(source_id smallint,source_key text,payload jsonb,payload_hash text)
      ON CONFLICT(source_id,dataset_code,source_key,payload_hash) DO UPDATE SET payload=EXCLUDED.payload
      RETURNING raw_record_id,source_id,payload
    ) UPDATE event.documents d SET raw_record_id=saved.raw_record_id FROM saved
      WHERE d.source_id=saved.source_id AND d.url=saved.payload->>'url'`, params);
}

async function insert_ops_sync_cursors(params, client = pool) {
  return client.query(`INSERT INTO ops.sync_cursors(scope_key,dataset_code,last_success_date,cursor_payload,last_attempt_at)
      VALUES($1,'official_documents',$2,$3::jsonb,now()) ON CONFLICT(scope_key,dataset_code) DO UPDATE SET
      last_success_date=GREATEST(ops.sync_cursors.last_success_date,EXCLUDED.last_success_date),cursor_payload=EXCLUDED.cursor_payload,last_attempt_at=now(),updated_at=now()`, params);
}

async function select_fundamental_convertible_bond_ratings(params, client = pool) {
  return client.query(`SELECT rating,raw_payload FROM fundamental.convertible_bond_ratings
        WHERE instrument_id=$1 AND rating_date=$2::date AND rating_company=$3 AND raw_payload->>'rating_date_source'='official_document'`, params);
}

async function insert_ops_raw_records(params, client = pool) {
  return client.query(`INSERT INTO ops.raw_records(source_id,dataset_code,source_key,payload,payload_hash)
      VALUES($1,'bond_analysis_inputs',$2,$3::jsonb,$4) ON CONFLICT(source_id,dataset_code,source_key,payload_hash)
      DO UPDATE SET payload=EXCLUDED.payload RETURNING raw_record_id`, params);
}

async function update_event_documents(params, client = pool) {
  return client.query(`UPDATE event.documents d SET content_hash=CASE WHEN NOT EXISTS(SELECT 1 FROM event.documents other
      WHERE other.source_id=d.source_id AND other.url=d.url AND other.content_hash=$2 AND other.document_id<>d.document_id) THEN $2 ELSE d.content_hash END,raw_record_id=$3,
      raw_payload=raw_payload || jsonb_build_object('analysis_projections',COALESCE(raw_payload->'analysis_projections','{}'::jsonb)||$4::jsonb)
    WHERE document_id=$1`, params);
}

async function select_fundamental_convertible_bond_ratings_1(params, client = pool) {
  return client.query(`SELECT DISTINCT rating_date::text AS date FROM fundamental.convertible_bond_ratings
          WHERE instrument_id=$1 AND announced_at=$2::date AND rating=$4 AND
          (source_id=$3 OR (raw_payload->>'ts_code'=$5 AND raw_payload->>'ann_date'=replace($2::text,'-','') AND raw_payload ? 'rating_way'))`, params);
}

async function delete_fundamental_convertible_bond_ratings(params, client = pool) {
  return client.query(`DELETE FROM fundamental.convertible_bond_ratings WHERE instrument_id=$1
        AND raw_payload->>'source_url'=$2 AND raw_payload ? 'document_hash' AND NOT(rating_date=ANY($3::date[]))`, params);
}

async function select_fundamental_convertible_bond_ratings_2(params, client = pool) {
  return client.query(`SELECT rating FROM fundamental.convertible_bond_ratings WHERE instrument_id=$1
          AND rating_date=$2::date AND rating_company=$3 AND raw_payload->>'rating_date_source'='official_document'
          AND raw_payload->>'rating_grade_context_version'='current-grade-v1'
          AND (raw_payload->>'rating_date_context' IN ('current_explicit_label','current_summary_table','current_report_issuance')
            OR raw_payload->'identity_binding'->>'validated'='true')`, params);
}

async function update_fundamental_convertible_bond_ratings(params, client = pool) {
  return client.query(`UPDATE fundamental.convertible_bond_ratings SET source_id=$3
        WHERE instrument_id=$1 AND raw_payload->>'source_url'=$2 AND rating_date=ANY($4::date[])`, params);
}

async function select_fundamental_convertible_bond_profiles_1(params, client = pool) {
  return client.query(`SELECT p.instrument_id,p.raw_payload FROM fundamental.convertible_bond_profiles p
    JOIN core.instruments i ON i.instrument_id=p.instrument_id WHERE i.canonical_code=$1`, params);
}

async function update_fundamental_convertible_bond_profiles(params, client = pool) {
  return client.query(`UPDATE fundamental.convertible_bond_profiles SET raw_payload=jsonb_set(raw_payload,'{analysis_inputs}',
    COALESCE(raw_payload->'analysis_inputs','{}'::jsonb)||jsonb_build_object('terminal_gaps',
      COALESCE(raw_payload->'analysis_inputs'->'terminal_gaps','{}'::jsonb)||jsonb_build_object($2::text,$3::jsonb)),true),updated_at=now()
    WHERE instrument_id=$1`, params);
}

async function select_ops_sync_cursors_1(params, client = pool) {
  return client.query(`SELECT cursor_payload FROM ops.sync_cursors WHERE scope_key=$1 AND dataset_code='inputs'`, params);
}


function suspectRatingUrlsQuery1(executor, ...args) { return executor(`SELECT DISTINCT raw_payload->>'source_url' AS url FROM fundamental.convertible_bond_ratings
    WHERE instrument_id=$1 AND raw_payload->>'rating_date_source'='official_document'
    AND ((raw_payload->>'rating_context_version' IS DISTINCT FROM 'current-narrative-v2'
      AND NOT raw_payload ? 'identity_binding' AND rating_date<date_trunc('year',announced_at))
      OR (raw_payload->>'text_method'='rapidocr-onnx-v1' AND rating='AA'
        AND raw_payload->>'rating_evidence' LIKE '%信用等级%'
        AND raw_payload->>'rating_grade_context_version' IS DISTINCT FROM 'current-grade-v1'))`, ...args); }

function initialRatingBindingArgumentsQuery1(executor, ...args) { return executor(`SELECT COUNT(*)::int AS matches,BOOL_OR(p.instrument_id=$3) AS is_target FROM fundamental.convertible_bond_profiles p
    JOIN core.instruments s ON s.instrument_id=p.stock_instrument_id WHERE s.canonical_code=$1 AND p.issue_size=$2
    AND p.value_date BETWEEN $4::date AND $5::date`, ...args); }

module.exports = {
  suspectRatingUrlsQuery1, initialRatingBindingArgumentsQuery1,
  persistBondInputs,
  readDocuments,
  readRatingHistory,
  select_ops_sync_cursors,
  select_fundamental_convertible_bond_profiles,
  with_ops_raw_records,
  insert_ops_sync_cursors,
  select_fundamental_convertible_bond_ratings,
  insert_ops_raw_records,
  update_event_documents,
  select_fundamental_convertible_bond_ratings_1,
  delete_fundamental_convertible_bond_ratings,
  select_fundamental_convertible_bond_ratings_2,
  update_fundamental_convertible_bond_ratings,
  select_fundamental_convertible_bond_profiles_1,
  update_fundamental_convertible_bond_profiles,
  select_ops_sync_cursors_1,
};

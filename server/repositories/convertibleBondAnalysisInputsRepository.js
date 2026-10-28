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

module.exports = {
  persistBondInputs,
  readDocuments,
  readRatingHistory,
};

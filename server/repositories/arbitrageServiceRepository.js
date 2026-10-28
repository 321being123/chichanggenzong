const { pool } = require('../db/connection');

// 自 server/services/arbitrageService.js 迁入的数据读写函数（只做标准事实读写，业务判定仍留在服务层）。

async function getCandidates(page = 1, pageSize = 50, status = 'pending') {
  const offset = (page - 1) * pageSize;
  const { rows } = await pool.query(`
    SELECT c.*, i.canonical_code, i.name
    FROM event.arbitrage_cases c
    LEFT JOIN core.instruments i ON c.target_instrument_id = i.instrument_id
    WHERE c.review_status = $1
    ORDER BY c.created_at DESC
    LIMIT $2 OFFSET $3
  `, [status, pageSize, offset]);

  const { rows: countRows } = await pool.query(
    'SELECT count(*) as total FROM event.arbitrage_cases WHERE review_status=$1', [status]
  );

  return { rows, total: parseInt(countRows[0].total), page, pageSize };
}

async function getCaseDetail(caseId) {
  const { rows } = await pool.query(`
    SELECT c.*, i.canonical_code, i.name,
           ri.canonical_code as ref_code, ri.name as ref_name,
           rwi.canonical_code as rights_code, rwi.name as rights_name
    FROM event.arbitrage_cases c
    LEFT JOIN core.instruments i ON c.target_instrument_id = i.instrument_id
    LEFT JOIN core.instruments ri ON c.reference_instrument_id = ri.instrument_id
    LEFT JOIN core.instruments rwi ON c.rights_instrument_id = rwi.instrument_id
    WHERE c.case_id = $1
  `, [caseId]);

  if (!rows.length) return null;

  const { rows: docs } = await pool.query(`
    SELECT d.document_id, d.title, d.announced_at, d.url, acd.relation_type
    FROM event.arbitrage_case_documents acd
    JOIN event.documents d ON acd.document_id = d.document_id
    WHERE acd.case_id = $1
    ORDER BY d.announced_at DESC NULLS LAST
  `, [caseId]);

  return { ...rows[0], documents: docs };
}

async function with_event_arbitrage_case_documents(params, client = pool) {
  return client.query(`
    WITH linked AS (
      SELECT d.document_id, d.title, d.announced_at, d.url, acd.relation_type, acd.document_role
      FROM event.arbitrage_case_documents acd
      JOIN event.documents d ON acd.document_id = d.document_id
      WHERE acd.case_id = $1
    ), inferred_risk AS (
      SELECT d.document_id, d.title, d.announced_at, d.url,
             'risk_event'::text AS relation_type, 'risk'::text AS document_role
      FROM event.documents d
      WHERE d.document_type = 'arbitrage_announcement'
        AND d.title ~* '(立案告知书|立案调查|调查通知书|调查告知书|行政处罚决定书|处罚决定|行政监管措施|监管警示|监管措施|问询函|监管工作函|监管函)'
        AND d.title !~* '((问询函|监管工作函|监管函).{0,16}(回复|答复)|((回复|答复).{0,16}(问询函|监管工作函|监管函)))'
        AND COALESCE(d.raw_payload->>'secCode', d.raw_payload->>'stockCode', d.raw_payload->>'code') = ANY($2::text[])
        AND NOT EXISTS (SELECT 1 FROM linked l WHERE l.document_id = d.document_id)
    ), inferred_progress AS (
      SELECT d.document_id, d.title, d.announced_at, d.url,
             'progress_event'::text AS relation_type, 'progress'::text AS document_role
      FROM event.documents d
      WHERE d.document_type = 'arbitrage_announcement'
        AND d.title ~* '((问询函|监管工作函|监管函).{0,16}(回复|答复)|((回复|答复).{0,16}(问询函|监管工作函|监管函))|(报告书|报告|申请).{0,12}(注册稿|申报稿)|(注册稿|申报稿).{0,12}(报告书|报告|申请))'
        AND COALESCE(d.raw_payload->>'secCode', d.raw_payload->>'stockCode', d.raw_payload->>'code') = ANY($2::text[])
        AND NOT EXISTS (SELECT 1 FROM linked l WHERE l.document_id = d.document_id)
    )
    SELECT * FROM linked
    UNION ALL
    SELECT * FROM inferred_risk
    UNION ALL
    SELECT * FROM inferred_progress
    ORDER BY announced_at DESC NULLS LAST
  `, params);
}

async function select_event_arbitrage_cases(params, client = pool) {
  return client.query(`
    SELECT c.*,i.canonical_code
    FROM event.arbitrage_cases c
    LEFT JOIN core.instruments i ON i.instrument_id=c.target_instrument_id
    WHERE c.case_id = $1
  `, params);
}

async function select_event_arbitrage_case_documents(params, client = pool) {
  return client.query(`
    SELECT d.document_id,d.url,d.title,acd.document_role,acd.parser_version,acd.parse_status
    FROM event.arbitrage_case_documents acd
    JOIN event.documents d ON acd.document_id=d.document_id
    WHERE acd.case_id=$1 AND d.url ~* '\\.pdf$'
    ORDER BY d.announced_at ASC NULLS LAST
  `, params);
}

async function select_event_arbitrage_cases_1(params, client = pool) {
  return client.query(`SELECT case_id FROM event.arbitrage_cases WHERE case_id=$1`, params);
}

module.exports = {
  getCandidates,
  getCaseDetail,
  with_event_arbitrage_case_documents,
  select_event_arbitrage_cases,
  select_event_arbitrage_case_documents,
  select_event_arbitrage_cases_1,
};

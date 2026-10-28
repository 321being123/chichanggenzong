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

module.exports = {
  getCandidates,
  getCaseDetail,
};

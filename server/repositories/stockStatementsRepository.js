const { pool } = require('../db/connection');

async function listAnnualStatements(tsCode, type, limit) {
  return pool.query(`SELECT to_char(r.period_end,'YYYY') AS fiscal_year,to_char(r.announced_at,'YYYY-MM-DD') AS announced_at,r.raw_payload
  FROM fundamental.financial_reports r JOIN core.company_instruments ci ON ci.company_id=r.company_id JOIN core.instruments i ON i.instrument_id=ci.instrument_id
  WHERE i.canonical_code=$1 AND r.report_kind=$2 AND r.period_type='annual' AND r.is_current_version=true ORDER BY r.period_end DESC LIMIT $3`, [tsCode, type, limit]);
}

module.exports = { listAnnualStatements };

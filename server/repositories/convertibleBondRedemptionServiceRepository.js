const { pool } = require('../db/connection');

// 自 server/services/convertibleBondRedemptionService.js 迁入的数据读写函数（只做标准事实读写，业务判定仍留在服务层）。

async function getLatestCallState(instrumentId) {
  const { rows } = await pool.query(
    `SELECT * FROM analytics.convertible_bond_call_latest WHERE instrument_id=$1 LIMIT 1`, [instrumentId]
  );
  return rows[0] || null;
}

async function getLatestCallStateBySecurityCodes(codes) {
  const normalized = [...new Set((codes || []).map(value => String(value || '').trim().toUpperCase().replace(/\.(SH|SZ|BJ|HK)$/, '')).filter(Boolean))];
  if (!normalized.length) return new Map();
  const { rows } = await pool.query(
    `SELECT * FROM analytics.convertible_bond_call_latest
      WHERE security_code=ANY($1::text[])`, [normalized]
  );
  return new Map(rows.map(row => [String(row.security_code || '').toUpperCase(), row]));
}

async function getLatestCallStateMap(instrumentIds) {
  const ids = [...new Set((instrumentIds || []).map(Number).filter(Number.isInteger))];
  if (!ids.length) return new Map();
  const { rows } = await pool.query(
    `SELECT * FROM analytics.convertible_bond_call_latest WHERE instrument_id=ANY($1::bigint[])`, [ids]
  );
  return new Map(rows.map(row => [Number(row.instrument_id), row]));
}

module.exports = {
  getLatestCallState,
  getLatestCallStateBySecurityCodes,
  getLatestCallStateMap,
};

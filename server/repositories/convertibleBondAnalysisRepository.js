const { pool } = require('../db/connection');

// 自 server/services/convertibleBondAnalysis.js 迁入的数据读写函数（只做标准事实读写，业务判定仍留在服务层）。

async function getResetNetAssetFloor(instrumentId, asOf) {
  const { rows } = await pool.query(
    `SELECT CASE WHEN net_asset_floor_applicable THEN true
                 WHEN parse_status='complete' THEN false ELSE NULL END AS applicable
       FROM fundamental.convertible_bond_terms
      WHERE instrument_id=$1 AND term_type='reset' AND effective_from<=$2::date
        AND (effective_to IS NULL OR effective_to>$2::date)
      ORDER BY effective_from DESC LIMIT 1`, [instrumentId, asOf]);
  return rows[0]?.applicable ?? null;
}

module.exports = {
  getResetNetAssetFloor,
};

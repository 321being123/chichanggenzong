const { pool } = require('../db/connection');

// 自 server/services/convertibleBondValuationService.js 迁入的数据读写函数（只做标准事实读写，业务判定仍留在服务层）。

async function getActiveModel() {
  const { rows } = await pool.query(
    "SELECT model_version, formula_version, universe_version, neutral_market_extra, residual_quantiles, training_end_date " +
    "FROM analytics.convertible_bond_valuation_models WHERE is_active=true ORDER BY created_at DESC LIMIT 1"
  );
  return rows[0] || null;
}

module.exports = {
  getActiveModel,
};

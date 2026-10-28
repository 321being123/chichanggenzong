const { pool } = require('../db/connection');

// 自 server/services/convertibleBondValuationService.js 迁入的数据读写函数（只做标准事实读写，业务判定仍留在服务层）。

async function getActiveModel() {
  const { rows } = await pool.query(
    "SELECT model_version, formula_version, universe_version, neutral_market_extra, residual_quantiles, training_end_date " +
    "FROM analytics.convertible_bond_valuation_models WHERE is_active=true ORDER BY created_at DESC LIMIT 1"
  );
  return rows[0] || null;
}

async function select_analytics_convertible_bond_valuation_daily(params, client = pool) {
  return client.query(`SELECT MAX(trade_date) AS d FROM analytics.convertible_bond_valuation_daily`);
}

async function select_market_convertible_bond_daily_metrics(params, client = pool) {
  return client.query(`SELECT MAX(trade_date) AS d FROM market.convertible_bond_daily_metrics`);
}

async function select_analytics_convertible_bond_valuation_daily_1(params, client = pool) {
  return client.query(`SELECT MAX(market_heat_pct) AS market_heat_pct, MAX(calculated_at) AS updated_at FROM analytics.convertible_bond_valuation_daily WHERE trade_date=$1 AND model_version=$2`, params);
}

async function select_analytics_convertible_bond_valuation_models(params, client = pool) {
  return client.query(`SELECT training_end_date, yearly_metadata FROM analytics.convertible_bond_valuation_models WHERE model_version=$1`, params);
}

module.exports = {
  getActiveModel,
  select_analytics_convertible_bond_valuation_daily,
  select_market_convertible_bond_daily_metrics,
  select_analytics_convertible_bond_valuation_daily_1,
  select_analytics_convertible_bond_valuation_models,
};

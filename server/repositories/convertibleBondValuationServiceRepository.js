const { pool } = require('../db/connection');

// 自 server/services/convertibleBondValuationService.js 迁入的数据读写函数（只做标准事实读写，业务判定仍留在服务层）。

const EVAL_ORDER = { '低估': 0, '偏低估': 1, '合理': 2, '偏高估': 3, '高估': 4, '风险折价': 5, '数据不足': 6 };

const LIST_SELECT = `
  SELECT v.trade_date, v.instrument_id, v.model_version, v.formula_version, v.universe_version,
         v.quote_date, v.close, v.conversion_value, v.bond_value, v.conversion_premium_pct,
         v.anchor_value, v.remaining_years, v.conversion_value_volatility_60d,
         v.fair_price, v.fair_price_low, v.fair_price_high, v.absolute_deviation_pct,
         v.valuation_percentile, v.relative_market_deviation_pct, v.base_evaluation,
         v.safety_level, v.credit_warning, v.final_evaluation, v.eval_class, v.data_status,
         v.neutral_market_extra, v.predicted_relative_extra, v.diagnostics, v.calculated_at,
         v.model_year, v.quote_lag_days, v.historical_safety, v.confidence_level,
         i.canonical_code AS bond_code, i.name AS bond_name,
         c.business_status AS call_status,
         s.name AS stock_name,
         CASE COALESCE(al.alert_rank, 0) WHEN 2 THEN '重要' WHEN 1 THEN '关注' ELSE '无' END AS alert_level
  FROM analytics.convertible_bond_valuation_daily v
  JOIN core.instruments i ON i.instrument_id = v.instrument_id
  JOIN fundamental.convertible_bond_profiles p ON p.instrument_id = v.instrument_id
  JOIN public.bond_unified u ON u.instrument_id = v.instrument_id
  LEFT JOIN analytics.convertible_bond_call_latest c ON c.instrument_id = v.instrument_id
  LEFT JOIN core.instruments s ON s.instrument_id = p.stock_instrument_id
  LEFT JOIN (
    SELECT a.instrument_id, MAX(CASE a.alert_level WHEN '重要' THEN 2 WHEN '关注' THEN 1 ELSE 0 END) AS alert_rank
    FROM analytics.convertible_bond_valuation_alerts a
    JOIN analytics.convertible_bond_valuation_models m ON m.model_version=a.model_version AND m.is_active
    WHERE a.is_active GROUP BY a.instrument_id
  ) al ON al.instrument_id = v.instrument_id
`;

async function getActiveModel() {
  const { rows } = await pool.query(
    "SELECT model_version, formula_version, universe_version, neutral_market_extra, residual_quantiles, training_end_date " +
    "FROM analytics.convertible_bond_valuation_models WHERE is_active=true ORDER BY created_at DESC LIMIT 1",
  );
  return rows[0] || null;
}

async function select_analytics_convertible_bond_valuation_daily(params, client = pool) {
  return client.query('SELECT MAX(trade_date) AS d FROM analytics.convertible_bond_valuation_daily');
}

async function select_market_convertible_bond_daily_metrics(params, client = pool) {
  return client.query('SELECT MAX(trade_date) AS d FROM market.convertible_bond_daily_metrics');
}

async function select_analytics_convertible_bond_valuation_daily_1(params, client = pool) {
  return client.query('SELECT MAX(market_heat_pct) AS market_heat_pct, MAX(calculated_at) AS updated_at FROM analytics.convertible_bond_valuation_daily WHERE trade_date=$1 AND model_version=$2', params);
}

async function select_analytics_convertible_bond_valuation_models(params, client = pool) {
  return client.query('SELECT training_end_date, yearly_metadata FROM analytics.convertible_bond_valuation_models WHERE model_version=$1', params);
}

// 估值列表页：在市口径 + 可选筛选（搜索/评估等级/安全等级/数据状态/预警等级），按评估等级与分位排序
async function listValuationPage(params, client = pool) {
  const where = [
    'v.trade_date = $1',
    "u.status = 'listed'",
    "(u.issue_type IS NULL OR u.issue_type NOT IN ('定向', '私募'))",
    '(i.list_date IS NULL OR i.list_date <= $2::date)',
    '(i.delist_date IS NULL OR i.delist_date > $2::date)',
    '(p.maturity_date IS NULL OR p.maturity_date >= $2::date)',
    '(p.conv_end_date IS NULL OR p.conv_end_date >= $2::date)',
    '(u.conv_stop_date IS NULL OR u.conv_stop_date > $2::date)',
    "(p.cb_type IS NULL OR p.cb_type IN ('CB', ''))",
    "(s.status IS NULL OR s.status = 'listed')",
    '(s.delist_date IS NULL OR s.delist_date > $2::date)',
  ];
  const args = [params.tradeDate, params.universeDate];
  let pi = 3;
  const filters = params.filters || {};
  if (filters.search) {
    where.push(`(i.canonical_code ILIKE $${pi} OR i.name ILIKE $${pi} OR COALESCE(s.name,'') ILIKE $${pi})`);
    args.push('%' + filters.search + '%');
    pi += 1;
  }
  if (filters.final_evaluation) { where.push(`v.eval_class = $${pi}`); args.push(filters.final_evaluation); pi += 1; }
  if (filters.safety_level) { where.push(`v.safety_level = $${pi}`); args.push(filters.safety_level); pi += 1; }
  if (filters.data_status) { where.push(`v.data_status = $${pi}`); args.push(filters.data_status); pi += 1; }
  if (filters.alert_level && filters.alert_level !== '无') {
    const lvl = filters.alert_level === '重要' ? 2 : 1;
    where.push(`COALESCE(al.alert_rank,0) >= $${pi}`);
    args.push(lvl); pi += 1;
  }
  const sql = LIST_SELECT + ' WHERE ' + where.join(' AND ') +
    ' ORDER BY CASE v.eval_class ' +
    Object.entries(EVAL_ORDER).map(([k, v]) => `WHEN '${k}' THEN ${v}`).join(' ') +
    ' ELSE 7 END, v.valuation_percentile ASC';
  const { rows } = await client.query(sql, args);
  return rows;
}

async function selectValuationDetail(params, client = pool) {
  const { rows } = await client.query(
    LIST_SELECT + ' WHERE v.trade_date=$1 AND i.canonical_code=$2',
    [params.tradeDate, params.code],
  );
  return rows;
}

async function listCreditHistory(code, client = pool) {
  const { rows } = await client.query(
    `SELECT r.rating_date, r.rating, r.rating_outlook, r.rating_type, r.announced_at
    FROM fundamental.convertible_bond_ratings r
    JOIN core.instruments i ON i.instrument_id = r.instrument_id
    WHERE i.canonical_code = $1 ORDER BY r.rating_date DESC LIMIT 20`,
    [code],
  );
  return rows;
}

async function listValuationHistory(params, client = pool) {
  const cutoff = params.cutoff || null;
  const sql = `
    SELECT v.trade_date, v.close, v.anchor_value, v.fair_price, v.fair_price_low, v.fair_price_high,
           v.absolute_deviation_pct, v.valuation_percentile, v.market_heat_pct,
           v.relative_market_deviation_pct, v.base_evaluation, v.final_evaluation, v.model_version
    FROM analytics.convertible_bond_valuation_daily v
    JOIN core.instruments i ON i.instrument_id = v.instrument_id
    WHERE i.canonical_code = $1 ${cutoff ? 'AND v.trade_date >= $2' : ''}
    ORDER BY v.trade_date ASC`;
  const args = cutoff ? [params.code, cutoff] : [params.code];
  const { rows } = await client.query(sql, args);
  return rows;
}

async function listValuationAlerts(params, client = pool) {
  const filters = params.filters || {};
  const where = [];
  const args = [];
  let pi = 1;
  if (filters.level) { where.push(`a.alert_level = $${pi}`); args.push(filters.level); pi += 1; }
  if (filters.active !== undefined) { where.push(`a.is_active = $${pi}`); args.push(filters.active); pi += 1; }
  if (params.cutoff) { where.push(`a.trade_date >= $${pi}`); args.push(params.cutoff); pi += 1; }
  const sql = `
    SELECT a.trade_date, a.alert_type, a.alert_level, a.previous_state, a.current_state,
           a.trigger_payload, a.model_version, a.created_at, a.is_active,
           i.canonical_code AS bond_code, i.name AS bond_name
    FROM analytics.convertible_bond_valuation_alerts a
    JOIN core.instruments i ON i.instrument_id = a.instrument_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY a.trade_date DESC, a.alert_level DESC LIMIT 500`;
  const { rows } = await client.query(sql, args);
  return rows;
}

async function listBondAlerts(code, client = pool) {
  const { rows } = await client.query(
    `SELECT a.trade_date, a.alert_type, a.alert_level, a.previous_state, a.current_state,
           a.trigger_payload, a.model_version, a.created_at, a.is_active
    FROM analytics.convertible_bond_valuation_alerts a
    JOIN core.instruments i ON i.instrument_id = a.instrument_id
    WHERE i.canonical_code = $1 ORDER BY a.trade_date DESC LIMIT 100`,
    [code],
  );
  return rows;
}

async function listValuationByCodes(params, client = pool) {
  const { rows } = await client.query(
    `SELECT i.canonical_code, v.final_evaluation, v.eval_class, v.valuation_percentile, v.trade_date
    FROM analytics.convertible_bond_valuation_daily v
    JOIN core.instruments i ON i.instrument_id = v.instrument_id
    WHERE v.trade_date = $1
      AND REGEXP_REPLACE(i.canonical_code, '\\D', '', 'g') = ANY($2)`,
    [params.tradeDate, params.codes],
  );
  return rows;
}

module.exports = {
  getActiveModel,
  listBondAlerts,
  listCreditHistory,
  listValuationAlerts,
  listValuationByCodes,
  listValuationHistory,
  listValuationPage,
  selectValuationDetail,
  select_analytics_convertible_bond_valuation_daily,
  select_analytics_convertible_bond_valuation_daily_1,
  select_analytics_convertible_bond_valuation_models,
  select_market_convertible_bond_daily_metrics,
};

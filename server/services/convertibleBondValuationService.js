// 可转债估值：只读查询服务（页面与接口只读取数据库，不调用上游数据源）
const { pool } = require('../db');
const { getLatestCycle } = require('./convertibleBondCycleService');
const { expectedTradeDate } = require('../routes/bondCycle');

const EVAL_ORDER = { '低估': 0, '偏低估': 1, '合理': 2, '偏高估': 3, '高估': 4, '风险折价': 5, '数据不足': 6 };

function isoDate(d) {
  if (d instanceof Date) return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return String(d || '').slice(0, 10);
}

function rangeCutoff(range) {
  if (!range || range === 'all') return null;
  const years = { '1y': 1, '3y': 3, '5y': 5 }[range];
  if (!years) return null;
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  return d.toISOString().slice(0, 10);
}

function isValuationStale(tradeDate, expectedDate, latestMarketDate) {
  return Boolean(tradeDate && (
    (expectedDate && tradeDate < expectedDate) ||
    (latestMarketDate && tradeDate < latestMarketDate)
  ));
}

// ---- 基础：模型版本与最新估值日 ----
async function getActiveModel() {
  const { rows } = await pool.query(
    "SELECT model_version, formula_version, universe_version, neutral_market_extra, residual_quantiles, training_end_date " +
    "FROM analytics.convertible_bond_valuation_models WHERE is_active=true ORDER BY created_at DESC LIMIT 1"
  );
  return rows[0] || null;
}

async function getLatestTradeDate() {
  const { rows } = await pool.query(
    "SELECT MAX(trade_date) AS d FROM analytics.convertible_bond_valuation_daily"
  );
  return rows[0] && rows[0].d ? isoDate(rows[0].d) : null;
}

// 行 -> 列表接口字段
function mapListRow(r) {
  return {
    bond_code: r.bond_code,
    bond_name: r.bond_name,
    call_status: r.call_status || 'incomplete',
    stock_name: r.stock_name || '',
    safety_level: r.safety_level || '',
    credit_warning: r.credit_warning || '无',
    close: r.close,
    conversion_value: r.conversion_value,
    bond_value: r.bond_value,
    conversion_premium_pct: r.conversion_premium_pct,
    anchor_value: r.anchor_value,
    remaining_years: r.remaining_years,
    conversion_value_volatility_60d: r.conversion_value_volatility_60d,
    fair_price: r.fair_price,
    fair_price_low: r.fair_price_low,
    fair_price_high: r.fair_price_high,
    absolute_deviation_pct: r.absolute_deviation_pct,
    valuation_percentile: r.valuation_percentile,
    relative_market_deviation_pct: r.relative_market_deviation_pct,
    final_evaluation: r.final_evaluation || '',
    eval_class: r.eval_class || '',
    alert_level: r.alert_level || '无',
    quote_date: isoDate(r.quote_date),
    data_status: r.data_status || '完整',
  };
}

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

async function getList(asOf, filters = {}) {
  const model = await getActiveModel();
  const tradeDate = asOf || (await getLatestTradeDate());
  if (!tradeDate) return null;
  const { rows: [marketDateRow] } = await pool.query(
    'SELECT MAX(trade_date) AS d FROM market.convertible_bond_daily_metrics'
  );
  const latestMarketDate = marketDateRow && marketDateRow.d ? isoDate(marketDateRow.d) : null;
  // 默认列表即使展示的是上一有效快照，也必须按当前预期交易日剔除已退市、
  // 已到期或已停止转股的债券；显式查询历史日期时则按该历史日还原范围。
  const universeDate = asOf ? tradeDate : expectedTradeDate();
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
  const params = [tradeDate, universeDate];
  let pi = 3;
  if (filters.search) {
    where.push(`(i.canonical_code ILIKE $${pi} OR i.name ILIKE $${pi} OR COALESCE(s.name,'') ILIKE $${pi})`);
    params.push('%' + filters.search + '%');
    pi++;
  }
  if (filters.final_evaluation) { where.push(`v.eval_class = $${pi}`); params.push(filters.final_evaluation); pi++; }
  if (filters.safety_level) { where.push(`v.safety_level = $${pi}`); params.push(filters.safety_level); pi++; }
  if (filters.data_status) { where.push(`v.data_status = $${pi}`); params.push(filters.data_status); pi++; }
  if (filters.alert_level && filters.alert_level !== '无') {
    const lvl = filters.alert_level === '重要' ? 2 : 1;
    where.push(`COALESCE(al.alert_rank,0) >= $${pi}`);
    params.push(lvl); pi++;
  }
  const sql = LIST_SELECT + ' WHERE ' + where.join(' AND ') +
    ' ORDER BY CASE v.eval_class ' +
    Object.entries(EVAL_ORDER).map(([k, v]) => `WHEN '${k}' THEN ${v}`).join(' ') +
    " ELSE 7 END, v.valuation_percentile ASC";
  const { rows } = await pool.query(sql, params);
  const data = rows.map(mapListRow);

  // 计数
  const counts = { '低估': 0, '偏低估': 0, '合理': 0, '偏高估': 0, '高估': 0, '风险折价': 0, '数据不足': 0 };
  let valued = 0;
  for (const r of data) {
    const cls = r.eval_class || '数据不足';
    if (counts[cls] !== undefined) counts[cls]++;
    if (r.data_status === '完整' && r.fair_price != null) valued++;
  }
  const total = data.length;
  const expected = expectedTradeDate();
  const latestModel = model || {};
  const { rows: [heatRow] } = await pool.query(
    'SELECT MAX(market_heat_pct) AS market_heat_pct, MAX(calculated_at) AS updated_at FROM analytics.convertible_bond_valuation_daily WHERE trade_date=$1 AND model_version=$2',
    [tradeDate, latestModel.model_version || '']
  );
  const cycle = await getLatestCycle();
  return {
    as_of_date: tradeDate,
    expected_trade_date: expected,
    updated_at: heatRow && heatRow.updated_at ? heatRow.updated_at : null,
    latest_market_date: latestMarketDate,
    stale: isValuationStale(tradeDate, expected, latestMarketDate),
    model_version: latestModel.model_version || null,
    formula_version: latestModel.formula_version || null,
    universe_version: latestModel.universe_version || null,
    market_heat_pct: heatRow ? Number(heatRow.market_heat_pct) : null,
    cycle_level: cycle ? cycle.cycle_level : null,
    total,
    valued_count: valued,
    coverage_ratio: total ? valued / total : 0,
    counts,
    data: data,
  };
}

// ---- 单券详情 ----
async function getBondDetail(code, asOf) {
  const tradeDate = asOf || (await getLatestTradeDate());
  if (!tradeDate) return null;
  const { rows } = await pool.query(
    LIST_SELECT + ' WHERE v.trade_date=$1 AND i.canonical_code=$2',
    [tradeDate, code]
  );
  if (!rows.length) return null;
  const r = rows[0];
  const cur = mapListRow(r);

  // 安全性快照明细（统一用 loadSafety，和股债分析同一套逻辑）
  const safetyRaw = await loadSafety(code);
  const safety = safetyRaw ? {
    safety: safetyRaw.safety || '',
    interest_coverage: safetyRaw.interest_coverage,
    cash_coverage: safetyRaw.cash_coverage,
    liability_to_market_cap: safetyRaw.liability_market_ratio,
    source_updated_at: safetyRaw.source_updated_at || null,
  } : null;
  // 信用历史
  const credit = await getCreditHistory(code);
  // 诊断
  let diagnostics = {};
  try { diagnostics = r.diagnostics ? (typeof r.diagnostics === 'string' ? JSON.parse(r.diagnostics) : r.diagnostics) : {}; } catch (e) { diagnostics = {}; }

  // 模型训练截止日期（优先年度子模型，取不到再退回整体训练截止日）
  let trainingEndDate = null;
  try {
    const { rows: [m] } = await pool.query(
      'SELECT training_end_date, yearly_metadata FROM analytics.convertible_bond_valuation_models WHERE model_version=$1',
      [r.model_version]
    );
    if (m) {
      const ym = m.yearly_metadata && r.model_year != null ? m.yearly_metadata[String(r.model_year)] : null;
      trainingEndDate = (ym && ym.training_end_date) || (m.training_end_date ? isoDate(m.training_end_date) : null);
    }
  } catch (e) { /* 保持 null */ }

  return {
    bond_code: cur.bond_code,
    bond_name: cur.bond_name,
    call_status: cur.call_status,
    stock_name: cur.stock_name,
    quote_date: cur.quote_date,
    quote_lag_days: r.quote_lag_days,
    data_status: cur.data_status,
    missing_fields: Array.isArray(diagnostics.missing_fields) && diagnostics.missing_fields.length
      ? diagnostics.missing_fields
      : (diagnostics.missing ? [String(diagnostics.missing)] : []),
    observation_days: diagnostics.observation_days ?? null,
    required_observation_days: diagnostics.required_observation_days ?? null,
    historical_safety: r.historical_safety || '',
    model_version: r.model_version,
    model_year: r.model_year,
    model_training_end_date: trainingEndDate,
    calculated_at: r.calculated_at || null,
    trade_date: tradeDate,
    current: cur,
    breakdown: {
      conversion_value: cur.conversion_value,
      bond_value: cur.bond_value,
      anchor_value: cur.anchor_value,
      conversion_premium_pct: cur.conversion_premium_pct,
      remaining_years: cur.remaining_years,
      conversion_value_volatility_60d: cur.conversion_value_volatility_60d,
      neutral_market_extra: r.neutral_market_extra,
      predicted_relative_extra: r.predicted_relative_extra,
      maturity_call_price: diagnostics.maturity_call_price ?? null,
      redemption_present_value: diagnostics.redemption_present_value ?? null,
      option_time_value_weight: diagnostics.option_time_value_weight ?? null,
      effective_option_years: diagnostics.effective_option_years ?? null,
      option_end_date: diagnostics.option_end_date ?? null,
      option_end_reason: diagnostics.option_end_reason ?? null,
      fair_price: cur.fair_price,
      fair_price_low: cur.fair_price_low,
      fair_price_high: cur.fair_price_high,
      absolute_deviation_pct: cur.absolute_deviation_pct,
      relative_market_deviation_pct: cur.relative_market_deviation_pct,
    },
    safety,
    credit: {
      negative_rule_triggered: !!(r.credit_warning && r.credit_warning !== '无'),
      credit_warning: r.credit_warning || '无',
      rating_history_complete: credit.length > 0,
      history: credit,
    },
    diagnostics,
  };
}

const { loadSafety } = require('./convertibleBondAnalysis');

async function getCreditHistory(code) {
  const sql = `
    SELECT r.rating_date, r.rating, r.rating_outlook, r.rating_type, r.announced_at
    FROM fundamental.convertible_bond_ratings r
    JOIN core.instruments i ON i.instrument_id = r.instrument_id
    WHERE i.canonical_code = $1 ORDER BY r.rating_date DESC LIMIT 20`;
  const { rows } = await pool.query(sql, [code]);
  return rows.map(r => ({
    rating_date: isoDate(r.rating_date),
    announced_at: isoDate(r.announced_at),
    rating: r.rating,
    rating_outlook: r.rating_outlook || '',
    rating_type: r.rating_type || '',
  }));
}

// ---- 历史估值 ----
async function getHistory(code, range) {
  const cutoff = rangeCutoff(range);
  const sql = `
    SELECT v.trade_date, v.close, v.anchor_value, v.fair_price, v.fair_price_low, v.fair_price_high,
           v.absolute_deviation_pct, v.valuation_percentile, v.market_heat_pct,
           v.relative_market_deviation_pct, v.base_evaluation, v.final_evaluation, v.model_version
    FROM analytics.convertible_bond_valuation_daily v
    JOIN core.instruments i ON i.instrument_id = v.instrument_id
    WHERE i.canonical_code = $1 ${cutoff ? 'AND v.trade_date >= $2' : ''}
    ORDER BY v.trade_date ASC`;
  const params = cutoff ? [code, cutoff] : [code];
  const { rows } = await pool.query(sql, params);
  return rows.map(r => ({
    date: isoDate(r.trade_date),
    close: r.close,
    anchor_value: r.anchor_value,
    fair_price: r.fair_price,
    fair_price_low: r.fair_price_low,
    fair_price_high: r.fair_price_high,
    absolute_deviation_pct: r.absolute_deviation_pct,
    valuation_percentile: r.valuation_percentile,
    market_heat_pct: r.market_heat_pct,
    relative_market_deviation_pct: r.relative_market_deviation_pct,
    base_evaluation: r.base_evaluation,
    final_evaluation: r.final_evaluation,
    model_version: r.model_version,
  }));
}

// ---- 预警 ----
async function getAlerts(filters = {}) {
  const where = [];
  const params = [];
  let pi = 1;
  if (filters.level) { where.push(`a.alert_level = $${pi}`); params.push(filters.level); pi++; }
  if (filters.active !== undefined) { where.push(`a.is_active = $${pi}`); params.push(filters.active); pi++; }
  const cutoff = rangeCutoff(filters.range);
  if (cutoff) { where.push(`a.trade_date >= $${pi}`); params.push(cutoff); pi++; }
  const sql = `
    SELECT a.trade_date, a.alert_type, a.alert_level, a.previous_state, a.current_state,
           a.trigger_payload, a.model_version, a.created_at, a.is_active,
           i.canonical_code AS bond_code, i.name AS bond_name
    FROM analytics.convertible_bond_valuation_alerts a
    JOIN core.instruments i ON i.instrument_id = a.instrument_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY a.trade_date DESC, a.alert_level DESC LIMIT 500`;
  const { rows } = await pool.query(sql, params);
  return rows.map(r => ({
    bond_code: r.bond_code, bond_name: r.bond_name,
    trade_date: isoDate(r.trade_date), alert_type: r.alert_type, alert_level: r.alert_level,
    previous_state: r.previous_state, current_state: r.current_state,
    trigger_payload: r.trigger_payload, model_version: r.model_version, created_at: r.created_at,
    is_active: r.is_active,
  }));
}

async function getBondAlerts(code) {
  const sql = `
    SELECT a.trade_date, a.alert_type, a.alert_level, a.previous_state, a.current_state,
           a.trigger_payload, a.model_version, a.created_at, a.is_active
    FROM analytics.convertible_bond_valuation_alerts a
    JOIN core.instruments i ON i.instrument_id = a.instrument_id
    WHERE i.canonical_code = $1 ORDER BY a.trade_date DESC LIMIT 100`;
  const { rows } = await pool.query(sql, [code]);
  return rows.map(r => ({
    trade_date: isoDate(r.trade_date), alert_type: r.alert_type, alert_level: r.alert_level,
    previous_state: r.previous_state, current_state: r.current_state,
    trigger_payload: r.trigger_payload, model_version: r.model_version, created_at: r.created_at,
    is_active: r.is_active,
  }));
}

// ---- 持仓联动：按 6 位代码批量查最新交易日估值 ----
// 输入持仓里的可转债 6 位纯数字代码列表（如 ['113050','123456']），返回
// { '113050': { eval_class, final_evaluation, percentile, as_of } }。
// 匹配时忽略后缀（库中 canonical_code 形如 113050.SH），一次 SQL 查完。
async function getValuationByCodes(codes) {
  if (!Array.isArray(codes) || codes.length === 0) return {};
  const clean = [...new Set(codes.map(c => String(c || '').trim()).filter(c => /^\d{6}$/.test(c)))];
  if (clean.length === 0) return {};
  const tradeDate = await getLatestTradeDate();
  if (!tradeDate) return {};
  const sql = `
    SELECT i.canonical_code, v.final_evaluation, v.eval_class, v.valuation_percentile, v.trade_date
    FROM analytics.convertible_bond_valuation_daily v
    JOIN core.instruments i ON i.instrument_id = v.instrument_id
    WHERE v.trade_date = $1
      AND REGEXP_REPLACE(i.canonical_code, '\\D', '', 'g') = ANY($2)`;
  const { rows } = await pool.query(sql, [tradeDate, clean]);
  const out = {};
  for (const r of rows) {
    const code = String(r.canonical_code || '').replace(/\D/g, '');
    if (!code) continue;
    out[code] = {
      eval_class: r.eval_class || r.final_evaluation || '',
      final_evaluation: r.final_evaluation || '',
      percentile: r.valuation_percentile != null ? Number(r.valuation_percentile) : null,
      as_of: isoDate(r.trade_date),
    };
  }
  return out;
}

module.exports = {
  EVAL_ORDER,
  isValuationStale,
  getActiveModel,
  getLatestTradeDate,
  getList,
  getBondDetail,
  getHistory,
  getAlerts,
  getBondAlerts,
  getValuationByCodes,
};

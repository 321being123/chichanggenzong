const { pool } = require('../db/connection');

// 自 server/services/convertibleBondListService.js 迁入的数据读写函数（只做标准事实读写，业务判定仍留在服务层）。

async function fetchCoupons(instrumentIds) {
  if (!instrumentIds.length) return new Map();
  const { rows } = await pool.query(`
    SELECT instrument_id,interest_year,coupon_rate,pay_date,pre_tax_interest,after_tax_interest
      FROM fundamental.convertible_bond_coupon_schedule
     WHERE instrument_id=ANY($1::bigint[])
     ORDER BY instrument_id,interest_year
  `, [instrumentIds]);
  const result = new Map();
  for (const row of rows) {
    const key = String(row.instrument_id);
    if (!result.has(key)) result.set(key, []);
    result.get(key).push(row);
  }
  return result;
}

async function fetchStockHistory(stockIds, tradeDate) {
  if (!stockIds.length) return new Map();
  const { rows } = await pool.query(`
    SELECT instrument_id,trade_date,close
      FROM (
        SELECT instrument_id,trade_date,close,
               ROW_NUMBER() OVER (PARTITION BY instrument_id ORDER BY trade_date DESC) AS rn
          FROM market.daily_bars
         WHERE instrument_id=ANY($1::bigint[]) AND trade_date <= $2::date AND close > 0
      ) history
     WHERE rn <= 251
     ORDER BY instrument_id,trade_date DESC
  `, [stockIds, tradeDate]);
  const history = new Map();
  for (const row of rows) {
    if (!history.has(String(row.instrument_id))) history.set(String(row.instrument_id), []);
    const list = history.get(String(row.instrument_id));
    if (list.length < 251) list.push(row);
  }
  return history;
}

async function fetchUniverseRows(tradeDate) {
  const { rows } = await pool.query(`
    WITH bond_rows AS (
      SELECT DISTINCT ON (m.instrument_id)
             m.instrument_id,m.trade_date,m.close,m.conversion_value,m.conversion_premium_pct,
             m.bond_value,m.bond_premium_pct,m.raw_payload,
             p.stock_instrument_id,p.bond_short_name,p.remain_size,
             p.maturity_date,p.value_date,p.current_conv_price,p.rate_clause,p.coupon_rate,p.maturity_call_price,
             p.raw_payload AS profile_payload,p.newest_rating,p.issue_rating,
             b.canonical_code,b.name AS instrument_name,u.status,b.list_date,b.delist_date,
             s.canonical_code AS stock_code,s.name AS stock_name,
             sb.stock_trade_date,sb.stock_close,sb.stock_prev_close,sv.stock_pb,sv.stock_dividend_yield,sv.stock_market_cap,
             f.data AS financial_data,f.report_end_date AS financial_period_end,
             fh.report_date AS fund_report_date,fh.remain_size_ratio AS fund_ratio,
             fh.holding_quantity AS fund_quantity,
             put_term.trigger_ratio AS put_trigger_ratio,
             put_term.observation_days AS put_observation_days,
             put_term.required_days AS put_required_days,
             put_term.clause_text AS put_term_clause
        FROM market.convertible_bond_daily_metrics m
        JOIN fundamental.convertible_bond_profiles p ON p.instrument_id=m.instrument_id
        JOIN core.instruments b ON b.instrument_id=m.instrument_id
        JOIN public.bond_unified u ON u.instrument_id=m.instrument_id
        LEFT JOIN core.instruments s ON s.instrument_id=p.stock_instrument_id
        LEFT JOIN LATERAL (
          SELECT MAX(trade_date) FILTER (WHERE rn=1) AS stock_trade_date,
                 MAX(close) FILTER (WHERE rn=1) AS stock_close,
                 MAX(close) FILTER (WHERE rn=2) AS stock_prev_close
            FROM (
              SELECT trade_date,close,ROW_NUMBER() OVER (ORDER BY trade_date DESC,source_id DESC) AS rn
                FROM market.daily_bars
               WHERE instrument_id=p.stock_instrument_id AND trade_date <= $1::date AND close > 0
            ) x
        ) sb ON true
        LEFT JOIN LATERAL (
          SELECT pb AS stock_pb,dividend_yield_ttm AS stock_dividend_yield,total_market_cap AS stock_market_cap
            FROM market.daily_valuations
           WHERE instrument_id=p.stock_instrument_id AND trade_date <= $1::date
           ORDER BY trade_date DESC,source_id DESC LIMIT 1
        ) sv ON true
        LEFT JOIN bond_safety_financial_cache f ON f.ts_code=s.canonical_code
        LEFT JOIN LATERAL (
          SELECT report_date,remain_size_ratio,holding_quantity
            FROM fundamental.convertible_bond_fund_holdings
           WHERE instrument_id=m.instrument_id AND report_date <= $1::date
           ORDER BY report_date DESC LIMIT 1
        ) fh ON true
        LEFT JOIN LATERAL (
          SELECT trigger_ratio,observation_days,required_days,clause_text
            FROM fundamental.convertible_bond_terms
           WHERE instrument_id=m.instrument_id AND term_type='put'
             AND effective_from <= $1::date
             AND (effective_to IS NULL OR effective_to >= $1::date)
           ORDER BY effective_from DESC,term_id DESC LIMIT 1
        ) put_term ON true
       WHERE m.trade_date=$1::date
         AND u.status='listed'
         AND (u.issue_type IS NULL OR u.issue_type NOT IN ('定向','私募'))
         AND (b.list_date IS NULL OR b.list_date <= $1::date)
         AND (b.delist_date IS NULL OR b.delist_date > $1::date)
         AND (p.maturity_date IS NULL OR p.maturity_date >= $1::date)
         AND (p.conv_end_date IS NULL OR p.conv_end_date >= $1::date)
         AND (u.conv_stop_date IS NULL OR u.conv_stop_date > $1::date)
       ORDER BY m.instrument_id,m.source_id DESC
    )
    SELECT * FROM bond_rows ORDER BY canonical_code
  `, [tradeDate]);
  return rows;
}

module.exports = {
  fetchCoupons,
  fetchStockHistory,
  fetchUniverseRows,
};

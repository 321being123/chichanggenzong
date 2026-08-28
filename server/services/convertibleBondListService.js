// 上市可转债列表：批量读取统一数据层，计算并发布 Excel 对应的每日派生指标。
// 页面行情刷新只通过本服务复用统一腾讯行情缓存，依赖指标在服务端重算。
const crypto = require('crypto');
const { pool } = require('../db');
const { fetchTencentQuotes } = require('./tencentQuote');
const { getLatestCallStateMap } = require('./convertibleBondRedemptionService');
const {
  finite, isoDate, normalizeBondCode, remainingYears, annualizedVolatility,
  parseTriggerRatio, earliestPutDate, estimatePutTimeline, futureTradeCalendar,
  cashflowsToDate, yieldToMaturity, accruedPutPrice, annualizedRedemptionYield, parseMoney,
  blackScholesConvertible,
} = require('./convertibleBondAnalysis');

const FORMULA_VERSION = '2';
const LIST_QUOTE_TTL_MS = 15 * 60 * 1000;
const LIST_IGNORED_MISSING_FIELDS = new Set([
  'expected_put_payment_date', 'put_yield_pre_tax', 'put_yield_after_tax',
]);

function dateText(value) {
  const text = isoDate(value);
  return text || null;
}

function hashInput(value) {
  return crypto.createHash('md5').update(JSON.stringify(value || {})).digest('hex');
}

function numberOrNull(value) {
  const number = finite(value);
  return number == null ? null : number;
}

function quoteLookupKey(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw) return [];
  const normalized = normalizeBondCode(raw) || raw.replace(/^(SH|SZ|BJ|HK)/, '').replace(/\.(SH|SZ|BJ|HK)$/, '');
  const bare = normalized.split('.')[0];
  return [...new Set([normalized, bare])];
}

function findQuote(quotes, code) {
  for (const key of quoteLookupKey(code)) {
    const quote = quotes.get(key);
    if (quote && numberOrNull(quote.price) > 0) return quote;
  }
  return null;
}

function withIntradayQuotes(row, quotes) {
  const bondQuote = findQuote(quotes, row.canonical_code);
  const stockQuote = findQuote(quotes, row.stock_code);
  const bondPrice = bondQuote ? numberOrNull(bondQuote.price) : numberOrNull(row.close);
  const stockPrice = stockQuote ? numberOrNull(stockQuote.price) : numberOrNull(row.stock_close);
  const convPrice = numberOrNull(row.current_conv_price);
  const conversionValue = stockPrice > 0 && convPrice > 0
    ? stockPrice / convPrice * 100 : numberOrNull(row.conversion_value);
  const rawPayload = { ...(row.raw_payload || {}) };
  if (bondQuote && numberOrNull(bondQuote.change) != null) rawPayload.pct_chg = numberOrNull(bondQuote.change);
  return {
    row: {
      ...row,
      close: bondPrice,
      stock_close: stockPrice,
      conversion_value: conversionValue,
      conversion_premium_pct: conversionValue > 0 && bondPrice != null
        ? (bondPrice / conversionValue - 1) * 100 : row.conversion_premium_pct,
      raw_payload: rawPayload,
    },
    bondQuote,
    stockQuote,
    live: Boolean(bondQuote || stockQuote),
  };
}

async function loadIntradayContext(universe, force = false) {
  const codes = universe.flatMap(row => [row.canonical_code, row.stock_code]).filter(Boolean);
  let quotes = new Map();
  let error = null;
  try {
    quotes = await fetchTencentQuotes([...new Set(codes)], {
      ttlMs: LIST_QUOTE_TTL_MS,
      force,
    });
  } catch (cause) {
    error = cause;
  }
  const liveRows = universe.map(row => withIntradayQuotes(row, quotes));
  const liveCount = liveRows.filter(row => row.live).length;
  if (!liveCount) return { rows: liveRows, quotes, liveCount, error, stockHistory: new Map(), couponMap: new Map() };
  const stockIds = [...new Set(universe.map(row => row.stock_instrument_id).filter(Boolean))];
  const [stockHistory, couponMap] = await Promise.all([
    fetchStockHistory(stockIds, universe[0].trade_date),
    fetchCoupons(universe.map(row => row.instrument_id)),
  ]);
  return { rows: liveRows, quotes, liveCount, error, stockHistory, couponMap };
}

function safeDate(value) {
  return isoDate(value);
}

function buildWeekdayCalendar(startDate, days = 800) {
  const startText = isoDate(startDate);
  if (!startText) return [];
  const [year, month, day] = startText.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1, day));
  const rows = [];
  for (let i = 1; i <= days; i += 1) {
    const d = new Date(start.getTime());
    d.setUTCDate(d.getUTCDate() + i);
    const weekday = d.getUTCDay();
    if (weekday !== 0 && weekday !== 6) rows.push({ cal_date: d.toISOString().slice(0, 10), is_open: '1' });
  }
  return rows;
}

async function latestTradeDate() {
  const { rows } = await pool.query(`
    SELECT MAX(trade_date)::text AS trade_date
      FROM market.convertible_bond_daily_metrics
  `);
  return rows[0] && rows[0].trade_date ? safeDate(rows[0].trade_date) : null;
}

async function latestPublishedTradeDate() {
  const { rows } = await pool.query(`
    SELECT MAX(trade_date)::text AS trade_date
      FROM analytics.convertible_bond_list_metrics_daily
     WHERE formula_version=$1
  `, [FORMULA_VERSION]);
  return rows[0] && rows[0].trade_date ? safeDate(rows[0].trade_date) : null;
}

async function latestSafetyRatings() {
  try {
    const { rows } = await pool.query(`
      SELECT data
        FROM bond_safety_snapshots
       ORDER BY id DESC
       LIMIT 1
    `);
    const snapshot = rows[0] && Array.isArray(rows[0].data) ? rows[0].data : [];
    const ratings = new Map();
    snapshot.forEach(row => {
      const normalized = normalizeBondCode(row && row.bond_code) || String(row && row.bond_code || '').trim();
      if (!normalized) return;
      const safety = row && row.safety ? row.safety : '未评级';
      ratings.set(normalized, safety);
      ratings.set(normalized.split('.')[0], safety);
    });
    return ratings;
  } catch (error) {
    // 安全性是列表补充展示字段，读取失败不阻断行情和指标列表。
    return new Map();
  }
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

async function attachCallStates(rows) {
  const states = await getLatestCallStateMap((rows || []).map(row => row.instrument_id));
  return (rows || []).map(row => {
    const state = states.get(Number(row.instrument_id));
    return Object.assign({}, row, {
      call_trigger_price: state ? numberOrNull(state.trigger_price) : null,
      call_matched_days: state ? numberOrNull(state.matched_days) : null,
      call_required_days: state ? numberOrNull(state.required_days) : null,
      call_observation_days: state ? numberOrNull(state.observation_days) : null,
      call_remaining_days: state ? numberOrNull(state.remaining_days) : null,
      call_business_status: state ? state.business_status : 'incomplete',
      call_data_status: state ? state.data_status : 'incomplete',
      call_announcement_title: state ? state.announcement_title : null,
    });
  });
}

async function fetchStockHistory(stockIds, tradeDate) {
  if (!stockIds.length) return new Map();
  const { rows } = await pool.query(`
    SELECT instrument_id,trade_date,close
      FROM market.daily_bars
     WHERE instrument_id=ANY($1::bigint[]) AND trade_date <= $2::date AND close > 0
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

function profileClause(row, key) {
  return String((row.profile_payload && row.profile_payload[key]) || '');
}

function calculateRow(row, stockRows, coupons) {
  const tradeDate = dateText(row.trade_date);
  const bondPrice = numberOrNull(row.close);
  const conversionValue = numberOrNull(row.conversion_value);
  const bondValue = numberOrNull(row.bond_value);
  const conversionPremium = conversionValue > 0 && bondPrice != null
    ? bondPrice / conversionValue - 1 : numberOrNull(row.conversion_premium_pct) == null
      ? null : numberOrNull(row.conversion_premium_pct) / 100;
  const bondFloorPremium = bondValue > 0 && bondPrice != null ? bondPrice / bondValue - 1 : null;
  const maturityDate = dateText(row.maturity_date);
  const asOfDate = tradeDate ? new Date(`${tradeDate}T00:00:00+08:00`) : new Date();
  const years = maturityDate && tradeDate ? remainingYears(maturityDate, asOfDate) : null;
  const stockHistory = stockRows.get(String(row.stock_instrument_id)) || [];
  const volatility = annualizedVolatility(stockHistory);
  const stockPrice = numberOrNull(row.stock_close);
  const stockDividendRaw = numberOrNull(row.stock_dividend_yield);
  const stockDividend = stockDividendRaw == null ? null : stockDividendRaw / 100;
  const riskFreeRate = finite(process.env.CB_RISK_FREE_RATE) == null ? 0.015 : finite(process.env.CB_RISK_FREE_RATE);
  const optionValue = blackScholesConvertible(stockPrice, numberOrNull(row.current_conv_price), years, volatility, riskFreeRate, stockDividend);
  const theoreticalValue = bondValue != null && optionValue != null ? bondValue + optionValue : null;
  // 强赎触发价由统一强赎状态视图提供；列表计算只复制，不重新解析条款或相乘。
  const callTrigger = numberOrNull(row.call_trigger_price);
  const marketCap = numberOrNull(row.stock_market_cap);
  const remainSize = numberOrNull(row.remain_size);
  const financial = row.financial_data || {};
  const assets = numberOrNull(financial.total_assets);
  const liabilities = numberOrNull(financial.total_liability);
  const financialRatio = assets > 0 && liabilities != null ? liabilities / assets : null;
  const fundRatio = numberOrNull(row.fund_ratio) != null ? numberOrNull(row.fund_ratio)
    : remainSize > 0 && numberOrNull(row.fund_quantity) != null ? numberOrNull(row.fund_quantity) * 1000000 / remainSize : null;
  const rawAmount = row.raw_payload && numberOrNull(row.raw_payload.amount);
  const turnover = rawAmount != null && remainSize > 0 && bondPrice > 0 ? rawAmount * 10000 * 100 / bondPrice / remainSize : null;

  const putClause = row.put_term_clause || profileClause(row, 'put_clause');
  const putStartDate = earliestPutDate(maturityDate, putClause);
  const putRatio = numberOrNull(row.put_trigger_ratio) == null ? parseTriggerRatio(putClause) : numberOrNull(row.put_trigger_ratio);
  const putTerm = putRatio == null ? null : {
    ratio: putRatio,
    observation_days: Number(row.put_observation_days) || 30,
    required_days: Number(row.put_required_days) || Number(row.put_observation_days) || 30,
    comparison: 'lt',
  };
  const calendarRows = buildWeekdayCalendar(tradeDate);
  const futureDates = futureTradeCalendar(calendarRows, tradeDate, 800)
    .filter(value => !maturityDate || value <= maturityDate);
  const putTimeline = putTerm && putStartDate
    ? estimatePutTimeline(stockHistory, putTerm, numberOrNull(row.current_conv_price), putStartDate, futureDates, stockPrice, tradeDate)
    : null;
  const putTriggerDate = putTimeline && putTimeline.trigger_date ? safeDate(putTimeline.trigger_date) : null;
  const putPaymentDate = putTimeline && putTimeline.payment_date ? safeDate(putTimeline.payment_date) : null;
  const couponRows = coupons || [];
  const profile = {
    value_date: dateText(row.value_date), maturity_date: maturityDate,
    rate_clause: String(row.rate_clause || ''), coupon_rate: numberOrNull(row.coupon_rate),
    put_clause: putClause, maturity_call_price: row.maturity_call_price,
  };
  const maturityFinal = parseMoney(row.maturity_call_price, 100 + (numberOrNull(row.coupon_rate) || 0));
  const maturityFlows = cashflowsToDate(profile, couponRows, maturityDate, false, maturityFinal, tradeDate);
  const maturityYield = yieldToMaturity(bondPrice, maturityFlows);
  const putFinal = putTriggerDate ? accruedPutPrice(profile, couponRows, putTriggerDate) : null;
  const putYears = putPaymentDate ? remainingYears(putPaymentDate, asOfDate) : null;
  const putYieldPreTax = putFinal != null && putYears > 0 ? annualizedRedemptionYield(bondPrice, putFinal, putYears) : null;
  const putYieldAfterTax = putFinal != null && putYears > 0 ? annualizedRedemptionYield(bondPrice, putFinal, putYears, 0.2) : null;
  const bondMarketCapRatio = remainSize != null && marketCap > 0 ? remainSize / marketCap : null;
  const stockQuoteDate = safeDate(row.stock_trade_date);
  const missing = [];
  const addMissing = (name, value, applicable = true) => { if (applicable && value == null) missing.push(name); };
  addMissing('bond_price', bondPrice);
  addMissing('conversion_value', conversionValue);
  addMissing('bond_value', bondValue);
  addMissing('stock_price', stockPrice);
  if (stockQuoteDate && tradeDate && stockQuoteDate < tradeDate) missing.push('stock_price_stale');
  addMissing('stock_volatility', volatility, stockHistory.length >= 30);
  addMissing('theoretical_option_value', optionValue, stockPrice > 0 && numberOrNull(row.current_conv_price) > 0 && years > 0 && volatility != null);
  addMissing('theoretical_value', theoreticalValue, bondValue != null && optionValue != null);
  addMissing('call_trigger_price', callTrigger, row.call_required_days != null);
  addMissing('bond_market_cap_ratio', bondMarketCapRatio, remainSize != null && marketCap > 0);
  addMissing('asset_liability_ratio', financialRatio);
  addMissing('fund_holding_ratio', fundRatio);
  addMissing('turnover_rate', turnover);
  addMissing('maturity_yield_pre_tax', maturityYield, maturityDate != null && profile.value_date != null && bondPrice > 0);
  // 回售触发日、回售到账日及回售收益已不在列表展示，不参与当前列表完整性判定。
  const diagnostics = {
    missing,
    stock_history_count: stockHistory.length,
    stock_quote_date: stockQuoteDate,
    formula: 'Black-Scholes + existing convertible-bond cashflow helpers',
  };
  const input = {
    trade_date: tradeDate, instrument_id: row.instrument_id, bondPrice, conversionValue, bondValue,
    stockPrice, currentConvPrice: numberOrNull(row.current_conv_price), volatility, marketCap,
    stockQuoteDate, financialPeriod: row.financial_period_end,
    fundReportDate: row.fund_report_date,
  };
  return {
    trade_date: tradeDate, instrument_id: row.instrument_id, formula_version: FORMULA_VERSION,
    theoretical_option_value: optionValue,
    theoretical_value: theoreticalValue,
    theoretical_deviation_pct: bondPrice > 0 && theoreticalValue > 0 ? (bondPrice - theoreticalValue) / bondPrice : null,
    stock_volatility: volatility,
    call_trigger_price: callTrigger,
    bond_market_cap_ratio: bondMarketCapRatio,
    asset_liability_ratio: financialRatio,
    fund_holding_ratio: fundRatio,
    turnover_rate: turnover,
    maturity_yield_pre_tax: maturityYield,
    earliest_put_trigger_date: putStartDate,
    earliest_put_remaining_years: putStartDate ? remainingYears(putStartDate, asOfDate) : null,
    expected_put_payment_date: putPaymentDate,
    put_yield_pre_tax: putYieldPreTax,
    put_yield_after_tax: putYieldAfterTax,
    double_low: bondPrice != null && conversionPremium != null ? bondPrice + conversionPremium * 100 : null,
    financial_period_end: safeDate(row.financial_period_end),
    fund_report_date: safeDate(row.fund_report_date),
    input_hash: hashInput(input),
    data_status: missing.length ? 'partial' : 'complete',
    diagnostics,
  };
}

async function buildDailyMetrics({ tradeDate = null, reason = 'scheduled' } = {}) {
  const date = tradeDate || await latestTradeDate();
  if (!date) throw new Error('暂无可转债行情分区，无法生成列表指标');
  const universe = await attachCallStates(await fetchUniverseRows(date));
  if (!universe.length) throw new Error(`交易日 ${date} 没有可转债列表样本`);
  const stocks = await fetchStockHistory([...new Set(universe.map(row => row.stock_instrument_id).filter(Boolean))], date);
  const couponMap = await fetchCoupons(universe.map(row => row.instrument_id));
  const metrics = universe.map(row => calculateRow(row, stocks, couponMap.get(String(row.instrument_id)) || []));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const metric of metrics) {
      await client.query(`
        INSERT INTO analytics.convertible_bond_list_metrics_daily
          (trade_date,instrument_id,formula_version,theoretical_option_value,theoretical_value,theoretical_deviation_pct,
           stock_volatility,call_trigger_price,bond_market_cap_ratio,asset_liability_ratio,fund_holding_ratio,
           turnover_rate,maturity_yield_pre_tax,earliest_put_trigger_date,earliest_put_remaining_years,
           expected_put_payment_date,put_yield_pre_tax,put_yield_after_tax,double_low,financial_period_end,
           fund_report_date,input_hash,data_status,diagnostics,calculated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,now())
        ON CONFLICT(trade_date,instrument_id,formula_version) DO UPDATE SET
          theoretical_option_value=EXCLUDED.theoretical_option_value,theoretical_value=EXCLUDED.theoretical_value,
          theoretical_deviation_pct=EXCLUDED.theoretical_deviation_pct,stock_volatility=EXCLUDED.stock_volatility,
          call_trigger_price=EXCLUDED.call_trigger_price,bond_market_cap_ratio=EXCLUDED.bond_market_cap_ratio,
          asset_liability_ratio=EXCLUDED.asset_liability_ratio,fund_holding_ratio=EXCLUDED.fund_holding_ratio,
          turnover_rate=EXCLUDED.turnover_rate,maturity_yield_pre_tax=EXCLUDED.maturity_yield_pre_tax,
          earliest_put_trigger_date=EXCLUDED.earliest_put_trigger_date,earliest_put_remaining_years=EXCLUDED.earliest_put_remaining_years,
          expected_put_payment_date=EXCLUDED.expected_put_payment_date,put_yield_pre_tax=EXCLUDED.put_yield_pre_tax,
          put_yield_after_tax=EXCLUDED.put_yield_after_tax,double_low=EXCLUDED.double_low,
          financial_period_end=EXCLUDED.financial_period_end,fund_report_date=EXCLUDED.fund_report_date,
          input_hash=EXCLUDED.input_hash,data_status=EXCLUDED.data_status,diagnostics=EXCLUDED.diagnostics,calculated_at=now()
      `, [metric.trade_date, metric.instrument_id, metric.formula_version, metric.theoretical_option_value,
        metric.theoretical_value, metric.theoretical_deviation_pct, metric.stock_volatility, metric.call_trigger_price,
        metric.bond_market_cap_ratio, metric.asset_liability_ratio, metric.fund_holding_ratio, metric.turnover_rate,
        metric.maturity_yield_pre_tax, metric.earliest_put_trigger_date, metric.earliest_put_remaining_years,
        metric.expected_put_payment_date, metric.put_yield_pre_tax, metric.put_yield_after_tax, metric.double_low,
        metric.financial_period_end, metric.fund_report_date, metric.input_hash, metric.data_status, JSON.stringify(metric.diagnostics)]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return { trade_date: date, count: metrics.length, reason, complete: metrics.filter(row => row.data_status === 'complete').length };
}

async function getBondList({ tradeDate = null, query = '', limit = 500, refreshQuotes = false } = {}) {
  const requestedDate = tradeDate || await latestTradeDate();
  const publishedDate = tradeDate ? null : await latestPublishedTradeDate();
  const stale = !tradeDate && (!publishedDate || (requestedDate && publishedDate < requestedDate));
  // 发布快照可能短暂领先底层行情（例如列表已发布 8 月 18 日，行情仍只到 8 月 17 日）。
  // 默认读取时不能拿领先日期去查底层行情，否则会把整张列表误判为空；显式指定日期仍保持精确查询。
  const date = !tradeDate && publishedDate && requestedDate && publishedDate <= requestedDate
    ? publishedDate : requestedDate;
  if (!date) return { trade_date: null, updated_at: null, count: 0, data: [] };
  const universe = await attachCallStates(await fetchUniverseRows(date));
  if (!universe.length) return { trade_date: date, updated_at: null, count: 0, data: [] };
  const [{ rows: metricRows }, safetyRatings] = await Promise.all([
    pool.query(`
      SELECT * FROM analytics.convertible_bond_list_metrics_daily
       WHERE trade_date=$1::date AND formula_version=$2
    `, [date, FORMULA_VERSION]),
    latestSafetyRatings(),
  ]);
  const metrics = new Map(metricRows.map(row => [String(row.instrument_id), row]));
  const shouldRefreshQuotes = refreshQuotes && !tradeDate;
  const intraday = shouldRefreshQuotes
    ? await loadIntradayContext(universe, true)
    : { rows: universe.map(row => ({ row, bondQuote: null, stockQuote: null, live: false })), liveCount: 0, error: null, stockHistory: new Map(), couponMap: new Map() };
  const intradayRows = new Map(intraday.rows.map(item => [String(item.row.instrument_id), item]));
  const q = String(query || '').trim().toLowerCase();
  const max = Math.max(1, Math.min(1000, Number(limit) || 500));
  const data = universe.filter(row => {
    if (!q) return true;
    return [row.canonical_code, row.bond_short_name, row.instrument_name, row.stock_name, row.stock_code]
      .some(value => String(value || '').toLowerCase().includes(q));
  }).slice(0, max).map(row => {
    const live = intradayRows.get(String(row.instrument_id));
    const sourceRow = live && live.live ? live.row : row;
    const calculated = live && live.live
      ? calculateRow(sourceRow, intraday.stockHistory, intraday.couponMap.get(String(row.instrument_id)) || [])
      : null;
    const metric = calculated || metrics.get(String(row.instrument_id)) || {};
    const rawDiagnostics = metric.diagnostics && typeof metric.diagnostics === 'object' ? metric.diagnostics : {};
    const maturityYieldFallback = metric.maturity_yield_pre_tax == null && sourceRow.close != null && row.value_date && row.maturity_date
      ? yieldToMaturity(sourceRow.close, cashflowsToDate({
        value_date: dateText(row.value_date), maturity_date: dateText(row.maturity_date),
        rate_clause: String(row.rate_clause || ''), coupon_rate: numberOrNull(row.coupon_rate),
      }, [], dateText(row.maturity_date), false,
      parseMoney(row.maturity_call_price, 100 + (numberOrNull(row.coupon_rate) || 0)), date))
      : null;
    const maturityYield = metric.maturity_yield_pre_tax == null ? maturityYieldFallback : Number(metric.maturity_yield_pre_tax);
    const missing = Array.isArray(rawDiagnostics.missing)
      ? rawDiagnostics.missing.filter(name => !LIST_IGNORED_MISSING_FIELDS.has(name) &&
        !(name === 'maturity_yield_pre_tax' && maturityYield != null)) : [];
    const dataStatus = metric.data_status === 'not_calculated' ? 'not_calculated' : missing.length ? 'partial' : 'complete';
    const diagnostics = { ...rawDiagnostics, missing };
    const bondCode = normalizeBondCode(row.canonical_code) || row.canonical_code;
    const stockChange = live && live.stockQuote && numberOrNull(live.stockQuote.change) != null
      ? numberOrNull(live.stockQuote.change) / 100
      : numberOrNull(sourceRow.stock_close) != null && numberOrNull(sourceRow.stock_prev_close) > 0
        ? numberOrNull(sourceRow.stock_close) / numberOrNull(sourceRow.stock_prev_close) - 1 : null;
    const rawPct = sourceRow.raw_payload && numberOrNull(sourceRow.raw_payload.pct_chg);
    const conversionPremium = numberOrNull(sourceRow.conversion_value) > 0 && numberOrNull(sourceRow.close) != null
      ? numberOrNull(sourceRow.close) / numberOrNull(sourceRow.conversion_value) - 1
      : numberOrNull(sourceRow.conversion_premium_pct) == null ? null : numberOrNull(sourceRow.conversion_premium_pct) / 100;
    return {
      instrument_id: row.instrument_id, bond_code: bondCode && bondCode.split('.')[0], ts_code: bondCode,
      bond_name: row.bond_short_name || row.instrument_name || bondCode,
      price: numberOrNull(sourceRow.close), change_pct: live && live.bondQuote && numberOrNull(live.bondQuote.change) != null
        ? numberOrNull(live.bondQuote.change) / 100 : rawPct == null ? null : rawPct / 100,
      stock_name: row.stock_name || row.stk_short_name || '', stock_code: row.stock_code || '',
      stock_price: numberOrNull(sourceRow.stock_close), stock_change_pct: stockChange, stock_pb: numberOrNull(row.stock_pb),
      convert_price: numberOrNull(row.current_conv_price), conversion_value: numberOrNull(sourceRow.conversion_value),
      conversion_premium: conversionPremium, bond_value: numberOrNull(row.bond_value),
      bond_floor_premium: numberOrNull(row.bond_value) > 0 && numberOrNull(sourceRow.close) != null ? numberOrNull(sourceRow.close) / numberOrNull(row.bond_value) - 1 : null,
      rating: row.newest_rating || row.issue_rating || null,
      safety: safetyRatings.get(bondCode) || safetyRatings.get(bondCode && bondCode.split('.')[0]) || '未评级',
      option_value: metric.theoretical_option_value == null ? null : Number(metric.theoretical_option_value),
      theoretical_value: metric.theoretical_value == null ? null : Number(metric.theoretical_value),
      theoretical_deviation: metric.theoretical_deviation_pct == null ? null : Number(metric.theoretical_deviation_pct),
      stock_volatility: metric.stock_volatility == null ? null : Number(metric.stock_volatility),
      call_trigger_price: row.call_trigger_price == null ? null : Number(row.call_trigger_price),
      call_status: row.call_business_status || 'incomplete',
      call_matched_days: row.call_matched_days == null ? null : Number(row.call_matched_days),
      call_required_days: row.call_required_days == null ? null : Number(row.call_required_days),
      call_remaining_days: row.call_remaining_days == null ? null : Number(row.call_remaining_days),
      call_data_status: row.call_data_status || 'incomplete',
      call_announcement_title: row.call_announcement_title || null,
      bond_market_cap_ratio: metric.bond_market_cap_ratio == null ? null : Number(metric.bond_market_cap_ratio),
      asset_liability_ratio: metric.asset_liability_ratio == null ? null : Number(metric.asset_liability_ratio),
      fund_holding_ratio: metric.fund_holding_ratio == null ? null : Number(metric.fund_holding_ratio),
      maturity_date: dateText(row.maturity_date), remaining_years: row.maturity_date ? remainingYears(row.maturity_date, new Date(`${date}T00:00:00+08:00`)) : null,
      remain_size: row.remain_size == null ? null : Number(row.remain_size) / 100000000,
      amount: row.raw_payload && numberOrNull(row.raw_payload.amount),
      turnover_rate: metric.turnover_rate == null ? null : Number(metric.turnover_rate),
      maturity_yield_pre_tax: maturityYield,
      earliest_put_trigger_date: dateText(metric.earliest_put_trigger_date),
      earliest_put_remaining_years: metric.earliest_put_remaining_years == null ? null : Number(metric.earliest_put_remaining_years),
      expected_put_payment_date: dateText(metric.expected_put_payment_date),
      put_yield_pre_tax: metric.put_yield_pre_tax == null ? null : Number(metric.put_yield_pre_tax),
      put_yield_after_tax: metric.put_yield_after_tax == null ? null : Number(metric.put_yield_after_tax),
      double_low: metric.double_low == null ? null : Number(metric.double_low),
      financial_period_end: dateText(metric.financial_period_end), fund_report_date: dateText(metric.fund_report_date),
      data_status: dataStatus, diagnostics,
    };
  });
  const latest = shouldRefreshQuotes && intraday.liveCount ? new Date().toISOString()
    : metricRows.reduce((maxDate, row) => row.calculated_at && (!maxDate || row.calculated_at > maxDate) ? row.calculated_at : maxDate, null);
  const quoteTimes = intraday.rows.flatMap(item => [item.bondQuote, item.stockQuote])
    .map(quote => quote && quote.quote_time).filter(Boolean).sort();
  return {
    trade_date: date, requested_trade_date: requestedDate, stale, updated_at: latest,
    count: data.length, total: universe.length, data, formula_version: FORMULA_VERSION,
    quote_source: shouldRefreshQuotes ? 'tencent' : null,
    quote_status: shouldRefreshQuotes ? (intraday.error || intraday.liveCount < universe.length ? 'partial' : 'fresh') : 'daily',
    quote_count: intraday.liveCount,
    quote_time: quoteTimes.length ? quoteTimes[quoteTimes.length - 1] : null,
  };
}

module.exports = { FORMULA_VERSION, latestTradeDate, latestPublishedTradeDate, fetchUniverseRows, calculateRow, buildDailyMetrics, getBondList };

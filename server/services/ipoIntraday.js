const { pool } = require('../db/connection');
const CoreDate = require('../../public/shared/core-date');
const { fetchTencentQuotes } = require('./tencentQuote');
const { resolveProviderCode } = require('./securityIdentity');

// 只在用户打开历史栏目或主动刷新时复用统一行情入口。
const inflight = new Map();
async function collectQuotes(codes, options, fetchQuotes) {
  const key = [...new Set(codes)].sort().join(',');
  if (inflight.has(key)) return inflight.get(key);
  const request = fetchQuotes(codes, options);
  inflight.set(key, request);
  try { return await request; } finally { inflight.delete(key); }
}

function firstDayPerformance(row, quote, now = new Date()) {
  const hk = row.market_code === 'HK';
  const issuePrice = Number(hk ? row.issue_price_final : row.issue_price);
  const lotSize = hk ? Number(row.lot_size_shares) : 500;
  const historical = hk ? row.actual_return : row.ld_close_change;
  const result = { first_day_return: historical == null ? null : Number(historical),
    first_day_profit: hk ? (row.lot_profit == null ? null : Number(row.lot_profit))
      : (historical != null && issuePrice > 0 ? Math.round(issuePrice * Number(historical) / 100 * lotSize * 100) / 100 : null),
    first_day_basis: historical == null ? 'unavailable' : 'close', first_day_quote_time: null,
    first_day_quote_stale: false, first_day_price: null };
  const today = CoreDate.todayInZone('Asia/Shanghai', now);
  if (row.listing_date !== today || row.listing_date_is_estimated || historical != null
    || ['postponed','cancelled','withdrawn','excluded'].includes(row.ipo_status)) return result;
  const quoteDate = quote && CoreDate.dateInZone(quote.quote_time, 'Asia/Shanghai');
  const time = quoteDate ? new Date(quote.quote_time) : null;
  const price = Number(quote && quote.price);
  // 开盘前占位价、跨日/未来行情、缺正式发行价均不能计算盘中收益。
  if (!time || CoreDate.dateInZone(time, 'Asia/Shanghai') !== today
    || CoreDate.dateTimeInZone(time, 'Asia/Shanghai').slice(11, 16) < '09:30'
    || time > now || !Number.isFinite(price) || price <= 0 || !Number.isFinite(issuePrice) || issuePrice <= 0) return result;
  return { ...result, first_day_return: Math.round((price / issuePrice - 1) * 10000) / 100,
    first_day_profit: Number.isFinite(lotSize) && lotSize > 0 ? Math.round((price - issuePrice) * lotSize * 100) / 100 : null,
    first_day_basis: 'intraday', first_day_quote_time: time.toISOString(), first_day_price: price,
    first_day_quote_stale: now - time > 3 * 60 * 1000 };
}

async function attachFirstDayPerformance(rows, market, { now = null, query = pool.query.bind(pool), resolve = resolveProviderCode,
  refresh = false, force = false, fetchQuotes = fetchTencentQuotes } = {}) {
  const today = CoreDate.todayInZone('Asia/Shanghai', now || new Date());
  const symbols = new Map();
  for (const row of rows) {
    if (row.listing_date === today && !row.listing_date_is_estimated
      && (market === 'HK' ? row.actual_return == null : row.ld_close_change == null)
      && !['postponed','cancelled','withdrawn','excluded'].includes(row.ipo_status)) {
      const symbol = await resolve({ instrumentId: row.instrument_id, sourceCode: 'tencent', identifierType: 'quote_symbol' });
      if (symbol) symbols.set(row.security_code, symbol);
    }
  }
  let refreshFailed = false;
  if (refresh && symbols.size) {
    try { await collectQuotes([...symbols.keys()], { businessDate: today, force }, fetchQuotes); }
    catch (_) { refreshFailed = true; }
  }
  const cached = symbols.size ? await query(
    "SELECT symbol,price,quote_time FROM market_quote_cache WHERE source='tencent' AND symbol=ANY($1::text[])",
    [[...new Set(symbols.values())]]) : { rows: [] };
  const quotes = new Map(cached.rows.map(row => [row.symbol, row]));
  // 只展示已持久化的报价；联网失败保留同日旧报价并明确标记。
  const displayNow = now || new Date();
  return rows.map(row => ({ ...row, ...firstDayPerformance({ ...row, market_code: market }, quotes.get(symbols.get(row.security_code)), displayNow),
    first_day_refresh_failed: refreshFailed && symbols.has(row.security_code) }));
}

module.exports = { firstDayPerformance, attachFirstDayPerformance };

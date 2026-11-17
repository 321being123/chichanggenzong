'use strict';

// 历史投影同样要带证据字段：只按价格数字推进会把候选价/未核实价当成历史收盘价。
function listHistoryPrices(executor, ...args) { return executor(`SELECT date, code, market, price::float8 AS price, quality, is_final, source, evidence FROM daily_prices
    WHERE username=$1 AND account_name=$2 AND date::date <= $3::date ORDER BY date, code`, ...args); }

function listHistoryFxRates(executor, ...args) { return executor(`SELECT DISTINCT ON (rate_date) rate_date, rate::float8 AS rate
    FROM market.fx_rates WHERE base_currency='HKD' AND quote_currency='CNY' AND rate_date <= $1
    ORDER BY rate_date ASC, fetched_at DESC, source_id DESC`, ...args); }

// 基准价必须带出证据字段：没有 quality/is_final 就无法判断这条价是已确认收盘
// 还是盘中候选/遗留未核验价，归因就会把未确认价格当作可信基准。
function listBasisPrices(executor, ...args) { return executor(`SELECT DISTINCT ON (market, code) date, code, market, price::float8 AS price, quality, is_final FROM daily_prices
        WHERE username=$1 AND account_name=$2 AND code=ANY($3::text[]) AND date::date <= $4::date
        ORDER BY market, code, date DESC`, ...args); }

function listConfirmedBasisBefore(executor, ...args) { return executor(`SELECT date::text AS date, code, market, price::float8 AS price,
        quality, is_final, source, evidence FROM daily_prices
       WHERE username=$1 AND account_name=$2 AND code=$3 AND market='CN' AND date::date<$4::date
         AND quality='confirmed' AND is_final=true AND price>0
       ORDER BY date DESC LIMIT 1`, ...args); }

function listEarlierBasisPrices(executor, ...args) { return executor(`SELECT DISTINCT ON (market, code) date, code, market, price::float8 AS price, quality, is_final FROM daily_prices
        WHERE username=$1 AND account_name=$2 AND code=ANY($3::text[]) AND date::date <= $4::date
        ORDER BY market, code, date DESC`, ...args); }

function listBasisFxRates(executor, ...args) { return executor(`SELECT DISTINCT ON (rate_date) rate_date, rate::float8 AS rate FROM market.fx_rates
      WHERE base_currency='HKD' AND quote_currency='CNY' AND rate_date <= $1
      ORDER BY rate_date ASC, fetched_at DESC, source_id DESC`, ...args); }

module.exports = { listHistoryPrices, listHistoryFxRates, listBasisPrices, listConfirmedBasisBefore, listEarlierBasisPrices, listBasisFxRates };

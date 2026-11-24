'use strict';

// daily_prices.date 在既有 schema 中是 TEXT（era01CoreSchema），历史写入统一为 YYYY-MM-DD。
// 因此这里用 ISO 文本范围比较，直接命中 (username, account_name, date DESC) /
// (market, code, date DESC) 索引；不把 date 转成 DATE，避免失去索引并全表扫描。

// 历史投影：本账户全部行，限制在需要的历史范围内。上界为最后一条净值日期；
// 下界由调用方按最早净值日回退最近应有收盘日窗口，保证周末/节假日仍能覆盖。
function listOwnPricesInRange(executor, ...args) {
  return executor(`SELECT date, code, market, price::float8 AS price, quality, is_final, source, evidence
    FROM daily_prices
    WHERE username=$1 AND account_name=$2 AND date >= $3 AND date <= $4
    ORDER BY date, code, market`, ...args);
}

// 历史/归因的停牌或旧本地参考：每个「市场 + 代码」只取下界之前最近一条
// confirmed + final 正价。一次批量返回，不逐券查询。
function listOwnConfirmedBefore(executor, ...args) {
  return executor(`SELECT DISTINCT ON (market, code)
          date, code, market, price::float8 AS price, quality, is_final, source, evidence
    FROM daily_prices
    WHERE username=$1 AND account_name=$2 AND date < $3
      AND quality='confirmed' AND is_final=true AND price>0
    ORDER BY market, code, date DESC`, ...args);
}

// 共享候选：只按调用方明确给出的「市场 + 代码 + 应有收盘日」精确读取其它账户的
// confirmed + final 正价，排除账户私有派生来源。JOIN 走 (market, code, date DESC) 索引，
// 不读取任何非目标日期的共享历史行。
function listSharedConfirmedAt(executor, ...args) {
  return executor(`WITH wanted AS (
      SELECT * FROM jsonb_to_recordset($3::jsonb) AS w(market text, code text, date text)
    )
    SELECT dp.date, dp.code, dp.market, dp.price::float8 AS price,
           dp.quality, dp.is_final, dp.source, dp.evidence
    FROM wanted w
    JOIN daily_prices dp
      ON dp.market=w.market AND dp.code=w.code AND dp.date=w.date
    WHERE dp.quality='confirmed' AND dp.is_final=true AND dp.price>0
      AND COALESCE(dp.source,'') <> ALL($4::text[])
      AND NOT (dp.username=$1 AND dp.account_name=$2)
    ORDER BY dp.market, dp.code, dp.date`, ...args);
}

// 区间内已有共享确认价：历史补价在访问上游日线之前先查本地已确认价，命中即复用。
function listSharedConfirmedRange(executor, ...args) {
  return executor(`SELECT dp.date, dp.code, dp.market, dp.price::float8 AS price,
           dp.quality, dp.is_final, dp.source, dp.evidence
      FROM daily_prices dp
     WHERE dp.market=$3 AND dp.code = ANY($4::text[])
       AND dp.date BETWEEN $5 AND $6
       AND dp.quality='confirmed' AND dp.is_final=true AND dp.price>0
       AND COALESCE(dp.source,'') <> ALL($7::text[])
       AND NOT (dp.username=$1 AND dp.account_name=$2)
     ORDER BY dp.date, dp.code`, ...args);
}

// 基准价：本账户在明确目标日期的全部行，保留候选/遗留证据供业务层判资格；
// 只按目标日期精确读取，不再拉取全历史后由 JS 丢弃旧行。
function listOwnPricesAt(executor, ...args) {
  return executor(`WITH wanted AS (
      SELECT * FROM jsonb_to_recordset($3::jsonb) AS w(market text, code text, date text)
    )
    SELECT dp.date, dp.code, dp.market, dp.price::float8 AS price,
           dp.quality, dp.is_final, dp.source, dp.evidence
    FROM wanted w
    JOIN daily_prices dp
      ON dp.username=$1 AND dp.account_name=$2
     AND dp.market=w.market AND dp.code=w.code AND dp.date=w.date
    ORDER BY dp.market, dp.code, dp.date`, ...args);
}

// 归因停牌/旧本地参考：对每个明确目标日期，只取本账户在该日之前最近一条
// confirmed + final 正价。一次批量 LATERAL，不逐券往返数据库。
function listOwnConfirmedBeforePairs(executor, ...args) {
  return executor(`WITH wanted AS (
      SELECT * FROM jsonb_to_recordset($3::jsonb) AS w(market text, code text, date text)
    )
    SELECT w.market AS wanted_market, w.code AS wanted_code, w.date AS wanted_date,
           dp.date, dp.code, dp.market, dp.price::float8 AS price,
           dp.quality, dp.is_final, dp.source, dp.evidence
    FROM wanted w
    JOIN LATERAL (
      SELECT date, code, market, price, quality, is_final, source, evidence
      FROM daily_prices
      WHERE username=$1 AND account_name=$2 AND market=w.market AND code=w.code
        AND date < w.date AND quality='confirmed' AND is_final=true AND price>0
      ORDER BY date DESC LIMIT 1
    ) dp ON true
    ORDER BY w.market, w.code, w.date`, ...args);
}

// 旧本地参考：对每个明确目标截点，只取本账户在该截点当天或之前最近一条正价行
// （不限定质量）。业务层仅在精确应有收盘日缺失时用它做数值参考，并保持不完整标记。
function listOwnLatestBeforePairs(executor, ...args) {
  return executor(`WITH wanted AS (
      SELECT * FROM jsonb_to_recordset($3::jsonb) AS w(market text, code text, date text)
    )
    SELECT w.market AS wanted_market, w.code AS wanted_code, w.date AS wanted_date,
           dp.date, dp.code, dp.market, dp.price::float8 AS price,
           dp.quality, dp.is_final, dp.source, dp.evidence
    FROM wanted w
    JOIN LATERAL (
      SELECT date, code, market, price, quality, is_final, source, evidence
      FROM daily_prices
      WHERE username=$1 AND account_name=$2 AND market=w.market AND code=w.code
        AND date <= w.date AND price>0
      ORDER BY date DESC LIMIT 1
    ) dp ON true
    ORDER BY w.market, w.code, w.date`, ...args);
}

function listHistoryFxRates(executor, ...args) { return executor(`SELECT DISTINCT ON (rate_date) rate_date, rate::float8 AS rate
    FROM market.fx_rates WHERE base_currency='HKD' AND quote_currency='CNY' AND rate_date <= $1
    ORDER BY rate_date ASC, fetched_at DESC, source_id DESC`, ...args); }

function listBasisFxRates(executor, ...args) { return executor(`SELECT DISTINCT ON (rate_date) rate_date, rate::float8 AS rate FROM market.fx_rates
      WHERE base_currency='HKD' AND quote_currency='CNY' AND rate_date <= $1
      ORDER BY rate_date ASC, fetched_at DESC, source_id DESC`, ...args); }

module.exports = {
  listOwnPricesInRange,
  listOwnConfirmedBefore,
  listSharedConfirmedAt,
  listSharedConfirmedRange,
  listOwnPricesAt,
  listOwnConfirmedBeforePairs,
  listOwnLatestBeforePairs,
  listHistoryFxRates,
  listBasisFxRates,
};

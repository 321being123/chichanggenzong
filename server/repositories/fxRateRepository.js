const { pool } = require('../db/connection');

// 港币兑人民币汇率事实读写：唯一落库来源，按抓取时间取最新版本。

async function readRateForDate(rateDate, client = pool) {
  const { rows } = await client.query(
    `SELECT rate::float8 AS rate
       FROM market.fx_rates
      WHERE base_currency='HKD' AND quote_currency='CNY' AND rate_date=$1
      ORDER BY fetched_at DESC
      LIMIT 1`,
    [rateDate],
  );
  return rows[0] || null;
}

async function readLatestRateUpTo(date, client = pool) {
  const { rows } = await client.query(
    `SELECT rate::float8 AS rate, rate_date::text AS rate_date, fetched_at
       FROM market.fx_rates
      WHERE base_currency='HKD' AND quote_currency='CNY' AND rate_date <= $1
      ORDER BY rate_date DESC, fetched_at DESC
      LIMIT 1`,
    [date],
  );
  return rows[0] || null;
}

async function upsertRate({ rateDate, sourceId, rate }, client = pool) {
  await client.query(
    `INSERT INTO market.fx_rates(base_currency,quote_currency,rate_date,source_id,rate,fetched_at)
     VALUES ('HKD','CNY',$1,$2,$3,now())
     ON CONFLICT (base_currency,quote_currency,rate_date)
     DO UPDATE SET source_id=EXCLUDED.source_id, rate=EXCLUDED.rate, fetched_at=EXCLUDED.fetched_at`,
    [rateDate, sourceId, rate],
  );
}

async function syncLegacyAccountRates(rate, client = pool) {
  const result = await client.query(
    `UPDATE accounts
        SET hk_rate=$1, hk_rate_updated_at=now(), updated_at=to_char(now(),'YYYY-MM-DD HH24:MI:SS')
      WHERE hk_rate IS DISTINCT FROM $1`,
    [rate],
  );
  return result.rowCount;
}

// ---- 非港币币种对（外币财报折算用） ----
// 只读写 market.fx_rates 同一张表的其他币种对，不参与账户估值与旧字段同步；
// 港币→人民币的专用函数保持原样，行为不变。

async function readLatestRatePairUpTo({ baseCurrency, quoteCurrency, date }, client = pool) {
  const { rows } = await client.query(
    `SELECT rate::float8 AS rate, rate_date::text AS rate_date, fetched_at
       FROM market.fx_rates
      WHERE base_currency=$1 AND quote_currency=$2 AND rate_date <= $3
      ORDER BY rate_date DESC, fetched_at DESC
      LIMIT 1`,
    [String(baseCurrency).toUpperCase(), String(quoteCurrency).toUpperCase(), date],
  );
  return rows[0] || null;
}

async function upsertRatePair({ baseCurrency, quoteCurrency, rateDate, sourceId, rate }, client = pool) {
  await client.query(
    `INSERT INTO market.fx_rates(base_currency,quote_currency,rate_date,source_id,rate,fetched_at)
     VALUES ($1,$2,$3,$4,$5,now())
     ON CONFLICT (base_currency,quote_currency,rate_date)
     DO UPDATE SET source_id=EXCLUDED.source_id, rate=EXCLUDED.rate, fetched_at=EXCLUDED.fetched_at`,
    [String(baseCurrency).toUpperCase(), String(quoteCurrency).toUpperCase(), rateDate, sourceId, rate],
  );
}

async function readSourceIdByCode(sourceCode, client = pool) {
  const { rows } = await client.query(
    'SELECT source_id FROM ops.data_sources WHERE source_code=$1',
    [sourceCode],
  );
  return rows.length ? rows[0].source_id : null;
}

module.exports = {
  readRateForDate, readLatestRateUpTo, upsertRate, syncLegacyAccountRates,
  readLatestRatePairUpTo, upsertRatePair, readSourceIdByCode,
};

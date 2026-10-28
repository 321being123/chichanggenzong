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

module.exports = { readRateForDate, readLatestRateUpTo, upsertRate, syncLegacyAccountRates };

// 全站港币→人民币汇率单一来源。
// accounts.hk_rate 和 nav_history.hk_rate 只作为旧版本兼容缓存，不能作为新估值依据。
const { pool } = require('../db/connection');

function cnDate(value) {
  const d = value instanceof Date ? value : new Date(value || Date.now());
  const cn = new Date(d.getTime() + (d.getTimezoneOffset() + 480) * 60000);
  const pad = n => String(n).padStart(2, '0');
  return cn.getUTCFullYear() + '-' + pad(cn.getUTCMonth() + 1) + '-' + pad(cn.getUTCDate());
}

function validRate(value) {
  const rate = Number(value);
  return Number.isFinite(rate) && rate > 0.5 && rate < 1.5 ? rate : null;
}

async function getFxRate(rateDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(rateDate || ''))) return null;
  const { rows } = await pool.query(
    `SELECT rate::float8 AS rate
       FROM market.fx_rates
      WHERE base_currency='HKD' AND quote_currency='CNY' AND rate_date=$1
      ORDER BY fetched_at DESC
      LIMIT 1`,
    [rateDate]
  );
  return rows[0] && validRate(rows[0].rate);
}

async function getCurrentFxRate() {
  const today = cnDate(new Date());
  const todayRate = await getFxRate(today);
  if (todayRate) return todayRate;
  const { rows } = await pool.query(
    `SELECT rate::float8 AS rate
       FROM market.fx_rates
      WHERE base_currency='HKD' AND quote_currency='CNY' AND rate_date <= $1
      ORDER BY rate_date DESC, fetched_at DESC
      LIMIT 1`,
    [today]
  );
  return rows[0] && validRate(rows[0].rate);
}

async function upsertFxRate(value, options = {}) {
  const rate = validRate(value);
  if (!rate) throw new Error('港币汇率不在有效范围内');
  const rateDate = options.rateDate || cnDate(new Date());
  const sourceId = Number(options.sourceId || 7);
  await pool.query(
    `INSERT INTO market.fx_rates(base_currency,quote_currency,rate_date,source_id,rate,fetched_at)
     VALUES ('HKD','CNY',$1,$2,$3,now())
     ON CONFLICT (base_currency,quote_currency,rate_date)
     DO UPDATE SET source_id=EXCLUDED.source_id, rate=EXCLUDED.rate, fetched_at=EXCLUDED.fetched_at`,
    [rateDate, sourceId, rate]
  );
  return rate;
}

async function syncLegacyAccountRates(rate) {
  const normalized = validRate(rate);
  if (!normalized) return 0;
  const result = await pool.query(
    `UPDATE accounts
        SET hk_rate=$1, hk_rate_updated_at=now(), updated_at=to_char(now(),'YYYY-MM-DD HH24:MI:SS')
      WHERE hk_rate IS DISTINCT FROM $1`,
    [normalized]
  );
  return result.rowCount;
}

module.exports = { cnDate, validRate, getFxRate, getCurrentFxRate, upsertFxRate, syncLegacyAccountRates };

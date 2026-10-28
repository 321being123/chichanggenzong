// 全站港币→人民币汇率单一来源。
// accounts.hk_rate 和 nav_history.hk_rate 只作为旧版本兼容缓存，不能作为新估值依据。
const fxRateRepository = require('../repositories/fxRateRepository');
const CoreDate = require('../../public/shared/core-date.js');

function cnDate(value) {
  const businessDate = CoreDate.normalizeBusinessDate(value);
  if (businessDate) return businessDate;
  const instant = value instanceof Date ? value : new Date(value || Date.now());
  const date = CoreDate.dateInZone(instant, 'Asia/Shanghai');
  if (!date) throw new TypeError('汇率日期必须是 YYYY-MM-DD 业务日期或带时区的有效时刻');
  return date;
}

function validRate(value) {
  const rate = Number(value);
  return Number.isFinite(rate) && rate > 0.5 && rate < 1.5 ? rate : null;
}

async function getFxRate(rateDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(rateDate || ''))) return null;
  const row = await fxRateRepository.readRateForDate(rateDate);
  return row && validRate(row.rate);
}

async function getCurrentFxRate() {
  const snapshot = await getCurrentFxRateSnapshot();
  return snapshot && snapshot.rate;
}

async function getCurrentFxRateSnapshot() {
  const today = cnDate(new Date());
  const row = await fxRateRepository.readLatestRateUpTo(today);
  const rate = row && validRate(row.rate);
  return rate ? { rate, rateDate: row.rate_date, fetchedAt: row.fetched_at || null } : null;
}

async function upsertFxRate(value, options = {}) {
  const rate = validRate(value);
  if (!rate) throw new Error('港币汇率不在有效范围内');
  const rateDate = options.rateDate || cnDate(new Date());
  const sourceId = Number(options.sourceId || 7);
  await fxRateRepository.upsertRate({ rateDate, sourceId, rate });
  return rate;
}

async function syncLegacyAccountRates(rate) {
  const normalized = validRate(rate);
  if (!normalized) return 0;
  return fxRateRepository.syncLegacyAccountRates(normalized);
}

module.exports = { cnDate, validRate, getFxRate, getCurrentFxRate, getCurrentFxRateSnapshot, upsertFxRate, syncLegacyAccountRates };

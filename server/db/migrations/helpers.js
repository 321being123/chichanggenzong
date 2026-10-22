// 迁移内部共用的小工具（数值/日期归一化）
// R-6 拆分自 ../migrations.js（2026-10-21）：仅供迁移函数内部使用。
const { pool, crypto, fs, path, DATA_DIR, DEFAULT_FEE_SETTINGS } = require('../connection');
const { uid, round, bulkInsert, hashPwd, safeEqual, verifyPwd, hashString } = require('../util');

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeMigrationDate(value) {
  const text = String(value || '').replace(/-/g, '').slice(0, 8);
  return /^\d{8}$/.test(text) ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}` : null;
}

function normalizeMigrationTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeMigrationStockCode(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw) return null;
  if (raw.includes('.')) return raw;
  return /^(0|3)/.test(raw) ? `${raw}.SZ` : `${raw}.SH`;
}

function scale100m(value, divisor) {
  const number = toNumber(value);
  return number == null ? null : number / divisor;
}

module.exports = {
  toNumber,
  normalizeMigrationDate,
  normalizeMigrationTimestamp,
  normalizeMigrationStockCode,
  scale100m,
};

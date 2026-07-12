// ========== 休市日配置（运行时读取，改此 JSON 即时生效，无需部署） ==========
// worker 进程每次跑收盘/补漏时现读本文件；ensureHolidaysCurrent 会按官方日历重写它。
const fs = require('fs');
const path = require('path');
const CONFIG = path.join(__dirname, 'holidays.json');

let _cache = null;
let _cacheDay = '';

function todayCN() {
  const now = new Date();
  const cn = new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60000);
  const p = n => String(n).padStart(2, '0');
  return cn.getUTCFullYear() + '-' + p(cn.getUTCMonth() + 1) + '-' + p(cn.getUTCDate());
}

// 读取（当日缓存，避免同进程内频繁读盘）
function loadHolidays() {
  const day = todayCN();
  if (_cache && _cacheDay === day) return _cache;
  let obj = { updatedAt: '', years: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      obj = parsed;
      if (!obj.years || typeof obj.years !== 'object') obj.years = {};
    }
  } catch (e) { /* 文件缺失/损坏则用空 */ }
  _cache = obj;
  _cacheDay = day;
  return obj;
}

// 写回（ensureHolidaysCurrent 年度自愈时调用）
function saveHolidays(obj) {
  obj.updatedAt = obj.updatedAt || todayCN();
  fs.writeFileSync(CONFIG, JSON.stringify(obj, null, 2));
  _cache = obj;
  _cacheDay = todayCN();
}

// 是否为法定节假日（不含周末，周末由 isTradingDay 另行排除）
function isCnHoliday(dateStr) {
  const obj = loadHolidays();
  const y = String(dateStr || '').slice(0, 4);
  const list = obj.years && obj.years[y];
  if (!list || !Array.isArray(list)) return false;
  return list.indexOf(dateStr) >= 0;
}

// 已覆盖的最新年份（用于判断是否跨年需联网）
function getCoveredYear(obj) {
  obj = obj || loadHolidays();
  const ys = Object.keys(obj.years || {}).map(Number).filter(n => !isNaN(n));
  return ys.length ? Math.max.apply(null, ys) : 0;
}

module.exports = { loadHolidays, saveHolidays, isCnHoliday, getCoveredYear, CONFIG };

// ========== 休市日配置（Git 种子 + 运行时副本） ==========
const fs = require('fs');
const path = require('path');
const SEED_CONFIG = path.join(__dirname, 'holidays.json');
const CONFIG = process.env.HOLIDAY_CONFIG_PATH || path.resolve(__dirname, '..', '..', 'data', 'holidays.json');

let _cache = null;
let _cacheDay = '';
let _loadError = null;

function atomicReplace(temp, target) {
  try {
    fs.renameSync(temp, target);
    return;
  } catch (error) {
    // Windows 不能直接 rename 覆盖已有文件；先把旧副本移到同目录，失败时恢复。
    if (!fs.existsSync(target)) throw error;
    const backup = `${target}.${process.pid}.bak`;
    fs.renameSync(target, backup);
    try {
      fs.renameSync(temp, target);
      fs.rmSync(backup, { force: true });
    } catch (replaceError) {
      if (!fs.existsSync(target) && fs.existsSync(backup)) fs.renameSync(backup, target);
      throw replaceError;
    }
  }
}

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
    if (!fs.existsSync(CONFIG)) {
      fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
      const seed = fs.readFileSync(SEED_CONFIG, 'utf8');
      const temp = `${CONFIG}.${process.pid}.tmp`;
      fs.writeFileSync(temp, seed, { encoding: 'utf8', mode: 0o600 });
      atomicReplace(temp, CONFIG);
    }
    const parsed = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      obj = parsed;
      if (!obj.years || typeof obj.years !== 'object') obj.years = {};
    }
    _loadError = null;
  } catch (e) {
    _loadError = e;
    console.error('[holiday] 运行时休市日历加载失败:', e.message);
    try {
      const parsed = JSON.parse(fs.readFileSync(SEED_CONFIG, 'utf8'));
      if (parsed && typeof parsed === 'object') obj = parsed;
    } catch (_) { /* 保留空配置，由任务告警暴露 */ }
  }
  _cache = obj;
  _cacheDay = day;
  return obj;
}

// 写回（ensureHolidaysCurrent 年度自愈时调用）
function saveHolidays(obj) {
  obj.updatedAt = obj.updatedAt || todayCN();
  const content = JSON.stringify(obj, null, 2);
  const current = fs.existsSync(CONFIG) ? fs.readFileSync(CONFIG, 'utf8') : '';
  if (current !== content) {
    fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
    const temp = `${CONFIG}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(temp, content, { encoding: 'utf8', mode: 0o600 });
      atomicReplace(temp, CONFIG);
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
  }
  _loadError = null;
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

function getHolidayLoadError() { return _loadError; }

module.exports = { loadHolidays, saveHolidays, isCnHoliday, getCoveredYear, getHolidayLoadError, CONFIG, SEED_CONFIG };

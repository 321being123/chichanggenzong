// ========== 休市日年度自愈：每月核对官方日历（Tushare trade_cal），不一致则重写本地 JSON（零部署） ==========
// 由 worker 进程调用（pm2 常驻），不依赖 WorkBuddy 自动化，跨年自动跟上。
const { tushareQuery, normDate } = require('../services/market');
const { loadHolidays, saveHolidays, getCoveredYear } = require('../config/holidays');

const REFRESH_DAYS = 30;

function daysSince(obj) {
  if (!obj || !obj.updatedAt) return 9999;
  return (Date.now() - new Date(obj.updatedAt).getTime()) / 86400000;
}

// 取某年 SSE 交易日历，返回「非周末且休市」的日期数组（= 法定节假日，与 holidays.json 口径一致）
async function fetchTradeCal(year) {
  const sd = year + '0101';
  const ed = year + '1231';
  const data = await tushareQuery('trade_cal', { exchange: 'SSE', start_date: sd, end_date: ed }, 'cal_date,is_open');
  if (!data) return null;
  const fields = data.fields || [];
  const rows = (data.items || []).map(it => {
    const o = {};
    fields.forEach((f, i) => { o[f] = it[i]; });
    return o;
  });
  const hol = [];
  for (const r of rows) {
    const ds = normDate(r.cal_date);
    const day = new Date(ds + 'T00:00:00').getDay();
    if (day === 0 || day === 6) continue; // 周末不计入法定节假日
    if (r.is_open === '0' || r.is_open === 0) hol.push(ds);
  }
  return hol.sort();
}

async function ensureHolidaysCurrent() {
  const obj = loadHolidays();
  const year = new Date().getFullYear();
  const stale = daysSince(obj) > REFRESH_DAYS;
  const covered = getCoveredYear(obj);
  if (covered >= year && !stale) {
    console.log('[holiday] 休市日已是最新，跳过联网');
    return;
  }
  const hol = await fetchTradeCal(year);
  if (!hol) { console.warn('[holiday] Tushare 取历失败，保留旧数据'); return; }
  let next = null;
  if (new Date().getMonth() === 11) { // 12 月预拉明年（交易所已公布全年日历）
    next = await fetchTradeCal(year + 1);
  }
  const nextObj = { updatedAt: new Date().toISOString().slice(0, 10), years: { [year]: hol } };
  if (next) nextObj.years[year + 1] = next;
  saveHolidays(nextObj);
  console.log('[holiday] 已更新休市日: ' + year + ' (' + hol.length + '天)' + (next ? ' + 次年' + next.length + '天' : ''));
}

module.exports = { ensureHolidaysCurrent, fetchTradeCal };

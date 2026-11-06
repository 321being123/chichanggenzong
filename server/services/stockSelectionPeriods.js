// 投资策略选股中心 V2：周期键与目标日解析（方案第 27.6 节）。
// 只做"日期 → 周期键/目标交易日"的确定性换算，不读库、不联网；日历由调用方传入。
'use strict';

const PERIOD_TYPES = Object.freeze(['day', 'week', 'quarter']);

function pad2(value) { return String(value).padStart(2, '0'); }

function shiftDays(date, days) {
  const dt = new Date(`${date}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** 周一起始日（市场当地周一至周日为工程默认周边界，方案 27.6）。 */
function weekMondayOf(date) {
  const dt = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(dt.getTime())) return null;
  const offset = (dt.getUTCDay() + 6) % 7; // 周一=0 … 周日=6
  return shiftDays(date, -offset);
}

function quarterOf(date) {
  const month = Number(String(date).slice(5, 7));
  return `${String(date).slice(0, 4)}Q${Math.ceil(month / 3)}`;
}

/**
 * 周期键：day=D:YYYY-MM-DD、week=W:<周一起始日>、quarter=Q:YYYYQn。
 * 周键用起始日而不是「自然年＋第几周」，避免公历年与周序号跨年冲突。
 */
function periodKeyOf(periodType, date) {
  const type = String(periodType || '').toLowerCase();
  if (!PERIOD_TYPES.includes(type)) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return null;
  if (type === 'day') return `D:${date}`;
  if (type === 'quarter') return `Q:${quarterOf(date)}`;
  const monday = weekMondayOf(date);
  return monday ? `W:${monday}` : null;
}

/** 周期起止（用于 runs.period_start/period_end 与发布指针）。 */
function periodRangeOf(periodType, periodKey) {
  const key = String(periodKey || '');
  if (String(periodType) === 'day') {
    const match = /^D:(\d{4}-\d{2}-\d{2})$/.exec(key);
    return match ? { periodStart: match[1], periodEnd: match[1] } : null;
  }
  if (String(periodType) === 'week') {
    const match = /^W:(\d{4}-\d{2}-\d{2})$/.exec(key);
    return match ? { periodStart: match[1], periodEnd: shiftDays(match[1], 6) } : null;
  }
  if (String(periodType) === 'quarter') {
    const match = /^Q:(\d{4})Q([1-4])$/.exec(key);
    if (!match) return null;
    const year = Number(match[1]);
    const quarter = Number(match[2]);
    const startMonth = (quarter - 1) * 3 + 1;
    const endMonth = quarter * 3;
    const endDay = [31, (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 29 : 28,
      31, 30, 31, 30, 31, 31, 30, 31, 30, 31][endMonth - 1];
    return { periodStart: `${year}-${pad2(startMonth)}-01`, periodEnd: `${year}-${pad2(endMonth)}-${pad2(endDay)}` };
  }
  return null;
}

/** 目标交易日：给定周期内的最后一个开市日；日历缺档/整周休市返回明确原因，不猜。 */
function lastSessionOf(calendar, periodStart, periodEnd) {
  const days = (calendar || []).filter(day => day >= periodStart && day <= periodEnd);
  if (!days.length) return null;
  return days[days.length - 1];
}

module.exports = { PERIOD_TYPES, periodKeyOf, periodRangeOf, weekMondayOf, quarterOf, shiftDays, lastSessionOf };

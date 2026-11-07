// 投资策略选股中心 V2：周期键与目标日解析（方案第 27.6 节）。
// 只做"日期 → 周期键/目标交易日"的确定性换算，不读库、不联网；日历由调用方传入。
'use strict';

const PERIOD_TYPES = Object.freeze(['day', 'week', 'quarter']);

function pad2(value) { return String(value).padStart(2, '0'); }

/** 真实日历日校验：正则只能挡格式，2026-02-31 这类不存在日期必须在这里拒绝（方案 27.6/27.7）。 */
function isRealDate(value) {
  const text = String(value === undefined || value === null ? '' : value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const dt = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(dt.getTime())) return false;
  // Date 会把 2026-02-31 归一成 2026-03-03；回验相等才算真实日期。
  return dt.toISOString().slice(0, 10) === text;
}

function shiftDays(date, days) {
  const dt = new Date(`${date}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** 周一起始日（市场当地周一至周日为工程默认周边界，方案 27.6）。 */
function weekMondayOf(date) {
  if (!isRealDate(date)) return null;
  const dt = new Date(`${date}T00:00:00Z`);
  const offset = (dt.getUTCDay() + 6) % 7; // 周一=0 … 周日=6
  return shiftDays(date, -offset);
}

function isMonday(date) {
  if (!isRealDate(date)) return false;
  return new Date(`${date}T00:00:00Z`).getUTCDay() === 1;
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
  if (!isRealDate(date)) return null;
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
    return match && isRealDate(match[1]) ? { periodStart: match[1], periodEnd: match[1] } : null;
  }
  if (String(periodType) === 'week') {
    const match = /^W:(\d{4}-\d{2}-\d{2})$/.exec(key);
    // 周键必须是周一起始日；周二/周日当起点会让发布渠道与真实周边界错位（AC-10）。
    if (!match || !isMonday(match[1])) return null;
    return { periodStart: match[1], periodEnd: shiftDays(match[1], 6) };
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

/** 逐日枚举闭区间日期（周期最大 7 或 92 天，量级安全）。 */
function enumerateDates(periodStart, periodEnd) {
  if (!isRealDate(periodStart) || !isRealDate(periodEnd) || periodStart > periodEnd) return [];
  const dates = [];
  let cursor = periodStart;
  while (cursor <= periodEnd) {
    dates.push(cursor);
    cursor = shiftDays(cursor, 1);
  }
  return dates;
}

/**
 * 逐日日历证据（方案 27.5 第 1 条 / 27.6）：必须区分「整周期休市」和「日历缺档」。
 * rows 是区间内全部日历行（含 is_open=false），不是只筛开市日的结果。
 * - calendarComplete=true 表示区间每一天都有日历记录；
 * - 缺任何一天就记 missingDates，调用方不得在该证据下确定目标 T；
 * - 同日多交易所只按「任一开市」计一次，不重复计数。
 */
function calendarEvidenceOf(rows, periodStart, periodEnd) {
  const byDate = new Map();
  (rows || []).forEach(row => {
    const date = typeof row === 'string' ? row : (row && (row.trade_date || row.tradeDate));
    if (!isRealDate(date)) return;
    const raw = typeof row === 'string' ? true : (row.is_open === undefined ? row.isOpen : row.is_open);
    const open = raw !== false && raw !== 'false';
    byDate.set(date, (byDate.get(date) || false) || open);
  });
  const expectedDates = enumerateDates(periodStart, periodEnd);
  const missingDates = expectedDates.filter(date => !byDate.has(date));
  const openDays = expectedDates.filter(date => byDate.get(date) === true);
  return {
    calendarComplete: expectedDates.length > 0 && missingDates.length === 0,
    expectedCalendarDays: expectedDates.length,
    missingDates,
    openDays,
    closedDays: expectedDates.filter(date => byDate.get(date) === false).length,
  };
}

module.exports = {
  PERIOD_TYPES, isRealDate, isMonday, periodKeyOf, periodRangeOf, weekMondayOf, quarterOf,
  shiftDays, lastSessionOf, enumerateDates, calendarEvidenceOf,
};

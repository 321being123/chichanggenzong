// ========== 休市日年度自愈：每月核对官方日历（Tushare trade_cal），不一致则重写本地 JSON（零部署） ==========
// 由 systemd 托管的 worker 进程调用，不依赖 WorkBuddy 自动化，跨年自动跟上。
const { tushareQuery, normDate } = require('../services/market');
const { loadHolidays, saveHolidays, getHolidayLoadError } = require('../config/holidays');
const { pool } = require('../db/connection');
const CoreDate = require('../../public/shared/core-date');

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

function datesForYear(year) {
  const dates = [];
  for (let day = new Date(`${year}-01-01T00:00:00Z`); day.getUTCFullYear() === Number(year); day.setUTCDate(day.getUTCDate() + 1)) {
    dates.push(CoreDate.dateInZone(day, 'UTC'));
  }
  return dates;
}

function calendarHolidays(rows) {
  return rows.filter(row => !row.is_open && ![0, 6].includes(new Date(`${row.trade_date}T00:00:00Z`).getUTCDay()))
    .map(row => row.trade_date).sort();
}

function validateCalendarRows(data, expectedDates) {
  if (!data || !Array.isArray(data.fields) || !Array.isArray(data.items)) throw new Error('交易日历响应缺失');
  const dateIndex = data.fields.indexOf('cal_date');
  const openIndex = data.fields.indexOf('is_open');
  if (dateIndex < 0 || openIndex < 0) throw new Error('交易日历缺少日期或开休市字段');
  const expected = new Set(expectedDates);
  const rows = new Map();
  for (const item of data.items) {
    const date = normDate(item[dateIndex]);
    const open = String(item[openIndex]);
    if (!expected.has(date) || !['0', '1'].includes(open) || rows.has(date)) throw new Error('交易日历含越界、重复或非法日期状态');
    rows.set(date, { exchange: 'SSE', trade_date: date, is_open: open === '1',
      raw_payload: { cal_date: item[dateIndex], is_open: item[openIndex] } });
  }
  if (rows.size !== expected.size) throw new Error('交易日历覆盖不完整，保留原数据');
  return [...rows.values()].sort((a, b) => a.trade_date.localeCompare(b.trade_date));
}

async function storeCalendar(client, rows, source) {
  await client.query(`INSERT INTO market.trade_calendar(exchange,trade_date,is_open,source_code,raw_payload)
    SELECT x.exchange,x.trade_date,x.is_open,$2,x.raw_payload FROM jsonb_to_recordset($1::jsonb)
      AS x(exchange text,trade_date date,is_open boolean,raw_payload jsonb)
    ON CONFLICT(exchange,trade_date) DO UPDATE SET is_open=EXCLUDED.is_open,
      source_code=EXCLUDED.source_code,raw_payload=EXCLUDED.raw_payload,ingested_at=now()`, [JSON.stringify(rows), source]);
}

async function withCalendarLock(work) {
  const client = await pool.connect();
  let locked = false;
  try {
    locked = (await client.query("SELECT pg_try_advisory_lock(hashtext('holiday_sync')) AS locked")).rows[0].locked;
    if (!locked) return { ok: false, skipped: true, reason: 'already_running' };
    return await work(client);
  } finally {
    try { if (locked) await client.query("SELECT pg_advisory_unlock(hashtext('holiday_sync'))"); }
    finally { client.release(); }
  }
}

async function saveManualHolidays(year, dates) {
  const expectedDates = datesForYear(year);
  const expected = new Set(expectedDates);
  if (!dates.every(date => expected.has(date)) || new Set(dates).size !== dates.length) throw new Error('休市日期必须属于维护年份且不能重复');
  const result = await withCalendarLock(async client => {
    const obj = loadHolidays();
    if (getHolidayLoadError()) throw getHolidayLoadError();
    const holidays = new Set(dates);
    const rows = expectedDates.map(date => ({ exchange: 'SSE', trade_date: date,
      is_open: !holidays.has(date) && ![0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay()),
      raw_payload: { manual_year: Number(year), calendar_basis: 'administrator_annual_schedule' } }));
    await storeCalendar(client, rows, 'admin_holiday_schedule');
    saveHolidays({ ...obj, years: { ...obj.years, [year]: [...dates].sort() },
      manualYears: { ...obj.manualYears, [year]: true }, updatedAt: CoreDate.todayInZone('Asia/Shanghai') });
    return { ok: true };
  });
  if (!result.ok) throw new Error('日历同步正在执行，请稍后保存');
  return result;
}

async function ensureHolidaysCurrent({ businessDate = CoreDate.todayInZone('Asia/Shanghai') } = {}) {
  return withCalendarLock(async client => {
  const obj = loadHolidays();
  const loadError = getHolidayLoadError();
  if (loadError) throw new Error(`运行时休市日历不可写或已损坏：${loadError.message}`);
  const year = Number(businessDate.slice(0, 4));
  const stale = daysSince(obj) > REFRESH_DAYS;
  const nextObj = { ...obj, years: { ...obj.years } };
  const years = businessDate.slice(5, 7) === '12' ? [year, year + 1] : [year];
  for (const targetYear of years) {
    const expectedDates = datesForYear(targetYear);
    const { rows } = await client.query(`SELECT trade_date::text AS trade_date,is_open,source_code,raw_payload
      FROM market.trade_calendar WHERE exchange='SSE' AND trade_date BETWEEN $1::date AND $2::date ORDER BY trade_date`,
    [expectedDates[0], expectedDates[expectedDates.length - 1]]);
    const known = new Set(rows.map(row => row.trade_date));
    const missing = expectedDates.filter(date => !known.has(date));
    const manual = obj.manualYears?.[targetYear] || rows.some(row => row.source_code === 'admin_holiday_schedule');
    const hol = nextObj.years[targetYear];
    const matches = Array.isArray(hol) && JSON.stringify([...hol].sort()) === JSON.stringify(calendarHolidays(rows));
    if (!missing.length && (!stale || manual)) {
      if (!matches) throw new Error(`休市配置与SSE日历${targetYear}年不一致，保留人工维护差异`);
      continue;
    }
    if (manual) throw new Error(`${targetYear}年人工日历覆盖不完整，请通过原维护入口重新保存`);
    // 有未补窗口时只取缺失范围；月度复核仍查询完整年度以发现官方更正。
    const requestedDates = stale || !missing.length ? expectedDates
      : expectedDates.filter(date => date >= missing[0] && date <= missing[missing.length - 1]);
    const data = await tushareQuery('trade_cal', { exchange: 'SSE',
      start_date: requestedDates[0].replace(/-/g, ''), end_date: requestedDates[requestedDates.length - 1].replace(/-/g, '') }, 'cal_date,is_open');
    const fetched = validateCalendarRows(data, requestedDates);
    const merged = new Map(rows.map(row => [row.trade_date, row]));
    fetched.forEach(row => merged.set(row.trade_date, row));
    const allRows = expectedDates.map(date => merged.get(date));
    const incomingHolidays = calendarHolidays(allRows);
    if (Array.isArray(hol) && JSON.stringify([...hol].sort()) !== JSON.stringify(incomingHolidays)) {
      throw new Error(`${targetYear}年官方日历与现有配置冲突，保留旧值并等待核对`);
    }
    await storeCalendar(client, fetched, 'tushare');
    nextObj.years[targetYear] = incomingHolidays;
  }
  const nextDay = await client.query("SELECT trade_date::text AS trade_date FROM market.trade_calendar WHERE exchange='SSE' AND is_open=true AND trade_date>$1::date ORDER BY trade_date LIMIT 1", [businessDate]);
  if (!nextDay.rows.length) throw new Error('共享SSE日历缺少下一交易日，不能确认同步完成');
  nextObj.updatedAt = businessDate;
  // 缓存命中不推进外部核对日期，避免每天检查把月度刷新永久短路。
  if (JSON.stringify(nextObj.years) !== JSON.stringify(obj.years) || stale) saveHolidays(nextObj);
  return { ok: true, status: 'succeeded', dataAsOf: `${years[years.length - 1]}-12-31`,
    datasetDiagnostics: { trade_calendar: { query_status: 'success', quality_status: 'passed',
      coverage_status: 'complete', exchange: 'SSE', next_trade_date: nextDay.rows[0].trade_date } } };
  });
}

module.exports = { ensureHolidaysCurrent, fetchTradeCal, saveManualHolidays, datesForYear, validateCalendarRows };

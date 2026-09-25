const { pool } = require('../db/connection');
const { isCnHoliday } = require('../config/holidays');

const CACHE_TTL_MS = 60 * 1000;
const HK_CLOSE_QUOTE_BUFFER_MINUTES = 20;
const FACT_CACHE = new Map();

function validDate(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function parseClock(value) {
  const match = String(value || '').match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour < 24 && minute < 60 ? hour * 60 + minute : null;
}

function isCnTradingDate(date) {
  if (!validDate(date)) return false;
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return weekday >= 1 && weekday <= 5 && !isCnHoliday(date);
}

function isPotentialHkTradingTime(date, time) {
  if (!validDate(date) || parseClock(time) == null) return false;
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (weekday < 1 || weekday > 5) return false;
  const minute = parseClock(time);
  return (minute >= 9 * 60 + 30 && minute < 12 * 60 + 10)
    || (minute >= 13 * 60 && minute < 16 * 60 + 10);
}

function normalizeRawPayload(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch (_) {}
  }
  return {};
}

function factCacheKey(market, date) {
  return `${String(market).toUpperCase()}|${date}`;
}

function normalizeHkCalendarRow(row) {
  const rawPayload = normalizeRawPayload(row.raw_payload);
  const official = rawPayload.official_schedule && typeof rawPayload.official_schedule === 'object'
    ? rawPayload.official_schedule : null;
  const tushare = rawPayload.tushare && typeof rawPayload.tushare === 'object'
    ? rawPayload.tushare : (!official ? rawPayload : null);
  const officialOpen = official && typeof official.is_open === 'boolean' ? official.is_open : null;
  const sourceOpen = row.is_open == null ? null : Boolean(row.is_open);
  const isOpen = officialOpen == null ? sourceOpen : officialOpen;
  const sourceOpenFromTushare = tushare && tushare.is_open != null
    ? (String(tushare.is_open) === '1' || tushare.is_open === true)
    : null;
  const conflict = officialOpen != null && sourceOpenFromTushare != null && officialOpen !== sourceOpenFromTushare;
  const sessionType = official && official.session_type
    ? String(official.session_type)
    : (isOpen == null ? null : (isOpen ? 'full_day' : 'closed'));
  const closeTime = official && official.close_time
    ? String(official.close_time)
    : (isOpen ? (sessionType === 'half_day' ? '12:10' : '16:10') : null);
  return {
    market: 'HK',
    businessDate: String(row.trade_date).slice(0, 10),
    status: isOpen == null ? 'unknown' : (isOpen ? 'open' : 'closed'),
    sessionType,
    closeTime,
    source: official ? (official.source || 'hkex_official_schedule') : (row.source_code || 'unknown'),
    evidence: official || rawPayload,
    qualityStatus: conflict ? 'conflict' : 'passed',
    conflict: conflict ? { officialIsOpen: officialOpen, tushareIsOpen: sourceOpenFromTushare } : null,
  };
}

function cnMarketFacts(date) {
  const isOpen = isCnTradingDate(date);
  return {
    market: 'CN',
    businessDate: date,
    status: isOpen ? 'open' : 'closed',
    sessionType: isOpen ? 'full_day' : 'closed',
    closeTime: isOpen ? '15:00' : null,
    source: 'cn_holiday_rules',
    evidence: { calendar: 'local_cn_holidays', date },
    qualityStatus: 'passed',
    conflict: null,
  };
}

async function prefetchMarketFacts(market, dates, query = pool.query.bind(pool)) {
  const normalizedMarket = String(market || '').toUpperCase();
  const uniqueDates = [...new Set((dates || []).filter(validDate))];
  if (normalizedMarket === 'CN' || uniqueDates.length === 0) return;
  if (normalizedMarket !== 'HK') throw new Error(`不支持的市场代码：${normalizedMarket}`);
  const missingDates = uniqueDates.filter(date => {
    const cached = FACT_CACHE.get(factCacheKey(normalizedMarket, date));
    return !cached || Date.now() - cached.cachedAt >= CACHE_TTL_MS;
  });
  if (!missingDates.length) return;
  const { rows } = await query(
    `SELECT trade_date::text AS trade_date, is_open, source_code, raw_payload
       FROM market.trade_calendar
      WHERE exchange='HKEX' AND trade_date=ANY($1::date[])`,
    [missingDates]
  );
  const rowsByDate = new Map(rows.map(row => [String(row.trade_date).slice(0, 10), row]));
  for (const date of missingDates) {
    const row = rowsByDate.get(date);
    const facts = row ? normalizeHkCalendarRow(row) : {
      market: 'HK', businessDate: date, status: 'unknown', sessionType: null,
      closeTime: null, source: 'calendar_missing', evidence: null,
      qualityStatus: 'unknown', conflict: null,
    };
    FACT_CACHE.set(factCacheKey(normalizedMarket, date), { facts, cachedAt: Date.now() });
  }
}

function minutesToClock(minutes) {
  if (minutes == null || minutes < 0 || minutes >= 24 * 60) return null;
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function deriveMarketState(facts, time) {
  const currentMinute = parseClock(time);
  if (currentMinute == null) throw new Error('市场状态时刻必须使用 HH:mm 格式');
  const open = facts.status === 'open';
  const closeMinute = parseClock(facts.closeTime);
  let inSession = false;
  if (open && facts.market === 'HK') {
    const morningClose = facts.sessionType === 'half_day' ? closeMinute : 12 * 60;
    inSession = (currentMinute >= 9 * 60 + 30 && morningClose != null && currentMinute < morningClose)
      || (currentMinute >= 13 * 60 && closeMinute != null && currentMinute < closeMinute);
  } else if (open && facts.market === 'CN') {
    inSession = (currentMinute >= 9 * 60 + 30 && currentMinute < 11 * 60 + 30)
      || (currentMinute >= 13 * 60 && closeMinute != null && currentMinute < closeMinute);
  }
  const afterClose = open && closeMinute != null && currentMinute >= closeMinute;
  const closeQuoteMinute = facts.market === 'HK' && closeMinute != null
    ? closeMinute + HK_CLOSE_QUOTE_BUFFER_MINUTES : null;
  return {
    ...facts,
    time,
    isOpen: facts.status === 'open' ? true : (facts.status === 'closed' ? false : null),
    isTradingNow: inSession,
    isAfterMarketClose: afterClose,
    closeQuoteTime: minutesToClock(closeQuoteMinute),
  };
}

async function getMarketState({ market, businessDate, time, query } = {}) {
  const normalizedMarket = String(market || '').toUpperCase();
  if (!['CN', 'HK'].includes(normalizedMarket)) throw new Error(`不支持的市场代码：${normalizedMarket || '(空)'}`);
  if (!validDate(businessDate)) throw new Error('市场状态业务日格式错误');
  if (parseClock(time) == null) throw new Error('市场状态时刻必须使用 HH:mm 格式');
  if (normalizedMarket === 'CN') return deriveMarketState(cnMarketFacts(businessDate), time);
  await prefetchMarketFacts(normalizedMarket, [businessDate], query || pool.query.bind(pool));
  const facts = FACT_CACHE.get(factCacheKey(normalizedMarket, businessDate)).facts;
  return deriveMarketState(facts, time);
}

function shanghaiDateTime(value = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(value);
  const values = Object.fromEntries(parts.map(item => [item.type, item.value]));
  return { businessDate: `${values.year}-${values.month}-${values.day}`, time: `${values.hour}:${values.minute}` };
}

async function getCurrentMarketStates(value = new Date()) {
  const { businessDate, time } = shanghaiDateTime(value);
  const [cn, hk] = await Promise.all([
    getMarketState({ market: 'CN', businessDate, time }),
    getMarketState({ market: 'HK', businessDate, time }),
  ]);
  return { businessDate, time, markets: { CN: cn, HK: hk } };
}

function invalidateMarketStateCache({ market, businessDate } = {}) {
  const normalizedMarket = market ? String(market).toUpperCase() : null;
  for (const key of FACT_CACHE.keys()) {
    const [cachedMarket, cachedDate] = key.split('|');
    if ((!normalizedMarket || normalizedMarket === cachedMarket) && (!businessDate || businessDate === cachedDate)) {
      FACT_CACHE.delete(key);
    }
  }
}

module.exports = {
  CACHE_TTL_MS,
  HK_CLOSE_QUOTE_BUFFER_MINUTES,
  validDate,
  parseClock,
  isCnTradingDate,
  isPotentialHkTradingTime,
  prefetchMarketFacts,
  getMarketState,
  getCurrentMarketStates,
  shanghaiDateTime,
  invalidateMarketStateCache,
  normalizeHkCalendarRow,
  deriveMarketState,
};

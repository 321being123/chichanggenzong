// ========== 港交所交易日历同步 ==========
// 港股日历与 SSE 日历分开保存；若上游权限/入口尚未确认，任务安全跳过并保留上一份数据。
const { pool } = require('../db');
const { tushareQuery } = require('../services/tushare');
const { scheduleForDate, supportedScheduleYears } = require('../config/hkexAnnualSchedules');
const { invalidateMarketStateCache } = require('../services/marketState');

function dateText(value) {
  const text = String(value || '').replace(/-/g, '').slice(0, 8);
  if (!/^\d{8}$/.test(text)) return null;
  const normalized = `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  const date = new Date(`${normalized}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== normalized ? null : normalized;
}

function todayShanghai() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
}

function addDays(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function rowsFromPayload(data) {
  if (!data || !Array.isArray(data.items)) return [];
  const fields = data.fields || [];
  return data.items.map(item => Object.fromEntries(fields.map((field, index) => [field, item[index]])));
}

function normalizeCalendarRows(rows) {
  return (rows || []).map(row => ({
    tradeDate: dateText(row.trade_date || row.cal_date || row.date),
    preTradeDate: dateText(row.pretrade_date),
    isOpen: (() => {
      const value = row.is_open == null ? row.open : row.is_open;
      if (value === true || value === 1 || String(value) === '1') return true;
      if (value === false || value === 0 || String(value) === '0') return false;
      return null;
    })(),
    rawPayload: row,
  })).filter(row => row.tradeDate && row.isOpen != null);
}

async function fetchConfiguredHkCalendar(fromDate, toDate) {
  const apiName = String(process.env.TUSHARE_HK_TRADE_CAL_API || 'hk_tradecal').trim();
  const params = {
    start_date: String(fromDate).replace(/-/g, ''),
    end_date: String(toDate).replace(/-/g, ''),
  };
  if (apiName !== 'hk_tradecal') params.exchange = process.env.TUSHARE_HK_TRADE_CAL_EXCHANGE || 'HKEX';
  const fields = apiName === 'hk_tradecal' ? 'cal_date,is_open,pretrade_date' : 'cal_date,trade_date,is_open,pretrade_date';
  const data = await tushareQuery(apiName, params, fields);
  return normalizeCalendarRows(rowsFromPayload(data));
}

function validateManualCorrection(input = {}) {
  const date = String(input.date || '').trim();
  const status = String(input.status || '').trim().toLowerCase();
  const sessionType = String(input.sessionType || '').trim().toLowerCase();
  const closeTime = input.closeTime == null ? null : String(input.closeTime).trim();
  const evidenceUrl = String(input.evidenceUrl || '').trim();
  const reason = String(input.reason || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !dateText(date)) throw new Error('人工修正日期无效');
  if (!['open', 'closed'].includes(status)) throw new Error('人工修正状态必须是 open 或 closed');
  if (status === 'closed' && (sessionType && sessionType !== 'closed' || closeTime)) throw new Error('休市修正不能包含交易时段或收市时间');
  if (status === 'open' && !['full_day', 'half_day'].includes(sessionType)) throw new Error('开市修正必须指定 full_day 或 half_day');
  if (status === 'open' && !/^\d{2}:\d{2}$/.test(closeTime || '')) throw new Error('开市修正必须提供收市时间');
  if (status === 'open' && sessionType === 'half_day' && closeTime > '12:10') throw new Error('半日市收市时间不能晚于 12:10');
  let parsedUrl;
  try { parsedUrl = new URL(evidenceUrl); } catch (_) { throw new Error('必须提供港交所公告链接'); }
  if (parsedUrl.protocol !== 'https:' || !/(^|\.)hkex\.com\.hk$/i.test(parsedUrl.hostname)) throw new Error('公告链接必须来自港交所官网');
  if (reason.length < 8) throw new Error('人工修正原因至少填写 8 个字');
  return { date, isOpen: status === 'open', sessionType: status === 'open' ? sessionType : 'closed', closeTime: status === 'open' ? closeTime : null, evidenceUrl, reason };
}

function everyDate(fromDate, toDate) {
  const dates = [];
  for (let cursor = fromDate; cursor <= toDate; cursor = addDays(cursor, 1)) dates.push(cursor);
  return dates;
}

function officialRowsForSupportedYears() {
  const rows = [];
  for (const year of supportedScheduleYears()) {
    for (const tradeDate of everyDate(`${year}-01-01`, `${year}-12-31`)) {
      const schedule = scheduleForDate(tradeDate);
      if (schedule) rows.push({ tradeDate, schedule });
    }
  }
  return rows;
}

async function resolveSyncRange({ fromDate, toDate, today }) {
  if (fromDate || toDate) {
    const start = fromDate || toDate;
    const end = toDate || fromDate;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) {
      throw new Error('港股交易日历同步日期范围无效');
    }
    return { fromDate: start, toDate: end };
  }
  const year = Number(today.slice(0, 4));
  const requestedEnd = supportedScheduleYears().includes(year) ? `${year}-12-31` : addDays(today, 90);
  const { rows } = await pool.query(
    `SELECT MIN(trade_date)::text AS first_date, MAX(trade_date)::text AS last_date
       FROM market.trade_calendar WHERE exchange='HKEX' AND trade_date BETWEEN $1::date AND $2::date`,
    [`${year}-01-01`, requestedEnd]
  );
  const first = rows[0] && rows[0].first_date;
  const last = rows[0] && rows[0].last_date;
  const missing = await pool.query(
    `SELECT d::date::text AS missing_date
       FROM generate_series($1::date,$2::date,'1 day'::interval) d
       LEFT JOIN market.trade_calendar tc ON tc.exchange='HKEX' AND tc.trade_date=d::date
      WHERE tc.trade_date IS NULL ORDER BY d LIMIT 1`,
    [`${year}-01-01`, requestedEnd]
  );
  const firstMissing = missing.rows[0] && missing.rows[0].missing_date;
  if (!first || !last || firstMissing) {
    return { fromDate: firstMissing || `${year}-01-01`, toDate: requestedEnd };
  }
  const missingPretrade = await pool.query(
    `SELECT MIN(trade_date)::text AS missing_date
       FROM market.trade_calendar
      WHERE exchange='HKEX' AND trade_date BETWEEN $1::date AND $2::date
        AND NULLIF(COALESCE(raw_payload#>>'{tushare,pretrade_date}',raw_payload->>'pretrade_date'),'') IS NULL`,
    [`${year}-01-01`, requestedEnd]
  );
  if (missingPretrade.rows[0] && missingPretrade.rows[0].missing_date) {
    return { fromDate: String(missingPretrade.rows[0].missing_date).slice(0, 10), toDate: requestedEnd };
  }
  const overlapStart = addDays(today, -5);
  return { fromDate: overlapStart < `${year}-01-01` ? `${year}-01-01` : overlapStart, toDate: today };
}

function previousTusharePayload(payload) {
  if (payload && payload.tushare && typeof payload.tushare === 'object') return payload.tushare;
  if (payload && payload.official_schedule) return null;
  return payload && typeof payload === 'object' ? payload : null;
}

async function upsertCalendarFacts({ tushareRows, officialRows }) {
  const allDates = [...new Set([
    ...(tushareRows || []).map(row => row.tradeDate),
    ...(officialRows || []).map(row => row.tradeDate),
  ])].sort();
  if (!allDates.length) return { rows: 0, conflicts: [] };
  const { rows: existingRows } = await pool.query(
    `SELECT trade_date::text AS trade_date, is_open, source_code, raw_payload
       FROM market.trade_calendar WHERE exchange='HKEX' AND trade_date=ANY($1::date[])`,
    [allDates]
  );
  const existingByDate = new Map(existingRows.map(row => [String(row.trade_date).slice(0, 10), row]));
  const tushareByDate = new Map((tushareRows || []).map(row => [row.tradeDate, row]));
  const officialByDate = new Map((officialRows || []).map(row => [row.tradeDate, row.schedule]));
  const conflicts = [];
  let written = 0;
  for (const tradeDate of allDates) {
    const existing = existingByDate.get(tradeDate);
    const previousPayload = existing && existing.raw_payload && typeof existing.raw_payload === 'object'
      ? existing.raw_payload : {};
    const incomingTushare = tushareByDate.get(tradeDate);
    const tushare = incomingTushare ? incomingTushare.rawPayload : previousTusharePayload(previousPayload);
    const existingOfficial = previousPayload.official_schedule && typeof previousPayload.official_schedule === 'object'
      ? previousPayload.official_schedule : null;
    const configuredOfficial = officialByDate.get(tradeDate);
    const incomingCorrection = configuredOfficial && configuredOfficial.evidence.source === 'hkex_admin_correction';
    const official = incomingCorrection ? configuredOfficial : (existingOfficial && existingOfficial.source === 'hkex_admin_correction'
      ? { ...configuredOfficial, isOpen: existingOfficial.is_open, sessionType: existingOfficial.session_type,
        closeTime: existingOfficial.close_time || null, holidayName: existingOfficial.holiday_name || null,
        evidence: { ...existingOfficial, source: 'hkex_admin_correction' } }
      : configuredOfficial);
    const tushareIsOpen = tushare && tushare.is_open != null
      ? (String(tushare.is_open) === '1' || tushare.is_open === true) : null;
    const officialConflict = official && tushareIsOpen != null && tushareIsOpen !== official.isOpen;
    const conflict = officialConflict ? { date: tradeDate, officialIsOpen: official.isOpen, tushareIsOpen } : null;
    if (conflict) conflicts.push(conflict);
    const rawPayload = {
      ...previousPayload,
      ...(tushare ? { tushare } : {}),
      ...(official ? { official_schedule: {
        is_open: official.isOpen,
        session_type: official.sessionType,
        close_time: official.closeTime,
        holiday_name: official.holidayName,
        source: official.evidence.source || 'hkex_official_schedule',
        source_url: official.evidence.source_url,
        notice_title: official.evidence.title,
        notice_year: official.evidence.year,
        verified_at: official.evidence.verified_at,
        ...(official.evidence.reason ? { reason: official.evidence.reason } : {}),
        ...(official.evidence.corrected_by ? { corrected_by: official.evidence.corrected_by } : {}),
        ...(official.evidence.corrected_at ? { corrected_at: official.evidence.corrected_at } : {}),
        ...(conflict ? { quality_status: 'conflict', source_conflict: conflict } : { quality_status: 'passed' }),
      } } : previousPayload.official_schedule ? { official_schedule: previousPayload.official_schedule } : {}),
    };
    const effectiveOpen = official ? official.isOpen : incomingTushare ? incomingTushare.isOpen : existing && existing.is_open;
    const sourceCode = official ? (official.evidence.source || 'hkex_official_schedule') : (incomingTushare ? 'tushare_hk_tradecal' : existing && existing.source_code || 'tushare_hk_tradecal');
    const unchanged = existing
      && Boolean(existing.is_open) === Boolean(effectiveOpen)
      && existing.source_code === sourceCode
      && JSON.stringify(existing.raw_payload || {}) === JSON.stringify(rawPayload);
    if (unchanged) continue;
    await pool.query(
      `INSERT INTO market.trade_calendar(exchange,trade_date,is_open,source_code,raw_payload,ingested_at)
       VALUES('HKEX',$1::date,$2,$3,$4::jsonb,now())
       ON CONFLICT(exchange,trade_date) DO UPDATE SET is_open=EXCLUDED.is_open,
         source_code=EXCLUDED.source_code,raw_payload=EXCLUDED.raw_payload,ingested_at=now()`,
      [tradeDate, effectiveOpen, sourceCode, JSON.stringify(rawPayload)]
    );
    written++;
  }
  invalidateMarketStateCache({ market: 'HK' });
  return { rows: written, conflicts };
}

async function syncHkTradeCalendar({ fromDate, toDate, fetchImpl, manualCorrection } = {}) {
  const today = todayShanghai();
  if (manualCorrection) {
    const correction = validateManualCorrection(manualCorrection);
    const year = Number(correction.date.slice(0, 4));
    const correctionRow = {
      tradeDate: correction.date,
      schedule: {
        isOpen: correction.isOpen,
        sessionType: correction.sessionType,
        closeTime: correction.closeTime,
        holidayName: correction.reason,
        evidence: {
          source: 'hkex_admin_correction',
          source_url: correction.evidenceUrl,
          title: '港交所临时交易安排人工核验修正',
          year,
          verified_at: today,
          corrected_by: String(manualCorrection.correctedBy || 'admin'),
          corrected_at: new Date().toISOString(),
          reason: correction.reason,
        },
      },
    };
    const stored = await upsertCalendarFacts({ officialRows: [...officialRowsForSupportedYears(), correctionRow] });
    return {
      ok: true,
      status: 'succeeded',
      rows: stored.rows,
      correctedDate: correction.date,
      sourceConflicts: stored.conflicts,
      verifiedBy: correctionRow.schedule.evidence.corrected_by,
      dataAsOf: correction.date,
      partitionKey: correction.date,
      watermarkNotRequired: true,
    };
  }
  const range = await resolveSyncRange({ fromDate, toDate, today });
  let rows = [];
  let sourceError = null;
  try {
    rows = fetchImpl ? normalizeCalendarRows(await fetchImpl(range.fromDate, range.toDate))
      : await fetchConfiguredHkCalendar(range.fromDate, range.toDate);
  } catch (error) {
    sourceError = error;
  }
  const stored = await upsertCalendarFacts({ tushareRows: rows, officialRows: officialRowsForSupportedYears() });
  if (sourceError) return { ok: false, rows: stored.rows, sourceError: sourceError.message, conflicts: stored.conflicts };
  if (!rows.length) return { ok: false, rows: stored.rows, reason: 'HKEX 日历返回空结果，未覆盖旧数据', conflicts: stored.conflicts };
  const expectedDates = everyDate(range.fromDate, range.toDate);
  const sourceDates = new Set(rows.map(row => row.tradeDate));
  const missingSourceDates = expectedDates.filter(date => !sourceDates.has(date));
  const conflicts = stored.conflicts.filter(item => item.date >= range.fromDate && item.date <= range.toDate);
  const ok = missingSourceDates.length === 0 && conflicts.length === 0;
  return {
    ok,
    rows: stored.rows,
    sourceRows: rows.length,
    dataAsOf: rows.map(row => row.tradeDate).sort().at(-1),
    range,
    expectedDays: expectedDates.length,
    missingSourceDates,
    conflicts,
    ...(ok ? {} : { errorType: 'data_quality', failedDatasets: ['hk_trade_calendar'] }),
  };
}

module.exports = { syncHkTradeCalendar, normalizeCalendarRows, dateText, todayShanghai, addDays, everyDate, officialRowsForSupportedYears, resolveSyncRange, upsertCalendarFacts, validateManualCorrection };

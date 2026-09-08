// ========== 港交所交易日历同步 ==========
// 港股日历与 SSE 日历分开保存；若上游权限/入口尚未确认，任务安全跳过并保留上一份数据。
const { pool } = require('../db');
const { tushareQuery } = require('../services/tushare');

function dateText(value) {
  const text = String(value || '').replace(/-/g, '').slice(0, 8);
  return /^\d{8}$/.test(text) ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}` : null;
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
    isOpen: String(row.is_open == null ? row.open : row.is_open) === '1' || row.is_open === true || row.open === true,
    rawPayload: row,
  })).filter(row => row.tradeDate);
}

async function fetchConfiguredHkCalendar(fromDate, toDate) {
  const apiName = String(process.env.TUSHARE_HK_TRADE_CAL_API || 'hk_tradecal').trim();
  const params = {
    start_date: String(fromDate).replace(/-/g, ''),
    end_date: String(toDate).replace(/-/g, ''),
  };
  if (apiName !== 'hk_tradecal') params.exchange = process.env.TUSHARE_HK_TRADE_CAL_EXCHANGE || 'HKEX';
  const data = await tushareQuery(apiName, params, 'cal_date,trade_date,is_open');
  return normalizeCalendarRows(rowsFromPayload(data));
}

async function syncHkTradeCalendar({ fromDate, toDate, fetchImpl } = {}) {
  const today = todayShanghai();
  const start = fromDate || `${today.slice(0, 4)}-01-01`;
  const end = toDate || addDays(today, 90);
  const rows = fetchImpl ? normalizeCalendarRows(await fetchImpl(start, end)) : await fetchConfiguredHkCalendar(start, end);
  if (!rows) return { ok: true, skipped: true, reason: 'HKEX 日历入口尚未配置，等待 P0 探针确认' };
  if (!rows.length) return { ok: false, reason: 'HKEX 日历返回空结果，未覆盖旧数据' };
  for (const row of rows) {
    await pool.query(`INSERT INTO market.trade_calendar(exchange,trade_date,is_open,source_code,raw_payload,ingested_at)
      VALUES('HKEX',$1::date,$2,'tushare_hk_tradecal',$3::jsonb,now())
      ON CONFLICT(exchange,trade_date) DO UPDATE SET is_open=EXCLUDED.is_open,source_code=EXCLUDED.source_code,
        raw_payload=EXCLUDED.raw_payload,ingested_at=now()`, [row.tradeDate, row.isOpen, JSON.stringify(row.rawPayload || {})]);
  }
  return { ok: true, rows: rows.length, dataAsOf: rows.map(row => row.tradeDate).sort().at(-1) };
}

module.exports = { syncHkTradeCalendar, normalizeCalendarRows, dateText, todayShanghai, addDays };

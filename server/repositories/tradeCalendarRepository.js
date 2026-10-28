const { pool } = require('../db/connection');

// 交易日历事实读写：负责 SSE 官方日历落库、范围读取、下一交易日查询与同步会话锁。

async function upsertCalendarRows(rows, source, client = pool) {
  await client.query(`INSERT INTO market.trade_calendar(exchange,trade_date,is_open,source_code,raw_payload)
    SELECT x.exchange,x.trade_date,x.is_open,$2,x.raw_payload FROM jsonb_to_recordset($1::jsonb)
      AS x(exchange text,trade_date date,is_open boolean,raw_payload jsonb)
    ON CONFLICT(exchange,trade_date) DO UPDATE SET is_open=EXCLUDED.is_open,
      source_code=EXCLUDED.source_code,raw_payload=EXCLUDED.raw_payload,ingested_at=now()`,
  [JSON.stringify(rows), source]);
}

async function loadCalendarRange(startDate, endDate, client = pool) {
  const { rows } = await client.query(`SELECT trade_date::text AS trade_date,is_open,source_code,raw_payload
      FROM market.trade_calendar WHERE exchange='SSE' AND trade_date BETWEEN $1::date AND $2::date ORDER BY trade_date`,
  [startDate, endDate]);
  return rows;
}

async function findNextTradingDate(businessDate, client = pool) {
  const { rows } = await client.query("SELECT trade_date::text AS trade_date FROM market.trade_calendar WHERE exchange='SSE' AND is_open=true AND trade_date>$1::date ORDER BY trade_date LIMIT 1", [businessDate]);
  return rows[0] ? rows[0].trade_date : null;
}

// 某交易所日历在给定区间的首末覆盖日期
async function loadCalendarBounds(exchange, startDate, endDate, client = pool) {
  const { rows } = await client.query(
    `SELECT MIN(trade_date)::text AS first_date, MAX(trade_date)::text AS last_date
       FROM market.trade_calendar WHERE exchange=$3 AND trade_date BETWEEN $1::date AND $2::date`,
    [startDate, endDate, exchange],
  );
  return rows[0] || null;
}

// 区间内第一个尚无日历记录的日期
async function findFirstMissingDate(exchange, startDate, endDate, client = pool) {
  const { rows } = await client.query(
    `SELECT d::date::text AS missing_date
       FROM generate_series($1::date,$2::date,'1 day'::interval) d
       LEFT JOIN market.trade_calendar tc ON tc.exchange=$3 AND tc.trade_date=d::date
      WHERE tc.trade_date IS NULL ORDER BY d LIMIT 1`,
    [startDate, endDate, exchange],
  );
  return rows[0] ? rows[0].missing_date : null;
}

// 区间内第一个缺少上一交易日字段的日历记录日期
async function findFirstMissingPretradeDate(exchange, startDate, endDate, client = pool) {
  const { rows } = await client.query(
    `SELECT MIN(trade_date)::text AS missing_date
       FROM market.trade_calendar
      WHERE exchange=$3 AND trade_date BETWEEN $1::date AND $2::date
        AND NULLIF(COALESCE(raw_payload#>>'{tushare,pretrade_date}',raw_payload->>'pretrade_date'),'') IS NULL`,
    [startDate, endDate, exchange],
  );
  return rows[0] ? rows[0].missing_date : null;
}

async function loadCalendarRowsByDates(exchange, dates, client = pool) {
  const { rows } = await client.query(
    `SELECT trade_date::text AS trade_date, is_open, source_code, raw_payload
       FROM market.trade_calendar WHERE exchange=$2 AND trade_date=ANY($1::date[])`,
    [dates, exchange],
  );
  return rows;
}

async function upsertCalendarRow(exchange, row, client = pool) {
  await client.query(
    `INSERT INTO market.trade_calendar(exchange,trade_date,is_open,source_code,raw_payload,ingested_at)
       VALUES($5,$1::date,$2,$3,$4::jsonb,now())
       ON CONFLICT(exchange,trade_date) DO UPDATE SET is_open=EXCLUDED.is_open,
         source_code=EXCLUDED.source_code,raw_payload=EXCLUDED.raw_payload,ingested_at=now()`,
    [row.tradeDate, row.isOpen, row.sourceCode, JSON.stringify(row.rawPayload), exchange],
  );
}

// 会话级 advisory lock：跨网络请求持有同一连接，锁与连接归属都在本层。
async function withAdvisoryLock(lockName, work) {
  const client = await pool.connect();
  let locked = false;
  try {
    locked = (await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [lockName])).rows[0].locked;
    if (!locked) return { ok: false, skipped: true, reason: 'already_running' };
    return await work(client);
  } finally {
    try { if (locked) await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockName]); }
    finally { client.release(); }
  }
}

module.exports = {
  findFirstMissingDate,
  findFirstMissingPretradeDate,
  findNextTradingDate,
  loadCalendarBounds,
  loadCalendarRange,
  loadCalendarRowsByDates,
  upsertCalendarRow,
  upsertCalendarRows,
  withAdvisoryLock,
};

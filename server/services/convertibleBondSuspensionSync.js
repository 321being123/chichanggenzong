const { pool } = require('../db/connection');
const { tushareQuery, tsRows } = require('./market');

function compactDate(value) {
  const text = String(value || '').replace(/-/g, '').slice(0, 8);
  return /^\d{8}$/.test(text) ? text : null;
}

function isoDate(value) {
  const text = compactDate(value);
  return text ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}` : null;
}

/**
 * 增量同步强赎计算所需的正股停牌日。只保存可转债对应正股，避免每次计算重新访问接口。
 */
async function syncConvertibleBondSuspensions({ startDate, endDate } = {}) {
  const from = compactDate(startDate) || compactDate(endDate);
  const to = compactDate(endDate) || from;
  if (!from || !to || from > to) return { ok: false, status: 'invalid_range', count: 0 };

  const [{ rows: stocks }, sourceResult, data] = await Promise.all([
    pool.query(`
      SELECT DISTINCT s.instrument_id, s.canonical_code
        FROM fundamental.convertible_bond_profiles p
        LEFT JOIN fundamental.convertible_bond_issuance iss ON iss.instrument_id=p.instrument_id
        JOIN core.instruments s ON s.instrument_id=p.stock_instrument_id
       WHERE p.stock_instrument_id IS NOT NULL
         AND (iss.issue_type IS NULL OR iss.issue_type NOT IN ('定向','私募'))`),
    pool.query(`SELECT source_id FROM ops.data_sources WHERE source_code='tushare' LIMIT 1`),
    tushareQuery('suspend_d', { start_date: from, end_date: to },
      'ts_code,trade_date,suspend_type,suspend_reason', { allowEmpty: true }),
  ]);
  const sourceId = sourceResult.rows[0] && sourceResult.rows[0].source_id;
  if (!sourceId) return { ok: false, status: 'source_missing', count: 0 };
  const instrumentMap = new Map(stocks.map(row => [row.canonical_code, row.instrument_id]));
  const rows = tsRows(data).map(row => ({
    instrument_id: instrumentMap.get(row.ts_code),
    trade_date: isoDate(row.trade_date),
    suspend_type: String(row.suspend_type || 'S'),
    suspend_reason: row.suspend_reason || null,
    raw_payload: row,
  })).filter(row => row.instrument_id && row.trade_date);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`
      INSERT INTO market.stock_suspend_calendar
        (instrument_id,trade_date,suspend_type,suspend_reason,source_id,raw_payload)
      SELECT x.instrument_id,x.trade_date,x.suspend_type,x.suspend_reason,$2,x.raw_payload
        FROM jsonb_to_recordset($1::jsonb) AS x(
          instrument_id bigint,trade_date date,suspend_type text,suspend_reason text,raw_payload jsonb)
      ON CONFLICT (instrument_id,trade_date,source_id) DO UPDATE SET
        suspend_type=EXCLUDED.suspend_type,
        suspend_reason=EXCLUDED.suspend_reason,
        raw_payload=EXCLUDED.raw_payload,
        ingested_at=now()`, [JSON.stringify(rows), sourceId]);
    await client.query('COMMIT');
    return { ok: true, status: 'succeeded', from: isoDate(from), to: isoDate(to), count: result.rowCount };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { syncConvertibleBondSuspensions };

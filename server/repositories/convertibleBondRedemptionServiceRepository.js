const { pool } = require('../db/connection');

// 自 server/services/convertibleBondRedemptionService.js 迁入的数据读写函数（只做标准事实读写，业务判定仍留在服务层）。

async function getLatestCallState(instrumentId) {
  const { rows } = await pool.query(
    `SELECT * FROM analytics.convertible_bond_call_latest WHERE instrument_id=$1 LIMIT 1`, [instrumentId]
  );
  return rows[0] || null;
}

async function getLatestCallStateBySecurityCodes(codes) {
  const normalized = [...new Set((codes || []).map(value => String(value || '').trim().toUpperCase().replace(/\.(SH|SZ|BJ|HK)$/, '')).filter(Boolean))];
  if (!normalized.length) return new Map();
  const { rows } = await pool.query(
    `SELECT * FROM analytics.convertible_bond_call_latest
      WHERE security_code=ANY($1::text[])`, [normalized]
  );
  return new Map(rows.map(row => [String(row.security_code || '').toUpperCase(), row]));
}

async function getLatestCallStateMap(instrumentIds) {
  const ids = [...new Set((instrumentIds || []).map(Number).filter(Number.isInteger))];
  if (!ids.length) return new Map();
  const { rows } = await pool.query(
    `SELECT * FROM analytics.convertible_bond_call_latest WHERE instrument_id=ANY($1::bigint[])`, [ids]
  );
  return new Map(rows.map(row => [Number(row.instrument_id), row]));
}

async function select_market_trade_calendar(params, client = pool) {
  return client.query(`SELECT trade_date::text
       FROM market.trade_calendar
      WHERE exchange='SSE' AND is_open AND trade_date <= $1::date
      ORDER BY trade_date DESC LIMIT $2`, params);
}

async function select_market_convertible_bond_daily_metrics(params, client = pool) {
  return client.query(`SELECT MAX(trade_date)::text AS trade_date
       FROM market.convertible_bond_daily_metrics`);
}

async function select_core_instruments(params, client = pool) {
  return client.query(`SELECT i.instrument_id,i.canonical_code,p.stock_instrument_id,p.current_conv_price,
            p.remain_size,p.maturity_date,p.conv_start_date,p.conv_end_date,p.conv_stop_date,
            term.trigger_ratio,term.observation_days,term.required_days,term.term_id,
            latest_event.event_type AS latest_event_type,latest_event.no_call_until,
            latest_event.decision_date,latest_event.lock_start_date,latest_event.validity_basis,
            latest_event.parse_status AS announcement_parse_status,latest_event.details AS event_details
       FROM core.instruments i
       JOIN fundamental.convertible_bond_profiles p ON p.instrument_id=i.instrument_id
       JOIN public.bond_unified u ON u.instrument_id=i.instrument_id
       JOIN market.convertible_bond_daily_metrics dm
         ON dm.instrument_id=i.instrument_id AND dm.trade_date=$1::date
       LEFT JOIN LATERAL (
         SELECT term_id,trigger_ratio,observation_days,required_days
           FROM fundamental.convertible_bond_terms
          WHERE instrument_id=i.instrument_id AND term_type='call'
            AND effective_from <= $1::date
            AND (effective_to IS NULL OR effective_to > $1::date)
          ORDER BY effective_from DESC,term_id DESC LIMIT 1
       ) term ON true
       LEFT JOIN LATERAL (
         SELECT event_type,no_call_until,decision_date,lock_start_date,validity_basis,parse_status,details
           FROM event.convertible_bond_call_events
          WHERE instrument_id=i.instrument_id
            AND event_type IN ('waive','exercise','implementation','completion')
            AND announced_at <= $1::date
          ORDER BY announced_at DESC,event_id DESC LIMIT 1
       ) latest_event ON true
      WHERE i.asset_class='convertible_bond'
        AND i.status='listed'
        AND u.status='listed'
        AND (u.issue_type IS NULL OR u.issue_type NOT IN ('定向','私募'))
        AND (i.list_date IS NULL OR i.list_date <= $1::date)
        AND (i.delist_date IS NULL OR i.delist_date > $1::date)
        AND (u.maturity_date IS NULL OR u.maturity_date >= $1::date)
        AND (u.conv_end_date IS NULL OR u.conv_end_date >= $1::date)
        AND (u.conv_stop_date IS NULL OR u.conv_stop_date > $1::date)`, params);
}

async function select_market_daily_bars(params, client = pool) {
  return client.query(`SELECT instrument_id,trade_date::text,close
         FROM (
           SELECT instrument_id,trade_date,close,
                  ROW_NUMBER() OVER (PARTITION BY instrument_id ORDER BY trade_date DESC) AS rn
             FROM (
               SELECT instrument_id,trade_date,close,
                      ROW_NUMBER() OVER (PARTITION BY instrument_id,trade_date ORDER BY source_id DESC) AS source_rn
                 FROM market.daily_bars
                WHERE instrument_id=ANY($1::bigint[])
                  AND trade_date <= $2::date
                  AND trade_date >= ($2::date - INTERVAL '365 days')
                  AND close > 0
             ) daily
            WHERE source_rn=1
         ) x
        WHERE rn <= 180
        ORDER BY instrument_id,trade_date DESC`, params);
}

async function select_fundamental_convertible_bond_price_changes(params, client = pool) {
  return client.query(`SELECT instrument_id,change_date::text,price_before,price_after
         FROM fundamental.convertible_bond_price_changes
        WHERE instrument_id=ANY($1::bigint[]) AND change_date <= $2::date
        ORDER BY instrument_id,change_date DESC`, params);
}

async function select_market_stock_suspend_calendar(params, client = pool) {
  return client.query(`SELECT instrument_id,trade_date::text,suspend_type
       FROM market.stock_suspend_calendar
      WHERE instrument_id=ANY($1::bigint[])
        AND trade_date=ANY($2::date[])
        AND suspend_type='S'`, params);
}

async function insert_analytics_convertible_bond_trigger_daily(params, client = pool) {
  return client.query(`INSERT INTO analytics.convertible_bond_trigger_daily
           (instrument_id,trade_date,trigger_type,trigger_price,close_price,matched_days,required_days,observation_days,status,formula_version,diagnostics,data_status)
         VALUES($1,$2,'call',$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)
         ON CONFLICT(instrument_id,trade_date,trigger_type,formula_version) DO UPDATE SET
           trigger_price=EXCLUDED.trigger_price,close_price=EXCLUDED.close_price,
           matched_days=EXCLUDED.matched_days,required_days=EXCLUDED.required_days,
           observation_days=EXCLUDED.observation_days,status=EXCLUDED.status,
           diagnostics=EXCLUDED.diagnostics,data_status=EXCLUDED.data_status,calculated_at=now()`, params);
}

async function select_market_convertible_bond_daily_metrics_1(params, client = pool) {
  return client.query(`SELECT MAX(trade_date)::text AS trade_date FROM market.convertible_bond_daily_metrics`);
}

async function select_analytics_convertible_bond_trigger_daily(params, client = pool) {
  return client.query(`SELECT MAX(trade_date)::text AS trade_date
                  FROM analytics.convertible_bond_trigger_daily
                 WHERE trigger_type='call' AND formula_version=$1`, params);
}

async function select_market_trade_calendar_1(params, client = pool) {
  return client.query(`SELECT MAX(trade_date)::text AS trade_date
                  FROM market.trade_calendar
                 WHERE exchange='SSE' AND is_open
                   AND trade_date < (now() AT TIME ZONE 'Asia/Shanghai')::date`);
}

module.exports = {
  getLatestCallState,
  getLatestCallStateBySecurityCodes,
  getLatestCallStateMap,
  select_market_trade_calendar,
  select_market_convertible_bond_daily_metrics,
  select_core_instruments,
  select_market_daily_bars,
  select_fundamental_convertible_bond_price_changes,
  select_market_stock_suspend_calendar,
  insert_analytics_convertible_bond_trigger_daily,
  select_market_convertible_bond_daily_metrics_1,
  select_analytics_convertible_bond_trigger_daily,
  select_market_trade_calendar_1,
};

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

// 强赎概览的筛选条件：在市口径 + 可选状态/关键字/交易日，占位符在本层拼装
function buildCallWhere({ status, query, date }) {
  const marketAsOf = `(SELECT COALESCE(MAX(trade_date), CURRENT_DATE) FROM market.convertible_bond_daily_metrics)`;
  const clauses = [
    `u.status='listed'`,
    `(u.issue_type IS NULL OR u.issue_type NOT IN ('定向','私募'))`,
    `(u.delist_date IS NULL OR u.delist_date > ${marketAsOf})`,
    `(u.maturity_date IS NULL OR u.maturity_date >= ${marketAsOf})`,
    `(u.conv_end_date IS NULL OR u.conv_end_date >= ${marketAsOf})`,
    `(u.conv_stop_date IS NULL OR u.conv_stop_date > ${marketAsOf})`,
  ];
  const values = [];
  if (status) { values.push(status); clauses.push(`c.business_status=$${values.length}`); }
  if (query) {
    values.push(`%${query}%`);
    const p = `$${values.length}`;
    clauses.push(`(c.security_code ILIKE ${p} OR c.ts_code ILIKE ${p} OR c.bond_name ILIKE ${p} OR c.stock_code ILIKE ${p} OR c.stock_name ILIKE ${p})`);
  }
  if (date) { values.push(date); clauses.push(`c.trade_date=$${values.length}::date`); }
  return { clauses, values };
}

function buildCallBase(filter) {
  return `
    FROM analytics.convertible_bond_call_latest c
    JOIN public.bond_unified u ON u.instrument_id=c.instrument_id
    JOIN LATERAL (
      SELECT close,conversion_value,conversion_premium_pct,trade_date AS market_trade_date
       FROM market.convertible_bond_daily_metrics m
       WHERE m.instrument_id=c.instrument_id
         AND m.trade_date=(SELECT MAX(trade_date) FROM market.convertible_bond_daily_metrics)
       ORDER BY m.trade_date DESC LIMIT 1
    ) m ON true
   WHERE ${filter.clauses.join(' AND ')}`;
}

// 强赎概览主列表：按业务状态优先级与剩余天数排序
async function listCallOverviewRows(params, client = pool) {
  const filter = buildCallWhere(params.filter || {});
  const base = buildCallBase(filter);
  return client.query(
    `SELECT c.instrument_id,c.ts_code,c.security_code,c.bond_name,c.stock_code,c.stock_name,
              m.close AS bond_close,m.market_trade_date,c.stock_close,c.current_conv_price,c.trigger_ratio,c.trigger_price,
              c.distance_to_trigger_pct,c.trade_date,c.matched_days,c.required_days,c.observation_days,
              c.remaining_days,c.calculated_status,c.official_status,c.business_status,c.data_status,c.diagnostics,
              c.announced_at,c.decision_date,c.lock_start_date,c.no_call_until,c.validity_basis,
              c.next_count_start_date,c.calendar_status,c.data_quality_reason,c.redemption_record_date,c.last_trade_date,
              c.last_conversion_date,c.redemption_price,c.source_url,c.announcement_title,
              c.announcement_parse_status,c.remain_size,c.maturity_date,c.conv_start_date,c.conv_end_date,
              c.calculated_at
         ${base}
        ORDER BY CASE c.business_status WHEN 'announced' THEN 1 WHEN 'maturity_redeem' THEN 2 WHEN 'maturity_near' THEN 3
                                       WHEN 'redemption_unconfirmed' THEN 4 WHEN 'met_pending' THEN 5
                                       WHEN 'near' THEN 6 WHEN 'tracking' THEN 7 WHEN 'waived' THEN 8 WHEN 'not_active' THEN 9 ELSE 10 END,
                 COALESCE(c.remaining_days,9999),c.security_code
        LIMIT $${filter.values.length + 1}`,
    [...filter.values, params.safeLimit],
  );
}

// 强赎概览状态汇总
async function listCallOverviewSummary(params, client = pool) {
  const filter = buildCallWhere(params.filter || {});
  const base = buildCallBase(filter);
  return client.query(
    `SELECT c.business_status,count(*)::int AS count
         ${base}
        GROUP BY c.business_status`, filter.values,
  );
}

module.exports = {
  buildCallWhere,
  listCallOverviewRows,
  listCallOverviewSummary,
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

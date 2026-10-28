const { pool } = require('../db/connection');

// 自 server/services/convertibleBondRevisionService.js 迁入的数据读写函数（只做标准事实读写，业务判定仍留在服务层）。

async function loadPriceChanges(instrumentIds, targetDate) {
  if (!instrumentIds.length) return new Map();
  const { rows } = await pool.query(
    `SELECT instrument_id,change_date::text,price_before,price_after,reason,
            raw_payload->>'revision_floor_price' AS revision_floor_price
       FROM fundamental.convertible_bond_price_changes
      WHERE instrument_id=ANY($1::bigint[]) AND change_date <= $2::date
      ORDER BY instrument_id,change_date DESC`, [instrumentIds, targetDate]
  );
  const result = new Map();
  for (const row of rows) {
    if (!result.has(row.instrument_id)) result.set(row.instrument_id, []);
    result.get(row.instrument_id).push(row);
  }
  return result;
}

async function loadRevisionBonds(targetDate) {
  const { rows } = await pool.query(
    `SELECT i.instrument_id,i.canonical_code AS ts_code,i.list_date,p.stock_instrument_id,p.current_conv_price,
            p.remain_size,p.value_date,p.maturity_date,p.conv_start_date,p.conv_end_date,p.conv_stop_date,
            term.term_id,term.trigger_ratio,term.observation_days,term.required_days,term.effective_from,
            term.clause_text,term.revision_direction,term.comparison_operator,term.parse_status,term.parser_version,
            term.net_asset_floor_applicable,no_revision.announced_at AS no_revision_announced_at,
            no_revision.valid_until AS no_revision_valid_until,no_revision.next_eligible_date,
            no_revision.lock_declared AS no_revision_lock_declared,
            no_revision.parser_version AS no_revision_parser_version,
            no_revision.no_revision_evidence
       FROM core.instruments i
       JOIN fundamental.convertible_bond_profiles p ON p.instrument_id=i.instrument_id
       JOIN public.bond_unified u ON u.instrument_id=i.instrument_id
       LEFT JOIN fundamental.convertible_bond_issuance iss ON iss.instrument_id=i.instrument_id
       LEFT JOIN LATERAL (
         SELECT term_id,trigger_ratio,observation_days,required_days,effective_from,clause_text,
                revision_direction,comparison_operator,parse_status,parser_version,net_asset_floor_applicable
           FROM fundamental.convertible_bond_terms
          WHERE instrument_id=i.instrument_id AND term_type='reset'
            AND effective_from <= $1::date AND (effective_to IS NULL OR effective_to > $1::date)
          ORDER BY effective_from DESC,term_id DESC LIMIT 1
       ) term ON true
       LEFT JOIN LATERAL (
         SELECT announced_at,valid_until,
                COALESCE((SELECT MIN(tc.trade_date)
                            FROM market.trade_calendar tc
                           WHERE tc.exchange='SSE' AND tc.is_open
                             AND nr0.next_eligible_date >= (SELECT MIN(tc0.trade_date)
                                                             FROM market.trade_calendar tc0
                                                            WHERE tc0.exchange='SSE' AND tc0.is_open)
                            AND tc.trade_date >= nr0.next_eligible_date), nr0.next_eligible_date) AS next_eligible_date,
                COALESCE((raw_payload->>'lock_declared')::boolean,false) AS lock_declared,
                COALESCE(raw_payload->>'parser_version','') AS parser_version,
                COALESCE((raw_payload->>'no_revision_evidence')::boolean,false) AS no_revision_evidence
           FROM fundamental.convertible_bond_no_revision_history nr0
          WHERE nr0.instrument_id=i.instrument_id AND nr0.announced_at <= $1::date
          ORDER BY nr0.announced_at DESC,nr0.history_id DESC LIMIT 1
       ) no_revision ON true
      WHERE i.asset_class='convertible_bond' AND i.status='listed' AND u.status='listed'
        AND (u.issue_type IS NULL OR u.issue_type NOT IN ('定向','私募'))
        AND (iss.issue_type IS NULL OR iss.issue_type NOT IN ('定向','私募'))
        AND EXISTS (
          SELECT 1 FROM market.convertible_bond_daily_metrics active_dm
           WHERE active_dm.instrument_id=i.instrument_id AND active_dm.trade_date=$1::date
        )
        AND (i.list_date IS NULL OR i.list_date <= $1::date)
        AND (i.delist_date IS NULL OR i.delist_date > $1::date)
        AND (p.maturity_date IS NULL OR p.maturity_date >= $1::date)
        AND (p.conv_end_date IS NULL OR p.conv_end_date >= $1::date)
        AND (p.conv_stop_date IS NULL OR p.conv_stop_date > $1::date)
      ORDER BY i.canonical_code`, [targetDate]
  );
  return rows;
}

async function loadRevisionResponseHistory(instrumentIds, targetDate) {
  const result = new Map();
  if (!instrumentIds.length) return result;
  const [events, noRevision] = await Promise.all([
    pool.query(
      `SELECT instrument_id,event_type,announced_at::text
         FROM event.convertible_bond_revision_events
        WHERE instrument_id=ANY($1::bigint[]) AND announced_at <= $2::date
        ORDER BY instrument_id,announced_at,event_id`, [instrumentIds, targetDate]
    ),
    pool.query(
      `SELECT instrument_id,'no_revision' AS event_type,announced_at::text
         FROM fundamental.convertible_bond_no_revision_history
        WHERE instrument_id=ANY($1::bigint[]) AND announced_at <= $2::date
        ORDER BY instrument_id,announced_at,history_id`, [instrumentIds, targetDate]
    ),
  ]);
  for (const row of [...events.rows, ...noRevision.rows]) {
    if (!result.has(row.instrument_id)) result.set(row.instrument_id, []);
    result.get(row.instrument_id).push(row);
  }
  return result;
}

module.exports = {
  loadPriceChanges,
  loadRevisionBonds,
  loadRevisionResponseHistory,
};

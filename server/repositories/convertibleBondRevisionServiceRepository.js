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

async function select_market_convertible_bond_daily_metrics(params, client = pool) {
  return client.query(`SELECT MAX(trade_date)::text AS trade_date FROM market.convertible_bond_daily_metrics`);
}

async function select_market_trade_calendar(params, client = pool) {
  return client.query(`SELECT trade_date::text FROM market.trade_calendar
      WHERE exchange='SSE' AND is_open AND trade_date <= $1::date
      ORDER BY trade_date DESC LIMIT $2`, params);
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
              WHERE instrument_id=ANY($1::bigint[]) AND trade_date <= $2::date
                AND trade_date >= ($2::date - INTERVAL '365 days') AND close > 0
           ) daily
          WHERE source_rn=1
       ) x
      WHERE rn <= 180 ORDER BY instrument_id,trade_date DESC`, params);
}

async function select_market_daily_bars_1(params, client = pool) {
  return client.query(`SELECT DISTINCT ON (instrument_id) instrument_id,trade_date::text,close
         FROM market.daily_bars
        WHERE instrument_id=ANY($1::bigint[]) AND trade_date <= COALESCE($2::date,CURRENT_DATE) AND close > 0
        ORDER BY instrument_id,trade_date DESC,source_id DESC`, params);
}

async function select_market_daily_valuations(params, client = pool) {
  return client.query(`SELECT DISTINCT ON (instrument_id) instrument_id,trade_date::text,pb
         FROM market.daily_valuations
        WHERE instrument_id=ANY($1::bigint[]) AND trade_date <= COALESCE($2::date,CURRENT_DATE)
        ORDER BY instrument_id,trade_date DESC,source_id DESC`, params);
}

async function select_market_stock_suspend_calendar(params, client = pool) {
  return client.query(`SELECT instrument_id,trade_date::text FROM market.stock_suspend_calendar
      WHERE instrument_id=ANY($1::bigint[]) AND trade_date=ANY($2::date[]) AND suspend_type='S'`, params);
}

async function insert_analytics_convertible_bond_trigger_daily(params, client = pool) {
  return client.query(`INSERT INTO analytics.convertible_bond_trigger_daily
         (instrument_id,trade_date,trigger_type,trigger_price,close_price,matched_days,required_days,observation_days,minimum_future_days,status,formula_version,diagnostics,data_status)
         VALUES($1,$2,'reset',$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
         ON CONFLICT(instrument_id,trade_date,trigger_type,formula_version) DO UPDATE SET
           trigger_price=EXCLUDED.trigger_price,close_price=EXCLUDED.close_price,matched_days=EXCLUDED.matched_days,
           required_days=EXCLUDED.required_days,observation_days=EXCLUDED.observation_days,minimum_future_days=EXCLUDED.minimum_future_days,status=EXCLUDED.status,
           diagnostics=EXCLUDED.diagnostics,data_status=EXCLUDED.data_status,calculated_at=now()`, params);
}

async function select_analytics_convertible_bond_trigger_daily(params, client = pool) {
  return client.query(`SELECT MAX(trade_date)::text AS trade_date FROM analytics.convertible_bond_trigger_daily WHERE trigger_type='reset' AND formula_version=$1`, params);
}

async function with_analytics_convertible_bond_announcement_history(params, client = pool) {
  return client.query(`WITH latest_no_revision AS (
                  SELECT DISTINCT ON (h.instrument_id)
                         h.instrument_id,h.announced_at,h.parser_version,h.next_eligible_date,h.raw_payload
                    FROM analytics.convertible_bond_announcement_history h
                    JOIN core.instruments current_i ON current_i.instrument_id=h.instrument_id
                   WHERE h.fact_type='no_revision' AND current_i.status='listed'
                   ORDER BY h.instrument_id,h.announced_at DESC,h.fact_id DESC
                ), latest_revision_event AS (
                  SELECT DISTINCT ON (instrument_id)
                         instrument_id,announced_at,event_type
                    FROM event.convertible_bond_revision_events
                   ORDER BY instrument_id,announced_at DESC,event_id DESC
                )
                SELECT
                  (SELECT COUNT(*)::int FROM latest_no_revision
                    WHERE ((parser_version IS DISTINCT FROM '7'
                            AND (next_eligible_date IS NULL
                                 OR NOT COALESCE((raw_payload->>'lock_declared')::boolean,false)))
                           OR (next_eligible_date IS NULL
                               AND NOT (COALESCE((raw_payload->>'no_revision_evidence')::boolean,false)
                                        OR COALESCE((raw_payload->>'lock_declared')::boolean,false))))
                      AND COALESCE(raw_payload->'reparse'->>'status','') <> 'failed') AS pending_no_revision_parse,
                  (SELECT COUNT(*)::int FROM latest_no_revision
                    WHERE ((parser_version IS DISTINCT FROM '7'
                            AND (next_eligible_date IS NULL
                                 OR NOT COALESCE((raw_payload->>'lock_declared')::boolean,false)))
                           OR (next_eligible_date IS NULL
                               AND NOT (COALESCE((raw_payload->>'no_revision_evidence')::boolean,false)
                                        OR COALESCE((raw_payload->>'lock_declared')::boolean,false))))
                      AND COALESCE(raw_payload->'reparse'->>'status','') = 'failed') AS terminal_no_revision_parse,
                  (SELECT COUNT(*)::int
                     FROM analytics.convertible_bond_revision_latest r
                     JOIN latest_no_revision nr ON nr.instrument_id=r.instrument_id
                     LEFT JOIN latest_revision_event ev ON ev.instrument_id=r.instrument_id
                    WHERE nr.announced_at >= COALESCE(ev.announced_at, DATE '0001-01-01')
                      AND r.business_status IN ('proposed','meeting_pending','approved','terminated')) AS decision_status_conflicts,
                  (SELECT COUNT(*)::int FROM ops.sync_cursors
                    WHERE scope_key='convertible_bond_announcement_history'
                      AND dataset_code='official_announcements'
                      AND NULLIF(last_error,'') IS NOT NULL) AS announcement_errors`);
}

// 下修列表的查询字段（视图已按当前交易日行情和单券索引取数）
const REVISION_SELECT_FIELDS = [
  'business_status','security_code','ts_code','bond_name','bond_close','remain_size','stock_instrument_id',
  'stock_name','stock_code','current_conv_price','conversion_value','conversion_premium_pct',
  'net_asset_floor_applicable','net_asset_floor_value','net_asset_floor_blocked','trigger_ratio','trigger_price','distance_to_trigger_pct','matched_days','required_days','remaining_days','rolling_remaining_days',
  'observation_days','minimum_future_days','no_revision_announced_at','no_revision_valid_until','next_eligible_date','official_announced_at',
  'meeting_date','price_after','effective_date','reached_floor','official_source_url','official_source_number',
  'official_title','official_summary','trade_date','maturity_date','conv_start_date','conv_end_date',
  'conv_stop_date','issue_type','official_event_type',
].map(field => `r.${field}`).join(',');
const MOTIVE_SELECT_FIELDS = `motive.motive_level,motive.trade_date AS motive_trade_date,motive.motive_score,
  motive.research_percentile,motive.model_version AS motive_model_version,motive.model_version AS model_version,
  motive.quality_status AS motive_quality_status,motive.executability_status AS motive_executability_status`;

// 下修列表的筛选条件：只有状态/关键字/临期三个入口，占位符按实际顺序递增
function buildRevisionWhere({ status = '', query = '', near = false } = {}) {
  const clauses = [
    `r.business_status IS NOT NULL`,
    `(r.issue_type IS NULL OR r.issue_type NOT IN ('定向','私募'))`,
  ];
  const values = [];
  if (status) { values.push(status); clauses.push(`r.business_status=$${values.length}`); }
  if (near) clauses.push(`r.business_status IN ('near','met_pending','proposed','meeting_pending','approved')`);
  if (query) {
    values.push(`%${query}%`);
    const p = `$${values.length}`;
    clauses.push(`(r.security_code ILIKE ${p} OR r.ts_code ILIKE ${p} OR r.bond_name ILIKE ${p} OR r.stock_code ILIKE ${p} OR r.stock_name ILIKE ${p})`);
  }
  return { clauses, values };
}

// 下修概览的主列表与状态汇总（共用同一段 FROM/WHERE，排序与截断交给数据库）
async function loadRevisionOverview({ filter, modelVersion, limit }) {
  // 模型版本是服务层常量，不是外部输入；仍做一次单引号转义，避免拼接出语法错误。
  const safeModelVersion = String(modelVersion == null ? '' : modelVersion).replace(/'/g, "''");
  const base = `FROM analytics.convertible_bond_revision_latest r
    LEFT JOIN LATERAL (
      SELECT motive_level,trade_date,motive_score,model_version,quality_status,executability_status,
             (SELECT count(*) FILTER (WHERE peer.motive_score <= md.motive_score)::numeric / NULLIF(count(*),0)
                FROM analytics.convertible_bond_revision_motive_daily peer
               WHERE peer.trade_date=md.trade_date AND peer.model_version=md.model_version) AS research_percentile
        FROM analytics.convertible_bond_revision_motive_daily md
       WHERE md.instrument_id=r.instrument_id AND md.model_version='${safeModelVersion}'
       ORDER BY md.trade_date DESC,md.calculated_at DESC LIMIT 1
    ) motive ON true
    WHERE ${filter.clauses.join(' AND ')}`;
  const order = `ORDER BY CASE r.business_status
      WHEN 'implemented' THEN 1 WHEN 'proposed' THEN 2 WHEN 'meeting_pending' THEN 3
      WHEN 'approved' THEN 4 WHEN 'met_pending' THEN 5 WHEN 'near' THEN 6
      WHEN 'locked' THEN 7 WHEN 'floor_blocked' THEN 8 WHEN 'tracking' THEN 9 ELSE 10 END,
    COALESCE(r.remaining_days,9999),r.security_code LIMIT $${filter.values.length + 1}`;
  const [rowsResult, summaryResult] = await Promise.all([
    pool.query(`SELECT ${REVISION_SELECT_FIELDS},${MOTIVE_SELECT_FIELDS} ${base} ${order}`, [...filter.values, limit]),
    pool.query(`SELECT r.business_status,count(*)::int AS count ${base} GROUP BY r.business_status`, filter.values),
  ]);
  return { rows: rowsResult.rows, summaryRows: summaryResult.rows };
}

// 最近一个已完成的开市日（收盘后才要求当日数据；盘中/休市沿用最近已完成交易日）
async function selectLatestCompletedTradeDate(expectTodayData) {
  return pool.query(`SELECT MAX(trade_date)::text AS trade_date
                  FROM market.trade_calendar
                 WHERE exchange='SSE' AND is_open
                   AND trade_date ${expectTodayData ? '<=' : '<'} (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date`);
}

module.exports = {
  buildRevisionWhere,
  loadRevisionOverview,
  selectLatestCompletedTradeDate,

  loadPriceChanges,
  loadRevisionBonds,
  loadRevisionResponseHistory,
  select_market_convertible_bond_daily_metrics,
  select_market_trade_calendar,
  select_market_daily_bars,
  select_market_daily_bars_1,
  select_market_daily_valuations,
  select_market_stock_suspend_calendar,
  insert_analytics_convertible_bond_trigger_daily,
  select_analytics_convertible_bond_trigger_daily,
  with_analytics_convertible_bond_announcement_history,
};

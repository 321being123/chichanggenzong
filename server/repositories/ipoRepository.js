// 打新（IPO）数据仓储（批次3，从 routes/ipo.js 整段迁入的 SQL）。
// 合同：method(params, tx)；本域返回 pg result（保留 rows/rowCount），因为调用点同时消费两者。
// SQL 为原样搬移（含 hkOfferPhaseSql 片段与 CTE/窗口函数），未改写任何口径。
const { pool } = require('../db');

// 港股招股阶段 SQL 片段（原 routes/ipo.js 内定义，随 SQL 一并迁入）
function hkOfferPhaseSql(alias = 'h') {
  return `CASE
    WHEN LOWER(COALESCE(${alias}.ipo_status,'')) IN ('cancelled','canceled') THEN 'cancelled'
    WHEN LOWER(COALESCE(${alias}.ipo_status,''))='postponed' THEN 'postponed'
    WHEN LOWER(COALESCE(${alias}.ipo_status,'')) IN ('introduction','gem_transfer','de_spac') THEN 'not_applicable'
    WHEN LOWER(COALESCE(${alias}.ipo_status,''))='listed'
      OR ${alias}.listing_at <= now()
      OR (${alias}.listing_date ~ '^\\d{4}-\\d{2}-\\d{2}$' AND ${alias}.listing_date::date <= (timezone('Asia/Shanghai', now()))::date) THEN 'listed'
    WHEN LOWER(COALESCE(${alias}.ipo_status,''))='allotted'
      OR ${alias}.allotment_at <= now() THEN 'allotted'
    WHEN LOWER(COALESCE(${alias}.ipo_status,''))='priced'
      OR ${alias}.pricing_at <= now() THEN 'priced'
    WHEN ${alias}.offer_open_at IS NULL OR ${alias}.offer_close_at IS NULL THEN 'pending_window'
    WHEN now() < ${alias}.offer_open_at THEN 'upcoming'
    WHEN now() <= ${alias}.offer_close_at THEN 'open'
    ELSE 'closed'
  END`;
}
// 第 1 处（原 routes/ipo.js 行 156）
async function searchIpoHistory(params = {}, tx) {
  const runner = tx || pool;
  return runner.query(`SELECT h.security_code,h.security_name,h.market_type,h.ipo_date,h.listing_date,
            h.issue_price,h.issue_pe,h.industry_pe,h.industry,h.main_business,
            h.subscribe_upper_limit,h.fund_raised,h.total_shares,h.online_shares,
            h.online_lottery_rate,h.oversubscribe_multiple,h.ld_close_change,
            h.business_exposure,h.data_quality_status,
            p.pred_return,p.pred_date,p.base_pred_return,p.sector_adjustment_pp,
            p.sector_multiplier,p.sector_confidence,p.prediction_context
       FROM ipo_history h
       LEFT JOIN LATERAL (
         SELECT pred_return,pred_date,base_pred_return,sector_adjustment_pp,
                sector_multiplier,sector_confidence,prediction_context
           FROM predictions
          WHERE type='stock' AND code=h.security_code
          ORDER BY pred_date DESC,updated_at DESC NULLS LAST
          LIMIT 1
       ) p ON true
      WHERE h.market_code='CN' AND h.security_code=$1
      LIMIT 1`, [params.code]);
}

function hkSignalHistoryJoinSql(alias = 'signal_history') {
  const kindSql = hkSignalKindSql('s');
  const valueSql = `CASE WHEN ${kindSql}='margin_estimate'
    THEN COALESCE(s.margin_multiple,s.subscription_multiple)
    ELSE s.subscription_multiple END`;
  const freshnessSql = hkSignalFreshnessSql('s');
  return `LEFT JOIN LATERAL (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'amount_hkd',snapshot_history.margin_amount_hkd,
      'multiple',snapshot_history.multiple,
      'source',snapshot_history.source,
      'source_observed_at',snapshot_history.source_observed_at,
      'collected_at',snapshot_history.collected_at,
      'signal_kind',snapshot_history.signal_kind,
      'status',snapshot_history.status
    ) ORDER BY snapshot_history.event_at DESC),'[]'::jsonb) AS history
      FROM (
        SELECT s.margin_amount_hkd,${valueSql} AS multiple,s.source_code AS source,
               s.source_observed_at,s.observed_at AS collected_at,${kindSql} AS signal_kind,
               CASE WHEN ${freshnessSql} THEN 'valid' ELSE 'stale' END AS status,
               COALESCE(s.source_observed_at,s.observed_at) AS event_at
          FROM analytics.hk_ipo_market_snapshots s
         WHERE regexp_replace(s.security_code,'\\D','','g')=regexp_replace(h.security_code,'\\D','','g')
           AND s.signal_type='subscription'
           AND COALESCE(s.quality_status,'valid')='valid'
           AND (h.offer_open_at IS NULL OR s.data_date >= h.offer_open_at::date)
           AND (h.offer_close_at IS NULL OR s.data_date <= h.offer_close_at::date)
         ORDER BY COALESCE(s.source_observed_at,s.observed_at) DESC,s.data_date DESC
         LIMIT 12
      ) snapshot_history
  ) ${alias} ON true`;
}

function stockHistoryStageSql(alias = 'h') {
  return `CASE WHEN ${alias}.listing_date ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN
    CASE
      WHEN ${alias}.listing_date::date = (timezone('Asia/Shanghai', now()))::date THEN 'listing_today'
      WHEN ${alias}.listing_date::date < (timezone('Asia/Shanghai', now()))::date THEN 'listed'
      ELSE 'subscribed'
    END
  ELSE 'subscribed' END`;
}

// 以下 SQL 片段生成器原在 routes/ipo.js，随 SQL 一并迁入（被仓储内 SQL 直接插值引用）
function hkIpoShortNameJoinSql() {
  return `LEFT JOIN LATERAL (
    SELECT COALESCE(NULLIF(BTRIM(s.raw_payload->>'short_name'),''),
                    NULLIF(BTRIM(s.raw_payload->>'securityName'),'')) AS name
      FROM analytics.hk_ipo_market_snapshots s
     WHERE regexp_replace(s.security_code,'\\D','','g')=regexp_replace(h.security_code,'\\D','','g')
       AND s.source_code='hkipox-public' AND s.signal_type='subscription'
       AND COALESCE(s.quality_status,'valid')='valid'
       AND COALESCE(NULLIF(BTRIM(s.raw_payload->>'short_name'),''),
                    NULLIF(BTRIM(s.raw_payload->>'securityName'),'')) IS NOT NULL
     ORDER BY s.observed_at DESC
     LIMIT 1
  ) hkipox_name ON true`;
}

function hkSignalJoinSql(kind, alias) {
  const valueSql = kind === 'margin_estimate'
    ? 'COALESCE(s.margin_multiple,s.subscription_multiple)'
    : 's.subscription_multiple';
  const kindSql = hkSignalKindSql('s');
  const freshnessSql = hkSignalFreshnessSql('s');
  return `LEFT JOIN LATERAL (
    SELECT jsonb_build_object(
      'amount_hkd',s.margin_amount_hkd,
      'multiple',${valueSql},
      'source',s.source_code,
      'source_observed_at',s.source_observed_at,
      'collected_at',s.observed_at,
      'signal_kind',${kindSql},
      'status',CASE WHEN ${freshnessSql} THEN 'valid' ELSE 'stale' END
    ) AS signal,
    ${valueSql} AS multiple,s.source_code,s.source_observed_at,s.observed_at,${kindSql} AS signal_kind,
    CASE WHEN ${freshnessSql} THEN 'valid' ELSE 'stale' END AS signal_status
      FROM analytics.hk_ipo_market_snapshots s
     WHERE regexp_replace(s.security_code,'\\D','','g')=regexp_replace(h.security_code,'\\D','','g')
       AND s.signal_type='subscription'
       AND COALESCE(s.quality_status,'valid')='valid'
       AND ${kindSql}='${kind}'
     ORDER BY CASE WHEN ${freshnessSql} THEN 0 ELSE 1 END,
              COALESCE(s.source_observed_at,s.observed_at) DESC,
              s.data_date DESC,s.observed_at DESC
     LIMIT 1
  ) ${alias} ON true`;
}

function hkSignalKindSql(alias = 's') {
  return `COALESCE(NULLIF(${alias}.signal_kind,''),NULLIF(${alias}.raw_payload->>'signal_kind',''))`;
}

function hkSignalFreshnessSql(alias = 's') {
  const observedAtSql = `CASE WHEN ${alias}.source_code='hkipox-public'
    THEN COALESCE(${alias}.last_seen_at,${alias}.observed_at)
    ELSE COALESCE(${alias}.source_observed_at,${alias}.observed_at) END`;
  return `${observedAtSql} >= now() - CASE ${alias}.source_code
    WHEN 'livermore' THEN INTERVAL '2 hours'
    WHEN 'vbkr-public' THEN INTERVAL '2 hours'
    WHEN 'hkipox-public' THEN INTERVAL '2 hours'
    WHEN 'futu-public' THEN INTERVAL '6 hours'
    ELSE INTERVAL '1 day'
  END`;
}

function stockFieldStatusSql(alias = 'h') {
  return `jsonb_build_object(
    'ipo_date', CASE WHEN ${alias}.ipo_date ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN 'value' ELSE 'missing' END,
    'listing_date', CASE
      WHEN ${alias}.listing_date ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN 'value'
      ELSE 'pending'
    END,
    'issue_price', CASE WHEN ${alias}.issue_price IS NOT NULL THEN 'value' ELSE 'missing' END,
    'online_lottery_rate', CASE WHEN ${alias}.online_lottery_rate > 0 THEN 'value' ELSE 'pending' END,
    'oversubscribe_multiple', CASE WHEN ${alias}.oversubscribe_multiple > 0 THEN 'value' ELSE 'pending' END,
    'industry', CASE WHEN NULLIF(${alias}.industry, '') IS NOT NULL THEN 'value'
      WHEN ${alias}.ipo_date ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN 'missing'
      ELSE 'pending' END,
    'industry_pe', CASE WHEN ${alias}.industry_pe IS NOT NULL THEN 'value'
      WHEN ${alias}.data_quality_status->'field_states'->'industry_pe'->>'status' IN ('not_disclosed','not_required')
        THEN ${alias}.data_quality_status->'field_states'->'industry_pe'->>'status'
      WHEN ${alias}.data_quality_status->'field_states'->'industry_pe'->>'status' = 'source_unavailable' THEN 'source_unavailable'
      WHEN ${alias}.ipo_date ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN 'missing'
      ELSE 'pending' END,
    'main_business', CASE WHEN NULLIF(${alias}.main_business, '') IS NOT NULL THEN 'value'
      WHEN ${alias}.ipo_date ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN 'missing'
      ELSE 'pending' END,
    'business_exposure', CASE
      WHEN ${alias}.business_exposure->'industry_chain'->>'status'='complete' AND NULLIF(${alias}.business_exposure->'industry_chain'->'evidence'->>'url','') IS NOT NULL AND NULLIF(${alias}.business_exposure->'industry_chain'->'evidence'->>'content_hash','') IS NOT NULL AND jsonb_array_length(CASE WHEN jsonb_typeof(${alias}.business_exposure->'industry_chain'->'products')='array' THEN ${alias}.business_exposure->'industry_chain'->'products' ELSE '[]'::jsonb END)>0 AND jsonb_array_length(CASE WHEN jsonb_typeof(${alias}.business_exposure->'industry_chain'->'upstream')='array' THEN ${alias}.business_exposure->'industry_chain'->'upstream' ELSE '[]'::jsonb END)>0 AND jsonb_array_length(CASE WHEN jsonb_typeof(${alias}.business_exposure->'industry_chain'->'downstream')='array' THEN ${alias}.business_exposure->'industry_chain'->'downstream' ELSE '[]'::jsonb END)>0 THEN 'value'
      WHEN jsonb_typeof(${alias}.business_exposure->'exposures') = 'array' THEN
        CASE WHEN jsonb_array_length(${alias}.business_exposure->'exposures') > 0 THEN 'value'
          WHEN ${alias}.ipo_date ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN 'missing'
          ELSE 'pending' END
      WHEN ${alias}.ipo_date ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN 'missing'
      ELSE 'pending' END,
    'ld_close_change', CASE WHEN ${alias}.listing_date ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN
      CASE
        WHEN ${alias}.listing_date::date > (timezone('Asia/Shanghai', now()))::date THEN 'pending'
        WHEN ${alias}.ld_close_change IS NOT NULL THEN 'value'
        ELSE 'missing'
      END
      ELSE 'pending'
    END
  )`;
}

// 第 2 处（原 routes/ipo.js 行 557）
async function listUpcomingHkCalendar(params = {}, tx) {
  const runner = tx || pool;
  return runner.query(`SELECT h.security_code AS code,
            h.security_name_cn,h.security_name,q.name AS quote_name,i.name AS instrument_name,
            hkipox_name.name AS hkipox_short_name,
            COALESCE(timezone('Asia/Shanghai',h.offer_close_at)::date::text,h.ipo_date) AS offer_close_date,
            COALESCE(h.data_completeness->'missing_fields','[]'::jsonb) AS missing_fields
       FROM public.ipo_history h
       LEFT JOIN core.instruments i ON i.canonical_code=h.security_code
       ${hkIpoShortNameJoinSql()}
       LEFT JOIN LATERAL (
         SELECT q.name FROM market_quote_cache q
          WHERE q.source='tencent' AND q.symbol='hk' || regexp_replace(h.security_code,'\\D','','g')
          ORDER BY q.fetched_at DESC LIMIT 1
       ) q ON true
      WHERE h.market_code='HK'
        AND COALESCE(h.ipo_status,'active') NOT IN ('introduction','gem_transfer','de_spac','cancelled','canceled','listed')
        AND COALESCE(i.status,'') <> 'listed'
        AND h.listing_at IS NULL
        AND NOT (COALESCE(h.listing_date ~ '^\\d{4}-\\d{2}-\\d{2}$',false)
          AND h.listing_date::date <= (timezone('Asia/Shanghai',now()))::date)
        AND h.data_completeness->>'status'='retryable'
        AND ${hkOfferPhaseSql('h')} IN ('pending_window','upcoming','open')
        AND COALESCE(timezone('Asia/Shanghai',h.offer_close_at)::date,
          CASE WHEN h.ipo_date ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN h.ipo_date::date END)
          >= (timezone('Asia/Shanghai',now()))::date - (($1::int + 30) * INTERVAL '1 day')
       ORDER BY h.offer_close_at DESC NULLS LAST,h.security_code
      LIMIT 30`, [params.days]);
}

// 第 3 处（原 routes/ipo.js 行 595）
async function listHkCalendarWindow(params = {}, tx) {
  const runner = tx || pool;
  return runner.query(`WITH bounds AS (
         SELECT (timezone('Asia/Shanghai', now()))::date AS start_date,
                (timezone('Asia/Shanghai', now()))::date + ($1::int * INTERVAL '1 day') AS end_date
       ), hk_base AS (
         SELECT h.security_code AS code,
                h.security_name_cn,h.security_name,q.name AS quote_name,i.name AS instrument_name,
                hkipox_name.name AS hkipox_short_name,
                h.offer_open_at,h.offer_close_at,h.listing_at,h.listing_date,
                CASE WHEN h.listing_at IS NOT NULL THEN timezone('Asia/Shanghai',h.listing_at)::date::text
                     WHEN h.listing_date ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN h.listing_date END AS actual_listing_date,
                CASE WHEN h.data_completeness#>>'{prospectus,expectedEvents,listingDate,date}' ~ '^\\d{4}-\\d{2}-\\d{2}$'
                     THEN h.data_completeness#>>'{prospectus,expectedEvents,listingDate,date}' END AS expected_listing_date,
                timezone('Asia/Shanghai', h.offer_open_at)::date AS offer_open_date,
                timezone('Asia/Shanghai', h.offer_close_at)::date AS offer_close_date,
                ${hkOfferPhaseSql('h')} AS offer_phase
           FROM ipo_history h
           LEFT JOIN core.instruments i ON i.canonical_code=h.security_code
           ${hkIpoShortNameJoinSql()}
           LEFT JOIN LATERAL (
             SELECT q.name FROM market_quote_cache q
              WHERE q.source='tencent' AND q.symbol='hk' || regexp_replace(h.security_code,'\\D','','g')
              ORDER BY q.fetched_at DESC LIMIT 1
           ) q ON true
          WHERE h.market_code='HK'
       ), stock_events AS (
         SELECT GREATEST(h.offer_open_date,b.start_date)::text AS date,
                'apply' AS event_type,h.code,h.security_name_cn,h.security_name,h.quote_name,h.instrument_name,h.hkipox_short_name,h.offer_open_at,h.offer_close_at,
                h.listing_at,h.listing_date,h.offer_phase,false AS is_estimated
           FROM hk_base h CROSS JOIN bounds b
          WHERE h.offer_open_date < b.end_date::date
            AND h.offer_close_date >= b.start_date
            AND h.offer_close_at >= now()
            AND h.offer_phase IN ('upcoming','open')
         UNION ALL
         SELECT COALESCE(h.actual_listing_date,h.expected_listing_date) AS date,
                'listing' AS event_type,h.code,h.security_name_cn,h.security_name,h.quote_name,h.instrument_name,h.hkipox_short_name,h.offer_open_at,h.offer_close_at,
                h.listing_at,COALESCE(h.actual_listing_date,h.expected_listing_date) AS listing_date,h.offer_phase,
                h.actual_listing_date IS NULL AS is_estimated
           FROM hk_base h CROSS JOIN bounds b
          WHERE COALESCE(h.actual_listing_date,h.expected_listing_date)::date >= b.start_date
            AND COALESCE(h.actual_listing_date,h.expected_listing_date)::date < b.end_date::date
       )
       SELECT date,event_type,code,security_name_cn,security_name,quote_name,instrument_name,hkipox_short_name,
              offer_open_at,offer_close_at,listing_at,listing_date,offer_phase,is_estimated
         FROM stock_events
        WHERE date ~ '^\\d{4}-\\d{2}-\\d{2}$'
        ORDER BY date,code,event_type`, [params.days]);
}

// 第 4 处（原 routes/ipo.js 行 663）
async function listCnCalendarWindow(params = {}, tx) {
  const runner = tx || pool;
  return runner.query(`WITH bounds AS (
       SELECT (timezone('Asia/Shanghai', now()))::date AS start_date,
              (timezone('Asia/Shanghai', now()))::date + ($1::int * INTERVAL '1 day') AS end_date
     ), stock_events AS (
       SELECT h.ipo_date AS event_date, 'apply' AS event_type,
              h.security_code AS code, COALESCE(NULLIF(h.security_name_cn,''),NULLIF(q.name,''),h.security_name) AS name
         FROM ipo_history h
         LEFT JOIN LATERAL (
           SELECT q.name FROM market_quote_cache q
            WHERE q.source='tencent' AND q.symbol='hk' || regexp_replace(h.security_code,'\\D','','g')
            ORDER BY q.fetched_at DESC LIMIT 1
         ) q ON true, bounds b
         WHERE h.market_code=$2
           AND h.ipo_date ~ '^\\d{4}-\\d{2}-\\d{2}$'
           AND h.ipo_date >= to_char(b.start_date, 'YYYY-MM-DD')
          AND h.ipo_date < to_char(b.end_date, 'YYYY-MM-DD')
          AND ($2='HK' OR (COALESCE(h.market_type, '') <> '北交所' AND h.security_code !~ '^(920|82|83|87|43)'))
       UNION ALL
       SELECT h.listing_date AS event_date, 'listing' AS event_type,
              h.security_code AS code, COALESCE(NULLIF(h.security_name_cn,''),NULLIF(q.name,''),h.security_name) AS name
         FROM ipo_history h
         LEFT JOIN LATERAL (
           SELECT q.name FROM market_quote_cache q
            WHERE q.source='tencent' AND q.symbol='hk' || regexp_replace(h.security_code,'\\D','','g')
            ORDER BY q.fetched_at DESC LIMIT 1
         ) q ON true, bounds b
         WHERE h.market_code=$2
           AND h.listing_date ~ '^\\d{4}-\\d{2}-\\d{2}$'
           AND h.listing_date >= to_char(b.start_date, 'YYYY-MM-DD')
          AND h.listing_date < to_char(b.end_date, 'YYYY-MM-DD')
          AND ($2='HK' OR (COALESCE(h.market_type, '') <> '北交所' AND h.security_code !~ '^(920|82|83|87|43)'))
     )
     SELECT event_date AS date,event_type,code,name
       FROM stock_events ORDER BY event_date,code,event_type`, [params.days, params.market]);
}

// 第 5 处（原 routes/ipo.js 行 709）
async function listRecentInstrumentEvents(params = {}, tx) {
  const runner = tx || pool;
  return runner.query(`SELECT DISTINCT ON (e.instrument_id, e.event_type, e.event_date)
            e.event_date::text AS date, e.event_type, split_part(i.canonical_code, '.', 1) AS code,
            i.canonical_code AS secu_code, i.name
       FROM event.instrument_events e
       JOIN core.instruments i ON i.instrument_id=e.instrument_id
       LEFT JOIN fundamental.convertible_bond_issuance iss ON iss.instrument_id=e.instrument_id
      WHERE i.asset_class='convertible_bond'
        AND (iss.issue_type IS NULL OR iss.issue_type NOT IN ('定向','私募'))
        AND e.event_type IN ('online_subscription','listing')
        AND e.event_date >= CURRENT_DATE
        AND e.event_date < CURRENT_DATE + ($1::int * INTERVAL '1 day')
      ORDER BY e.instrument_id, e.event_type, e.event_date, e.source_updated_at DESC NULLS LAST`, [params.days]);
}

// 第 6 处（原 routes/ipo.js 行 735）
async function latestBondEvent(params = {}, tx) {
  const runner = tx || pool;
  return runner.query(`SELECT event_type,event_date::text AS date
         FROM event.instrument_events
        WHERE instrument_id=$1 AND event_type IN ('online_subscription','listing')
        ORDER BY event_date DESC, event_type DESC LIMIT 1`, [params.instrumentId]);
}

// 第 7 处（原 routes/ipo.js 行 760）
async function latestReportCalendar(params = {}, tx) {
  const runner = tx || pool;
  return runner.query("SELECT summary_json->'calendar' AS calendar FROM ipo_reports ORDER BY report_date DESC LIMIT 1", []);
}

// 第 8 处（原 routes/ipo.js 行 801）
async function ipoHistoryDetail(params = {}, tx) {
  const runner = tx || pool;
  return runner.query(`SELECT market_type, ipo_date, listing_date, issue_price, issue_pe, industry_pe,
              industry, main_business, subscribe_upper_limit
       FROM ipo_history WHERE security_code=$1 AND market_code='CN' LIMIT 1`, [params.code]);
}

// 第 9 处（原 routes/ipo.js 行 831）
async function reportByDate(params = {}, tx) {
  const runner = tx || pool;
  return runner.query('SELECT report_date, md, html, summary_json FROM ipo_reports WHERE report_date=$1', [params.date]);
}

// 第 10 处（原 routes/ipo.js 行 837）
async function countCnHistoryTotal(params = {}, tx) {
  const runner = tx || pool;
  return runner.query(`SELECT COUNT(*)::int AS total FROM ipo_history h
          WHERE h.ipo_date ~ '^\\d{4}-\\d{2}-\\d{2}$'
            AND h.market_code='CN'
            AND h.ipo_date <= to_char((timezone('Asia/Shanghai', now()))::date, 'YYYY-MM-DD')
            AND COALESCE(h.market_type, '') <> '北交所'
            AND h.security_code !~ '^(920|82|83|87|43)'`, []);
}

// 第 11 处（原 routes/ipo.js 行 846）
async function latestReport(params = {}, tx) {
  const runner = tx || pool;
  return runner.query('SELECT report_date, md, html, summary_json FROM ipo_reports ORDER BY report_date DESC LIMIT 1', []);
}

// 第 12 处（原 routes/ipo.js 行 864）
async function reportIndex(params = {}, tx) {
  const runner = tx || pool;
  return runner.query(`SELECT report_date,
              summary_json->>'date_display' AS date_display,
              summary_json->>'weekday' AS weekday
       FROM ipo_reports ORDER BY report_date DESC`, []);
}

// 第 13 处（原 routes/ipo.js 行 887）
async function countHkHistoryTotal(params = {}, tx) {
  const runner = tx || pool;
  return runner.query("SELECT COUNT(*)::int AS total FROM ipo_history WHERE market_code='HK'", []);
}

// 第 14 处（原 routes/ipo.js 行 889）
async function listHkHistory(params = {}, tx) {
  const runner = tx || pool;
  return runner.query(`SELECT h.instrument_id,h.security_code,h.security_name,
                h.security_name_cn,q.name AS quote_name,i.name AS instrument_name,
                hkipox_name.name AS hkipox_short_name,
                h.market_type,h.ipo_status,
                ${hkOfferPhaseSql('h')} AS offer_phase,
                COALESCE(to_char(timezone('Asia/Shanghai',h.offer_open_at),'YYYY-MM-DD'),h.ipo_date) AS offer_open_date,
                to_char(timezone('Asia/Shanghai',h.offer_close_at),'YYYY-MM-DD') AS offer_close_date,
                to_char(timezone('Asia/Shanghai',h.pricing_at),'YYYY-MM-DD') AS pricing_date,
                h.data_completeness#>>'{prospectus,expectedEvents,pricingDate,date}' AS expected_pricing_date,
                to_char(timezone('Asia/Shanghai',h.allotment_at),'YYYY-MM-DD') AS allotment_date,
                COALESCE(to_char(timezone('Asia/Shanghai',h.listing_at),'YYYY-MM-DD'),h.listing_date) AS listing_date,
                CASE WHEN h.listing_at IS NULL AND (h.listing_date IS NULL OR h.listing_date !~ '^\\d{4}-\\d{2}-\\d{2}$')
                     THEN h.data_completeness#>>'{prospectus,expectedEvents,listingDate,date}' END AS expected_listing_date,
                (h.listing_at IS NULL AND (h.listing_date IS NULL OR h.listing_date !~ '^\\d{4}-\\d{2}-\\d{2}$')
                  AND h.data_completeness#>>'{prospectus,expectedEvents,listingDate,date}' ~ '^\\d{4}-\\d{2}-\\d{2}$') AS listing_date_is_estimated,
                h.data_completeness#>>'{prospectus,expectedEvents,allotmentDate,date}' AS expected_allotment_date,
                h.data_completeness#>>'{prospectus,fields,issuePriceType}' AS prospectus_price_type,
                h.issue_price_low,h.issue_price_high,h.issue_price_final,h.lot_size_shares,h.lot_amount_hkd,
                h.application_fee_hkd,h.brokerage_fee_hkd,h.online_lottery_rate,h.oversubscribe_multiple AS public_oversubscription,
                h.oversubscribe_multiple AS final_public_oversubscription,
                subscription_signal.signal AS current_subscription_signal,
                margin_signal.signal AS current_margin_signal,
                signal_history.history AS intraday_signal_history,
                margin_signal.multiple AS subscription_live_multiple,
                margin_signal.source_code AS subscription_live_source,
                margin_signal.observed_at AS subscription_live_observed_at,
                margin_signal.signal_kind AS subscription_live_kind,
                margin_signal.signal_status <> 'valid' AS subscription_live_stale,
                livermore_grey.grey_market_price_hkd AS livermore_grey_market_price_hkd,
                livermore_grey.grey_market_change_pct AS livermore_grey_market_change_pct,
                livermore_grey.observed_at AS livermore_grey_market_observed_at,
                futu_grey.grey_market_price_hkd AS futu_grey_market_price_hkd,
                futu_grey.grey_market_change_pct AS futu_grey_market_change_pct,
                futu_grey.observed_at AS futu_grey_market_observed_at,
                NULLIF(h.greenshoe_details->>'protectionRatioPct','')::numeric AS greenshoe_protection_ratio,
                NULLIF(h.greenshoe_details->>'initialPublicOfferShares','')::numeric AS greenshoe_initial_public_offer_shares,
                NULLIF(h.greenshoe_details->>'finalPublicOfferShares','')::numeric AS greenshoe_final_public_offer_shares,
                (SELECT document->'parserEvidence'->>'publicOversubscriptionQualifier'
                   FROM jsonb_array_elements(COALESCE(h.source_documents,'[]'::jsonb)) document
                  WHERE document->>'type'='allotment_result'
                    AND document->'parserEvidence'->>'publicOversubscriptionQualifier' IS NOT NULL
                  ORDER BY document->>'announcedAt' DESC NULLS LAST
                  LIMIT 1) AS public_oversubscription_qualifier,
                h.public_offer_ratio,h.international_offer_ratio,
                h.cornerstone_details,h.greenshoe_details,h.source_documents,h.data_completeness,
                perf.listing_close,
                CASE WHEN h.issue_price_final IS NOT NULL AND h.issue_price_final > 0 AND perf.listing_close IS NOT NULL
                     THEN ROUND(((perf.listing_close / h.issue_price_final - 1) * 100)::numeric, 2) END AS actual_return,
                CASE WHEN h.issue_price_final IS NOT NULL AND perf.listing_close IS NOT NULL AND h.lot_size_shares IS NOT NULL
                     THEN ROUND(((perf.listing_close - h.issue_price_final) * h.lot_size_shares)::numeric, 2) END AS lot_profit,
                h.facts_published_at AS published_at,
                to_char(h.facts_published_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS data_as_of,
                NULL::numeric AS pred_return,NULL::numeric AS score,'facts' AS stage,'待事实完整后校准' AS advice,
                (h.facts_published_at IS NULL OR h.facts_published_at < now() - interval '2 days') AS is_stale,
                CASE WHEN h.facts_published_at IS NULL THEN '缺少事实更新时间'
                     WHEN h.facts_published_at < now() - interval '2 days' THEN '事实超过 2 天未更新'
                     ELSE '' END AS stale_reason
           FROM ipo_history h
           LEFT JOIN core.instruments i ON i.canonical_code=h.security_code
           ${hkIpoShortNameJoinSql()}
           LEFT JOIN LATERAL (
             SELECT q.name
               FROM market_quote_cache q
              WHERE q.source='tencent'
                AND q.symbol='hk' || replace(h.security_code,'.HK','')
              ORDER BY q.fetched_at DESC
              LIMIT 1
           ) q ON true
           ${hkSignalJoinSql('subscription_estimate', 'subscription_signal')}
           ${hkSignalJoinSql('margin_estimate', 'margin_signal')}
           ${hkSignalHistoryJoinSql('signal_history')}
           LEFT JOIN LATERAL (
             SELECT s.grey_market_price_hkd,s.grey_market_change_pct,s.observed_at
               FROM analytics.hk_ipo_market_snapshots s
              WHERE regexp_replace(s.security_code,'\\D','','g')=regexp_replace(h.security_code,'\\D','','g') AND s.signal_type='grey_market' AND s.source_code='livermore'
              ORDER BY s.observed_at DESC
              LIMIT 1
           ) livermore_grey ON true
           LEFT JOIN LATERAL (
             SELECT s.grey_market_price_hkd,s.grey_market_change_pct,s.observed_at
               FROM analytics.hk_ipo_market_snapshots s
              WHERE regexp_replace(s.security_code,'\\D','','g')=regexp_replace(h.security_code,'\\D','','g') AND s.signal_type='grey_market' AND s.source_code='futu-public'
              ORDER BY s.observed_at DESC
              LIMIT 1
           ) futu_grey ON true
           LEFT JOIN LATERAL (
             SELECT d.close AS listing_close
              FROM market.daily_bars d
              WHERE d.instrument_id=h.instrument_id
                AND d.trade_date >= CASE
                  WHEN h.listing_at IS NOT NULL THEN h.listing_at::date
                  WHEN h.listing_date ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN h.listing_date::date
                END
              ORDER BY d.trade_date,d.source_id DESC
              LIMIT 1
           ) perf ON true
          WHERE h.market_code='HK'
          ORDER BY COALESCE(h.offer_open_at,h.listing_at,h.facts_published_at) DESC NULLS LAST,h.security_code
          LIMIT $1 OFFSET $2`, [params.limit, params.offset]);
}

// 第 15 处（原 routes/ipo.js 行 1006）
async function countCnHistoryFiltered(params = {}, tx) {
  const runner = tx || pool;
  return runner.query(`SELECT COUNT(*)::int AS total FROM ipo_history h
          WHERE h.ipo_date ~ '^\\d{4}-\\d{2}-\\d{2}$'
            AND h.market_code='CN'
            AND h.ipo_date <= to_char((timezone('Asia/Shanghai', now()))::date, 'YYYY-MM-DD')
            AND COALESCE(h.market_type, '') <> '北交所'
            AND h.security_code !~ '^(920|82|83|87|43)'`, []);
}

// 第 16 处（原 routes/ipo.js 行 1015）
async function listCnHistory(params = {}, tx) {
  const runner = tx || pool;
  return runner.query(`              SELECT h.instrument_id, h.security_code, h.security_name, h.ipo_date,
                h.issue_price, h.issue_pe, h.industry_pe, h.fund_raised,
                h.total_shares, h.online_shares, h.online_lottery_rate, h.oversubscribe_multiple,
                COALESCE(
                  h.circulation_mv,
                  ROUND((COALESCE(h.online_shares, h.total_shares) * h.issue_price / 10000.0)::numeric, 2)::double precision
                ) AS circulation_mv,
                h.listing_date, h.ld_close_change,
                h.main_business, h.industry, h.subscribe_upper_limit,
                h.issue_pe_status, h.data_quality_status,
                ${stockHistoryStageSql('h')} AS history_stage,
                ${stockFieldStatusSql('h')} AS field_status,
                to_char((timezone('Asia/Shanghai', now()))::date, 'YYYY-MM-DD') AS data_as_of,
                p.pred_return AS pred_return,
                p.base_pred_return AS base_pred_return,
                p.sector_adjustment_pp AS sector_adjustment_pp,
                p.sector_multiplier AS sector_multiplier,
                p.sector_confidence AS sector_confidence,
                p.prediction_context AS prediction_context,
                COALESCE(p.has_prediction, false) AS has_prediction
         FROM ipo_history h
         LEFT JOIN LATERAL (
           SELECT pred_return, base_pred_return, sector_adjustment_pp,
                  sector_multiplier, sector_confidence, prediction_context,
                  true AS has_prediction FROM predictions
           WHERE type = 'stock' AND code = h.security_code AND pred_return IS NOT NULL
           ORDER BY pred_date DESC LIMIT 1
         ) p ON true
          WHERE h.ipo_date ~ '^\\d{4}-\\d{2}-\\d{2}$'
            AND h.market_code='CN'
            AND h.ipo_date <= to_char((timezone('Asia/Shanghai', now()))::date, 'YYYY-MM-DD')
           AND COALESCE(h.market_type, '') <> '北交所'
           AND h.security_code !~ '^(920|82|83|87|43)'
         ORDER BY h.ipo_date DESC, NULLIF(h.listing_date, '') DESC NULLS LAST, h.security_code LIMIT $1 OFFSET $2`, [params.limit, params.offset]);
}

// 第 17 处（原 routes/ipo.js 行 1093）
async function reportFactByCode(params = {}, tx) {
  const runner = tx || pool;
  return runner.query(`SELECT h.security_code,h.security_name,h.security_name_cn,
                q.name AS quote_name,i.name AS instrument_name,
                hkipox_name.name AS hkipox_short_name,
                market_type,ipo_status,${hkOfferPhaseSql('h')} AS offer_phase,
                COALESCE(to_char(timezone('Asia/Shanghai',offer_open_at),'YYYY-MM-DD'),ipo_date) AS offer_open_date,
                to_char(timezone('Asia/Shanghai',offer_close_at),'YYYY-MM-DD') AS offer_close_date,
                to_char(timezone('Asia/Shanghai',pricing_at),'YYYY-MM-DD') AS pricing_date,
                data_completeness#>>'{prospectus,expectedEvents,pricingDate,date}' AS expected_pricing_date,
                to_char(timezone('Asia/Shanghai',allotment_at),'YYYY-MM-DD') AS allotment_date,
                COALESCE(to_char(timezone('Asia/Shanghai',listing_at),'YYYY-MM-DD'),listing_date) AS listing_date,
                CASE WHEN listing_at IS NULL AND (listing_date IS NULL OR listing_date !~ '^\\d{4}-\\d{2}-\\d{2}$')
                     THEN data_completeness#>>'{prospectus,expectedEvents,listingDate,date}' END AS expected_listing_date,
                (listing_at IS NULL AND (listing_date IS NULL OR listing_date !~ '^\\d{4}-\\d{2}-\\d{2}$')
                  AND data_completeness#>>'{prospectus,expectedEvents,listingDate,date}' ~ '^\\d{4}-\\d{2}-\\d{2}$') AS listing_date_is_estimated,
                data_completeness#>>'{prospectus,expectedEvents,allotmentDate,date}' AS expected_allotment_date,
                data_completeness#>>'{prospectus,fields,issuePriceType}' AS prospectus_price_type,
                issue_price_low,issue_price_high,issue_price_final,lot_size_shares,lot_amount_hkd,
                application_fee_hkd,brokerage_fee_hkd,oversubscribe_multiple,greenshoe_details,facts_published_at,
                subscription_signal.signal AS current_subscription_signal,
                margin_signal.signal AS current_margin_signal,
                signal_history.history AS intraday_signal_history,
                margin_signal.multiple AS subscription_live_multiple,
                margin_signal.source_code AS subscription_live_source,
                (SELECT s.grey_market_change_pct FROM analytics.hk_ipo_market_snapshots s
                  WHERE regexp_replace(s.security_code,'\\D','','g')=regexp_replace(h.security_code,'\\D','','g')
                    AND s.signal_type='grey_market' AND s.source_code='livermore' ORDER BY s.observed_at DESC LIMIT 1) AS livermore_grey_market_change_pct,
                (SELECT s.grey_market_change_pct FROM analytics.hk_ipo_market_snapshots s
                  WHERE regexp_replace(s.security_code,'\\D','','g')=regexp_replace(h.security_code,'\\D','','g')
                    AND s.signal_type='grey_market' AND s.source_code='futu-public' ORDER BY s.observed_at DESC LIMIT 1) AS futu_grey_market_change_pct
           FROM ipo_history h
           LEFT JOIN core.instruments i ON i.canonical_code=h.security_code
           ${hkIpoShortNameJoinSql()}
           LEFT JOIN LATERAL (
             SELECT name
               FROM market_quote_cache
              WHERE source='tencent' AND symbol='hk' || replace(h.security_code,'.HK','')
              ORDER BY fetched_at DESC
              LIMIT 1
           ) q ON true
           ${hkSignalJoinSql('subscription_estimate', 'subscription_signal')}
           ${hkSignalJoinSql('margin_estimate', 'margin_signal')}
           ${hkSignalHistoryJoinSql('signal_history')}
          WHERE h.market_code='HK' AND h.security_code=$1 LIMIT 1`, [params.hkCode]);
}

// 第 18 处（原 routes/ipo.js 行 1178）
async function reportMarkdownByCode(params = {}, tx) {
  const runner = tx || pool;
  return runner.query('SELECT md FROM ipo_reports WHERE md LIKE $1 ORDER BY report_date DESC', [params.pattern]);
}

async function latestReportDate(_params = {}, tx) {
  return (tx || pool).query('SELECT report_date FROM ipo_reports ORDER BY report_date DESC LIMIT 1');
}

async function findHkTargetCodes(codes, tx) {
  return (tx || pool).query(`
      SELECT security_code FROM public.ipo_history
       WHERE market_code='HK' AND security_code=ANY($1::text[])
    `, [codes]);
}


function attachFirstDayPerformanceQuery1(executor, ...args) { return executor("SELECT symbol,price,quote_time FROM market_quote_cache WHERE source='tencent' AND symbol=ANY($1::text[])", ...args); }

module.exports = {
  attachFirstDayPerformanceQuery1,
  hkOfferPhaseSql,
  hkIpoShortNameJoinSql,
  hkSignalJoinSql,
  hkSignalKindSql,
  hkSignalFreshnessSql,
  stockFieldStatusSql,
  hkSignalHistoryJoinSql,
  stockHistoryStageSql,
  searchIpoHistory,
  listUpcomingHkCalendar,
  listHkCalendarWindow,
  listCnCalendarWindow,
  listRecentInstrumentEvents,
  latestBondEvent,
  latestReportCalendar,
  ipoHistoryDetail,
  reportByDate,
  countCnHistoryTotal,
  latestReport,
  latestReportDate,
  findHkTargetCodes,
  reportIndex,
  countHkHistoryTotal,
  listHkHistory,
  countCnHistoryFiltered,
  listCnHistory,
  reportFactByCode,
  reportMarkdownByCode,
};

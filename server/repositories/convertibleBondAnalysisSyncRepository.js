const { pool } = require('../db/connection');

// 自 server/services/convertibleBondAnalysisSync.js 抽取的 SQL 执行函数：语句原样搬迁，返回 pg 原始结果（rows/rowCount），调用方零改动。
async function delete_fundamental_convertible_bond_price_changes(params, client = pool) {
  return client.query(`DELETE FROM fundamental.convertible_bond_price_changes
     WHERE instrument_id=$1 AND source_id=$2 AND reason ~ '(提议|预计触发|可能触发|提示性)'`, params);
}

async function insert_fundamental_convertible_bond_no_revision_history(params, client = pool) {
  return client.query(`INSERT INTO fundamental.convertible_bond_no_revision_history(instrument_id,announced_at,valid_until,next_eligible_date,summary,source_id,raw_payload)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(instrument_id,announced_at) DO UPDATE SET valid_until=EXCLUDED.valid_until,
           next_eligible_date=EXCLUDED.next_eligible_date,summary=EXCLUDED.summary,raw_payload=EXCLUDED.raw_payload`, params);
}

async function insert_fundamental_convertible_bond_price_changes(params, client = pool) {
  return client.query(`INSERT INTO fundamental.convertible_bond_price_changes(instrument_id,publish_date,change_date,price_before,price_after,reason,source_id,raw_payload)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT(instrument_id,change_date) DO UPDATE SET publish_date=EXCLUDED.publish_date,
           price_before=COALESCE(EXCLUDED.price_before,fundamental.convertible_bond_price_changes.price_before),
           price_after=COALESCE(EXCLUDED.price_after,fundamental.convertible_bond_price_changes.price_after),reason=EXCLUDED.reason,raw_payload=EXCLUDED.raw_payload`, params);
}

async function insert_analytics_convertible_bond_trigger_daily(params, client = pool) {
  return client.query(`INSERT INTO analytics.convertible_bond_trigger_daily
       (instrument_id,trade_date,trigger_type,trigger_price,close_price,matched_days,required_days,observation_days,status,formula_version,diagnostics)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
       ON CONFLICT(instrument_id,trade_date,trigger_type,formula_version) DO UPDATE SET trigger_price=EXCLUDED.trigger_price,
         close_price=EXCLUDED.close_price,matched_days=EXCLUDED.matched_days,required_days=EXCLUDED.required_days,
         observation_days=EXCLUDED.observation_days,status=EXCLUDED.status,diagnostics=EXCLUDED.diagnostics,calculated_at=now()`, params);
}

async function select_market_trade_calendar(params, client = pool) {
  return client.query(`SELECT MIN(trade_date)::text AS trade_date
       FROM market.trade_calendar
      WHERE exchange='SSE' AND is_open AND trade_date > $1::date`, params);
}

async function select_ops_data_sources(params, client = pool) {
  return client.query(`SELECT source_id FROM ops.data_sources WHERE source_code='tushare' LIMIT 1`);
}

async function insert_ops_source_endpoint_runtime(params, client = pool) {
  return client.query(`INSERT INTO ops.source_endpoint_runtime(source_id,api_name,credential_fingerprint,consecutive_fallback_count,last_fallback_at,last_primary_success_at)
     VALUES($1,'cb_daily','none',CASE WHEN $2::boolean THEN 1 ELSE 0 END,CASE WHEN $2::boolean THEN now() END,CASE WHEN $2::boolean THEN NULL ELSE now() END)
     ON CONFLICT(source_id,api_name,credential_fingerprint) DO UPDATE SET
       consecutive_fallback_count=CASE WHEN $2::boolean THEN ops.source_endpoint_runtime.consecutive_fallback_count+1 ELSE 0 END,
       last_fallback_at=CASE WHEN $2::boolean THEN now() ELSE ops.source_endpoint_runtime.last_fallback_at END,
       last_primary_success_at=CASE WHEN $2::boolean THEN ops.source_endpoint_runtime.last_primary_success_at ELSE now() END,
       updated_at=now()
     RETURNING consecutive_fallback_count,last_primary_success_at`, params);
}

async function select_event_instrument_events(params, client = pool) {
  return client.query(`SELECT DISTINCT ON (i.instrument_id)
            split_part(i.canonical_code,'.',1) AS code,
            i.name,
            e.event_date::text AS listing_date,
            (l.instrument_id IS NULL) AS missing
       FROM event.instrument_events e
       JOIN core.instruments i ON i.instrument_id=e.instrument_id
       JOIN fundamental.convertible_bond_profiles p ON p.instrument_id=i.instrument_id
       LEFT JOIN fundamental.convertible_bond_issuance iss ON iss.instrument_id=i.instrument_id
       LEFT JOIN analytics.convertible_bond_listing_liquidity l ON l.instrument_id=i.instrument_id
      WHERE e.event_type='listing'
        AND e.event_date=$1::date
        AND i.asset_class='convertible_bond'
        AND (iss.issue_type IS NULL OR iss.issue_type NOT IN ('定向','私募'))
      ORDER BY i.instrument_id,e.event_date DESC`, params);
}

async function select_fundamental_convertible_bond_profiles(params, client = pool) {
  return client.query(`SELECT i.canonical_code AS ts_code, p.current_conv_price
           FROM fundamental.convertible_bond_profiles p
           JOIN core.instruments i ON i.instrument_id = p.instrument_id`);
}

async function insert_ops_sync_cursors(params, client = pool) {
  return client.query(`INSERT INTO ops.sync_cursors(scope_key,dataset_code,last_success_date,last_source_update,last_attempt_at,last_error,retry_count)
         VALUES('convertible_bond_universe','cb_basic_cb_daily',$1,now(),now(),'',0)
         ON CONFLICT(scope_key,dataset_code) DO UPDATE SET last_success_date=COALESCE(EXCLUDED.last_success_date,ops.sync_cursors.last_success_date),
           last_source_update=now(),last_attempt_at=now(),last_error='',retry_count=0,updated_at=now()`, params);
}

async function insert_market_trade_calendar(params, client = pool) {
  return client.query(`INSERT INTO market.trade_calendar(exchange,trade_date,is_open,source_code,raw_payload)
       SELECT x.exchange,x.trade_date,x.is_open,'tushare',x.raw_payload
         FROM jsonb_to_recordset($1::jsonb) AS x(exchange text,trade_date date,is_open boolean,raw_payload jsonb)
       ON CONFLICT(exchange,trade_date) DO UPDATE SET
         is_open=EXCLUDED.is_open,source_code=EXCLUDED.source_code,
         raw_payload=EXCLUDED.raw_payload,ingested_at=now()`, params);
}

async function select_core_instruments(params, client = pool) {
  return client.query(`SELECT i.canonical_code, i.instrument_id
         FROM core.instruments i
         JOIN fundamental.convertible_bond_profiles p ON p.instrument_id=i.instrument_id`);
}

async function update_ops_dataset_partitions(params, client = pool) {
  return client.query(`UPDATE ops.dataset_partitions
        SET status='stale',is_stale=true,stale_reason=$2,
            diagnostics=COALESCE(diagnostics,'{}'::jsonb)||$3::jsonb,updated_at=now()
      WHERE dataset_code='stock_daily' AND scope_key='CN' AND partition_key=$1::date`, params);
}

async function select_ops_sync_cursors(params, client = pool) {
  return client.query(`SELECT last_success_date::text AS last_success_date,last_error
       FROM ops.sync_cursors
      WHERE scope_key='convertible_bond_announcement_history' AND dataset_code='official_announcements'`);
}

async function update_fundamental_convertible_bond_no_revision_history(params, client = pool) {
  return client.query(`UPDATE fundamental.convertible_bond_no_revision_history
                SET raw_payload=jsonb_set(COALESCE(raw_payload,'{}'::jsonb),'{reparse}',
                  COALESCE(raw_payload->'reparse','{}'::jsonb) || jsonb_build_object(
                    'parser_version','7','status','failed','attempted_at',now(),
                    'reason',$3::text,'attempts',COALESCE((raw_payload->'reparse'->>'attempts')::int,0)+1))
              WHERE instrument_id=$1 AND announced_at=$2::date`, params);
}

async function update_fundamental_convertible_bond_no_revision_history_1(params, client = pool) {
  return client.query(`UPDATE fundamental.convertible_bond_no_revision_history
                SET raw_payload=jsonb_set(COALESCE(raw_payload,'{}'::jsonb),'{reparse}',
                  COALESCE(raw_payload->'reparse','{}'::jsonb) || jsonb_build_object(
                    'status','maturity_checked','attempted_at',now(),'reason','legacy_maturity_date_check'))
              WHERE instrument_id=$1 AND announced_at=$2::date`, params);
}

async function insert_ops_sync_cursors_1(params, client = pool) {
  return client.query(`INSERT INTO ops.sync_cursors(scope_key,dataset_code,last_attempt_at,last_error,retry_count,updated_at)
             VALUES('convertible_bond_announcement_history','official_announcements',now(),$1,1,now())
             ON CONFLICT(scope_key,dataset_code) DO UPDATE SET last_attempt_at=now(),last_error=$1,
               retry_count=ops.sync_cursors.retry_count+1,updated_at=now()`, params);
}

async function insert_ops_sync_cursors_2(params, client = pool) {
  return client.query(`INSERT INTO ops.sync_cursors(scope_key,dataset_code,last_attempt_at,last_error,retry_count,updated_at)
         VALUES('convertible_bond_announcement_history','official_announcements',now(),$1,1,now())
         ON CONFLICT(scope_key,dataset_code) DO UPDATE SET last_attempt_at=now(),last_error=$1,
           retry_count=ops.sync_cursors.retry_count+1,updated_at=now()`, params);
}

async function insert_ops_sync_cursors_3(params, client = pool) {
  return client.query(`INSERT INTO ops.sync_cursors(scope_key,dataset_code,last_success_date,last_attempt_at,last_error,retry_count,updated_at)
       VALUES('convertible_bond_announcement_history','official_announcements',$1,now(),''::text,0,now())
       ON CONFLICT(scope_key,dataset_code) DO UPDATE SET last_success_date=EXCLUDED.last_success_date,
         last_attempt_at=now(),last_error='',retry_count=0,updated_at=now()`, params);
}

async function select_market_trade_calendar_1(params, client = pool) {
  return client.query(`SELECT MIN(trade_date)::text AS trade_date
       FROM market.trade_calendar
      WHERE exchange='SSE' AND is_open AND trade_date>$1::date`, params);
}

async function select_fundamental_convertible_bond_no_revision_history(params, client = pool) {
  return client.query(`
      SELECT DISTINCT ON (h.instrument_id)
             h.history_id,h.instrument_id,h.announced_at::text,h.raw_payload,
             s.canonical_code AS stock_code
        FROM fundamental.convertible_bond_no_revision_history h
        JOIN core.instruments i ON i.instrument_id=h.instrument_id
        JOIN fundamental.convertible_bond_profiles p ON p.instrument_id=h.instrument_id
        JOIN core.instruments s ON s.instrument_id=p.stock_instrument_id
       WHERE h.raw_payload->>'symbolic_reference_type'='quarterly_report_board_meeting'
         AND COALESCE(h.raw_payload->>'symbolic_resolution_status','pending')<>'resolved'
       ORDER BY h.instrument_id,h.announced_at DESC,h.history_id DESC`);
}

async function update_fundamental_convertible_bond_no_revision_history_2(params, client = pool) {
  return client.query(`UPDATE fundamental.convertible_bond_no_revision_history
              SET valid_until=$2::date,next_eligible_date=$3::date,
                  raw_payload=COALESCE(raw_payload,'{}'::jsonb) || jsonb_build_object(
                    'symbolic_resolution_status','resolved',
                    'symbolic_report_announced_at',$4::text,
                    'symbolic_board_meeting_date',$2::text,
                    'symbolic_board_source_url',$5::text,
                    'symbolic_board_title',$6::text,
                    'symbolic_resolved_at',now())
            WHERE history_id=$1`, params);
}

async function select_fundamental_convertible_bond_profiles_1(params, client = pool) {
  return client.query(`SELECT DISTINCT s.canonical_code,s.instrument_id
       FROM fundamental.convertible_bond_profiles p
       JOIN core.instruments b ON b.instrument_id=p.instrument_id
       LEFT JOIN fundamental.convertible_bond_issuance iss ON iss.instrument_id=p.instrument_id
       JOIN core.instruments s ON s.instrument_id=p.stock_instrument_id
       JOIN public.bond_unified u ON u.instrument_id=b.instrument_id
       WHERE u.status='listed'
         AND s.asset_class='stock'
         AND s.list_date IS NOT NULL
         AND (s.delist_date IS NULL OR s.delist_date >= $1::date)
         AND (iss.issue_type IS NULL OR iss.issue_type NOT IN ('定向','私募'))
         AND (p.maturity_date IS NULL OR p.maturity_date >= $1::date)`, params);
}

async function select_market_stock_suspend_calendar(params, client = pool) {
  return client.query(`SELECT
           COUNT(DISTINCT i.instrument_id) FILTER (WHERE sc.instrument_id IS NULL)::int AS expected,
           COUNT(DISTINCT b.instrument_id) FILTER (WHERE sc.instrument_id IS NULL)::int AS bars,
           COUNT(DISTINCT v.instrument_id) FILTER (WHERE sc.instrument_id IS NULL)::int AS valuations
         FROM (SELECT unnest($1::bigint[]) AS instrument_id) i
         LEFT JOIN market.stock_suspend_calendar sc
           ON sc.instrument_id=i.instrument_id AND sc.trade_date=$2::date AND sc.source_id=$3
         LEFT JOIN market.daily_bars b ON b.instrument_id=i.instrument_id AND b.trade_date=$2::date AND b.source_id=$3
         LEFT JOIN market.daily_valuations v ON v.instrument_id=i.instrument_id AND v.trade_date=$2::date AND v.source_id=$3`, params);
}

// 公告历史回补目标清单：在市口径 + 可选代码范围 + 「仍有待解析积压」筛选（含解析版本与到期日残留判定）
async function selectAnnouncementHistoryTargets({ end, codes = [], cachedOnly = false, limit = null }) {
  const params = [];
  const clauses = ["i.asset_class='convertible_bond'", "i.status='listed'",
    "(iss.issue_type IS NULL OR iss.issue_type NOT IN ('定向','私募'))",
    `EXISTS (SELECT 1 FROM market.convertible_bond_daily_metrics active_dm
              WHERE active_dm.instrument_id=i.instrument_id
                AND active_dm.trade_date=(SELECT MAX(trade_date) FROM market.convertible_bond_daily_metrics))`,
    '(i.list_date IS NULL OR i.list_date <= $1::date)'];
  params.push(end);
  if (codes.length) { params.push(codes); clauses.push(`i.canonical_code=ANY(${params.length}::text[])`); }
  if (cachedOnly && !codes.length) {
    clauses.push(`(EXISTS (
      SELECT 1
        FROM analytics.convertible_bond_announcement_history pending_no_revision
       WHERE pending_no_revision.instrument_id=i.instrument_id
         AND pending_no_revision.fact_type='no_revision'
         AND pending_no_revision.fact_id=(SELECT h_latest.fact_id
                                            FROM analytics.convertible_bond_announcement_history h_latest
                                           WHERE h_latest.instrument_id=i.instrument_id
                                             AND h_latest.fact_type='no_revision'
                                           ORDER BY h_latest.announced_at DESC,h_latest.fact_id DESC LIMIT 1)
         AND ((pending_no_revision.parser_version IS DISTINCT FROM '7'
               AND (pending_no_revision.next_eligible_date IS NULL
                    OR NOT COALESCE((pending_no_revision.raw_payload->>'lock_declared')::boolean,false)))
              OR (pending_no_revision.next_eligible_date IS NULL
                  AND NOT (COALESCE((pending_no_revision.raw_payload->>'no_revision_evidence')::boolean,false)
                           OR COALESCE((pending_no_revision.raw_payload->>'lock_declared')::boolean,false)))
              OR (pending_no_revision.parser_version = '7'
                  AND EXISTS (
                    SELECT 1 FROM fundamental.convertible_bond_profiles maturity_profile
                     WHERE maturity_profile.instrument_id=pending_no_revision.instrument_id
                       AND (pending_no_revision.next_eligible_date=maturity_profile.maturity_date
                            OR pending_no_revision.valid_until=maturity_profile.maturity_date)
                  )
                  AND COALESCE(pending_no_revision.raw_payload->'reparse'->>'status','') <> 'maturity_checked'))
         AND COALESCE(pending_no_revision.raw_payload->'reparse'->>'status','') <> 'failed'
       ) OR EXISTS (
           SELECT 1 FROM event.convertible_bond_call_events pending_call
            WHERE pending_call.instrument_id=i.instrument_id
              AND pending_call.source_url <> ''
              AND (pending_call.parser_version IS DISTINCT FROM 'call-event-v3'
                   OR pending_call.parse_status <> 'complete')
         )
    )`);
  }
  const configuredLimit = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : null;
  const limitClause = configuredLimit ? ` LIMIT ${params.length + 1}` : '';
  if (configuredLimit) params.push(configuredLimit);
  const { rows } = await pool.query(
    `SELECT i.instrument_id,i.canonical_code AS ts_code,p.bond_short_name,p.value_date,p.list_date,p.maturity_date,
            s.canonical_code AS stock_code
       FROM core.instruments i
       JOIN fundamental.convertible_bond_profiles p ON p.instrument_id=i.instrument_id
       LEFT JOIN fundamental.convertible_bond_issuance iss ON iss.instrument_id=i.instrument_id
       LEFT JOIN core.instruments s ON s.instrument_id=p.stock_instrument_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY i.canonical_code${limitClause}`,
    params
  );
  return { rows };
}

// 最近若干开市日里，指定正股中仍存在行情缺口的清单（扣掉停牌日）
async function selectMissingStockBars(params, client = pool) {
  return client.query(
    `SELECT s.canonical_code,s.instrument_id
       FROM core.instruments s
      WHERE s.instrument_id=ANY($1::bigint[])
        AND (SELECT COUNT(*)
               FROM unnest($2::date[]) AS d(trade_date)
              WHERE NOT EXISTS (
                SELECT 1 FROM market.stock_suspend_calendar sc
                 WHERE sc.instrument_id=s.instrument_id AND sc.trade_date=d.trade_date AND sc.source_id=$3
              )) > 0
        AND (SELECT COUNT(DISTINCT b.trade_date)
               FROM market.daily_bars b
              WHERE b.instrument_id=s.instrument_id
                AND b.trade_date=ANY($2::date[])
                AND b.source_id=$3)
            < (SELECT COUNT(*)
                 FROM unnest($2::date[]) AS d(trade_date)
                 WHERE NOT EXISTS (
                   SELECT 1 FROM market.stock_suspend_calendar sc
                    WHERE sc.instrument_id=s.instrument_id AND sc.trade_date=d.trade_date AND sc.source_id=$3
                 ))
      ORDER BY s.canonical_code`,
    params,
  );
}


function readBondGapQueueQuery1(executor, ...args) { return executor(`SELECT cursor_payload FROM ops.sync_cursors
      WHERE scope_key='convertible_bond_universe' AND dataset_code='cb_basic_cb_daily' LIMIT 1`, ...args); }

function writeBondGapQueueQuery1(executor, ...args) { return executor(`INSERT INTO ops.sync_cursors(scope_key,dataset_code,cursor_payload,last_attempt_at,last_error)
     VALUES('convertible_bond_universe','cb_basic_cb_daily',jsonb_build_object('bond_daily_gap_queue',$1::jsonb),now(),'')
     ON CONFLICT(scope_key,dataset_code) DO UPDATE SET
       cursor_payload=jsonb_set(COALESCE(ops.sync_cursors.cursor_payload,'{}'::jsonb),'{bond_daily_gap_queue}',$1::jsonb,true),
       last_attempt_at=now(),updated_at=now()`, ...args); }

module.exports = {
  readBondGapQueueQuery1, writeBondGapQueueQuery1,
  selectMissingStockBars,
  selectAnnouncementHistoryTargets,
  delete_fundamental_convertible_bond_price_changes,
  insert_fundamental_convertible_bond_no_revision_history,
  insert_fundamental_convertible_bond_price_changes,
  insert_analytics_convertible_bond_trigger_daily,
  select_market_trade_calendar,
  select_ops_data_sources,
  insert_ops_source_endpoint_runtime,
  select_event_instrument_events,
  select_fundamental_convertible_bond_profiles,
  insert_ops_sync_cursors,
  insert_market_trade_calendar,
  select_core_instruments,
  update_ops_dataset_partitions,
  select_ops_sync_cursors,
  update_fundamental_convertible_bond_no_revision_history,
  update_fundamental_convertible_bond_no_revision_history_1,
  insert_ops_sync_cursors_1,
  insert_ops_sync_cursors_2,
  insert_ops_sync_cursors_3,
  select_market_trade_calendar_1,
  select_fundamental_convertible_bond_no_revision_history,
  update_fundamental_convertible_bond_no_revision_history_2,
  select_fundamental_convertible_bond_profiles_1,
  select_market_stock_suspend_calendar,
};

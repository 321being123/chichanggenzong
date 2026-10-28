const { pool } = require('../db/connection');

const crypto = require('crypto');

// 自 server/services/convertibleBondRevisionMotiveService.js 迁入的数据读写函数（只做标准事实读写，业务判定仍留在服务层）。

const CYCLE_VERSION = 'cycle-v1';

async function saveRevisionCycles(client, instrumentId, cycles, termId) {
  await client.query('DELETE FROM analytics.convertible_bond_revision_cycles WHERE instrument_id=$1 AND cycle_version=$2', [instrumentId, CYCLE_VERSION]);
  for (const row of cycles || []) {
    await client.query(
      `INSERT INTO analytics.convertible_bond_revision_cycles
       (instrument_id,cycle_no,cycle_start_date,first_match_date,trigger_date,proposal_date,decision_date,cycle_end_date,implementation_date,outcome,short_label,proposal_type,no_revision,lock_until,term_id,cycle_version,evidence)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)
       ON CONFLICT(instrument_id,cycle_no,cycle_version) DO UPDATE SET cycle_start_date=EXCLUDED.cycle_start_date,
         first_match_date=EXCLUDED.first_match_date,trigger_date=EXCLUDED.trigger_date,proposal_date=EXCLUDED.proposal_date,decision_date=EXCLUDED.decision_date,
         cycle_end_date=EXCLUDED.cycle_end_date,implementation_date=EXCLUDED.implementation_date,outcome=EXCLUDED.outcome,short_label=EXCLUDED.short_label,
         proposal_type=EXCLUDED.proposal_type,no_revision=EXCLUDED.no_revision,lock_until=EXCLUDED.lock_until,term_id=EXCLUDED.term_id,evidence=EXCLUDED.evidence,calculated_at=now()` ,
      [instrumentId, row.cycle_no, row.cycle_start_date, row.first_match_date, row.trigger_date, row.proposal_date, row.decision_date, row.cycle_end_date,
        row.implementation_date, row.outcome, row.short_label, row.proposal_type, row.no_revision, row.lock_until, termId, CYCLE_VERSION, JSON.stringify(row.evidence)]
    );
  }
  return cycles.length;
}

async function saveSyncCursor(client, { instrumentId = null, companyId = null, scopeKey, datasetCode, successDate = null, error = '' }) {
  await client.query(
    `INSERT INTO ops.sync_cursors(instrument_id,company_id,scope_key,dataset_code,last_success_date,last_attempt_at,last_error,retry_count,updated_at)
     VALUES($1,$2,$3,$4,$5::date,now(),$6,CASE WHEN $6='' THEN 0 ELSE 1 END,now())
     ON CONFLICT(scope_key,dataset_code) DO UPDATE SET
       instrument_id=COALESCE(EXCLUDED.instrument_id,ops.sync_cursors.instrument_id),
       company_id=COALESCE(EXCLUDED.company_id,ops.sync_cursors.company_id),
       last_success_date=CASE WHEN EXCLUDED.last_success_date IS NULL THEN ops.sync_cursors.last_success_date
                              ELSE GREATEST(COALESCE(ops.sync_cursors.last_success_date,'1900-01-01'::date),EXCLUDED.last_success_date) END,
       last_attempt_at=now(),last_error=EXCLUDED.last_error,
       retry_count=CASE WHEN EXCLUDED.last_error='' THEN 0 ELSE ops.sync_cursors.retry_count+1 END,updated_at=now()`,
    [instrumentId, companyId, scopeKey, datasetCode, successDate, error]
  );
}

async function saveSyncRawPayload(client, sourceId, datasetCode, sourceKey, businessDate, rows) {
  if (!sourceId || !Array.isArray(rows) || !rows.length) return null;
  const payload = JSON.stringify({ business_date: businessDate, rows });
  const payloadHash = crypto.createHash('sha256').update(payload).digest('hex');
  const { rows: saved } = await client.query(
    `INSERT INTO ops.raw_records(source_id,dataset_code,source_key,source_updated_at,payload,payload_hash)
     VALUES($1,$2,$3,$4::date,$5::jsonb,$6)
     ON CONFLICT(source_id,dataset_code,source_key,payload_hash) DO NOTHING
     RETURNING raw_record_id`,
    [sourceId, datasetCode, sourceKey, businessDate, payload, payloadHash]
  );
  return saved[0] && saved[0].raw_record_id || null;
}

async function insert_fundamental_convertible_bond_holder_positions(params, client = pool) {
  return client.query(`INSERT INTO fundamental.convertible_bond_holder_positions
       (instrument_id,report_date,announced_at,holder_rank,holder_name,holder_name_normalized,holder_type,is_controller_related,hold_amount,hold_ratio,source_id,source_key,raw_payload)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
       ON CONFLICT(source_id,source_key) DO UPDATE SET announced_at=EXCLUDED.announced_at,holder_name=EXCLUDED.holder_name,
         holder_name_normalized=EXCLUDED.holder_name_normalized,holder_type=EXCLUDED.holder_type,hold_amount=EXCLUDED.hold_amount,
         hold_ratio=EXCLUDED.hold_ratio,is_controller_related=EXCLUDED.is_controller_related,raw_payload=EXCLUDED.raw_payload,ingested_at=now()`, params);
}

async function select_fundamental_convertible_bond_holder_positions(params, client = pool) {
  return client.query(`SELECT DISTINCT report_date FROM fundamental.convertible_bond_holder_positions
      WHERE instrument_id=$1 ORDER BY report_date DESC LIMIT 2`, params);
}

async function select_fundamental_convertible_bond_holder_positions_1(params, client = pool) {
  return client.query(`SELECT report_date,announced_at,holder_name,holder_name_normalized,hold_amount,hold_ratio
         FROM fundamental.convertible_bond_holder_positions
        WHERE instrument_id=$1 AND report_date IN ($2::date,$3::date)`, params);
}

async function insert_event_convertible_bond_holder_change_events(params, client = pool) {
  return client.query(`INSERT INTO event.convertible_bond_holder_change_events
         (instrument_id,announced_at,holder_name,holder_name_normalized,change_type,change_amount,change_ratio,
          before_amount,after_amount,before_ratio,after_ratio,is_cleared,change_start_date,change_end_date,source_id,source_key,raw_payload)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)
         ON CONFLICT(source_id,source_key) DO UPDATE SET announced_at=EXCLUDED.announced_at,change_type=EXCLUDED.change_type,
           change_amount=EXCLUDED.change_amount,change_ratio=EXCLUDED.change_ratio,before_amount=EXCLUDED.before_amount,
           after_amount=EXCLUDED.after_amount,before_ratio=EXCLUDED.before_ratio,after_ratio=EXCLUDED.after_ratio,
           is_cleared=EXCLUDED.is_cleared,change_start_date=EXCLUDED.change_start_date,change_end_date=EXCLUDED.change_end_date,
           raw_payload=EXCLUDED.raw_payload`, params);
}

async function insert_fundamental_company_pledge_snapshots(params, client = pool) {
  return client.query(`INSERT INTO fundamental.company_pledge_snapshots
       (company_id,as_of_date,announced_at,pledge_count,pledge_ratio,pledged_shares,unpledged_shares,total_shares,source_id,source_key,raw_payload)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
       ON CONFLICT(source_id,source_key) DO UPDATE SET announced_at=EXCLUDED.announced_at,pledge_ratio=EXCLUDED.pledge_ratio,
         pledge_count=EXCLUDED.pledge_count,pledged_shares=EXCLUDED.pledged_shares,unpledged_shares=EXCLUDED.unpledged_shares,
         total_shares=EXCLUDED.total_shares,raw_payload=EXCLUDED.raw_payload,ingested_at=now()`, params);
}

async function select_fundamental_convertible_bond_issuance(params, client = pool) {
  return client.query(`SELECT i.instrument_id,i.canonical_code AS ts_code,i.name AS bond_name,p.stock_instrument_id,p.bond_short_name,p.par_value,
            p.issue_size,p.remain_size,p.maturity_date,p.current_conv_price,p.conv_start_date,p.conv_end_date,
            p.raw_payload,si.canonical_code AS stock_code,si.name AS stock_name,ci.company_id,
            c.legal_name,(SELECT issue_type FROM fundamental.convertible_bond_issuance iss WHERE iss.instrument_id=i.instrument_id LIMIT 1) AS issue_type,
            dm.trade_date AS market_trade_date,dm.close AS bond_close,dm.conversion_value,dm.ingested_at AS market_ingested_at,
            sb.trade_date AS stock_trade_date,sb.close AS stock_close,sb.ingested_at AS stock_ingested_at,
            sv.trade_date AS valuation_trade_date,sv.pb AS stock_pb,sv.total_market_cap,sv.ingested_at AS valuation_ingested_at,
            td.status AS revision_status,td.matched_days,td.required_days,td.observation_days,td.minimum_future_days AS rolling_remaining_days,
            td.calculated_at AS trigger_calculated_at,
            t.net_asset_floor_applicable,t.term_id
       FROM core.instruments i
       JOIN fundamental.convertible_bond_profiles p ON p.instrument_id=i.instrument_id
       LEFT JOIN core.instruments si ON si.instrument_id=p.stock_instrument_id
       LEFT JOIN core.company_instruments ci ON ci.instrument_id=p.stock_instrument_id AND ci.relation_type='issued_by'
       LEFT JOIN core.companies c ON c.company_id=ci.company_id
       LEFT JOIN LATERAL (SELECT trade_date,close,conversion_value,ingested_at FROM market.convertible_bond_daily_metrics
                           WHERE instrument_id=i.instrument_id AND trade_date <= $2::date ORDER BY trade_date DESC LIMIT 1) dm ON true
       LEFT JOIN LATERAL (SELECT trade_date,close,ingested_at FROM market.daily_bars
                           WHERE instrument_id=p.stock_instrument_id AND trade_date <= $2::date ORDER BY trade_date DESC,source_id DESC LIMIT 1) sb ON true
       LEFT JOIN LATERAL (SELECT trade_date,pb,total_market_cap,ingested_at FROM market.daily_valuations
                           WHERE instrument_id=p.stock_instrument_id AND trade_date=sb.trade_date ORDER BY source_id DESC LIMIT 1) sv ON true
       LEFT JOIN LATERAL (SELECT status,matched_days,required_days,observation_days,minimum_future_days,calculated_at
                            FROM analytics.convertible_bond_trigger_daily
                           WHERE instrument_id=i.instrument_id AND trigger_type='reset' AND formula_version='reset-v2' AND trade_date <= $2::date
                           ORDER BY trade_date DESC LIMIT 1) td ON true
       LEFT JOIN LATERAL (SELECT term_id,net_asset_floor_applicable FROM fundamental.convertible_bond_terms
                           WHERE instrument_id=i.instrument_id AND term_type='reset' AND effective_from <= $2::date
                           ORDER BY effective_from DESC,term_id DESC LIMIT 1) t ON true
      WHERE i.canonical_code=$1`, params);
}

async function select_event_convertible_bond_revision_events(params, client = pool) {
  return client.query(`SELECT event_type,announced_at,meeting_date,effective_date,title,summary,source_url,source_number,updated_at FROM event.convertible_bond_revision_events WHERE instrument_id=$1 AND announced_at <= $2 ORDER BY announced_at,event_id`, params);
}

async function select_analytics_convertible_bond_announcement_history(params, client = pool) {
  return client.query(`SELECT announced_at,valid_until,next_eligible_date,summary FROM analytics.convertible_bond_announcement_history WHERE instrument_id=$1 AND fact_type='no_revision' AND announced_at <= $2 ORDER BY announced_at`, params);
}

async function select_fundamental_convertible_bond_holder_positions_2(params, client = pool) {
  return client.query(`SELECT report_date,announced_at,holder_name,holder_name_normalized,holder_type,hold_amount,hold_ratio,ingested_at FROM fundamental.convertible_bond_holder_positions WHERE instrument_id=$1 AND report_date <= $2 ORDER BY report_date DESC,holder_rank`, params);
}

async function select_fundamental_company_pledge_snapshots(params, client = pool) {
  return client.query(`SELECT as_of_date,announced_at,pledge_ratio,pledged_shares,unpledged_shares,ingested_at FROM fundamental.company_pledge_snapshots WHERE company_id=$1 AND announced_at IS NOT NULL AND announced_at <= $2 ORDER BY as_of_date DESC,announced_at DESC,pledge_id DESC LIMIT 1`, params);
}

async function select_ops_sync_cursors(params, client = pool) {
  return client.query(`SELECT last_success_date,last_attempt_at FROM ops.sync_cursors
      WHERE company_id=$1 AND scope_key=('company:' || $1::text) AND dataset_code='pledge_stat'
        AND COALESCE(last_error,'')='' AND last_success_date <= $2::date
      ORDER BY last_success_date DESC,last_attempt_at DESC LIMIT 1`, params);
}

async function select_core_company_controllers(params, client = pool) {
  return client.query(`SELECT controller_name,controller_type,control_ratio,announced_at FROM core.company_controllers WHERE company_id=$1 AND (announced_at IS NULL OR announced_at <= $2::date) AND (valid_from IS NULL OR valid_from <= $2::date) AND (valid_to IS NULL OR valid_to >= $2::date) ORDER BY is_current DESC,announced_at DESC,controller_id DESC LIMIT 1`, params);
}

async function select_fundamental_financial_reports(params, client = pool) {
  return client.query(`SELECT report_kind,period_end,announced_at,raw_payload,ingested_at FROM fundamental.financial_reports WHERE company_id=$1 AND period_end <= $2::date AND announced_at IS NOT NULL AND announced_at <= $2::date ORDER BY period_end DESC,announced_at DESC,report_id DESC LIMIT 20`, params);
}

async function select_bond_safety_financial_cache(params, client = pool) {
  return client.query(`SELECT data,report_end_date,announced_at,fetched_at FROM bond_safety_financial_cache WHERE ts_code=$1 AND announced_at IS NOT NULL AND announced_at::date <= $2::date ORDER BY fetched_at DESC LIMIT 1`, params);
}

async function select_bond_safety_snapshots(params, client = pool) {
  return client.query(`SELECT data,source_updated_at,refreshed_at FROM bond_safety_snapshots WHERE COALESCE(source_updated_at,refreshed_at)::date <= $1::date ORDER BY id DESC LIMIT 1`, params);
}

async function select_analytics_analysis_snapshots(params, client = pool) {
  return client.query(`SELECT payload FROM analytics.analysis_snapshots WHERE instrument_id=$1 AND snapshot_type='convertible_bond_analysis' AND as_of_date <= $2::date ORDER BY as_of_date DESC,created_at DESC LIMIT 1`, params);
}

async function select_market_daily_bars(params, client = pool) {
  return client.query(`SELECT trade_date,close,volume,amount,ingested_at FROM market.daily_bars WHERE instrument_id=$1 AND trade_date <= $2 ORDER BY trade_date DESC,source_id DESC LIMIT 220`, params);
}

async function select_market_convertible_bond_daily_metrics(params, client = pool) {
  return client.query(`SELECT trade_date,close FROM market.convertible_bond_daily_metrics WHERE instrument_id=$1 AND trade_date <= $2 ORDER BY trade_date DESC LIMIT 120`, params);
}

async function select_event_convertible_bond_revision_events_1(params, client = pool) {
  return client.query(`SELECT date_trunc('month',announced_at)::date AS period,count(*)::int AS count FROM event.convertible_bond_revision_events WHERE announced_at BETWEEN ($1::date - interval '3 years') AND $1::date AND event_type='proposal' GROUP BY 1 ORDER BY 1`, params);
}

async function select_event_convertible_bond_revision_events_2(params, client = pool) {
  return client.query(`SELECT COUNT(*)::int AS count FROM event.convertible_bond_revision_events WHERE instrument_id=$1 AND announced_at BETWEEN ($2::date - interval '90 days') AND $2::date AND event_type='proposal'`, params);
}

async function select_event_convertible_bond_revision_events_3(params, client = pool) {
  return client.query(`SELECT
        COUNT(*) FILTER (WHERE e.announced_at >= $2::date - interval '90 days')::int AS recent_count,
        COUNT(*) FILTER (WHERE e.announced_at >= $2::date - interval '360 days')::int AS year_count
       FROM event.convertible_bond_revision_events e
        JOIN fundamental.convertible_bond_profiles p2 ON p2.instrument_id=e.instrument_id
        JOIN core.company_instruments ci2 ON ci2.instrument_id=p2.stock_instrument_id AND ci2.relation_type='issued_by'
        JOIN core.company_industry_memberships im2 ON im2.company_id=ci2.company_id AND im2.is_current
       WHERE e.instrument_id<>$1 AND e.event_type='proposal' AND e.announced_at BETWEEN ($2::date - interval '360 days') AND $2::date
         AND im2.industry_node_id=(SELECT industry_node_id FROM core.company_industry_memberships WHERE company_id=$1 AND is_current ORDER BY valid_from DESC NULLS LAST LIMIT 1)`, params);
}

async function select_analytics_convertible_bond_trigger_daily(params, client = pool) {
  return client.query(`SELECT trade_date,status,matched_days,required_days,calculated_at
                FROM analytics.convertible_bond_trigger_daily
               WHERE instrument_id=$1 AND trigger_type='reset' AND formula_version='reset-v2' AND data_status='complete' AND trade_date <= $2::date
               ORDER BY trade_date`, params);
}

async function insert_analytics_convertible_bond_revision_motive_daily(params, client = pool) {
  return client.query(`INSERT INTO analytics.convertible_bond_revision_motive_daily
     (instrument_id,trade_date,model_version,motive_score,history_score,pressure_score,conversion_score,governance_score,market_score,maturity_score,
      executability_status,estimated_floor_price,estimated_space,estimated_post_conversion_value,estimated_value_uplift,safety_level,motive_level,classification,
      core_motives,blockers,components,input_snapshot,source_refs,input_data_date,input_hash,completeness_rate,quality_status)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20::jsonb,$21::jsonb,$22::jsonb,$23::jsonb,$24,$25,$26,$27)
     ON CONFLICT(instrument_id,trade_date,model_version) DO UPDATE SET motive_score=EXCLUDED.motive_score,history_score=EXCLUDED.history_score,
       pressure_score=EXCLUDED.pressure_score,conversion_score=EXCLUDED.conversion_score,governance_score=EXCLUDED.governance_score,market_score=EXCLUDED.market_score,
       maturity_score=EXCLUDED.maturity_score,executability_status=EXCLUDED.executability_status,estimated_floor_price=EXCLUDED.estimated_floor_price,
       estimated_space=EXCLUDED.estimated_space,estimated_post_conversion_value=EXCLUDED.estimated_post_conversion_value,estimated_value_uplift=EXCLUDED.estimated_value_uplift,
       safety_level=EXCLUDED.safety_level,motive_level=EXCLUDED.motive_level,classification=EXCLUDED.classification,core_motives=EXCLUDED.core_motives,
       blockers=EXCLUDED.blockers,components=EXCLUDED.components,input_snapshot=EXCLUDED.input_snapshot,source_refs=EXCLUDED.source_refs,input_data_date=EXCLUDED.input_data_date,
       input_hash=EXCLUDED.input_hash,completeness_rate=EXCLUDED.completeness_rate,quality_status=EXCLUDED.quality_status,calculated_at=now()`, params);
}

async function select_market_convertible_bond_daily_metrics_1(params, client = pool) {
  return client.query(`SELECT max(trade_date)::text AS trade_date FROM market.convertible_bond_daily_metrics`);
}

async function select_market_convertible_bond_daily_metrics_2(params, client = pool) {
  return client.query(`SELECT DISTINCT i.canonical_code AS ts_code
       FROM market.convertible_bond_daily_metrics md
       JOIN core.instruments i ON i.instrument_id=md.instrument_id
       JOIN fundamental.convertible_bond_profiles p ON p.instrument_id=i.instrument_id
       JOIN public.bond_unified u ON u.instrument_id=i.instrument_id
       LEFT JOIN fundamental.convertible_bond_issuance iss ON iss.instrument_id=i.instrument_id
       LEFT JOIN LATERAL (
         SELECT max(last_trade_date) AS last_trade_date,
                max(COALESCE(last_conversion_date,last_trade_date)) AS last_conversion_date
           FROM event.convertible_bond_call_events ce
          WHERE ce.instrument_id=i.instrument_id
            AND ce.event_type IN ('exercise','implementation','completion')
       ) call_stop ON true
      WHERE md.trade_date=$1::date AND i.asset_class='convertible_bond' AND i.status='listed' AND u.status='listed'
        AND (p.cb_type IS NULL OR p.cb_type IN ('CB',''))
        AND (u.issue_type IS NULL OR u.issue_type NOT IN ('定向','私募'))
        AND (iss.issue_type IS NULL OR iss.issue_type NOT IN ('定向','私募'))
        AND (i.list_date IS NULL OR i.list_date <= $1::date)
        AND (i.delist_date IS NULL OR i.delist_date > $1::date)
        AND (p.maturity_date IS NULL OR p.maturity_date >= $1::date)
        AND (p.conv_end_date IS NULL OR p.conv_end_date >= $1::date)
        AND (p.conv_stop_date IS NULL OR p.conv_stop_date > $1::date)
        AND (COALESCE(call_stop.last_trade_date,call_stop.last_conversion_date) IS NULL OR COALESCE(call_stop.last_trade_date,call_stop.last_conversion_date) > $1::date)
      ORDER BY i.canonical_code`, params);
}

async function select_core_instruments(params, client = pool) {
  return client.query(`SELECT i.canonical_code AS ts_code,i.name AS bond_name,si.canonical_code AS stock_code,si.name AS stock_name
      FROM core.instruments i JOIN fundamental.convertible_bond_profiles p ON p.instrument_id=i.instrument_id
      LEFT JOIN core.instruments si ON si.instrument_id=p.stock_instrument_id WHERE i.canonical_code=$1 LIMIT 1`, params);
}

async function select_ops_data_sources(params, client = pool) {
  return client.query(`SELECT source_id,source_code FROM ops.data_sources WHERE source_code IN ('tushare','calculated')`);
}

async function select_core_company_controllers_1(params, client = pool) {
  return client.query(`SELECT controller_name FROM core.company_controllers
             WHERE company_id=$1 AND (valid_from IS NULL OR valid_from <= $2::date) AND (valid_to IS NULL OR valid_to >= $2::date)
             ORDER BY is_current DESC,announced_at DESC,controller_id DESC`, params);
}

// 单只转债的动机评分明细（含同业分位）；tradeDate 给出时只取该日快照
async function selectRevisionMotiveDetail({ code, modelVersion, tradeDate = null }) {
  const params = [code, modelVersion];
  let dateClause = '';
  if (tradeDate) { params.push(tradeDate); dateClause = ` AND m.trade_date=$${params.length}::date`; }
  return pool.query(
    `SELECT m.*,i.canonical_code AS ts_code,i.name AS bond_name,p.stock_instrument_id,si.canonical_code AS stock_code,si.name AS stock_name,
            (SELECT count(*) FILTER (WHERE peer.motive_score <= m.motive_score)::numeric / NULLIF(count(*),0)
               FROM analytics.convertible_bond_revision_motive_daily peer
              WHERE peer.trade_date=m.trade_date AND peer.model_version=m.model_version) AS research_percentile
       FROM analytics.convertible_bond_revision_motive_daily m JOIN core.instruments i ON i.instrument_id=m.instrument_id
       JOIN fundamental.convertible_bond_profiles p ON p.instrument_id=i.instrument_id LEFT JOIN core.instruments si ON si.instrument_id=p.stock_instrument_id
      WHERE i.canonical_code=$1 AND m.model_version=$2${dateClause} ORDER BY m.trade_date DESC,m.calculated_at DESC LIMIT 1`, params
  );
}

// 待同步动机输入的转债清单（在市口径 + 抓取优先级排序），limit 给出时限制条数
async function selectRevisionMotiveInputTargets({ date, limit = null }) {
  const limitClause = limit ? ' LIMIT $2' : '';
  const queryParams = limit ? [date, limit] : [date];
  return pool.query(`SELECT p.instrument_id,p.stock_instrument_id,i.canonical_code AS ts_code,i.list_date,
             si.canonical_code AS stock_code,ci.company_id,holder_wm.holder_report_date
      FROM fundamental.convertible_bond_profiles p JOIN core.instruments i ON i.instrument_id=p.instrument_id
      JOIN public.bond_unified u ON u.instrument_id=i.instrument_id
      JOIN market.convertible_bond_daily_metrics md ON md.instrument_id=i.instrument_id
       AND md.trade_date=(SELECT max(trade_date) FROM market.convertible_bond_daily_metrics WHERE trade_date <= $1::date)
      LEFT JOIN core.instruments si ON si.instrument_id=p.stock_instrument_id
      LEFT JOIN core.company_instruments ci ON ci.instrument_id=p.stock_instrument_id AND ci.relation_type='issued_by'
      LEFT JOIN ops.sync_cursors hcur ON hcur.instrument_id=p.instrument_id
       AND hcur.scope_key=('convertible_bond:' || p.instrument_id::text) AND hcur.dataset_code='top10_cb_holders'
      LEFT JOIN ops.sync_cursors pcur ON pcur.company_id=ci.company_id
       AND pcur.scope_key=('company:' || ci.company_id::text) AND pcur.dataset_code='pledge_stat'
      LEFT JOIN LATERAL (
        SELECT max(report_date)::text AS holder_report_date
          FROM fundamental.convertible_bond_holder_positions hpwm
         WHERE hpwm.instrument_id=p.instrument_id
      ) holder_wm ON true
      LEFT JOIN fundamental.convertible_bond_issuance iss ON iss.instrument_id=i.instrument_id
      LEFT JOIN LATERAL (
        SELECT max(last_trade_date) AS last_trade_date,
               max(COALESCE(last_conversion_date,last_trade_date)) AS last_conversion_date
          FROM event.convertible_bond_call_events ce
         WHERE ce.instrument_id=i.instrument_id AND ce.event_type IN ('exercise','implementation','completion')
      ) call_stop ON true
     WHERE i.asset_class='convertible_bond' AND i.status='listed' AND u.status='listed'
       AND (p.cb_type IS NULL OR p.cb_type IN ('CB',''))
       AND (u.issue_type IS NULL OR u.issue_type NOT IN ('定向','私募'))
       AND (iss.issue_type IS NULL OR iss.issue_type NOT IN ('定向','私募'))
       AND (i.list_date IS NULL OR i.list_date <= $1::date)
       AND (i.delist_date IS NULL OR i.delist_date > $1::date)
       AND (p.maturity_date IS NULL OR p.maturity_date >= $1::date)
       AND (p.conv_end_date IS NULL OR p.conv_end_date >= $1::date)
       AND (p.conv_stop_date IS NULL OR p.conv_stop_date > $1::date)
       AND (COALESCE(call_stop.last_trade_date,call_stop.last_conversion_date) IS NULL OR COALESCE(call_stop.last_trade_date,call_stop.last_conversion_date) > $1::date)
     ORDER BY CASE WHEN EXISTS (
                SELECT 1 FROM fundamental.convertible_bond_holder_positions hp
                 WHERE hp.instrument_id=p.instrument_id
              ) THEN 1 ELSE 0 END,
              CASE WHEN hcur.last_attempt_at IS NULL THEN 0 ELSE 1 END,
              hcur.last_attempt_at ASC NULLS FIRST,
              CASE WHEN ci.company_id IS NULL OR EXISTS (
                SELECT 1 FROM fundamental.company_pledge_snapshots cps
                 WHERE cps.company_id=ci.company_id
              ) THEN 1 ELSE 0 END,
              CASE WHEN pcur.last_attempt_at IS NULL THEN 0 ELSE 1 END,
              pcur.last_attempt_at ASC NULLS FIRST,
              i.canonical_code${limitClause}`, queryParams);
}

module.exports = {
  saveRevisionCycles,
  saveSyncCursor,
  selectRevisionMotiveDetail,
  selectRevisionMotiveInputTargets,
  saveSyncRawPayload,
  insert_fundamental_convertible_bond_holder_positions,
  select_fundamental_convertible_bond_holder_positions,
  select_fundamental_convertible_bond_holder_positions_1,
  insert_event_convertible_bond_holder_change_events,
  insert_fundamental_company_pledge_snapshots,
  select_fundamental_convertible_bond_issuance,
  select_event_convertible_bond_revision_events,
  select_analytics_convertible_bond_announcement_history,
  select_fundamental_convertible_bond_holder_positions_2,
  select_fundamental_company_pledge_snapshots,
  select_ops_sync_cursors,
  select_core_company_controllers,
  select_fundamental_financial_reports,
  select_bond_safety_financial_cache,
  select_bond_safety_snapshots,
  select_analytics_analysis_snapshots,
  select_market_daily_bars,
  select_market_convertible_bond_daily_metrics,
  select_event_convertible_bond_revision_events_1,
  select_event_convertible_bond_revision_events_2,
  select_event_convertible_bond_revision_events_3,
  select_analytics_convertible_bond_trigger_daily,
  insert_analytics_convertible_bond_revision_motive_daily,
  select_market_convertible_bond_daily_metrics_1,
  select_market_convertible_bond_daily_metrics_2,
  select_core_instruments,
  select_ops_data_sources,
  select_core_company_controllers_1,
};

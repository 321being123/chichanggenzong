'use strict';

function listCandidates(executor, fromDate, upper) {
  return executor(`
    SELECT h.security_code,h.security_name,h.instrument_id,h.ipo_status,
           (CASE WHEN h.listing_at IS NOT NULL THEN h.listing_at::date
                 WHEN h.listing_date ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN h.listing_date::date END)::text AS listing_date,
           h.offer_open_at,h.offer_close_at,h.issue_price_final,h.issue_price_low,h.issue_price_high,
           h.public_offer_ratio,h.international_offer_ratio,h.lot_size_shares,h.data_completeness,h.source_documents
           ,h.online_lottery_rate,h.industry,h.board_key,h.application_fee_hkd,h.brokerage_fee_hkd
      FROM public.ipo_history h
     WHERE h.market_code='HK'
       AND (h.listing_at::date BETWEEN $1::date AND $2::date
            OR (h.listing_at IS NULL AND h.listing_date ~ '^\\d{4}-\\d{2}-\\d{2}$' AND h.listing_date::date BETWEEN $1::date AND $2::date))
       AND COALESCE(h.ipo_status,'active')='listed'
     ORDER BY listing_date,h.security_code`, [fromDate, upper]);
}

function listBars(executor, ids, toDate) {
  return executor(`
    SELECT DISTINCT ON (instrument_id,trade_date) instrument_id,trade_date::text AS trade_date,close
      FROM market.daily_bars
     WHERE instrument_id=ANY($1::bigint[])
       AND trade_date <= $2::date
     ORDER BY instrument_id,trade_date,source_id DESC`, [ids, toDate]);
}

function listOpenDates(executor, fromDate, toDate) {
  return executor(`
    SELECT trade_date::text AS trade_date
      FROM market.trade_calendar
     WHERE exchange='HKEX' AND is_open
       AND trade_date BETWEEN $1::date AND $2::date
     ORDER BY trade_date`, [fromDate, toDate]);
}


function findCalculatedSource(executor, ...args) { return executor("SELECT source_id FROM ops.data_sources WHERE source_code='calculated' LIMIT 1", ...args); }

function startConfigRun(executor, ...args) { return executor(`INSERT INTO ops.ingestion_runs(source_id,dataset_code,request_range,status,row_count)
     VALUES($1,'hk_ipo_model_config',$2::jsonb,'running',0) RETURNING run_id`, ...args); }

function saveConfigRecord(executor, ...args) { return executor(`INSERT INTO ops.raw_records(run_id,source_id,dataset_code,source_key,source_updated_at,payload,payload_hash)
       VALUES($1,$2,'hk_ipo_model_config',$3,now(),$4::jsonb,$5)
       ON CONFLICT(source_id,dataset_code,source_key,payload_hash) DO UPDATE SET run_id=EXCLUDED.run_id,ingested_at=now()`, ...args); }

function completeConfigRun(executor, ...args) { return executor(`UPDATE ops.ingestion_runs SET status='succeeded',row_count=1,finished_at=now() WHERE run_id=$1`, ...args); }

function failConfigRun(executor, ...args) { return executor(`UPDATE ops.ingestion_runs SET status='failed',error_message=$2,finished_at=now() WHERE run_id=$1`, ...args); }

function listProbeRuns(executor, ...args) { return executor(`
    WITH run_stats AS (
      SELECT ir.run_id,ir.request_range->>'environment' AS environment,
             (ir.started_at AT TIME ZONE 'Asia/Shanghai')::date AS observed_date,
             COUNT(rr.raw_record_id)::int AS target_count,
             COUNT(*) FILTER (WHERE rr.payload->>'responseSha256' ~ '^[0-9a-fA-F]{64}$')::int AS valid_targets,
             COUNT(*) FILTER (WHERE rr.payload->>'parserStatus'='parsed')::int AS parsed_targets
        FROM ops.ingestion_runs ir
        LEFT JOIN ops.raw_records rr ON rr.run_id=ir.run_id AND rr.dataset_code='hkex_ipo_probe'
       WHERE ir.dataset_code='hkex_ipo_probe' AND ir.status='succeeded'
       GROUP BY ir.run_id,ir.request_range->>'environment',ir.started_at
    )
    SELECT environment,observed_date::text AS observed_date,target_count,valid_targets,parsed_targets,
           (target_count > 0 AND valid_targets=target_count) AS stable
      FROM run_stats
     ORDER BY observed_date`, ...args); }

function listProbeCalendar(executor, ...args) { return executor(`
      SELECT trade_date::text AS trade_date
        FROM market.trade_calendar
       WHERE exchange='HKEX' AND is_open
         AND trade_date BETWEEN $1::date AND $2::date
       ORDER BY trade_date`, ...args); }

function saveBacktest(executor, ...args) { return executor(`INSERT INTO analytics.hk_ipo_backtests
      (model_version,from_date,to_date,candidate_count,eligible_count,test_count,first_day_coverage,five_day_coverage,
       metrics,windows,gate_status,gate_reasons,input_hash,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12::jsonb,$13,now())`, ...args); }

function findLatestGate(executor, ...args) { return executor(`SELECT gate_status,gate_reasons,metrics,model_version,created_at
    FROM analytics.hk_ipo_backtests ORDER BY created_at DESC LIMIT 1`, ...args); }

function saveFormalRecommendation(executor, ...args) { return executor(`
    INSERT INTO analytics.ipo_recommendation_snapshots(
      instrument_id,market_code,stage,as_of_date,model_version,score,advice,risk_flags,input_completeness,
      data_as_of,published_at,is_stale,stale_reason,raw_payload,created_at,updated_at
    ) VALUES($1,'HK','formal',$2::date,$3,$4,$5,$6::jsonb,$7::jsonb,$8::date,now(),false,'',$9::jsonb,now(),now())
    ON CONFLICT(instrument_id,stage,as_of_date,model_version) DO UPDATE SET
      score=EXCLUDED.score,advice=EXCLUDED.advice,risk_flags=EXCLUDED.risk_flags,input_completeness=EXCLUDED.input_completeness,
      data_as_of=EXCLUDED.data_as_of,published_at=EXCLUDED.published_at,is_stale=false,stale_reason='',raw_payload=EXCLUDED.raw_payload,updated_at=now()
    RETURNING snapshot_id`, ...args); }

module.exports = { listCandidates, listBars, listOpenDates, findCalculatedSource, startConfigRun, saveConfigRecord, completeConfigRun, failConfigRun, listProbeRuns, listProbeCalendar, saveBacktest, findLatestGate, saveFormalRecommendation };

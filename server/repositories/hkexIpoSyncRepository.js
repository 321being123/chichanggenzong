const { pool } = require('../db/connection');

// 自 server/services/hkexIpoSync.js 抽取的 SQL 执行函数：语句原样搬迁，返回 pg 原始结果（rows/rowCount），调用方零改动。
async function select_ops_data_sources(params, client = pool) {
  return client.query(`SELECT source_id FROM ops.data_sources WHERE source_code='hkex_announcements' LIMIT 1`);
}

async function insert_ops_ingestion_runs(params, client = pool) {
  return client.query(`INSERT INTO ops.ingestion_runs(source_id,dataset_code,request_range,status)
     VALUES($1,'hkex_ipo_history_report',$2::jsonb,'running') RETURNING run_id`, params);
}

async function insert_ops_raw_records(params, client = pool) {
  return client.query(`INSERT INTO ops.raw_records(run_id,source_id,dataset_code,source_key,source_updated_at,payload,payload_hash)
         VALUES($1,$2,'hkex_ipo_history_report',$3,now(),$4::jsonb,$5)
         ON CONFLICT(source_id,dataset_code,source_key,payload_hash) DO UPDATE SET run_id=EXCLUDED.run_id,ingested_at=now()`, params);
}

async function update_ops_ingestion_runs(params, client = pool) {
  return client.query(`UPDATE ops.ingestion_runs SET status=$2,row_count=$3,error_message=$4,finished_at=now() WHERE run_id=$1`, params);
}

async function update_ops_ingestion_runs_1(params, client = pool) {
  return client.query(`UPDATE ops.ingestion_runs SET status='failed',error_message=$2,finished_at=now() WHERE run_id=$1`, params);
}


function syncHkexPricingFactsLayerQuery1(executor, parts, ...args) { return executor(`SELECT security_code,issue_price_low,issue_price_high,issue_price_final,source_documents,
    data_completeness#>>'{prospectus,expectedEvents,pricingDate,date}' AS expected_pricing
    FROM public.ipo_history WHERE market_code='HK' AND issue_price_final IS NULL
      AND ipo_status NOT IN ('cancelled','canceled','postponed','introduction','gem_transfer','de_spac')
      AND COALESCE(data_completeness->>'exclusionReason','') <> 'rights_issue'
      AND data_completeness#>>'{prospectus,expectedEvents,pricingDate,date}' <= $1
      AND (cardinality($2::text[])=0 OR security_code=ANY($2::text[]))`, ...args); }

function syncHkexPricingFactsLayerQuery2(executor, parts, ...args) { return executor("SELECT source_id FROM ops.data_sources WHERE source_code='hkex_announcements' LIMIT 1", ...args); }

function syncHkexPricingFactsLayerQuery3(executor, parts, ...args) { return executor(`WITH saved AS (INSERT INTO ops.raw_records(source_id,dataset_code,source_key,payload,payload_hash)
        VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT(source_id,dataset_code,source_key,payload_hash) DO UPDATE SET payload=EXCLUDED.payload RETURNING raw_record_id)
        UPDATE public.ipo_history SET issue_price_final=$7,pricing_at=COALESCE($8::timestamptz,pricing_at),
          source_documents=$9::jsonb,ipo_status=CASE WHEN ipo_status='active' THEN 'priced' ELSE ipo_status END,updated_at=now()
        WHERE security_code=$6 AND EXISTS(SELECT 1 FROM saved)`, ...args); }

function syncHkexAllotmentFactsLayerQuery1(executor, parts, ...args) { return executor("SELECT source_id FROM ops.data_sources WHERE source_code='hkex_announcements' LIMIT 1", ...args); }

function syncHkexAllotmentFactsLayerQuery2(executor, parts, ...args) { return executor(`
    SELECT security_code,listing_at::date::text AS listing_date,to_char(allotment_at,'YYYY-MM-DD') AS allotment_date,
           lot_size_shares,online_lottery_rate,lot_amount_hkd,application_fee_hkd,brokerage_fee_hkd,
           oversubscribe_multiple,greenshoe_details,source_documents,data_completeness
      FROM public.ipo_history
     WHERE market_code='HK'
       AND COALESCE(ipo_status,'active') NOT IN ('introduction','gem_transfer','de_spac','cancelled','canceled','postponed')
       AND COALESCE(data_completeness->>'exclusionReason','') <> 'rights_issue'
       ${parts[0]}
       AND (
         $${parts[1]}::boolean
         OR (
           (public_offer_ratio IS NULL OR international_offer_ratio IS NULL)
           AND NOT EXISTS (
             SELECT 1
              FROM jsonb_array_elements(COALESCE(source_documents,'[]'::jsonb)) document
             WHERE document->>'type'='allotment_result'
                AND document->'parserEvidence'->>'lotteryParserStatus'='parsed'
                AND (
                  document->'parserEvidence'->>'parserStatus'='incomplete'
                  OR (
                    document->'parserEvidence'->>'parserStatus' IS NULL
                    AND document->'parserEvidence'->>'oneLotSuccessRate' IS NOT NULL
                  )
                )
           )
         )
         OR (
         online_lottery_rate IS NULL
           AND NOT EXISTS (
             SELECT 1
               FROM jsonb_array_elements(COALESCE(source_documents,'[]'::jsonb)) document
              WHERE document->>'type'='allotment_result'
                AND document->'parserEvidence'->>'lotteryParserStatus'='missing'
           )
         )
         OR (
         (lot_amount_hkd IS NULL OR application_fee_hkd IS NULL OR brokerage_fee_hkd IS NULL)
           AND NOT EXISTS (
             SELECT 1
               FROM jsonb_array_elements(COALESCE(source_documents,'[]'::jsonb)) document
              WHERE document->>'type'='allotment_result'
                AND document->'parserEvidence'->>'feeParserVersion'=$${parts[2]}
                AND document->'parserEvidence'->>'feeParserStatus' IN ('parsed','missing')
           )
         )
         OR (
           oversubscribe_multiple IS NULL
           AND NOT EXISTS (
             SELECT 1
               FROM jsonb_array_elements(COALESCE(source_documents,'[]'::jsonb)) document
              WHERE document->>'type'='allotment_result'
                AND document->'parserEvidence'->>'factsParserVersion'=$${parts[3]}
                AND document->'parserEvidence'->>'oversubscriptionParserStatus' IN ('parsed','missing')
           )
         )
         OR (
           (greenshoe_details IS NULL OR greenshoe_details='{}'::jsonb)
           AND NOT EXISTS (
             SELECT 1
               FROM jsonb_array_elements(COALESCE(source_documents,'[]'::jsonb)) document
              WHERE document->>'type'='allotment_result'
                AND document->'parserEvidence'->>'factsParserVersion'=$${parts[4]}
                AND document->'parserEvidence'->>'greenshoeParserStatus' IN ('parsed','missing')
           )
         )
         OR (
           greenshoe_details->>'overAllocatedShares' IS NOT NULL
           AND COALESCE(greenshoe_details->>'publicOfferSharesBasis','initial_public_offer') = 'initial_public_offer'
         )
         OR (pricing_at IS NULL AND EXISTS (
           SELECT 1 FROM jsonb_array_elements(COALESCE(source_documents,'[]'::jsonb)) document
            WHERE document->>'type'='allotment_result'
              AND document->'parserEvidence'->>'actualPricingDateStatus'='unresolved'
         ))
         OR ((pricing_at IS NULL OR issue_price_final IS NULL) AND NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements(COALESCE(source_documents,'[]'::jsonb)) document
            WHERE document->>'type'='allotment_result'
              AND document->'parserEvidence'->>'factsParserVersion'=$${parts[5]}
         ))
       )
       ${parts[6]}
     ORDER BY CASE WHEN listing_at IS NULL THEN 0 ELSE 1 END,
              COALESCE(listing_at,NULLIF(updated_at,'')::timestamptz) DESC,security_code
     ${parts[7]}`, ...args); }

function syncHkexAllotmentFactsLayerQuery3(executor, parts, ...args) { return executor(`INSERT INTO ops.ingestion_runs(source_id,dataset_code,request_range,status)
     VALUES($1,$2,$3::jsonb,'running') RETURNING run_id`, ...args); }

function syncHkexAllotmentFactsLayerQuery4(executor, parts, ...args) { return executor(`INSERT INTO ops.raw_records(run_id,source_id,dataset_code,source_key,source_updated_at,payload,payload_hash)
           VALUES($1,$2,$3,$4,now(),$5::jsonb,$6)
           ON CONFLICT(source_id,dataset_code,source_key,payload_hash) DO UPDATE SET run_id=EXCLUDED.run_id,ingested_at=now(),payload=EXCLUDED.payload`, ...args); }

function syncHkexNonPublicListingsLayerQuery1(executor, parts, ...args) { return executor("SELECT source_id FROM ops.data_sources WHERE source_code='hkex_announcements' LIMIT 1", ...args); }

function syncHkexNonPublicListingsLayerQuery2(executor, parts, ...args) { return executor(`
    SELECT security_code,listing_at::date::text AS listing_date,source_documents,data_completeness,instrument_id
      FROM public.ipo_history
     WHERE market_code='HK' AND ipo_status='listed'
       AND listing_at::date BETWEEN $1::date AND $2::date
       AND security_code=ANY($3::text[])
     ORDER BY listing_at,security_code`, ...args); }

function syncHkexNonPublicListingsLayerQuery3(executor, parts, ...args) { return executor(`INSERT INTO ops.ingestion_runs(source_id,dataset_code,request_range,status)
     VALUES($1,$2,$3::jsonb,'running') RETURNING run_id`, ...args); }

function syncHkexNonPublicListingsLayerQuery4(executor, parts, ...args) { return executor(`INSERT INTO ops.raw_records(run_id,source_id,dataset_code,source_key,source_updated_at,payload,payload_hash)
           VALUES($1,$2,$3,$4,now(),$5::jsonb,$6)
           ON CONFLICT(source_id,dataset_code,source_key,payload_hash) DO UPDATE SET run_id=EXCLUDED.run_id,ingested_at=now()`, ...args); }

function syncHkexListingStatusNoticesLayerQuery1(executor, parts, ...args) { return executor("SELECT source_id FROM ops.data_sources WHERE source_code='hkex_announcements' LIMIT 1", ...args); }

function syncHkexListingStatusNoticesLayerQuery2(executor, parts, ...args) { return executor(`
    SELECT security_code,security_name,instrument_id,offer_open_at,
           to_char(timezone('Asia/Shanghai',offer_open_at),'YYYY-MM-DD') AS offer_open_date,
           source_documents,data_completeness
      FROM public.ipo_history
     WHERE market_code='HK'
       AND ipo_status IN ('active','priced','allotted','postponed')
       AND allotment_at IS NULL
       AND offer_open_at::date BETWEEN $1::date AND $2::date
       ${parts[0]}
     ORDER BY offer_open_at DESC,security_code
     ${parts[1]}`, ...args); }

function syncHkexListingStatusNoticesLayerQuery3(executor, parts, ...args) { return executor(`INSERT INTO ops.ingestion_runs(source_id,dataset_code,request_range,status)
     VALUES($1,$2,$3::jsonb,'running') RETURNING run_id`, ...args); }

function syncHkexListingStatusNoticesLayerQuery4(executor, parts, ...args) { return executor(`INSERT INTO ops.raw_records(run_id,source_id,dataset_code,source_key,source_updated_at,payload,payload_hash)
           VALUES($1,$2,$3,$4,now(),$5::jsonb,$6)
           ON CONFLICT(source_id,dataset_code,source_key,payload_hash) DO UPDATE SET run_id=EXCLUDED.run_id,ingested_at=now()`, ...args); }

function syncHkexProspectusFactsLayerQuery1(executor, parts, ...args) { return executor("SELECT source_id FROM ops.data_sources WHERE source_code='hkex_announcements' LIMIT 1", ...args); }

function syncHkexProspectusFactsLayerQuery2(executor, parts, ...args) { return executor(`
    SELECT security_code,timezone('Asia/Shanghai',listing_at)::date::text AS actual_listing_date,listing_date,ipo_date,source_documents,data_completeness,
           issue_price_low,issue_price_high,issue_price_final,lot_size_shares,offer_open_at,offer_close_at,pricing_at,allotment_at
     FROM public.ipo_history
     WHERE market_code='HK'
       AND COALESCE(ipo_status,'active') NOT IN ('introduction','gem_transfer','de_spac','cancelled','canceled','postponed')
       AND COALESCE(data_completeness->>'exclusionReason','') <> 'rights_issue'
       AND data_completeness#>>'{prospectus,status}' IS DISTINCT FROM 'not_applicable'
       AND NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(COALESCE(source_documents,'[]'::jsonb)) document
          WHERE lower(COALESCE(document->>'title','') || ' ' || COALESCE(document->>'shortText',''))
                ~ '(rights[ _-]?issue|供股|配售|placing|share option|special purpose)'
       )
       ${parts[0]}
       ${parts[1]}
       AND (
         ${parts[2]}
         OR
         (issue_price_low IS NULL AND data_completeness#>>'{prospectus,fields,issuePriceLow}' IS DISTINCT FROM 'maximum_only')
         OR issue_price_high IS NULL OR lot_size_shares IS NULL OR offer_open_at IS NULL OR offer_close_at IS NULL
         OR data_completeness#>>'{prospectus,expectedEvents,pricingDate,status}' IS NULL
         OR data_completeness#>>'{prospectus,expectedEvents,allotmentDate,status}' IS NULL
         OR data_completeness#>>'{prospectus,expectedEvents,listingDate,status}' IS NULL
         OR (data_completeness#>>'{prospectus,expectedEvents,pricingDate,date}')::date <= (timezone('Asia/Shanghai',now()))::date
         OR (data_completeness#>>'{prospectus,expectedEvents,allotmentDate,date}')::date <= (timezone('Asia/Shanghai',now()))::date
         OR (data_completeness#>>'{prospectus,expectedEvents,listingDate,date}')::date <= (timezone('Asia/Shanghai',now()))::date
         OR (data_completeness#>>'{prospectus,fields,issuePriceType}'='range' AND issue_price_low=issue_price_high)
         OR (offer_close_at IS NOT NULL AND offer_close_at::date < (timezone('Asia/Shanghai',now()))::date AND (
           (pricing_at IS NULL AND (data_completeness#>>'{prospectus,expectedEvents,pricingDate,date}' IS NULL
             OR (data_completeness#>>'{prospectus,expectedEvents,pricingDate,date}')::date <= (timezone('Asia/Shanghai',now()))::date))
           OR (issue_price_final IS NULL AND (data_completeness#>>'{prospectus,expectedEvents,pricingDate,date}' IS NULL
             OR (data_completeness#>>'{prospectus,expectedEvents,pricingDate,date}')::date <= (timezone('Asia/Shanghai',now()))::date))
           OR (allotment_at IS NULL AND (data_completeness#>>'{prospectus,expectedEvents,allotmentDate,date}' IS NULL
             OR (data_completeness#>>'{prospectus,expectedEvents,allotmentDate,date}')::date <= (timezone('Asia/Shanghai',now()))::date))
         ))
         OR (data_completeness#>>'{prospectus,expectedEvents,listingDate,date}' IS NULL
             AND timezone('Asia/Shanghai',offer_close_at)::date < (timezone('Asia/Shanghai',now()))::date
             AND listing_at IS NULL AND (listing_date IS NULL OR listing_date !~ '^\\d{4}-\\d{2}-\\d{2}$'))
         OR ($${parts[3]}::boolean AND NOT EXISTS (
           SELECT 1
             FROM jsonb_array_elements(COALESCE(source_documents,'[]'::jsonb)) document
            WHERE document->>'type'='prospectus'
              AND document->'parserEvidence'->>'sponsorGroup' IS NOT NULL
         ))
       )
       ${parts[4]}
     -- 先重试已有招股书证据但字段不完整的记录，避免每轮都被无公开招股书的项目占满额度。
     ORDER BY CASE WHEN EXISTS (
                SELECT 1 FROM jsonb_array_elements(COALESCE(source_documents,'[]'::jsonb)) document
                 WHERE document->>'type'='prospectus'
              ) THEN 0
              WHEN data_completeness#>>'{prospectus,status}'='retryable'
                AND (data_completeness#>>'{prospectus,next_retry_at}')::timestamptz <= now() THEN 1
              ELSE 2 END,
              listing_at,security_code
     ${parts[5]}`, ...args); }

function syncHkexProspectusFactsLayerQuery3(executor, parts, ...args) { return executor(`INSERT INTO ops.ingestion_runs(source_id,dataset_code,request_range,status)
     VALUES($1,$2,$3::jsonb,'running') RETURNING run_id`, ...args); }

function syncHkexProspectusFactsLayerQuery4(executor, parts, ...args) { return executor(`SELECT payload FROM ops.raw_records
             WHERE source_id=$1 AND dataset_code=$2 AND source_key=$3
               AND payload#>>'{parser,parserVersion}'='hk-ipo-prospectus-v7'
               AND payload#>>'{parser,parserStatus}'='parsed'
             ORDER BY ingested_at DESC LIMIT 1`, ...args); }

function syncHkexProspectusFactsLayerQuery5(executor, parts, ...args) { return executor(`INSERT INTO ops.raw_records(run_id,source_id,dataset_code,source_key,source_updated_at,payload,payload_hash)
             VALUES($1,$2,$3,$4,now(),$5::jsonb,$6)
             ON CONFLICT(source_id,dataset_code,source_key,payload_hash) DO UPDATE SET run_id=EXCLUDED.run_id,ingested_at=now(),payload=EXCLUDED.payload`, ...args); }

module.exports = {
  syncHkexPricingFactsLayerQuery1, syncHkexPricingFactsLayerQuery2, syncHkexPricingFactsLayerQuery3, syncHkexAllotmentFactsLayerQuery1, syncHkexAllotmentFactsLayerQuery2, syncHkexAllotmentFactsLayerQuery3, syncHkexAllotmentFactsLayerQuery4, syncHkexNonPublicListingsLayerQuery1, syncHkexNonPublicListingsLayerQuery2, syncHkexNonPublicListingsLayerQuery3, syncHkexNonPublicListingsLayerQuery4, syncHkexListingStatusNoticesLayerQuery1, syncHkexListingStatusNoticesLayerQuery2, syncHkexListingStatusNoticesLayerQuery3, syncHkexListingStatusNoticesLayerQuery4, syncHkexProspectusFactsLayerQuery1, syncHkexProspectusFactsLayerQuery2, syncHkexProspectusFactsLayerQuery3, syncHkexProspectusFactsLayerQuery4, syncHkexProspectusFactsLayerQuery5,
  select_ops_data_sources,
  insert_ops_ingestion_runs,
  insert_ops_raw_records,
  update_ops_ingestion_runs,
  update_ops_ingestion_runs_1,
};

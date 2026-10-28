const { pool } = require('../db/connection');

// 自 server/services/hkexIpoFacts.js 抽取的 SQL 执行函数：语句原样搬迁，返回 pg 原始结果（rows/rowCount），调用方零改动。
async function select_ops_data_sources(params, client = pool) {
  return client.query(`SELECT source_id FROM ops.data_sources WHERE source_code=$1 LIMIT 1`, params);
}

async function insert_public_ipo_history(params, client = pool) {
  return client.query(`
        INSERT INTO public.ipo_history(
          security_code,security_name,market_type,listing_date,ipo_date,market_code,instrument_id,ipo_status,
          offer_open_at,offer_close_at,pricing_at,allotment_at,listing_at,issue_price_low,issue_price_high,
          issue_price_final,lot_size_shares,lot_amount_hkd,application_fee_hkd,brokerage_fee_hkd,
          public_offer_ratio,international_offer_ratio,cornerstone_details,greenshoe_details,source_documents,
          data_completeness,facts_published_at,updated_at,security_name_cn
        ) VALUES($1,$2,$3,$4,$5,'HK',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb,$23::jsonb,$24::jsonb,$25::jsonb,
          CASE WHEN $4::text IS NOT NULL OR $8::timestamptz IS NOT NULL OR $9::timestamptz IS NOT NULL OR $10::timestamptz IS NOT NULL OR $11::timestamptz IS NOT NULL OR $12::timestamptz IS NOT NULL OR $15::numeric IS NOT NULL OR $16::numeric IS NOT NULL THEN now() END,
          to_char(now(),'YYYY-MM-DD HH24:MI:SS'),$26)
        ON CONFLICT(security_code) DO UPDATE SET
          security_name=COALESCE(NULLIF(EXCLUDED.security_name,''),ipo_history.security_name),
          security_name_cn=COALESCE(NULLIF(EXCLUDED.security_name_cn,''),ipo_history.security_name_cn),
          market_type=COALESCE(EXCLUDED.market_type,ipo_history.market_type),listing_date=COALESCE(EXCLUDED.listing_date,ipo_history.listing_date),
          ipo_date=COALESCE(EXCLUDED.ipo_date,ipo_history.ipo_date),market_code='HK',instrument_id=EXCLUDED.instrument_id,
          ipo_status=CASE
            WHEN ipo_history.ipo_status IN ('introduction','gem_transfer','de_spac','cancelled','canceled','postponed') THEN ipo_history.ipo_status
            WHEN EXCLUDED.ipo_status='active' AND ipo_history.ipo_status IN ('priced','allotted','listed') THEN ipo_history.ipo_status
            ELSE EXCLUDED.ipo_status
          END,
          offer_open_at=COALESCE(EXCLUDED.offer_open_at,ipo_history.offer_open_at),
          offer_close_at=COALESCE(EXCLUDED.offer_close_at,ipo_history.offer_close_at),pricing_at=COALESCE(EXCLUDED.pricing_at,ipo_history.pricing_at),
          allotment_at=COALESCE(EXCLUDED.allotment_at,ipo_history.allotment_at),listing_at=COALESCE(EXCLUDED.listing_at,ipo_history.listing_at),
          issue_price_low=CASE WHEN ipo_history.data_completeness#>>'{prospectus,fields,issuePriceType}'='range'
            AND ipo_history.issue_price_low<ipo_history.issue_price_high THEN ipo_history.issue_price_low
            ELSE COALESCE(EXCLUDED.issue_price_low,ipo_history.issue_price_low) END,
          issue_price_high=CASE WHEN ipo_history.data_completeness#>>'{prospectus,fields,issuePriceType}'='range'
            AND ipo_history.issue_price_low<ipo_history.issue_price_high THEN ipo_history.issue_price_high
            ELSE COALESCE(EXCLUDED.issue_price_high,ipo_history.issue_price_high) END,
          issue_price_final=COALESCE(EXCLUDED.issue_price_final,ipo_history.issue_price_final),lot_size_shares=COALESCE(EXCLUDED.lot_size_shares,ipo_history.lot_size_shares),
          lot_amount_hkd=COALESCE(EXCLUDED.lot_amount_hkd,ipo_history.lot_amount_hkd),application_fee_hkd=COALESCE(EXCLUDED.application_fee_hkd,ipo_history.application_fee_hkd),
          brokerage_fee_hkd=COALESCE(EXCLUDED.brokerage_fee_hkd,ipo_history.brokerage_fee_hkd),public_offer_ratio=COALESCE(EXCLUDED.public_offer_ratio,ipo_history.public_offer_ratio),
          international_offer_ratio=COALESCE(EXCLUDED.international_offer_ratio,ipo_history.international_offer_ratio),cornerstone_details=ipo_history.cornerstone_details || EXCLUDED.cornerstone_details,
          greenshoe_details=ipo_history.greenshoe_details || EXCLUDED.greenshoe_details,
          source_documents=(
            SELECT COALESCE(jsonb_agg(DISTINCT document), '[]'::jsonb)
              FROM jsonb_array_elements(COALESCE(ipo_history.source_documents,'[]'::jsonb) || COALESCE(EXCLUDED.source_documents,'[]'::jsonb)) AS document
          ),
          data_completeness=COALESCE(ipo_history.data_completeness,'{}'::jsonb) || COALESCE(EXCLUDED.data_completeness,'{}'::jsonb),
          facts_published_at=CASE
            WHEN EXCLUDED.listing_date IS NOT NULL OR EXCLUDED.offer_open_at IS NOT NULL
              OR EXCLUDED.offer_close_at IS NOT NULL OR EXCLUDED.pricing_at IS NOT NULL
              OR EXCLUDED.allotment_at IS NOT NULL OR EXCLUDED.issue_price_final IS NOT NULL
              OR EXCLUDED.lot_size_shares IS NOT NULL THEN now()
            ELSE ipo_history.facts_published_at
          END,
          updated_at=to_char(now(),'YYYY-MM-DD HH24:MI:SS')`, params);
}

async function insert_event_instrument_events(params, client = pool) {
  return client.query(`INSERT INTO event.instrument_events(instrument_id,event_type,event_date,event_at,source_id,source_key,details,source_updated_at)
          VALUES($1,$2,$3::date,$3::date,$4,$5,$6::jsonb,now())
          ON CONFLICT(source_id,source_key) DO UPDATE SET event_date=EXCLUDED.event_date,event_at=EXCLUDED.event_at,details=EXCLUDED.details,updated_at=now()`, params);
}


function persistHkexProbeLayerQuery1(executor, parts, ...args) { return executor("SELECT source_id FROM ops.data_sources WHERE source_code='hkex_announcements' LIMIT 1", ...args); }

function persistHkexProbeLayerQuery2(executor, parts, ...args) { return executor(`INSERT INTO ops.ingestion_runs(source_id,dataset_code,request_range,status,row_count,error_message,finished_at)
     VALUES($1,'hkex_ipo_probe',$2::jsonb,$3,$4,$5,now()) RETURNING run_id`, ...args); }

function persistHkexProbeLayerQuery3(executor, parts, ...args) { return executor(`INSERT INTO ops.raw_records(run_id,source_id,dataset_code,source_key,source_updated_at,payload,payload_hash)
       SELECT $1,$2,'hkex_ipo_probe',x.source_key,now(),x.payload,md5(x.payload::text)
         FROM jsonb_to_recordset($3::jsonb) AS x(source_key text,payload jsonb)
       ON CONFLICT(source_id,dataset_code,source_key,payload_hash) DO NOTHING`, ...args); }

function readHkIpoCompletenessLayerQuery1(executor, parts, ...args) { return executor(`SELECT security_code,ipo_status,offer_open_at,offer_close_at,pricing_at,allotment_at,
    listing_at,listing_date,issue_price_low,issue_price_high,issue_price_final,lot_size_shares,source_documents,data_completeness
    FROM public.ipo_history WHERE market_code='HK'`, ...args); }

function recomputeHkIpoCompletenessLayerQuery1(executor, parts, ...args) { return executor(`
    SELECT security_code,ipo_status,offer_open_at,offer_close_at,pricing_at,allotment_at,listing_at,listing_date,
           issue_price_low,issue_price_high,issue_price_final,lot_size_shares,source_documents,data_completeness
      FROM public.ipo_history
     WHERE market_code='HK'
       ${parts[0]}
  `, ...args); }

function syncStoredHkListingsLayerQuery1(executor, parts, ...args) { return executor(`SELECT h.security_code,h.security_name,h.security_name_cn,h.market_type,i.list_date::text,
      i.status,r.raw_record_id,r.payload,r.payload_hash,r.source_updated_at,r.request_range,r.ingestion_status
    FROM public.ipo_history h JOIN core.instruments i ON i.instrument_id=h.instrument_id
    JOIN LATERAL (SELECT rr.raw_record_id,rr.payload,rr.payload_hash,rr.source_updated_at,ir.request_range,ir.status AS ingestion_status
      FROM ops.raw_records rr JOIN ops.data_sources ds USING(source_id) JOIN ops.ingestion_runs ir ON ir.run_id=rr.run_id AND ir.source_id=rr.source_id
      WHERE ds.source_code='tushare' AND rr.dataset_code='hk_basic' AND rr.source_key=h.security_code
        AND rr.payload->>'ts_code'=h.security_code AND ir.dataset_code='hk_basic'
        AND ir.request_range->>'list_status'='L' AND ir.status='success'
      ORDER BY rr.ingested_at DESC,rr.raw_record_id DESC LIMIT 1) r ON true
    WHERE h.market_code='HK' AND h.listing_at IS NULL AND COALESCE(h.listing_date,'')=''
      AND i.market='HK' AND i.status='listed' AND i.list_date<=$1::date
      AND h.ipo_status NOT IN ('cancelled','canceled','postponed','introduction','gem_transfer','de_spac')
      AND (cardinality($2::text[])=0 OR h.security_code=ANY($2::text[]))`, ...args); }

module.exports = {
  persistHkexProbeLayerQuery1, persistHkexProbeLayerQuery2, persistHkexProbeLayerQuery3, readHkIpoCompletenessLayerQuery1, recomputeHkIpoCompletenessLayerQuery1, syncStoredHkListingsLayerQuery1,
  select_ops_data_sources,
  insert_public_ipo_history,
  insert_event_instrument_events,
};

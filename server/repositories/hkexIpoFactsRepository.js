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

module.exports = {
  select_ops_data_sources,
  insert_public_ipo_history,
  insert_event_instrument_events,
};

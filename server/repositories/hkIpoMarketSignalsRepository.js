const { pool } = require('../db/connection');

const crypto = require('crypto');

// 自 server/services/hkIpoMarketSignals.js 迁入的数据读写函数（只做标准事实读写，业务判定仍留在服务层）。

async function persistRaw(sourceCode, datasetCode, sourceKey, payload, executor = pool) {
  const source = await executor.query('SELECT source_id FROM ops.data_sources WHERE source_code=$1 LIMIT 1', [sourceCode]);
  if (!source.rows[0]) return;
  const text = JSON.stringify(payload || {});
  await executor.query(`
    INSERT INTO ops.raw_records(source_id,dataset_code,source_key,source_updated_at,payload,payload_hash)
    VALUES($1,$2,$3,now(),$4::jsonb,$5)
    ON CONFLICT(source_id,dataset_code,source_key,payload_hash) DO UPDATE SET ingested_at=now()
  `, [source.rows[0].source_id, datasetCode, sourceKey, text, crypto.createHash('sha256').update(text).digest('hex')]);
}

async function select_public_ipo_history(params, client = pool) {
  return client.query(`
    SELECT security_code,instrument_id,ipo_status,offer_open_at,offer_close_at,listing_at,listing_date
      FROM public.ipo_history
     WHERE market_code='HK'
  `);
}

async function update_public_ipo_history(params, client = pool) {
  return client.query(`
    UPDATE public.ipo_history
       SET security_name_cn=$2
     WHERE market_code='HK' AND regexp_replace(security_code,'\\D','','g')=regexp_replace($1,'\\D','','g')
       AND security_name_cn IS DISTINCT FROM $2
  `, params);
}

async function insert_analytics_hk_ipo_market_snapshots(params, client = pool) {
  return client.query(`
    INSERT INTO analytics.hk_ipo_market_snapshots(
      security_code,instrument_id,source_code,signal_type,data_date,observed_at,
      source_observed_at,last_seen_at,subscription_multiple,margin_amount_hkd,margin_multiple,
      grey_market_price_hkd,grey_market_change_pct,signal_kind,source_record_hash,quality_status,raw_payload
    ) VALUES($1,$2,$3,$4,$5::date,COALESCE($6::timestamptz,now()),$7::timestamptz,now(),$8,$9,$10,
      $11,$12,$13,$14,$15,$16::jsonb)
    ON CONFLICT(security_code,source_code,signal_type,data_date,source_record_hash)
      WHERE source_record_hash IS NOT NULL DO UPDATE SET
      instrument_id=COALESCE(EXCLUDED.instrument_id,analytics.hk_ipo_market_snapshots.instrument_id),
      last_seen_at=now(),
      subscription_multiple=COALESCE(EXCLUDED.subscription_multiple,analytics.hk_ipo_market_snapshots.subscription_multiple),
      margin_amount_hkd=COALESCE(EXCLUDED.margin_amount_hkd,analytics.hk_ipo_market_snapshots.margin_amount_hkd),
      margin_multiple=COALESCE(EXCLUDED.margin_multiple,analytics.hk_ipo_market_snapshots.margin_multiple),
      grey_market_price_hkd=COALESCE(EXCLUDED.grey_market_price_hkd,analytics.hk_ipo_market_snapshots.grey_market_price_hkd),
      grey_market_change_pct=COALESCE(EXCLUDED.grey_market_change_pct,analytics.hk_ipo_market_snapshots.grey_market_change_pct),
      source_observed_at=COALESCE(EXCLUDED.source_observed_at,analytics.hk_ipo_market_snapshots.source_observed_at),
      quality_status=EXCLUDED.quality_status,
      raw_payload=EXCLUDED.raw_payload,
      updated_at=now()
  `, params);
}

module.exports = {
  persistRaw,
  select_public_ipo_history,
  update_public_ipo_history,
  insert_analytics_hk_ipo_market_snapshots,
};

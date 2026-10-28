const { pool } = require('../db/connection');

// 自 server/services/convertibleBondSuspensionSync.js 迁入的数据读写函数（只做标准事实读写，业务判定仍留在服务层）。

async function tushareSourceId() {
  const { rows } = await pool.query("SELECT source_id FROM ops.data_sources WHERE source_code='tushare' LIMIT 1");
  return rows[0] && rows[0].source_id;
}

async function select_market_trade_calendar(params, client = pool) {
  return client.query(`SELECT trade_date::text AS trade_date
       FROM market.trade_calendar
      WHERE exchange='SSE' AND is_open AND trade_date BETWEEN $1::date AND $2::date
      ORDER BY trade_date`, params);
}

async function select_fundamental_convertible_bond_profiles(params, client = pool) {
  return client.query(`
      SELECT DISTINCT s.instrument_id, s.canonical_code
         FROM fundamental.convertible_bond_profiles p
         LEFT JOIN fundamental.convertible_bond_issuance iss ON iss.instrument_id=p.instrument_id
         JOIN public.bond_unified u ON u.instrument_id=p.instrument_id
         JOIN core.instruments s ON s.instrument_id=p.stock_instrument_id
        WHERE p.stock_instrument_id IS NOT NULL
          AND u.status='listed'
          AND (iss.issue_type IS NULL OR iss.issue_type NOT IN ('定向','私募'))
      UNION
      SELECT i.instrument_id,i.canonical_code FROM core.instruments i
        WHERE i.asset_class='stock' AND (EXISTS (SELECT 1 FROM stock_watchlist w WHERE w.ts_code=i.canonical_code)
          OR EXISTS (SELECT 1 FROM positions p WHERE p.instrument_id=i.instrument_id))`);
}

async function select_ops_data_sources(params, client = pool) {
  return client.query(`SELECT source_id FROM ops.data_sources WHERE source_code='tushare' LIMIT 1`);
}

async function insert_market_stock_suspend_calendar(params, client = pool) {
  return client.query(`
      INSERT INTO market.stock_suspend_calendar
        (instrument_id,trade_date,suspend_type,suspend_reason,source_id,raw_payload)
      SELECT x.instrument_id,x.trade_date,x.suspend_type,x.suspend_reason,$2,x.raw_payload
        FROM jsonb_to_recordset($1::jsonb) AS x(
          instrument_id bigint,trade_date date,suspend_type text,suspend_reason text,raw_payload jsonb)
      ON CONFLICT (instrument_id,trade_date,source_id) DO UPDATE SET
        suspend_type=EXCLUDED.suspend_type,
        suspend_reason=EXCLUDED.suspend_reason,
        raw_payload=EXCLUDED.raw_payload,
        ingested_at=now()`, params);
}

async function with_fundamental_convertible_bond_profiles(params, client = pool) {
  return client.query(`WITH target_stocks AS (
       SELECT DISTINCT s.instrument_id
         FROM fundamental.convertible_bond_profiles p
         LEFT JOIN fundamental.convertible_bond_issuance iss ON iss.instrument_id=p.instrument_id
         JOIN public.bond_unified u ON u.instrument_id=p.instrument_id
         JOIN core.instruments s ON s.instrument_id=p.stock_instrument_id
        WHERE p.stock_instrument_id IS NOT NULL
          AND u.status='listed'
          AND (iss.issue_type IS NULL OR iss.issue_type NOT IN ('定向','私募'))
       UNION
       SELECT i.instrument_id FROM core.instruments i
        WHERE i.asset_class='stock' AND i.canonical_code LIKE ANY(ARRAY['%.SH','%.SZ','%.BJ'])
          AND (EXISTS (SELECT 1 FROM stock_watchlist w WHERE w.ts_code=i.canonical_code)
            OR EXISTS (SELECT 1 FROM positions p WHERE p.instrument_id=i.instrument_id))
     ), open_days AS (
       SELECT trade_date
         FROM market.trade_calendar
        WHERE exchange='SSE' AND is_open AND trade_date BETWEEN $1::date AND $2::date
     ), coverage AS (
       SELECT d.trade_date,
              COUNT(DISTINCT s.instrument_id)::int AS expected_count,
              COUNT(DISTINCT CASE WHEN b.instrument_id IS NOT NULL OR sc.instrument_id IS NOT NULL
                                  THEN s.instrument_id END)::int AS covered_count,
              MAX(dp.status) AS partition_status,
              BOOL_OR(COALESCE(dp.is_stale,false)) AS partition_is_stale
         FROM open_days d
         CROSS JOIN target_stocks s
         LEFT JOIN market.daily_bars b
           ON b.instrument_id=s.instrument_id AND b.trade_date=d.trade_date AND b.source_id=$3
         LEFT JOIN market.stock_suspend_calendar sc
           ON sc.instrument_id=s.instrument_id AND sc.trade_date=d.trade_date AND sc.source_id=$4
         LEFT JOIN ops.dataset_partitions dp
           ON dp.dataset_code='stock_suspend_calendar' AND dp.scope_key='CN' AND dp.partition_key=d.trade_date
        GROUP BY d.trade_date
     )
     SELECT trade_date::text,expected_count,covered_count,partition_status,partition_is_stale
       FROM coverage
      WHERE covered_count < expected_count
         OR partition_status IS DISTINCT FROM 'published'
         OR COALESCE(partition_is_stale,false)
      ORDER BY trade_date`, params);
}

async function select_market_trade_calendar_1(params, client = pool) {
  return client.query(`SELECT tc.trade_date::text AS trade_date,COUNT(DISTINCT sc.instrument_id)::int AS row_count
       FROM market.trade_calendar tc
       LEFT JOIN market.stock_suspend_calendar sc
         ON sc.trade_date=tc.trade_date AND sc.source_id=$3
      WHERE tc.exchange='SSE' AND tc.is_open AND tc.trade_date BETWEEN $1::date AND $2::date
      GROUP BY tc.trade_date ORDER BY tc.trade_date`, params);
}

async function update_ops_dataset_partitions(params, client = pool) {
  return client.query(`UPDATE ops.dataset_partitions
        SET status='stale',is_stale=true,stale_reason=$3,
            diagnostics=COALESCE(diagnostics,'{}'::jsonb)||$4::jsonb,updated_at=now()
      WHERE dataset_code='stock_suspend_calendar' AND scope_key='CN'
        AND partition_key BETWEEN $1::date AND $2::date`, params);
}

async function select_ops_dataset_partitions(params, client = pool) {
  return client.query(`SELECT partition_key::text AS partition_key
       FROM ops.dataset_partitions
      WHERE dataset_code='stock_suspend_calendar' AND scope_key='CN'
        AND partition_key BETWEEN $1::date AND $2::date`, params);
}

module.exports = {
  tushareSourceId,
  select_market_trade_calendar,
  select_fundamental_convertible_bond_profiles,
  select_ops_data_sources,
  insert_market_stock_suspend_calendar,
  with_fundamental_convertible_bond_profiles,
  select_market_trade_calendar_1,
  update_ops_dataset_partitions,
  select_ops_dataset_partitions,
};

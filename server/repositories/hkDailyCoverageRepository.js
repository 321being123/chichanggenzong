const { pool } = require('../db/connection');

// 自 server/services/hkDailyCoverage.js 迁入的数据读写函数（只做标准事实读写，业务判定仍留在服务层）。

async function loadCandidates(client, fromDate, toDate, limit = null, targetCodes = []) {
  const scopedCodes = [...new Set((Array.isArray(targetCodes) ? targetCodes : []).map(code => String(code || '').trim().toUpperCase()).filter(code => /^\d{5}\.HK$/.test(code)))];
  const targeted = scopedCodes.length > 0;
  const candidateLimit = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : null;
  const coverageDateParam = targeted ? 1 : 2;
  const targetFilter = targeted ? ' AND i.canonical_code=ANY($2::text[])' : '';
  const dateFilter = targeted ? '' : ' AND i.list_date::date BETWEEN $1::date AND $2::date';
  const params = targeted ? [toDate, scopedCodes] : [fromDate, toDate];
  const limitClause = candidateLimit ? ` LIMIT $${params.length + 1}` : '';
  if (candidateLimit) params.push(candidateLimit);
  const { rows } = await client.query(
    `SELECT i.instrument_id,i.canonical_code,i.list_date::text AS list_date,i.status
       FROM core.instruments i
       LEFT JOIN LATERAL (
         SELECT COUNT(DISTINCT b.trade_date)::int AS observed_days
           FROM market.daily_bars b
          WHERE b.instrument_id=i.instrument_id
            AND b.trade_date >= i.list_date
            AND b.trade_date <= $${coverageDateParam}::date
       ) coverage ON true
      WHERE i.asset_class='stock' AND i.market='HK'
        AND i.list_date IS NOT NULL AND i.list_date::date <= $${coverageDateParam}::date
        AND i.canonical_code ~ '^\\d{5}\\.HK$'
        ${dateFilter}
        AND COALESCE(coverage.observed_days,0) < 5
        ${targetFilter}
      ORDER BY i.list_date,i.canonical_code
      ${limitClause}`, params
  );
  return rows;
}

async function sourceIdFor(executor = pool, sourceCode = 'tushare') {
  const { rows } = await executor.query('SELECT source_id FROM ops.data_sources WHERE source_code=$1 LIMIT 1', [sourceCode]);
  if (!rows[0]) throw new Error(`${sourceCode} 数据源未注册`);
  return rows[0].source_id;
}

async function insert_ops_ingestion_runs(params, client = pool) {
  return client.query(`INSERT INTO ops.ingestion_runs(source_id,dataset_code,request_range,status)
       VALUES($1,'hk_daily',$2::jsonb,'running') RETURNING run_id`, params);
}

async function insert_ops_raw_records(params, client = pool) {
  return client.query(`INSERT INTO ops.raw_records(run_id,source_id,dataset_code,source_key,source_updated_at,payload,payload_hash)
         SELECT $1,$2,'hk_daily',x.source_key,now(),x.payload,md5(x.payload::text)
           FROM jsonb_to_recordset($3::jsonb) AS x(source_key text,payload jsonb)
         ON CONFLICT(source_id,dataset_code,source_key,payload_hash) DO NOTHING`, params);
}

async function insert_market_daily_bars(params, client = pool) {
  return client.query(`INSERT INTO market.daily_bars(instrument_id,trade_date,source_id,open,high,low,close,volume,amount)
         SELECT x.instrument_id,x.trade_date,$2,x.open,x.high,x.low,x.close,x.volume,x.amount
           FROM jsonb_to_recordset($1::jsonb) AS x(instrument_id bigint,trade_date date,open numeric,high numeric,low numeric,close numeric,volume numeric,amount numeric)
         ON CONFLICT(instrument_id,trade_date,source_id) DO UPDATE SET open=EXCLUDED.open,high=EXCLUDED.high,low=EXCLUDED.low,
           close=EXCLUDED.close,volume=EXCLUDED.volume,amount=EXCLUDED.amount,ingested_at=now()`, params);
}

async function insert_ops_sync_cursors(params, client = pool) {
  return client.query(`INSERT INTO ops.sync_cursors(scope_key,dataset_code,last_success_date,last_attempt_at,last_error,retry_count,updated_at)
       VALUES('HK','hk_daily',$1,now(),$2,CASE WHEN $2='' THEN 0 ELSE 1 END,now())
       ON CONFLICT(scope_key,dataset_code) DO UPDATE SET
         last_success_date=CASE WHEN EXCLUDED.last_success_date IS NULL THEN ops.sync_cursors.last_success_date
           ELSE GREATEST(COALESCE(ops.sync_cursors.last_success_date,'1900-01-01'::date),EXCLUDED.last_success_date) END,
         last_attempt_at=now(),last_error=EXCLUDED.last_error,
         retry_count=CASE WHEN EXCLUDED.last_error='' THEN 0 ELSE ops.sync_cursors.retry_count+1 END,updated_at=now()`, params);
}

async function update_ops_ingestion_runs(params, client = pool) {
  return client.query(`UPDATE ops.ingestion_runs SET status=$2,row_count=$3,error_message=$4,finished_at=now() WHERE run_id=$1`, params);
}

async function update_ops_ingestion_runs_1(params, client = pool) {
  return client.query(`UPDATE ops.ingestion_runs SET status=$2,error_message=$3,finished_at=now() WHERE run_id=$1`, params);
}

module.exports = {
  loadCandidates,
  sourceIdFor,
  insert_ops_ingestion_runs,
  insert_ops_raw_records,
  insert_market_daily_bars,
  insert_ops_sync_cursors,
  update_ops_ingestion_runs,
  update_ops_ingestion_runs_1,
};

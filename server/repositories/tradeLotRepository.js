const { pool } = require('../db/connection');

// 自 server/services/tradeLot.js 迁入的数据读写函数（只做标准事实读写，业务判定仍留在服务层）。

async function backfillPositionInstrumentIds() {
  await pool.query(`
    UPDATE positions p
       SET instrument_id = i.instrument_id
      FROM core.instruments i
     WHERE p.instrument_id IS NULL
       AND i.canonical_code = p.code
  `);
  await pool.query(`
    UPDATE positions p
       SET instrument_id = m.instrument_id
      FROM (
        SELECT p.username, p.account_name, p.id, min(i.instrument_id) AS instrument_id
          FROM positions p
          JOIN core.instruments i
            ON REGEXP_REPLACE(i.canonical_code, '[^0-9]', '', 'g') = REGEXP_REPLACE(p.code, '[^0-9]', '', 'g')
         WHERE p.instrument_id IS NULL
         GROUP BY p.username, p.account_name, p.id
        HAVING count(DISTINCT i.instrument_id) = 1
      ) m
     WHERE p.username = m.username AND p.account_name = m.account_name AND p.id = m.id
  `);
  // 映射成功：关闭已 open 的未匹配质量记录（status → resolved）
  await pool.query(`
    UPDATE ops.data_quality_issues q
       SET status='resolved', resolved_at=now(), details=jsonb_set(details,'{resolved_by}','"backfill"')
      FROM positions p
     WHERE q.dataset_code='positions' AND q.field_code='instrument_id' AND q.issue_type='unmatched_position'
       AND q.status='open'
       AND p.instrument_id IS NOT NULL
       AND q.details->>'username'=p.username AND q.details->>'account_name'=p.account_name AND q.details->>'code'=p.code
  `);
  // 未匹配：先查重再插入（instrument_id 为 NULL 时 UNIQUE 约束不生效，须手动去重防累积）
  await pool.query(`
    INSERT INTO ops.data_quality_issues(instrument_id,dataset_code,field_code,issue_type,severity,details)
    SELECT NULL,'positions','instrument_id','unmatched_position','warning',
           jsonb_build_object('username',p.username,'account_name',p.account_name,'code',p.code)
      FROM positions p
     WHERE p.instrument_id IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM core.instruments i
          WHERE REGEXP_REPLACE(i.canonical_code, '[^0-9]', '', 'g') = REGEXP_REPLACE(p.code, '[^0-9]', '', 'g')
       )
       AND NOT EXISTS (
         SELECT 1 FROM ops.data_quality_issues q
          WHERE q.dataset_code='positions' AND q.field_code='instrument_id'
            AND q.issue_type='unmatched_position' AND q.status='open'
            AND q.details->>'username'=p.username
            AND q.details->>'account_name'=p.account_name
            AND q.details->>'code'=p.code
       )
  `);
  return { ok: true };
}

async function upsertTradeRule(client, instrumentId, sourceId, today, lot, rawRecordId) {
  const cur = (await client.query(
    `SELECT buy_lot_size_shares,
            to_char(valid_from AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS valid_from_cn
       FROM market.instrument_trade_rules
      WHERE instrument_id=$1 AND source_id=$2 AND valid_to IS NULL
      ORDER BY valid_from DESC LIMIT 1`,
    [instrumentId, sourceId]
  )).rows[0];
  if (cur && cur.buy_lot_size_shares === lot) return false; // 无变化
  if (!cur) {
    await client.query(
      `INSERT INTO market.instrument_trade_rules(instrument_id,source_id,valid_from,buy_lot_size_shares,source_updated_at,raw_record_id)
       VALUES($1,$2,$3::date,$4,now(),$5)`,
      [instrumentId, sourceId, today, lot, rawRecordId || null]
    );
    return true;
  }
  if (cur.valid_from_cn === today) {
    // 同一天内首次同步后每手股数再次变化：直接 UPDATE 当天记录（覆盖数值），
    // 不能关闭旧规则（否则 valid_to=昨天 < valid_from=今天 违反约束）
    await client.query(
      `UPDATE market.instrument_trade_rules
          SET buy_lot_size_shares=$3, source_updated_at=now(), raw_record_id=$4
        WHERE instrument_id=$1 AND source_id=$2 AND valid_to IS NULL
          AND to_char(valid_from AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD')=$5`,
      [instrumentId, sourceId, lot, rawRecordId || null, today]
    );
    return true;
  }
  // 历史某天生效的规则变更：关闭旧规则（valid_to = 新规则生效日前一天，
  // 避免"新规则生效当天"两条规则同时满足 valid_from<=day<=valid_to）
  const prevDay = new Date(today + 'T00:00:00');
  prevDay.setDate(prevDay.getDate() - 1);
  const validTo = `${prevDay.getFullYear()}-${String(prevDay.getMonth() + 1).padStart(2, '0')}-${String(prevDay.getDate()).padStart(2, '0')}`;
  await client.query(
    `UPDATE market.instrument_trade_rules SET valid_to=$3::date
      WHERE instrument_id=$1 AND source_id=$2 AND valid_to IS NULL`,
    [instrumentId, sourceId, validTo]
  );
  await client.query(
    `INSERT INTO market.instrument_trade_rules(instrument_id,source_id,valid_from,buy_lot_size_shares,source_updated_at,raw_record_id)
     VALUES($1,$2,$3::date,$4,now(),$5)`,
    [instrumentId, sourceId, today, lot, rawRecordId || null]
  );
  return true;
}

async function select_market_instrument_trade_rules(params, client = pool) {
  return client.query(`SELECT r.buy_lot_size_shares, r.valid_from, r.source_updated_at, r.raw_record_id,
            s.source_code, s.priority
       FROM market.instrument_trade_rules r
       JOIN ops.data_sources s ON s.source_id = r.source_id
      WHERE r.instrument_id = $1
        AND r.valid_from <= $2
        AND (r.valid_to IS NULL OR r.valid_to >= $2)
      ORDER BY s.priority ASC, r.valid_from DESC
      LIMIT 1`, params);
}

async function select_market_instrument_trade_rules_1(params, client = pool) {
  return client.query(`SELECT r.instrument_id, r.buy_lot_size_shares, r.valid_from, r.source_updated_at, r.raw_record_id,
            s.source_code, s.priority
       FROM market.instrument_trade_rules r
       JOIN ops.data_sources s ON s.source_id = r.source_id
      WHERE r.instrument_id = ANY($1::bigint[])
        AND r.valid_from <= $2
        AND (r.valid_to IS NULL OR r.valid_to >= $2)`, params);
}

async function select_ops_data_sources(params, client = pool) {
  return client.query(`SELECT source_id FROM ops.data_sources WHERE source_code='tushare'`);
}

async function insert_ops_ingestion_runs(params, client = pool) {
  return client.query(`INSERT INTO ops.ingestion_runs(source_id,dataset_code,request_range,status)
       VALUES($1,'hk_basic',$2::jsonb,'running') RETURNING run_id`, params);
}

async function insert_core_instrument_identifiers(params, client = pool) {
  return client.query(`INSERT INTO core.instrument_identifiers(instrument_id,source_id,identifier_type,identifier_value,valid_from)
         VALUES($1,$2,'ts_code',$3,$4) ON CONFLICT(source_id,identifier_type,identifier_value,valid_from) DO NOTHING`, params);
}

async function insert_ops_raw_records(params, client = pool) {
  return client.query(`INSERT INTO ops.raw_records(run_id,source_id,dataset_code,source_key,source_updated_at,payload,payload_hash)
         VALUES($1,$2,'hk_basic',$3,now(),$4::jsonb,$5) ON CONFLICT(source_id,dataset_code,source_key,payload_hash) DO NOTHING
         RETURNING raw_record_id`, params);
}

async function insert_ops_sync_cursors(params, client = pool) {
  return client.query(`INSERT INTO ops.sync_cursors(scope_key,dataset_code,last_success_date,last_attempt_at,last_error)
       VALUES('hk_basic','hk_basic',$1,now(),'') ON CONFLICT(scope_key,dataset_code)
       DO UPDATE SET last_success_date=$1,last_attempt_at=now(),last_error='',updated_at=now()`, params);
}

async function update_ops_ingestion_runs(params, client = pool) {
  return client.query(`UPDATE ops.ingestion_runs SET status='success',row_count=$2,finished_at=now() WHERE run_id=$1`, params);
}

module.exports = {
  backfillPositionInstrumentIds,
  upsertTradeRule,
  select_market_instrument_trade_rules,
  select_market_instrument_trade_rules_1,
  select_ops_data_sources,
  insert_ops_ingestion_runs,
  insert_core_instrument_identifiers,
  insert_ops_raw_records,
  insert_ops_sync_cursors,
  update_ops_ingestion_runs,
};

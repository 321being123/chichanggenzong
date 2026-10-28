const { pool } = require('../db/connection');

// 自 server/services/convertibleBondCycleService.js 迁入的数据读写函数（只做标准事实读写，业务判定仍留在服务层）。

const CYCLE_SCOPE = 'convertible_bond_cycle';
const DATASET = 'cb_daily';

async function getSyncCursor() {
  const { rows } = await pool.query(
    "SELECT to_char(last_success_date,'YYYYMMDD') AS d FROM ops.sync_cursors WHERE scope_key=$1 AND dataset_code=$2", [CYCLE_SCOPE, DATASET]
  );
  return rows[0] ? rows[0].d : null;
}

async function getTushareSourceId(client = pool) {
  const { rows } = await client.query("SELECT source_id FROM ops.data_sources WHERE source_code='tushare' LIMIT 1");
  return rows[0] ? rows[0].source_id : null;
}

async function upsertCycleDaily(client, row) {
  await client.query(
    `INSERT INTO analytics.convertible_bond_cycle_daily
      (trade_date,formula_version,universe_version,bond_count,premium_count,coverage_ratio,median_price,median_conversion_value,
       median_conversion_premium_pct,premium_weight,composite_value,rolling_percentile,cycle_level,source_id,diagnostics,calculated_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now())
     ON CONFLICT(trade_date,formula_version,universe_version) DO UPDATE SET
      bond_count=EXCLUDED.bond_count,premium_count=EXCLUDED.premium_count,coverage_ratio=EXCLUDED.coverage_ratio,
      median_price=EXCLUDED.median_price,median_conversion_value=EXCLUDED.median_conversion_value,
      median_conversion_premium_pct=EXCLUDED.median_conversion_premium_pct,premium_weight=EXCLUDED.premium_weight,
      composite_value=EXCLUDED.composite_value,rolling_percentile=EXCLUDED.rolling_percentile,cycle_level=EXCLUDED.cycle_level,
      source_id=EXCLUDED.source_id,diagnostics=EXCLUDED.diagnostics,calculated_at=now()`,
    [row.trade_date, row.formula_version, row.universe_version, row.bond_count, row.premium_count, row.coverage_ratio,
     row.median_price, row.median_conversion_value, row.median_conversion_premium_pct, row.premium_weight, row.composite_value,
     row.rolling_percentile, row.cycle_level, row.source_id, JSON.stringify(row.diagnostics || {})]
  );
}

async function select_core_instruments(params, client = pool) {
  return client.query(`SELECT instrument_id, canonical_code FROM core.instruments WHERE canonical_code = ANY($1)`, params);
}

async function select_analytics_convertible_bond_cycle_daily(params, client = pool) {
  return client.query(`SELECT composite_value FROM analytics.convertible_bond_cycle_daily
     WHERE formula_version=$1 AND universe_version=$2 AND trade_date < $3 AND composite_value IS NOT NULL
     ORDER BY trade_date DESC LIMIT $4`, params);
}

async function insert_ops_sync_cursors(params, client = pool) {
  return client.query(`INSERT INTO ops.sync_cursors(scope_key,dataset_code,last_success_date,last_source_update,last_attempt_at,last_error,retry_count,updated_at)
     VALUES($1,$2,$3,now(),now(),'',0,now())
     ON CONFLICT(scope_key,dataset_code) DO UPDATE SET
      last_success_date=GREATEST(sync_cursors.last_success_date,EXCLUDED.last_success_date),
      last_source_update=now(),last_attempt_at=now(),last_error='',retry_count=0,updated_at=now()`, params);
}

async function insert_ops_sync_cursors_1(params, client = pool) {
  return client.query(`INSERT INTO ops.sync_cursors(scope_key,dataset_code,last_success_date,last_source_update,last_attempt_at,last_error,retry_count,updated_at)
     VALUES($1,$2,NULL,now(),now(),$3,1,now())
     ON CONFLICT(scope_key,dataset_code) DO UPDATE SET
      last_attempt_at=now(),last_error=EXCLUDED.last_error,retry_count=sync_cursors.retry_count+1,updated_at=now()`, params);
}

async function select_analytics_convertible_bond_cycle_daily_1(params, client = pool) {
  return client.query(`SELECT trade_date, composite_value FROM analytics.convertible_bond_cycle_daily
     WHERE formula_version=$1 AND universe_version=$2 ORDER BY trade_date ASC`, params);
}

async function update_analytics_convertible_bond_cycle_daily(params, client = pool) {
  return client.query(`UPDATE analytics.convertible_bond_cycle_daily SET rolling_percentile=$1, cycle_level=$2, calculated_at=now()
       WHERE trade_date=$3 AND formula_version=$4 AND universe_version=$5`, params);
}

async function select_unnest(params, client = pool) {
  return client.query(`SELECT to_char(d.day,'YYYYMMDD') AS day FROM unnest($1::date[]) AS d(day)
     LEFT JOIN (
       SELECT trade_date, count(*) AS c, count(conversion_premium_pct) AS p
       FROM market.convertible_bond_daily_metrics GROUP BY trade_date
     ) f ON f.trade_date = d.day
     WHERE f.trade_date IS NULL OR (f.c >= 100 AND f.p = 0)
     ORDER BY d.day`, params);
}

async function select_analytics_convertible_bond_cycle_daily_2(params, client = pool) {
  return client.query(`SELECT trade_date,formula_version,universe_version,bond_count,premium_count,coverage_ratio,
            median_price,median_conversion_value,median_conversion_premium_pct,premium_weight,
            composite_value,rolling_percentile,cycle_level,source_id,diagnostics,calculated_at
     FROM analytics.convertible_bond_cycle_daily WHERE formula_version=$1 AND universe_version=$2
     ORDER BY trade_date DESC LIMIT 1`, params);
}

// 周期历史序列（可选起始日截断），按公式版本与标的池版本双过滤
async function listCycleHistory(formulaVersion, universeVersion, cutoff, client = pool) {
  const sql = `SELECT trade_date,cycle_level,rolling_percentile,composite_value,median_price,
                      median_conversion_premium_pct,median_conversion_value,premium_weight,bond_count,coverage_ratio
               FROM analytics.convertible_bond_cycle_daily WHERE formula_version=$1 AND universe_version=$2
               ${cutoff ? 'AND trade_date >= $3' : ''} ORDER BY trade_date ASC`;
  const params = cutoff ? [formulaVersion, universeVersion, cutoff] : [formulaVersion, universeVersion];
  const { rows } = await client.query(sql, params);
  return rows;
}

module.exports = {
  listCycleHistory,
  getSyncCursor,
  getTushareSourceId,
  upsertCycleDaily,
  select_core_instruments,
  select_analytics_convertible_bond_cycle_daily,
  insert_ops_sync_cursors,
  insert_ops_sync_cursors_1,
  select_analytics_convertible_bond_cycle_daily_1,
  update_analytics_convertible_bond_cycle_daily,
  select_unnest,
  select_analytics_convertible_bond_cycle_daily_2,
};

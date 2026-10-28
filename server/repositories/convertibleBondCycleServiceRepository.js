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

module.exports = {
  getSyncCursor,
  getTushareSourceId,
  upsertCycleDaily,
};

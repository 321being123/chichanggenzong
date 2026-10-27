// 可转债安全性数据仓储（批次3，从 routes/bondSafety 迁入的 SQL）。
// 合同：method(params, tx)；只读取强赎状态水位，不承载评级与缓存语义。
const { pool } = require('../db');

// 强赎状态版本水位：计算时间、公告更新时间、最新公告号、行情交易日。
// 任一变化都必须让缓存失效，否则快照未变但 call_status 已变时会错误命中 304。
async function readCallStateWatermark(params, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(`
    SELECT
      (SELECT COALESCE(MAX(calculated_at)::text, '')
         FROM analytics.convertible_bond_trigger_daily
        WHERE trigger_type='call') AS trigger_calculated_at,
      (SELECT COALESCE(MAX(updated_at)::text, '')
         FROM event.convertible_bond_call_events) AS event_updated_at,
      (SELECT COALESCE(MAX(event_id)::text, '')
         FROM event.convertible_bond_call_events) AS event_id,
      (SELECT COALESCE(MAX(trade_date)::text, '')
         FROM market.convertible_bond_daily_metrics) AS market_trade_date`);
  return rows[0] || null;
}

module.exports = { readCallStateWatermark };

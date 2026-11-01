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

// 到期日：安全性快照本身不含到期日，列表名称旁的到期提醒按证券代码批量读标准主档，
// 不为此扩建快照结构（快照是物化产物，加字段要重建，代价与风险都不成比例）。
async function selectMaturityDatesByCodes(params, tx) {
  const codes = [...new Set(((params && params.codes) || [])
    .map(value => String(value || '').trim().toUpperCase().replace(/\.(SH|SZ|BJ|HK)$/, ''))
    .filter(Boolean))];
  if (!codes.length) return new Map();
  const runner = tx || pool;
  const { rows } = await runner.query(`
    SELECT UPPER(split_part(i.canonical_code, '.', 1)) AS bond_code,
           p.maturity_date::text AS maturity_date
      FROM core.instruments i
      JOIN fundamental.convertible_bond_profiles p ON p.instrument_id = i.instrument_id
     WHERE UPPER(split_part(i.canonical_code, '.', 1)) = ANY($1::text[])`, [codes]);
  return new Map(rows.map(row => [String(row.bond_code || '').toUpperCase(), row.maturity_date]));
}

module.exports = { readCallStateWatermark, selectMaturityDatesByCodes };

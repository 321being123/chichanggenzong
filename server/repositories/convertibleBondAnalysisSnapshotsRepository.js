const { pool } = require('../db/connection');

const CoreDate = require('../../public/shared/core-date');

// 自 server/services/convertibleBondAnalysisSnapshots.js 迁入的数据读写函数（只做标准事实读写，业务判定仍留在服务层）。

async function latestAnalysisDate(asOfDate = null) {
  if(asOfDate&&!CoreDate.normalizeBusinessDate(asOfDate))throw new Error('无效分析目标日');
  const {rows}=await pool.query('SELECT MAX(trade_date)::text AS date FROM market.convertible_bond_daily_metrics WHERE ($1::date IS NULL OR trade_date<=$1::date)',[asOfDate]);
  return CoreDate.normalizeBusinessDate(rows[0]?.date);
}

async function loadAnalysisUniverse(targetDate) {
  const { rows } = await pool.query(`SELECT i.instrument_id,i.canonical_code AS ts_code,p.bond_short_name,p.bond_full_name,
    s.canonical_code AS stock_code,i.list_date::text,p.value_date::text,p.maturity_date::text,p.raw_payload,
    p.fundraising_purpose,p.rate_clause,p.first_conv_price,p.updated_at::text AS profile_version
    FROM core.instruments i JOIN fundamental.convertible_bond_profiles p USING(instrument_id)
    JOIN public.bond_unified u USING(instrument_id)
    LEFT JOIN core.instruments s ON s.instrument_id=p.stock_instrument_id
    WHERE (i.status='listed' OR (i.status='delisted' AND i.list_date IS NOT NULL
      AND i.list_date<=$1::date AND i.delist_date>$1::date))
    AND (u.issue_type IS NULL OR u.issue_type NOT IN ('定向','私募'))
    AND NOT EXISTS(SELECT 1 FROM event.convertible_bond_call_events ce WHERE ce.instrument_id=i.instrument_id
      AND ce.event_type IN ('exercise','implementation','completion')
      AND COALESCE(ce.last_trade_date,ce.last_conversion_date)<=$1::date)
    AND (i.list_date IS NULL OR i.list_date<=$1::date) AND (i.delist_date IS NULL OR i.delist_date>$1::date)
    AND (p.maturity_date IS NULL OR p.maturity_date>=$1::date)
    AND (p.conv_end_date IS NULL OR p.conv_end_date>=$1::date)
    AND (p.conv_stop_date IS NULL OR p.conv_stop_date>$1::date)
    AND EXISTS(SELECT 1 FROM market.convertible_bond_daily_metrics m WHERE m.instrument_id=i.instrument_id AND m.trade_date=$1::date)
    ORDER BY i.canonical_code`,[targetDate]);
  return rows;
}

async function persistAnalysisProgress(datasetCode, targetDate, state) {
  await pool.query(`INSERT INTO ops.sync_cursors(scope_key,dataset_code,cursor_payload,last_attempt_at,last_success_date,last_error)
    VALUES($5,$1,$2::jsonb,now(),$3,$4)
    ON CONFLICT(scope_key,dataset_code) DO UPDATE SET cursor_payload=EXCLUDED.cursor_payload,last_attempt_at=now(),
    last_success_date=COALESCE(GREATEST(ops.sync_cursors.last_success_date,EXCLUDED.last_success_date),ops.sync_cursors.last_success_date),
    last_error=EXCLUDED.last_error,updated_at=now()`,
  [datasetCode,JSON.stringify({targetDate,...state}),state.remaining.length || !state.expected ? null : targetDate,
    state.remaining.length || !state.expected?'资料或计算尚未完成':'',state.scopeKey||'convertible_bond_analysis']);
}

async function select_ops_sync_cursors(params, client = pool) {
  return client.query(`SELECT cursor_payload FROM ops.sync_cursors
    WHERE scope_key='convertible_bond_analysis' AND dataset_code='snapshots'`);
}

module.exports = {
  latestAnalysisDate,
  loadAnalysisUniverse,
  persistAnalysisProgress,
  select_ops_sync_cursors,
};

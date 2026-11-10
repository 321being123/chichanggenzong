// 港股单股刷新的逐域本地覆盖审计（SQL 只在仓储层）。
// 统计按「证券 + 市场」而不是整张混合表，A 股分区不能抵消港股缺口。
'use strict';

const { pool } = require('../db/connection');

async function readHkCoverage(tsCode, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(
    `WITH target AS (
       SELECT i.instrument_id,ci.company_id FROM core.instruments i
       LEFT JOIN core.company_instruments ci ON ci.instrument_id=i.instrument_id
      WHERE upper(i.canonical_code)=upper($1) AND i.market='HK' LIMIT 1
     )
     SELECT
       (SELECT count(*) FROM target) AS master,
       (SELECT count(*) FROM market.daily_bars b JOIN target t ON t.instrument_id=b.instrument_id) AS bars,
       (SELECT to_char(max(b.trade_date),'YYYY-MM-DD') FROM market.daily_bars b JOIN target t ON t.instrument_id=b.instrument_id) AS bars_date,
       (SELECT count(*) FROM market.daily_valuations v JOIN target t ON t.instrument_id=v.instrument_id) AS valuations,
       (SELECT to_char(max(v.trade_date),'YYYY-MM-DD') FROM market.daily_valuations v JOIN target t ON t.instrument_id=v.instrument_id) AS valuation_date,
       (SELECT count(*) FROM market.adjustment_factors a JOIN target t ON t.instrument_id=a.instrument_id) AS adjustments,
       (SELECT count(*) FROM fundamental.statement_income_hkfrs w JOIN target t ON t.company_id=w.company_id) AS income_rows,
       (SELECT count(*) FROM fundamental.statement_balance_hkfrs w JOIN target t ON t.company_id=w.company_id) AS balance_rows,
       (SELECT count(*) FROM fundamental.statement_cashflow_hkfrs w JOIN target t ON t.company_id=w.company_id) AS cashflow_rows,
       (SELECT count(*) FROM fundamental.corporate_actions a JOIN target t ON t.instrument_id=a.instrument_id
         WHERE a.action_type='dividend') AS dividends,
       (SELECT count(*) FROM analytics.analysis_snapshots s JOIN target t ON t.instrument_id=s.instrument_id
         WHERE s.snapshot_type='stock_analysis') AS snapshots`,
    [tsCode]
  );
  const row = rows[0] || {};
  const count = key => Number(row[key] || 0);
  return {
    master: count('master') > 0,
    bars: count('bars'), barsDate: row.bars_date || null,
    valuations: count('valuations'), valuationDate: row.valuation_date || null,
    adjustments: count('adjustments'),
    reports: count('income_rows') + count('balance_rows') + count('cashflow_rows'),
    dividends: count('dividends'),
    snapshots: count('snapshots'),
  };
}

// 日常自动更新的目标集：所有用户持仓 ∪ 显式自选中的港股，按完整标准身份去重。
// 不以是否港股通/恒生成分作为准入，也不改变选股股票池。
async function listTrackedHkCodes(tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(
    `SELECT DISTINCT i.canonical_code AS code FROM core.instruments i
      WHERE i.market='HK' AND i.asset_class='stock' AND i.canonical_code ~ '^[0-9]{5}\\.HK$'
        AND (
          EXISTS (SELECT 1 FROM stock_watchlist w WHERE upper(w.ts_code)=upper(i.canonical_code))
          OR EXISTS (SELECT 1 FROM positions p
                      WHERE lpad(replace(upper(p.code),'.HK',''),5,'0')=substring(i.canonical_code,1,5)
                        AND p.code ~ '^[0-9]{5}(\\.HK)?$')
        )
      ORDER BY i.canonical_code`
  );
  return rows.map(row => row.code);
}

// 普通用户刷新进度授权投影：只按 slotId + 发起人账号返回安全状态字段，
// 不返回内部错误栈、凭据、request_payload 全文或任意他人任务详情。
async function readRefreshSlotForUser(slotId, username) {
  const id = Number(slotId);
  if (!Number.isSafeInteger(id) || id <= 0 || !username) return null;
  const { rows } = await pool.query(
    `SELECT slot_id,status,to_char(business_date,'YYYY-MM-DD') AS target_date,
            COALESCE(result_summary->>'status','') AS stage_status,
            COALESCE((result_summary->>'stageComplete')::boolean,false) AS stage_complete,
            COALESCE(result_summary->>'effectiveDataDate','') AS effective_data_date,
            COALESCE(result_summary->>'analysisVersion','') AS analysis_version,
            COALESCE((result_summary->>'remainingCount')::int,0) AS remaining_count,
            COALESCE(result_summary->>'market','') AS market,
            COALESCE(request_payload->>'targetCodes','[]') AS target_codes,
            updated_at
       FROM ops.job_schedule_slots
      WHERE slot_id=$1 AND job_code='company_financial_incremental_sync'
        AND request_payload->>'requestedBy'=$2
        AND request_payload->>'mode'='stock_analysis' LIMIT 1`, [id, username]
  );
  return rows[0] || null;
}

// ---- 港股证券分析所需的标准事实读取（SQL 只在仓储层；表名/列名由调用方从版本化字典传入） ----
const REPORT_TABLES = Object.freeze({
  income: 'fundamental.statement_income_hkfrs',
  balance: 'fundamental.statement_balance_hkfrs',
  cashflow: 'fundamental.statement_cashflow_hkfrs',
});
const REPORT_SELECTS = Object.freeze({
  income: 'w.ps_npatoshopc,w.ps_np,w.ps_toi,w.ps_oi,w.ps_beps',
  balance: 'w.bs_tetoshopc,w.bs_tetshaoehopc,w.bs_ta,w.bs_tl',
  cashflow: 'w.cfs_ncffoa',
});
const REPORT_KINDS = Object.freeze(['income', 'balance', 'cashflow']);

async function readHkReportFacts(tsCode, limit = 12, tx) {
  const runner = tx || pool;
  const results = await Promise.all(REPORT_KINDS.map(kind => runner.query(
    `SELECT '${kind}' AS kind,to_char(w.period_end,'YYYY-MM-DD') AS period_end,w.period_type,
            to_char(w.announced_at,'YYYY-MM-DD') AS announced_at,w.currency_code,
            w.source_version,w.report_id,w.company_id,${REPORT_SELECTS[kind]}
       FROM ${REPORT_TABLES[kind]} w
       JOIN core.company_instruments ci ON ci.company_id=w.company_id
       JOIN core.instruments i ON i.instrument_id=ci.instrument_id
      WHERE i.canonical_code=$1
      ORDER BY w.period_end DESC,w.announced_at DESC NULLS LAST,w.report_id DESC LIMIT $2`,
    [tsCode, limit]
  )));
  return results.map((result, index) => ({ kind: REPORT_KINDS[index], rows: result.rows }));
}

// 宽表名与列清单必须来自 dataAccess/lixingerReportMetrics 受控常量，不接受请求参数。
async function listHkStatementRows(tsCode, type, table, columns, limit, tx) {
  const runner = tx || pool;
  const { rows } = await runner.query(
    `SELECT w.report_id,to_char(w.period_end,'YYYY-MM-DD') AS period_end,w.period_type,
            to_char(w.announced_at,'YYYY-MM-DD') AS announced_at,w.currency_code,
            w.accounting_standard,w.source_version,w.company_id,
       ${columns}
       FROM ${table} w
       JOIN core.company_instruments ci ON ci.company_id=w.company_id
       JOIN core.instruments i ON i.instrument_id=ci.instrument_id
       JOIN fundamental.financial_reports r ON r.report_id=w.report_id AND r.is_current_version=true
      WHERE i.canonical_code=$1
      ORDER BY w.period_end DESC,w.announced_at DESC NULLS LAST,w.report_id DESC
      LIMIT $2`, [tsCode, limit]
  );
  return rows;
}

async function searchInstrumentCandidates(text, tx) {
  const runner = tx || pool;
  const like = `%${text}%`, prefix = `${text}%`;
  const { rows } = await runner.query(
    `SELECT canonical_code,name,market,asset_class,currency_code,status
       FROM core.instruments
      WHERE asset_class='stock' AND (market='HK' OR market='CN')
        AND (name ILIKE $1 OR canonical_code ILIKE $1)
      ORDER BY CASE WHEN name ILIKE $2 THEN 0 ELSE 1 END, canonical_code LIMIT 12`, [like, prefix]
  );
  return rows;
}

module.exports = {
  readHkCoverage, listTrackedHkCodes, readRefreshSlotForUser,
  readHkReportFacts, listHkStatementRows, searchInstrumentCandidates,
};

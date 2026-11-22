const { pool } = require('../db/connection');

// 自 server/services/bondSafetyTushare.js 迁入的数据读写函数（只做标准事实读写，业务判定仍留在服务层）。

async function loadFinancialCache() {
  const { rows } = await pool.query('SELECT ts_code, stock_name, data, fetched_at FROM bond_safety_financial_cache');
  return new Map(rows.map(row => [row.ts_code, {
    stock_name: row.stock_name,
    data: row.data || {},
    fetched_at: new Date(row.fetched_at).getTime(),
  }]));
}

async function saveFinancialCache(tsCode, stockName, data) {
  await pool.query(
    `INSERT INTO bond_safety_financial_cache
       (ts_code, stock_name, report_end_date, announced_at, data)
     VALUES ($1,$2,$3,$4,$5::jsonb)
     ON CONFLICT (ts_code) DO UPDATE SET stock_name=EXCLUDED.stock_name,
       report_end_date=EXCLUDED.report_end_date, announced_at=EXCLUDED.announced_at,
       data=EXCLUDED.data, fetched_at=now()`,
    [tsCode, stockName || '', data.report_end_date, data.announced_at, JSON.stringify(data)]
  );
}

// 按证券代码读取发行方式，供服务层排除非公开发行标的
async function loadIssuanceTypes(codes, client = pool) {
  const result = await client.query(`
    SELECT i.canonical_code, v.issue_type
      FROM core.instruments i
      JOIN fundamental.convertible_bond_issuance v ON v.instrument_id=i.instrument_id
     WHERE i.canonical_code = ANY($1::text[])
  `, [codes]);
  return result.rows;
}


// 安全性只消费同一报告期、同一合并口径的资产负债表；Tushare 摘要保留原始键，
// 理杏仁摘要不含全量科目，因此同一 report_id 的 CAS 宽表 bs_tcl 作为缺失回退。
// 任何跨报告、跨版本、跨来源、跨市场或非 CNY 的值都不借用；真实缺失保持 null，0 保持 0。
function finiteField(value) {
  // 只接受真实数字或数字字符串；布尔、数组、对象经 Number() 会变成 1/0 等假财务值。
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '' || text === 'null') return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function resolveCurrentLiability(row = {}) {
  const raw = finiteField(row.balance_payload && row.balance_payload.total_cur_liab);
  if (raw !== null) return raw;
  if (String(row.balance_source_code || '').toLowerCase() !== 'lixinger_official') return null;
  if (row.balance_report_id == null || row.balance_wide_report_id == null) return null;
  if (String(row.balance_report_id) !== String(row.balance_wide_report_id)) return null;
  if (row.balance_source_id == null || row.balance_wide_source_id == null
    || String(row.balance_source_id) !== String(row.balance_wide_source_id)) return null;
  if (row.balance_source_version && row.balance_wide_source_version
    && String(row.balance_source_version) !== String(row.balance_wide_source_version)) return null;
  if (String(row.balance_wide_currency || '').toUpperCase() !== 'CNY') return null;
  if (String(row.balance_wide_standard || '').toUpperCase() !== 'CAS') return null;
  return finiteField(row.balance_wide_current_liability);
}

async function loadBondSafetyFacts(params, client = pool) {
  const { rows } = await client.query(`
    WITH market_day AS (
      SELECT COALESCE($1::date, MAX(trade_date)) AS trade_date
        FROM market.convertible_bond_daily_metrics
    ), bonds AS (
      SELECT i.instrument_id,i.canonical_code AS bond_code,i.name AS bond_name,
             s.canonical_code AS stock_code,s.name AS stock_name,p.stock_instrument_id,
             dm.trade_date::text AS trade_date,dm.close,dm.raw_payload->>'pct_chg' AS change_pct,
             dm.conversion_value,dm.conversion_premium_pct,
             p.current_conv_price AS convert_price,v.trade_date::text AS valuation_trade_date,
             COALESCE(v.pe_ttm,v.pe_static) AS pe_ttm,v.pe_static,v.pb,v.dividend_yield_ttm,
             v.total_market_cap,s.raw_data AS stock_raw
        FROM market_day md
        JOIN market.convertible_bond_daily_metrics dm ON dm.trade_date=md.trade_date
        JOIN core.instruments i ON i.instrument_id=dm.instrument_id AND i.asset_class='convertible_bond'
        JOIN fundamental.convertible_bond_profiles p ON p.instrument_id=i.instrument_id
        LEFT JOIN core.instruments s ON s.instrument_id=p.stock_instrument_id
        LEFT JOIN LATERAL (
          SELECT * FROM market.daily_valuations x
           WHERE x.instrument_id=p.stock_instrument_id AND x.trade_date=dm.trade_date
           ORDER BY x.source_id DESC LIMIT 1
        ) v ON true
       WHERE i.status='listed' AND (i.delist_date IS NULL OR i.delist_date>md.trade_date)
         AND (p.maturity_date IS NULL OR p.maturity_date>=md.trade_date)
      UNION ALL
      -- 待上市新债：安全性评级依据正股财务，上市前即可评定；页面读取端仍按在市口径过滤（2026-10-22）
      SELECT i.instrument_id,i.canonical_code AS bond_code,i.name AS bond_name,
             s.canonical_code AS stock_code,s.name AS stock_name,p.stock_instrument_id,
             NULL::text AS trade_date,NULL::numeric AS close,NULL::text AS change_pct,
             NULL::numeric AS conversion_value,NULL::numeric AS conversion_premium_pct,
             p.current_conv_price AS convert_price,NULL::text AS valuation_trade_date,
             COALESCE(v.pe_ttm,v.pe_static) AS pe_ttm,v.pe_static,v.pb,v.dividend_yield_ttm,
             v.total_market_cap,s.raw_data AS stock_raw
        FROM core.instruments i
        JOIN fundamental.convertible_bond_profiles p ON p.instrument_id=i.instrument_id
        LEFT JOIN core.instruments s ON s.instrument_id=p.stock_instrument_id
        LEFT JOIN LATERAL (
          SELECT * FROM market.daily_valuations x
           WHERE x.instrument_id=p.stock_instrument_id
           ORDER BY x.trade_date DESC, x.source_id DESC LIMIT 1
        ) v ON true
       WHERE i.asset_class='convertible_bond'
         AND (i.list_date IS NULL OR i.list_date>=COALESCE($1::date,CURRENT_DATE))
         AND NOT EXISTS (SELECT 1 FROM market.convertible_bond_daily_metrics existing
           WHERE existing.instrument_id=i.instrument_id
             AND existing.trade_date=(SELECT trade_date FROM market_day))
         AND COALESCE(i.status,'') NOT IN ('cancelled','canceled')
         AND p.stock_instrument_id IS NOT NULL
    )
    SELECT b.*,ci.company_id,
           ind.raw_payload AS indicator_payload, bal.raw_payload AS balance_payload,
           inc.raw_payload AS income_payload, fp.period_end::text AS financial_report_end_date,
           bal.report_id AS balance_report_id,bal.source_id AS balance_source_id,
           bal.source_version AS balance_source_version,bds.source_code AS balance_source_code,
           wide.report_id AS balance_wide_report_id,wide.source_id AS balance_wide_source_id,
           wide.source_version AS balance_wide_source_version,wide.currency_code AS balance_wide_currency,
           wide.accounting_standard AS balance_wide_standard,wide.bs_tcl AS balance_wide_current_liability,
           inc.period_end::text AS income_period,bal.period_end::text AS balance_period,ind.period_end::text AS indicator_period,
           COALESCE(n.industry_name,b.stock_raw->>'industry','') AS industry
      FROM bonds b
      LEFT JOIN core.company_instruments ci ON ci.instrument_id=b.stock_instrument_id
      LEFT JOIN LATERAL (
        SELECT r.period_end
          FROM fundamental.financial_reports r
         WHERE r.company_id=ci.company_id AND r.report_kind IN ('income','balance','indicator')
           AND r.report_type='1' AND r.is_current_version
           AND upper(COALESCE(r.raw_payload->>'ts_code','')) ~ '^[0-9]{6}[.](SH|SZ|BJ)$'
         GROUP BY r.period_end
        HAVING COUNT(DISTINCT r.report_kind)=3
         ORDER BY r.period_end DESC LIMIT 1
      ) fp ON true
      LEFT JOIN LATERAL (SELECT r.raw_payload,r.period_end FROM fundamental.financial_reports r WHERE r.company_id=ci.company_id AND r.report_kind='indicator' AND r.report_type='1' AND r.is_current_version AND r.period_end=fp.period_end AND upper(COALESCE(r.raw_payload->>'ts_code','')) ~ '^[0-9]{6}[.](SH|SZ|BJ)$' ORDER BY r.announced_at DESC NULLS LAST LIMIT 1) ind ON true
      LEFT JOIN LATERAL (SELECT r.raw_payload,r.period_end,r.report_id,r.source_id,r.source_version FROM fundamental.financial_reports r WHERE r.company_id=ci.company_id AND r.report_kind='balance' AND r.report_type='1' AND r.is_current_version AND r.period_end=fp.period_end AND upper(COALESCE(r.raw_payload->>'ts_code','')) ~ '^[0-9]{6}[.](SH|SZ|BJ)$' ORDER BY r.announced_at DESC NULLS LAST LIMIT 1) bal ON true
      -- 只按选中的 balance.report_id 关联 CAS 宽表；不按公司/期间二次选择，避免借到另一报告或版本。
      LEFT JOIN fundamental.statement_balance_cas wide ON wide.report_id=bal.report_id
      LEFT JOIN ops.data_sources bds ON bds.source_id=bal.source_id
      LEFT JOIN LATERAL (SELECT r.raw_payload,r.period_end FROM fundamental.financial_reports r WHERE r.company_id=ci.company_id AND r.report_kind='income' AND r.report_type='1' AND r.is_current_version AND r.period_end=fp.period_end AND upper(COALESCE(r.raw_payload->>'ts_code','')) ~ '^[0-9]{6}[.](SH|SZ|BJ)$' ORDER BY r.announced_at DESC NULLS LAST LIMIT 1) inc ON true
      LEFT JOIN LATERAL (SELECT n.industry_name FROM core.company_industry_memberships m JOIN core.industry_nodes n ON n.industry_node_id=m.industry_node_id WHERE m.company_id=ci.company_id AND m.is_current ORDER BY m.announced_at DESC NULLS LAST LIMIT 1) n ON true
    WHERE NOT EXISTS (SELECT 1 FROM fundamental.convertible_bond_issuance issuance
      WHERE issuance.instrument_id=b.instrument_id AND issuance.issue_type IN ('定向','私募'))
  `, params);
  return { rows: rows.map(row => ({ ...row, balance_current_liability: resolveCurrentLiability(row) })) };
}

module.exports = {
  loadBondSafetyFacts,
  loadFinancialCache,
  loadIssuanceTypes,
  saveFinancialCache,
  resolveCurrentLiability,
};

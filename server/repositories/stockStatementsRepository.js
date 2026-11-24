'use strict';

const { pool } = require('../db/connection');
const dict = require('../dataAccess/lixingerReportMetrics');

// 旧 A 股报告仍可能只有 Tushare 风格 raw_payload。这里只保留经过核对的
// 语义一一对应关系；新宽表有值时始终优先，不能用字段名相似度做猜测。
const LEGACY_CAS_FIELD_MAP = Object.freeze({
  'bs.ta': 'total_assets', 'bs.tca': 'total_cur_assets', 'bs.tnca': 'total_nca',
  'bs.cabb': 'money_cap', 'bs.tfa': 'trad_asset', 'bs.nraar': 'accounts_receiv_bill',
  'bs.nr': 'notes_receiv', 'bs.ar': 'accounts_receiv', 'bs.ats': 'prepayment',
  'bs.i': 'inventories', 'bs.ca': 'contract_assets', 'bs.ahfs': 'hfs_assets',
  'bs.ncadwioy': 'nca_within_1y', 'bs.oca': 'oth_cur_assets', 'bs.ltei': 'lt_eqt_invest',
  'bs.rei': 'invest_real_estate', 'bs.cri': 'debt_invest', 'bs.ocri': 'oth_debt_invest',
  'bs.fa': 'fix_assets', 'bs.dofa': 'fixed_assets_disp', 'bs.cip': 'cip',
  'bs.es': 'const_materials', 'bs.ia': 'intan_assets', 'bs.rade': 'r_and_d',
  'bs.gw': 'goodwill', 'bs.ltpe': 'lt_amor_exp', 'bs.dita': 'defer_tax_assets',
  'bs.onca': 'oth_nca', 'bs.tl': 'total_liab', 'bs.tcl': 'total_cur_liab',
  'bs.tncl': 'total_ncl', 'bs.stl': 'st_borr', 'bs.npaap': 'accounts_pay',
  'bs.np': 'notes_payable', 'bs.ap': 'acct_payable', 'bs.afc': 'adv_receipts',
  'bs.cl': 'contract_liab', 'bs.sawp': 'payroll_payable', 'bs.tp': 'taxes_payable',
  'bs.oap': 'oth_payable', 'bs.intp': 'int_payable', 'bs.dp': 'div_payable',
  'bs.ncldwioy': 'non_cur_liab_due_1y', 'bs.ocl': 'oth_cur_liab', 'bs.ltl': 'lt_borr',
  'bs.bp': 'bond_payable', 'bs.ltap': 'lt_payable', 'bs.sap': 'specific_payables',
  'bs.ncal': 'estimated_liab', 'bs.ditl': 'defer_tax_liab', 'bs.ltdi': 'defer_inc_non_cur_liab',
  'bs.oncl': 'oth_ncl', 'bs.toe': 'total_hldr_eqy_inc_min_int', 'bs.tetshaoehopc': 'total_hldr_eqy_exc_min_int',
  'bs.etmsh': 'minority_int', 'bs.capr': 'cap_rese', 'bs.surr': 'surplus_rese',
  'bs.rtp': 'undistr_porfit', 'bs.is': 'treasury_share', 'bs.oci': 'oth_comp_income',
  'ps.toi': 'total_revenue', 'ps.oi': 'revenue', 'ps.ii': 'int_income', 'ps.ep': 'prem_earned',
  'ps.faci': 'comm_income', 'ps.ooi': 'oth_b_income', 'ps.oc': 'oper_cost',
  'ps.ie': 'int_exp', 'ps.face': 'comm_exp', 'ps.tas': 'biz_tax_surchg', 'ps.se': 'sell_exp',
  'ps.ae': 'admin_exp', 'ps.fe': 'fin_exp', 'ps.rade': 'rd_exp', 'ps.ailor': 'assets_impair_loss',
  'ps.cilor': 'credit_impa_loss', 'ps.ooe': 'other_bus_cost', 'ps.ciofv': 'fv_value_chg_gain',
  'ps.ivi': 'invest_income', 'ps.iifaajv': 'ass_invest_income', 'ps.ei': 'forex_gain',
  'ps.op': 'operate_profit', 'ps.noi': 'non_oper_income', 'ps.noe': 'non_oper_exp',
  'ps.tp': 'total_profit', 'ps.ite': 'income_tax', 'ps.np': 'n_income',
  'ps.npfco': 'continued_net_profit', 'ps.npatshaoehopc': 'n_income_attr_p', 'ps.npatmsh': 'minority_gain',
  'ps.natooci': 'oth_compr_income', 'ps.tci': 't_compr_income', 'ps.tciatshaoehopc': 'compr_inc_attr_p',
  'ps.tciatmsh': 'compr_inc_attr_m_s', 'ps.beps': 'basic_eps', 'ps.deps': 'diluted_eps',
  'ps.ebit': 'ebit', 'ps.ebitda': 'ebitda', 'ps.ieife': 'fin_exp_int_exp', 'ps.iiife': 'fin_exp_int_inc',
  'cfs.stciffoa': 'c_inf_fr_operate_a', 'cfs.crfscapls': 'c_fr_sale_sg', 'cfs.crfwbot': 'recp_tax_rends',
  'cfs.crrtooa': 'c_fr_oth_operate_a', 'cfs.stcoffoa': 'st_cash_out_act', 'cfs.cpfpcarls': 'c_paid_goods_s',
  'cfs.cptofe': 'c_paid_to_for_empl', 'cfs.cpft': 'c_paid_for_taxes', 'cfs.cprtooa': 'oth_cash_pay_oper_act',
  'cfs.ncffoa': 'n_cashflow_act', 'cfs.stcifia': 'stot_inflows_inv_act', 'cfs.crfrci': 'c_disp_withdrwl_invest',
  'cfs.crfii': 'c_recp_return_invest',
  'cfs.crfdofiaolta': 'n_recp_disp_fiolta', 'cfs.crrtoia': 'oth_recp_ral_inv_act',
  'cfs.stcoffia': 'stot_out_inv_act', 'cfs.cpfpfiaolta': 'c_pay_acq_const_fiolta', 'cfs.cpfi': 'c_paid_invest',
  'cfs.cprtoia': 'oth_pay_ral_inv_act', 'cfs.ncffia': 'n_cashflow_inv_act',
  'cfs.stcifffa': 'stot_cash_in_fnc_act', 'cfs.crfai': 'c_recp_cap_contrib', 'cfs.crfl': 'c_recp_borrow',
  'cfs.crfib': 'proc_issue_bonds', 'cfs.crrtofa': 'oth_cash_recp_ral_fnc_act',
  'cfs.stcofffa': 'stot_cashout_fnc_act', 'cfs.cpfbrp': 'c_prepay_amt_borr',
  'cfs.cpfdapdoi': 'c_pay_dist_dpcp_int_exp', 'cfs.cprtofa': 'oth_cashpay_ral_fnc_act',
  'cfs.ncfffa': 'n_cash_flows_fnc_act', 'cfs.iocacedtfier': 'eff_fx_flu_cash',
  'cfs.niicace': 'n_incr_cash_cash_equ', 'cfs.bocaceatpb': 'c_cash_equ_beg_period',
  'cfs.bocaceatpe': 'c_cash_equ_end_period', 'cfs.np': 'net_profit', 'cfs.fe': 'finan_exp',
  'cfs.dofx_dooaga_dopba': 'depr_fa_coga_dpba',
  'cfs.aoia': 'amort_intang_assets', 'cfs.aoltde': 'lt_amort_deferred_exp',
  'cfs.dii': 'decr_inventories', 'cfs.dior': 'decr_oper_payable', 'cfs.iiop': 'incr_oper_payable',
  'cfs.ncffoa_dup': 'im_net_cashflow_oper_act',
});

// Historical Tushare values previously copied into these columns can have a
// different meaning from the official metric. Do not expose them as that metric.
const UNVERIFIED_TUSHARE_WIDE = new Set(['bs.tetoshopc', 'ps.npatoshopc', 'ps.tciatoshopc', 'ps.toc', 'ps.ncadarl', 'cfs.ioa']);

function legacyMetricExpression(metric) {
  const column = dict.columnOf(metric.code);
  const field = LEGACY_CAS_FIELD_MAP[metric.code];
  if (UNVERIFIED_TUSHARE_WIDE.has(metric.code)) {
    return `CASE WHEN i.market='CN' AND ds.source_code='tushare' THEN NULL ELSE w.${column} END AS ${column}`;
  }
  if (!field) return `w.${column} AS ${column}`;
  const raw = `NULLIF(NULLIF(r.raw_payload->>'${field}', ''), 'null')::numeric`;
  // Tushare's original report is authoritative for this mapping; an older
  // synthesized wide value may have been populated with an incorrect mapping.
  return `CASE WHEN i.market='CN' AND ds.source_code='tushare' THEN ${raw} ELSE w.${column} END AS ${column}`;
}

// 来源代码能识别时不能跨 A/H 市场；身份不明仅在该市场专用宽表存在时可识别。
// 参数均为仓储内部固定 SQL 标识，表名仅来自受控字典。
function reportMarketPredicate(report, wide, market) {
  const code = `upper(COALESCE(${report}.raw_payload->>'ts_code',''))`;
  return `((${code} LIKE '%.HK' AND ${market}='HK')
    OR (${code} ~ '^[0-9]{6}[.](SH|SZ|BJ)$' AND ${market}='CN')
    OR (${code} NOT LIKE '%.HK' AND ${code} !~ '^[0-9]{6}[.](SH|SZ|BJ)$' AND ${wide}.report_id IS NOT NULL))`;
}

// is_current_version 是公司全局标记，A/H 同期会互相覆盖；读取按市场、范围和同一排序独立选版。
function latestMarketReportPredicate(report, market, table) {
  return `${report}.report_id = (SELECT market_version.report_id
    FROM fundamental.financial_reports market_version
    LEFT JOIN ${table} market_wide ON market_wide.report_id=market_version.report_id
    WHERE market_version.company_id=${report}.company_id AND market_version.report_kind=${report}.report_kind
      AND market_version.period_end=${report}.period_end
      AND COALESCE(market_version.statement_scope,'consolidated')=COALESCE(${report}.statement_scope,'consolidated')
      AND (market_version.available_at IS NULL OR market_version.available_at <= now())
      AND ${reportMarketPredicate('market_version', 'market_wide', market)}
    ORDER BY CASE WHEN market_version.report_type='1' THEN 0 ELSE 1 END,
      market_version.announced_at DESC NULLS LAST,market_version.ingested_at DESC,market_version.report_id DESC LIMIT 1)`;
}

async function listStatementRows({ tsCode, market = 'CN', type = 'balance', limit = 8, periodType = null, scope = null, tx = null } = {}) {
  const runner = tx || pool;
  const metrics = dict.metricsByStatement(market, type);
  const table = dict.tableNameOf(market, type);
  const selectedMetrics = metrics.map(legacyMetricExpression).join(',\n       ');
  const periodTypeExpression = `COALESCE(NULLIF(w.period_type,'unknown'),NULLIF(r.period_type,'unknown'),CASE lower(r.raw_payload->>'report_period_label') WHEN 'annual_report' THEN 'annual' WHEN 'annual' THEN 'annual' WHEN 'year_report' THEN 'annual' WHEN 'semi_annual_report' THEN 'semiannual' WHEN 'semiannual_report' THEN 'semiannual' WHEN 'interim_report' THEN 'semiannual' WHEN 'second_quarterly_report' THEN 'semiannual' WHEN 'first_quarterly_report' THEN 'q1' WHEN 'quarterly_report' THEN 'q1' WHEN 'q1' THEN 'q1' WHEN 'third_quarterly_report' THEN 'q3' WHEN 'q3' THEN 'q3' WHEN 'fourth_quarterly_report' THEN 'annual' WHEN 'q4' THEN 'annual' END,'unknown')`;
  const params = [tsCode, String(market).toUpperCase(), type];
  const predicates = [
    'upper(i.canonical_code)=upper($1)',
    'i.market=$2',
    'r.report_kind=$3',
    '(r.available_at IS NULL OR r.available_at <= now())',
    reportMarketPredicate('r', 'w', 'i.market'),
    latestMarketReportPredicate('r', 'i.market', table),
  ];
  if (periodType && periodType !== 'all') {
    if (periodType === 'quarter') {
      predicates.push(`${periodTypeExpression} IN ('q1','q3')`);
    } else {
      params.push(periodType);
      predicates.push(`${periodTypeExpression}=$${params.length}`);
    }
  }
  if (scope) {
    params.push(scope);
    predicates.push(`COALESCE(r.statement_scope,'consolidated')=$${params.length}`);
  }
  params.push(Math.max(3, Math.min(24, Number(limit) || 8)));
  const { rows } = await runner.query(`SELECT r.report_id,r.company_id,to_char(COALESCE(w.period_end,r.period_end),'YYYY-MM-DD') AS period_end,
       ${periodTypeExpression} AS period_type,
       to_char(COALESCE(w.announced_at,r.announced_at),'YYYY-MM-DD') AS announced_at,
       to_char(r.f_ann_date,'YYYY-MM-DD') AS f_ann_date,
       COALESCE(w.currency_code,NULLIF(r.raw_payload->>'currency',''),CASE WHEN i.market='CN' THEN 'CNY' END) AS currency_code,
       r.raw_payload->>'currency' AS source_currency,
       COALESCE(w.accounting_standard,CASE WHEN i.market='CN' THEN 'CAS' WHEN i.market='HK' THEN 'HKFRS' END) AS accounting_standard,
       COALESCE(w.source_id,r.source_id) AS source_id,ds.source_code,
       COALESCE(w.source_version,r.source_version) AS source_version,
       to_char(COALESCE(w.ingested_at,r.ingested_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') AS statement_revision,
       r.report_type,r.comp_type,r.update_flag,r.statement_scope,r.available_at,
       r.raw_payload->>'report_period_label' AS report_type_label,
       r.raw_payload->>'fiscal_year' AS fiscal_year,
       r.raw_payload->'__statement_coverage' AS statement_coverage,
       c.raw_data->>'industry' AS industry,
       ${selectedMetrics}
    FROM fundamental.financial_reports r
    JOIN core.company_instruments ci ON ci.company_id=r.company_id
    JOIN core.instruments i ON i.instrument_id=ci.instrument_id
     LEFT JOIN ${table} w ON w.report_id=r.report_id
     LEFT JOIN ops.data_sources ds ON ds.source_id=COALESCE(w.source_id,r.source_id)
     LEFT JOIN core.companies c ON c.company_id=r.company_id
    WHERE ${predicates.join(' AND ')}
    ORDER BY COALESCE(w.period_end,r.period_end) DESC,COALESCE(w.announced_at,r.announced_at) DESC NULLS LAST,r.report_id DESC
    LIMIT $${params.length}`, params);
  return rows;
}

// 旧 A 股读取入口保留，避免其他服务在迁移期间被无关改动打断。
async function listAnnualStatements(tsCode, type, limit) {
  return pool.query(`SELECT to_char(r.period_end,'YYYY') AS fiscal_year,to_char(r.announced_at,'YYYY-MM-DD') AS announced_at,r.raw_payload
    FROM fundamental.financial_reports r JOIN core.company_instruments ci ON ci.company_id=r.company_id JOIN core.instruments i ON i.instrument_id=ci.instrument_id
    WHERE i.canonical_code=$1 AND r.report_kind=$2 AND r.period_type='annual'
      AND (r.available_at IS NULL OR r.available_at <= now())
      AND upper(COALESCE(r.raw_payload->>'ts_code',''))=upper($1)
      AND r.report_id = (SELECT candidate.report_id
        FROM fundamental.financial_reports candidate
        WHERE candidate.company_id=r.company_id AND candidate.report_kind=r.report_kind
          AND candidate.period_end=r.period_end AND candidate.period_type='annual'
          AND upper(COALESCE(candidate.raw_payload->>'ts_code',''))=upper($1)
        ORDER BY CASE WHEN candidate.report_type='1' THEN 0 ELSE 1 END,
          candidate.announced_at DESC NULLS LAST,candidate.ingested_at DESC,candidate.report_id DESC LIMIT 1)
    ORDER BY r.period_end DESC LIMIT $3`, [tsCode, type, limit]);
}

module.exports = { LEGACY_CAS_FIELD_MAP, UNVERIFIED_TUSHARE_WIDE, legacyMetricExpression, reportMarketPredicate, latestMarketReportPredicate, listAnnualStatements, listStatementRows };

'use strict';

const dict = require('../dataAccess/lixingerReportMetrics');
const contract = require('../domain/securityAnalysisContract');
const presentation = require('../domain/statementPresentation');
const repository = require('../repositories/stockStatementsRepository');
const FORMULA_VERSION = 'stock-statements-5';

const PERIOD_TYPES = new Set(['all', 'annual', 'semiannual', 'q1', 'q3', 'unknown']);
const COMPARES = new Set(['yoy', 'qoq', 'none']);
const STATEMENT_TYPES = new Set(['non_financial', 'bank', 'insurance', 'security', 'other_financial', 'reit']);

function normalizeOptions(options = {}) {
  const periodType = String(options.periodType || options.period_type || 'all').toLowerCase();
  const compare = String(options.compare || 'yoy').toLowerCase();
  return {
    periodType: PERIOD_TYPES.has(periodType) ? periodType : 'all',
    compare: COMPARES.has(compare) ? compare : 'yoy',
    scope: options.scope ? String(options.scope) : 'consolidated',
    limit: Math.max(3, Math.min(20, Number(options.limit) || 8)),
  };
}

function parseCoverage(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return null; }
}

function dateKey(value) { return String(value || '').slice(0, 10); }

function sameIdentity(current, prior) {
  const currentCurrency = String(current && current.currency_code || '').toUpperCase();
  const priorCurrency = String(prior && prior.currency_code || '').toUpperCase();
  return current && prior && currentCurrency && priorCurrency
    && currentCurrency === priorCurrency
    && current.company_id && String(current.company_id) === String(prior.company_id || '')
    && current.source_id && String(current.source_id) === String(prior.source_id || '')
    && current.accounting_standard && String(current.accounting_standard) === String(prior.accounting_standard || '')
    && current.statement_scope && String(current.statement_scope) === String(prior.statement_scope || '')
    && current.comp_type && String(current.comp_type) === String(prior.comp_type || '')
    // 历史理杏仁适配器曾把未知重述标志写成 0，不能把这些旧记录视为已确认未重述。
    && current.source_code !== 'lixinger_official' && prior.source_code !== 'lixinger_official'
    // source_version is a per-report content hash, not a shared revision basis.
    // An explicitly unadjusted pair is comparable; revisions need further evidence.
    && String(current.update_flag ?? '') === '0' && String(prior.update_flag ?? '') === '0';
}

function sameYearMonthDay(current, prior) {
  const now = dateKey(current.period_end), old = dateKey(prior.period_end);
  return /^\d{4}-\d{2}-\d{2}$/.test(now) && /^\d{4}-\d{2}-\d{2}$/.test(old)
    && now.slice(5) === old.slice(5) && Number(now.slice(0, 4)) - Number(old.slice(0, 4)) === 1;
}

function isPreviousQuarter(current, prior) {
  const now = dateKey(current.period_end), old = dateKey(prior.period_end);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(now) || !/^\d{4}-\d{2}-\d{2}$/.test(old)) return false;
  const [y, m, day] = now.split('-').map(Number), [py, pm, pd] = old.split('-').map(Number);
  if ((y - py) * 12 + m - pm !== 3) return false;
  const endOfMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day !== pd && !(day === endOfMonth(y, m) && pd === endOfMonth(py, pm))) return false;
  const previous = { q1: 'annual', semiannual: 'q1', q3: 'semiannual', annual: 'q3' };
  return previous[current.period_type] === prior.period_type;
}

function comparisonOf({ rows, index, metricCode, rawValue, statement, compare, measureType }) {
  if (compare === 'none') return { value: null, status: null, reason: null };
  if (measureType !== 'currency') return { value: null, status: contract.FIELD_STATUS.NOT_APPLICABLE, reason: 'comparison_method_unverified' };
  const current = rows[index];
  if (compare === 'qoq' && statement !== 'balance') {
    return { value: null, status: contract.FIELD_STATUS.NOT_APPLICABLE, reason: 'cumulative_flow_qoq_not_supported' };
  }
  // Current rows do not contain a verified period start/restatement basis for
  // cumulative flows, so an identical end date alone cannot establish YOY.
  if (compare === 'yoy' && statement !== 'balance') {
    return { value: null, status: contract.FIELD_STATUS.NOT_APPLICABLE, reason: 'flow_period_basis_unverified' };
  }
  const prior = compare === 'yoy'
    ? rows.find((row, rowIndex) => rowIndex > index && current.period_type !== 'unknown' && Boolean(current.period_type) && sameIdentity(current, row)
      && String(row.period_type || '') === String(current.period_type || '') && sameYearMonthDay(current, row))
    : rows.find((row, rowIndex) => rowIndex > index && sameIdentity(current, row) && isPreviousQuarter(current, row));
  if (!prior) return { value: null, status: contract.FIELD_STATUS.INSUFFICIENT_HISTORY, reason: 'comparable_period_missing' };
  const priorRaw = contract.finite(prior[metricCode]);
  if (rawValue === null || priorRaw === null) return { value: null, status: contract.FIELD_STATUS.SOURCE_UNAVAILABLE, reason: 'comparable_value_missing' };
  if (priorRaw === 0) return { value: null, status: contract.FIELD_STATUS.NOT_APPLICABLE, reason: 'zero_denominator' };
  if (priorRaw < 0 || rawValue < 0) return { value: null, status: contract.FIELD_STATUS.NOT_APPLICABLE, reason: 'negative_comparison_unverified' };
  return { value: (rawValue - priorRaw) / Math.abs(priorRaw), status: contract.FIELD_STATUS.AVAILABLE, reason: null };
}

function valueStatus(raw, coverage, code, sourceCode) {
  const value = contract.finite(raw);
  if (value !== null) return { value, status: contract.FIELD_STATUS.AVAILABLE, reason: null };
  if (sourceCode === 'tushare' && repository.UNVERIFIED_TUSHARE_WIDE.has(code)) {
    return { value: null, status: contract.FIELD_STATUS.SOURCE_UNAVAILABLE, reason: 'source_mapping_unverified' };
  }
  const requested = new Set((coverage && coverage.requested_metric_codes) || []);
  if (coverage && coverage.complete === false) return { value: null, status: contract.FIELD_STATUS.COLLECTION_INCOMPLETE, reason: 'source_batch_incomplete' };
  if (requested.has(code)) return { value: null, status: contract.FIELD_STATUS.SOURCE_NOT_DISCLOSED, reason: 'source_not_disclosed' };
  if (coverage) return { value: null, status: contract.FIELD_STATUS.SOURCE_UNAVAILABLE, reason: 'metric_not_requested' };
  return { value: null, status: contract.FIELD_STATUS.MISSING, reason: 'metric_missing' };
}

function reportDigestOf(rows) {
  return rows.map(row => `${row.report_id}:${row.source_version || ''}:${row.period_end || ''}:${row.period_type || ''}:${row.statement_revision || ''}`).join(',');
}

function statementAnalysisVersionOf({ canonicalCode, market = 'CN', type = 'balance', formulaVersion = FORMULA_VERSION, rows = [] } = {}) {
  return contract.analysisVersionOf({
    canonicalCode, formulaVersion,
    inputs: { market, type, reports: reportDigestOf(rows) },
  });
}

function metadataOf(row, market) {
  const coverage = parseCoverage(row.statement_coverage);
  const meta = contract.statementMetadataOf({
    report_id: row.report_id,
    period_end: dateKey(row.period_end),
    fiscal_year: row.fiscal_year || (market === 'CN' ? dateKey(row.period_end).slice(0, 4) : null),
    report_type_label: row.report_type_label || row.period_type,
    accounting_standard: row.accounting_standard,
    currency: row.currency_code,
    announced_at: row.announced_at,
    version: row.source_version,
    company_id: row.company_id,
  });
  return Object.assign(meta, {
    year: meta.fiscal_year || (market === 'CN' ? dateKey(row.period_end).slice(0, 4) : dateKey(row.period_end)),
    end_date: meta.period_end,
    period_type: row.period_type || null,
    report_type: row.report_type_label || row.period_type || row.report_type || meta.report_type,
    report_type_label: meta.report_type,
    source_report_type: row.report_type || null,
    fs_table_type: coverage && coverage.fs_table_type || null,
    scope: row.statement_scope || 'consolidated',
    source_id: row.source_id || null,
    source_version: row.source_version || null,
    available_at: row.available_at || null,
    currency: meta.currency,
  });
}

function buildStatementPayload({ market = 'CN', type = 'balance', rows = [], versionRows = rows, options = {}, formulaVersion = FORMULA_VERSION, canonicalCode } = {}) {
  const normalized = normalizeOptions(options);
  const types = [...new Set(rows.map(row => parseCoverage(row.statement_coverage))
    .map(coverage => coverage && coverage.fs_table_type).filter(Boolean))];
  const hasUnknownType = rows.length > 0 && rows.some(row => {
    const coverage = parseCoverage(row.statement_coverage);
    return !coverage || !STATEMENT_TYPES.has(String(coverage.fs_table_type || '').toLowerCase());
  });
  const ordered = [];
  for (const tableType of types) {
    try {
      const relationContext = `${market}|${tableType}`;
      ordered.push(...dict.metricsOfType(market, tableType)
        .filter(metric => metric.statement === type)
        .map(metric => ({ ...metric, relation_contexts: [relationContext, ...(hasUnknownType ? [`${market}|unknown`] : [])] })));
    }
    catch (_) { /* 旧记录类型无法识别时不猜测 */ }
  }
  const byCode = new Map();
  for (const metric of [...ordered, ...dict.metricsByStatement(market, type).map(item => ({ ...item, relation_contexts: [] }))]) {
    const existing = byCode.get(metric.code);
    if (!existing) {
      byCode.set(metric.code, metric);
    } else if (metric.relation_contexts && metric.relation_contexts.length) {
      existing.relation_contexts = [...new Set([...(existing.relation_contexts || []), ...metric.relation_contexts])];
    }
  }
  const metrics = [...byCode.values()];
  const currencies = [...new Set(rows.map(row => String(row.currency_code || '').toUpperCase()).filter(Boolean))];
  const currencyUnverified = row => {
    if (market !== 'HK' || row.source_code !== 'lixinger_official') return false;
    const currency = String(row.currency_code || '').trim().toUpperCase();
    const sourceCurrency = String(row.source_currency || '').trim().toUpperCase();
    const coverage = parseCoverage(row.statement_coverage);
    return !/^[A-Z]{3}$/.test(currency) || currency !== sourceCurrency || (currency !== 'HKD'
      && !(coverage && coverage.value_basis === 'source_original_t_o'));
  };
  const hasUnverifiedCurrency = rows.some(currencyUnverified);
  const periods = rows.map(row => metadataOf(row, market));
  const coverageRows = rows.map(row => parseCoverage(row.statement_coverage)).filter(Boolean);
  const requestedMetricCodes = [...new Set(coverageRows.flatMap(item => item.requested_metric_codes || []))];
  const returnedMetricCodes = [...new Set(coverageRows.flatMap(item => item.returned_metric_codes || []))];
  const analysisVersion = statementAnalysisVersionOf({ canonicalCode, market, type, formulaVersion, rows: versionRows });
  const fields = presentation.presentationOf(metrics, type, currencies.length === 1 && !hasUnverifiedCurrency ? currencies[0] : null)
    .filter(field => rows.some(row => contract.finite(row[dict.columnOf(field.code)]) !== null)
      || requestedMetricCodes.includes(field.code)
      || (rows.some(row => row.source_code === 'tushare')
        && (repository.UNVERIFIED_TUSHARE_WIDE.has(field.code) || field.code === 'cfs.crfrci')))
    .map(field => ({
      ...field,
      values: rows.map((row, index) => {
        const observed = contract.finite(row[dict.columnOf(field.code)]);
        const unverified = observed !== null && currencyUnverified(row) && ['currency', 'per_share'].includes(field.measure_type);
        const raw = unverified ? null : observed;
        const state = unverified ? { value: null, status: contract.FIELD_STATUS.SOURCE_UNAVAILABLE, reason: 'source_currency_unverified' }
          : valueStatus(raw, parseCoverage(row.statement_coverage), field.code, row.source_code);
        const comparison = raw === null ? { value: null, status: state.status, reason: state.reason }
          : comparisonOf({ rows, index, metricCode: dict.columnOf(field.code), rawValue: raw, statement: type, compare: normalized.compare, measureType: field.measure_type });
        return {
          value: presentation.normalizeMetricValue(raw, field, row.currency_code),
          status: state.status,
          reason: state.reason,
          change: comparison.value,
          yoy: normalized.compare === 'yoy' ? comparison.value : null,
          comparison_status: comparison.status,
          comparison_reason: comparison.reason,
        };
      }),
    }));
  const availablePeriods = versionRows.map(row => metadataOf(row, market));
  const availablePeriodTypes = [...new Set(availablePeriods.map(period => period.period_type).filter(Boolean))];
  const availableScopes = [...new Set(availablePeriods.map(period => period.scope).filter(Boolean))];
  return {
    market,
    type,
    name: dict.STATEMENT_LABEL[type],
    standard: dict.standardOf(market),
    formula_version: formulaVersion,
    analysis_version: analysisVersion,
    unit_label: hasUnverifiedCurrency ? '来源金额币种待核实；比例等按字段标注'
      : `原值按${currencies.length === 1 ? currencies[0] : '报告币种'}展示；金额折算为亿元，比例/每股按字段标注`,
    currency: currencies.length === 1 ? currencies[0] : null,
    currency_mixed: currencies.length > 1,
    report_ids: rows.map(row => row.report_id),
    periods,
    available_filters: { period_types: availablePeriodTypes, scopes: availableScopes, currencies },
    coverage: { requested_metric_codes: requestedMetricCodes, returned_metric_codes: returnedMetricCodes, complete: coverageRows.length ? coverageRows.every(item => item.complete !== false) : null },
    compare: normalized.compare,
    scope: normalized.scope,
    fields,
    status: periods.length ? contract.FIELD_STATUS.AVAILABLE : contract.FIELD_STATUS.MISSING,
  };
}

async function getStockStatements({ tsCode, market = 'CN', type = 'balance', limit = 8, requestedVersion = null, formulaVersion = FORMULA_VERSION, ...options } = {}) {
  if (!dict.STATEMENTS.includes(type)) throw new Error('三表类型无效');
  const normalized = normalizeOptions({ ...options, limit });
  const [rows, versionRows] = await Promise.all([
    repository.listStatementRows({ tsCode, market, type, limit: normalized.limit, periodType: normalized.periodType,
      scope: normalized.scope === 'all' ? null : normalized.scope }),
    repository.listStatementRows({ tsCode, market, type, limit: 20, periodType: null, scope: null }),
  ]);
  const payload = buildStatementPayload({ market, type, rows, versionRows, options: normalized, formulaVersion, canonicalCode: tsCode });
  const conflict = contract.versionConflict(requestedVersion, payload.analysis_version);
  if (conflict) {
    const error = new Error(conflict.error);
    error.status = 409;
    error.conflict = conflict;
    throw error;
  }
  return payload;
}

async function getStockStatementVersions({ tsCode, market = 'CN', formulaVersion = FORMULA_VERSION } = {}) {
  const entries = await Promise.all(dict.STATEMENTS.map(async type => {
    const rows = await repository.listStatementRows({ tsCode, market, type, limit: 20, periodType: null, scope: null });
    return [type, statementAnalysisVersionOf({ canonicalCode: tsCode, market, type, formulaVersion, rows })];
  }));
  return Object.fromEntries(entries);
}

module.exports = {
  FORMULA_VERSION, PERIOD_TYPES, COMPARES, normalizeOptions, buildStatementPayload,
  reportDigestOf, statementAnalysisVersionOf, getStockStatements, getStockStatementVersions,
};

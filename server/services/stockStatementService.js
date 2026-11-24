'use strict';

const dict = require('../dataAccess/lixingerReportMetrics');
const contract = require('../domain/securityAnalysisContract');
const presentation = require('../domain/statementPresentation');
const repository = require('../repositories/stockStatementsRepository');
const FORMULA_VERSION = 'stock-statements-7';

const PERIOD_TYPES = new Set(['all', 'annual', 'semiannual', 'quarter', 'q1', 'q3', 'unknown']);
const COMPARES = new Set(['yoy', 'qoq', 'none']);
const STATEMENT_TYPES = new Set(['non_financial', 'bank', 'insurance', 'security', 'other_financial', 'reit']);
const VALID_SCOPES = new Set(['consolidated', 'parent']);
const MARKET_VALID_STANDARDS = Object.freeze({
  CN: new Set(['CAS']),
  HK: new Set(['HKFRS', 'IFRS']),
});
// 展示结构只对已登记的来源启用：理杏仁官方，以及字段映射受控的 Tushare 历史。
const RELATION_SOURCE_WHITELIST = new Set(['lixinger_official', 'tushare']);

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

const KNOWN_PERIOD_TYPES = new Set(['annual', 'semiannual', 'q1', 'q3']);
const VERIFIED_FLOW_SOURCES = new Set(['lixinger_official', 'tushare']);

function sameIdentity(current, prior) {
  const currentCurrency = String(current && current.currency_code || '').toUpperCase();
  const priorCurrency = String(prior && prior.currency_code || '').toUpperCase();
  const currentSource = String(current && current.source_code || '');
  const priorSource = String(prior && prior.source_code || '');
  const currentFlag = current && current.update_flag != null && current.update_flag !== '' ? String(current.update_flag) : null;
  const priorFlag = prior && prior.update_flag != null && prior.update_flag !== '' ? String(prior.update_flag) : null;
  const bothLixinger = currentSource === 'lixinger_official' && priorSource === 'lixinger_official';
  // 非理杏仁来源必须双方均有明确未重述标志 '0'；理杏仁官方无 update_flag（null），只要双方均未标为明确重述 '1' 即可比。
  const restatementValid = bothLixinger
    ? (currentFlag !== '1' && priorFlag !== '1')
    : (currentFlag === '0' && priorFlag === '0');
  return Boolean(current && prior && currentCurrency && priorCurrency
    && currentCurrency === priorCurrency
    && current.company_id && String(current.company_id) === String(prior.company_id || '')
    && current.source_id && String(current.source_id) === String(prior.source_id || '')
    && current.accounting_standard && String(current.accounting_standard) === String(prior.accounting_standard || '')
    && current.statement_scope && String(current.statement_scope) === String(prior.statement_scope || '')
    && current.comp_type && String(current.comp_type) === String(prior.comp_type || '')
    && restatementValid);
}

function flowPeriodStartOf(row) {
  if (!row) return '';
  const cov = parseCoverage(row.statement_coverage);
  return dateKey(row.period_start || row.start_date || (cov && cov.period_start));
}

function hasSingleFlowPeriodBasis(row, market) {
  if (!row) return false;
  if (!KNOWN_PERIOD_TYPES.has(String(row.period_type || ''))) return false;
  if (!VERIFIED_FLOW_SOURCES.has(String(row.source_code || ''))) return false;
  const cov = parseCoverage(row.statement_coverage);
  if (cov && cov.complete === false) return false;
  const start = flowPeriodStartOf(row);
  if (start && !/^\d{4}-\d{2}-\d{2}$/.test(start)) return false;
  const isNaturalYearCas = String(market || '').toUpperCase() === 'CN'
    && String(row.accounting_standard || '').toUpperCase() === 'CAS';
  if (!isNaturalYearCas && !start) return false;
  return true;
}

function hasFlowPeriodBasis(current, prior, market) {
  if (!hasSingleFlowPeriodBasis(current, market) || !hasSingleFlowPeriodBasis(prior, market)) {
    return false;
  }
  if (String(current.period_type) !== String(prior.period_type)) return false;
  if (String(current.source_code || '') !== String(prior.source_code || '')) return false;
  const curStart = flowPeriodStartOf(current);
  const priorStart = flowPeriodStartOf(prior);
  if (curStart || priorStart) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(curStart) || !/^\d{4}-\d{2}-\d{2}$/.test(priorStart)) return false;
    if (curStart.slice(5) !== priorStart.slice(5) || Number(curStart.slice(0, 4)) - Number(priorStart.slice(0, 4)) !== 1) {
      return false;
    }
  }
  const hasCurFy = current.fiscal_year != null && current.fiscal_year !== '';
  const hasPriorFy = prior.fiscal_year != null && prior.fiscal_year !== '';
  if (hasCurFy !== hasPriorFy) return false;
  if (hasCurFy && Number(current.fiscal_year) - Number(prior.fiscal_year) !== 1) return false;
  return true;
}

function isCurrencyUnverified(row, market) {
  if (!row || market !== 'HK' || row.source_code !== 'lixinger_official') return false;
  const currency = String(row.currency_code || '').trim().toUpperCase();
  const sourceCurrency = String(row.source_currency || '').trim().toUpperCase();
  const coverage = parseCoverage(row.statement_coverage);
  return !/^[A-Z]{3}$/.test(currency) || currency !== sourceCurrency || (currency !== 'HKD'
    && !(coverage && coverage.value_basis === 'source_original_t_o'));
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

function comparisonOf({ rows, comparisonRows, index, metricCode, rawValue, statement, compare, measureType, market }) {
  if (compare === 'none') return { value: null, status: null, reason: null };
  if (measureType !== 'currency') return { value: null, status: contract.FIELD_STATUS.NOT_APPLICABLE, reason: 'comparison_method_unverified' };
  const current = rows[index];
  if (compare === 'qoq' && statement !== 'balance') {
    return { value: null, status: contract.FIELD_STATUS.NOT_APPLICABLE, reason: 'cumulative_flow_qoq_not_supported' };
  }
  const poolRows = Array.isArray(comparisonRows) && comparisonRows.length ? comparisonRows : rows;
  const prior = compare === 'yoy'
    ? poolRows.find(row => row && row.report_id !== current.report_id && dateKey(row.period_end) < dateKey(current.period_end)
      && current.period_type !== 'unknown' && Boolean(current.period_type) && sameIdentity(current, row)
      && String(row.period_type || '') === String(current.period_type || '') && sameYearMonthDay(current, row))
    : poolRows.find(row => row && row.report_id !== current.report_id && dateKey(row.period_end) < dateKey(current.period_end)
      && sameIdentity(current, row) && isPreviousQuarter(current, row));
  if (compare === 'yoy' && statement !== 'balance') {
    if (!prior) {
      return hasSingleFlowPeriodBasis(current, market)
        ? { value: null, status: contract.FIELD_STATUS.INSUFFICIENT_HISTORY, reason: 'comparable_period_missing' }
        : { value: null, status: contract.FIELD_STATUS.NOT_APPLICABLE, reason: 'flow_period_basis_unverified' };
    }
    if (!hasFlowPeriodBasis(current, prior, market)) {
      return { value: null, status: contract.FIELD_STATUS.NOT_APPLICABLE, reason: 'flow_period_basis_unverified' };
    }
  }
  if (!prior) return { value: null, status: contract.FIELD_STATUS.INSUFFICIENT_HISTORY, reason: 'comparable_period_missing' };
  if (isCurrencyUnverified(prior, market)) {
    return { value: null, status: contract.FIELD_STATUS.SOURCE_UNAVAILABLE, reason: 'comparable_value_missing' };
  }
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
  return rows.map(row => `${row.report_id}:${row.source_version || ''}:${row.period_end || ''}:${row.period_type || ''}:${row.period_start || ''}:${row.statement_revision || ''}`).join(',');
}

function statementAnalysisVersionOf({
  canonicalCode,
  market = 'CN',
  type = 'balance',
  formulaVersion = FORMULA_VERSION,
  presentationVersion = presentation.PRESENTATION_VERSION,
  ruleVersion = dict.HIERARCHY_RULE_VERSION,
  rows = [],
} = {}) {
  return contract.analysisVersionOf({
    canonicalCode, formulaVersion,
    inputs: { market, type, presentationVersion, ruleVersion, reports: reportDigestOf(rows) },
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

function buildStatementPayload({ market = 'CN', type = 'balance', rows = [], comparisonRows = null, versionRows = rows, options = {}, formulaVersion = FORMULA_VERSION, canonicalCode } = {}) {
  const normalized = normalizeOptions(options);
  const types = [...new Set(rows.map(row => parseCoverage(row.statement_coverage))
    .map(coverage => coverage && coverage.fs_table_type).filter(Boolean))];
  const hasUnknownType = rows.length > 0 && rows.some(row => {
    const coverage = parseCoverage(row.statement_coverage);
    return !coverage || !STATEMENT_TYPES.has(String(coverage.fs_table_type || '').toLowerCase());
  });
  // A 股财报历史未写 __statement_coverage：仅在整表完全没有类型证据时，才用公司行业分类
  // 做一次保守推断；已有类型但混有未知期（港股现状）仍按 unknown 阻断，不靠推断补齐。
  const inferredType = types.length
    ? null
    : presentation.inferTableTypeFromIndustry(market, rows.map(row => row.industry));
  const effectiveTypes = types.length ? types : (inferredType ? [inferredType] : []);
  // 关系描述适用于整张多期表，不能只检查包含该字段的类型；其他期的类型也参与门禁。
  const relationContexts = effectiveTypes.map(tableType => `${market}|${String(tableType).toLowerCase()}`);
  if (hasUnknownType && !inferredType) relationContexts.push(`${market}|unknown`);
  // 报告来源只决定金额口径，不决定展示结构：父子关系来自按 `市场|报表类型` 核验的字典，
  // 金额的口径问题由 UNVERIFIED_TUSHARE_WIDE 单独屏蔽。因此结构只要求来源是可追溯登记过的
  // （理杏仁官方、Tushare 受控映射）；出现未登记来源时仍整表关闭，不让未知来源继承已核验层级。
  // 早前按「非理杏仁即阻断」会把最近几期恰好都来自 Tushare 的证券（如 600519.SH）整表压平。
  const hasUnverifiedSource = !rows.every(row => RELATION_SOURCE_WHITELIST.has(String(row.source_code || '')));
  if (hasUnverifiedSource) {
    relationContexts.push(`${market}|unverified_source`);
  }
  const validStandards = MARKET_VALID_STANDARDS[String(market || '').toUpperCase()] || new Set();
  const rowStandards = rows.map(row => String(row.accounting_standard || '').trim().toUpperCase());
  const rowScopes = rows.map(row => String(row.statement_scope || '').trim().toLowerCase());
  const rowFormatVersions = rows.map(row => {
    const coverage = parseCoverage(row.statement_coverage);
    return String((coverage && (coverage.presentation_version || coverage.format_version))
      || row.presentation_version || row.format_version || '').trim().toUpperCase();
  });
  const standards = [...new Set(rowStandards.filter(Boolean))];
  const scopes = [...new Set(rowScopes.filter(Boolean))];
  const expectedBaselineFormats = String(market || '').toUpperCase() === 'CN'
    ? new Set(['CAS_2019', 'DEFAULT'])
    : new Set(['HKAS_1', 'HKFRS_LEGACY', 'DEFAULT']);
  const hasUnknownFormat = rows.length > 0 && rowFormatVersions.some(fmt => !fmt);
  const hasBasisConflict = rows.length > 0 && (
    rowStandards.some(std => !validStandards.has(std))
    || standards.length !== 1
    || rowScopes.some(sc => !VALID_SCOPES.has(sc))
    || scopes.length !== 1
    || new Set(rowFormatVersions).size > 1
    || rowFormatVersions.some(fmt => fmt && !expectedBaselineFormats.has(fmt))
  );
  const typeMetricsByType = new Map();
  const ordered = [];
  for (const tableType of effectiveTypes) {
    try {
      const list = dict.metricsOfType(market, tableType).filter(metric => metric.statement === type);
      typeMetricsByType.set(tableType, new Map(list.map(metric => [metric.code, metric])));
      ordered.push(...list);
    }
    catch (_) { /* 旧记录类型无法识别时不猜测 */ }
  }
  const byCode = new Map();
  for (const metric of [...ordered, ...dict.metricsByStatement(market, type)]) {
    if (!byCode.has(metric.code)) {
      const contextRules = [];
      for (const tableType of effectiveTypes) {
        const typeMetric = typeMetricsByType.get(tableType)?.get(metric.code) || null;
        contextRules.push({
          context: `${market}|${String(tableType).toLowerCase()}`,
          rule: typeMetric ? typeMetric.hierarchy_rule || null : null,
        });
      }
      if (hasUnknownType && !inferredType) {
        contextRules.push({ context: `${market}|unknown`, rule: null });
      }
      if (hasUnverifiedSource) {
        contextRules.push({ context: `${market}|unverified_source`, rule: null });
      }
      if (hasBasisConflict) {
        contextRules.push({ context: `${market}|basis_conflict`, rule: null, reason: 'basis_conflict' });
      }
      byCode.set(metric.code, {
        ...metric,
        relation_contexts: relationContexts,
        context_rules: contextRules,
        has_basis_conflict: hasBasisConflict,
        has_unknown_format: hasUnknownFormat,
      });
    }
  }
  const metrics = [...byCode.values()];
  const currencies = [...new Set(rows.map(row => String(row.currency_code || '').toUpperCase()).filter(Boolean))];
  const currencyUnverified = row => isCurrencyUnverified(row, market);
  const hasUnverifiedCurrency = rows.some(currencyUnverified);
  const periods = rows.map(row => {
    const meta = metadataOf(row, market);
    if (!meta.fs_table_type && inferredType) meta.fs_table_type = inferredType;
    return meta;
  });
  const coverageRows = rows.map(row => parseCoverage(row.statement_coverage)).filter(Boolean);
  const requestedMetricCodes = [...new Set(coverageRows.flatMap(item => item.requested_metric_codes || []))];
  const returnedMetricCodes = [...new Set(coverageRows.flatMap(item => item.returned_metric_codes || []))];
  const analysisVersion = statementAnalysisVersionOf({ canonicalCode, market, type, formulaVersion, rows: versionRows });
  const visibleFields = presentation.presentationOf(metrics, type, currencies.length === 1 && !hasUnverifiedCurrency ? currencies[0] : null)
    .filter(field => rows.some(row => contract.finite(row[dict.columnOf(field.code)]) !== null)
      || requestedMetricCodes.includes(field.code)
      || (rows.some(row => row.source_code === 'tushare')
        && (repository.UNVERIFIED_TUSHARE_WIDE.has(field.code) || field.code === 'cfs.crfrci')));
  const fields = presentation.rebaseVisibleHierarchy(visibleFields).map(field => ({
      ...field,
      values: rows.map((row, index) => {
        const observed = contract.finite(row[dict.columnOf(field.code)]);
        const unverified = observed !== null && currencyUnverified(row) && ['currency', 'per_share'].includes(field.measure_type);
        const raw = unverified ? null : observed;
        const state = unverified ? { value: null, status: contract.FIELD_STATUS.SOURCE_UNAVAILABLE, reason: 'source_currency_unverified' }
          : valueStatus(raw, parseCoverage(row.statement_coverage), field.code, row.source_code);
        const comparison = raw === null ? { value: null, status: state.status, reason: state.reason }
          : comparisonOf({ rows, comparisonRows, index, metricCode: dict.columnOf(field.code), rawValue: raw, statement: type, compare: normalized.compare, measureType: field.measure_type, market });
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
  const presentationModel = presentation.buildStatementPresentation(fields, {
    metrics,
    statement: type,
    ruleVersion: dict.HIERARCHY_RULE_VERSION,
  });
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
    presentation: presentationModel,
    status: periods.length ? contract.FIELD_STATUS.AVAILABLE : contract.FIELD_STATUS.MISSING,
  };
}

function filterRowsByOptions(allRows, normalized) {
  return allRows.filter(row => {
    if (normalized.periodType && normalized.periodType !== 'all') {
      if (normalized.periodType === 'quarter') {
        if (row.period_type !== 'q1' && row.period_type !== 'q3') return false;
      } else if (row.period_type !== normalized.periodType) {
        return false;
      }
    }
    if (normalized.scope && normalized.scope !== 'all') {
      if (String(row.statement_scope || 'consolidated') !== normalized.scope) return false;
    }
    return true;
  }).slice(0, normalized.limit);
}

async function getStockStatements({ tsCode, market = 'CN', type = 'balance', limit = 8, requestedVersion = null, formulaVersion = FORMULA_VERSION, ...options } = {}) {
  if (!dict.STATEMENTS.includes(type)) throw new Error('三表类型无效');
  const normalized = normalizeOptions({ ...options, limit });
  // 单次全量快照读取：展示行、比较基期池与版本摘要共享同一份数据库读取，避免两路读取修订漂移、筛选漏基期或长窗口版本遗漏。
  const allRows = await repository.listStatementRows({ tsCode, market, type, limit: null, periodType: null, scope: null });
  const rows = filterRowsByOptions(allRows, normalized);
  const payload = buildStatementPayload({ market, type, rows, comparisonRows: allRows, versionRows: allRows, options: normalized, formulaVersion, canonicalCode: tsCode });
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
    const rows = await repository.listStatementRows({ tsCode, market, type, limit: null, periodType: null, scope: null });
    return [type, statementAnalysisVersionOf({ canonicalCode: tsCode, market, type, formulaVersion, rows })];
  }));
  return Object.fromEntries(entries);
}

module.exports = {
  FORMULA_VERSION, PERIOD_TYPES, COMPARES, normalizeOptions, buildStatementPayload,
  reportDigestOf, statementAnalysisVersionOf, getStockStatements, getStockStatementVersions,
};

// 证券分析市场中立合同（方案第十四节 14.3 / 14.4 / 14.6.1）。
// 纯计算：不取数、不写库、不联网。A 股既有公式不经过本模块，港股走这里的口径。
// 逐指标状态与数值分开返回：0 是有效事实，未知一律 null，前端不得用布尔把未知变成「否」。
'use strict';

const crypto = require('crypto');

const FIELD_STATUS = Object.freeze({
  AVAILABLE: 'available',
  INSUFFICIENT_HISTORY: 'insufficient_history',
  NOT_APPLICABLE: 'not_applicable',
  SOURCE_UNAVAILABLE: 'source_unavailable',
  MISSING: 'missing',
});

const SHARE_SCOPE = Object.freeze({
  MATCHED: 'matched_tradable',          // 与股价同一交易证券、同一币种、范围已验证的股份
  H_SHARE: 'h_share',                   // 仅 H 股股份
  COMPANY_TOTAL: 'company_total',       // 公司全体股本
  UNKNOWN: 'unknown',
});

const CN_CODE_RE = /^\d{6}\.(SH|SZ|BJ)$/;
const HK_CODE_RE = /^\d{5}\.HK$/;
const NON_ORDINARY_HK = /(ETF|REIT|REITs|WARRANT|CBBC|权证|認股證|牛熊證|基金|信托基金|ETF基金)/i;

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// 代码归一：完整标准代码精确命中优先；六位数字一律按内地代码处理，绝不静默改成港股。
// 无法唯一确定的输入返回 ambiguous，由调用方列出候选供选择，不自动选首项。
function normalizeAnalyzableCode(raw) {
  const text = String(raw == null ? '' : raw).trim().toUpperCase();
  if (!text) return { ok: false, reason: 'empty' };
  if (text.length > 24) return { ok: false, reason: 'too_long' };

  if (HK_CODE_RE.test(text)) return { ok: true, code: text, market: 'HK' };
  if (CN_CODE_RE.test(text)) return { ok: true, code: text, market: 'CN' };

  const bare = text.replace(/\.(HK|SH|SZ|BJ)$/, '');
  if (!/^\d+$/.test(bare)) return { ok: false, ambiguous: true, reason: 'name_or_ambiguous' };

  // 显式带 .HK 但位数不是 5 位（例如 700.HK）按港股补零；不带后缀的 1—5 位数字按港股补零。
  const hkIntended = /\.HK$/.test(text) || bare.length <= 5;
  if (hkIntended && bare.length <= 5) {
    return { ok: true, code: `${bare.padStart(5, '0')}.HK`, market: 'HK' };
  }
  // 六位数字不猜市场后缀，交给统一身份服务按共用分类规则纠正（920002.SH → 920002.BJ）。
  if (bare.length === 6) return { ok: false, ambiguous: true, reason: 'cn_code_needs_suffix', digits: bare };
  return { ok: false, reason: 'invalid_code' };
}

function marketOf(canonicalCode) {
  const normalized = normalizeAnalyzableCode(canonicalCode);
  return normalized.ok ? normalized.market : null;
}

// 主档类型闸门：只接受可识别的港股普通股票。类型未知时明确返回 unknown，不按代码或行业名称猜。
function classifyHkInstrument(instrument) {
  if (!instrument) return { ok: false, status: FIELD_STATUS.MISSING, reason: 'instrument_missing' };
  if (String(instrument.asset_class || '') !== 'stock') {
    return { ok: false, status: FIELD_STATUS.NOT_APPLICABLE, reason: 'not_a_stock' };
  }
  const market = String(instrument.market || '').toUpperCase();
  if (market !== 'HK' && !HK_CODE_RE.test(String(instrument.canonical_code || '').toUpperCase())) {
    return { ok: false, status: FIELD_STATUS.NOT_APPLICABLE, reason: 'not_hk' };
  }
  const raw = instrument.raw_data || {};
  const marker = [instrument.name, instrument.security_type, raw.security_type, raw.instrument_type, raw.asset_type, raw.market, raw.fs_table_type]
    .filter(Boolean).map(String).join(' ');
  if (NON_ORDINARY_HK.test(marker)) {
    return { ok: false, status: FIELD_STATUS.NOT_APPLICABLE, reason: 'non_ordinary_security' };
  }
  // 金融公司按已验证的报表类型走适用指标，不套普通企业结论。
  const tableType = String(raw.fs_table_type || raw.fsTableType || '').toLowerCase();
  const financial = ['bank', 'insurance', 'security', 'other_financial'].includes(tableType);
  return {
    ok: true,
    status: FIELD_STATUS.AVAILABLE,
    financial,
    reportTableType: tableType || null,
    currency: String(instrument.currency_code || raw.currency || raw.curr_type || '').toUpperCase() || null,
    securityTypeKnown: Boolean(raw.security_type || raw.instrument_type || raw.fs_table_type),
  };
}

function metric(value, status = FIELD_STATUS.AVAILABLE, reason = null) {
  const numeric = finite(value);
  const resolved = numeric === null && status === FIELD_STATUS.AVAILABLE ? FIELD_STATUS.MISSING : status;
  return { value: numeric, status: resolved, reason: resolved === FIELD_STATUS.AVAILABLE ? null : reason };
}

// 币种换算：rate 恒表示「1 单位 from = rate 单位 to」，方向、日期与来源缺一不可。
function convertAmount({ value, from, to, rate, rateDate, rateSource, direction } = {}) {
  const amount = finite(value);
  const factor = finite(rate);
  if (from && to && String(from).toUpperCase() === String(to).toUpperCase()) {
    return metric(amount, FIELD_STATUS.AVAILABLE);
  }
  if (amount === null || factor === null || factor <= 0 || !from || !to || !rateDate || !rateSource
      || (direction && !['from_to', 'to_from'].includes(direction))) {
    return metric(null, FIELD_STATUS.MISSING, 'currency_rate_incomplete');
  }
  const applied = direction === 'to_from' ? amount / factor : amount * factor;
  return Object.assign(metric(applied), {
    currency: String(to).toUpperCase(), from: String(from).toUpperCase(), rate: factor, rateDate, rateSource, direction: direction || 'from_to',
  });
}

// 市值：分子（股价×股份）与分母（利润/净资产）必须同范围同币种。
// 范围未知或只有公司全体股本时，不允许用 H 股价乘全体股本生成误导市值。
function marketCapOf({ price, shares, shareScope, priceCurrency, verifiedMarketCap, verifiedScope } = {}) {
  const p = finite(price), s = finite(shares);
  const scope = shareScope || SHARE_SCOPE.UNKNOWN;
  if (p === null || !priceCurrency) return metric(null, FIELD_STATUS.MISSING, 'price_or_currency_missing');
  if (scope === SHARE_SCOPE.UNKNOWN || scope === SHARE_SCOPE.COMPANY_TOTAL || s === null) {
    const verified = finite(verifiedMarketCap);
    if (verified === null || !verifiedScope) return metric(null, FIELD_STATUS.MISSING, 'share_scope_unverified');
    return Object.assign(metric(verified), { currency: priceCurrency, scope: verifiedScope, source: 'verified_source_valuation' });
  }
  return Object.assign(metric(p * s), { currency: String(priceCurrency).toUpperCase(), scope, source: 'computed_matched_scope' });
}

function peOf(marketCap, profit) {
  const cap = marketCap && marketCap.value !== null ? marketCap.value : null;
  const p = finite(profit);
  if (cap === null) return metric(null, FIELD_STATUS.MISSING, 'market_cap_unavailable');
  if (p === null) return metric(null, FIELD_STATUS.MISSING, 'profit_unavailable');
  if (p === 0) return metric(null, FIELD_STATUS.NOT_APPLICABLE, 'zero_profit');
  if (p < 0) return Object.assign(metric(cap / p), { note: 'negative_pe_loss_fact' });
  return metric(cap / p);
}

// TTM：最近完整财年 + 本期累计 - 上年同财年同期累计；只有三个期间连续且可比时适用。
function ttmForFiscalYear({ annual, currentCumulative, priorComparableCumulative, comparable, fiscalYearChanged } = {}) {
  const a = finite(annual), c = finite(currentCumulative), p = finite(priorComparableCumulative);
  if (fiscalYearChanged || comparable === false) {
    return metric(null, FIELD_STATUS.NOT_APPLICABLE, 'fiscal_year_changed_or_not_comparable');
  }
  if (a === null) return metric(a, FIELD_STATUS.AVAILABLE);
  if (c === null || p === null) return metric(null, FIELD_STATUS.INSUFFICIENT_HISTORY, 'missing_comparable_period');
  return metric(a + c - p);
}

// 十年稳定性：只有十个完整可比财年均有证据才给结论；缺失不是失败，也不是通过。
function tenYearStability(years) {
  const rows = Array.isArray(years) ? years.slice(0, 10) : [];
  const complete = rows.length === 10 && rows.every(row => row && row.evidence === true);
  if (!complete) return { status: FIELD_STATUS.INSUFFICIENT_HISTORY, value: null, coveredYears: rows.filter(row => row && row.evidence === true).length };
  const profitable = rows.every(row => finite(row.profit) !== null && finite(row.profit) > 0);
  const dividends = rows.every(row => finite(row.dividend) !== null && finite(row.dividend) > 0);
  return { status: FIELD_STATUS.AVAILABLE, value: { profitable, dividends }, coveredYears: 10 };
}

// 分红：同事件按来源原生键去重；同日两笔独立事件保留；只有每股现金时不推公司分红总额。
function dividendEventsOf(events) {
  const bySourceKey = new Map();
  (events || []).forEach(event => {
    if (!event) return;
    const key = String(event.source_event_key || event.event_key || `${event.ex_date}|${event.cash_per_share}|${event.fiscal_year}`);
    const existing = bySourceKey.get(key);
    if (!existing || (event.revision || 0) >= (existing.revision || 0)) bySourceKey.set(key, event);
  });
  return [...bySourceKey.values()];
}

function dividendYieldOf({ events, price, priceCurrency, within12m, eventCurrency } = {}) {
  const p = finite(price);
  const distinct = dividendEventsOf(events);
  const eligible = distinct.filter(event => within12m === undefined || within12m(event));
  const cash = eligible.reduce((sum, event) => sum + (finite(event && event.cash_per_share) || 0), 0);
  const currencyMismatch = eligible.some(event => event && event.currency && priceCurrency
    && String(event.currency).toUpperCase() !== String(priceCurrency).toUpperCase());
  if (p === null || p <= 0 || !priceCurrency || currencyMismatch || !eligible.length) {
    return { yield: metric(null, FIELD_STATUS.MISSING, 'dividend_yield_inputs_incomplete'), events: distinct.length, totalAmount: null };
  }
  const hasCompanyAmount = eligible.some(event => finite(event.company_amount) !== null);
  return {
    yield: metric(cash / p),
    events: distinct.length,
    totalAmount: hasCompanyAmount ? eligible.reduce((sum, event) => sum + (finite(event.company_amount) || 0), 0) : null,
    currency: String(eventCurrency || priceCurrency).toUpperCase(),
  };
}

// FCF：缺资本开支不等于零，不能退化成经营现金流。
function freeCashFlowOf({ operating, capex } = {}) {
  const o = finite(operating), c = finite(capex);
  if (o === null || c === null) return metric(null, FIELD_STATUS.MISSING, 'capex_or_operating_missing');
  return metric(o - c);
}

// 正估值分位：当前值非正不输出；历史样本排除非正并留排除数。
function positiveValuationPercentile(samples, current) {
  const value = finite(current);
  if (value === null || value <= 0) return { status: FIELD_STATUS.NOT_APPLICABLE, value: null, excluded: 0 };
  const numbers = (samples || []).map(finite).filter(v => v !== null);
  const positive = numbers.filter(v => v > 0).sort((a, b) => a - b);
  if (positive.length < 2) return { status: FIELD_STATUS.INSUFFICIENT_HISTORY, value: null, excluded: numbers.length - positive.length };
  const below = positive.filter(v => v < value).length;
  return {
    status: FIELD_STATUS.AVAILABLE,
    value: Math.min(1, Math.max(0, below / (positive.length - 1))),
    sampleCount: positive.length,
    excluded: numbers.length - positive.length,
  };
}

// 价格与估值各自独立：缺估值不清空股价；缺复权因子时相关指标不可算但价格仍可显示（标注未复权）。
function priceSeriesStatus({ prices, valuations, adjustmentFactors } = {}) {
  const priceRows = (prices || []).filter(row => finite(row && row.close) !== null);
  const valuationRows = (valuations || []).filter(row => finite(row && (row.pe_ttm ?? row.pb)) !== null);
  const hasFactors = (adjustmentFactors || []).some(row => finite(row && row.adj_factor) !== null);
  return {
    prices: { available: priceRows.length > 0, count: priceRows.length, adjusted: hasFactors },
    valuations: { available: valuationRows.length > 0, count: valuationRows.length },
    adjustedMetrics: metric(hasFactors && priceRows.length ? 1 : null, hasFactors ? FIELD_STATUS.AVAILABLE : FIELD_STATUS.NOT_APPLICABLE, 'no_reliable_adjustment_factor'),
  };
}

// 报告元数据：期末、类型、币种、版本来自实际报告，不按月份猜类型。
function statementMetadataOf(report) {
  if (!report) return { status: FIELD_STATUS.MISSING, reason: 'report_missing' };
  const currency = String(report.currency || report.currency_code || '').toUpperCase() || null;
  const reportType = String(report.report_type_label || report.period_type || '').trim() || null;
  return {
    status: FIELD_STATUS.AVAILABLE,
    period_end: report.period_end || null,
    fiscal_year: report.fiscal_year || null,
    report_type: reportType,
    accounting_standard: String(report.accounting_standard || '').toUpperCase() || null,
    currency,
    unit: report.unit || null,
    announced_at: report.announced_at || null,
    report_id: report.report_id || null,
    version: report.version || null,
    company_id: report.company_id || null,
  };
}

function statementUnitOf({ currency, scale, perShare } = {}) {
  if (perShare) return `${currency || '原币'}/股`;
  if (!currency || !scale) return null;
  return `${currency}·${scale}`;
}

// 分析版本：完整身份 + 公式版本 + 各输入版本摘要。三表请求携带该版本，只读取对应已存报告。
function analysisVersionOf({ canonicalCode, formulaVersion, inputs } = {}) {
  if (!canonicalCode || !formulaVersion) return null;
  const ordered = Object.keys(inputs || {}).sort().map(key => `${key}:${inputs[key] == null ? '-' : inputs[key]}`);
  return crypto.createHash('sha256').update([canonicalCode, formulaVersion, ...ordered].join('|')).digest('hex').slice(0, 16);
}

function versionConflict(requested, actual) {
  if (!requested) return null; // 旧 A 股调用保持兼容
  return requested === actual ? null : { status: 409, error: '分析数据已更新，请重新读取', requested, actual };
}

// 单一身份 + 市场 + 目标日的数据集范围证据键；单股不发布市场全集分区。
function datasetScopeOf({ market, targetDate, targetCodes } = {}) {
  if (!market || !targetDate) return null;
  const codes = Array.isArray(targetCodes) && targetCodes.length ? [...new Set(targetCodes)].sort().join(',') : 'market';
  return { market: String(market).toUpperCase(), targetDate, scope: codes === 'market' ? 'market' : `security:${codes}` };
}

module.exports = {
  FIELD_STATUS,
  SHARE_SCOPE,
  CN_CODE_RE,
  HK_CODE_RE,
  finite,
  metric,
  normalizeAnalyzableCode,
  marketOf,
  classifyHkInstrument,
  convertAmount,
  marketCapOf,
  peOf,
  ttmForFiscalYear,
  tenYearStability,
  dividendEventsOf,
  dividendYieldOf,
  freeCashFlowOf,
  positiveValuationPercentile,
  priceSeriesStatus,
  statementMetadataOf,
  statementUnitOf,
  analysisVersionOf,
  versionConflict,
  datasetScopeOf,
};

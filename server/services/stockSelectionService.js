// 投资策略选股中心：用例编排（方案第 7、9 节）。
// 职责：把标准事实读成时点快照 → 调纯规则/组合算法 → 裁决数据质量 → 在事务里落库与发布。
// 本文件只读库内已落库事实，页面与接口不得在这里触发外部采集。
'use strict';

const crypto = require('crypto');
const RULES = require('../domain/stockSelectionRules');
const { loadFinancialSourceGaps, sourceGapYearsOf, loadPbGapDays, pbGapFullyRegistered } = require('../domain/financialSourceGaps');
const RULES_V2 = require('../domain/stockSelectionRulesV2');
const GRAHAM_RULES = require('../domain/stockSelectionGrahamRules');
const PORTFOLIO = require('../domain/stockSelectionPortfolio');
const PERIODS = require('./stockSelectionPeriods');
const readinessService = require('./stockSelectionReadiness');
const repo = require('../repositories/stockSelectionRepository');
const { withTransaction } = require('../db/transaction');
const CoreDate = require('../../public/shared/core-date.js');

const STRATEGY_VERSION = 'v1';
const STRATEGY_CODES = Object.freeze([RULES.STRATEGY_CODE, RULES_V2.STRATEGY_CODE_V2, GRAHAM_RULES.STRATEGY_CODE_GRAHAM]);
/**
 * 默认激活策略：由 STOCK_SELECTION_STRATEGY 显式指定，未配置时保持 V1。
 * 这是方案 27.13 的上线顺序决定的——V2 必须先以影子批次跑满两个完整周，
 * 由发布对话确认后再切换默认值；代码上线不等于策略切换，不能悄悄改现网业务结论。
 */
const DEFAULT_STRATEGY_CODE = (() => {
  const code = String(process.env.STOCK_SELECTION_STRATEGY || '').trim().toLowerCase();
  return STRATEGY_CODES.includes(code) ? code : RULES.STRATEGY_CODE;
})();
const MARKET_LABEL = Object.freeze({ CN: 'A股', HK: '港股' });
// 运行类型 → 信号周期：季度保留原 quarter，日/周新增；预览与个人不做正式周期发布，归属日。
const PERIOD_TYPE_OF_KIND = Object.freeze({
  quarterly: 'quarter', daily: 'day', weekly: 'week', preview: 'day', personal: 'day',
});
// 收盘可见时点：A股 15:00、港股 16:00（当地）。只有日期没有时刻的公告保守地从下一交易日视为可用。
const CLOSE_CUTOFF = Object.freeze({ CN: 'T15:00:00+08:00', HK: 'T16:00:00+08:00' });

function pad2(value) { return String(value).padStart(2, '0'); }

function quarterOf(date) {
  const month = Number(String(date).slice(5, 7));
  return `${String(date).slice(0, 4)}Q${Math.ceil(month / 3)}`;
}

function quarterEndDate(quarter) {
  const match = /^(\d{4})Q([1-4])$/.exec(String(quarter || ''));
  if (!match) return null;
  const year = Number(match[1]);
  const q = Number(match[2]);
  const month = q * 3;
  const days = [31, (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return `${year}-${pad2(month)}-${pad2(days[month - 1])}`;
}

function shiftYears(date, years) {
  const year = Number(String(date).slice(0, 4)) - years;
  const month = Number(String(date).slice(5, 7));
  const day = Number(String(date).slice(8, 10));
  const days = [31, (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return `${year}-${pad2(month)}-${pad2(Math.min(day, days[month - 1]))}`;
}

function shiftMonths(date, months) {
  const total = Number(String(date).slice(0, 4)) * 12 + (Number(String(date).slice(5, 7)) - 1) - months;
  const year = Math.floor(total / 12);
  const month = total % 12 + 1;
  const days = [31, (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const day = Math.min(Number(String(date).slice(8, 10)), days[month - 1]);
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function knowledgeCutoffFor(market, asOfDate) {
  return `${asOfDate}${CLOSE_CUTOFF[market] || 'T15:00:00+08:00'}`;
}

function hashOf(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * 批量取数执行器：事务连接上不允许并发发送查询（pg 会告警并可能错序），
 * 因此在事务内按顺序执行；无事务（只读预览）时并行，减少往返。
 */
async function runBatched(tasks, tx) {
  if (tx) {
    const results = [];
    for (const task of tasks) results.push(await task());
    return results;
  }
  return Promise.all(tasks.map(task => task()));
}

/** 季度末目标日：取该市场本地交易日历中季度最后一个有效交易日。 */
async function resolveQuarterTarget({ market, quarter }, tx) {
  const end = quarterEndDate(quarter);
  if (!end) {
    const error = new Error('季度参数不合法');
    error.status = 400;
    throw error;
  }
  const start = shiftMonths(end, 1);
  const calendar = await repo.loadCalendar({ market, fromDate: start, toDate: end }, tx);
  if (!calendar.length) return { asOfDate: null, reason: 'calendar_unavailable', quarterEnd: end };
  const asOfDate = calendar[calendar.length - 1];
  if (asOfDate !== end) {
    // 季度末恰逢休市时用当月最后一个交易日；跨月则说明日历缺档。
    const sameMonth = calendar.filter(day => day.slice(0, 7) === end.slice(0, 7));
    if (!sameMonth.length) return { asOfDate: null, reason: 'calendar_incomplete', quarterEnd: end };
    return { asOfDate: sameMonth[sameMonth.length - 1], quarterEnd: end };
  }
  return { asOfDate, quarterEnd: end };
}

function normalizeMarket(market) {
  const value = String(market || '').toUpperCase();
  if (!MARKET_LABEL[value]) {
    const error = new Error('市场参数不合法');
    error.status = 400;
    throw error;
  }
  return value;
}

/** 策略代码规范化：只接受已登记的策略，未知代码直接 400，不静默退回默认。 */
function normalizeStrategyCode(value) {
  const code = String(value || DEFAULT_STRATEGY_CODE).toLowerCase();
  if (!STRATEGY_CODES.includes(code)) {
    const error = new Error('策略版本不合法');
    error.status = 400;
    throw error;
  }
  return code;
}

/**
 * V2 参数覆盖白名单：当前为空。
 * 阈值（maxPb=1.5、乘积 22.5、三倍极值比）与 R02 证据政策只能随公式/策略版本固化，
 * 浏览器请求不得覆盖公共策略——这是方案 27.4 的明确要求，不是遗漏参数。
 */
function sanitizeV2Overrides() {
  return {};
}

/**
 * 年度事实构造（SSV-04）：利润与分红的完整性分别标注。
 * 没有任何分红记录的一年是"未知"，不是"零分红"——记 null 并标 dividendKnown=false，
 * 让年度异常比较整段跳过，而不是拿 0 参与求和把公司误判成异常或正常。
 * R3-03：完整性只认仓储层给出的"该财年分红已完整取证且金额已知"；
 * 预案、只有中期单条、已实施但总额缺失都属未知，一律保持 null，不能因 eventCount>0 就折成 0。
 */
function buildAnnualYears(profits, annualDividends) {
  return (profits || []).map(item => {
    const dividendRow = (annualDividends || []).find(d => d.year === item.year);
    const known = !!dividendRow && dividendRow.dividendKnown === true
      && dividendRow.dividend !== null && dividendRow.dividend !== undefined;
    return {
      year: item.year,
      profit: item.profit === undefined ? null : item.profit,
      profitCurrency: item.currency ? String(item.currency).toUpperCase() : null,
      dividend: known ? Number(dividendRow.dividend) : null,
      dividendKnown: known,
      dividendCurrencies: dividendRow && Array.isArray(dividendRow.dividendCurrencies) ? dividendRow.dividendCurrencies : [],
      dividendCurrencyUnknown: !!(dividendRow && dividendRow.dividendCurrencyUnknown),
      complete: item.profit !== null && item.profit !== undefined,
      // 事实版本随年度一起保留：它是"这一年的利润有没有被更正过"的证据（R2-02）。
      sourceVersion: item.sourceVersion || null,
      dividendBasis: known
        ? (dividendRow.dividendBasis || 'dividend_events_visible')
        : ((dividendRow && dividendRow.dividendBasis) || 'dividend_unknown'),
    };
  }).sort((a, b) => a.year - b.year);
}

/** 年报期类型识别：优先用供应商 periodType，缺失时才回退 12-31，不按月份猜中期性质。 */
const ANNUAL_PERIOD_TYPES = /^(annual|year|yearly|fy|a)$/;
const YTD_PERIOD_TYPES = /^(q1|q2|q3|q4|h1|h2|semi|semiannual|half|half_year|interim|third|ytd|quarter)$/;

function normalizePeriodType(value) {
  const text = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!text || text === 'unknown') return null;
  if (ANNUAL_PERIOD_TYPES.test(text)) return 'annual';
  if (YTD_PERIOD_TYPES.test(text)) return 'ytd';
  return null;
}

/** 同一日往前/后推整数年（2-29 落到 2-28），用于定位"上年同期累计"。 */
function shiftYearsText(date, years) {
  const text = String(date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const year = Number(text.slice(0, 4)) + years;
  const monthDay = text.slice(4);
  if (monthDay === '-02-29' && !(year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0))) {
    return `${year}-02-28`;
  }
  return `${year}${monthDay}`;
}

/**
 * 自算 TTM 归母净利（方案 27.4）：完整年度 ＋ 本期累计 − 上年同期累计。
 * - 最新报告是否年度，按供应商 `periodType` 判定（6 月/9 月财年同样适用），不按月份猜；
 * - 中期累计需要「最近一个完整年度」与「去年同期累计」，缺任一段保持未知，不用最新投影凑；
 * - 去年同期必须早于最近年报，否则视为财年变更/口径不一致，保持未知；
 * - 三段币种必须一致，否则相减得到错误量纲的利润。
 * 同一 period_end 有多个版本时取最新公告的一条，不混用不同修订版本。
 */
function computeTtmFromReports(reports) {
  // 币种未核实的最新或历史输入不能被过滤后回退为旧版 TTM。
  if ((reports || []).some(item => item && item.currencyUnverified)) {
    return { value: null, reason: 'source_currency_unverified', evidence: null };
  }
  const list = (reports || []).filter(item => item && item.netProfit !== null && item.netProfit !== undefined);
  if (!list.length) return { value: null, reason: 'ttm_reports_missing', evidence: null };
  const byPeriod = new Map();
  list.forEach(item => {
    const current = byPeriod.get(item.periodEnd);
    if (!current || String(item.announcedAt || '') > String(current.announcedAt || '')) byPeriod.set(item.periodEnd, item);
  });
  const periods = [...byPeriod.values()].sort((a, b) => (a.periodEnd < b.periodEnd ? 1 : -1));
  const latest = periods[0];
  const pick = item => ({
    reportId: item.reportId, periodEnd: item.periodEnd, announcedAt: item.announcedAt,
    netProfit: item.netProfit, currency: item.currency, periodType: item.periodType || null,
  });

  // 性质判定：periodType 明确年度 → 年度；明确累计 → 累计；
  // periodType 缺失时不按"月份"猜，先看该证券有没有更早的 12-31 年报作为财年证据：
  // 有 12-31 年报纸 → 可确认是 12 月制财年，非 12-31 的那期按累计处理；都没有才判未知。
  const declaredType = normalizePeriodType(latest.periodType);
  const monthDay = String(latest.periodEnd).slice(5);
  const hasPriorDecemberAnnual = periods.some(item => item !== latest
    && item.periodEnd < latest.periodEnd
    && String(item.periodEnd).slice(5) === '12-31');
  const isAnnualReport = declaredType === 'annual' || (declaredType === null && monthDay === '12-31');
  if (isAnnualReport) {
    return {
      value: latest.netProfit,
      evidence: {
        method: 'annual_direct',
        basis: declaredType === 'annual' ? 'period_type_annual' : 'period_end_december',
        latest: pick(latest),
        fiscalYearEnd: latest.periodEnd,
      },
    };
  }
  const treatAsYtd = declaredType === 'ytd' || (declaredType === null && hasPriorDecemberAnnual);
  if (!treatAsYtd) {
    // 既不是年度、也没有可确认的财年证据：不猜，直接未知。
    return {
      value: null,
      reason: 'ttm_period_type_unknown',
      evidence: { method: 'period_type_unknown', latest: pick(latest) },
    };
  }

  // 最近一个完整年度（必须早于本期累计，且月份口径由 periodType 决定，不看 12-31）。
  const priorAnnual = periods.find(item => item !== latest
    && item.periodEnd < latest.periodEnd
    && (normalizePeriodType(item.periodType) === 'annual'
      || (normalizePeriodType(item.periodType) === null && String(item.periodEnd).slice(5) === '12-31')));
  const priorSameEnd = shiftYearsText(latest.periodEnd, -1);
  const priorSame = priorSameEnd ? byPeriod.get(priorSameEnd) || null : null;

  if (!priorAnnual || !priorSame) {
    return {
      value: null,
      reason: 'ttm_components_missing',
      evidence: {
        method: 'annual_plus_ytd_minus_prior_ytd',
        latest: pick(latest),
        priorAnnual: priorAnnual ? pick(priorAnnual) : null,
        priorSame: priorSame ? pick(priorSame) : null,
        fiscalYearEnd: priorAnnual ? priorAnnual.periodEnd : null,
      },
    };
  }
  // 去年同期若晚于/等于最近年报，说明财年变更或口径不一致，相减没有意义。
  if (priorSame.periodEnd >= priorAnnual.periodEnd) {
    return {
      value: null,
      reason: 'ttm_fiscal_year_changed',
      evidence: {
        method: 'annual_plus_ytd_minus_prior_ytd',
        latest: pick(latest),
        priorAnnual: pick(priorAnnual),
        priorSame: pick(priorSame),
      },
    };
  }
  const currencies = [priorAnnual.currency, latest.currency, priorSame.currency]
    .map(value => (value ? String(value).toUpperCase() : null));
  if (currencies.some(value => !value)) {
    return { value: null, reason: 'ttm_currency_unknown',
      evidence: { method: 'annual_plus_ytd_minus_prior_ytd', latest: pick(latest),
        priorAnnual: pick(priorAnnual), priorSame: pick(priorSame), currencies } };
  }
  if (new Set(currencies).size > 1) {
    return {
      value: null,
      reason: 'ttm_currency_mismatch',
      evidence: {
        method: 'annual_plus_ytd_minus_prior_ytd',
        latest: pick(latest), priorAnnual: pick(priorAnnual), priorSame: pick(priorSame),
        currencies,
      },
    };
  }
  return {
    value: priorAnnual.netProfit + latest.netProfit - priorSame.netProfit,
    evidence: {
      method: 'annual_plus_ytd_minus_prior_ytd',
      formula: 'priorAnnual + latestYtd - priorSameYtd',
      latest: pick(latest), priorAnnual: pick(priorAnnual), priorSame: pick(priorSame),
      fiscalYearEnd: priorAnnual.periodEnd,
    },
  };
}

/**
 * 构造年度异常/年度分红的规则输入。三项名次与年度异常**共用**这一个函数：
 * 2026-11-08 生产事故——两处各自构造 annual，`sourceGapYears` 只进了名次那一路，
 * 已核实「源端不可恢复」的 601528.SH 仍被判待补，整批继续不可发布。
 */
function annualFactsOf(profits, annualDividends, code, sourceGaps, listDate) {
  const rows = Array.isArray(profits) ? profits : [];
  const years = buildAnnualYears(rows, annualDividends);
  return {
    latestYear: years.length ? years[years.length - 1].year : null,
    years,
    currency: years.length ? years[years.length - 1].profitCurrency : null,
    requireProfitCurrency: true,
    requireDividendCurrency: true,
    // 上市年份：判断「十年比较窗口」是否早于上市（2026-11-08）。
    // 上市前公司只在招股书里披露申报前 3 年，公开定期报告本就没有那些年份；
    // 拿库内最早年份当"历史够长"的证据会被这 3 年骗过（601528 有 2014—2016、缺 2017），
    // 于是把"上市前无年报"误判成"该补没补"。上市年份是硬事实，用它划窗口下限。
    listingYear: listingYearOf(listDate),
    // 已核实「源端不可恢复」的财年（方案 27.5 第 6 条）：只有登记过的年份才允许判 NOT_APPLICABLE。
    sourceGapYears: sourceGaps ? sourceGapYearsOf(sourceGaps, code) : [],
  };
}

/** 从 `list_date`（YYYY-MM-DD 文本或 Date）取上市年份；缺失返回 null，交回原判定。 */
function listingYearOf(listDate) {
  if (!listDate) return null;
  const text = String(listDate);
  const match = text.match(/^(\d{4})/);
  if (!match) return null;
  const year = Number(match[1]);
  return Number.isInteger(year) && year > 1900 ? year : null;
}

/** 把库内事实拼成规则输入（不查库）。 */
function buildRuleFacts(row, ctx) {
  const companyKey = row.company_id === null || row.company_id === undefined ? null : String(row.company_id);
  const equity = companyKey ? ctx.equity.get(companyKey) || null : null;
  const profits = companyKey ? ctx.profits.get(companyKey) || [] : [];
  const annualDividends = companyKey ? ctx.annualDividends.get(companyKey) || [] : [];
  const dividend = ctx.dividends.get(String(row.instrument_id)) || null;
  const industry = companyKey ? ctx.industries.get(companyKey) || null : null;
  const pbEvidence = ctx.pbWindow.byInstrument.get(String(row.instrument_id)) || { maxPb: null, coveredDays: 0 };
  // 自算 TTM（方案 27.4）：供应商 PE(TTM) 只作对照，利润口径由三段报表自行闭合。
  const ttm = companyKey && ctx.ttm ? ctx.ttm.get(companyKey) || null : null;

  const annual = annualFactsOf(profits, annualDividends, row.code, ctx.sourceGaps, row.list_date);
  const years = annual.years;
  const latestYear = annual.latestYear;

  let fx = null;
  if (equity && equity.currency && equity.currency !== 'CNY' && equity.periodEnd) {
    fx = ctx.fx.get(`${String(equity.currency).toUpperCase()}|${equity.periodEnd}`) || null;
  }

  return {
    instrumentId: Number(row.instrument_id),
    companyId: row.company_id === null || row.company_id === undefined ? null : Number(row.company_id),
    code: row.code,
    name: row.name,
    market: row.market,
    // 原始 NUMERIC 文本：V2 全链路十进制判定必须拿到数据库原文，不能先经过 Number（方案 27.4）。
    pbRaw: row.pb === null || row.pb === undefined ? null : String(row.pb),
    peTtmRaw: row.pe_ttm === null || row.pe_ttm === undefined ? null : String(row.pe_ttm),
    pb: row.pb,
    peStatic: row.pe_static,
    peTtm: row.pe_ttm,
    price: row.price,
    priceDate: row.price_date,
    // 停牌回退时的真实估值日期：V2 要能说清"这是停牌前最后有效 PB"，不能冒充 T 日值。
    valuationAsOf: row.valuation_date || null,
    // 价格币种（F09）：股息必须与价格同币种才能相除，否则算出来的是错误量纲的比率。
    priceCurrency: row.currency_code ? String(row.currency_code).toUpperCase() : null,
    pbWindow: {
      // V1 合同字段
      maxPb: pbEvidence.maxPb,
      coveredDays: pbEvidence.coveredDays,
      expectedDays: pbEvidence.expectedDays,
      gapDays: pbEvidence.gapDays,
      marketDays: ctx.pbWindow.marketDays,
      calendarDays: ctx.pbWindow.calendarDays,
      // V2 正极值比与覆盖分账（原始 NUMERIC 文本一并保留）
      minPb: pbEvidence.minPb,
      minPbRaw: pbEvidence.minPbRaw,
      maxPbRaw: pbEvidence.maxPbRaw,
      positiveDays: pbEvidence.positiveDays,
      positiveGapDays: pbEvidence.positiveGapDays,
      observedDays: pbEvidence.observedDays,
      nonPositiveDays: pbEvidence.nonPositiveDays,
      invalidDays: pbEvidence.invalidDays,
      missingDays: pbEvidence.missingDays,
      exemptDays: pbEvidence.exemptDays,
      calendarComplete: pbEvidence.calendarComplete,
      effectiveStart: pbEvidence.effectiveStart,
      listDate: pbEvidence.listDate,
      minPbDate: pbEvidence.minPbDate,
      maxPbDate: pbEvidence.maxPbDate,
      historyYears: pbEvidence.historyYears,
      windowStart: pbEvidence.windowStart,
      windowEnd: pbEvidence.windowEnd,
    },
    // 证据引用：完整日序列仍在 market.daily_valuations，这里只带摘要指纹（方案 27.7）。
    pbSeriesHash: pbEvidence.pbSeriesDigest || null,
    equity: equity ? {
      amount: equity.amount, currency: equity.currency, periodEnd: equity.periodEnd,
      announcedAt: equity.announcedAt, reportId: equity.reportId,
      currencyUnverified: equity.currencyUnverified === true,
      availabilityBasis: equity.availabilityBasis || 'announced_at',
    } : {},
    fx: fx || {},
    dividend: dividend ? Object.assign({}, dividend, {
      windowStart: ctx.dividendWindowStart,
      windowEnd: ctx.asOfDate,
      // 2026-11-04 口径调整：采过分红事实、但近 12 个月没有一笔已实施现金分红，
      // 就是明确的"本期无现金分红"（R04 判不通过），不再当成"数据不可用"阻断整批发布。
      // 只有从未采过分红的证券才保留未知（继续待补）。
      verifiedZero: dividend.count === 0 && dividend.hasDividendHistory === true,
    }) : { verifiedZero: false },
    annual,
    // 估值缺口已核实为源端不可恢复（窗口内缺失日全部登记在案）→ R02 判不可评估，不进补数队列。
    pbGapSourceUnrecoverable: !!(ctx.pbGapCovered && ctx.pbGapCovered.get(String(row.code || '').toUpperCase())),
    // 自算 TTM 的利润与血缘证据（三份报表 + 公式 + 币种），供应商 PE 的符号另由规则层对照。
    ttmProfit: ttm ? ttm.value : null,
    ttmEvidenceRef: ttm ? ttm.evidence : null,
    ttmStatusReason: ttm && ttm.value === null ? ttm.reason || null : null,
    industry,
    suspended: !!row.suspend_type,
    suspensionReason: row.suspend_type || null,
    riskWarning: row.risk_warning ? 'risk_warning_name' : null,
    delistedAtTargetDate: false,
  };
}

/**
 * 计算一次选股（不写库）。返回候选、排名、组合、覆盖与质量裁决。
 */
/**
 * 股票池 + 不可变 artifact（方案 27.11 / DEV-02）：
 * - 首次计算某目标日时固化证券集合与内容哈希（当天记 real_time_observation，历史记 pit_research_replay）；
 * - 已有 artifact 时以它为准：集合一致直接复用；集合漂移时保留旧集合并把差异写进质量原因，
 *   绝不用今天的主档替换已经固化的历史名单，也不把重建说成"当时真实可见"；
 * - 固化成员在新主档里完全找不到（或取不到任何行）时返回 universe_not_recoverable，回测据此判不可还原。
 */
async function loadUniverseWithArtifact({ market, asOfDate, knowledgeCutoff, writeArtifact = true, restrictCodes = null }, tx) {
  // 续批定点复核（B1-1）：只重读本批对象，不读/不写当日 artifact。
  // artifact 是"全市场冻结名单"的证据，用 20 只子集读写它会把名单偷换成子集。
  if (Array.isArray(restrictCodes) && restrictCodes.length) {
    const rows = await repo.loadUniverse({ market, asOfDate, availableBefore: knowledgeCutoff, codes: restrictCodes }, tx);
    return {
      rows,
      artifact: null,
      drift: null,
      evidence: {
        restricted: true,
        memberCount: rows.length,
        poolDefinition: 'restricted_reaudit',
        requestedCodes: restrictCodes.length,
      },
    };
  }
  // C0：先定"名单"（生命周期 + 市场/交易所准入，不含行情），再单独判断"能不能交易"。
  // 不能因为今天没行情就把证券从历史名单里抹掉，也不能用今天有行情的子集冒充目标池。
  const roster = await repo.loadUniverseRoster({ market, asOfDate }, tx);
  const rosterIds = roster.map(row => Number(row.instrument_id)).sort((a, b) => a - b);
  const rosterHash = hashOf(rosterIds);
  const roleOfRoster = new Map(roster.map(row => [Number(row.instrument_id), row]));
  const live = await repo.loadUniverse({ market, asOfDate, availableBefore: knowledgeCutoff }, tx);
  const excluded = roster
    .filter(row => row.has_recent_bars !== true)
    .map(row => ({
      instrumentId: Number(row.instrument_id),
      code: row.code,
      reason: row.has_any_data === true ? 'no_recent_bars_60d' : 'never_had_market_data',
    }));
  const today = CoreDate.todayInZone('Asia/Shanghai');
  const replayType = asOfDate === today ? 'real_time_observation' : 'pit_research_replay';
  const saved = await repo.findUniverseArtifact({ market, targetDate: asOfDate }, tx);

  if (!saved) {
    if (rosterIds.length && writeArtifact) {
      await repo.insertUniverseArtifact({
        market,
        targetDate: asOfDate,
        contentHash: rosterHash,
        instrumentIds: rosterIds,
        members: roster.map(row => ({
          instrumentId: Number(row.instrument_id),
          code: row.code,
          listDate: row.list_date || null,
          delistDate: row.delist_date || null,
          exchange: row.exchange_code || null,
          tradableAtTargetDate: row.has_recent_bars === true,
        })),
        excluded,
        knowledgeCutoff,
        sourceVersions: { universe: rosterHash, poolDefinition: 'lifecycle_admitted' },
        basis: {
          poolDefinition: 'lifecycle_admitted',
          filters: ['asset_class_stock', 'market', 'exchange', 'list_date<=T', 'delist_date>T'],
          rosterCount: rosterIds.length,
          tradableCount: live.length,
          excludedCount: excluded.length,
        },
        replayType,
      }, tx);
    }
    return {
      rows: live,
      artifact: null,
      drift: null,
      evidence: {
        contentHash: rosterHash,
        memberCount: rosterIds.length,
        tradableCount: live.length,
        excludedCount: excluded.length,
        poolDefinition: 'lifecycle_admitted',
        replayType,
        created: true,
        excluded: excluded.slice(0, 200),
      },
    };
  }

  // 已有 artifact：在池判定以名单为准，行情只影响"可交易子集"，不再触发池漂移。
  const savedIds = (saved.instrument_ids || []).map(Number).sort((a, b) => a - b);
  const savedSet = new Set(savedIds);
  const rosterSet = new Set(rosterIds);
  const missing = savedIds.filter(id => !rosterSet.has(id));
  const added = rosterIds.filter(id => !savedSet.has(id));
  const rows = live.filter(row => savedSet.has(Number(row.instrument_id)));
  const drift = missing.length || added.length ? { missing, added, rosterHash } : null;
  const evidence = {
    artifactId: Number(saved.artifact_id),
    contentHash: saved.content_hash,
    memberCount: savedIds.length,
    tradableCount: rows.length,
    excludedCount: excluded.length,
    poolDefinition: (saved.basis && saved.basis.poolDefinition) || 'lifecycle_admitted',
    replayType: saved.replay_type,
    knowledgeCutoff: saved.knowledge_cutoff || null,
    created: false,
    drift,
    excluded: excluded.slice(0, 200),
  };
  // 名单成员是否"还在主档"才是不可恢复的判据：
  // 全部成员都查不到（主档重建、证券合并/删除）才是历史池不可还原；
  // 成员都在、只是目标日取不到可评估行（行情未覆盖、知识截止早于行情）属正常空池，
  // 必须交给上层按 universe_empty 处理。
  // 旧写法只看 rows.length，导致首次算空池并固化 artifact 之后，同一天再算或回测
  // 会被判成"数据坏了"（2026-11-07 生产版本发布时实测到）。
  if (!rows.length && savedIds.length && missing.length === savedIds.length) {
    return {
      rows: [],
      artifact: saved,
      drift,
      evidence: Object.assign(evidence, { reason: 'universe_not_recoverable' }),
    };
  }
  // 名单内、但目标日不可交易（无近期行情）的数量单独计数，供质量裁决区分"空仓"与"缺数据"。
  const untradableInRoster = rosterIds.filter(id => {
    const row = roleOfRoster.get(id);
    return row && row.has_recent_bars !== true;
  }).length;
  evidence.untradableInRoster = untradableInRoster;
  return { rows, artifact: saved, drift, evidence };
}

/**
 * 名单漂移是否阻断本次计算（方案 27.11 的发布边界）：
 * 固化名单与新主档不一致时仍使用固化集合，差异只作证据，不静默换池；
 * 只有生产/预览发布路径显式放行，才不把新股/退市这类正常生命周期变化当质量阻断。
 * 回测与 G0 审计默认严格阻断，避免用今天的主档篡改历史池。
 */
function shouldBlockUniverseDrift(drift, allowUniverseDrift) {
  return Boolean(drift) && allowUniverseDrift !== true;
}

async function computeGrahamSelection(input, { market, asOfDate, strategyCode, positionRatio, valuation, knowledgeCutoff, universeLoad }, tx) {
  const params = Object.assign({}, GRAHAM_RULES.GRAHAM_PARAMS, input.internalParams || {});
  const gate = RULES_V2.evaluateMarketGateV2(valuation);
  const universe = universeLoad.rows;
  const companyIds = Array.from(new Set(universe.map(row => row.company_id).filter(id => id !== null && id !== undefined)));
  const [balances, industries] = await runBatched([
    () => repo.loadGrahamBalanceFacts({ companyIds, asOfDate, availableBefore: knowledgeCutoff, market }, tx),
    () => repo.loadIndustries({ companyIds, market, asOfDate }, tx),
  ], tx);

  const targetCurrency = market === 'HK' ? 'HKD' : 'CNY';
  const fxPairs = [];
  for (const row of universe) {
    const bal = row.company_id ? balances.get(String(row.company_id)) : null;
    const valCcy = String(row.valuation_currency || targetCurrency).toUpperCase();
    const balCcy = bal && bal.currency ? String(bal.currency).toUpperCase() : null;
    if (bal && balCcy && balCcy !== valCcy) {
      fxPairs.push({ currency: balCcy, date: asOfDate });
    }
  }
  const fxRates = await repo.loadFxRatesToCurrency({ pairs: fxPairs, targetCurrency }, tx);

  const evaluated = universe.map(row => {
    const companyKey = row.company_id !== null && row.company_id !== undefined ? String(row.company_id) : null;
    const bal = companyKey ? balances.get(companyKey) || null : null;
    const industry = companyKey ? industries.get(companyKey) || null : null;
    const valCcy = String(row.valuation_currency || targetCurrency).toUpperCase();
    const balCcy = bal && bal.currency ? String(bal.currency).toUpperCase() : null;
    const fx = (balCcy && balCcy !== valCcy) ? fxRates.get(`${balCcy}|${asOfDate}`) || null : null;

    const evalResult = GRAHAM_RULES.evaluateGrahamCandidate({
      market,
      asOfDate,
      tsCode: row.code,
      listDate: row.list_date,
      delistDate: row.delist_date,
      riskWarning: row.risk_warning,
      suspendType: row.suspend_type,
      fsTableType: bal ? bal.fsTableType : null,
      hasBalanceReport: Boolean(bal && bal.reportId),
      reportId: bal ? bal.reportId : null,
      periodEnd: bal ? bal.periodEnd : null,
      currentAssets: bal && !bal.currencyUnverified ? bal.currentAssets : null,
      currentLiabilities: bal && !bal.currencyUnverified ? bal.currentLiabilities : null,
      balanceCurrency: balCcy,
      valuationCurrency: valCcy,
      totalMarketCap: row.total_market_cap,
      fxRate: fx ? fx.rate : null,
      fxDate: fx ? fx.date : null,
    });

    return {
      instrumentId: Number(row.instrument_id),
      companyId: row.company_id ? Number(row.company_id) : null,
      code: row.code,
      name: row.name,
      industry,
      currentPb: row.pb === null || row.pb === undefined ? null : Number(row.pb),
      historicalPbMax: null,
      historicalPbMin: null,
      currentPe: row.pe_ttm === null || row.pe_ttm === undefined ? null : Number(row.pe_ttm),
      profitStatus: 'unknown',
      dividendYield: row.dividend_yield_ttm === null || row.dividend_yield_ttm === undefined ? null : Number(row.dividend_yield_ttm),
      equityAmount: null,
      equityCurrency: balCcy,
      equityCny: null,
      fxRate: fx ? fx.rate : null,
      fxDate: fx ? fx.date : null,
      filterStatus: evalResult.status,
      dataQualityStatus: evalResult.status === RULES.STATUS.PENDING ? 'pending' : (evalResult.status === RULES.STATUS.NOT_APPLICABLE ? 'not_applicable' : 'complete'),
      exclusionReasons: evalResult.status === RULES.STATUS.PASS ? [] : [evalResult.reason],
      rules: { G01: evalResult.g01 },
      rankReady: evalResult.status === RULES.STATUS.PASS,
      rankBlockReasons: [],
      pbRank: null,
      peRank: null,
      dividendRank: null,
      totalScore: evalResult.rankingScore,
      selectionOrder: null,
      detail: {
        graham: evalResult.metrics,
        price: row.price === null || row.price === undefined ? null : Number(row.price),
        priceDate: row.price_date || null,
        valuationDate: row.valuation_date || null,
        periodEnd: bal ? bal.periodEnd : null,
        announcedAt: bal ? bal.announcedAt : null,
      },
    };
  });

  const ranked = evaluated
    .filter(item => item.filterStatus === RULES.STATUS.PASS && item.totalScore !== null)
    .sort((a, b) => {
      if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
      return String(a.code || '').localeCompare(String(b.code || ''));
    });
  ranked.forEach((item, idx) => { item.selectionOrder = idx + 1; });

  const excludedCodes = new Set((input.excludedCodes || []).map(c => String(c || '').trim().toUpperCase()).filter(Boolean));
  const excludedIndustries = new Set((input.excludedIndustryCodes || []).map(c => String(c || '').trim()).filter(Boolean));
  const selected = [];
  for (const item of ranked) {
    if (selected.length >= params.slotsPerMarket) break;
    if (excludedCodes.has(String(item.code || '').toUpperCase())) continue;
    if (item.industry && excludedIndustries.has(String(item.industry.code || ''))) continue;
    selected.push(item);
  }
  // 席位与权重一律走共享构造器（buildSelectedPortfolio）：members 表的 slot_no /
  // weight_in_market_budget / weight_in_equity_target 都是非空带范围检查的列，
  // 早期这里自己拼对象只给 targetWeight，落库即报 slot_no 为空（2026-11-23 线上实证）。
  const portfolio = PORTFOLIO.buildSelectedPortfolio({
    selected,
    positionRatio,
    slots: params.slotsPerMarket,
    params,
  });

  const pendingCount = evaluated.filter(item => item.filterStatus === RULES.STATUS.PENDING).length;
  const riskHeld = evaluated.filter(item => item.filterStatus === RULES.STATUS.RISK);
  const notEvaluable = evaluated.filter(item => item.filterStatus === RULES.STATUS.NOT_APPLICABLE);
  const reasons = [];
  if (!gate.eligible) reasons.push(gate.reason || 'market_not_eligible');
  if (!universe.length) reasons.push('universe_empty');
  if (shouldBlockUniverseDrift(universeLoad.evidence.drift, input.allowUniverseDrift)) reasons.push('universe_drift');
  // 格雷厄姆方案的待补对象只做披露、不阻断发布（2026-11-22 用户决策）。
  // 净流动资产法只对有流动科目的实体成立，缺科目是数据侧长期边界
  // （2026-11-22 线上实测 5626 家 A股里 141 家缺，占 2.5%），拿它当永久阻断
  // 会让方案永远发不出组合，而合格候选本身不受这些标的影响。pendingCount 照常披露。
  // 投资要义方案走另一处质量判定，口径保持原状。

  const quality = {
    publishable: reasons.length === 0,
    reason: reasons[0] || null,
    reasons,
    universeCount: universe.length,
    poolSize: ranked.length,
    pendingCount,
    anomalyPendingCount: 0,
    rankBlockedCount: 0,
    riskHeldCount: riskHeld.length,
    notEvaluableCount: notEvaluable.length,
    anomalyNotEvaluableCount: 0,
    anomalyDividendSkipped: 0,
    industryMissing: ranked.filter(item => !item.industry).length,
    stalePrice: evaluated.filter(item => item.filterStatus === RULES.STATUS.PASS && !item.detail.priceDate).length,
    profitCount: 0,
  };

  return {
    market,
    asOfDate,
    gate,
    valuation,
    params,
    positionRatio,
    strategyCode,
    isV2: true,
    universe,
    evaluated,
    anomalyById: {},
    candidates: evaluated,
    ranked,
    portfolio,
    quality,
    coverage: {
      universeCount: universe.length,
      withValuation: evaluated.filter(i => i.detail.graham && i.detail.graham.totalMarketCap > 0).length,
      withPrice: evaluated.filter(i => i.detail.price !== null).length,
      withEquity: evaluated.filter(i => i.detail.graham !== null).length,
      withIndustry: evaluated.filter(i => i.industry !== null).length,
      // B2-1：格雷厄姆按自身 G01 合同独立收窄（FAIL/NOT_APPLICABLE 不再要求行业）。
      industryRequiredCount: evaluated.filter(i => industryRequiredOf(i)).length,
      withIndustryRequired: evaluated.filter(i => industryRequiredOf(i) && i.industry !== null).length,
      pbWindow: null,
    },
    universeEvidence: universeLoad.evidence,
  };
}

async function computeSelection(input, tx) {
  const market = normalizeMarket(input.market);
  const asOfDate = String(input.asOfDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
    const error = new Error('目标日参数不合法');
    error.status = 400;
    throw error;
  }
  // 策略分派（方案 27.2）：V1 与 V2 各自登记参数/公式，服务不能写死 V1 常量。
  // V2 的阈值与比较方式固化在公式版本里，不接受浏览器请求覆盖公共策略。
  const strategyCode = normalizeStrategyCode(input.strategyCode);
  const isV2 = strategyCode === RULES_V2.STRATEGY_CODE_V2;
  // internalParams 只给回测/审计的阶梯对照使用（不经 HTTP 入口），保证浏览器仍不能覆盖公共策略。
  const params = isV2
    ? Object.assign({}, RULES_V2.V2_PARAMS, sanitizeV2Overrides(input.params), input.internalParams || {})
    : Object.assign({}, RULES.DEFAULT_PARAMS, input.params || {}, input.internalParams || {});
  const positionRatio = PORTFOLIO.clampRatio(input.positionRatio, 1);
  const valuation = await repo.loadMarketValuation({ market, asOfDate }, tx);
  // V2 取消市场指数 PB 配置门槛（方案 27.3）：指数估值只做可选展示，缺失/异常不阻断计算与发布。
  // 阶梯对照需要能单独切换这一步：只有显式 marketGate='v1' 才按 V1 合同执行（B03）。
  const gateMode = isV2 ? String(params.marketGate || 'off') : 'v1';
  const gate = (isV2 && gateMode !== 'v1')
    ? RULES_V2.evaluateMarketGateV2(valuation)
    : RULES.evaluateMarketGate(valuation, Object.assign({}, RULES.DEFAULT_PARAMS, params));

  // 信息可见截止先算出来：宇宙查询里的 PE/PB 回退也要用它，否则同一批计算里
  // PE/净资产会取到不同版本的报表（F09）。
  const knowledgeCutoff = knowledgeCutoffFor(market, asOfDate);
  const universeLoad = await loadUniverseWithArtifact({
    market, asOfDate, knowledgeCutoff,
    // 续批定点复核只重读本批代码；全市场审计/发布路径保持原行为。
    restrictCodes: Array.isArray(input.restrictCodes) && input.restrictCodes.length ? input.restrictCodes : null,
    // 只读审计（G0）传 false：不固化 artifact，也不写业务表。
    writeArtifact: input.writeUniverseArtifact !== false,
  }, tx);
  const universe = universeLoad.rows;
  if (!universe.length) {
    // 空候选池是合法状态（例如港股行情还没补齐）。返回契约必须与正常路径一致：
    // auditInputs 会遍历 evaluated，缺字段会直接抛错并把整批补数打成 failed（2026-11-05 生产实测）。
    const emptyReason = universeLoad.evidence.reason || 'universe_empty';
    return {
      market, asOfDate, gate, valuation, params, positionRatio,
      strategyCode, isV2,
      universe, evaluated: [], anomalyById: {},
      candidates: [], ranked: [], portfolio: PORTFOLIO.buildPortfolio({ ranked: [], positionRatio, params }),
      // 空池必须同时给出 reason 和 reasons（F10）：回测只读 reasons 判"可不可还原"，
      // 只填 reason 会让空池被当成"没有质量阻断"，进而把缺数据算成 0% 收益的策略空仓。
      quality: {
        publishable: false, reason: emptyReason, reasons: [emptyReason],
        universeCount: 0, pendingCount: 0, poolSize: 0,
      },
      coverage: { universeCount: 0 },
      universeEvidence: universeLoad.evidence,
    };
  }
  if (strategyCode === GRAHAM_RULES.STRATEGY_CODE_GRAHAM) {
    return computeGrahamSelection(input, {
      market, asOfDate, strategyCode, positionRatio, valuation, knowledgeCutoff, universeLoad,
    }, tx);
  }

  const companyIds = Array.from(new Set(universe.map(row => row.company_id).filter(id => id !== null && id !== undefined)));
  const instrumentIds = universe.map(row => row.instrument_id);
  // 续批定点复核才把 PB 窗口收窄到本批证券；全市场计算保持原查询。
  const restrictedInstrumentIds = Array.isArray(input.restrictCodes) && input.restrictCodes.length ? instrumentIds : null;
  const windowStart = shiftYears(asOfDate, params.pbLookbackYears);
  const dividendWindowStart = shiftMonths(asOfDate, params.dividendWindowMonths);
  // 信息可见截止（knowledgeCutoff）已在宇宙查询前算好：同一批计算共用同一个截止时刻。
  const [pbWindow, equity, profits, dividends, annualDividends, industries, ttmReports] = await runBatched([
    () => repo.loadPbWindow({ market, windowStart, asOfDate, instrumentIds: restrictedInstrumentIds }, tx),
    () => repo.loadEquityFacts({ companyIds, asOfDate, availableBefore: knowledgeCutoff, market }, tx),
    () => repo.loadAnnualProfits({ companyIds, asOfDate, availableBefore: knowledgeCutoff, market }, tx),
    () => repo.loadDividendWindow({ instrumentIds, windowStart: dividendWindowStart, asOfDate, market }, tx),
    // R5-02：年度分红与利润、权益共用同一个信息截止（目标日收盘时刻），
    // 否则"目标日之后才可取到"的年报版本会把旧季度分红从待补变成通过。
    () => repo.loadAnnualDividends({ companyIds, asOfDate, availableBefore: knowledgeCutoff, market }, tx),
    () => repo.loadIndustries({ companyIds, market, asOfDate }, tx),
    // 自算 TTM 的三段报表：与权益/年度利润同一可见截止，不用今天的最新投影补历史。
    () => repo.loadTtmInputs({ companyIds, asOfDate, availableBefore: knowledgeCutoff, market }, tx),
  ], tx);
  // 逐公司先算一次 TTM，供 buildRuleFacts 直接取用（不在每只股票里重复算）。
  const ttm = new Map();
  companyIds.forEach(companyId => {
    const key = String(companyId);
    ttm.set(key, computeTtmFromReports(ttmReports.get(key) || []));
  });
  const fxPairs = Array.from(equity.values())
    .filter(item => item.currency && item.currency !== 'CNY' && item.periodEnd)
    .map(item => ({ currency: String(item.currency).toUpperCase(), date: item.periodEnd }));
  const fx = await repo.loadFxRatesForPairs({ pairs: fxPairs }, tx);

  // 估值缺口登记（2026-11-08，方案 27.36.7）：只有「窗口内缺失日**全部**被 governance 登记覆盖」
  // 才允许 R02 判不可评估。缺失日清单要对 688 只逐日保留集合，成本高，所以只对登记在案的证券查，
  // 通常是 0～1 只；没登记、只登记一部分、登记的日期对不上，一律维持待补（不静默放行）。
  const pbGapRegistry = loadPbGapDays();
  const pbGapCodes = universe
    .map(row => String(row.code || '').toUpperCase())
    .filter(code => pbGapRegistry.has(code));
  const pbGapCovered = new Map();
  if (pbGapCodes.length) {
    const pbMissing = await repo.loadPbMissingDaysForCodes({ market, codes: pbGapCodes, windowStart, asOfDate }, tx);
    pbGapCodes.forEach(code => {
      pbGapCovered.set(code, pbGapFullyRegistered(pbGapRegistry, code, pbMissing.get(code) || []));
    });
  }

  const ctx = { equity, profits, annualDividends, dividends, industries, pbWindow, fx, ttm, asOfDate,
    dividendWindowStart, sourceGaps: loadFinancialSourceGaps(), pbGapCovered };
  const evaluated = universe.map(row => buildRuleFacts(row, ctx))
    .map(facts => (isV2 ? RULES_V2.evaluateInstrumentV2(facts, params) : RULES.evaluateInstrument(facts, params)));

  // 年度异常独立判定，不参与三项名次。这里直接遍历 universe 原始行，而不是 evaluated：
  // evaluated 是规则输出（V1/V2 结构不同），从它身上取上市日期必然再出现「同一字段只生效一路」。
  const anomalyById = {};
  universe.forEach(row => {
    const companyKey = row.company_id === null || row.company_id === undefined ? null : String(row.company_id);
    const profitRows = companyKey ? profits.get(companyKey) || [] : [];
    const dividendRows = companyKey ? annualDividends.get(companyKey) || [] : [];
    // 与三项名次用同一个构造函数、同一份原始行字段（2026-11-08 两处各造一份导致登记只生效一路）。
    const annual = annualFactsOf(profitRows, dividendRows, row.code, ctx.sourceGaps, row.list_date);
    anomalyById[Number(row.instrument_id)] = RULES.evaluateAnnualAnomaly(Object.assign({ market }, annual), params);
  });

  const ranking = isV2 ? RULES_V2.rankCandidatesV2(evaluated) : RULES.rankCandidates(evaluated);
  const { ranked, profitCount, poolSize, peRankFallback } = ranking;
  const portfolio = PORTFOLIO.buildPortfolio({
    ranked,
    anomalyById,
    positionRatio,
    slots: params.slotsPerMarket,
    industryLimitRatio: params.industryLimitRatio,
    params,
    excludedInstrumentIds: input.excludedInstrumentIds || null,
    excludedIndustryCodes: input.excludedIndustryCodes || null,
  });

  // 质量裁决：PENDING 表示"未知"，FAIL 是"明确不符合"，RISK 是"当期风险暂缓"。
  // SSV-03：四项通过但排名输入未知（如静态 PE/利润口径未定）也必须算待补，
  // 否则它会从排名池静默消失、还能让别人把 publishable 撑成 true。
  const pending = evaluated.filter(item => item.filterStatus === RULES.STATUS.PENDING);
  const rankBlocked = evaluated.filter(item => item.filterStatus === RULES.STATUS.PASS && item.rankReady === false);
  const anomalyPending = ranked.filter(item => (anomalyById[item.instrumentId] || {}).status === RULES.STATUS.PENDING);
  const pendingCount = pending.length + rankBlocked.length + anomalyPending.length;
  const riskHeld = evaluated.filter(item => item.filterStatus === RULES.STATUS.RISK);
  // 不可评估（R02 估值窗口先天覆盖不全、年度历史不足）：不入选、不进缺口、不阻断发布，
  // 必须单独计数，否则"少了一批人"在页面上看不出来。
  const notEvaluable = evaluated.filter(item => item.filterStatus === RULES.STATUS.NOT_APPLICABLE);
  const anomalyNotEvaluable = ranked.filter(item => (anomalyById[item.instrumentId] || {}).status === RULES.STATUS.NOT_APPLICABLE);
  const anomalyDividendSkipped = ranked.filter(item => {
    const anomaly = anomalyById[item.instrumentId];
    return anomaly && anomaly.dividendComparable === false;
  }).length;
  const industryMissing = ranked.filter(item => !item.industry).length;
  const stalePrice = evaluated.filter(item => item.rules.R01.status === RULES.STATUS.PASS && !item.detail.priceDate).length;

  const reasons = [];
  if (!gate.eligible) reasons.push(gate.reason || 'market_not_eligible');
  if (!universe.length) reasons.push('universe_empty');
  // 固化股票池与新主档不一致：保留旧集合、差异留证，不静默换池（方案 27.11）。
  // 生产发布路径只留证据不阻断：名单漂移不是数据缺口，若当成永久阻断，同一目标日
  // 一旦名单变化就永远发不出结果，后台选股槽每天撞 24 小时止损告警（2026-11-10～11-14 线上实证）。
  // 回测与 G0 审计直接调 computeSelection，仍按原口径严格阻断。
  if (shouldBlockUniverseDrift(universeLoad.evidence.drift, input.allowUniverseDrift)) reasons.push('universe_drift');
  if (pendingCount > 0) reasons.push('pending_objects_in_ranking_pool');
  // 行业源本身不给（北交所新股、已合并主体）只让该股不可评估，不阻断整批：
  // buildPortfolio 已经把 industry 为空的证券 skip 掉（reason=industry_unverified），
  // 它们不会进组合，也就不影响组合内的行业集中度；把它当阻断项会让整批永远发不出去。
  // R3-04：输入完整时"没有合格股票"是有效业务结果（本季空仓），不是数据缺口。
  // 只有存在输入缺口或市场不可入时才把"无合格成员"记为附加阻断，
  // 否则零合格会永远被当成待补数据、季度反复续跑却永远补不齐。
  const inputBlocked = !gate.eligible || pendingCount > 0;
  if (portfolio.members.length === 0 && inputBlocked) reasons.push('no_eligible_member');

  const quality = {
    publishable: reasons.length === 0,
    reason: reasons[0] || null,
    reasons,
    universeCount: universe.length,
    poolSize,
    pendingCount,
    anomalyPendingCount: anomalyPending.length,
    rankBlockedCount: rankBlocked.length,
    riskHeldCount: riskHeld.length,
    notEvaluableCount: notEvaluable.length,
    anomalyNotEvaluableCount: anomalyNotEvaluable.length,
    anomalyDividendSkipped,
    industryMissing,
    stalePrice,
    profitCount,
    peRankFallback,
    failures: evaluated.filter(item => item.filterStatus === RULES.STATUS.FAIL).length,
    passed: evaluated.filter(item => item.filterStatus === RULES.STATUS.PASS).length,
  };

  // B2-1：覆盖率同时给「全市场分母」与「必需候选分母」——后者只含未淘汰、可能进入排名池的标的，
  // 避免把已确定淘汰（A 类）与 RISK 的行业缺失算进必须补齐率。
  const industryRequired = evaluated.filter(item => industryRequiredOf(item));
  const coverage = {
    universeCount: universe.length,
    withValuation: universe.filter(row => row.pb !== null && row.pb !== undefined).length,
    withPrice: universe.filter(row => row.price !== null && row.price !== undefined).length,
    withEquity: evaluated.filter(item => item.equityCny !== null).length,
    withIndustry: evaluated.filter(item => !!item.industry).length,
    industryRequiredCount: industryRequired.length,
    withIndustryRequired: industryRequired.filter(item => !!item.industry).length,
    withAnnualHistory: Array.from(profits.values()).filter(list => list.length >= params.requiredFiscalYears).length,
    companies: companyIds.length,
    pbWindow: { marketDays: pbWindow.marketDays, calendarDays: pbWindow.calendarDays, windowStart },
  };

  return { market, asOfDate, gate, valuation, params, positionRatio, strategyCode, isV2, universe, evaluated, ranked, anomalyById, portfolio, quality, coverage, universeEvidence: universeLoad.evidence };
}

/**
 * 逐股输入摘要（SSV-05 / R2-02）：哈希必须覆盖实际参与判断的**全部值与证据**。
 * 反例一：同一集合里把某只 PB 从 1.2 改成 0.81，行数、指数、参数都不变，旧实现复用旧快照。
 * 反例二：把 2015 年利润从 10 亿改成 -200 亿，最新一年与其他指标不变——只哈希最新一年时
 * 年度异常已从 PASS 变 FAIL，哈希却不变，于是继续返回旧已发布批次。
 * 因此这里把每一年的利润/分红/完整性、事实版本、权益版本与年度异常结论一起排序后哈希。
 */
function inputsDigestOf(computed) {
  const anomalyById = computed.anomalyById || {};
  const rows = computed.evaluated.map(item => {
    const detail = item.detail || {};
    const equity = detail.equity || {};
    const dividend = detail.dividend || {};
    const annual = detail.annual || {};
    const pbWindow = detail.pbWindow || {};
    // 全部年度事实都要进指纹，不能只取最新一年。
    const years = (annual.years || []).map(row => [
      Number(row.year), row.profit === undefined ? null : row.profit,
      row.dividend === undefined ? null : row.dividend,
      row.dividendKnown === true, row.complete === true, row.sourceVersion || null,
      row.profitCurrency || null, row.dividendCurrencies || [], row.dividendCurrencyUnknown === true,
    ]);
    const anomaly = anomalyById[item.instrumentId] || null;
    const anomalyEvidence = anomaly ? [
      anomaly.status, anomaly.reason || null, anomaly.latestYear,
      anomaly.profitY === undefined ? null : anomaly.profitY,
      anomaly.profitSum === undefined ? null : anomaly.profitSum,
      anomaly.dividendY === undefined ? null : anomaly.dividendY,
      anomaly.dividendSum === undefined ? null : anomaly.dividendSum,
      anomaly.dividendComparable === undefined ? null : anomaly.dividendComparable,
      anomaly.dividendComparison || null,
      (anomaly.dividendUnknownYears || []).join(','),
      (anomaly.missingYears || []).join(','),
    ] : null;
    return [
      item.instrumentId, item.code,
      item.currentPb, item.currentPe, detail.price, item.dividendYield,
      item.historicalPbMax, pbWindow.expectedDays, pbWindow.gapDays, pbWindow.coveredDays,
      item.equityCny, item.equityCurrency, equity.reportId, equity.periodEnd, equity.announcedAt,
      equity.sourceVersion || null,
      dividend.ttmPerShare, dividend.count, dividend.currency || null, dividend.shareUnitUnverified === true,
      annual.latestYear, annual.currency || null, years,
      anomalyEvidence,
      item.industry ? `${item.industry.system}:${item.industry.code}:${item.industry.version}` : null,
      item.rules.G01 ? item.rules.G01.status : item.rules.R01.status,
      item.rules.R02 ? item.rules.R02.status : null,
      item.rules.R04 ? item.rules.R04.status : null,
      item.rules.R05 ? item.rules.R05.status : null,
      item.filterStatus, item.profitStatus,
    ];
  }).sort((a, b) => Number(a[0]) - Number(b[0]));
  return hashOf(rows);
}

function manifestOf(computed, extra) {
  return Object.assign({
    market: computed.market,
    asOfDate: computed.asOfDate,
    benchmarkCode: computed.valuation.benchmarkCode,
    valuationMethod: computed.valuation.valuationMethod,
    marketPb: computed.valuation.pb,
    marketPe: computed.valuation.pe,
    universeCount: computed.coverage.universeCount,
    withValuation: computed.coverage.withValuation,
    withPrice: computed.coverage.withPrice,
    withEquity: computed.coverage.withEquity,
    withIndustry: computed.coverage.withIndustry,
    pbWindow: computed.coverage.pbWindow,
    params: computed.params,
    // 证券集合与逐股关键值摘要：变值不变行数、变证券不变总数都会改变哈希。
    universeDigest: hashOf(computed.evaluated.map(item => item.code).sort()),
    // 不可变股票池 artifact 的内容哈希：同一目标日的重算必须能证明用的是同一份名单。
    // 只放稳定字段（哈希/数量/回放类型）；created/artifactId 属本次执行过程，进哈希会让同输入重跑建新批次。
    universeArtifact: computed.universeEvidence ? {
      contentHash: computed.universeEvidence.contentHash,
      memberCount: computed.universeEvidence.memberCount,
      replayType: computed.universeEvidence.replayType,
    } : null,
    inputsDigest: inputsDigestOf(computed),
  }, extra || {});
}

function businessStatusOf(computed, quality) {
  if (!computed.gate.eligible) {
    return computed.gate.status === 'market_closed' ? 'market_closed' : 'market_data_missing';
  }
  if (quality.publishable) {
    // R3-04：可发布但没有成员 = 明确空仓。零候选池与"有候选池但全不合格"要分开，
    // 两者都不是"数据不足"，季度应当推进而不是续跑。
    if (!computed.portfolio.members.length) {
      return quality.poolSize > 0 ? 'no_eligible_member' : 'insufficient_candidates';
    }
    return 'eligible';
  }
  return 'insufficient_data';
}

function statusOf(computed, quality) {
  return {
    executionStatus: 'succeeded',
    qualityStatus: quality.publishable ? 'passed' : 'partial',
    businessStatus: businessStatusOf(computed, quality),
  };
}

/**
 * 在同一事务里发布质量分区（方案 27.7）：首次与"复用同一逻辑 run"都必须走这里，
 * 否则重试或幂等复用会留下"指针有了、分区没有"的中间态（B01）。
 * 分区写失败直接抛错，整笔回滚——不允许 catch 后当成已原子发布。
 */
async function publishPartitionInTransaction({ input, tx, runId, computed, qualityStatus, businessStatus, isShadow }) {
  if (!input.datasetPublication) return null;
  const { publishDatasetSnapshot } = require('./datasetPartitionRegistry');
  const descriptor = await input.datasetPublication({
    runId, asOfDate: computed.asOfDate, computed, qualityStatus, businessStatus, isShadow,
  });
  if (!descriptor || !descriptor.datasetCode) return null;
  const options = Object.assign({}, descriptor.options || {});
  const publication = await publishDatasetSnapshot(descriptor.datasetCode, Object.assign(options, {
    partitionKey: options.partitionKey || computed.asOfDate,
    dataAsOf: options.dataAsOf || computed.asOfDate,
    rowCount: options.rowCount === undefined ? computed.portfolio.members.length : options.rowCount,
  }), (sql, params) => tx.query(sql, params));
  if (!publication.published) {
    const error = new Error(`选股质量分区发布失败：${publication.reason || 'unknown'}`);
    error.status = 409;
    throw error;
  }
  return publication;
}

/**
 * 计算并落库（正式季度/每日/每周 / 预览 / 个人测算共用一条路径）。
 * 只有共享非影子且质量通过的 quarterly/daily/weekly 才移动对应渠道的正式发布指针；
 * 影子只保存影子批次（分区由 Runner 另行发布），个人与预览永不发布。
 */
async function computeAndPersist(input) {
  const runKind = input.runKind || 'preview';
  if (!['quarterly', 'daily', 'weekly', 'preview', 'personal'].includes(runKind)) {
    const error = new Error('运行类型不合法');
    error.status = 400;
    throw error;
  }
  if (runKind === 'personal' && !input.ownerUsername) {
    const error = new Error('个人测算必须绑定登录用户');
    error.status = 400;
    throw error;
  }
  const isShadow = input.shadow === true || input.isShadow === true;
  if (isShadow && !['daily', 'weekly'].includes(runKind)) {
    const error = new Error('只有每日/每周模式支持影子批次');
    error.status = 400;
    throw error;
  }
  return withTransaction(async tx => {
    // 生产/预览发布路径：名单漂移只留证、不永久阻断发布；回测与审计不经过这里，仍严格。
    const computed = await computeSelection(Object.assign({}, input, { allowUniverseDrift: true }), tx);
    const isV2 = computed.strategyCode === RULES_V2.STRATEGY_CODE_V2;
    const strategyVersion = input.strategyVersion || (isV2 ? 'v2' : STRATEGY_VERSION);
    const strategyId = await repo.upsertStrategy(tx, {
      strategyCode: computed.strategyCode,
      market: computed.market,
      version: strategyVersion,
      formulaVersion: computed.params.formulaVersion,
      adapterVersion: computed.params.adapterVersion,
      riskVersion: computed.params.riskVersion,
      industryVersion: computed.params.industryVersion,
      effectiveFrom: computed.asOfDate,
      parameters: computed.params,
      contentHash: hashOf({ strategy: computed.strategyCode, params: computed.params, version: strategyVersion }),
    });
    // 周期身份：日/周/季由 run_kind 决定；预览与个人不做正式周期发布，但同样记录归属周期便于筛选。
    const periodType = input.periodType || PERIOD_TYPE_OF_KIND[runKind] || 'day';
    const periodKey = input.periodKey || PERIODS.periodKeyOf(periodType, computed.asOfDate);
    const periodRange = periodKey ? PERIODS.periodRangeOf(periodType, periodKey) : null;
    const manifestExtra = {
      positionRatio: computed.positionRatio,
      industryLimitRatio: computed.params.industryLimitRatio,
      owner: input.ownerUsername || null,
      sourceRunId: input.sourceRunId || null,
    };
    const isGraham = computed.strategyCode === GRAHAM_RULES.STRATEGY_CODE_GRAHAM;
    // V1 的输入哈希保持原样（不因 V2 上线漂移）；V2 与格雷厄姆低估额外绑定策略/周期/精度/影子身份。
    if (isV2 || isGraham) {
      manifestExtra.strategyCode = computed.strategyCode;
      manifestExtra.precisionPolicyVersion = computed.params.precisionPolicyVersion;
      manifestExtra.pbExtremaPolicy = computed.params.pbExtremaPolicy;
      if (runKind === 'daily' || runKind === 'weekly') {
        manifestExtra.periodType = periodType;
        manifestExtra.periodKey = periodKey;
        manifestExtra.isShadow = isShadow;
      }
      if (input.settingsHash) manifestExtra.settingsHash = input.settingsHash;
    }
    const manifest = manifestOf(computed, manifestExtra);
    const inputHash = hashOf(manifest);
    const quarter = input.quarter || quarterOf(computed.asOfDate);
    const ownerSubjectId = input.ownerSubjectId || null;
    // 业务身份范围锁：并发/重试必须在锁内重查内容幂等键；锁外各算一次再让随机失败者退出，
    // 会把正常并发重试当成新 revision 或漏写半个组合（方案 27.7 创建/发布并发闭环）。
    const identityKey = ['stock_selection_run', computed.market, strategyId, runKind, periodType,
      periodKey || '', isShadow ? 'shadow' : 'formal', ownerSubjectId || input.ownerUsername || ''].join(':');
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [identityKey]);
    const existing = await repo.findRunByIdempotencyKey(tx, {
      strategyId, market: computed.market, asOfDate: computed.asOfDate,
      runKind, inputHash, ownerUsername: input.ownerUsername || null,
      ownerSubjectId, periodType, isShadow,
    });
    if (existing) {
      const run = await repo.findRun(existing, tx);
      // 幂等复用同一逻辑 run：仍要保证该渠道质量分区存在（上次可能写失败），
      // 分区发布幂等且不移动指针，这是"复用/重试"路径的完成合同（B01）。
      const reusedPublication = run && run.quality_status === 'passed'
        ? await publishPartitionInTransaction({
          input, tx, runId: existing, computed,
          qualityStatus: run.quality_status, businessStatus: run.business_status, isShadow,
        })
        : null;
      return { runId: existing, reused: true, run, computed, publish: null, datasetPublication: reusedPublication };
    }
    const isFormal = ['quarterly', 'daily', 'weekly'].includes(runKind) && !isShadow;
    const revision = isFormal
      ? await repo.nextRevision(tx, { market: computed.market, quarter, strategyId, periodType, periodKey, runKind })
      : 1;
    const status = statusOf(computed, computed.quality);
    const publishable = isFormal && computed.quality.publishable;
    const computedAt = new Date();
    const runId = await repo.insertRun(tx, {
      strategyId, market: computed.market, runKind, ownerUsername: input.ownerUsername || null,
      quarter: runKind === 'quarterly' ? quarter : null,
      asOfDate: computed.asOfDate, knowledgeCutoff: knowledgeCutoffFor(computed.market, computed.asOfDate),
      executionStatus: status.executionStatus,
      qualityStatus: status.qualityStatus,
      businessStatus: status.businessStatus,
      inputHash, inputManifest: Object.assign(manifest, { quality: computed.quality, coverage: computed.coverage }),
      universeCount: computed.coverage.universeCount,
      pendingCount: computed.quality.pendingCount,
      selectedCount: computed.portfolio.members.length,
      marketPb: computed.valuation.pb, marketPe: computed.valuation.pe,
      benchmarkCode: computed.valuation.benchmarkCode,
      valuationMethod: computed.valuation.valuationMethod,
      positionRatio: computed.positionRatio,
      budgetRatio: input.budgetRatio === undefined ? null : PORTFOLIO.clampRatio(input.budgetRatio, null),
      revision,
      publishedAt: null,
      supersedesRunId: input.supersedesRunId || null,
      requestId: input.requestId || null,
      periodType, periodKey,
      periodStart: periodRange ? periodRange.periodStart : null,
      periodEnd: periodRange ? periodRange.periodEnd : null,
      sourceDailyRunId: input.sourceDailyRunId || null,
      settingsRevision: input.settingsRevision === undefined ? null : input.settingsRevision,
      settingsHash: input.settingsHash || null,
      ownerSubjectId: input.ownerSubjectId || null,
      revisionReason: input.revisionReason || null,
      computedAt,
      isShadow,
    });
    // 候选要保存全市场逐项决策，不能只留最有希望的 30 只。
    const rankedById = new Map(computed.ranked.map(item => [item.instrumentId, item]));
    const rows = computed.evaluated.map(item => {
      const rankedRow = rankedById.get(item.instrumentId) || {};
      return Object.assign({}, item, {
        anomaly: computed.anomalyById[item.instrumentId] || null,
        totalScore: rankedRow.totalScore,
        pbRank: rankedRow.pbRank,
        peRank: rankedRow.peRank,
        dividendRank: rankedRow.dividendRank,
        selectionOrder: rankedRow.selectionOrder,
        rankReady: item.rankReady === true,
        rankBlockReasons: item.rankBlockReasons || [],
      });
    });
    await repo.insertCandidates(tx, runId, rows);
    await repo.insertMembers(tx, runId, computed.portfolio.members);
    let publish = null;
    if (publishable) {
      // 指针 CAS：先读当前渠道指针并声明期望值；指针已被别的批次改写就拒绝，不能盲写（AC-04）。
      // 历史季度可能已发布但迁移前没有指针行，此时不声明期望值，仍由 revision 比较与唯一键保护。
      const pointer = await repo.findPublication({
        market: computed.market, strategyId, periodType, periodKey,
      }, tx);
      publish = await repo.publishRun(tx, runId, {
        market: computed.market,
        quarter,
        expectedRunId: pointer ? Number(pointer.run_id) : undefined,
        actor: input.actor || input.ownerUsername || null,
        subjectId: ownerSubjectId,
        slotId: input.slotId || null,
        executionToken: input.executionToken || null,
        reason: input.revisionReason || (isShadow ? 'shadow' : null),
      });
    }
    let datasetPublication = null;
    const shouldPublishDataset = input.datasetPublication
      && (isShadow ? computed.quality.publishable : (publishable && publish && publish.published));
    if (shouldPublishDataset) {
      datasetPublication = await publishPartitionInTransaction({
        input, tx, runId, computed,
        qualityStatus: status.qualityStatus, businessStatus: status.businessStatus, isShadow,
      });
    }
    const run = await repo.findRun(runId, tx);
    return { runId, reused: false, run, computed, publish, periodType, periodKey, isShadow, datasetPublication };
  }).then(async result => {
    // 提交成功后补"可见确认"时刻：事务内 now() 不能冒称对外可见时间（方案 27.7）。
    // 确认失败不能再被静默吞掉：events.visible_at IS NULL 即持久待补证据，调用方必须能看到。
    if (result.publish && result.publish.eventId) {
      try {
        const confirmed = await repo.markPublicationVisible({ runId: result.runId, eventId: result.publish.eventId });
        result.publish.visibleConfirmed = confirmed.ok === true;
        if (!confirmed.ok) {
          console.warn(`[stock-selection] 发布可见确认未落地，run=${result.runId} 留待补`);
        }
      } catch (error) {
        result.publish.visibleConfirmed = false;
        result.publish.visibleConfirmError = error.message;
        console.error(`[stock-selection] 发布可见确认失败，run=${result.runId} 留待补：`, error.message);
      }
    }
    return result;
  });
}

/**
 * 周期自动排队的到期目标（方案 27.6 / 27.8）：
 * - daily：本市场今天开市，且已过工程就绪检查时刻（默认 18:30 上海，DEV-00 需按真实发布时段校准）；
 * - weekly：今天是本周最后一个已确认开市日，且整周日历完整（缺档时不猜，等下一交易日复核）。
 * 这里只给确定性目标，是否已有批次由调用方按 hasPeriodRun 去重，不新建平行任务。
 */
/**
 * 上一个已结束周的周期目标（周一 + 最后开市日）。整周日历缺档时返回 null，不猜 T。
 * 晨间补算与「新策略首次上线回补」共用同一份推导，避免两处算法漂移。
 */
async function previousClosedWeekTarget({ market, today, strategyCode }, tx) {
  const thisMonday = PERIODS.weekMondayOf(today);
  const prevMonday = thisMonday ? PERIODS.shiftDays(thisMonday, -7) : null;
  const prevRange = prevMonday ? PERIODS.periodRangeOf('week', `W:${prevMonday}`) : null;
  if (!prevRange || prevRange.periodEnd >= today) return null;
  const weekRows = await loadPeriodCalendar({
    market, fromDate: prevRange.periodStart, toDate: prevRange.periodEnd,
  }, tx);
  const weekEvidence = PERIODS.calendarEvidenceOf(weekRows.rows, prevRange.periodStart, prevRange.periodEnd);
  const lastOpen = weekEvidence.openDays[weekEvidence.openDays.length - 1] || null;
  if (!weekEvidence.calendarComplete || !lastOpen) return null;
  return { periodType: 'week', periodKey: `W:${prevMonday}`, targetDate: lastOpen, catchup: true, strategyCode: strategyCode || null };
}

async function duePeriodicTargets({ market, now = new Date(), readyHour = 18, strategyCode } = {}, tx) {
  const normalized = normalizeMarket(market);
  const stamp = CoreDate.dateTimeInZone(now, 'Asia/Shanghai');
  if (!stamp) return [];
  const today = stamp.slice(0, 10);
  const readyNow = Number(stamp.slice(11, 13)) >= readyHour;
  const targets = [];
  if (!readyNow) {
    // 非就绪时段（晨间或提前执行）：补"上一个已结束的交易日 + 上一周"，覆盖迟到与跨日补算。
    // 已有批次由调用方 hasPeriodRun 去重，不会重复建槽；整周日历缺档时不猜 T。
    const lookbackStart = PERIODS.shiftDays(today, -20);
    const rows = await loadPeriodCalendar({ market: normalized, fromDate: lookbackStart, toDate: today }, tx);
    const evidence = PERIODS.calendarEvidenceOf(rows.rows, lookbackStart, today);
    const pastDays = evidence.openDays.filter(day => day < today);
    const prevDay = pastDays[pastDays.length - 1] || null;
    if (prevDay) {
      targets.push({ periodType: 'day', periodKey: `D:${prevDay}`, targetDate: prevDay, catchup: true, strategyCode: strategyCode || null });
    }
    const prevWeek = await previousClosedWeekTarget({ market: normalized, today, strategyCode }, tx);
    if (prevWeek) targets.push(prevWeek);
    return targets;
  }
  const dayRows = await loadPeriodCalendar({ market: normalized, fromDate: today, toDate: today }, tx);
  const dayEvidence = PERIODS.calendarEvidenceOf(dayRows.rows, today, today);
  if (dayEvidence.openDays.length === 1) {
    targets.push({ periodType: 'day', periodKey: `D:${today}`, targetDate: today, strategyCode: strategyCode || null });
  }
  const monday = PERIODS.weekMondayOf(today);
  const weekRange = monday ? PERIODS.periodRangeOf('week', `W:${monday}`) : null;
  if (weekRange) {
    const weekRows = await loadPeriodCalendar({
      market: normalized, fromDate: weekRange.periodStart, toDate: weekRange.periodEnd,
    }, tx);
    const weekEvidence = PERIODS.calendarEvidenceOf(weekRows.rows, weekRange.periodStart, weekRange.periodEnd);
    const lastOpen = weekEvidence.openDays[weekEvidence.openDays.length - 1] || null;
    if (weekEvidence.calendarComplete && lastOpen === today) {
      targets.push({ periodType: 'week', periodKey: `W:${monday}`, targetDate: today, strategyCode: strategyCode || null });
    }
  }
  // 新策略首次上线：该策略在该市场还没有任何正式批次时，额外补上一个已结束周。
  // 否则周批次只能等「本周最后一个开市日」，页面在策略上线后最长空白一周——
  // 2026-11-22 格雷厄姆低估上线后正是这样（11-22 是周日，等到 11-27 周五才有周批次）。
  if (strategyCode && await repo.hasNoPeriodRunAtAll({ market: normalized, strategyCode }, tx)) {
    const prevWeek = await previousClosedWeekTarget({ market: normalized, today, strategyCode }, tx);
    if (prevWeek && !targets.some(item => item.periodKey === prevWeek.periodKey)) targets.push(prevWeek);
  }
  return targets;
}

/** 该渠道是否已有正式批次（自动排队去重用）。 */
async function hasPeriodRun(query) {
  return repo.hasPeriodRun(query);
}

/** 季度自动执行：目标日与季度都由交易日历推导，不用执行当天替代。 */
async function runQuarterly({ market, quarter, requestId, strategyVersion, strategyCode, actor, slotId, executionToken }) {
  const normalized = normalizeMarket(market);
  // 缺省季度由最近一个已结束季度解析（管理员不带季度直接点计算也必须有确定目标日）。
  const resolvedQuarter = quarter || (await pendingQuarter({ market: normalized })).quarter;
  if (!resolvedQuarter) {
    return { ok: false, status: 'blocked', reason: 'selection_quarter_unresolved', market: normalized, quarter: null };
  }
  const target = await resolveQuarterTarget({ market: normalized, quarter: resolvedQuarter }, null);
  if (!target.asOfDate) {
    return { ok: false, status: 'blocked', reason: target.reason, market: normalized, quarter };
  }
  const result = await computeAndPersist({
    market: normalized, asOfDate: target.asOfDate, quarter: resolvedQuarter, runKind: 'quarterly',
    requestId, strategyVersion, strategyCode, positionRatio: 1,
    actor, slotId, executionToken,
  });
  return {
    ok: true,
    market: normalized,
    quarter: resolvedQuarter,
    quarterDate: target.asOfDate,
    periodType: 'quarter',
    periodKey: result.periodKey || `Q:${resolvedQuarter}`,
    runId: result.runId,
    reused: result.reused,
    qualityStatus: result.run.quality_status,
    businessStatus: result.run.business_status,
    published: !!result.run.published_at,
    selectedCount: Number(result.run.selected_count || 0),
    // 阶段完成裁决需要区分"正式发布 / 市场正常关闭 / 只是预览"，这些证据必须一起返回。
    pendingCount: Number(result.run.pending_count || 0),
    qualityReasons: computedQualityReasons(result),
  };
}

/**
 * 周期目标日：先按周期键（或给定日期所在周期）算起止，再取该周期内最后一个开市日。
 * 整周期休市返回 no_session（运营证据），不改用别的日期凑一次计算（方案 27.6）。
 */
async function resolvePeriodTarget({ market, periodType, date, periodKey }, tx) {
  const normalized = normalizeMarket(market);
  const type = String(periodType || '').toLowerCase();
  if (!PERIODS.PERIOD_TYPES.includes(type)) {
    const error = new Error('周期类型不合法');
    error.status = 400;
    throw error;
  }
  let key = periodKey || null;
  if (!key) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
      const error = new Error('目标日期参数不合法');
      error.status = 400;
      throw error;
    }
    key = PERIODS.periodKeyOf(type, date);
  }
  const range = key ? PERIODS.periodRangeOf(type, key) : null;
  if (!range) {
    const error = new Error('周期键不合法');
    error.status = 400;
    throw error;
  }
  const calendar = await loadPeriodCalendar({ market: normalized, fromDate: range.periodStart, toDate: range.periodEnd }, tx);
  const evidence = PERIODS.calendarEvidenceOf(calendar.rows, range.periodStart, range.periodEnd);
  const calendarFields = {
    calendarComplete: evidence.calendarComplete,
    missingDates: evidence.missingDates,
    expectedCalendarDays: evidence.expectedCalendarDays,
  };
  // 日历缺档与整周期休市必须分开（方案 27.5 第 1 条 / 27.6）：
  // 只查到几条开市行就当成完整周，会把某一天直接定成周度 T（AC-07）。
  if (calendar.authoritative && !evidence.calendarComplete) {
    return { market: normalized, periodType: type, periodKey: key, ...range, ...calendarFields, asOfDate: null, reason: 'calendar_incomplete' };
  }
  if (!evidence.openDays.length) {
    if (!calendar.authoritative) {
      return { market: normalized, periodType: type, periodKey: key, ...range, ...calendarFields, asOfDate: null, reason: 'calendar_unavailable' };
    }
    // 整周期全休市是运营证据（no_session），不是故障。
    return { market: normalized, periodType: type, periodKey: key, ...range, ...calendarFields, asOfDate: null, reason: 'no_session' };
  }
  const asOfDate = evidence.openDays[evidence.openDays.length - 1];
  // 未结束周期不得提前形成正式结果：T 不能晚于今天（上海），跨T日完成由延迟/补算表达（方案 27.6）。
  const today = CoreDate.todayInZone('Asia/Shanghai');
  if (asOfDate > today) {
    return { market: normalized, periodType: type, periodKey: key, ...range, ...calendarFields, asOfDate: null, reason: 'period_not_finished', targetDate: asOfDate };
  }
  // 日周期必须正好落在交易日，不允许把"周内最后开市日"当成某一天的结果。
  if (type === 'day' && asOfDate !== date && date) {
    return { market: normalized, periodType: type, periodKey: key, ...range, ...calendarFields, asOfDate: null, reason: 'no_session', targetDate: date };
  }
  return { market: normalized, periodType: type, periodKey: key, ...range, ...calendarFields, asOfDate, reason: null };
}

/**
 * 周期日历行：优先取逐日证据（含休市），旧测试替身只提供 loadCalendar 时退回开市日语义，
 * 并标记 authoritative=false —— 非权威证据不得用来断言"日历完整"。
 */
async function loadPeriodCalendar({ market, fromDate, toDate }, tx) {
  if (typeof repo.loadCalendarEvidence === 'function') {
    const rows = await repo.loadCalendarEvidence({ market, fromDate, toDate }, tx);
    return { rows, authoritative: true };
  }
  const days = await repo.loadCalendar({ market, fromDate, toDate }, tx);
  return { rows: (days || []).map(day => ({ trade_date: day, is_open: true })), authoritative: false };
}

/**
 * 每日/每周执行（方案 27.8 的 selection_daily / selection_weekly）。
 * 影子批次（shadow=true）只保存影子结果，不移动正式指针、不写正式分区。
 */
async function runPeriodic(input) {
  const market = normalizeMarket(input.market);
  const periodType = String(input.periodType || '').toLowerCase();
  if (!['day', 'week'].includes(periodType)) {
    const error = new Error('周期类型不合法');
    error.status = 400;
    throw error;
  }
  const shadow = input.shadow === true;
  const strategyCode = normalizeStrategyCode(input.strategyCode);
  const target = await resolvePeriodTarget({ market, periodType, date: input.targetDate || input.date, periodKey: input.periodKey });
  if (!target.asOfDate) {
    return {
      ok: false, status: target.reason === 'no_session' ? 'no_session' : 'blocked',
      reason: target.reason, market, periodType, periodKey: target.periodKey,
      periodStart: target.periodStart, periodEnd: target.periodEnd, shadow, runId: null,
    };
  }
  const runKind = periodType === 'day' ? 'daily' : 'weekly';
  // 前置就绪检查（B1-2）：先按本市场目标日 T 的已发布上游证据判定能不能算。
  // 未就绪时立即返回，不调用 computeSelection、不写 runs/candidates 的 partial 试算批次。
  const readiness = await readinessService.assessPeriodReadiness({
    market, periodType, asOfDate: target.asOfDate, periodKey: target.periodKey,
    // 调用方显式给出的时钟必须透传（回测/回归固定"现在"）；未传时保持就绪模块默认的 new Date()。
    now: input.now,
  });
  if (readiness.ready !== true) {
    return {
      ok: true,
      status: 'not_ready',
      reason: 'selection_not_ready',
      readinessStatus: 'not_ready',
      waitReason: 'selection_not_ready',
      market,
      periodType,
      periodKey: target.periodKey,
      periodStart: target.periodStart,
      periodEnd: target.periodEnd,
      asOfDate: target.asOfDate,
      shadow,
      runId: null,
      reused: false,
      qualityStatus: null,
      businessStatus: null,
      published: false,
      selectedCount: 0,
      pendingCount: 0,
      qualityReasons: [],
      nextCheckAt: readiness.nextCheckAt,
      // 精确缺失分区/域清单：由就绪检查给出，不用"selection 数据集没写"这种结果倒推。
      missingDatasets: readiness.missingDatasets || [],
      missingDomains: readiness.missingDomains || [],
      readinessEvidence: readiness.evidence || {},
      strategyCode,
      datasetPublication: null,
    };
  }
  const result = await computeAndPersist({
    market,
    asOfDate: target.asOfDate,
    runKind,
    periodType,
    periodKey: target.periodKey,
    shadow,
    strategyCode,
    requestId: input.requestId,
    actor: input.actor || null,
    slotId: input.slotId || null,
    executionToken: input.executionToken || null,
    positionRatio: 1,
    sourceDailyRunId: input.sourceDailyRunId || null,
    // 质量分区回调必须原样下沉到 computeAndPersist：否则 Runner 传进来的 datasetPublication
    // 在日/周路径被静默丢弃，指针已提交但分区缺失（B01）。
    datasetPublication: input.datasetPublication || null,
    ownerSubjectId: input.ownerSubjectId || null,
  });
  const quality = (result.run && result.run.input_manifest && result.run.input_manifest.quality) || {};
  const readinessStatus = result.run && result.run.quality_status === 'passed' ? 'ready' : 'not_ready';
  return {
    ok: true,
    status: result.run && result.run.quality_status === 'passed' ? 'succeeded' : 'partial',
    market,
    periodType,
    periodKey: target.periodKey,
    periodStart: target.periodStart,
    periodEnd: target.periodEnd,
    asOfDate: target.asOfDate,
    shadow,
    runId: result.runId,
    reused: result.reused,
    qualityStatus: result.run.quality_status,
    businessStatus: result.run.business_status,
    published: !!result.run.published_at,
    selectedCount: Number(result.run.selected_count || 0),
    pendingCount: Number(result.run.pending_count || 0),
    qualityReasons: computedQualityReasons(result),
    readinessStatus,
    quality,
    strategyCode,
    // 分区发布结果必须回传：Runner 用它判定 stageComplete 与失败原因，不能只报 published。
    datasetPublication: result.datasetPublication || null,
  };
}

/** 当前周期就绪概览：供 /markets 说明"本周/今日是否已就绪"，不用 daily 冒充 weekly。 */
async function periodStatus({ market, periodType, strategyCode, date }) {
  const normalized = normalizeMarket(market);
  const type = String(periodType || 'week').toLowerCase();
  const today = /^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))
    ? String(date)
    : CoreDate.todayInZone('Asia/Shanghai');
  const periodKey = PERIODS.periodKeyOf(type, today);
  const range = periodKey ? PERIODS.periodRangeOf(type, periodKey) : null;
  const code = normalizeStrategyCode(strategyCode);
  const strategyId = await repo.findStrategyId({ market: normalized, strategyCode: code });
  const latest = await repo.latestPublishedRun({ market: normalized, strategyId, periodType: type });
  const target = await resolvePeriodTarget({ market: normalized, periodType: type, date: today });
  return {
    market: normalized,
    periodType: type,
    periodKey,
    periodStart: range ? range.periodStart : null,
    periodEnd: range ? range.periodEnd : null,
    strategyCode: code,
    asOfDate: target.asOfDate,
    readinessStatus: target.asOfDate ? 'calendar_ready' : 'not_ready',
    readinessReason: target.reason || null,
    // "本周待就绪 + 最近一次历史正式结果日期"是页面必须能同时看到的两件事（方案 27.6）。
    latest: latest ? {
      runId: Number(latest.run_id),
      periodType: latest.period_type || 'quarter',
      periodKey: latest.period_key || (latest.quarter ? `Q:${latest.quarter}` : null),
      asOfDate: latest.as_of_date,
      revision: Number(latest.revision || 1),
      selectedCount: Number(latest.selected_count || 0),
      publishedAt: latest.published_at,
    } : null,
    samePeriodPublished: Boolean(latest && latest.period_key === periodKey),
  };
}

// 质量裁决的阻断原因随批次落库在 input_manifest.quality，这里只做安全读取。
function computedQualityReasons(result) {
  const manifest = result && result.run && result.run.input_manifest;
  const quality = manifest && manifest.quality;
  return (quality && Array.isArray(quality.reasons)) ? quality.reasons : [];
}

/** 该季度是否已有可核验的完成终态（R5-03）：走仓储存在性查询，不受列表分页影响。 */
async function hasCompletedQuarter({ market, quarter }) {
  if (!quarter) return false;
  return repo.hasCompletedQuarterRun({ market: normalizeMarket(market), quarter });
}

/** 该市场待生成的最近一个完整季度（用于自动排队）。 */
async function pendingQuarter({ market, now }) {
  const normalized = normalizeMarket(market);
  // 业务日按上海时区取，不用 UTC 截日（INC-0032 口径）。
  const today = typeof now === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(now)
    ? now
    : CoreDate.todayInZone('Asia/Shanghai', now instanceof Date ? now : new Date());
  const currentQuarter = quarterOf(today);
  const currentEnd = quarterEndDate(currentQuarter);
  const previousQuarter = today <= currentEnd ? previousQuarterOf(currentQuarter) : currentQuarter;
  return { quarter: previousQuarter, quarterEnd: quarterEndDate(previousQuarter) };
}

function previousQuarterOf(quarter) {
  const match = /^(\d{4})Q([1-4])$/.exec(quarter);
  const year = Number(match[1]);
  const q = Number(match[2]);
  if (q === 1) return `${year - 1}Q4`;
  return `${year}Q${q - 1}`;
}

/**
 * 市场概览：指数 PB/PE（仅展示）、准入结论与当前周期就绪情况。
 * V2 的 ready 只看"本周期是否有正式结果"，不再依赖指数 PB（方案 27.3）；
 * 同时单独给出每日/每周状态，"本周未就绪"不能拿 daily 结果顶替。
 */
async function getMarkets({ strategyCode, periodType } = {}) {
  const code = normalizeStrategyCode(strategyCode);
  const isV2 = code === RULES_V2.STRATEGY_CODE_V2;
  const params = isV2 ? RULES_V2.V2_PARAMS : RULES.DEFAULT_PARAMS;
  const requestedPeriodType = ['day', 'week', 'quarter'].includes(String(periodType || '').toLowerCase())
    ? String(periodType).toLowerCase() : null;
  const activePeriodType = requestedPeriodType || (isV2 ? 'week' : 'quarter');
  const markets = [];
  for (const market of ['CN', 'HK']) {
    const config = repo.MARKET_CONFIG[market];
    // 页面只读库：取该指数最近一条可用估值日期，不触发任何外部采集。
    const latest = await repo.loadLatestMarketValuation({ market });
    const gate = isV2 ? RULES_V2.evaluateMarketGateV2(latest) : RULES.evaluateMarketGate(latest, params);
    const strategyId = await repo.findStrategyId({ market, strategyCode: code });
    const published = await repo.latestPublishedRun({ market, strategyId, periodType: activePeriodType });
    // 就绪 = 已激活策略在本周期有正式结果；指数 PB 是否合格不再是条件。
    const ready = isV2 ? !!published : (gate.eligible && !!published);
    let weekly = null;
    let daily = null;
    if (isV2) {
      weekly = await periodStatus({ market, periodType: 'week', strategyCode: code }).catch(() => null);
      daily = await periodStatus({ market, periodType: 'day', strategyCode: code }).catch(() => null);
    }
    const selectedPeriodStatus = activePeriodType === 'day' ? daily : activePeriodType === 'week' ? weekly : null;
    markets.push({
      market,
      label: MARKET_LABEL[market],
      benchmarkCode: config.benchmarkCode,
      benchmarkLabel: market === 'CN' ? '中证全指' : '恒生指数',
      valuationMethod: 'market_cap_weighted',
      valuationMethodLabel: '总市值加权',
      // 页面名称必须写清是"市场代理"，不能标成精确全市场整体 PB（方案 3.2）。
      proxyLabel: market === 'CN' ? '中证全指PB（A股市场代理）' : '恒生指数PB（港股市场代理）',
      asOfDate: latest.tradeDate,
      pb: latest.pb,
      pe: latest.pe,
      sourceCode: latest.sourceCode,
      gate,
      // V2 明确标注指数估值只作参考，不参与是否配置（用户可见文案见方案 27.15）。
      marketValuationRole: isV2 ? 'display_only' : 'gate',
      referencePosition: RULES.referencePositionForPb(latest.pb),
      latestRun: published,
      ready,
      activePeriodType,
      selectedPeriodStatus,
      weekly,
      daily,
    });
  }
  return { markets, params, strategyCode: code, activePeriodType };
}

async function getRun(runId) {
  const run = await repo.findRun(runId);
  if (!run) return null;
  return run;
}

// 个人生成与旧结果解释复用同一份冻结候选投影，不重算基础资格/排名。
function personalPortfolioOf(rows, { positionRatio, params, exclusion, legacyIndustryCodes = [] }) {
  const anomalyById = {};
  const ranked = rows.filter(row => row.filter_status === RULES.STATUS.PASS).map(row => {
    const detail = row.detail || {};
    if (detail.anomaly) anomalyById[Number(row.instrument_id)] = detail.anomaly;
    return {
      instrumentId: Number(row.instrument_id), code: row.code, name: row.name,
      companyId: row.company_id === null ? null : Number(row.company_id),
      currentPb: row.current_pb === null ? null : Number(row.current_pb),
      currentPe: row.current_pe === null ? null : Number(row.current_pe),
      dividendYield: row.dividend_yield === null ? null : Number(row.dividend_yield),
      profitStatus: row.ttm_profit_status || row.profit_status,
      ttmProfitStatus: row.ttm_profit_status || row.profit_status,
      filterStatus: row.filter_status,
      rankReady: row.rank_ready === null || row.rank_ready === undefined ? detail.rankReady !== false : row.rank_ready === true,
      selectionOrder: row.selection_order,
      industry: row.industry_code ? { code: row.industry_code, name: row.industry_name, system: row.industry_system, version: row.industry_version } : null,
    };
  });
  return PORTFOLIO.buildPortfolio({ ranked, anomalyById, positionRatio, params,
    excludedInstrumentIds: exclusion.instrumentIds, excludedIndustryKeys: exclusion.industryKeys,
    excludedIndustryCodes: legacyIndustryCodes });
}

function personalSelectionOutcomes(portfolio) {
  return (portfolio.skipped || []).map(item => ({ instrumentId: Number(item.instrumentId), reason: item.reason }))
    .concat((portfolio.watchlist || []).map(item => ({ instrumentId: Number(item.instrumentId), reason: 'zero_position' })));
}

async function personalSelectionContext(run) {
  const manifest = run.input_manifest || {};
  const settings = manifest.settingsSnapshot || {};
  const exclusion = exclusionOf(settings, run.market);
  if (Array.isArray(manifest.excludedInstrumentIds)) exclusion.instrumentIds = manifest.excludedInstrumentIds.map(Number);
  if (Array.isArray(manifest.excludedIndustryKeys)) exclusion.industryKeys = manifest.excludedIndustryKeys;
  // 旧版按代码过滤的批次按其原冻结载荷解释，不把新完整身份语义套回旧结果。
  const legacyIndustryCodes = !Array.isArray(manifest.excludedIndustryKeys) && Array.isArray(manifest.excludedIndustryCodes)
    ? manifest.excludedIndustryCodes.map(String) : [];
  const selected = new Set((await repo.listMembers(run.run_id)).map(row => Number(row.instrument_id)));
  const frozen = run.input_manifest && run.input_manifest.portfolio;
  let outcomes = frozen && frozen.selectionOutcomes;
  if (!Array.isArray(outcomes) && run.position_ratio !== null && run.position_ratio !== undefined) {
    // 历史个人结果没有原因摘要：只读其已复制的冻结候选，复用原席位规则回放，不写回旧快照。
    const rows = await repo.listCandidatesForProjection({ runId: run.run_id });
    const replay = personalPortfolioOf(rows, {
      positionRatio: Number(run.position_ratio), params: run.parameters || {}, exclusion, legacyIndustryCodes,
    });
    // 历史算法不一致时不编造具体原因，实际成员始终以该快照落库结果为准。
    const sameMembers = replay.members.length === selected.size && replay.members.every(item => selected.has(Number(item.instrumentId)));
    outcomes = sameMembers ? personalSelectionOutcomes(replay) : [];
  }
  return { exclusion, selected, legacyIndustryCodes, outcomes: new Map((outcomes || []).map(item => [Number(item.instrumentId), item.reason])) };
}

function withPersonalSelection(row, context) {
  const { exclusion, selected, outcomes, legacyIndustryCodes } = context;
  const industry = row.industry_code ? {
    code: row.industry_code, system: row.industry_system, version: row.industry_version,
  } : null;
  const industryKey = industry ? PORTFOLIO.industryIdentityKey(industry) : null;
  const byStock = exclusion.instrumentIds.includes(Number(row.instrument_id));
  const byIndustry = !!industryKey && (exclusion.industryKeys.includes(industryKey) || legacyIndustryCodes.includes(String(row.industry_code)));
  const reasons = [];
  if (byStock) reasons.push('user_excluded_instrument');
  if (byIndustry) reasons.push('user_excluded_industry');
  const isSelected = selected.has(Number(row.instrument_id));
  const ruleReason = row.filter_status === RULES.STATUS.FAIL ? 'rule_not_passed'
    : row.filter_status === RULES.STATUS.NOT_APPLICABLE ? 'rule_not_evaluable'
      : row.filter_status === RULES.STATUS.RISK ? 'risk_held'
        : row.filter_status !== RULES.STATUS.PASS ? 'rule_or_data_pending' : 'not_selected';
  return Object.assign(row, {
    personalExcluded: reasons.length > 0,
    personalExclusionReasons: reasons,
    personalSelected: isSelected,
    personalStatus: isSelected ? 'selected' : (reasons.length ? 'excluded' : 'not_selected'),
    personalNonSelectionReasons: isSelected ? [] : reasons.length ? reasons : [outcomes.get(Number(row.instrument_id)) || ruleReason],
  });
}

async function getCandidates(query) {
  const result = await repo.listCandidates(query);
  const run = await repo.findRun(query.runId);
  if (!run || run.run_kind !== 'personal') return result;
  const context = await personalSelectionContext(run);
  result.rows = result.rows.map(row => withPersonalSelection(row, context));
  return result;
}

async function getPortfolio(runId, options = {}) {
  const run = await repo.findRun(runId);
  if (!run) return null;
  const members = await repo.listMembers(runId);
  // #39：按本批次冻结的目标日与可见截止补充两项基本面指标，只读历史批次，不改库表结构。
  const memberFundamentals = await repo.loadMemberFundamentals({
    companyIds: [...new Set(members.map(member => Number(member.company_id))
      .filter(companyId => Number.isFinite(companyId) && companyId > 0))],
    asOfDate: run.as_of_date_text,
    availableBefore: run.knowledge_cutoff_text,
    market: run.market,
  });
  const sourceRun = run.run_kind === 'personal' && run.supersedes_run_id
    ? await repo.findRun(run.supersedes_run_id) : null;
  const sourceIndustryIdentityCounts = await repo.listIndustryIdentityCounts(
    sourceRun ? Number(sourceRun.run_id) : Number(runId));
  let baseline;
  if (options.baselineRunId) {
    const requested = await repo.findRun(options.baselineRunId);
    const sameOwner = requested && requested.run_kind === 'personal'
      && ((run.owner_subject_id && String(requested.owner_subject_id) === String(run.owner_subject_id))
        || (!run.owner_subject_id && !requested.owner_subject_id && requested.owner_username === run.owner_username));
    if (!sourceRun || !requested || (Number(requested.run_id) !== Number(sourceRun.run_id)
      && !(sameOwner && Number(requested.supersedes_run_id) === Number(sourceRun.run_id)))) {
      const error = new Error('比较基线与个人组合来源或主体不一致');
      error.status = 400;
      throw error;
    }
    baseline = { run: requested, rows: await repo.listMembers(requested.run_id) };
  } else if (sourceRun) {
    const personalBaseline = await repo.previousPersonalMembers({
      market: run.market,
      sourceRunId: Number(sourceRun.run_id),
      excludeRunId: Number(runId),
      ownerUsername: run.owner_username,
      ownerSubjectId: run.owner_subject_id,
    });
    baseline = personalBaseline.run ? personalBaseline : await repo.previousPublishedMembers({
      market: run.market,
      asOfDate: null,
      excludeRunId: Number(runId),
      periodType: sourceRun.period_type || 'quarter',
      sourceRunId: Number(sourceRun.run_id),
    });
  } else {
    baseline = await repo.previousPublishedMembers({
      market: run.market,
      asOfDate: run.as_of_date_text,
      excludeRunId: Number(runId),
      periodType: run.period_type || 'quarter',
      sourceRunId: null,
    });
  }
  const previous = baseline.rows;
  const currentIds = new Set(members.map(member => Number(member.instrument_id)));
  const previousIds = new Set(previous.map(row => Number(row.instrument_id)));
  const changes = {
    // 有效零成员批次也属于可比较基线，不能用 rows.length 判断是否存在历史。
    comparable: !!baseline.run,
    basis: run.run_kind === 'personal'
      ? (baseline.run && baseline.run.run_kind === 'personal' ? 'previous_personal_run' : 'source_public_run')
      : ((run.period_type || 'quarter') === 'quarter' ? 'previous_period' : 'previous_same_channel'),
    previousRunId: baseline.run ? Number(baseline.run.run_id) : null,
    previousPeriodKey: baseline.run ? baseline.run.period_key : null,
    previousQuarter: baseline.run ? baseline.run.quarter : null,
    previousAsOfDate: baseline.run ? baseline.run.as_of_date : null,
    added: members.filter(member => !previousIds.has(Number(member.instrument_id)))
      .map(member => ({ code: member.code, name: member.name, slotNo: member.slot_no })),
    removed: previous.filter(row => !currentIds.has(Number(row.instrument_id)))
      .map(row => ({ code: row.code, name: row.name })),
    kept: members.filter(member => previousIds.has(Number(member.instrument_id))).length,
  };
  const positionRatio = run.position_ratio === null || run.position_ratio === undefined ? null : Number(run.position_ratio);
  const slots = RULES.DEFAULT_PARAMS.slotsPerMarket;
  const investedDenominator = members.length;
  const industryBreakdown = [];
  const industryCount = new Map();
  members.forEach(member => {
    const key = member.industry_code || 'unverified';
    const entry = industryCount.get(key) || {
      industryCode: key, industryName: member.industry_name || null, count: 0, weightInMarketBudget: 0,
    };
    entry.count += 1;
    const memberWeight = member.weight_in_market_budget === null || member.weight_in_market_budget === undefined
      ? null : Number(member.weight_in_market_budget);
    entry.weightInMarketBudget = entry.weightInMarketBudget === null || memberWeight === null
      ? null : entry.weightInMarketBudget + memberWeight;
    industryCount.set(key, entry);
  });
  industryCount.forEach(entry => {
    industryBreakdown.push(Object.assign(entry, {
      weightInMarketBudget: entry.weightInMarketBudget,
      // 实际股票子组合口径：不足 30 席时它和 1/30 不同；行业占预算 13.33% 不等于占股票 13.33%。
      weightInInvestedEquity: investedDenominator > 0 ? entry.count / investedDenominator : null,
      limitRatio: RULES.DEFAULT_PARAMS.industryLimitRatio,
    }));
  });
  const weightsComplete = members.every(member => member.weight_in_market_budget !== null && member.weight_in_market_budget !== undefined);
  const equityWeight = weightsComplete
    ? members.reduce((sum, member) => sum + Number(member.weight_in_market_budget), 0)
    : null;
  return {
    runId: Number(runId),
    market: run.market,
    runKind: run.run_kind,
    periodType: run.period_type || null,
    periodKey: run.period_key || null,
    periodStart: run.period_start_text || null,
    periodEnd: run.period_end_text || null,
    sourceRunId: sourceRun ? Number(sourceRun.run_id) : (run.run_kind === 'personal' ? null : Number(run.run_id)),
    sourceRevision: sourceRun ? Number(sourceRun.revision || 1) : Number(run.revision || 1),
    settingsRevision: run.settings_revision === null || run.settings_revision === undefined ? null : Number(run.settings_revision),
    strategyCode: run.strategy_code || null,
    isShadow: run.is_shadow === true,
    computedAt: run.computed_at || null,
    asOfDate: run.as_of_date_text,
    positionRatio,
    budgetRatio: run.budget_ratio === null ? null : Number(run.budget_ratio),
    slots,
    selectedCount: members.length,
    unfilledSlots: slots - members.length,
    equityWeightInMarketBudget: equityWeight,
    cashWeightInMarketBudget: equityWeight === null ? null : 1 - equityWeight,
    // 三种权重分母分开给，页面不要用一个"权重"混着说（方案 27.9）。
    weightBasis: {
      weightInMarketBudget: positionRatio === null ? null : positionRatio / slots,
      weightInEquityTarget: 1 / slots,
      weightInInvestedEquity: investedDenominator > 0 ? 1 / investedDenominator : null,
      investedDenominator,
    },
    changes,
    sourceIndustryIdentityCounts: sourceIndustryIdentityCounts.map(row => ({
      code: row.code,
      name: row.name || null,
      system: row.system || null,
      version: row.version || null,
      affectedCount: Number(row.affected_count || 0),
    })),
    members: members.map(member => {
      const fundamental = memberFundamentals.get(String(member.company_id)) || {};
      return {
        instrumentId: Number(member.instrument_id),
        slotNo: member.slot_no,
        code: member.code,
        name: member.name,
        companyId: member.company_id,
        industryCode: member.industry_code,
        industryName: member.industry_name,
        industrySystem: member.industry_system,
        industryVersion: member.industry_version,
        weightInMarketBudget: member.weight_in_market_budget === null || member.weight_in_market_budget === undefined
          ? null : Number(member.weight_in_market_budget),
        weightInEquityTarget: member.weight_in_equity_target === null || member.weight_in_equity_target === undefined
          ? null : Number(member.weight_in_equity_target),
        weightInInvestedEquity: member.weight_in_invested_equity === null || member.weight_in_invested_equity === undefined
          ? null : Number(member.weight_in_invested_equity),
        issuerDuplicate: member.issuer_duplicate,
        currentPb: member.current_pb === null ? null : Number(member.current_pb),
        currentPe: member.current_pe === null ? null : Number(member.current_pe),
        dividendYield: member.dividend_yield === null ? null : Number(member.dividend_yield),
        // 最近一期合并报表口径（缺失为 null，页面显示“—”）：不写入快照表。
        debtToAssetRatio: fundamental.debtToAssetRatio === null || fundamental.debtToAssetRatio === undefined
          ? null : Number(fundamental.debtToAssetRatio),
        debtToAssetPeriodEnd: fundamental.debtToAssetPeriodEnd || null,
        latestProfitYoy: fundamental.latestProfitYoy === null || fundamental.latestProfitYoy === undefined
          ? null : Number(fundamental.latestProfitYoy),
        latestProfitPeriodEnd: fundamental.latestProfitPeriodEnd || null,
        totalScore: member.total_score === null ? null : Number(member.total_score),
        // V2 解释字段：估值通过路径与历史极值，和"最终入选"分开说明。
        valuationStatus: member.valuation_status || null,
        valuationPassReason: member.valuation_pass_reason || null,
        pbPeProduct: member.pb_pe_product === null || member.pb_pe_product === undefined ? null : Number(member.pb_pe_product),
        historicalPbMin: member.historical_pb_min === null || member.historical_pb_min === undefined ? null : Number(member.historical_pb_min),
        historicalPbMax: member.historical_pb_max === null || member.historical_pb_max === undefined ? null : Number(member.historical_pb_max),
        pbPositiveExtremaRatio: member.pb_positive_extrema_ratio === null || member.pb_positive_extrema_ratio === undefined
          ? null : Number(member.pb_positive_extrema_ratio),
        ttmProfitStatus: member.ttm_profit_status || null,
      };
    }),
    industryBreakdown,
  };
}

/**
 * 淘汰详情历史回放（B3-2）：被裁剪的年度数组按该 run 的目标日与可见截止回查原表，
 * 重算年度指纹并与写入时冻结的 `annual.yearsDigest` 比对。
 * 只有指纹完全一致才把这些年份作为"当时事实"返回；不一致（被更正过/版本变化）时显式
 * `verified:false` 且不返回年份，绝不拿今日修订后的报表冒充历史快照。
 */
async function historicalAnnualReplayOf(run, candidate, tx) {
  const annual = candidate && candidate.detail ? candidate.detail.annual : null;
  if (!annual || annual.yearsTrimmed !== true) {
    return { required: false, verified: null, years: null, reason: 'frozen_detail_complete' };
  }
  const companyId = candidate.company_id === null || candidate.company_id === undefined
    ? null : Number(candidate.company_id);
  if (!Number.isFinite(companyId) || companyId <= 0) {
    return { required: true, verified: false, years: null, reason: 'company_identity_missing' };
  }
  try {
    const params = {
      companyIds: [companyId], asOfDate: run.as_of_date_text,
      availableBefore: run.knowledge_cutoff_text, market: run.market,
    };
    const [profits, dividends] = await Promise.all([
      repo.loadAnnualProfits(params, tx),
      repo.loadAnnualDividends(params, tx),
    ]);
    // 复用 annualFactsOf 这一唯一入口，保证回放与实时计算拿到的年度事实同源。
    const rebuilt = annualFactsOf(
      profits.get(String(companyId)) || [], dividends.get(String(companyId)) || [], candidate.code, null, null);
    const years = rebuilt.years;
    const matches = !!annual.yearsDigest && annual.yearsDigest === repo.annualYearsDigest(years);
    return {
      required: true, verified: matches,
      years: matches ? years : null,
      reason: matches ? 'frozen_digest_matched' : 'frozen_digest_mismatch',
    };
  } catch (error) {
    // 回放查询失败不能伪造成"已验证一致"，也不能拖垮整个详情读取。
    return { required: true, verified: false, years: null, reason: 'replay_query_failed' };
  }
}

async function getStockDetail({ runId, code }) {
  const run = await repo.findRun(runId);
  if (!run) return null;
  const candidate = await repo.findCandidate({ runId, code });
  if (!candidate) return null;
  if (run.run_kind === 'personal') withPersonalSelection(candidate, await personalSelectionContext(run));
  const historicalReplay = await historicalAnnualReplayOf(run, candidate);
  return {
    runId: Number(runId),
    market: run.market,
    asOfDate: run.as_of_date_text,
    strategyVersion: run.strategy_version,
    knowledgeCutoff: run.knowledge_cutoff_text,
    historicalReplay,
    historicalReplayVerified: historicalReplay.required ? historicalReplay.verified : null,
    candidate: {
      code: candidate.code,
      name: candidate.name,
      instrumentId: Number(candidate.instrument_id),
      companyId: candidate.company_id === null ? null : Number(candidate.company_id),
      industry: candidate.industry_code ? {
        code: candidate.industry_code, name: candidate.industry_name,
        system: candidate.industry_system, version: candidate.industry_version,
      } : null,
      currentPb: candidate.current_pb === null ? null : Number(candidate.current_pb),
      historicalPbMax: candidate.historical_pb_max === null ? null : Number(candidate.historical_pb_max),
      historicalPbMin: candidate.historical_pb_min === null || candidate.historical_pb_min === undefined
        ? null : Number(candidate.historical_pb_min),
      pbPositiveExtremaRatio: candidate.pb_positive_extrema_ratio === null || candidate.pb_positive_extrema_ratio === undefined
        ? null : Number(candidate.pb_positive_extrema_ratio),
      pbPeProduct: candidate.pb_pe_product === null || candidate.pb_pe_product === undefined
        ? null : Number(candidate.pb_pe_product),
      valuationStatus: candidate.valuation_status || null,
      valuationPassReason: candidate.valuation_pass_reason || null,
      ttmProfitStatus: candidate.ttm_profit_status || null,
      rankReady: candidate.rank_ready === null || candidate.rank_ready === undefined ? null : candidate.rank_ready === true,
      rankBlockReasons: candidate.rank_block_reasons || [],
      pbCoverage: {
        coveredDays: candidate.pb_covered_days === null || candidate.pb_covered_days === undefined ? null : Number(candidate.pb_covered_days),
        expectedDays: candidate.pb_expected_days === null || candidate.pb_expected_days === undefined ? null : Number(candidate.pb_expected_days),
        gapDays: candidate.pb_gap_days === null || candidate.pb_gap_days === undefined ? null : Number(candidate.pb_gap_days),
        historyYears: candidate.pb_history_years === null || candidate.pb_history_years === undefined ? null : Number(candidate.pb_history_years),
      },
      currentPe: candidate.current_pe === null ? null : Number(candidate.current_pe),
      profitStatus: candidate.profit_status,
      dividendYield: candidate.dividend_yield === null ? null : Number(candidate.dividend_yield),
      equityAmount: candidate.equity_amount === null ? null : Number(candidate.equity_amount),
      equityCurrency: candidate.equity_currency,
      equityCny: candidate.equity_cny === null ? null : Number(candidate.equity_cny),
      fxRate: candidate.fx_rate === null ? null : Number(candidate.fx_rate),
      fxDate: candidate.fx_date,
      pbRank: candidate.pb_rank,
      peRank: candidate.pe_rank,
      dividendRank: candidate.dividend_rank,
      totalScore: candidate.total_score,
      selectionOrder: candidate.selection_order,
      filterStatus: candidate.filter_status,
      dataQualityStatus: candidate.data_quality_status,
      exclusionReasons: candidate.exclusion_reasons,
      personalExcluded: candidate.personalExcluded === true,
      personalExclusionReasons: candidate.personalExclusionReasons || [],
      personalSelected: candidate.personalSelected === true,
      personalStatus: candidate.personalStatus || null,
      personalNonSelectionReasons: candidate.personalNonSelectionReasons || [],
      detail: candidate.detail,
      historicalReplay,
    },
  };
}

const SETTINGS_SCHEMA_VERSION = 2;
const SETTINGS_LIMITS = Object.freeze({
  industriesPerMarket: 200,
  excludedInstruments: 500,
  noteLength: 100,
  codeLength: 20,
});

// 行业代码/备注是纯文本：长度受限、不做 HTML 转义后存储（前端渲染时转义），但不允许控制字符。
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function sanitizePlainText(value, maxLength) {
  const text = String(value === undefined || value === null ? '' : value);
  return text.replace(CONTROL_CHARS, '').slice(0, maxLength);
}

/**
 * 设置校验（方案 27.9）：资金字段沿用原合同，新字段以「省略=保留、显式空=清空」处理。
 * 旧客户端只提交资金字段时，服务端不能把已存的行业/证券排除一并清掉。
 */
function validateSettingsPayload(body, existing) {
  const errors = [];
  const pickRatio = (value, field) => {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 1) errors.push(`${field} 必须是 0—1 之间的小数`);
    return Number.isFinite(n) ? n : null;
  };
  const prior = existing || {};
  const has = key => Object.prototype.hasOwnProperty.call(body || {}, key);
  const priorRatio = key => (prior[key] === undefined ? null : prior[key]);
  const settings = {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    // 资金字段：省略=保留，显式 null/空字符串=清空。行内排除入口不得把旧资金配置写成 null。
    budgetRatioA: pickRatio(has('budgetRatioA') ? body.budgetRatioA : priorRatio('budgetRatioA'), 'A股市场资金占比'),
    budgetRatioHk: pickRatio(has('budgetRatioHk') ? body.budgetRatioHk : priorRatio('budgetRatioHk'), '港股市场资金占比'),
    positionRatioA: pickRatio(has('positionRatioA') ? body.positionRatioA : priorRatio('positionRatioA'), 'A股目标股票仓位'),
    positionRatioHk: pickRatio(has('positionRatioHk') ? body.positionRatioHk : priorRatio('positionRatioHk'), '港股目标股票仓位'),
    totalCapital: has('totalCapital')
      ? (body.totalCapital === null || body.totalCapital === '' ? null : Number(body.totalCapital))
      : (prior.totalCapital === undefined ? null : prior.totalCapital),
  };
  if (settings.totalCapital !== null) settings.totalCapital = Number(settings.totalCapital);
  if (settings.totalCapital !== null && (!Number.isFinite(settings.totalCapital) || settings.totalCapital < 0)) {
    errors.push('总资金必须是非负数字');
  }
  const budgetSum = (settings.budgetRatioA || 0) + (settings.budgetRatioHk || 0);
  if (budgetSum > 1 + 1e-9) errors.push('两个市场资金占比之和不能超过 100%');

  // 行业排除：{ CN: [code...], HK: [code...] }，省略整个字段表示保留旧值。
  const rawIndustries = body.industryFilters === undefined ? prior.industryFilters : body.industryFilters;
  const industryFilters = { CN: [], HK: [] };
  if (rawIndustries !== undefined && rawIndustries !== null) {
    if (typeof rawIndustries !== 'object' || Array.isArray(rawIndustries)) {
      errors.push('行业排除格式不合法');
    } else {
      ['CN', 'HK'].forEach(market => {
        const list = rawIndustries[market];
        if (list === undefined) {
          // 只提交一个市场时，另一个市场保留旧值，不把"没提到"当"清空"。
          industryFilters[market] = Array.isArray(prior.industryFilters && prior.industryFilters[market])
            ? prior.industryFilters[market] : [];
          return;
        }
        if (!Array.isArray(list)) {
          errors.push(`${market} 市场行业排除必须是数组`);
          return;
        }
        const seen = new Set();
        list.forEach(item => {
          const code = typeof item === 'object' && item !== null ? item.code : item;
          const text = sanitizePlainText(code, 32).trim();
          if (!text) return;
          const industry = {
            code: text,
            system: typeof item === 'object' && item !== null ? sanitizePlainText(item.system, 32) || null : null,
            version: typeof item === 'object' && item !== null ? sanitizePlainText(item.version, 16) || null : null,
            name: typeof item === 'object' && item !== null ? sanitizePlainText(item.name, 64) || null : null,
          };
          const identity = PORTFOLIO.industryIdentityKey(industry);
          if (seen.has(identity)) return;
          seen.add(identity);
          industryFilters[market].push(industry);
        });
        if (industryFilters[market].length > SETTINGS_LIMITS.industriesPerMarket) {
          errors.push(`${market} 市场行业排除最多 ${SETTINGS_LIMITS.industriesPerMarket} 个`);
        }
      });
    }
  } else {
    industryFilters.CN = Array.isArray(prior.industryFilters && prior.industryFilters.CN) ? prior.industryFilters.CN : [];
    industryFilters.HK = Array.isArray(prior.industryFilters && prior.industryFilters.HK) ? prior.industryFilters.HK : [];
  }
  settings.industryFilters = industryFilters;

  // 证券排除：省略=保留；显式 [] 才是"全部恢复"。
  const rawExcluded = body.excludedInstruments === undefined ? prior.excludedInstruments : body.excludedInstruments;
  const excludedInstruments = [];
  if (rawExcluded !== undefined && rawExcluded !== null) {
    if (!Array.isArray(rawExcluded)) {
      errors.push('股票排除必须是数组');
    } else {
      const seen = new Set();
      rawExcluded.forEach(item => {
        if (typeof item !== 'object' || item === null) { errors.push('股票排除每项必须是对象'); return; }
        const market = String(item.market || '').toUpperCase();
        if (!['CN', 'HK'].includes(market)) { errors.push('股票排除的市场必须是 CN 或 HK'); return; }
        const code = sanitizePlainText(item.code, SETTINGS_LIMITS.codeLength).trim().toUpperCase();
        if (!code) { errors.push('股票排除的代码不能为空'); return; }
        const key = `${market}:${code}`;
        if (seen.has(key)) return;
        seen.add(key);
        excludedInstruments.push({
          market,
          code,
          instrumentId: item.instrumentId === undefined || item.instrumentId === null ? null : Number(item.instrumentId),
          note: sanitizePlainText(item.note, SETTINGS_LIMITS.noteLength) || null,
        });
      });
      if (excludedInstruments.length > SETTINGS_LIMITS.excludedInstruments) {
        errors.push(`股票排除最多 ${SETTINGS_LIMITS.excludedInstruments} 只`);
      }
    }
  } else if (Array.isArray(prior.excludedInstruments)) {
    prior.excludedInstruments.forEach(item => {
      if (!item || !item.market || !item.code) return;
      excludedInstruments.push({
        market: String(item.market).toUpperCase(),
        code: String(item.code).toUpperCase(),
        instrumentId: item.instrumentId === undefined ? null : item.instrumentId,
        note: item.note || null,
      });
    });
  }
  settings.excludedInstruments = excludedInstruments;
  // customFilterVersion 是结构版本，不能替代每次保存递增的 revision。
  settings.customFilterVersion = SETTINGS_SCHEMA_VERSION;

  if (errors.length) {
    const error = new Error(errors.join('；'));
    error.status = 400;
    throw error;
  }
  return settings;
}

async function getSettings(username) {
  const stored = await repo.readUserSettings(username);
  if (!stored) {
    const error = new Error('账号不存在');
    error.status = 404;
    throw error;
  }
  return { settings: stored.settings, revision: stored.revision };
}

/**
 * 保存设置：显式 revision 乐观锁 + 统一身份解析（方案 27.9）。
 * 用户填的代码必须唯一映射到一只证券，否则报错让用户写全代码，不猜、不静默丢弃。
 */
async function saveSettings({ username, body, expectedSubjectId }) {
  const stored = await repo.readUserSettings(username);
  if (!stored) {
    const error = new Error('账号不存在');
    error.status = 404;
    throw error;
  }
  const settings = validateSettingsPayload(body || {}, stored.settings || {});
  const expected = Number((body || {}).revision === undefined ? stored.revision : (body || {}).revision);
  if (!Number.isInteger(expected) || expected !== stored.revision) {
    const error = new Error('设置已被其他窗口修改，请刷新后重试');
    error.status = 409;
    error.code = 'STOCK_SELECTION_SETTINGS_REVISION_CONFLICT';
    throw error;
  }

  // 代码 → 统一身份：按市场分组批量解析，写回规范化代码与 instrument_id。
  const byMarket = { CN: [], HK: [] };
  settings.excludedInstruments.forEach(item => { byMarket[item.market].push(item.code); });
  const resolved = new Map();
  for (const market of ['CN', 'HK']) {
    if (!byMarket[market].length) continue;
    const rows = await repo.resolveInstrumentsByCodes({ market, codes: byMarket[market] });
    const byCode = new Map();
    rows.forEach(row => {
      const bare = String(row.code).split('.')[0].toUpperCase();
      [String(row.code).toUpperCase(), bare].forEach(key => {
        const list = byCode.get(key) || [];
        if (!list.some(item => Number(item.instrument_id) === Number(row.instrument_id))) list.push(row);
        byCode.set(key, list);
      });
    });
    for (const code of byMarket[market]) {
      const bare = code.split('.')[0];
      const candidates = byCode.get(code) || byCode.get(bare) || [];
      const unique = Array.from(new Map(candidates.map(row => [String(row.instrument_id), row])).values());
      if (!unique.length) {
        const error = new Error(`${market === 'CN' ? 'A股' : '港股'}代码 ${code} 未找到对应证券`);
        error.status = 400;
        throw error;
      }
      if (unique.length > 1) {
        const error = new Error(`${market === 'CN' ? 'A股' : '港股'}代码 ${code} 匹配到多只证券，请填写完整代码`);
        error.status = 400;
        throw error;
      }
      resolved.set(`${market}:${code}`, {
        instrumentId: Number(unique[0].instrument_id),
        code: String(unique[0].code),
        name: unique[0].name || null,
      });
    }
  }
  settings.excludedInstruments = settings.excludedInstruments.map(item => {
    const hit = resolved.get(`${item.market}:${item.code}`);
    return hit
      ? Object.assign({}, item, { instrumentId: hit.instrumentId, code: hit.code, name: hit.name })
      : item;
  });

  return repo.saveUserSettings({ username, settings, expectedRevision: expected, expectedSubjectId });
}

/** 个人排除的生效集合：只取本人设置里、当前市场范围内的行业代码与 instrument_id。 */
function exclusionOf(settings, market) {
  const source = settings || {};
  const industryFilters = (source.industryFilters && Array.isArray(source.industryFilters[market])
    ? source.industryFilters[market] : []).map(item => (typeof item === 'string' ? { code: item } : item)).filter(item => item && item.code);
  const industryCodes = industryFilters.map(item => item.code).filter(Boolean);
  const industryKeys = industryFilters.map(item => PORTFOLIO.industryIdentityKey(item)).filter(Boolean);
  const instrumentIds = (Array.isArray(source.excludedInstruments) ? source.excludedInstruments : [])
    .filter(item => item && String(item.market).toUpperCase() === market)
    .map(item => Number(item.instrumentId))
    .filter(id => Number.isFinite(id) && id > 0);
  return { industryFilters, industryCodes, industryKeys, instrumentIds };
}

/**
 * 个人资金测算（方案 27.9）：个人结果是公共策略的覆盖层，不是公共组合本身。
 * - 源批次必须是**完整**质量通过的结果（daily 允许未发布但必须完整，方案 27.6）；
 * - 用完整冻结投影（游标分页，不受 5000 行限制），保留源名次与全部判定，不补 rankReady；
 * - 本人行业/证券排除 → 按原 selection_order 递补 → 席位与行业上限。
 */
async function createSimulation({ username, sourceRunId, positionRatio, budgetRatio, clientRequestId, expectedSettingsRevision, expectedSubjectId }, options = {}) {
  return withTransaction(async tx => {
    const summaryOf = run => {
      const summary = run && run.input_manifest && run.input_manifest.portfolio;
      return summary ? {
        excludedCount: Number(summary.excludedCount || 0),
        weightBasis: summary.weightBasis || null,
      } : null;
    };
    const reusedResult = async (runId, settingsRevision) => {
      const run = await repo.findRun(runId, tx);
      return { runId: Number(runId), reused: true, run, portfolio: summaryOf(run), settingsRevision };
    };
    const requestMarker = value => value === undefined ? '__omitted__' : value === null ? '__null__' : String(value);
    const requestValueMatches = (incoming, stored, effective, omittedValue, nullIsOmitted) => {
      // 响应丢失后的同请求恢复以已落库的有效值为准；省略/空值由服务端按原合同回退，不能把等价数字格式判成异参。
      if (incoming === undefined || incoming === '' || (incoming === null && nullIsOmitted)) {
        if (omittedValue === undefined) return stored === '__omitted__';
        return PORTFOLIO.clampRatio(omittedValue, null) === (effective == null ? null : Number(effective));
      }
      if (incoming === null) return effective === null || effective === undefined;
      const incomingNumber = Number(incoming);
      const effectiveNumber = effective === null || effective === undefined || effective === '' ? NaN : Number(effective);
      if (Number.isFinite(incomingNumber) && Number.isFinite(effectiveNumber)) return PORTFOLIO.clampRatio(incomingNumber, null) === effectiveNumber;
      return requestMarker(incoming) === requestMarker(stored) || requestMarker(incoming) === requestMarker(effective);
    };
    const requestMatchesRun = async run => {
      if (!run || Number(run.supersedes_run_id) !== Number(sourceRunId)) return false;
      const manifest = run.input_manifest || {};
      const requestInputs = manifest.requestInputs || {};
      const snapshot = manifest.settingsSnapshot;
      const savedBudget = snapshot ? (run.market === 'CN' ? snapshot.budgetRatioA : snapshot.budgetRatioHk) : undefined;
      // 旧版没有请求载荷快照：省略仓位固定为 1，省略预算固定为 null。
      const legacyDefaults = !manifest.requestInputs && !snapshot && !Object.prototype.hasOwnProperty.call(manifest, 'defaultPositionRatio');
      let defaultPosition = legacyDefaults ? 1 : Object.prototype.hasOwnProperty.call(manifest, 'defaultPositionRatio') ? manifest.defaultPositionRatio : undefined;
      if (defaultPosition === undefined && (positionRatio === undefined || positionRatio === null || positionRatio === '')) {
        // 旧批次没有冻结默认仓位时，只能从同一修订的公共来源和冻结设置恢复。
        const originalSource = await repo.findRun(sourceRunId, tx);
        if (originalSource && (!manifest.sourceRevision || Number(originalSource.revision || 1) === Number(manifest.sourceRevision))) {
          if (originalSource.position_ratio !== null && originalSource.position_ratio !== undefined) defaultPosition = originalSource.position_ratio;
          else if (snapshot) defaultPosition = (run.market === 'CN' ? snapshot.positionRatioA : snapshot.positionRatioHk) ?? null;
        }
      }
      if (!requestValueMatches(positionRatio, requestInputs.positionRatio, run.position_ratio, defaultPosition, true)
        || !requestValueMatches(budgetRatio, requestInputs.budgetRatio, run.budget_ratio, snapshot ? (savedBudget == null ? null : savedBudget) : legacyDefaults ? null : undefined, false)) return false;
      if (expectedSettingsRevision !== undefined && expectedSettingsRevision !== null
        && Number(expectedSettingsRevision) !== Number(run.settings_revision)) return false;
      return true;
    };
    const requestConflict = () => {
      const error = new Error('同一请求编号提交了不同参数，请刷新后重试');
      error.status = 409;
      error.code = 'STOCK_SELECTION_REQUEST_CONFLICT';
      return error;
    };
    const subjectId = await repo.readUserSubjectId(username, tx);
    if (expectedSubjectId && subjectId !== expectedSubjectId) {
      const error = new Error('登录账号已变化，请重新登录'); error.status = 401; error.code = 'AUTHENTICATION_REQUIRED'; throw error;
    }
    const recoverExistingRequest = async () => {
      if (!clientRequestId) return null;
      const binding = await repo.findStockSelectionRequestBinding({ username, subjectId, requestId: clientRequestId }, tx);
      if (binding) {
        if (!await requestMatchesRun(binding)) throw requestConflict();
        return reusedResult(binding.run_id, binding.settings_revision);
      }
      const legacy = await repo.findPersonalRunByRequestId({ username, subjectId, requestId: clientRequestId }, tx);
      if (!legacy) return null;
      if (!await requestMatchesRun(legacy)) throw requestConflict();
      await repo.bindStockSelectionRequest({ username, subjectId, requestId: clientRequestId, inputHash: legacy.input_hash, runId: legacy.run_id }, tx);
      return reusedResult(legacy.run_id, legacy.settings_revision);
    };
    const earlyResult = await recoverExistingRequest();
    if (earlyResult) return earlyResult;

    // 源批次与用户设置在同一事务内锁定；计算可在锁外优化，但写入前不能再信任旧 revision。
    const source = await repo.findRunForUpdate(sourceRunId, tx);
    if (!source) {
      const error = new Error('源批次不存在');
      error.status = 404;
      throw error;
    }
    const isPersonalSource = source.run_kind === 'personal';
    const sourceReady = source.quality_status === 'passed'
      && !!source.published_at && !source.is_shadow;
    if (!sourceReady || isPersonalSource) {
      const error = new Error('该批次尚未就绪或不可作为测算来源');
      error.status = 409;
      throw error;
    }
    const stored = await repo.readUserSettingsForUpdate(username, tx);
    if (!stored) {
      const error = new Error('账号不存在');
      error.status = 404;
      throw error;
    }
    if (expectedSubjectId && stored.subjectId !== expectedSubjectId) {
      const error = new Error('登录账号已变化，请重新登录'); error.status = 401; error.code = 'AUTHENTICATION_REQUIRED'; throw error;
    }
    // 首次查询后若有同请求正在提交，等待用户行锁后再查一次；恢复原请求优先于当前 revision。
    const lateResult = await recoverExistingRequest();
    if (lateResult) return lateResult;
    if (expectedSettingsRevision !== undefined && expectedSettingsRevision !== null
      && Number(expectedSettingsRevision) !== stored.revision) {
      const error = new Error('设置已被其他窗口修改，请刷新后重试');
      error.status = 409;
      error.code = 'STOCK_SELECTION_SETTINGS_REVISION_CONFLICT';
      throw error;
    }
    const settings = stored.settings || {};
    const exclusion = exclusionOf(settings, source.market);
    const strategyParams = Object.assign({}, RULES.DEFAULT_PARAMS, source.parameters || {});
    const savedPosition = source.market === 'CN' ? settings.positionRatioA : settings.positionRatioHk;
    const defaultPositionRatio = PORTFOLIO.clampRatio(source.position_ratio === null || source.position_ratio === undefined ? savedPosition : source.position_ratio, null);
    const ratioInput = positionRatio === undefined || positionRatio === null || positionRatio === ''
      ? (source.position_ratio === null || source.position_ratio === undefined ? savedPosition : source.position_ratio)
      : positionRatio;
    const ratio = PORTFOLIO.clampRatio(ratioInput, null);
    if (ratio === null) {
      const error = new Error('无法确定该来源批次的实际仓位，请先保存本市场仓位后重试');
      error.status = 409;
      error.code = 'STOCK_SELECTION_POSITION_REQUIRED';
      throw error;
    }
    const savedBudget = source.market === 'CN' ? settings.budgetRatioA : settings.budgetRatioHk;
    const budget = budgetRatio === undefined || budgetRatio === ''
      ? PORTFOLIO.clampRatio(savedBudget, null)
      : PORTFOLIO.clampRatio(budgetRatio, null);
    const settingsHash = hashOf({ settings, revision: stored.revision });
    // clientRequestId 是传输幂等标识，不进入内容哈希；同内容的多个请求仍可分别绑定。
    const payload = {
      source: Number(sourceRunId), sourceRevision: Number(source.revision || 1),
      positionRatio: ratio, budgetRatio: budget, owner: username,
      settingsRevision: stored.revision, settingsHash,
      excludedInstrumentIds: exclusion.instrumentIds.slice().sort((a, b) => a - b),
      excludedIndustryKeys: exclusion.industryKeys.slice().sort(),
      strategyCode: source.strategy_code || RULES.STRATEGY_CODE,
      formulaVersion: source.formula_version || strategyParams.formulaVersion,
    };
    const inputHash = hashOf(payload);
    const existing = await repo.findRunByIdempotencyKey(tx, {
      strategyId: Number(source.strategy_id), market: source.market, asOfDate: source.as_of_date_text,
      runKind: 'personal', inputHash, ownerUsername: username, ownerSubjectId: subjectId,
      periodType: source.period_type || null, isShadow: false,
    });
    if (existing) {
      if (clientRequestId) await repo.bindStockSelectionRequest({ username, subjectId, requestId: clientRequestId, inputHash, runId: existing }, tx);
      return reusedResult(existing, stored.revision);
    }

    const rows = await repo.listCandidatesForProjection({ runId: sourceRunId }, tx);
    const portfolio = personalPortfolioOf(rows, { positionRatio: ratio, params: strategyParams, exclusion });
    const runId = await repo.insertRun(tx, {
      strategyId: Number(source.strategy_id), market: source.market, runKind: 'personal',
      ownerUsername: username, ownerSubjectId: subjectId, quarter: source.quarter,
      asOfDate: source.as_of_date_text, knowledgeCutoff: source.knowledge_cutoff_text,
      executionStatus: 'succeeded', qualityStatus: source.quality_status,
      businessStatus: 'personal_simulation', inputHash,
      inputManifest: Object.assign({}, payload, {
        clientRequestId: clientRequestId || null,
        defaultPositionRatio,
        // B3-1：个人测算不再物理复制全市场候选；候选读取统一解析到 supersedes_run_id 的冻结公共源批次。
        candidatesRefMode: 'source_run',
        requestInputs: { positionRatio: String(ratio), budgetRatio: budget === null ? '__null__' : String(budget) },
        settingsSnapshot: settings,
        portfolio: {
          selectedCount: portfolio.members.length, excludedCount: portfolio.excludedCount,
          weightBasis: portfolio.weightBasis,
          selectionOutcomes: personalSelectionOutcomes(portfolio),
        },
        quality: source.input_manifest ? source.input_manifest.quality : null,
      }),
      universeCount: Number(source.universe_count || 0), pendingCount: Number(source.pending_count || 0),
      selectedCount: portfolio.members.length,
      marketPb: source.market_pb === null ? null : Number(source.market_pb),
      marketPe: source.market_pe === null ? null : Number(source.market_pe),
      benchmarkCode: source.benchmark_code, valuationMethod: source.valuation_method,
      positionRatio: ratio, budgetRatio: budget, revision: 1, publishedAt: null,
      supersedesRunId: Number(sourceRunId), requestId: clientRequestId || null,
      periodType: source.period_type || null, periodKey: source.period_key || null,
      periodStart: source.period_start_text || null, periodEnd: source.period_end_text || null,
      settingsRevision: stored.revision, settingsHash, computedAt: new Date(), isShadow: false,
    });
    // B3-1：不再调用 copyCandidates。个人 run 只写批次与 <=30 行成员，候选由读端解析到源批次。
    await repo.insertMembers(tx, runId, portfolio.members);
    if (clientRequestId) {
      const binding = await repo.bindStockSelectionRequest({ username, subjectId, requestId: clientRequestId, inputHash, runId }, tx);
      if (binding && Number(binding.run_id) !== Number(runId)) {
        return reusedResult(binding.run_id, stored.revision);
      }
    }
    return { runId, reused: false, run: await repo.findRun(runId, tx), portfolio, settingsRevision: stored.revision };
  }, { tx: options.tx });
}

/** 回测入口（实现在 stockSelectionBacktest，这里只做权限与参数校验后的转发）。 */
async function runBacktest(input) {
  const backtest = require('./stockSelectionBacktest');
  return backtest.runBacktest(input);
}

async function listRuns(query) {
  return repo.listRuns(query);
}

async function getBacktest(backtestId) {
  const row = await repo.findBacktest(backtestId);
  if (!row) return null;
  return backtestEnvelope(row);
}

async function getBacktestPeriods(query) {
  return repo.listBacktestPeriods(query);
}

function backtestEnvelope(row) {
  return {
    backtestId: Number(row.backtest_id),
    market: row.market,
    startDate: row.start_date ? String(row.start_date).slice(0, 10) : null,
    endDate: row.end_date ? String(row.end_date).slice(0, 10) : null,
    currency: row.currency,
    status: row.status,
    executionModelVersion: row.execution_model_version,
    costVersion: row.cost_version,
    benchmarkCode: row.benchmark_code,
    benchmarkReturnType: row.benchmark_return_type,
    metrics: row.metrics,
    diagnostics: row.diagnostics,
    createdAt: row.created_at,
  };
}

/** 回测历史列表：只读库，页面用来展示已有回测状态与"不可还原"原因。 */
async function listBacktests({ market, limit, offset }) {
  const result = await repo.listBacktests({ market, limit, offset });
  return { total: result.total, rows: result.rows.map(backtestEnvelope) };
}

/**
 * 已退市证券不再进选股输入缺口队列：旧主档 delist_date 常为空、status 仍写 listed，
 * 但交易所简称会改成「XX退」「退市XX」「摘牌XX」，这是本地可核验的退市事实。
 * 退市后上游不会再给行业/财报/行情，继续排队只会永远补不到、把补数槽锁死。
 * 只认名称里的明确退市标记；正常证券不受影响，港股名称没有这类标记也不受影响。
 */
function isDelistedSecurityName(name) {
  const text = String(name || '').replace(/\s+/g, '');
  return /(退市|摘牌)/.test(text) || /退$/.test(text);
}

/**
 * 缺口的采集计划（INC-0054 第一阶段第 2 条）：把「缺证券」细化到报告期、财报种类和必需字段。
 *
 * 原来队列只知道"这只股票缺财报"，补采一律按 12 年 × 四类全量重拉，真正的缺口
 * （例如只缺某一年资产负债表）被整批历史数据淹没。这里从规则原因和年度异常里
 * 推出本次真正需要的种类与报告期；推不出来时不缩小范围（保持原来的保守行为）。
 */
const REPORT_KIND_BY_REASON = Object.freeze({
  // 净资产类缺口只需要资产负债表（R05）。
  equity_unavailable: ['balance'],
  equity_not_evaluable_no_report: ['balance'],
  equity_currency_unknown: ['balance'],
  source_currency_unverified: ['balance'],
  fx_unavailable_not_evaluable: ['balance'],
  // 利润口径未知要补利润表与指标表。
  profit_status_unknown: ['income', 'indicator'],
});

// 财报域的原因前缀：R05（净资产）、RANK:profit_status_unknown（利润口径）、年度异常。
// 其余原因属于行业/估值/未分类，不参与「补哪几张表」的判断。
const FINANCIAL_REASON_PATTERN = /^(R05:|RANK:profit_status_unknown$|annual_anomaly:)/;

function collectionPlanOf({ domains = [], reasons = [], rules = null, anomaly = null } = {}) {
  const plan = {};
  if (!domains.includes('financial_reports')) return plan;
  const kinds = new Set();
  const periods = new Set();
  // 混合原因（例如同时有 R05 净资产缺口和未映射的年度异常）不能只按能识别的那一条收窄：
  // 把 report_kinds 误收成 ['balance'] 会让其余三表永远补不到。只要存在一个无法映射到具体
  // 报表的财报原因，就返回空数组，交给补采端保守回退四类全量。
  let unmapped = false;
  reasons.forEach(reason => {
    // reasons 是跨 domain 的扁平清单（还可能含行业/估值原因），只有财报域的原因参与收窄。
    if (!FINANCIAL_REASON_PATTERN.test(String(reason))) return;
    const plain = String(reason).replace(/^R\d+:/, '').replace(/^RANK:/, '').replace(/^annual_anomaly:/, '');
    const mapped = REPORT_KIND_BY_REASON[plain];
    if (mapped) mapped.forEach(kind => kinds.add(kind));
    else unmapped = true;
  });
  (anomaly && Array.isArray(anomaly.missingYears) ? anomaly.missingYears : [])
    .forEach(year => { if (/^\d{4}$/.test(String(year))) periods.add(String(year)); });
  const r05 = rules && rules.R05;
  const requiredFields = [];
  if (r05 && /^equity_|^source_currency|^fx_unavailable/.test(String(r05.reason || ''))) {
    requiredFields.push('total_hldr_eqy_exc_min_int');
  }
  plan.report_kinds = unmapped ? [] : Array.from(kinds);
  plan.report_periods = Array.from(periods).sort();
  plan.required_fields = requiredFields;
  return plan;
}

/**
 * B2-1：该标的是否已被 A 类确定性证据淘汰（任何可靠 FAIL 或白名单内客观不适用）。
 * V1/V2 由领域层给出 deterministicElimination；格雷厄姆单规则路径没有该字段，
 * 按其自身 G01 合同独立判断（FAIL / NOT_APPLICABLE 均属确定性不入选），不套用四项规则白名单。
 */
function isDeterministicallyEliminated(item) {
  const evidence = item && item.deterministicElimination;
  if (evidence && evidence.eliminated === true) return true;
  if (evidence && evidence.eliminated === false) return false;
  const rules = (item && item.rules) || {};
  return Object.values(rules).some(rule => rule
    && (rule.status === RULES.STATUS.FAIL || rule.status === RULES.STATUS.NOT_APPLICABLE));
}

/**
 * B2-1 行业补采收窄：只有未淘汰且可能进入排名池的标的才需要行业外采。
 * PASS 与未淘汰的 PENDING 可能转成可发布候选；A 类淘汰与 RISK 永远不会进池。
 */
function industryRequiredOf(item) {
  if (!item || isDeterministicallyEliminated(item)) return false;
  if (item.filterStatus === RULES.STATUS.RISK) return false;
  return item.filterStatus === RULES.STATUS.PASS || item.filterStatus === RULES.STATUS.PENDING;
}

/**
 * 缺口的数据集归属（R2-04）：每个原因必须能落到"补什么"，
 * 补不了的（估值由共享行情任务负责）也要显式分类，不能变成"没有原因"。
 */
function gapDomainsOf(item, anomaly, options = {}) {
  const domains = new Set();
  const reasons = [];
  const add = (domain, reason) => { domains.add(domain); reasons.push(reason); };
  const includeIndustry = options.includeIndustry !== false;

  if (item.filterStatus === RULES.STATUS.PENDING) {
    RULES.RULE_CODES.forEach(code => {
      const rule = (item.rules || {})[code];
      if (!rule || rule.status !== RULES.STATUS.PENDING) return;
      const reason = `${code}:${rule.reason || rule.status}`;
      // R04 走分红事实、R05 走财报、R01/R02 走行情估值。
      if (code === 'R04') add('dividends', reason);
      else if (code === 'R05') add('financial_reports', reason);
      else add('valuation', reason);
    });
  }
  // 排名受阻：利润口径未知要补财报，静态 PE 缺失要补估值。
  (item.rankBlockReasons || []).forEach(reason => {
    if (reason === 'profit_status_unknown') add('financial_reports', `RANK:${reason}`);
    else add('valuation', `RANK:${reason}`);
  });
  if (anomaly && anomaly.status === RULES.STATUS.PENDING) {
    const code = `annual_anomaly:${anomaly.reason || 'pending'}`;
    const unknownYears = anomaly.dividendUnknownYears || [];
    // 分红未知 → 补分红；利润历史不全 → 补财报；两者都可能时都入队。
    if (unknownYears.length) add('dividends', code);
    if (!unknownYears.length || (anomaly.missingYears || []).length) add('financial_reports', code);
  }
  if (includeIndustry && !item.industry) add('industry', 'industry_unverified');
  // 未识别原因也保留：不允许"有缺口但 reasons 为空"。
  if (!reasons.length) {
    const fallback = Array.from(new Set((item.exclusionReasons || []).map(row => row.code))).filter(Boolean);
    if (fallback.length) fallback.forEach(code => add('unclassified', code));
    else add('unclassified', 'gap_reason_unresolved');
  }
  return { domains: Array.from(domains), reasons: Array.from(new Set(reasons)) };
}

/**
 * 选股输入缺口审计（对应选股任务 selection_inputs 模式）：
 * 只读库内标准事实，冻结"应补未补"的对象清单并持久化可续跑队列；
 * 不在这里新增第二条外部采集链路（方案 7.1 要求复用原采集入口）。
 *
 * R2-04：缺口必须带明确的字段/数据集分类（domains），并且：
 * - 只有"待补/排名输入未知/年度异常待补/行业未核验"才进队列，明确不符合(FAIL)与风险暂缓(RISK)不是缺口；
 * - 因此不会出现"gapCount=1 但 reasons=[]"导致补齐任务处理 0 个还报成功；
 * - 明细全量持久化（不再按 5000 条截断），续跑队列因此完整。
 */
/**
 * 从一次计算的结果提取"应补未补"清单（B1-1 定点复核复用同一套规则）：
 * 全市场 auditInputs 与本批 auditInputsForCodes 必须用同一份缺口判定，
 * 否则续批"同一只股票"在两次审计里会得到不同结论。
 */
function gapsFromComputed(computed) {
  const gaps = [];
  const excludedDelisted = [];
  (computed.evaluated || []).forEach(item => {
    if (isDelistedSecurityName(item.name)) {
      excludedDelisted.push({ code: item.code, name: item.name });
      return;
    }
    const anomaly = computed.anomalyById ? computed.anomalyById[item.instrumentId] : null;
    // B2-1：A 类确定性淘汰与 RISK 是结论，不是缺口；也不再为它们入队补行业。
    // 单规则诊断仍留在 item.rules 里，页面/历史证据能看到每条规则自己的状态与原因码。
    if (isDeterministicallyEliminated(item) || item.filterStatus === RULES.STATUS.RISK) return;
    const pending = item.filterStatus === RULES.STATUS.PENDING;
    const rankBlocked = item.filterStatus === RULES.STATUS.PASS && item.rankReady === false;
    const anomalyPending = item.filterStatus === RULES.STATUS.PASS && anomaly && anomaly.status === RULES.STATUS.PENDING;
    // 明确不符合(FAIL)与当期风险(RISK)是结论，不是缺口；它们不该被反复"补齐"。
    // 行业补采同样收窄：只有可能进入排名池（PASS / 未淘汰 PENDING）才需要行业。
    const needsIndustry = industryRequiredOf(item) && !item.industry;
    if (!pending && !rankBlocked && !anomalyPending && !needsIndustry) return;
    const classified = gapDomainsOf(item, anomaly, {
      includeIndustry: industryRequiredOf(item),
    });
    const plan = collectionPlanOf({
      domains: classified.domains, reasons: classified.reasons, rules: item.rules, anomaly,
    });
    gaps.push({
      code: item.code,
      name: item.name,
      companyId: item.companyId,
      filterStatus: item.filterStatus,
      domains: classified.domains,
      reasons: classified.reasons,
      // 采集计划随队列冻结：补采只按真正缺的种类/报告期取数，不再一律 12 年 × 四类全量。
      ...(Object.keys(plan).length ? { collection_plan: plan } : {}),
    });
  });
  return { gaps, excludedDelisted };
}

function domainCountsOf(gaps) {
  return (gaps || []).reduce((acc, gap) => {
    (gap.domains || []).forEach(domain => { acc[domain] = (acc[domain] || 0) + 1; });
    return acc;
  }, {});
}

async function auditInputs({ market, asOfDate, strategyCode }) {
  const computed = await computeSelection({ market, asOfDate, positionRatio: 1, strategyCode });
  const { gaps, excludedDelisted } = gapsFromComputed(computed);
  const domainCounts = domainCountsOf(gaps);
  const payload = {
    market: computed.market,
    asOfDate: computed.asOfDate,
    generatedAt: new Date().toISOString(),
    universeCount: computed.coverage.universeCount,
    gapCount: gaps.length,
    domainCounts,
    excludedDelisted,
    coverage: computed.coverage,
    quality: computed.quality,
    // 全量保存：补齐任务与续跑判定都依赖完整队列，截断会让"剩余数量"失真。
    gaps,
    truncated: false,
  };
  const queueId = await repo.saveInputGapQueue({ market: computed.market, payload });
  return { queueId, gapCount: gaps.length, domainCounts, excludedDelisted, coverage: computed.coverage, quality: computed.quality, gaps };
}

/**
 * 续批定点复核（B1-1）：只对本批处理过的代码重读事实并重算规则。
 * - 不跑全市场审计、不写 artifact、不写缺口队列（队列由调用方原地合并）；
 * - 返回 universeCodes 供调用方区分"已核实解除"与"不在可评估池、无法确认"：
 *   后者必须保留原缺口项（例如港股尚未补到行情的标的），不能被当成已补齐。
 */
async function auditInputsForCodes({ market, asOfDate, strategyCode, codes = [] }) {
  const normalized = normalizeMarket(market);
  const list = Array.from(new Set((codes || []).map(code => String(code || '').trim().toUpperCase()).filter(Boolean)));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(asOfDate || '')) || !list.length) {
    return { market: normalized, asOfDate: asOfDate || null, gaps: [], evaluatedCodes: [], universeCount: 0 };
  }
  const computed = await computeSelection({
    market: normalized, asOfDate, positionRatio: 1, strategyCode,
    restrictCodes: list,
    // 子集计算不得固化/覆盖当日全市场 artifact，也不按名单漂移阻断（本路径只取缺口结论）。
    writeUniverseArtifact: false,
    allowUniverseDrift: true,
  });
  const { gaps } = gapsFromComputed(computed);
  return {
    market: normalized,
    asOfDate,
    codes: list,
    gaps,
    evaluatedCodes: (computed.evaluated || []).map(item => String(item.code || '').toUpperCase()),
    universeCount: computed.coverage ? Number(computed.coverage.universeCount || 0) : 0,
  };
}

/** 行业下拉：只读库内合法一级分类，不现场调用行业源（方案 27.10）。 */
async function listIndustries({ market }) {
  const normalized = normalizeMarket(market);
  const rows = await repo.listIndustryOptions({ market: normalized });
  return {
    market: normalized,
    // 分类体系代码由库内 taxonomy 给出，不伪造 HSICS 版本（方案 27.9）。
    industries: rows.map(row => ({
      code: row.code,
      name: row.name,
      system: row.system,
      version: row.version || null,
      level: row.level === null || row.level === undefined ? null : Number(row.level),
    })),
  };
}

module.exports = {
  // 内部工具（导出供回归断言「两处年度事实必须同源」，不是对外契约）。
  annualFactsOf,
  historicalAnnualReplayOf,
  STRATEGY_VERSION,
  DEFAULT_STRATEGY_CODE,
  STRATEGY_CODES,
  SETTINGS_SCHEMA_VERSION,
  PERIOD_TYPE_OF_KIND,
  MARKET_LABEL,
  RULES,
  RULES_V2,
  PORTFOLIO,
  PERIODS,
  quarterOf,
  quarterEndDate,
  previousQuarterOf,
  resolveQuarterTarget,
  resolvePeriodTarget,
  periodStatus,
  knowledgeCutoffFor,
  computeSelection,
  shouldBlockUniverseDrift,
  collectionPlanOf,
  buildAnnualYears,
  computeTtmFromReports,
  computeAndPersist,
  runQuarterly,
  runPeriodic,
  auditInputsForCodes,
  gapsFromComputed,
  gapDomainsOf,
  isDeterministicallyEliminated,
  industryRequiredOf,
  assessPeriodReadiness: readinessService.assessPeriodReadiness,
  nextDailyRecheckAt: readinessService.nextDailyRecheckAt,
  duePeriodicTargets,
  hasPeriodRun,
  pendingQuarter,
  hasCompletedQuarter,
  getMarkets,
  listRuns,
  getRun,
  getCandidates,
  getPortfolio,
  getStockDetail,
  getBacktest,
  getBacktestPeriods,
  listBacktests,
  backtestEnvelope,
  auditInputs,
  isDelistedSecurityName,
  getSettings,
  saveSettings,
  createSimulation,
  validateSettingsPayload,
  exclusionOf,
  listIndustries,
  normalizeStrategyCode,
  runBacktest,
};

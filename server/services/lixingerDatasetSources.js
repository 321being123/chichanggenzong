// 理杏仁官方来源 → 现有业务数据集的字段映射（数据适配层）。
//
// 只做三件事：调用统一官方入口、按官方文档字典取值、把结果转成现有链路的字段口径。
// 不判断业务是否需要、不写数据库、不改标准口径。
//
// 指标口径全部来自官方 API 文档字典（api-docs 的 metricsList.layers），
// 并在 2026-10-30 用 600519 与 Tushare 逐字段对过真值：
//   q.ps.toi.t = 营业总收入（2026H1 92,278,072,083 = Tushare total_revenue）
//   q.bs.ta.t  = 资产总计（309,050,784,569 = Tushare total_assets）
//   q.cfs.ncffoa.t = 经营活动现金流量净额（70,690,750,119 = Tushare n_cashflow_act）
//   q.ps.npadnrpatoshaopc.t = 扣非归母净利润（44,464,207,646 = Tushare profit_dedt）
// 后缀 `.t` 是"报告期累计"，与 Tushare 累计口径一致；`.c` 是单季，本项目不用。
const { callEndpoint } = require('./lixingerOfficial');
const { resolveProviderIdentifier } = require('./securityIdentity');

const SOURCE = 'lixinger_official';
const VALUATION_CHUNK = 100; // 官方限制：stockCodes 一次最多 100 个
const VALUATION_METRICS = ['pe_ttm', 'pb', 'dyr', 'mc', 'cmc'];

// 官方估值指标 → 现有链路字段。单位只在这里换一次：
//   mc/cmc 官方是元，现有链路吃 Tushare 的万元 → /10000
//   dyr 官方是小数，现有链路吃 Tushare 的百分数点 → *100
// 官方没有静态市盈率指标（pe/pe_static 均被判为非法指标），pe 保持 null。
const VALUATION_FIELDS = {
  pe_ttm: 'pe_ttm', pb: 'pb', dyr: 'dv_ttm', mc: 'total_mv', cmc: 'circ_mv',
};

const REPORT_METRICS = {
  income: {
    total_revenue: 'ps.toi',
    revenue: 'ps.oi',
    operate_profit: 'ps.op',
    total_profit: 'ps.tp',
    ebit: 'ps.ebit',
    fin_exp_int_exp: 'ps.ieife',
    n_income_attr_p: 'ps.npatshaoehopc',
  },
  balance: {
    total_assets: 'bs.ta',
    total_liab: 'bs.tl',
    total_hldr_eqy_exc_min_int: 'bs.tetoshopc',
    goodwill: 'bs.gw',
    money_cap: 'bs.cabb',
    trad_asset: 'bs.tfa',
  },
  cashflow: {
    n_cashflow_act: 'cfs.ncffoa',
    c_pay_acq_const_fiolta: 'cfs.cpfpfiaolta',
  },
  // 指标表：官方比率是小数（m.roe 0.1784 = 17.84%），落库口径是百分数点 → ×100。
  // 利息保障倍数官方没有对应指标，留空（不使用推导值冒充供应商口径）。
  indicator: {
    profit_dedt: 'ps.npadnrpatoshaopc',
    roe: 'm.roe',
    roa: 'm.roa',
    interestdebt: 'bs.lwi',
  },
};

// 需要小数 → 百分数点换算的指标字段。
const PERCENT_FIELDS = new Set(['roe', 'roa']);

// 官方分红状态 → 现有 div_proc 口径。
const DIVIDEND_STATUS = {
  board_director_plan: '预案', shareholders_meeting_plan: '股东大会通过',
  implemented: '实施', canceled: '取消',
};

function isoDate(value) {
  if (!value) return null;
  const text = String(value);
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[1]}${match[2]}${match[3]}`;
  return /^\d{8}$/.test(text) ? text : null;
}

function dashDate(value) {
  const ts = isoDate(value);
  return ts ? `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}` : null;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// 官方财报把指标嵌在 q.<表>.<字段>.<后缀> 里，这里统一拍平成 'ps.toi.t' → 值。
function flattenMetrics(node, prefix = '', out = {}) {
  if (!node || typeof node !== 'object') return out;
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) flattenMetrics(value, path, out);
    else out[path] = value;
  }
  return out;
}

function stockCodeOf(tsCode) {
  const text = String(tsCode || '').trim();
  if (/^\d{6}$/.test(text)) return text;
  const match = text.match(/^(\d{5,6})\.(SH|SZ|BJ|CSI)$/i);
  return match ? match[1] : null;
}

/**
 * 估值快照：官方 cn/company/fundamental/non_financial 优先。
 * @returns {Promise<object[]|null>} 返回 Tushare 形状的行（万元/百分数点），失败返回 null 由调用方回退。
 */
async function resolveValuationRows({ codes = [], tradeDate, options = {} } = {}) {
  const list = (codes || []).map(code => ({ tsCode: String(code), code: stockCodeOf(code) })).filter(item => item.code);
  if (!list.length || !tradeDate) return null;
  const date = dashDate(tradeDate);
  if (!date) return null;
  const rows = [];
  let failed = 0;
  for (const batch of chunk(list, VALUATION_CHUNK)) {
    try {
      const result = await callEndpoint('cn/company/fundamental/non_financial', {
        stockCodes: batch.map(item => item.code), date, metricsList: VALUATION_METRICS,
      }, { dataset: 'stock_valuation', targetDate: date, ...options });
      const byCode = new Map(batch.map(item => [item.code, item.tsCode]));
      for (const row of result.rows) {
        const tsCode = byCode.get(String(row.stockCode));
        if (!tsCode) continue;
        const peTtm = numberOrNull(row.pe_ttm);
        const pb = numberOrNull(row.pb);
        const dyr = numberOrNull(row.dyr);
        const mc = numberOrNull(row.mc);
        const cmc = numberOrNull(row.cmc);
        if ([peTtm, pb, dyr, mc, cmc].every(value => value === null)) continue;
        rows.push({
          ts_code: tsCode,
          trade_date: isoDate(row.date) || isoDate(tradeDate),
          pe: null,
          pe_ttm: peTtm,
          pb,
          dv_ttm: dyr === null ? null : dyr * 100,
          total_mv: mc === null ? null : mc / 10000,
          circ_mv: cmc === null ? null : cmc / 10000,
          source_code: SOURCE,
        });
      }
    } catch (error) {
      failed += 1;
      if (failed >= 3) throw error;
    }
  }
  return rows;
}

// 财务三表：官方 cn/company/fs/non_financial。指标表（ROE/ROA 等）口径与 Tushare 不同，不在此映射。
async function resolveFinancialReports({ tsCode, startDate, endDate, kinds = ['income', 'balance', 'cashflow', 'indicator'], options = {} } = {}) {
  const code = stockCodeOf(tsCode);
  const start = dashDate(startDate), end = dashDate(endDate);
  if (!code || !start || !end) return null;
  const metrics = [];
  for (const kind of kinds) {
    for (const base of Object.values(REPORT_METRICS[kind] || {})) metrics.push(`q.${base}.t`);
  }
  if (!metrics.length) return null;
  const result = await callEndpoint('cn/company/fs/non_financial', {
    stockCodes: [code], startDate: start, endDate: end, metricsList: metrics,
  }, { dataset: 'stock_financial_reports', targetDate: end, ...options });
  const out = { income: [], balance: [], cashflow: [], indicator: [] };
  for (const item of result.rows) {
    const flat = flattenMetrics(item.q || {});
    const periodEnd = isoDate(item.standardDate) || isoDate(item.date);
    if (!periodEnd) continue;
    const base = {
      ts_code: tsCode,
      end_date: periodEnd,
      ann_date: isoDate(item.reportDate) || isoDate(item.date),
      f_ann_date: isoDate(item.reportDate) || isoDate(item.date),
      report_type: '1',
      comp_type: '1',
      currency: item.currency || 'CNY',
      update_flag: '0',
      source_code: SOURCE,
    };
    for (const kind of kinds) {
      const row = { ...base };
      let filled = 0;
      for (const [field, official] of Object.entries(REPORT_METRICS[kind] || {})) {
        const raw = numberOrNull(flat[`${official}.t`]);
        const value = raw !== null && PERCENT_FIELDS.has(field) ? raw * 100 : raw;
        row[field] = value;
        if (value !== null) filled += 1;
      }
      if (filled) out[kind].push(row);
    }
  }
  return out;
}

// 分红：官方 cn/company/dividend → 现有 stock_dividends 形状（cash_div_tax 为每股税前，已对过真值 28.02423）。
async function resolveDividendRows({ tsCode, startDate, endDate, options = {} } = {}) {
  const code = stockCodeOf(tsCode);
  const start = dashDate(startDate), end = dashDate(endDate);
  if (!code || !start || !end) return null;
  const result = await callEndpoint('cn/company/dividend', { stockCode: code, startDate: start, endDate: end },
    { dataset: 'stock_cash_dividend_facts', targetDate: end, ...options });
  return result.rows.map(row => {
    const cash = numberOrNull(row.dividend);
    const amount = numberOrNull(row.dividendAmount);
    // 现有落库口径是 cash_div_tax(每股) × base_share(万股) × 10000 = 总现金，这里反推 base_share。
    const baseShare = cash && amount ? Number((amount / (cash * 10000)).toFixed(4)) : null;
    return {
      ts_code: tsCode,
      end_date: isoDate(row.fsEndDate),
      ann_date: isoDate(row.date),
      imp_ann_date: isoDate(row.date),
      div_proc: DIVIDEND_STATUS[String(row.status || '')] || String(row.status || ''),
      cash_div_tax: cash,
      cash_div: null,
      stk_bo_rate: numberOrNull(row.bonusSharesFromProfit),
      stk_co_rate: numberOrNull(row.bonusSharesFromCapitalReserve),
      record_date: isoDate(row.registerDate),
      ex_date: isoDate(row.exDate),
      pay_date: isoDate(row.paymentDate),
      base_share: baseShare,
      source_code: SOURCE,
    };
  }).filter(row => row.end_date);
}

// 指数日线：官方 cn/index/candlestick。现有 index_history 只存日期与收盘价。
async function resolveIndexDaily({ tsCode, startDate, endDate, type = 'normal' } = {}) {
  const code = stockCodeOf(tsCode);
  const start = dashDate(startDate), end = dashDate(endDate);
  if (!code || !start || !end) return null;
  const result = await callEndpoint('cn/index/candlestick', { stockCode: code, type, startDate: start, endDate: end },
    { dataset: 'index_daily', targetDate: end });
  return result.rows
    .map(row => ({ date: dashDate(row.date), close: numberOrNull(row.close) }))
    .filter(point => point.date && point.close !== null && point.close > 0)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}


// 宏观：M2 货币供应。官方 `macro/money-supply` 的 `m.m2.t`（月·累积）单位是元，
// 站内 `market.money_supply_monthly.m2_100m_yuan` 是亿元 → /1e8。
// 2026-09 官方 359,628,970,000,000 元 = 3,596,289.7 亿元，与央行口径一致。
async function resolveMoneySupply({ startDate, endDate, areaCode = 'cn' } = {}) {
  const start = dashDate(startDate), end = dashDate(endDate);
  if (!start || !end) return null;
  const result = await callEndpoint('macro/money-supply', { areaCode, startDate: start, endDate: end, metricsList: ['m.m2.t'] },
    { dataset: 'market_money_supply', targetDate: end });
  return result.rows.map(row => {
    const value = numberOrNull(row.m && row.m.m2 && row.m.m2.t);
    const date = dashDate(row.date);
    return value === null || !date ? null : { month: date.slice(0, 7), m2: value / 1e8 };
  }).filter(Boolean);
}

// 宏观：中国 10 年期国债收益率。官方 `macro/national-debt` 的 `tcm_y10` 是小数（0.0165 = 1.65%），
// 站内 `market.sovereign_yield_daily.yield_pct` 是百分数点 → ×100。
async function resolveSovereignYield10y({ startDate, endDate, areaCode = 'cn' } = {}) {
  const start = dashDate(startDate), end = dashDate(endDate);
  if (!start || !end) return null;
  const result = await callEndpoint('macro/national-debt', { areaCode, startDate: start, endDate: end, metricsList: ['tcm_y10'] },
    { dataset: 'market_sovereign_yield', targetDate: end });
  return result.rows.map(row => {
    const value = numberOrNull(row.tcm_y10);
    const date = dashDate(row.date);
    return value === null || !date ? null : { workTime: date, tenYear: value * 100 };
  }).filter(Boolean);
}

// 官方证券代码走统一身份映射，业务不得自己拼后缀。
async function officialStockCode(canonicalCode) {
  return resolveProviderIdentifier({ canonicalCode, sourceCode: SOURCE, identifierType: 'stock_code' });
}

module.exports = {
  SOURCE,
  REPORT_METRICS,
  VALUATION_METRICS,
  officialStockCode,
  resolveDividendRows,
  resolveFinancialReports,
  resolveIndexDaily,
  resolveMoneySupply,
  resolveSovereignYield10y,
  resolveValuationRows,
};

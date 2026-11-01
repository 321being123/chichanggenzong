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
const { callEndpoint } = require('../../services/lixingerOfficial');
const { resolveProviderIdentifier } = require('../../services/securityIdentity');

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
  // 港股标准代码是 5 位（如 00700.HK），官方 hk 接口同样收 5 位，不足补零。
  const hk = text.match(/^(\d{1,5})\.HK$/i);
  if (hk) return hk[1].padStart(5, '0');
  const match = text.match(/^(\d{5,6})\.(SH|SZ|BJ|CSI)$/i);
  return match ? match[1] : null;
}

// 官方估值行 → 现有链路字段（Tushare 口径：市值万元、股息率为百分数点）。
// 官方没有静态市盈率指标（实测 metricsList 报 "(pe,pe_static) are invalid price metrics"），
// pe 这里恒为 null，需要静态市盈率时由 fillStaticPe 用官方市值与官方年报归母净利派生。
function valuationRow(rawRow, tsCode, fallbackDate) {
  const peTtm = numberOrNull(rawRow.pe_ttm);
  const pb = numberOrNull(rawRow.pb);
  const dyr = numberOrNull(rawRow.dyr);
  const mc = numberOrNull(rawRow.mc);
  const cmc = numberOrNull(rawRow.cmc);
  if ([peTtm, pb, dyr, mc, cmc].every(value => value === null)) return null;
  return {
    ts_code: tsCode,
    trade_date: isoDate(rawRow.date) || isoDate(fallbackDate),
    pe: null,
    pe_ttm: peTtm,
    pb,
    dv_ttm: dyr === null ? null : dyr * 100,
    total_mv: mc === null ? null : mc / 10000,
    circ_mv: cmc === null ? null : cmc / 10000,
    source_code: SOURCE,
  };
}

/**
 * 估值快照：官方 cn/company/fundamental/non_financial 优先。
 * @returns {Promise<object[]|null>} 返回 Tushare 形状的行（万元/百分数点），失败返回 null 由调用方回退。
 */
async function resolveValuationRows({ codes = [], tradeDate, options = {} } = {}) {
  const detail = await resolveValuationRowsDetailed({ codes, tradeDate, options });
  if (!detail) return null;
  if (!detail.complete) {
    // 有批次失败时不再静默返回部分数组（R2-001）：上层要么按详细结果补备源，要么整段回退。
    throw partialResultError('估值快照', detail);
  }
  return detail.rows;
}

// ---------- 估值批次完整性（R2-001）----------
// 计划在请求前冻结：快照按「代码批」，历史按「单证券 × 日期段」。
// 返回 rows 与 planned/succeeded/failed/notAttempted、逐批诊断；
// complete 只证明"计划内的请求全部成功"，不证明业务覆盖（某个证券/交易日有没有值要上层裁决）。
// 控制类与权限/凭据错误立即上抛，不再被"累计三次失败"的门槛吞掉。
const CONTROL_ERROR_CODES = new Set([
  'POLICY_NOT_CONFIGURED', 'JOB_BUDGET_EXCEEDED', 'DATASET_LOCKED',
  'CANCELLED', 'INVALID_CREDENTIAL', 'PERMISSION_DENIED', 'ENDPOINT_DISABLED', 'NOT_CONFIGURED', 'DEADLINE_EXCEEDED',
]);

function isControlError(error) {
  return Boolean(error && CONTROL_ERROR_CODES.has(error.code));
}

function batchDiagnostic(error, extra) {
  return {
    ...extra,
    code: (error && error.code) || 'ERROR',
    retryable: Boolean(error && error.retryable),
    message: String((error && error.message) || '').slice(0, 160),
  };
}

function summarizeBatches({ rows, planned, attempted, failures, emptyBatches, scope }) {
  return {
    rows,
    planned,
    attempted,
    succeeded: attempted - failures.length,
    failed: failures.length,
    notAttempted: planned - attempted,
    emptyBatches,
    // complete = 计划内没有被跳过的段、也没有失败段；不等于业务覆盖完整。
    complete: failures.length === 0 && planned === attempted,
    failures,
    scope,
  };
}

function partialResultError(label, detail) {
  const error = new Error(`理杏仁${label}未取全：计划 ${detail.planned} 段，成功 ${detail.succeeded} 段，失败 ${detail.failed} 段，未执行 ${detail.notAttempted} 段`);
  error.code = 'PARTIAL_RESULT';
  error.retryable = false;
  // 已取到的行随错误带回，调用方可据此保留成功部分，不把失败当成"没有数据"。
  error.partialRows = detail.rows;
  error.failures = detail.failures;
  return error;
}

async function resolveValuationRowsDetailed({ codes = [], tradeDate, options = {} } = {}) {
  const list = (codes || []).map(code => ({ tsCode: String(code), code: stockCodeOf(code) })).filter(item => item.code);
  if (!list.length || !tradeDate) return null;
  const date = dashDate(tradeDate);
  if (!date) return null;
  const batches = chunk(list, VALUATION_CHUNK);
  const rows = [];
  const failures = [];
  let attempted = 0;
  let emptyBatches = 0;
  for (const batch of batches) {
    attempted += 1;
    try {
      const result = await callEndpoint('cn/company/fundamental/non_financial', {
        stockCodes: batch.map(item => item.code), date, metricsList: VALUATION_METRICS,
      }, { dataset: 'stock_valuation', targetDate: date, ...options });
      if (!result.rows.length) emptyBatches += 1;
      const byCode = new Map(batch.map(item => [item.code, item.tsCode]));
      for (const row of result.rows) {
        const tsCode = byCode.get(String(row.stockCode));
        if (!tsCode) continue;
        const mapped = valuationRow(row, tsCode, tradeDate);
        if (mapped) rows.push(mapped);
      }
    } catch (error) {
      if (isControlError(error)) throw error;
      failures.push(batchDiagnostic(error, { stockCodes: batch.map(item => item.code), tradeDate: date }));
    }
  }
  return summarizeBatches({ rows, planned: batches.length, attempted, failures, emptyBatches,
    scope: { kind: 'snapshot', tradeDate: date, codes: list.length } });
}

/**
 * 官方区间接口有硬限制：起止**年份差不能超过 10 年**。
 * 实测 `cn/company/fs/non_financial`：2001-01-01~2011-12-31 通过，2001-01-01~2012-01-01 返回
 * ForbiddenError「时间跨度不能超过10年。」。业务侧常要「上市以来」二十多年
 * （财报、分红、估值序列、宏观、指数估值、个股日线都是区间接口），所以在这里统一分段取数、
 * 合并结果，调用方不必自己关心这个限制——否则请求会整体失败并静默回退备源，等于没切源。
 */
const MAX_RANGE_YEARS = 10;

function rangeChunks(startDate, endDate, years = MAX_RANGE_YEARS) {
  const from = dashDate(startDate), to = dashDate(endDate);
  if (!from || !to || from > to) return [];
  const chunks = [];
  const endYear = Number(to.slice(0, 4));
  let year = Number(from.slice(0, 4));
  let cursor = from;
  while (year <= endYear) {
    const lastYear = Math.min(endYear, year + years);
    chunks.push([cursor, lastYear === endYear ? to : `${lastYear}-12-31`]);
    year = lastYear + 1;
    cursor = `${year}-01-01`;
  }
  return chunks;
}

// 区间取数：按 ≤10 年分段请求并拼接原始行（分段首尾不重叠，不需要去重）。
async function callEndpointRange(endpoint, params, startDate, endDate, options = {}) {
  const rows = [];
  for (const [from, to] of rangeChunks(startDate, endDate)) {
    const result = await callEndpoint(endpoint, { ...params, startDate: from, endDate: to }, options);
    rows.push(...(result.rows || []));
  }
  return { rows };
}

/**
 * 估值序列：同接口的区间用法（startDate/endDate），单只证券的每日估值。
 * 官方按区间返回，不再出现「只取结束日、其余日期沿用备源数值」的情况。
 * @returns {Promise<object[]|null>} Tushare 形状的行（pe 待 fillStaticPe 派生）
 */
async function resolveValuationSeries({ codes = [], startDate, endDate, options = {} } = {}) {
  const detail = await resolveValuationSeriesDetailed({ codes, startDate, endDate, options });
  if (!detail) return null;
  // R2-001：任一证券的任一日期段失败，都不能把剩下的部分当成完整序列返回。
  if (!detail.complete) throw partialResultError('估值历史', detail);
  return detail.rows;
}

/**
 * 估值序列的详细结果（R2-001）。
 * 计划按「单证券 × 日期段」冻结；某段失败只记录该段，不跳过该证券余下区间，
 * 也不再用"累计三次失败"的门槛吞掉控制错误。调用方据此决定续跑/回退与是否发布质量分区。
 */
async function resolveValuationSeriesDetailed({ codes = [], startDate, endDate, options = {} } = {}) {
  const list = (codes || []).map(code => ({ tsCode: String(code), code: stockCodeOf(code) })).filter(item => item.code);
  const start = dashDate(startDate), end = dashDate(endDate);
  if (!list.length || !start || !end) return null;
  const rows = [];
  const failures = [];
  let attempted = 0;
  let emptyBatches = 0;
  // 官方「区间」模式只接受单个 stockCodes：一次传多只直接 400 ValidationError
  // （2026-11-01 生产实测 n=1 正常、n=10/30/50/100 全部失败）。所以这里按单只循环，
  // 不能像按日快照 resolveValuationRows 那样按 100 只批量；批量调用方要自己承担逐只请求的成本。
  for (const item of list) {
    for (const [from, to] of rangeChunks(start, end)) {
      attempted += 1;
      try {
        const result = await callEndpoint('cn/company/fundamental/non_financial', {
          stockCodes: [item.code], startDate: from, endDate: to, metricsList: VALUATION_METRICS,
        }, { dataset: 'stock_valuation', targetDate: end, ...options });
        if (!result.rows.length) emptyBatches += 1;
        for (const row of result.rows) {
          if (String(row.stockCode) !== String(item.code)) continue;
          const mapped = valuationRow(row, item.tsCode, to);
          if (mapped) rows.push(mapped);
        }
      } catch (error) {
        // 控制/凭据类错误立即上抛：既不重试、也不当作"这一段没数据"继续跑。
        if (isControlError(error)) throw error;
        failures.push(batchDiagnostic(error, { tsCode: item.tsCode, from, to }));
      }
    }
  }
  return summarizeBatches({ rows, planned: buildSeriesPlanSize(list, start, end), attempted, failures, emptyBatches,
    scope: { kind: 'series', startDate: start, endDate: end, codes: list.length } });
}

// 计划段数在请求前就可冻结：证券数 × 该区间的十年段数。
function buildSeriesPlanSize(list, start, end) {
  return list.length * rangeChunks(start, end).length;
}

/**
 * 年报归母净利润（元）：静态市盈率唯一缺的输入。
 * 官方 fs 接口按 reportType=annual_report 过滤，非年报（季报/中报）一律不参与静态市盈率。
 */
async function resolveAnnualNetProfits({ tsCode, startDate, endDate } = {}) {
  const code = stockCodeOf(tsCode);
  const start = dashDate(startDate), end = dashDate(endDate);
  if (!code || !start || !end) return null;
  const { rows } = await callEndpointRange('cn/company/fs/non_financial',
    { stockCodes: [code], metricsList: ['q.ps.npatshaoehopc.t'] }, start, end,
    { dataset: 'stock_financial_reports', targetDate: end });
  return rows.map(item => {
    const periodEnd = isoDate(item.standardDate) || isoDate(item.date);
    const node = item.q && item.q.ps && item.q.ps.npatshaoehopc;
    const netProfit = numberOrNull(node && node.t);
    if (!periodEnd || netProfit === null) return null;
    return {
      periodEnd,
      announcedAt: isoDate(item.reportDate) || periodEnd,
      reportType: String(item.reportType || ''),
      netProfit,
    };
  }).filter(Boolean)
    .filter(item => item.reportType === 'annual_report' || /1231$/.test(item.periodEnd))
    .sort((a, b) => (a.periodEnd < b.periodEnd ? -1 : a.periodEnd > b.periodEnd ? 1 : 0));
}

// 静态市盈率：站内页面字典就是「当前总市值 ÷ 最新完整年报归母净利润」，两个输入都在官方。
// 2026-10-30 用 600519 校验口径：官方 mc 1,740,176,092,672 ÷ 2025 年报归母 82,320,067,102 = 21.1391，
// 与 Tushare daily_basic.pe 21.1391 完全一致 —— 说明这是同一口径的定义式计算，不是估算兜底。
// 归母净利润缺失或为 0 时该日 pe 保持 null，不猜。
function fillStaticPe(rows, annuals) {
  const usable = (annuals || []).filter(item => item && Number.isFinite(item.netProfit) && item.netProfit !== 0);
  if (!usable.length) return rows;
  return (rows || []).map(row => {
    const day = String(row.trade_date || '');
    const marketCap = numberOrNull(row.total_mv);
    if (!day || marketCap === null) return row;
    let hit = null;
    for (const annual of usable) {
      const available = annual.announcedAt || annual.periodEnd;
      if (available && available <= day) hit = annual; // usable 已按报告期升序，最后一个命中的就是最近一期
    }
    if (!hit) return row;
    const pe = (marketCap * 10000) / hit.netProfit;
    return Number.isFinite(pe) ? { ...row, pe } : row;
  });
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
  const { rows } = await callEndpointRange('cn/company/fs/non_financial',
    { stockCodes: [code], metricsList: metrics }, start, end,
    { dataset: 'stock_financial_reports', targetDate: end, ...options });
  const out = { income: [], balance: [], cashflow: [], indicator: [] };
  for (const item of rows) {
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
  const result = await callEndpointRange('cn/company/dividend', { stockCode: code }, start, end,
    { dataset: 'stock_cash_dividend_facts', targetDate: end, ...options });
  const mapped = result.rows.map(row => {
    const cashRaw = numberOrNull(row.dividend);
    const amount = numberOrNull(row.dividendAmount);
    // 预案阶段（board_director_plan）官方只给 dividend=0、dividendAmount=null，即"金额未定"。
    // 不能当成"每股派 0 元"落库：0 会被当成已定金额，在现金收益里按权威等级压过备源的真实金额。
    const cash = cashRaw === 0 && amount === null ? null : cashRaw;
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
  // 分段拼接后同一事件可能重复出现（预案与实施跨报告期/跨年），按「报告期+公告日+进度」保留一条。
  const unique = new Map();
  for (const row of mapped) unique.set(`${row.end_date}:${row.ann_date || ''}:${row.div_proc || ''}`, row);
  return [...unique.values()];
}

// 指数日线：官方 cn/index/candlestick。现有 index_history 只存日期与收盘价。
async function resolveIndexDaily({ tsCode, startDate, endDate, type = 'normal', market = 'cn' } = {}) {
  // 指数 K 线 type 只接受 normal / total_return；恒指代码是字母（HSI），不按数字代码规则处理。
  const raw = String(tsCode || '').trim();
  const code = /^[A-Za-z]/.test(raw) ? raw.toUpperCase() : stockCodeOf(raw);
  const start = dashDate(startDate), end = dashDate(endDate);
  if (!code || !start || !end) return null;
  const endpoint = market === 'hk' ? 'hk/index/candlestick' : 'cn/index/candlestick';
  const result = await callEndpointRange(endpoint, { stockCode: code, type }, start, end,
    { dataset: 'index_daily', targetDate: end });
  const points = new Map();
  for (const row of result.rows) {
    const date = dashDate(row.date), close = numberOrNull(row.close);
    if (date && close !== null && close > 0) points.set(date, { date, close });
  }
  return [...points.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}



// 指数估值：官方 `cn/index/fundamental` 的 `pe_ttm.mcw` / `pb.mcw` 是总市值加权口径，
// 与站内既有 CSI300 加权 PE 同一口径（2026-10-30 CSI300 = 12.86，等权 ew 是 20.10，不能混用）。
async function resolveIndexValuation({ indexCode, startDate, endDate, market = 'cn', areaCode = 'cn' } = {}) {
  const start = dashDate(startDate), end = dashDate(endDate);
  const code = String(indexCode || '').trim();
  if (!code || !start || !end) return null;
  const endpoint = market === 'hk' ? 'hk/index/fundamental' : 'cn/index/fundamental';
  // cn 额外取 mc_om（A股市值），港股没有该指标。
  const metrics = market === 'hk' ? ['pe_ttm.mcw', 'pb.mcw', 'mc'] : ['pe_ttm.mcw', 'pb.mcw', 'mc', 'mc_om'];
  const result = await callEndpointRange(endpoint, { stockCodes: [code], metricsList: metrics }, start, end,
    { dataset: 'market_index_valuation', targetDate: end });
  const byDay = new Map();
  for (const row of result.rows) {
    const day = dashDate(row.date);
    const pe = numberOrNull(row['pe_ttm.mcw']);
    const pb = numberOrNull(row['pb.mcw']);
    const mc = numberOrNull(row.mc);
    if (!day || (pe === null && pb === null)) continue;
    byDay.set(day, { day, pe, pb, marketCap: mc, raw: row });
  }
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

// 股票/港股日线（不复权）：官方 `cn|hk/company/candlestick`，type=ex_rights。
// 单位换算回 Tushare 口径：官方 volume 是股 → 手(/100)，amount 是元 → 千元(/1000)。
async function resolveStockDaily({ tsCode, startDate, endDate, market = 'cn', options = {} } = {}) {
  const resolved = await officialStockCode(tsCode).catch(() => null);
  const code = (typeof resolved === 'string' && resolved) || stockCodeOf(tsCode);
  const start = dashDate(startDate), end = dashDate(endDate);
  if (!code || !start || !end) return null;
  const endpoint = market === 'hk' ? 'hk/company/candlestick' : 'cn/company/candlestick';
  const result = await callEndpointRange(endpoint, { stockCode: code, type: 'ex_rights' }, start, end,
    { dataset: 'market_daily_bars', targetDate: end, ...options });
  const byDay = new Map();
  for (const row of result.rows) {
    const tradeDate = isoDate(row.date);
    const close = numberOrNull(row.close);
    if (!tradeDate || close === null) continue;
    byDay.set(tradeDate, {
      ts_code: tsCode,
      trade_date: tradeDate,
      open: numberOrNull(row.open),
      high: numberOrNull(row.high),
      low: numberOrNull(row.low),
      close,
      vol: numberOrNull(row.volume) === null ? null : numberOrNull(row.volume) / 100,
      amount: numberOrNull(row.amount) === null ? null : numberOrNull(row.amount) / 1000,
      source_code: SOURCE,
    });
  }
  return [...byDay.values()].sort((a, b) => (a.trade_date < b.trade_date ? -1 : a.trade_date > b.trade_date ? 1 : 0));
}


// 按需批量日线：官方 candlestick 是单只接口，没有"按交易日取全市场"的批量接口
// （2026-10-31 逐条核对 261 条目录：返回 OHLC 的 6 个接口全部只接受单值 stockCode，
//  带 stockCodes 复数的接口都不返回开高低收）。因此只对"确实需要日线"的证券逐个取，
// 并发受限、失败按只记缺失，交由调用方用原来源补，不把整批打断。
// 串行取数：统一 Guard 对「来源+数据集+业务日」持有咨询锁，同一数据集并发请求会被判为
// DATASET_LOCKED 直接拒绝，这是既有设计（额度记账按数据集分区）。因此这里逐只串行，
// 节奏由 Guard 的最小间隔（官方 28ms/次）控制，不在这里另外并发。
const DAILY_BATCH_CONCURRENCY = 1;
const ABORT_CODES = new Set(['JOB_BUDGET_EXCEEDED', 'POLICY_NOT_CONFIGURED', 'DATASET_LOCKED']);

async function resolveStockDailyBatch({ tsCodes = [], tradeDate, market = 'cn', options = {} } = {}) {
  const list = Array.from(new Set((tsCodes || []).filter(Boolean)));
  const rows = [];
  const missing = [];
  if (!list.length || !tradeDate) return { rows, missing: list };
  for (const group of chunk(list, DAILY_BATCH_CONCURRENCY)) {
    const settled = await Promise.all(group.map(async tsCode => {
      try {
        const got = await resolveStockDaily({ tsCode, startDate: tradeDate, endDate: tradeDate, market, options });
        return { tsCode, rows: got || [] };
      } catch (error) {
        if (ABORT_CODES.has(error.code)) throw error;
        return { tsCode, rows: [], error };
      }
    }));
    for (const item of settled) {
      if (item.rows.length) rows.push(...item.rows);
      else missing.push(item.tsCode);
    }
  }
  return { rows, missing };
}

// 宏观：M2 货币供应。官方 `macro/money-supply` 的 `m.m2.t`（月·累积）单位是元，
// 站内 `market.money_supply_monthly.m2_100m_yuan` 是亿元 → /1e8。
// 2026-09 官方 359,628,970,000,000 元 = 3,596,289.7 亿元，与央行口径一致。
async function resolveMoneySupply({ startDate, endDate, areaCode = 'cn' } = {}) {
  const start = dashDate(startDate), end = dashDate(endDate);
  if (!start || !end) return null;
  const result = await callEndpointRange('macro/money-supply', { areaCode, metricsList: ['m.m2.t'] }, start, end,
    { dataset: 'market_money_supply', targetDate: end });
  const byMonth = new Map();
  for (const row of result.rows) {
    const value = numberOrNull(row.m && row.m.m2 && row.m.m2.t);
    const date = dashDate(row.date);
    if (value === null || !date) continue;
    byMonth.set(date.slice(0, 7), { month: date.slice(0, 7), m2: value / 1e8 });
  }
  return [...byMonth.values()].sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
}

// 宏观：中国 10 年期国债收益率。官方 `macro/national-debt` 的 `tcm_y10` 是小数（0.0165 = 1.65%），
// 站内 `market.sovereign_yield_daily.yield_pct` 是百分数点 → ×100。
async function resolveSovereignYield10y({ startDate, endDate, areaCode = 'cn' } = {}) {
  const start = dashDate(startDate), end = dashDate(endDate);
  if (!start || !end) return null;
  const result = await callEndpointRange('macro/national-debt', { areaCode, metricsList: ['tcm_y10'] }, start, end,
    { dataset: 'market_sovereign_yield', targetDate: end });
  const byDay = new Map();
  for (const row of result.rows) {
    const value = numberOrNull(row.tcm_y10);
    const date = dashDate(row.date);
    if (value === null || !date) continue;
    byDay.set(date, { workTime: date, tenYear: value * 100 });
  }
  return [...byDay.values()].sort((a, b) => (a.workTime < b.workTime ? -1 : a.workTime > b.workTime ? 1 : 0));
}

// 股票行业分类（官方一次返回 sw / sw_2021 / cni 多套体系）：只回原始行，
// 选哪套体系、怎么判级属于领域规则，不在适配层决定。
async function resolveIndustryRows({ tsCode, cacheMs } = {}) {
  const resolved = await officialStockCode(tsCode).catch(() => null);
  const code = (typeof resolved === 'string' && resolved) || stockCodeOf(tsCode);
  if (!code) return null;
  const result = await callEndpoint('cn/company/industries', { stockCode: code },
    { dataset: 'stock_analysis_industry', ...(cacheMs ? { maxAgeMs: cacheMs } : {}) });
  return result.rows;
}

// 官方证券代码走统一身份映射，业务不得自己拼后缀。
// 官方供应商代码：标识层可能返回标识行对象，也可能是字符串；
// 这里统一收敛成纯代码，避免把对象塞进请求体（会被上游判为 400 ValidationError）。
async function officialStockCode(canonicalCode) {
  const resolved = await resolveProviderIdentifier({ canonicalCode, sourceCode: SOURCE, identifierType: 'stock_code' });
  if (resolved && typeof resolved === 'object') {
    return resolved.identifier_value || resolved.identifierValue || null;
  }
  return resolved || null;
}

module.exports = {
  SOURCE,
  MAX_RANGE_YEARS,
  rangeChunks,
  REPORT_METRICS,
  VALUATION_METRICS,
  fillStaticPe,
  officialStockCode,
  resolveAnnualNetProfits,
  resolveDividendRows,
  resolveFinancialReports,
  resolveIndexDaily,
  resolveIndustryRows,
  resolveIndexValuation,
  resolveMoneySupply,
  resolveSovereignYield10y,
  resolveStockDaily,
  resolveStockDailyBatch,
  resolveValuationRows,
  resolveValuationRowsDetailed,
  resolveValuationSeries,
  resolveValuationSeriesDetailed,
};

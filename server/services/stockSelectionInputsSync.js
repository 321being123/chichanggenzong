// 投资策略选股中心：选股输入补齐（SSV-01）。
// 只做两件事：①把"应补未补"的对象按市场/目标日冻结成可续跑队列；②逐公司调用**既有**数据访问层与
// 既有标准层写入入口（persistCollectedData）把财报与分红补进原表。
// 不新建第二套采集链、不自己拼 HTTP、不写平行事实表。
// 估值与行情：A 股仍由共享行情任务负责（本任务只记剩余）；**港股没有这条共享链路**，
// 港股估值缺口由本任务的 collectHkMarketData 补（数据层已支持 hk 端点，写入同为 daily_valuations/daily_bars）。
'use strict';

const { persistCollectedData } = require('./financialDataArchitecture');
const { checkHistoryCollectionSpace } = require('./diskGuard');
const repo = require('../repositories/stockSelectionRepository');
const { upsertIndustryPath } = require('../repositories/industryRepository');

// 财报历史要覆盖"最新一年 + 此前十年"（方案 5.2 的 11 个完整财年），再往前留一年缓冲。
const HISTORY_YEARS = 12;
const REPORT_KINDS = ['income', 'balance', 'cashflow', 'indicator'];
// 港股估值要覆盖十年 PB 窗口（R02），再留一年缓冲；选股收盘价只需覆盖近一年（R04 分母 + 60 天窗口判定）。
// 个股分析页需要完整十年股价（反馈 #117），单股刷新通过 historyYears 单独扩大到 11 年，不放大选股批次。
const HK_VALUATION_YEARS = 11;
const HK_PRICE_YEARS = 1;
const HK_ANALYSIS_PRICE_YEARS = 11;

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function dashDate(value) {
  const text = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

/**
 * 交易日归一：官方估值/日线在不同接口上分别返回 `YYYYMMDD` 与 `YYYY-MM-DD`
 * （2026-11-05 实测：港股日线与估值序列都给 `20261104`），统一成标准层的 date 文本。
 */
function normalizeTradeDate(value) {
  const text = String(value || '').trim();
  const compact = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  return dashDate(text);
}

function shiftYears(date, years) {
  const year = Number(String(date).slice(0, 4)) - years;
  const month = String(date).slice(5, 10);
  return `${year}-${month}`;
}

/**
 * 缺口分类（R2-04）：按缺口自带的 domains 归类，**多条互斥判断改为并列**——
 * 一只证券同时缺财报与估值时必须两处都进去，不能因为 else-if 只补一类、
 * 然后把另一类永远留在"没人处理"的状态里。
 *
 * fundamental = 本任务能补的财报/分红（同一 collectOne 一并取回）
 * industry    = 本任务能补的一级行业分类
 * valuation   = 本任务不补，只负责如实记为剩余（等共享行情任务）
 * unclassified = 未能识别归属的缺口，必须显式暴露，不能静默消失
 */
function classifyGaps(gaps) {
  const fundamental = [];
  const industry = [];
  const valuation = [];
  const unclassified = [];
  (gaps || []).forEach(gap => {
    const domains = Array.isArray(gap.domains) ? gap.domains : [];
    if (domains.includes('financial_reports') || domains.includes('dividends')) fundamental.push(gap);
    if (domains.includes('industry')) industry.push(gap);
    if (domains.includes('valuation')) valuation.push(gap);
    if (domains.includes('unclassified') || (!domains.length && (gap.reasons || []).length === 0)) unclassified.push(gap);
  });
  return { fundamental, financial: fundamental, industry, valuation, unclassified };
}

function domainCountsOfGaps(gaps) {
  return (gaps || []).reduce((acc, gap) => {
    (Array.isArray(gap.domains) ? gap.domains : []).forEach(domain => { acc[domain] = (acc[domain] || 0) + 1; });
    return acc;
  }, {});
}

/**
 * 批次公平的顺序（R4-02）：按"累计被尝试次数"升序排队，同一次数内上次失败/无进展的排后，再按审计原序。
 * 只把"上一批失败的对象"挪到队尾是不够的——每轮只保存本批集合会让更早的尝试记录丢失，
 * 三只对象、每批一只时永远在处理前两只（第三只永远轮不到）。
 * 这里改为跨批次持久化每个对象的尝试次数：次数少的一定先被选中，
 * 因此 N 个对象、每批 B 个时，最多 ⌈N/B⌉+1 轮每个对象都会获得机会，且在重启后依然成立。
 */
function orderByAttempts(list, attempts, deprioritized) {
  return list
    .map((item, index) => ({
      item,
      index,
      tries: Math.max(0, Number((attempts || {})[item.code] || 0)),
      late: deprioritized && deprioritized.has(item.code) ? 1 : 0,
    }))
    .sort((a, b) => a.tries - b.tries || a.late - b.late || a.index - b.index)
    .map(row => row.item);
}

// 只保留仍待补对象的尝试次数，避免已解决对象的历史计数无限增长。
// R5-01：**不设条数上限**——用 JSON 键数上限裁掉尾部对象，会把这些对象的计数当成 0，
// 于是每轮都把它们当成"最少尝试"再补一次，前面的对象反而永远拿不到重试机会。
// 公平性必须覆盖全部未完成对象；执行批量（batchLimit）与队列完整性是两件事。
function pruneAttempts(attempts, remainingCodes) {
  const out = {};
  Object.entries(attempts || {}).forEach(([code, count]) => {
    if (!remainingCodes.has(code)) return;
    out[code] = Number(count) || 0;
  });
  return out;
}

async function readMeta(tsCode) {
  // SQL 只允许在仓储层（静态分层门禁 R2-07）；服务层不再直接持连接池查询。
  return repo.findInstrumentMeta({ tsCode });
}

function chunkCodes(list, size = 100) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * B2-2：批量解析 fsTableType，消除逐股查档案。
 * 先读本地主档与近期已核实财报（repo.loadFsTableTypes），只对缺失代码按 ≤100 只/批
 * 调用官方档案；官方响应由统一采集缓存留在 ops.raw_records，下次直接复用。
 */
async function resolveBatchFsTableTypes({ codes = [], deps = {} } = {}) {
  const result = new Map();
  const unique = Array.from(new Set((codes || []).map(code => String(code || '').trim().toUpperCase()).filter(Boolean)));
  if (!unique.length) return result;
  const loadLocal = deps.loadFsTableTypes || repo.loadFsTableTypes;
  if (typeof loadLocal === 'function') {
    try {
      const local = await loadLocal({ codes: unique });
      if (local instanceof Map) local.forEach((value, key) => { if (value) result.set(String(key).toUpperCase(), String(value)); });
      else Object.entries(local || {}).forEach(([key, value]) => { if (value) result.set(String(key).toUpperCase(), String(value)); });
    } catch (_) { /* 本地读失败不阻断，转官方批量核对 */ }
  }
  const missing = unique.filter(code => !result.get(code));
  if (!missing.length) return result;
  const datasets = deps.datasets || require('../dataAccess/marketDatasets');
  const readHk = deps.readCompanyProfiles || datasets.readCompanyProfiles;
  const readCn = deps.readCnCompanyProfiles || datasets.readCnCompanyProfiles;
  const groups = [
    { read: readHk, codes: missing.filter(code => /\.HK$/i.test(code)) },
    { read: readCn, codes: missing.filter(code => !/\.HK$/i.test(code)) },
  ];
  for (const group of groups) {
    if (typeof group.read !== 'function') continue;
    for (const part of chunkCodes(group.codes)) {
      try {
        const profiles = (await group.read({ codes: part })) || [];
        profiles.forEach(profile => {
          if (profile && profile.code && profile.fsTableType) {
            result.set(String(profile.code).toUpperCase(), String(profile.fsTableType));
          }
        });
      } catch (_) { /* 单批失败留待下一次续批，不把整批财报补采打断 */ }
    }
  }
  return result;
}

function dateKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function addDays(text, days) {
  const date = new Date(`${text}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return dateKey(date);
}

// 无本地日历时回退按工作日估算（只用于断档定位，不作为业务事实）。
function weekdayDates(startDate, endDate) {
  const out = [];
  for (let cursor = startDate; cursor <= endDate; cursor = addDays(cursor, 1)) {
    const day = new Date(`${cursor}T00:00:00Z`).getUTCDay();
    if (day !== 0 && day !== 6) out.push(cursor);
  }
  return out;
}

/**
 * B2-3：按本地已覆盖日期求真实缺失起止段。
 * 尾部仅缺 1–5 天时只会得到一个短段，不会重拉 11 年全历史；内部断档按连续缺失日分段。
 */
function missingDateSegments({ expected = [], covered = new Set(), startDate, endDate } = {}) {
  const expectedDays = Array.isArray(expected) && expected.length
    ? expected.filter(day => day >= startDate && day <= endDate)
    : weekdayDates(startDate, endDate);
  const segments = [];
  expectedDays.forEach((day, index) => {
    if (covered.has(day)) return;
    const previous = expectedDays[index - 1];
    const last = segments[segments.length - 1];
    // 相邻“应有交易日”都缺失才算同一段：周末/休市不切断区间，被覆盖日会切断区间。
    if (last && previous === last.endDate) last.endDate = day;
    else segments.push({ startDate: day, endDate: day });
  });
  return segments;
}

/**
 * 本次补采实际需要的种类与区间（INC-0054 第一阶段第 2 条）。
 * 队列里带 collection_plan 时按它冻结的种类与最早缺口年份取数；
 * 没有计划或计划不完整时退回原来的 12 年 × 四类——宁可多取也不漏补。
 * 只缺分红时不再拉财报（方案：只缺分红就单独补分红）。
 */
function collectionWindowOf(gap, asOfDate) {
  const plan = (gap && gap.collection_plan) || {};
  const domains = Array.isArray(gap && gap.domains) ? gap.domains : [];
  const onlyDividends = domains.includes('dividends') && !domains.includes('financial_reports');
  // 没有 domains 信息时无法判断缺什么，分红要按保守口径照拉；明确不含 dividends 就不拉。
  const needDividends = !domains.length || domains.includes('dividends');
  const planned = (Array.isArray(plan.report_kinds) ? plan.report_kinds : [])
    .filter(kind => REPORT_KINDS.includes(kind));
  const periods = (Array.isArray(plan.report_periods) ? plan.report_periods : [])
    .map(String).filter(year => /^\d{4}$/.test(year)).sort();
  const fallbackStart = dashDate(shiftYears(asOfDate, HISTORY_YEARS)) || '2000-01-01';
  const plannedStart = periods.length ? `${periods[0]}-01-01` : fallbackStart;
  return {
    kinds: onlyDividends ? [] : (planned.length ? planned : [...REPORT_KINDS]),
    // 缺口年份比 12 年窗口更早时以窗口为准，不能把该覆盖的历史丢掉。
    startDate: plannedStart < fallbackStart ? fallbackStart : plannedStart,
    // 分红游标与财报缺口年份无关：财报只缺 2020 年时，分红不能被收窄成「2020 年起」，
    // 否则港股 dividends 的成功水位会被写成 2020-01-01，2020 年以前永远不再补。
    dividendStartDate: fallbackStart,
    needDividends,
    narrowed: periods.length > 0 || planned.length > 0,
    onlyDividends,
  };
}

/**
 * 单只证券补财报 + 分红：数据层负责主备来源与字段归一，persistCollectedData 负责落原表与原始留证。
 * 港股与 A 股走同一条链路，只在数据层内部按代码后缀选择官方端点（见 lixingerDatasetAdapter）。
 * `deps` 只给回归测试注入数据层/仓储替身，生产调用保持默认实现。
 */
async function collectOne(gap, asOfDate, runContext = null, deps = {}, timing = null) {
  const readMetaFn = deps.readMeta || readMeta;
  const persist = deps.persist || persistCollectedData;
  const meta = await readMetaFn(gap.code);
  if (!meta) return { code: gap.code, ok: false, reason: 'instrument_missing' };
  const window = collectionWindowOf(gap, asOfDate);
  const startDate = window.startDate;
  const datasets = deps.datasets || require('../dataAccess/marketDatasets');
  const { readFinancialReportRows, readDividendRows, readDividendRowsWithCoverage } = datasets;
  const bundle = {};
  let anyFinancial = false;
  // 港股财报端点按公司财报类型分流（2026-11-05 实测：银行/保险/证券端点指标名与普通公司一致，
  // 只是端点不同；类型取自 hk/company 档案，取不到就保留为未知，不猜成普通公司。
  // B2-2：批量预取的 fsTableType 优先（同步入口已按 ≤100 只/批核对并复用缓存），
  // 这里不再逐股查档案；只有批量结果缺失时才回退单只查询（安全兜底，不改变既有行为）。
  let fsTableType = deps.fsTableTypeByCode
    ? (deps.fsTableTypeByCode.get(String(meta.ts_code || '').toUpperCase()) || null)
    : null;
  // F-14：批量入口已经查过档案（记录在 fsTableTypeChecked）仍拿不到类型时，不再为同一只港股重复发单只档案。
  // 没有批量检查证据（直调 collectOne）才保留单只兜底，避免破坏既有入口。
  const batchChecked = deps.fsTableTypeChecked instanceof Set
    && deps.fsTableTypeChecked.has(String(meta.ts_code || '').toUpperCase());
  if (window.kinds.length && !fsTableType && !batchChecked && /^\d{5}\.HK$/i.test(String(meta.ts_code || ''))) {
    try {
      const { readCompanyProfiles } = datasets;
      const profiles = (await readCompanyProfiles({ codes: [meta.ts_code] })) || [];
      fsTableType = (profiles[0] && profiles[0].fsTableType) || null;
    } catch (_) { fsTableType = null; }
  }
  const financial = window.kinds.length
    ? await readFinancialReportRows({
      tsCode: meta.ts_code, kinds: window.kinds, startDate, endDate: asOfDate, fsTableType,
      // B2-2：选股补财报只取核心科目批次，不再拉三表全量与原生比较值。
      profile: 'selection_core',
    })
    : null;
  if (financial) {
    if (Array.isArray(financial.income) && financial.income.length) { bundle.income = financial.income; anyFinancial = true; }
    if (Array.isArray(financial.balance) && financial.balance.length) { bundle.balance = financial.balance; anyFinancial = true; }
    if (Array.isArray(financial.cashflow) && financial.cashflow.length) { bundle.cashflow = financial.cashflow; anyFinancial = true; }
    if (Array.isArray(financial.indicator) && financial.indicator.length) { bundle.indicators = financial.indicator; anyFinancial = true; }
  }
  // 分红只在本次确实有分红缺口时拉取；游标用不受财报缺口年份收窄的窗口起点。
  const dividendStart = window.dividendStartDate;
  const divResult = !window.needDividends
    ? null
    : (typeof readDividendRowsWithCoverage === 'function'
      ? await readDividendRowsWithCoverage({ tsCode: meta.ts_code, startDate: dividendStart, endDate: asOfDate })
      : { rows: await readDividendRows({ tsCode: meta.ts_code, startDate: dividendStart, endDate: asOfDate }), coverage: null });
  const dividends = divResult && Array.isArray(divResult.rows) ? divResult.rows : (Array.isArray(divResult) ? divResult : null);
  const dividendCoverage = divResult && divResult.coverage && divResult.coverage.complete === true
    ? { complete: true, startDate: dashDate(divResult.coverage.startDate) || dividendStart, endDate: dashDate(divResult.coverage.endDate) || dashDate(asOfDate) }
    : null;
  if (Array.isArray(dividends) && dividends.length) bundle.dividends = dividends;
  if (!anyFinancial && !bundle.dividends) {
    // 官方返回空 = 本次没有可入库的新事实；不能当成"已补齐"，也不覆盖旧数据。
    return { code: gap.code, ok: false, reason: 'source_returned_empty', dividendCoverage };
  }
  const persistStartedAt = Date.now();
  await persist({
    ts_code: meta.ts_code,
    name: meta.name,
    market: meta.market,
    list_date: meta.list_date,
    data: meta.raw_data || {},
    // 采集批次要能追到发起者与目标范围（INC-0054 第一阶段第 3 条）：
    // 事故当天 8,504 个 stock_analysis_direct 批次找不到父任务，只能靠现场推断。
    collection_context: {
      caller: (runContext && runContext.caller) || 'stock_selection_inputs',
      callerMode: (runContext && runContext.callerMode) || 'selection_inputs',
      jobRunId: (runContext && runContext.jobRunId) || null,
      slotId: (runContext && runContext.slotId) || null,
      targetRange: { market: meta.market, asOfDate },
    },
  }, bundle);
  if (timing) timing.persistMs = (timing.persistMs || 0) + (Date.now() - persistStartedAt);
  if (dividendCoverage && dividendCoverage.complete === true && /\.HK$/i.test(String(meta.ts_code || ''))) {
    const { datasetScope, markDatasetSuccess } = require('./datasetCursors');
    await markDatasetSuccess(datasetScope('hk', meta.ts_code), 'dividends', {
      lastSuccessDate: dashDate(asOfDate),
      cursorPayload: dividendCoverage,
    });
  }
  return {
    code: gap.code,
    ok: true,
    financials: anyFinancial,
    dividends: Boolean(bundle.dividends),
    dividendCoverage,
    // 本次实际取数的范围随结果返回：补了什么、有没有按缺口收窄，必须能从任务回执看出来。
    collection: {
      kinds: window.kinds, startDate, narrowed: window.narrowed, onlyDividends: window.onlyDividends,
      needDividends: window.needDividends, dividendStartDate: dividendStart,
    },
  };
}

/**
 * 单只证券补一级行业分类：A 股走官方申万 2021，港股走官方恒生行业分类（hsi），
 * 取整条路径后写标准层（全层级节点 + 归属指向最深节点），供"单一行业不超过 20%"使用。
 */
async function collectIndustryOne(gap, market) {
  const companyId = gap.companyId ? Number(gap.companyId) : null;
  if (!companyId) return { code: gap.code, ok: false, reason: 'company_missing' };
  const { readIndustryClassification } = require('../dataAccess/marketDatasets');
  const info = await readIndustryClassification({ tsCode: gap.code });
  if (!info || !Array.isArray(info.industry_nodes) || !info.industry_nodes.length) {
    // 官方没给到从一级起的完整路径就是不补：塞个"其他"会让行业上限判定失真。
    return { code: gap.code, ok: false, reason: 'industry_source_returned_empty' };
  }
  const isHk = String(market || '').toUpperCase() === 'HK';
  await upsertIndustryPath({
    companyId,
    taxonomyCode: isHk ? 'HSICS' : 'SW2021',
    taxonomyName: isHk ? '恒生行业分类' : '申万行业',
    taxonomyVersion: isHk ? '' : '2021',
    nodes: info.industry_nodes,
    sourceCode: info.sourceCode || 'lixinger_official',
  });
  return {
    code: gap.code,
    ok: true,
    industry: info.industry,
    level: info.industry_level,
    path: (info.industry_path || []).join(' / '),
  };
}

/**
 * F-11：判断港股估值缺口是否必须回补多日历史序列。
 * 只有明确指向十年 PB 窗口/历史覆盖的原因（R02、history_*、coverage_unknown、gap_not_evaluable）
 * 才需要逐只拉序列；仅目标日估值缺失（R01/pb_unavailable）由多端点单日快照即可补齐。
 */
function needsHistoricalValuation(gap) {
  const reasons = Array.isArray(gap && gap.reasons) ? gap.reasons : [];
  return reasons.some(reason => /^R02:/i.test(String(reason))
    || /history|pb_window|pbwindow|coverage_unknown|gap_not_evaluable/i.test(String(reason)));
}

/**
 * F-11：把官方港股单日快照行换算成标准层估值行。
 * 口径与 collectHkMarketData 一致：`dv_ttm` 百分数点 → 小数股息率，`total_mv` 万元 → 元，币种随行写 HKD。
 */
function mapHkValuationSnapshotRows(rawRows, metaByCode) {
  const rows = [];
  const countByCode = new Map();
  (rawRows || []).forEach(row => {
    const code = String((row && row.ts_code) || '').toUpperCase();
    const meta = metaByCode.get(code) || null;
    if (!meta || !meta.instrument_id) return;
    const tradeDate = normalizeTradeDate(row.trade_date);
    if (!tradeDate) return;
    const dividendYield = finite(row.dv_ttm);
    const totalMv = finite(row.total_mv);
    const circMv = finite(row.circ_mv);
    rows.push({
      instrumentId: Number(meta.instrument_id),
      tradeDate,
      peStatic: finite(row.pe),
      peTtm: finite(row.pe_ttm),
      pb: finite(row.pb),
      dividendYield: dividendYield === null ? null : dividendYield / 100,
      totalMarketCap: totalMv === null ? null : totalMv * 10000,
      circulatingMarketCap: circMv === null ? null : circMv * 10000,
      currencyCode: row.currency || meta.currency_code || 'HKD',
    });
    countByCode.set(code, (countByCode.get(code) || 0) + 1);
  });
  return { rows, countByCode };
}

/**
 * 港股单只补估值序列 + 收盘价（A 股不走这里，仍等共享行情任务）。
 *
 * 数据层 `readStockValuationSeriesBatch` / `readStockDailySeries` 已按代码后缀分流到官方港股端点，
 * 本函数只做两件事：把数据层给的原有链路口径换算成标准层口径，再幂等落库。
 * 口径：数据层港股行沿用 `hkValuationRow` 的 `dv_ttm` 百分数点、`total_mv` 万元；
 * 标准层统一为小数股息率与「元」总市值，币种随行写入 HKD。
 * 官方分段取数部分失败时，已取到的行照常落库，剩余区间留给下一批，不用空值覆盖旧行。
 */
async function collectHkMarketData(gap, asOfDate, timing = null, deps = {}) {
  const readMetaFn = deps.readMeta || readMeta;
  const meta = await readMetaFn(gap.code);
  if (!meta) return { code: gap.code, ok: false, reason: 'instrument_missing' };
  const instrumentId = meta.instrument_id === null || meta.instrument_id === undefined ? null : Number(meta.instrument_id);
  if (!instrumentId) return { code: gap.code, ok: false, reason: 'instrument_id_missing' };
  const datasets = deps.datasets || require('../dataAccess/marketDatasets');
  const { readStockValuationSeriesBatch, readStockDailySeries, readStockForwardAdjustedSeries } = datasets;
  const store = require('./convertibleBondAnalysisStore');
  const sources = await store.sourceIds();
  const officialId = sources.lixinger_official;
  if (!officialId) return { code: gap.code, ok: false, reason: 'valuation_source_missing' };

  const valuationStart = dashDate(shiftYears(asOfDate, HK_VALUATION_YEARS)) || '2000-01-01';
  // 单股分析刷新传入 historyYears=11 时才拉十年日线；选股补数仍按一年，避免放大全市场批次。
  const priceYears = Number(gap.historyYears) > 0 ? Number(gap.historyYears) : HK_PRICE_YEARS;
  const priceStart = dashDate(shiftYears(asOfDate, priceYears)) || valuationStart;
  const includeAdjustments = gap.includeAdjustments === true && priceYears >= HK_ANALYSIS_PRICE_YEARS;
  // B2-3：历史估值也按 fsTableType 分流；选股补数要求类型先确认，未知类型不猜非金融端点，
  // 留缺口等档案核对（也避免为此白查覆盖与日历）。
  const fsTableType = deps.fsTableTypeByCode
    ? (deps.fsTableTypeByCode.get(String(meta.ts_code || '').toUpperCase()) || null)
    : (deps.fsTableType || null);
  if (!fsTableType) return { code: gap.code, ok: false, reason: 'financial_type_unknown' };
  // B2-3：先查本地已覆盖区间，只拉真实断档起止段。尾部只缺 1–5 天时不再重拉 11 年全历史；
  // 内部断档按连续缺失日分段，每段仍由数据层按 ≤10 年自动再分段。
  const loadCoverage = deps.loadHkCoverageDates || repo.loadHkCoverageDates;
  const coverage = typeof loadCoverage === 'function'
    ? await Promise.resolve(loadCoverage({ instrumentId, startDate: valuationStart, endDate: asOfDate }))
      .catch(() => ({ valuation: new Set(), bars: new Set() }))
    : { valuation: new Set(), bars: new Set() };
  const loadCalendar = deps.loadHkTradeCalendar || repo.loadHkTradeCalendar;
  const calendar = typeof loadCalendar === 'function'
    ? await Promise.resolve(loadCalendar({ startDate: valuationStart, endDate: asOfDate })).catch(() => [])
    : [];
  const valuationSegments = missingDateSegments({
    expected: calendar, covered: coverage.valuation, startDate: valuationStart, endDate: asOfDate,
  });
  const barSegments = missingDateSegments({
    expected: calendar, covered: coverage.bars, startDate: priceStart, endDate: asOfDate,
  });
  let rawValuations = [];
  let partial = false;
  for (const segment of valuationSegments) {
    try {
      const rows = await readStockValuationSeriesBatch({
        codes: [meta.ts_code], startDate: segment.startDate, endDate: segment.endDate, fsTableType,
      });
      rawValuations = rawValuations.concat(rows || []);
    } catch (error) {
      if (Array.isArray(error && error.partialRows)) {
        rawValuations = rawValuations.concat(error.partialRows);
        partial = true;
        continue; // 已取到的行照常落库，剩余段留给下一次续批。
      }
      // 未知财报类型属于业务缺口，不中断其它证券；返回失败由缺口队列记录。
      if (String(error && error.code) === 'HK_FS_TABLE_TYPE_UNKNOWN') {
        return { code: gap.code, ok: false, reason: 'financial_type_unknown', partial: false };
      }
      throw error;
    }
  }
  const valuations = (rawValuations || []).map(row => {
    const dividendYield = finite(row.dv_ttm);
    const totalMv = finite(row.total_mv);
    const circMv = finite(row.circ_mv);
    return {
      instrumentId,
      tradeDate: normalizeTradeDate(row.trade_date),
      peStatic: finite(row.pe),
      peTtm: finite(row.pe_ttm),
      pb: finite(row.pb),
      dividendYield: dividendYield === null ? null : dividendYield / 100,
      totalMarketCap: totalMv === null ? null : totalMv * 10000,
      circulatingMarketCap: circMv === null ? null : circMv * 10000,
      currencyCode: row.currency || meta.currency_code || 'HKD',
    };
  }).filter(row => row.tradeDate);
  const valuationWriteStartedAt = Date.now();
  const valuationWritten = await repo.upsertDailyValuationRows({ rows: valuations, sourceId: officialId });
  if (timing) timing.persistMs = (timing.persistMs || 0) + (Date.now() - valuationWriteStartedAt);

  let rawBars = [];
  // 单股分析刷新需要十年收盘价才能画完整前复权曲线；此时整段重取一次，
  // 同时作为前复权因子的分母。选股仍只补真实断档段。
  const barFetchSegments = includeAdjustments && priceYears >= HK_ANALYSIS_PRICE_YEARS
    ? [{ startDate: priceStart, endDate: asOfDate }]
    : barSegments;
  for (const segment of barFetchSegments) {
    try {
      const rows = await readStockDailySeries({
        tsCode: meta.ts_code, startDate: segment.startDate, endDate: segment.endDate, market: 'hk',
      });
      rawBars = rawBars.concat(rows || []);
    } catch (error) {
      if (Array.isArray(error && error.partialRows)) {
        rawBars = rawBars.concat(error.partialRows);
        partial = true;
        continue;
      }
      throw error;
    }
  }
  const barWriteStartedAt = Date.now();
  const barWritten = await writeHkBars({
    rawBars, instrumentId, sources, officialId,
  });
  if (timing) timing.persistMs = (timing.persistMs || 0) + (Date.now() - barWriteStartedAt);

  let adjustmentWritten = 0;
  if (includeAdjustments) {
    let forwardRows = [];
    for (const segment of barFetchSegments) {
      try {
        const rows = await readStockForwardAdjustedSeries({
          tsCode: meta.ts_code, startDate: segment.startDate, endDate: segment.endDate, market: 'hk',
        });
        forwardRows = forwardRows.concat(rows || []);
      } catch (error) {
        // 前复权只是派生指标；取不到时保持因子缺失，不影响不复权收盘价和估值。
        if (String(error && error.code) === 'JOB_BUDGET_EXCEEDED') throw error;
        partial = true;
      }
    }
    const rawCloseByDate = new Map(rawBars.map(row => [normalizeTradeDate(row.trade_date), finite(row.close)]));
    const factorRows = forwardRows.map(row => {
      const tradeDate = normalizeTradeDate(row.trade_date);
      const forwardClose = finite(row.close);
      const rawClose = rawCloseByDate.get(tradeDate);
      if (!tradeDate || forwardClose === null || forwardClose <= 0 || rawClose === null || rawClose <= 0) return null;
      return { tradeDate, adjFactor: forwardClose / rawClose };
    }).filter(Boolean);
    if (factorRows.length) {
      adjustmentWritten = await require('../repositories/hkSecurityAnalysisRepository')
        .saveAdjustmentFactors({ instrumentId, sourceId: officialId, rows: factorRows });
    }
  }

  const ok = valuationWritten > 0 || barWritten > 0;
  return {
    code: gap.code,
    ok,
    reason: ok ? undefined : (valuationSegments.length || barFetchSegments.length ? 'projection_returned_empty' : 'already_covered'),
    valuations: valuationWritten,
    bars: barWritten,
    adjustments: adjustmentWritten,
    partial,
    // 本次实际请求的断档段：证明尾部 1–5 天缺口没有重拉 11 年。
    coverageSegments: { valuation: valuationSegments, bars: barFetchSegments },
  };
}

/**
 * 港股收盘价落库：按来源分组写（官方与腾讯混用时各自记来源），返回写入行数。
 * 单位与字段口径由数据层保证，这里只做代码→instrument_id 的绑定与落库。
 */
async function writeHkBars({ rawBars, instrumentId, sources, officialId }) {
  const barGroups = new Map();
  (rawBars || []).forEach(row => {
    const tradeDate = normalizeTradeDate(row.trade_date);
    const close = finite(row.close);
    if (!tradeDate || close === null) return;
    const sourceCode = row.source_code || 'lixinger_official';
    if (!barGroups.has(sourceCode)) barGroups.set(sourceCode, []);
    barGroups.get(sourceCode).push({
      instrumentId, tradeDate,
      open: finite(row.open), high: finite(row.high), low: finite(row.low), close,
      volume: finite(row.vol), amount: finite(row.amount),
    });
  });
  let written = 0;
  for (const [sourceCode, rows] of barGroups) {
    written += await repo.upsertDailyBarRows({ rows, sourceId: sources[sourceCode] || officialId });
  }
  return written;
}

/**
 * F-11：港股目标日多端点批量估值快照。
 * 先按已确认 fsTableType 分组调用官方单日快照（≤100 只/批，适配层内部再按端点分组），
 * 一次性落库目标日估值；随后逐证券核对返回行是否「同一目标日 + pb/total_mv 齐备」。
 * 只有通过核对的代码才允许跳过逐股序列；漏码/日期不符/字段不齐/未知类型仍留在缺口队列。
 * 返回 filledCodes（可视为目标日已补）、逐代码行数与适配层原始 gaps 证据。
 */
async function collectHkValuationSnapshot({ codes = [], asOfDate, fsTableTypeByCode = null, deps = {} } = {}) {
  const datasets = deps.datasets || require('../dataAccess/marketDatasets');
  const readSnapshot = deps.readValuationSnapshotDetailed || datasets.readValuationSnapshotDetailed;
  if (typeof readSnapshot !== 'function') return { supported: false };
  const unique = Array.from(new Set((codes || []).map(code => String(code || '').toUpperCase()).filter(Boolean)));
  if (!unique.length) {
    return { supported: true, filledCodes: new Set(), rowCountByCode: new Map(), rows: [], written: 0, gaps: {} };
  }
  let detail = null;
  try {
    detail = await readSnapshot({ codes: unique, tradeDate: asOfDate, fsTableTypes: fsTableTypeByCode, options: {} });
  } catch (error) {
    // 快照失败不阻断整批：返回 error 证据，由调用方回退逐股断档补采，不能把失败当"已补齐"。
    return {
      supported: true, error: String(error.message || error).slice(0, 320),
      filledCodes: new Set(), rowCountByCode: new Map(), rows: [], written: 0, gaps: {},
    };
  }
  if (!detail) {
    return { supported: true, filledCodes: new Set(), rowCountByCode: new Map(), rows: [], written: 0, gaps: {} };
  }
  const resolveInstruments = deps.resolveInstrumentsByCodes || repo.resolveInstrumentsByCodes;
  const metaRows = typeof resolveInstruments === 'function'
    ? await Promise.resolve(resolveInstruments({ market: 'HK', codes: unique })).catch(() => [])
    : [];
  const metaByCode = new Map((metaRows || []).map(row => [String(row.code || '').toUpperCase(), row]));
  const { rows, countByCode } = mapHkValuationSnapshotRows(detail.rows, metaByCode);
  let written = 0;
  if (rows.length) {
    const store = deps.store || require('./convertibleBondAnalysisStore');
    const sources = await (deps.sourceIds ? deps.sourceIds() : store.sourceIds());
    const officialId = sources && sources.lixinger_official;
    if (!officialId) {
      return {
        supported: true, error: 'valuation_source_missing',
        filledCodes: new Set(), rowCountByCode: countByCode, rows, written: 0, gaps: detail.gaps || {},
      };
    }
    const upsert = deps.upsertDailyValuationRows || repo.upsertDailyValuationRows;
    written = await upsert({ rows, sourceId: officialId });
  }
  const gaps = detail.gaps || {};
  const gapCodes = new Set([
    ...(gaps.missingCodes || []),
    ...(gaps.dateMismatchCodes || []),
    ...(gaps.fieldIncompleteCodes || []),
    ...(gaps.unknownTypeCodes || []),
  ].map(code => String(code || '').toUpperCase()));
  // 逐证券核对：同目标日且 pb/total_mv 齐备、且不在适配层 gaps 中，才视为目标日已补。
  const validCodes = new Set();
  (detail.rows || []).forEach(row => {
    const code = String((row && row.ts_code) || '').toUpperCase();
    if (!code || gapCodes.has(code) || !metaByCode.has(code)) return;
    if (normalizeTradeDate(row.trade_date) !== asOfDate) return;
    if (finite(row.pb) === null || finite(row.total_mv) === null) return;
    validCodes.add(code);
  });
  return {
    supported: true, filledCodes: validCodes, rowCountByCode: countByCode, rows, written,
    gaps, error: null,
    businessComplete: detail.businessComplete === true,
  };
}

/**
 * 港股目标池 = 恒生成分股 ∪ 港股通标的（2026-11-05 用户确认的范围）。
 *
 * 两个来源都走既有统一采集层：恒生成分用官方 `hk/index/constituents`，
 * 港股通用官方 `hk/company` 的 `isMutualMarketAhFlag`（实测一次返回 666 只，`mutualMarketFlag=true`）。
 * 合并去重后只返回规范代码；不写业务事实表，也不在这里判断"值不值得买"。
 * 任一来源取不到只让该来源缺席并记在返回里，不用旧名单补齐。
 */
async function resolveHkTargetPool({ asOfDate, fsTableTypes = ['non_financial', 'bank', 'insurance', 'security', 'reit', 'other_financial'] } = {}) {
  const { readIndexConstituents, readMutualMarketCompanies, readCompanyProfiles } = require('../dataAccess/marketDatasets');
  const merged = new Map();
  let constituents = [];
  let mutual = [];
  let constituentsError = null;
  let mutualError = null;
  let profileError = null;
  if (typeof readIndexConstituents === 'function') {
    try { constituents = (await readIndexConstituents({ indexCode: 'HSI', date: asOfDate })) || []; }
    catch (error) { constituentsError = String(error.message || error).slice(0, 200); }
  }
  if (typeof readMutualMarketCompanies === 'function') {
    try { mutual = (await readMutualMarketCompanies()) || []; }
    catch (error) { mutualError = String(error.message || error).slice(0, 200); }
  }
  constituents.forEach(row => {
    if (!row || !row.code) return;
    merged.set(row.code, { code: row.code, name: row.name || null, fsTableType: null, sources: ['hsi'] });
  });
  let mutualCount = 0;
  mutual.forEach(row => {
    if (!row || !row.code) return;
    // 只认官方明确的互联互通标记：false 或缺失都不算港股通标的。
    if (row.mutualMarketFlag === false) return;
    mutualCount += 1;
    const existing = merged.get(row.code);
    if (existing) {
      if (!existing.sources.includes('mutual_market')) existing.sources.push('mutual_market');
      if (!existing.name) existing.name = row.name || null;
      if (!existing.fsTableType) existing.fsTableType = row.fsTableType || null;
      return;
    }
    merged.set(row.code, {
      code: row.code, name: row.name || null, fsTableType: row.fsTableType || null, sources: ['mutual_market'],
    });
  });
  // 财报类型决定财报端点与指标口径，必须在入池前确认；指数成分不返回该字段，这里批量补查一次（≤100 只/次，有缓存）。
  const unknownType = Array.from(merged.values()).filter(row => !row.fsTableType).map(row => row.code);
  if (unknownType.length && typeof readCompanyProfiles === 'function') {
    try {
      const profiles = (await readCompanyProfiles({ codes: unknownType })) || [];
      profiles.forEach(profile => {
        const target = merged.get(profile.code);
        if (target && !target.fsTableType) target.fsTableType = profile.fsTableType || null;
      });
    } catch (error) {
      profileError = String(error.message || error).slice(0, 200);
    }
  }
  const rows = Array.from(merged.values());
  const overlap = rows.filter(row => row.sources.length > 1).length;
  // 只纳入财报口径已支持的类型：港股银行/保险/证券等金融口径的官方指标字典尚未接入，
  // 硬纳入只会让它们永远停在"财报待补"并阻断整批发布（2026-11-05 实测 non_financial/bank/insurance
  // 三个端点都拒收通用指标名）。排除项按类型计数回报，不让"少了一批人"看不见。
  const allowed = new Set((fsTableTypes || []).map(type => String(type)));
  const kept = rows.filter(row => row.fsTableType && allowed.has(row.fsTableType));
  const excludedByType = {};
  rows.filter(row => !row.fsTableType || !allowed.has(row.fsTableType)).forEach(row => {
    const key = row.fsTableType || 'unknown';
    excludedByType[key] = (excludedByType[key] || 0) + 1;
  });
  const excludedCount = rows.length - kept.length;
  const codes = kept.map(row => row.code);
  // 来源完整性（F05）：任一来源失败都会让"目标集合"缩水。缩水后的分母不能拿来说"已全部完成"，
  // 因此把失败来源单独列出来，由完成判定统一消费。
  const sourceErrors = [
    constituentsError ? { source: 'hsi', error: constituentsError } : null,
    mutualError ? { source: 'mutual_market', error: mutualError } : null,
    // 财报口径缺失会把目标误判成"按类型排除"，等于偷偷缩小分母。
    profileError ? { source: 'company_profile', error: profileError } : null,
  ].filter(Boolean);
  return {
    codes,
    // 目标集合指纹：同一目标日的范围摘要，供续跑与验收核对"还是不是同一件事"。
    targetSetHash: require('crypto').createHash('sha256').update([...codes].sort().join(',')).digest('hex'),
    hsiCount: constituents.length,
    mutualMarketCount: mutualCount,
    overlapCount: overlap,
    mergedCount: rows.length,
    excludedCount,
    excludedByType,
    fsTableTypes: Array.from(allowed),
    constituentsError,
    mutualError,
    profileError,
    sourceErrors,
    reason: kept.length ? undefined : (constituentsError || mutualError ? 'target_pool_sources_failed' : 'target_pool_empty'),
  };
}

/**
 * 目标池里「客观补不到」的标的分类（生产实证 2026-11-15）：
 * - 主档里根本没有：恒生成分含非股票资产，如 00823.HK 领展房产基金（REIT）；
 * - 曾经有行情、近 60 天完全没有：长期停牌/退市，如 2026-09-01 起集体停牌的微创系。
 * 判据沿用选股池既有的「近 60 天无行情即停止交易」口径；从未有过行情的新上市标的
 * 仍保留为真实待补，不把缺口伪装成完成。只分类，不取数、不写库。
 */
function classifyUnavailableHkCodes({ pending, metaByCode, everTraded, asOfDate }) {
  const excluded = [];
  const eligible = [];
  for (const code of pending || []) {
    const meta = metaByCode.get(code);
    if (!meta) { excluded.push({ code, reason: 'instrument_missing' }); continue; }
    const listingDate = dashDate(meta.list_date);
    if (asOfDate && listingDate && listingDate > asOfDate) {
      excluded.push({ code, reason: 'not_listed_on_target_date', listingDate });
      continue;
    }
    if (everTraded.has(code)) { excluded.push({ code, reason: 'no_recent_bars_suspended_or_delisted' }); continue; }
    eligible.push(code);
  }
  return { excluded, eligible };
}

/**
 * 港股目标池预补收盘价（2026-11-05）。
 *
 * 为什么必须先补行情再审计缺口：`loadUniverse` 只把"目标日前 60 天内有日线"的证券当成可评估对象，
 * 恒生成分股里绝大多数港股目前一天行情都没有，它们根本不会进入选股池 ——
 * 直接补估值会永远补不到对象上。所以港股补齐的顺序是：先在册成分补近一年收盘价，
 * 再走缺口审计补估值/财报/分红/行业。
 * 幂等：本地已有近 60 天行情的成分不再请求外部接口。
 */
async function syncHkTargetPoolBars({ asOfDate, maxCodes } = {}) {
  const pool = await resolveHkTargetPool({ asOfDate });
  const codes = pool.codes || [];
  const poolMeta = {
    hsiCount: pool.hsiCount, mutualMarketCount: pool.mutualMarketCount, overlapCount: pool.overlapCount,
    mergedCount: pool.mergedCount, excludedCount: pool.excludedCount, excludedByType: pool.excludedByType,
    fsTableTypes: pool.fsTableTypes,
    constituentsError: pool.constituentsError || null, mutualError: pool.mutualError || null,
    profileError: pool.profileError || null,
  };
  if (!codes.length) {
    return Object.assign({ codes: [], excludedUnavailable: [], targetSetHash: pool.targetSetHash || null, targetCount: 0, pending: 0, processed: 0, succeeded: 0, reason: pool.reason || 'target_pool_empty', results: [] }, poolMeta);
  }
  const covered = await repo.listCodesWithRecentBars({ codes, asOfDate, days: 60 });
  const pending = codes.filter(code => !covered.has(code));
  // 主档缺失（REIT 等非股票资产）与「曾有行情、近 60 天全无」的停牌/退市标的再取数也补不到，
  // 却会一直占住剩余量把补数槽锁死。这里只把这两类排除并留证；从未有过行情的新股仍是真实待补。
  const everTraded = pending.length
    ? await repo.listCodesWithRecentBars({ codes: pending, asOfDate, days: 3650 })
    : new Set();
  const metaByCode = new Map();
  for (const code of pending) {
    const meta = await readMeta(code);
    if (meta) metaByCode.set(code, meta);
  }
  const { excluded: excludedUnavailable, eligible: eligiblePending } =
    classifyUnavailableHkCodes({ pending, metaByCode, everTraded, asOfDate });
  const excludedCodes = new Set(excludedUnavailable.map(item => item.code));
  // 收敛后的清单同时供批后复核使用，避免「批前排除了、批后又算回来」。
  const eligibleCodes = codes.filter(code => !excludedCodes.has(code));
  const cap = Number.isFinite(Number(maxCodes)) && Number(maxCodes) > 0 ? Math.floor(Number(maxCodes)) : eligiblePending.length;
  const batch = eligiblePending.slice(0, cap);
  const { readStockDailySeries } = require('../dataAccess/marketDatasets');
  const store = require('./convertibleBondAnalysisStore');
  const sources = await store.sourceIds();
  const officialId = sources.lixinger_official;
  if (!officialId) {
    return Object.assign({ codes: eligibleCodes, excludedUnavailable, targetSetHash: pool.targetSetHash || null, targetCount: eligibleCodes.length, pending: eligiblePending.length, processed: 0, succeeded: 0, reason: 'valuation_source_missing', results: [] }, poolMeta);
  }
  const priceStart = dashDate(shiftYears(asOfDate, HK_PRICE_YEARS)) || asOfDate;
  const results = [];
  for (const code of batch) {
    try {
      const meta = await readMeta(code);
      const instrumentId = meta && meta.instrument_id ? Number(meta.instrument_id) : null;
      if (!instrumentId) { results.push({ code, ok: false, reason: 'instrument_missing' }); continue; }
      const rawBars = await readStockDailySeries({ tsCode: meta.ts_code, startDate: priceStart, endDate: asOfDate, market: 'hk' });
      const written = await writeHkBars({ rawBars, instrumentId, sources, officialId });
      results.push({ code, ok: written > 0, bars: written, reason: written > 0 ? undefined : 'bars_returned_empty' });
    } catch (error) {
      results.push({ code, ok: false, reason: 'bars_collect_failed', error: String(error.message || error).slice(0, 320) });
    }
  }
  return Object.assign({
    codes: eligibleCodes,
    excludedUnavailable,
    targetSetHash: pool.targetSetHash || null,
    targetCount: eligibleCodes.length,
    pending: eligiblePending.length,
    processed: batch.length,
    succeeded: results.filter(item => item.ok).length,
    results,
  }, poolMeta);
}

/**
 * 缺口队列的四维身份（B1-1）：market / asOfDate / strategyCode / inputVersion。
 * inputVersion 冻结当日股票池 artifact 内容哈希、策略与公式版本、港股目标池指纹——
 * 任一变化都说明"队列对应的计算输入已经不是同一件事"，必须批前重审；
 * 身份不变时续批直接消费冻结队列，不再每批跑两遍全市场审计。
 */
function hashJson(value) {
  return require('crypto').createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function strategyParamsOf(strategyCode) {
  if (strategyCode === 'investment_essentials_adapted_v2') return require('../domain/stockSelectionRulesV2').V2_PARAMS;
  if (strategyCode === 'graham_net_net_v1') return require('../domain/stockSelectionGrahamRules').GRAHAM_PARAMS;
  return require('../domain/stockSelectionRules').DEFAULT_PARAMS;
}

async function resolveQueueIdentity({ market, asOfDate, strategyCode, targetSetHash = null }) {
  let universeContentHash = null;
  try {
    const artifact = await repo.findUniverseArtifact({ market, targetDate: asOfDate });
    universeContentHash = artifact ? artifact.content_hash || null : null;
  } catch (_) { universeContentHash = null; }
  const code = strategyCode || require('./stockSelectionService').DEFAULT_STRATEGY_CODE || 'default';
  const params = strategyParamsOf(code);
  return {
    market,
    asOfDate,
    strategyCode: code,
    inputVersion: hashJson({
      universeContentHash,
      strategyCode: code,
      formulaVersion: (params && params.formulaVersion) || null,
      params: params || null,
      targetSetHash: targetSetHash || null,
    }),
  };
}

function sameQueueIdentity(left, right) {
  if (!left || !right) return false;
  return String(left.market || '') === String(right.market || '')
    && String(left.asOfDate || '') === String(right.asOfDate || '')
    && String(left.strategyCode || '') === String(right.strategyCode || '')
    && String(left.inputVersion || '') === String(right.inputVersion || '');
}

function emptyTiming() {
  return { targetPoolMs: 0, auditMs: 0, fetchMs: 0, persistMs: 0, targetedReauditMs: 0, finalAuditMs: 0 };
}

async function measure(timing, key, task) {
  const startedAt = Date.now();
  try { return await task(); } finally { timing[key] = (timing[key] || 0) + (Date.now() - startedAt); }
}

/**
 * 执行一次选股输入补齐。
 * @param {{market:'CN'|'HK', asOfDate:string, batchLimit?:number, strategyCode?:string, forceFullAudit?:boolean}} input
 */
async function syncSelectionInputs(input) {
  const service = require('./stockSelectionService');
  const market = String(input.market || '').toUpperCase();
  if (!['CN', 'HK'].includes(market)) {
    const error = new Error('市场参数不合法');
    error.status = 400;
    throw error;
  }
  const asOfDate = dashDate(input.asOfDate);
  if (!asOfDate) {
    const error = new Error('目标日参数不合法');
    error.status = 400;
    throw error;
  }
  const limit = Number.isFinite(Number(input.batchLimit)) && Number(input.batchLimit) > 0
    ? Math.floor(Number(input.batchLimit)) : 20;
  const strategyCode = input.strategyCode ? String(input.strategyCode).toLowerCase() : null;
  const timing = emptyTiming();
  // 上一次的续跑进度必须在审计**之前**读取（R3-02）：auditInputs 会把同一市场的
  // cursor_payload 整体替换掉（它只写本次审计结果），若在审计后再读，
  // 拿到的永远是刚被清空 lastRun 的新记录，失败轮转等于从未生效，
  // 全市场批次会被固定的失败前缀反复占满、后面的股票永远轮不到。
  let previouslyFailed = new Set();
  let priorAttempts = {};
  let priorPayload = {};
  try {
    const lastQueue = await repo.readInputGapQueue({ market });
    priorPayload = (lastQueue && lastQueue.cursor_payload && typeof lastQueue.cursor_payload === 'object')
      ? lastQueue.cursor_payload : {};
    const lastRun = (priorPayload && priorPayload.lastRun) || {};
    // failedCodes = 本次失败；deferredCodes = 返回了结果但缺口仍未解除（无进展也不能占着队首）。
    previouslyFailed = new Set([...(lastRun.failedCodes || []), ...(lastRun.deferredCodes || [])]);
    // attempts 是跨批次的尝试计数（R4-02）：只记上一批的失败会把更早的尝试记录丢掉。
    priorAttempts = lastRun.attempts && typeof lastRun.attempts === 'object' ? lastRun.attempts : {};
  } catch (_) { /* 读不到历史队列不影响本次补齐，只失去轮转顺序 */ }
  // 根盘安全余量（INC-0054 第一阶段第 3 条 / F-08）：低于停止线就暂停历史补采。
  // 必须在任何历史补采之前判定：港股目标池收盘价同样是一次历史行情补采，
  // 放在它后面会让"已暂停"的第一批港股行情照常发起请求并写库。
  // 仍照常审计并保存队列，剩余量如实回传，由外层标成 blocked——
  // 不能把「空间不够」当成「补齐了」，也不能每轮都硬着头皮再写一批。
  const space = await checkHistoryCollectionSpace();
  const historySuspended = space.suspended === true;
  // 港股先补齐"在册目标池"的近一年收盘价，再审计缺口：
  // 没有行情就不在选股池里，估值缺口也就无从补起（见 syncHkTargetPoolBars 注释）。
  // 低空间时跳过：暂停历史补采不能再先写一批港股目标池行情。
  let targetPool = null;
  if (market === 'HK' && !historySuspended) {
    try {
      targetPool = await measure(timing, 'targetPoolMs', () => syncHkTargetPoolBars({ asOfDate, maxCodes: limit }));
    } catch (error) {
      targetPool = { targetCount: 0, pending: 0, processed: 0, succeeded: 0, reason: 'target_pool_bars_failed', error: String(error.message || error).slice(0, 320) };
    }
  }
  // 队列身份（B1-1）：只有"没有冻结队列 / 四维身份变化 / 队列被标为需重审 / 显式强制全审"
  // 才批前跑一次全市场 auditInputs 重建队列；同身份续批直接消费冻结队列，批前零全市场扫描。
  const targetSetHash = targetPool ? (targetPool.targetSetHash || null) : null;
  const priorIdentity = priorPayload.queueIdentity || null;
  const identityBefore = await resolveQueueIdentity({ market, asOfDate, strategyCode, targetSetHash });
  const hasFrozenQueue = Array.isArray(priorPayload.gaps);
  const identityChanged = !sameQueueIdentity(priorIdentity, identityBefore);
  const forceFullAudit = input.forceFullAudit === true || input.forceAudit === true;
  const preAuditRequired = forceFullAudit || !hasFrozenQueue || priorPayload.needsReaudit === true || identityChanged;
  let auditMode = 'incremental';
  let queueGaps;
  let queueCoverage = priorPayload.coverage || null;
  let queueQuality = priorPayload.quality || null;
  let queueUniverseCount = priorPayload.universeCount === undefined ? null : priorPayload.universeCount;
  let frozenIdentity = identityBefore;
  if (preAuditRequired) {
    const audit = await measure(timing, 'auditMs', () => service.auditInputs({
      market, asOfDate, strategyCode: strategyCode || undefined,
    }));
    queueGaps = Array.isArray(audit.gaps) ? audit.gaps : [];
    queueCoverage = audit.coverage || queueCoverage;
    queueQuality = audit.quality || queueQuality;
    queueUniverseCount = audit.coverage ? audit.coverage.universeCount : queueUniverseCount;
    auditMode = 'full';
    // 全市场审计可能首次固化当日 artifact：身份必须按审计后的输入重算，否则下次续批
    // 会把"artifact 从无到有"当成身份变化、每次重新全审。
    frozenIdentity = await resolveQueueIdentity({ market, asOfDate, strategyCode, targetSetHash });
  } else {
    // 冻结队列原样消费（深拷贝避免原地修改上一份载荷）。
    queueGaps = JSON.parse(JSON.stringify(priorPayload.gaps));
  }
  const { financial: fundamental, industry, valuation, unclassified } = classifyGaps(queueGaps);
  const industryQueue = orderByAttempts(industry, priorAttempts, previouslyFailed);
  const fundamentalQueue = orderByAttempts(fundamental, priorAttempts, previouslyFailed);
  // 统一批次配额（F-08）：行业优先占额，剩余名额依次分配给财报与港股估值。
  // 同一只证券即使同时命中多个域也只占 1 个证券名额（各域仍各自取数），
  // 保证最终去重后的本批处理证券数不超过 batchLimit，而不是每个域各自 slice(0, limit)。
  const batchCodes = new Set();
  const takeWithinLimit = queue => {
    const picked = [];
    for (const gap of queue) {
      const key = String(gap.code || '').toUpperCase();
      if (batchCodes.has(key)) { picked.push(gap); continue; }
      if (batchCodes.size >= limit) continue;
      batchCodes.add(key);
      picked.push(gap);
    }
    return picked;
  };
  // 行业分类先补：一次取数就能补齐一条完整路径，成本低，且它是"能否发布正式组合"的阻断项，
  // 不能被财报批次挤掉。
  const industryBatch = historySuspended ? [] : takeWithinLimit(industryQueue);
  const industryResults = [];
  for (const gap of industryBatch) {
    try {
      industryResults.push(await measure(timing, 'fetchMs', () => collectIndustryOne(gap, market)));
    } catch (error) {
      industryResults.push({ code: gap.code, ok: false, reason: 'industry_collect_failed', error: String(error.message || error).slice(0, 320) });
    }
  }
  const batch = historySuspended ? [] : takeWithinLimit(fundamentalQueue);
  // B2-2：补采前批量解析 fsTableType（本地主档/近期财报优先，缺失才 ≤100 只/批查官方档案），
  // 不再在 collectOne 里逐股查档案。
  const financialFsTableTypes = await resolveBatchFsTableTypes({
    codes: batch.map(gap => gap.code), deps: input.deps || {},
  });
  const results = [];
  const runContext = input.runContext && typeof input.runContext === 'object' ? input.runContext : null;
  // F-14：把本批"已批量核对过档案"的代码集合下沉给 collectOne，避免同一只港股重复单只查档案。
  const financialFsTableTypeChecked = new Set(batch.map(gap => String(gap.code || '').toUpperCase()));
  for (const gap of batch) {
    try {
      results.push(await measure(timing, 'fetchMs', () => collectOne(
        gap, asOfDate, runContext,
        { fsTableTypeByCode: financialFsTableTypes, fsTableTypeChecked: financialFsTableTypeChecked }, timing,
      )));
    } catch (error) {
      // 单只失败不阻断整批：失败原因留在结果里，剩余对象继续等下一次续跑。
      results.push({ code: gap.code, ok: false, reason: 'collect_failed', error: String(error.message || error).slice(0, 320) });
    }
  }
  // 港股估值/收盘价：A 股有共享行情任务，港股没有，缺口会永远悬着（2026-11-05 生产实证：
  // 港股 daily_valuations 全历史 0 行）。因此只在港股补，A 股的 valuation 缺口仍如实记为剩余。
  const valuationBatch = (historySuspended || market !== 'HK') ? [] : takeWithinLimit(orderByAttempts(valuation, priorAttempts, previouslyFailed));
  const valuationFsTableTypes = await resolveBatchFsTableTypes({
    codes: valuationBatch.map(gap => gap.code), deps: input.deps || {},
  });
  const valuationResults = [];
  let valuationSnapshot = null;
  const valuationSeriesGaps = [];
  if (valuationBatch.length) {
    // F-11：先按已确认 fsTableType 做目标日多端点批量快照，一次性补齐当日估值；
    // 只有快照缺失/字段不齐或确有历史窗口断档的标的，才回退逐股断档序列（受 batchLimit 约束）。
    const knownCodes = valuationBatch
      .filter(gap => valuationFsTableTypes.get(String(gap.code || '').toUpperCase()))
      .map(gap => gap.code);
    if (knownCodes.length) {
      try {
        valuationSnapshot = await measure(timing, 'fetchMs', () => collectHkValuationSnapshot({
          codes: knownCodes, asOfDate, fsTableTypeByCode: valuationFsTableTypes, deps: input.deps || {},
        }));
      } catch (error) {
        valuationSnapshot = {
          supported: true, error: String(error.message || error).slice(0, 320),
          filledCodes: new Set(), rowCountByCode: new Map(),
        };
      }
    }
    const filled = valuationSnapshot && valuationSnapshot.filledCodes instanceof Set
      ? valuationSnapshot.filledCodes : new Set();
    const rowCountByCode = valuationSnapshot && valuationSnapshot.rowCountByCode instanceof Map
      ? valuationSnapshot.rowCountByCode : new Map();
    const snapshotUsable = valuationSnapshot && valuationSnapshot.supported !== false && !valuationSnapshot.error;
    for (const gap of valuationBatch) {
      const code = String(gap.code || '').toUpperCase();
      const fsType = valuationFsTableTypes.get(code) || null;
      // 未知类型不硬发非金融端点，保留缺口等档案核对。
      if (!fsType) {
        valuationResults.push({ code: gap.code, ok: false, reason: 'financial_type_unknown' });
        continue;
      }
      // 快照已补齐目标日且缺口不含历史窗口断档 → 不再逐股拉序列。
      if (snapshotUsable && filled.has(code) && !needsHistoricalValuation(gap)) {
        valuationResults.push({
          code: gap.code, ok: true, reason: 'valuation_snapshot_filled',
          valuations: Number(rowCountByCode.get(code) || 1), bars: 0,
        });
        continue;
      }
      // 快照不可用（失败/缺函数）或该标的仍需历史/行情断档 → 回退逐股断档补采。
      valuationSeriesGaps.push(gap);
    }
    for (const gap of valuationSeriesGaps) {
      try {
        valuationResults.push(await measure(timing, 'fetchMs', () => collectHkMarketData(
          gap, asOfDate, timing, { fsTableTypeByCode: valuationFsTableTypes },
        )));
      } catch (error) {
        valuationResults.push({ code: gap.code, ok: false, reason: 'valuation_collect_failed', error: String(error.message || error).slice(0, 320) });
      }
    }
  }
  const attempted = results.concat(industryResults, valuationResults);
  const attemptedCodes = [...new Set(attempted.map(item => item.code))];
  // 续批定点复核（B1-1）：只对本批对象重读事实与规则，不再跑全市场 auditInputs。
  // 只有"本批对象仍在可评估池"时才能用复核结论删除缺口；不在池内的代码
  // （例如港股尚未补到行情、loadUniverse 分母里没有它）必须保留原缺口，不能当成已补齐。
  let targeted = { gaps: [], evaluatedCodes: [] };
  let targetedFailed = false;
  if (attemptedCodes.length) {
    try {
      targeted = await measure(timing, 'targetedReauditMs', () => service.auditInputsForCodes({
        market, asOfDate, strategyCode: strategyCode || undefined, codes: attemptedCodes,
      })) || { gaps: [], evaluatedCodes: [] };
    } catch (error) {
      targetedFailed = true;
      targeted = { gaps: [], evaluatedCodes: [], error: String(error.message || error).slice(0, 320) };
    }
  }
  const evaluatedCodes = new Set((targeted.evaluatedCodes || []).map(code => String(code || '').toUpperCase()));
  const targetedGapByCode = new Map((targeted.gaps || []).map(gap => [String(gap.code || '').toUpperCase(), gap]));
  // 原地合并：已核实解除 → 删除；仍有缺口 → 用定点复核结果替换；无法评估 → 保留原项。
  const mergedGaps = new Map(queueGaps.map(gap => [String(gap.code || '').toUpperCase(), gap]));
  if (!targetedFailed) {
    for (const code of attemptedCodes) {
      const key = String(code || '').toUpperCase();
      const refreshed = targetedGapByCode.get(key);
      if (refreshed) mergedGaps.set(key, refreshed);
      else if (evaluatedCodes.has(key)) mergedGaps.delete(key);
    }
  }
  let queueAfter = Array.from(mergedGaps.values());
  // 目标池批后复核（F05）。
  // 修复前完成判定只数 auditInputs 的缺口，而 auditInputs 的分母是 loadUniverse（只含近 60 天
  // 有行情的证券）：目标池里"还没补到行情"的股票根本不在分母里，于是 3 只目标只处理 1 只也能
  // 返回 succeeded/gapCount=0，续批直接停掉。这里对冻结的目标清单重新算一次真实剩余差集。
  const targetPoolAfter = market === 'HK' ? await auditHkTargetPoolAfterBatch(targetPool, asOfDate) : null;
  const targetPoolPending = targetPoolAfter && Array.isArray(targetPoolAfter.pendingCodes)
    ? targetPoolAfter.pendingCodes.length : 0;
  // 来源失败/口径缺失不得靠"分母变小"过关；空目标必须有完整取证。
  const targetPoolSourceFailed = Boolean(targetPool && (
    (Array.isArray(targetPool.sourceErrors) && targetPool.sourceErrors.length)
    || ['target_pool_sources_failed', 'target_pool_bars_failed', 'valuation_source_missing'].includes(String(targetPool.reason || ''))
  ));
  const targetPoolUnaudited = market === 'HK' && !targetPool;
  const targetPoolIncomplete = targetPoolSourceFailed || targetPoolPending > 0
    || targetPoolUnaudited || Boolean(targetPoolAfter && targetPoolAfter.error);
  let remaining = classifyGaps(queueAfter);
  let blockingRemaining = remaining.fundamental.length + remaining.industry.length
    + remaining.valuation.length + remaining.unclassified.length;
  // 清零门禁（B1-1）：原地更新后剩余量归零，只是"本批看到的队列"归零。
  // 宣告 cleared 之前必须跑一次完整全市场 auditInputs 终审；终审发现新缺口就回写最新队列并保持 partial，
  // 绝不凭局部计数误报完成。唯一例外是批前刚做过全市场全审且本批 0 标的（见下）。
  let finalAudit = null;
  let finalAuditFailed = false;
  // 批前刚做过全市场全审、且本批没有处理任何标的时，队列内容就是那次全审的结论；
  // 0 变更下再跑一遍全市场终审没有新信息，只会白扫一遍全市场（B1-1 基线单次约 197s）。
  // 反向条件必须保留：增量续批（批前未全审）或本批改动过数据后剩余归零时，终审仍是完成前提。
  const finalAuditCoveredByPreAudit = auditMode === 'full' && attemptedCodes.length === 0;
  let queueCoverageFinal = queueCoverage;
  let queueQualityFinal = queueQuality;
  let queueUniverseCountFinal = queueUniverseCount;
  if (!finalAuditCoveredByPreAudit
      && blockingRemaining === 0 && !targetPoolIncomplete && !targetedFailed && !historySuspended) {
    try {
      finalAudit = await measure(timing, 'finalAuditMs', () => service.auditInputs({
        market, asOfDate, strategyCode: strategyCode || undefined,
      }));
      queueAfter = Array.isArray(finalAudit.gaps) ? finalAudit.gaps : [];
      queueCoverageFinal = finalAudit.coverage || queueCoverageFinal;
      queueQualityFinal = finalAudit.quality || queueQualityFinal;
      queueUniverseCountFinal = finalAudit.coverage ? finalAudit.coverage.universeCount : queueUniverseCountFinal;
      remaining = classifyGaps(queueAfter);
      blockingRemaining = remaining.fundamental.length + remaining.industry.length
        + remaining.valuation.length + remaining.unclassified.length;
    } catch (error) {
      // 终审失败无法证明"全市场已清零"：不能报完成，保留队列等待下一次续批。
      finalAuditFailed = true;
      finalAudit = { error: String(error.message || error).slice(0, 320) };
    }
  }
  const failedResults = attempted.filter(item => !item.ok);
  const remainingCodes = new Set(queueAfter.map(gap => String(gap.code || '').toUpperCase()));
  const failedCodes = failedResults.map(item => item.code);
  // 本批"跑完了但缺口仍未解除"的对象同样要排到队尾（R3-02）：只轮转抛错对象时，
  // 一批"能返回数据但补不齐"的股票会稳稳占住队首，后面的对象永远轮不到。
  const deferredCodes = [...new Set(attempted
    .map(item => item.code)
    .filter(code => remainingCodes.has(String(code || '').toUpperCase()) && !failedCodes.includes(code)))];
  // 本批被尝试过的对象都要累加计数（不论成功与否）：这是"谁还没轮到"的唯一依据。
  const nextAttempts = Object.assign({}, priorAttempts);
  attempted.forEach(item => {
    nextAttempts[item.code] = Number(nextAttempts[item.code] || 0) + 1;
  });
  // 本批实际解除的队列缺口数：批前有缺口、批后权威队列里已不存在。
  const queueCodesBefore = new Set(queueGaps.map(gap => String(gap.code || '').toUpperCase()));
  const queueGapsCleared = attemptedCodes
    .filter(code => queueCodesBefore.has(String(code || '').toUpperCase()) && !remainingCodes.has(String(code || '').toUpperCase()))
    .length;
  // 队列里同时保留：补齐摘要 + 补齐后仍待补的对象明细（明细来自定点复核/终审，不是本批结果倒推）。
  const queuePayload = {
    market,
    asOfDate,
    generatedAt: new Date().toISOString(),
    // 冻结队列身份：下次续批据四维键判断能否直接消费本队列。
    queueIdentity: frozenIdentity,
    // 本批复核失败/终审失败时置位：下次批前强制全市场重审，避免用过期队列继续续批。
    needsReaudit: Boolean(targetedFailed || finalAuditFailed || priorPayload.needsReaudit === true && auditMode !== 'full'),
    auditMode,
    universeCount: queueUniverseCountFinal,
    gapCount: queueAfter.length,
    domainCounts: domainCountsOfGaps(queueAfter),
    coverage: queueCoverageFinal,
    quality: queueQualityFinal,
    gaps: queueAfter,
    truncated: false,
    lastRun: {
      // 分阶段耗时：基线剖析与"续批是否还在扫全市场"的验收证据。
      timing,
      auditMode,
      queueIdentity: frozenIdentity,
      targeted: {
        codes: attemptedCodes.length,
        evaluated: evaluatedCodes.size,
        cleared: queueGapsCleared,
        failed: targetedFailed,
      },
      finalAudit: {
        performed: Boolean(finalAudit && !finalAudit.error),
        failed: finalAuditFailed,
        skippedByPreAudit: finalAuditCoveredByPreAudit,
        gapCount: finalAudit && Array.isArray(finalAudit.gaps) ? finalAudit.gaps.length : null,
        error: finalAudit && finalAudit.error ? finalAudit.error : null,
      },
      processed: results.length,
      succeeded: results.filter(item => item.ok).length,
      failed: results.filter(item => !item.ok).length,
      industryProcessed: industryResults.length,
      industrySucceeded: industryResults.filter(item => item.ok).length,
      // 估值补齐只在港股执行；A 股仍如实记为剩余（等共享行情任务）。
      valuationProcessed: valuationResults.length,
      valuationSucceeded: valuationResults.filter(item => item.ok).length,
      valuationRows: valuationResults.reduce((sum, item) => sum + Number(item.valuations || 0), 0),
      valuationBars: valuationResults.reduce((sum, item) => sum + Number(item.bars || 0), 0),
      // F-11 证据：目标日多端点快照确实被调用、命中/写入/仍需序列的代码数量与适配层 gaps，
      // 用于证明日常只缺目标日估值时没有逐股拉 11 年序列。
      valuationSnapshot: valuationSnapshot ? {
        supported: valuationSnapshot.supported !== false,
        filled: valuationSnapshot.filledCodes instanceof Set ? valuationSnapshot.filledCodes.size : 0,
        written: Number(valuationSnapshot.written || 0),
        seriesCodes: valuationSeriesGaps.length,
        gaps: valuationSnapshot.gaps || null,
        error: valuationSnapshot.error || null,
      } : null,
      targetPool: targetPool ? Object.assign({}, targetPool, {
        // 批后真实剩余（不是批前统计），并给出未处理对象明细供续跑核对。
        pendingAfter: targetPoolPending,
        pendingAfterCodes: targetPoolAfter && targetPoolAfter.pendingCodes ? targetPoolAfter.pendingCodes.slice(0, 200) : [],
        pendingAfterTruncated: Boolean(targetPoolAfter && targetPoolAfter.pendingCodes && targetPoolAfter.pendingCodes.length > 200),
        sourceErrors: targetPool.sourceErrors || [],
        targetSetHash: targetPool.targetSetHash || null,
      }) : null,
      targetPoolPending,
      targetPoolSourceFailed,
      targetPoolUnaudited,
      targetPoolIncomplete,
      remainingFundamental: remaining.fundamental.length,
      remainingFinancial: remaining.fundamental.length,
      remainingIndustry: remaining.industry.length,
      remainingValuation: remaining.valuation.length,
      remainingUnclassified: remaining.unclassified.length,
      valuationCodes: remaining.valuation.slice(0, 200).map(item => item.code),
      // 失败代码持久化：下次批次据此轮转到队尾，保证剩余对象不会被同一前缀一直挡住。
      failedCodes: failedCodes.slice(0, 500),
      deferredCodes: deferredCodes.slice(0, 500),
      // 本次被尝试过的对象计数 +1（跨批次累加，清空后自动丢弃），下次批次按次数最少优先。
      attempts: pruneAttempts(nextAttempts, remainingCodes),
      failedReasons: failedResults.slice(0, 50).map(item => ({ code: item.code, reason: item.reason || 'unknown' })),
      // 暂停证据：空间不足时本轮不采集，剩余量保持真实值，不能记成完成。
      historySuspended,
      disk: historySuspended ? space : null,
    },
  };
  await repo.saveInputGapQueue({ market, payload: queuePayload });
  // 完成判定（R2-04）：本任务能补的（财报/分红/行业）与不能补但必需的（估值）都必须清空；
  // 未识别的缺口也不允许当完成。处理 0 个而仍有缺口时更不能报 succeeded。
  // B1-1：blockingRemaining 已按"定点复核 + 清零终审"后的权威队列计算；终审失败或定点复核失败
  // 都不能宣告完成（无法证明全市场已清零）。
  // F-06：完成还必须有本轮的有效全市场终审证据（或批前全审且本批 0 标的的等价证据），
  // 且本轮不能处于低磁盘暂停状态——低磁盘空队列只是"没补"，不是"补齐了"。
  const hasFullAuditEvidence = Boolean((finalAudit && !finalAudit.error) || finalAuditCoveredByPreAudit);
  const cleared = blockingRemaining === 0 && !targetPoolIncomplete && !finalAuditFailed
    && !targetedFailed && !historySuspended && hasFullAuditEvidence;
  const unclassifiedBlocked = remaining.unclassified.length > 0;
  const valuationBlocked = remaining.valuation.length > 0;
  const processedAny = results.length + industryResults.length + valuationResults.length > 0
    || Boolean(targetPool && targetPool.processed)
    || Boolean(finalAudit && !finalAudit.error);
  // 来源失败属于"客观阻塞"，要等来源恢复，不能靠继续续批碰运气；
  // 仍有可补目标（未补到行情）是 partial，续批继续处理。
  const status = cleared ? 'succeeded'
    : historySuspended ? 'blocked'
      : finalAuditFailed ? 'blocked'
        : (targetPoolSourceFailed || targetPoolUnaudited) ? 'blocked'
          : (!hasFullAuditEvidence && blockingRemaining === 0 && !targetPoolIncomplete && !targetedFailed) ? 'blocked'
            : (!processedAny && targetPoolPending === 0 ? 'blocked' : 'partial');
  const reason = cleared ? undefined
    : historySuspended ? 'root_disk_low'
      : finalAuditFailed ? 'selection_inputs_final_audit_failed'
        : (targetPoolSourceFailed || targetPoolUnaudited) ? 'selection_target_pool_sources_failed'
          : targetPoolPending > 0 ? 'selection_target_pool_pending'
            : (!hasFullAuditEvidence && blockingRemaining === 0) ? 'selection_inputs_final_audit_missing'
              : unclassifiedBlocked ? 'selection_gap_unclassified'
                : valuationBlocked && blockedOnlyByValuation(remaining) ? 'remaining_valuation_gap'
                  : 'selection_inputs_gaps_pending';
  return {
    ok: cleared,
    status,
    reason,
    // 暂停历史补采的证据：外层据此标 blocked 并停止续批，而不是当作失败反复重试。
    historySuspended,
    disk: historySuspended ? space : null,
    market,
    asOfDate,
    processed: results.length,
    succeeded: queuePayload.lastRun.succeeded,
    failed: queuePayload.lastRun.failed,
    industryProcessed: queuePayload.lastRun.industryProcessed,
    industrySucceeded: queuePayload.lastRun.industrySucceeded,
    valuationProcessed: queuePayload.lastRun.valuationProcessed,
    valuationSucceeded: queuePayload.lastRun.valuationSucceeded,
    valuationRows: queuePayload.lastRun.valuationRows,
    valuationBars: queuePayload.lastRun.valuationBars,
    targetPool,
    // 目标池剩余量单独暴露，供上层续批止损把"未补到行情的目标"也算进剩余工作。
    remainingTargetPool: targetPoolPending,
    targetPoolSourceFailed,
    targetPoolIncomplete,
    targetSetHash: targetPool ? (targetPool.targetSetHash || null) : null,
    remainingFundamental: queuePayload.lastRun.remainingFundamental,
    remainingFinancial: queuePayload.lastRun.remainingFinancial,
    remainingIndustry: queuePayload.lastRun.remainingIndustry,
    remainingValuation: queuePayload.lastRun.remainingValuation,
    remainingUnclassified: queuePayload.lastRun.remainingUnclassified,
    gapCount: queuePayload.gapCount,
    domainCounts: queuePayload.domainCounts,
    coverage: queueCoverageFinal,
    auditMode,
    queueIdentity: frozenIdentity,
    timing,
    finalAuditPerformed: Boolean(finalAudit && !finalAudit.error),
    // 本批实际尝试的证券（跨域去重后），用于核验统一配额没有超限。
    attemptedCodes: attemptedCodes.slice(0, 200),
    batchResults: results.slice(0, 50),
    industryResults: industryResults.slice(0, 50),
  };
}

// 批后复核目标池（F05）：对冻结的目标清单重新算"目标日前 60 天内有没有行情"，
// 得出真实剩余差集。不能直接把批前的 targetPool.pending 相加冒充最终剩余。
async function auditHkTargetPoolAfterBatch(targetPool, asOfDate) {
  const codes = targetPool && Array.isArray(targetPool.codes) ? targetPool.codes : [];
  if (!codes.length) return { pendingCodes: [], coveredCount: 0, targetCount: 0 };
  try {
    const covered = await repo.listCodesWithRecentBars({ codes, asOfDate, days: 60 });
    const pendingCodes = codes.filter(code => !covered.has(code));
    return { targetCount: codes.length, coveredCount: codes.length - pendingCodes.length, pendingCodes };
  } catch (error) {
    // 复核失败不等于"没有剩余"：按未知处理，完成判定一律不放行。
    return { error: String(error.message || error).slice(0, 320), pendingCodes: [] };
  }
}

// 只剩估值缺口时给出专门原因，便于任务面板区分"等共享行情"与"还有别的缺口在补"。
function blockedOnlyByValuation(remaining) {
  return remaining.fundamental.length === 0 && remaining.industry.length === 0
    && remaining.unclassified.length === 0 && remaining.valuation.length > 0;
}

module.exports = {
  syncSelectionInputs, collectOne, collectIndustryOne, classifyGaps, collectionWindowOf, REPORT_KINDS, HISTORY_YEARS,
  collectHkMarketData, syncHkTargetPoolBars, resolveHkTargetPool, writeHkBars,
  collectHkValuationSnapshot, needsHistoricalValuation,
  classifyUnavailableHkCodes,
  resolveBatchFsTableTypes, missingDateSegments,
};

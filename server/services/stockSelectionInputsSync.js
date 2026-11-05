// 投资策略选股中心：选股输入补齐（SSV-01）。
// 只做两件事：①把"应补未补"的对象按市场/目标日冻结成可续跑队列；②逐公司调用**既有**数据访问层与
// 既有标准层写入入口（persistCollectedData）把财报与分红补进原表。
// 不新建第二套采集链、不自己拼 HTTP、不写平行事实表。
// 估值与行情：A 股仍由共享行情任务负责（本任务只记剩余）；**港股没有这条共享链路**，
// 港股估值缺口由本任务的 collectHkMarketData 补（数据层已支持 hk 端点，写入同为 daily_valuations/daily_bars）。
'use strict';

const { persistCollectedData } = require('./financialDataArchitecture');
const repo = require('../repositories/stockSelectionRepository');
const { upsertIndustryPath } = require('../repositories/industryRepository');

// 财报历史要覆盖"最新一年 + 此前十年"（方案 5.2 的 11 个完整财年），再往前留一年缓冲。
const HISTORY_YEARS = 12;
const REPORT_KINDS = ['income', 'balance', 'cashflow', 'indicator'];
// 港股估值要覆盖十年 PB 窗口（R02），再留一年缓冲；收盘价只需覆盖近一年（R04 分母 + 60 天窗口判定）。
const HK_VALUATION_YEARS = 11;
const HK_PRICE_YEARS = 1;

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

/**
 * 单只证券补财报 + 分红：数据层负责主备来源与字段归一，persistCollectedData 负责落原表与原始留证。
 * 港股与 A 股走同一条链路，只在数据层内部按代码后缀选择官方端点（见 lixingerDatasetAdapter）。
 */
async function collectOne(gap, asOfDate) {
  const meta = await readMeta(gap.code);
  if (!meta) return { code: gap.code, ok: false, reason: 'instrument_missing' };
  const startDate = dashDate(shiftYears(asOfDate, HISTORY_YEARS)) || '2000-01-01';
  const { readFinancialReportRows, readDividendRows } = require('../dataAccess/marketDatasets');
  const bundle = {};
  let anyFinancial = false;
  const financial = await readFinancialReportRows({ tsCode: meta.ts_code, kinds: REPORT_KINDS, startDate, endDate: asOfDate });
  if (financial) {
    if (Array.isArray(financial.income) && financial.income.length) { bundle.income = financial.income; anyFinancial = true; }
    if (Array.isArray(financial.balance) && financial.balance.length) { bundle.balance = financial.balance; anyFinancial = true; }
    if (Array.isArray(financial.cashflow) && financial.cashflow.length) { bundle.cashflow = financial.cashflow; anyFinancial = true; }
    if (Array.isArray(financial.indicator) && financial.indicator.length) { bundle.indicators = financial.indicator; anyFinancial = true; }
  }
  const dividends = await readDividendRows({ tsCode: meta.ts_code, startDate, endDate: asOfDate });
  if (Array.isArray(dividends) && dividends.length) bundle.dividends = dividends;
  if (!anyFinancial && !bundle.dividends) {
    // 官方返回空 = 本次没有可入库的新事实；不能当成"已补齐"，也不覆盖旧数据。
    return { code: gap.code, ok: false, reason: 'source_returned_empty' };
  }
  await persistCollectedData({
    ts_code: meta.ts_code,
    name: meta.name,
    market: meta.market,
    list_date: meta.list_date,
    data: meta.raw_data || {},
  }, bundle);
  return {
    code: gap.code,
    ok: true,
    financials: anyFinancial,
    dividends: Boolean(bundle.dividends),
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
 * 港股单只补估值序列 + 收盘价（A 股不走这里，仍等共享行情任务）。
 *
 * 数据层 `readStockValuationSeriesBatch` / `readStockDailySeries` 已按代码后缀分流到官方港股端点，
 * 本函数只做两件事：把数据层给的原有链路口径换算成标准层口径，再幂等落库。
 * 口径：数据层港股行沿用 `hkValuationRow` 的 `dv_ttm` 百分数点、`total_mv` 万元；
 * 标准层统一为小数股息率与「元」总市值，币种随行写入 HKD。
 * 官方分段取数部分失败时，已取到的行照常落库，剩余区间留给下一批，不用空值覆盖旧行。
 */
async function collectHkMarketData(gap, asOfDate) {
  const meta = await readMeta(gap.code);
  if (!meta) return { code: gap.code, ok: false, reason: 'instrument_missing' };
  const instrumentId = meta.instrument_id === null || meta.instrument_id === undefined ? null : Number(meta.instrument_id);
  if (!instrumentId) return { code: gap.code, ok: false, reason: 'instrument_id_missing' };
  const { readStockValuationSeriesBatch, readStockDailySeries } = require('../dataAccess/marketDatasets');
  const store = require('./convertibleBondAnalysisStore');
  const sources = await store.sourceIds();
  const officialId = sources.lixinger_official;
  if (!officialId) return { code: gap.code, ok: false, reason: 'valuation_source_missing' };

  const valuationStart = dashDate(shiftYears(asOfDate, HK_VALUATION_YEARS)) || '2000-01-01';
  const priceStart = dashDate(shiftYears(asOfDate, HK_PRICE_YEARS)) || valuationStart;
  let rawValuations = [];
  let partial = false;
  try {
    rawValuations = await readStockValuationSeriesBatch({
      codes: [meta.ts_code], startDate: valuationStart, endDate: asOfDate,
    });
  } catch (error) {
    if (Array.isArray(error && error.partialRows)) {
      rawValuations = error.partialRows;
      partial = true;
    } else throw error;
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
  const valuationWritten = await repo.upsertDailyValuationRows({ rows: valuations, sourceId: officialId });

  const rawBars = await readStockDailySeries({
    tsCode: meta.ts_code, startDate: priceStart, endDate: asOfDate, market: 'hk',
  });
  const barWritten = await writeHkBars({
    rawBars, instrumentId, sources, officialId,
  });

  const ok = valuationWritten > 0 || barWritten > 0;
  return {
    code: gap.code,
    ok,
    reason: ok ? undefined : 'projection_returned_empty',
    valuations: valuationWritten,
    bars: barWritten,
    partial,
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
 * 港股目标池 = 恒生成分股 ∪ 港股通标的（2026-11-05 用户确认的范围）。
 *
 * 两个来源都走既有统一采集层：恒生成分用官方 `hk/index/constituents`，
 * 港股通用官方 `hk/company` 的 `isMutualMarketAhFlag`（实测一次返回 666 只，`mutualMarketFlag=true`）。
 * 合并去重后只返回规范代码；不写业务事实表，也不在这里判断"值不值得买"。
 * 任一来源取不到只让该来源缺席并记在返回里，不用旧名单补齐。
 */
async function resolveHkTargetPool({ asOfDate, fsTableTypes = ['non_financial'] } = {}) {
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
  return {
    codes: kept.map(row => row.code),
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
    reason: kept.length ? undefined : (constituentsError || mutualError ? 'target_pool_sources_failed' : 'target_pool_empty'),
  };
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
    return Object.assign({ targetCount: 0, pending: 0, processed: 0, succeeded: 0, reason: pool.reason || 'target_pool_empty', results: [] }, poolMeta);
  }
  const covered = await repo.listCodesWithRecentBars({ codes, asOfDate, days: 60 });
  const pending = codes.filter(code => !covered.has(code));
  const cap = Number.isFinite(Number(maxCodes)) && Number(maxCodes) > 0 ? Math.floor(Number(maxCodes)) : pending.length;
  const batch = pending.slice(0, cap);
  const { readStockDailySeries } = require('../dataAccess/marketDatasets');
  const store = require('./convertibleBondAnalysisStore');
  const sources = await store.sourceIds();
  const officialId = sources.lixinger_official;
  if (!officialId) {
    return Object.assign({ targetCount: codes.length, pending: pending.length, processed: 0, succeeded: 0, reason: 'valuation_source_missing', results: [] }, poolMeta);
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
    targetCount: codes.length,
    pending: pending.length,
    processed: batch.length,
    succeeded: results.filter(item => item.ok).length,
    results,
  }, poolMeta);
}

/**
 * 执行一次选股输入补齐。
 * @param {{market:'CN'|'HK', asOfDate:string, batchLimit?:number}} input
 * @param {{targetPool?:{codes:string[]}}} [options]
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
  // 上一次的续跑进度必须在审计**之前**读取（R3-02）：auditInputs 会把同一市场的
  // cursor_payload 整体替换掉（它只写本次审计结果），若在审计后再读，
  // 拿到的永远是刚被清空 lastRun 的新记录，失败轮转等于从未生效，
  // 全市场批次会被固定的失败前缀反复占满、后面的股票永远轮不到。
  let previouslyFailed = new Set();
  let priorAttempts = {};
  try {
    const lastQueue = await repo.readInputGapQueue({ market });
    const lastRun = (lastQueue && lastQueue.cursor_payload && lastQueue.cursor_payload.lastRun) || {};
    // failedCodes = 本次失败；deferredCodes = 返回了结果但缺口仍未解除（无进展也不能占着队首）。
    previouslyFailed = new Set([...(lastRun.failedCodes || []), ...(lastRun.deferredCodes || [])]);
    // attempts 是跨批次的尝试计数（R4-02）：只记上一批的失败会把更早的尝试记录丢掉。
    priorAttempts = lastRun.attempts && typeof lastRun.attempts === 'object' ? lastRun.attempts : {};
  } catch (_) { /* 读不到历史队列不影响本次补齐，只失去轮转顺序 */ }
  // 港股先补齐"在册目标池"的近一年收盘价，再审计缺口：
  // 没有行情就不在选股池里，估值缺口也就无从补起（见 syncHkTargetPoolBars 注释）。
  let targetPool = null;
  if (market === 'HK') {
    try {
      targetPool = await syncHkTargetPoolBars({ asOfDate, maxCodes: limit });
    } catch (error) {
      targetPool = { targetCount: 0, pending: 0, processed: 0, succeeded: 0, reason: 'target_pool_bars_failed', error: String(error.message || error).slice(0, 320) };
    }
  }
  const audit = await service.auditInputs({ market, asOfDate });
  const { financial: fundamental, industry, valuation, unclassified } = classifyGaps(audit.gaps || []);
  const industryQueue = orderByAttempts(industry, priorAttempts, previouslyFailed);
  const fundamentalQueue = orderByAttempts(fundamental, priorAttempts, previouslyFailed);
  // 行业分类先补：一次取数就能补齐一条完整路径，成本低，且它是"能否发布正式组合"的阻断项，
  // 不能被财报批次挤掉。
  const industryBatch = industryQueue.slice(0, limit);
  const industryResults = [];
  for (const gap of industryBatch) {
    try {
      industryResults.push(await collectIndustryOne(gap, market));
    } catch (error) {
      industryResults.push({ code: gap.code, ok: false, reason: 'industry_collect_failed', error: String(error.message || error).slice(0, 320) });
    }
  }
  const batch = fundamentalQueue.slice(0, limit);
  const results = [];
  for (const gap of batch) {
    try {
      results.push(await collectOne(gap, asOfDate));
    } catch (error) {
      // 单只失败不阻断整批：失败原因留在结果里，剩余对象继续等下一次续跑。
      results.push({ code: gap.code, ok: false, reason: 'collect_failed', error: String(error.message || error).slice(0, 320) });
    }
  }
  // 港股估值/收盘价：A 股有共享行情任务，港股没有，缺口会永远悬着（2026-11-05 生产实证：
  // 港股 daily_valuations 全历史 0 行）。因此只在港股补，A 股的 valuation 缺口仍如实记为剩余。
  const valuationBatch = market === 'HK' ? orderByAttempts(valuation, priorAttempts, previouslyFailed).slice(0, limit) : [];
  const valuationResults = [];
  for (const gap of valuationBatch) {
    try {
      valuationResults.push(await collectHkMarketData(gap, asOfDate));
    } catch (error) {
      valuationResults.push({ code: gap.code, ok: false, reason: 'valuation_collect_failed', error: String(error.message || error).slice(0, 320) });
    }
  }
  const attempted = results.concat(industryResults, valuationResults);
  // 重新审计：剩余量以"补完后仍待补"为准，不用本批处理数冒充完成。
  const after = await service.auditInputs({ market, asOfDate });
  const remaining = classifyGaps(after.gaps || []);
  const failedResults = attempted.filter(item => !item.ok);
  const remainingCodes = new Set((after.gaps || []).map(gap => gap.code));
  const failedCodes = failedResults.map(item => item.code);
  // 本批"跑完了但缺口仍未解除"的对象同样要排到队尾（R3-02）：只轮转抛错对象时，
  // 一批"能返回数据但补不齐"的股票会稳稳占住队首，后面的对象永远轮不到。
  const deferredCodes = [...new Set(attempted
    .map(item => item.code)
    .filter(code => remainingCodes.has(code) && !failedCodes.includes(code)))];
  // 本批被尝试过的对象都要累加计数（不论成功与否）：这是"谁还没轮到"的唯一依据。
  const nextAttempts = Object.assign({}, priorAttempts);
  attempted.forEach(item => {
    nextAttempts[item.code] = Number(nextAttempts[item.code] || 0) + 1;
  });
  // 队列里同时保留：补齐摘要 + 补齐后仍待补的对象明细（明细来自重新审计，不是本批结果倒推）。
  const queuePayload = {
    market,
    asOfDate,
    generatedAt: new Date().toISOString(),
    universeCount: after.coverage ? after.coverage.universeCount : null,
    gapCount: (after.gaps || []).length,
    domainCounts: after.domainCounts || {},
    coverage: after.coverage,
    quality: after.quality,
    gaps: after.gaps || [],
    truncated: false,
    lastRun: {
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
      targetPool,
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
    },
  };
  await repo.saveInputGapQueue({ market, payload: queuePayload });
  // 完成判定（R2-04）：本任务能补的（财报/分红/行业）与不能补但必需的（估值）都必须清空；
  // 未识别的缺口也不允许当完成。处理 0 个而仍有缺口时更不能报 succeeded。
  const blockingRemaining = remaining.fundamental.length + remaining.industry.length
    + remaining.valuation.length + remaining.unclassified.length;
  const cleared = blockingRemaining === 0;
  const unclassifiedBlocked = remaining.unclassified.length > 0;
  const valuationBlocked = remaining.valuation.length > 0;
  const processedAny = results.length + industryResults.length + valuationResults.length > 0
    || Boolean(targetPool && targetPool.processed);
  const status = cleared ? 'succeeded'
    : (!processedAny ? 'blocked' : 'partial');
  const reason = cleared ? undefined
    : unclassifiedBlocked ? 'selection_gap_unclassified'
      : valuationBlocked && blockedOnlyByValuation(remaining) ? 'remaining_valuation_gap'
        : 'selection_inputs_gaps_pending';
  return {
    ok: cleared,
    status,
    reason,
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
    remainingFundamental: queuePayload.lastRun.remainingFundamental,
    remainingFinancial: queuePayload.lastRun.remainingFinancial,
    remainingIndustry: queuePayload.lastRun.remainingIndustry,
    remainingValuation: queuePayload.lastRun.remainingValuation,
    remainingUnclassified: queuePayload.lastRun.remainingUnclassified,
    gapCount: queuePayload.gapCount,
    domainCounts: queuePayload.domainCounts,
    coverage: after.coverage,
    batchResults: results.slice(0, 50),
    industryResults: industryResults.slice(0, 50),
  };
}

// 只剩估值缺口时给出专门原因，便于任务面板区分"等共享行情"与"还有别的缺口在补"。
function blockedOnlyByValuation(remaining) {
  return remaining.fundamental.length === 0 && remaining.industry.length === 0
    && remaining.unclassified.length === 0 && remaining.valuation.length > 0;
}

module.exports = {
  syncSelectionInputs, collectOne, collectIndustryOne, classifyGaps, REPORT_KINDS, HISTORY_YEARS,
  collectHkMarketData, syncHkTargetPoolBars, resolveHkTargetPool, writeHkBars,
};

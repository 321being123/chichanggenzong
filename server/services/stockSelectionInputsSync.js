// 投资策略选股中心：选股输入补齐（SSV-01）。
// 只做两件事：①把"应补未补"的对象按市场/目标日冻结成可续跑队列；②逐公司调用**既有**数据访问层与
// 既有标准层写入入口（persistCollectedData）把财报与分红补进原表。
// 不新建第二套采集链、不自己拼 HTTP、不写平行事实表；估值与行情的补齐仍由共享行情任务负责。
'use strict';

const { persistCollectedData } = require('./financialDataArchitecture');
const repo = require('../repositories/stockSelectionRepository');
const { upsertIndustryPath } = require('../repositories/industryRepository');

// 财报历史要覆盖"最新一年 + 此前十年"（方案 5.2 的 11 个完整财年），再往前留一年缓冲。
const HISTORY_YEARS = 12;
const REPORT_KINDS = ['income', 'balance', 'cashflow', 'indicator'];

function dashDate(value) {
  const text = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
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
function pruneAttempts(attempts, remainingCodes, limit = 2000) {
  const out = {};
  Object.entries(attempts || {}).forEach(([code, count]) => {
    if (!remainingCodes.has(code)) return;
    if (Object.keys(out).length >= limit) return;
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
 * 执行一次选股输入补齐。
 * @param {{market:'CN'|'HK', asOfDate:string, batchLimit?:number}} input
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
  // 重新审计：剩余量以"补完后仍待补"为准，不用本批处理数冒充完成。
  const after = await service.auditInputs({ market, asOfDate });
  const remaining = classifyGaps(after.gaps || []);
  const failedResults = results.concat(industryResults).filter(item => !item.ok);
  const remainingCodes = new Set((after.gaps || []).map(gap => gap.code));
  const failedCodes = failedResults.map(item => item.code);
  // 本批"跑完了但缺口仍未解除"的对象同样要排到队尾（R3-02）：只轮转抛错对象时，
  // 一批"能返回数据但补不齐"的股票会稳稳占住队首，后面的对象永远轮不到。
  const deferredCodes = [...new Set(results.concat(industryResults)
    .map(item => item.code)
    .filter(code => remainingCodes.has(code) && !failedCodes.includes(code)))];
  // 本批被尝试过的对象都要累加计数（不论成功与否）：这是"谁还没轮到"的唯一依据。
  const nextAttempts = Object.assign({}, priorAttempts);
  results.concat(industryResults).forEach(item => {
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
  const processedAny = results.length + industryResults.length > 0;
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

module.exports = { syncSelectionInputs, collectOne, collectIndustryOne, classifyGaps, REPORT_KINDS, HISTORY_YEARS };

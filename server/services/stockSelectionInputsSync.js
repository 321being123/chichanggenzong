// 投资策略选股中心：选股输入补齐（SSV-01）。
// 只做两件事：①把"应补未补"的对象按市场/目标日冻结成可续跑队列；②逐公司调用**既有**数据访问层与
// 既有标准层写入入口（persistCollectedData）把财报与分红补进原表。
// 不新建第二套采集链、不自己拼 HTTP、不写平行事实表；估值与行情的补齐仍由共享行情任务负责。
'use strict';

const { pool } = require('../db/connection');
const { persistCollectedData } = require('./financialDataArchitecture');
const repo = require('../repositories/stockSelectionRepository');

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

/** 缺口原因里哪些属于"可以靠补财报/分红解决"，哪些必须等共享行情补估值。 */
function classifyGaps(gaps) {
  const financial = [];
  const valuation = [];
  gaps.forEach(gap => {
    const reasons = gap.reasons || [];
    const needsFinancial = reasons.some(reason => /R04|R05|annual|equity|dividend|history/i.test(reason));
    const needsValuation = reasons.some(reason => /R01|R02|pb_/i.test(reason));
    if (needsFinancial) financial.push(gap);
    else if (needsValuation) valuation.push(gap);
  });
  return { financial, valuation };
}

async function readMeta(tsCode) {
  const { rows } = await pool.query(
    `SELECT i.canonical_code AS ts_code, i.name, i.market, i.list_date::text AS list_date,
            i.currency_code, i.raw_data
       FROM core.instruments i WHERE i.canonical_code = $1 LIMIT 1`, [tsCode]);
  return rows[0] || null;
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
  const audit = await service.auditInputs({ market, asOfDate });
  const { financial, valuation } = classifyGaps(audit.gaps || []);
  const batch = financial.slice(0, limit);
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
  // 队列里同时保留：补齐摘要 + 补齐后仍待补的对象明细（明细来自重新审计，不是本批结果倒推）。
  const queuePayload = {
    market,
    asOfDate,
    generatedAt: new Date().toISOString(),
    universeCount: after.coverage ? after.coverage.universeCount : null,
    gapCount: remaining.financial.length + remaining.valuation.length,
    coverage: after.coverage,
    quality: after.quality,
    gaps: (after.gaps || []).slice(0, 5000),
    truncated: (after.gaps || []).length > 5000,
    lastRun: {
      processed: results.length,
      succeeded: results.filter(item => item.ok).length,
      failed: results.filter(item => !item.ok).length,
      remainingFinancial: remaining.financial.length,
      remainingValuation: remaining.valuation.length,
      valuationCodes: remaining.valuation.slice(0, 200).map(item => item.code),
    },
  };
  await repo.saveInputGapQueue({ market, payload: queuePayload });
  return {
    ok: remaining.financial.length === 0,
    status: remaining.financial.length === 0 ? 'succeeded' : 'partial',
    market,
    asOfDate,
    processed: results.length,
    succeeded: queuePayload.lastRun.succeeded,
    failed: queuePayload.lastRun.failed,
    remainingFinancial: queuePayload.lastRun.remainingFinancial,
    remainingValuation: queuePayload.lastRun.remainingValuation,
    coverage: after.coverage,
    batchResults: results.slice(0, 50),
  };
}

module.exports = { syncSelectionInputs, collectOne, classifyGaps, REPORT_KINDS, HISTORY_YEARS };

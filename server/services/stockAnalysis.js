const crypto = require('crypto');
const stockAnalysisRepository = require('../repositories/stockAnalysisRepository');
const { tushareQuery, tsRows, toTsCode, tsDateStr } = require('./market');
const marketDataGateway = require('../dataAccess/marketDataGateway');
// 采集函数（巨潮／交易所／东财／雪球／股吧）已迁入数据接入层，服务侧保持同名引用与导出不变。
const {
  controllerType, fetchActualController, requestJson, stockExchange, sourceForUrl, eventCategory, officialAnnouncementNumber, announcementStockCode, announcementUrl, dedupeAnnouncementEvents, mapSseAnnouncement, mapSzseAnnouncement, fetchCninfoEvents, fetchCninfoEventsByYear, fetchSseLatestReport, fetchSseEvents, fetchSzseEvents, fetchSseEventsBatch, fetchSzseEventsBatch, fetchCninfoEventsBatch, fetchSzseLatestReport, fetchXueqiuEvents, fetchGubaEvents,
} = require('../dataAccess/adapters/announcementSourceAdapter');
const { persistCollectedData, saveCollectedEvents, saveAnalysisResults } = require('./financialDataArchitecture');
const { statementApiFields } = require('./stockStatements');
const { evaluateStockFreshness, isoDateSafe } = require('./analysisFreshness');
const { datasetScope, getDatasetCursors, isDatasetFresh, markDatasetSuccess } = require('./datasetCursors');
const { resolveProviderCode } = require('./securityIdentity');
const CoreDate = require('../../public/shared/core-date.js');

const FORMULA_VERSION = '1';
// 允许按 TTL 跳过上游的低频数据组。行情、三表、财务指标不在此列：
// 行情已有 14 天重叠增量，财务有 120 天更正窗口，跳过会改变分析结论。
const GATED_STOCK_DATASETS = ['stock_basic', 'stock_dividend', 'stock_forecast', 'stock_industry', 'stock_controller'];
const REPORT_TABLES = {
  income: 'stock_income_statements',
  balancesheet: 'stock_balance_sheets',
  cashflow: 'stock_cashflow_statements',
};

// 批次2b：纯计算与口径只有 domain/stockValuation 一份实现，本文件只做采集与编排。
const {
  DAY, average, buildAnalysis: buildValuationAnalysis, dateText, financialAverage, finite, growthMetric,
  isoDate, latestAnnualRows, percentile, quantile, selectDividendPlans, selectLatestByPeriod, signedRatio,
  threeYearAverageGrowth, ttmValue, valuationComparator, valuationSamples, yearsAgo,
} = require('../domain/stockValuation');

function normalizeStockCode(value) {
  const tsCode = toTsCode(String(value || '').trim());
  return /^\d{6}\.(SH|SZ|BJ)$/.test(tsCode) ? tsCode : null;
}

function isOrdinaryAStock(tsCode) {
  if (!normalizeStockCode(tsCode)) return false;
  const code = tsCode.slice(0, 6);
  return /^(60|68|00|30|43|83|87|92)/.test(code) && !/^(110|111|113|118|123|127|128)/.test(code);
}

function versionKey(row) {
  return [row.end_date || '', row.report_type || '', row.f_ann_date || row.ann_date || '', row.update_flag || '', row.div_proc || '', row.ex_date || row.pay_date || ''].join('|');
}

async function fetchRequired(apiName, params, fields) {
  const data = await tushareQuery(apiName, params, fields);
  if (!data || !Array.isArray(data.items)) throw new Error(`${apiName} 数据获取失败`);
  return tsRows(data);
}

async function fetchIndustry(tsCode) {
  try {
    const rows = await fetchRequired('index_member_all', { ts_code: tsCode, is_new: 'Y' }, 'ts_code,l1_code,l1_name,l2_code,l2_name,l3_code,l3_name,is_new');
    const row = rows.find(item => item.l3_name) || rows[0];
    if (row) return { industry: row.l3_name || row.l2_name || row.l1_name || '', industry_system: '申万2021', industry_level: row.l3_name ? '三级' : (row.l2_name ? '二级' : '一级'), industry_path: [row.l1_name,row.l2_name,row.l3_name].filter(Boolean) };
  } catch (error) {
    if (error.code === 'JOB_BUDGET_EXCEEDED') throw error;
  }
  if (!process.env.GEOSCOPE_API_KEY) return null;
  try {
    return await require('./lixinger').fetchLixingerIndustry(tsCode);
  } catch (_) { return null; }
}

function ranges(startDate, endDate, years = 8) {
  let year = Number(String(startDate).slice(0, 4));
  const endYear = Number(String(endDate).slice(0, 4));
  const result = [];
  while (year <= endYear) {
    const last = Math.min(endYear, year + years - 1);
    result.push([`${year}0101`, `${last}1231` > endDate ? endDate : `${last}1231`]);
    year = last + 1;
  }
  return result;
}

async function fetchPartitioned(apiName, tsCode, startDate, endDate, fields) {
  const result = [];
  for (const [start, end] of ranges(startDate, endDate)) {
    const rows = await fetchRequired(apiName, { ts_code: tsCode, start_date: start, end_date: end }, fields);
    result.push(...rows);
  }
  return result;
}

async function repairZeroValuations(tsCode, rows, fields) {
  const affected=rows.filter(row=>['pe','pe_ttm','pb'].some(field=>finite(row[field])===0));
  if(!affected.length)return {rows,issues:[]};
  const dates=affected.map(row=>row.trade_date).sort(),retry=await fetchRequired('daily_basic',{ts_code:tsCode,start_date:dates[0],end_date:dates[dates.length-1]},fields),retryMap=new Map(retry.map(row=>[row.trade_date,row])),issues=[];
  const repaired=rows.map(row=>{const next=Object.assign({},row),again=retryMap.get(row.trade_date)||{};['pe','pe_ttm','pb'].forEach(field=>{if(finite(row[field])!==0)return;const value=finite(again[field]);if(value!==null&&value!==0)next[field]=value;else{next[field]=null;issues.push({trade_date:row.trade_date,field:field,reason:'接口重拉后仍为0，按缺失值处理'});}});return next;});
  return {rows:repaired,issues};
}


async function saveReports(kind, tsCode, rows) {
  await stockAnalysisRepository.saveReports({ kind, tsCode, rows });
}


// 交易所字段用于公告接口的栏目选择，不作为外部供应商证券标识；供应商代码统一走 securityIdentity。
// 三家官方公告返回的编号字段不完全一致，统一保留原始公告来源编号；
// 没有编号时才退回附件路径，避免补发/更正公告因 URL 变化产生重复事实。
// 交易所公告支持按市场/日期批量查询。分页由接口总数、短页或重复页结束；
// 真正的任务止损交给统一 Runner/Guard，不能在业务函数内写死页数。
async function fetchTushareAnnouncementBatch(startDate, endDate) {
  const data = await tushareQuery('anns_d', { start_date: dateText(startDate), end_date: dateText(endDate) }, 'ts_code,ann_date,title,url', { allowEmpty: true });
  const rows = tsRows(data);
  const events = rows.map(row => ({ source: 'tushare', source_number: `${row.ts_code || ''}:${row.ann_date || ''}:${row.title || ''}`,
    stock_code: announcementStockCode(row, String(row.ts_code || '').endsWith('.SH') ? 'SH' : 'SZ'), event_date: dateText(row.ann_date),
    title: String(row.title || ''), url: String(row.url || ''), category: eventCategory(row.title || ''), is_official: false, raw: row }))
    .filter(event => event.event_date && event.title && event.url);
  return { events: dedupeAnnouncementEvents(events), complete: true, fetched: rows.length };
}

async function saveEvents(tsCode, events) {
  await saveCollectedEvents(tsCode, events.filter(row => /^\d{8}$/.test(row.event_date || '')));
}

async function refreshDividends(tsCode, today) {
  const scope = datasetScope('stock', tsCode);
  const cursors = await getDatasetCursors(scope, ['stock_dividend']);
  if (isDatasetFresh(cursors.get('stock_dividend'), 'stock_dividend')) return;
  const rows = tsRows(await tushareQuery('dividend', { ts_code: tsCode },
    'ts_code,end_date,ann_date,div_proc,stk_div,stk_bo_rate,stk_co_rate,cash_div,cash_div_tax,record_date,ex_date,pay_date,imp_ann_date,base_date,base_share', { allowEmpty: true }));
  if (rows.length >= 2000 || rows.some(row => row.ts_code !== tsCode)) throw new Error('分红历史响应不完整或证券身份不一致，保留旧数据');
  const meta = await stockAnalysisRepository.readInstrumentMeta({ tsCode });
  if (!meta) throw new Error('缺少分红采集对应的证券档案');
  await persistCollectedData({ ...meta.raw_data, ts_code: tsCode, name: meta.name, market: meta.market, list_date: meta.list_date }, { dividends: rows });
  await markDatasetSuccess(scope, 'stock_dividend', { lastSuccessDate: isoDate(today) });
}

function eventRefreshStart(lastSuccessDate, today) {
  const end = new Date(`${isoDate(today)}T00:00:00+08:00`);
  const oneYearAgo = tsDateStr(new Date(end.getTime() - 365 * DAY));
  if (!lastSuccessDate) return oneYearAgo;
  const last = dateText(lastSuccessDate);
  const overlap = tsDateStr(new Date(Date.UTC(Number(last.slice(0,4)), Number(last.slice(4,6))-1, Number(last.slice(6,8))-7)));
  return overlap > oneYearAgo ? overlap : oneYearAgo;
}

function mergeOfficialEventSources(results) {
  const successful = results.filter(result => result.status === 'fulfilled');
  const errors = results.filter(result => result.status === 'rejected')
    .map(result => result.reason && result.reason.message).filter(Boolean);
  if (!successful.length) throw new Error(errors.join('；') || '公告源均不可用');
  const official = successful.flatMap(result => result.value || []).filter(event => event.is_official);
  if (!official.length && errors.length) throw new Error(`公告源部分失败且未返回公告：${errors.join('；')}`);
  return [...new Map(official.map(event => [event.url || `${event.event_date}:${event.title}`, event])).values()];
}

async function refreshEvents(tsCode, today) {
  const state = await stockAnalysisRepository.readEventCursor({ tsCode });
  const last = state && dateText(state.last_success_date);
  if (last === today && !state.last_error) return;
  const start = eventRefreshStart(last, today);
  try {
    const completeEvents = async fetcher => {
      const result = await fetcher(tsCode, start, today, '', { structured: true });
      if (!result || !result.complete || !Array.isArray(result.events)
        || result.diagnostics?.reason === 'org_id_not_found') throw new Error('公告采集未完成，保留已有公告和成功水位');
      return result.events.filter(event => event.is_official);
    };
    const exchange = tsCode.endsWith('.SH') ? fetchSseEvents : tsCode.endsWith('.SZ') ? fetchSzseEvents : null;
    let unique;
    if (exchange) {
      try { unique = await completeEvents(exchange); }
      catch (_) { unique = await completeEvents(fetchCninfoEvents); }
    } else unique = await completeEvents(fetchCninfoEvents);
    await saveEvents(tsCode, unique);
    await stockAnalysisRepository.upsertEventCursor({ tsCode, isoToday: isoDate(today) });
  } catch (error) {
    console.warn(`[stock-analysis] 公司事件刷新失败 ${tsCode}:`,error.message);
    throw new Error(`公司公告刷新失败：${error.message}`);
  }
}

async function loadData(tsCode) {
  return stockAnalysisRepository.loadAnalysisInputs({ tsCode });
}

// 编排（批次2b/1）：读取标准事实 → 按需经中立网关取实时行情（readOnly 时零外采）→ 交给域计算。
// 实时行情是唯一外采动作，经 dataAccess 网关统一收口；外采失败按"无实时报价"降级并留日志，
// 不阻断分析（原来外采异常会让整个分析接口 500）。
async function buildAnalysis(tsCode, options = {}) {
  const data = await loadData(tsCode);
  const today = CoreDate.todayInZone('Asia/Shanghai').replace(/-/g, '');
  const quoteResult = options.readOnly
    ? { byCode: new Map(), externalCalls: [] }
    : await marketDataGateway.defaultGateway.readQuotes({ codes: [tsCode], allowExternal: true });
  const failedCalls = (quoteResult.externalCalls || []).filter(item => !item.ok);
  if (failedCalls.length) {
    console.warn('[stock-analysis] 实时行情外采未成功，按无实时报价降级：'
      + failedCalls.map(item => item.source + ':' + (item.error || item.reason || 'unknown')).join(','));
  }
  const rawQuote = quoteResult.byCode.get(tsCode);
  return buildValuationAnalysis(data, { today, rawQuote });
}
// 本地已存分红的最新报告期（end_date）：作为增量水位原样返回（YYYYMMDD）；
// 重叠窗口（往前约一年）由下方过滤器统一计算，避免两处各减一年导致窗口翻倍。
// 首发（无本地数据）返回 null → 保留全量。
async function latestDividendEndDate(tsCode) {
  try {
    const d = await stockAnalysisRepository.latestDividendEndDate({ tsCode });
    if (!/^\d{8}$/.test(d)) return null;
    return d;
  } catch (_) { return null; }
}

// 本地已存业绩预告的最新公告日：作为增量水位，请求时只取该日往前 30 天重叠窗口。
async function latestForecastAnnDate(tsCode) {
  try {
    const d = await stockAnalysisRepository.latestForecastAnnDate({ tsCode });
    if (!/^\d{8}$/.test(d)) return null;
    const dt = new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(4, 6)) - 1, Number(d.slice(6, 8)) - 30));
    return tsDateStr(dt);
  } catch (_) { return null; }
}

async function refreshStockAnalysis(rawCode, reason = 'manual', options = {}) {
  const tsCode = normalizeStockCode(rawCode);
  if (!tsCode || !isOrdinaryAStock(tsCode)) throw new Error('仅支持A股普通股票');
  // 定时任务只做标准层本地计算，避免对每只股票重复请求同一行情/财务接口。
  if (options.readOnly === true) {
    const analysis = await buildAnalysis(tsCode, { readOnly: true });
    await saveAnalysisResults(tsCode, Object.assign({}, analysis, { diagnostics: { reason, read_only: true } }));
    return analysis;
  }
  const today = tsDateStr(new Date());

  // 低频数据组按 TTL 门控：TTL 内且本地已有可用旧值时跳过上游，避免重复拉取
  const stockScope = datasetScope('stock', tsCode);
  const cursors = await getDatasetCursors(stockScope, GATED_STOCK_DATASETS);
  const forceAll = options.force === true;
  const skippedDatasets = [];
  const gate = (code, run, fallback) => {
    if (fallback != null && isDatasetFresh(cursors.get(code), code, { force: forceAll })) {
      skippedDatasets.push(code);
      return Promise.resolve(fallback);
    }
    return run();
  };

  // 主档 stock_basic 有 7 天 TTL：TTL 内且本地 stock_unified 已同步时复用缓存，
  // 否则重新拉取主档（名称/上市状态等），避免「只要 stock_unified 有记录就永不刷新」的缺陷。
  const stockBasicFresh = isDatasetFresh(cursors.get('stock_basic'), 'stock_basic', { force: forceAll });
  let meta = null;
  if (stockBasicFresh) {
    try {
      const cached = { rows: [await stockAnalysisRepository.readUnifiedSummary({ tsCode })].filter(Boolean) };
      if (cached.rows[0]) meta = cached.rows[0];
    } catch (_) { /* stock_unified 可能尚未建，降级到原逻辑 */ }
  }

  if (!meta) {
    const metadataRows = await fetchRequired('stock_basic', { ts_code: tsCode }, 'ts_code,symbol,name,area,industry,market,exchange,list_status,list_date');
    meta = metadataRows[0];
  }
  if (!meta) throw new Error('未找到股票基础信息');
  // 上一轮存下来的行业与实际控制人，作为 TTL 内跳过时的兜底值（没有兜底就照常拉取）
  let prevRaw = {};
  try {
    const rawData = await stockAnalysisRepository.readInstrumentRawData({ tsCode });
    prevRaw = rawData || {};
  } catch (_) { /* 主档还没建时正常走全量 */ }
  const prevIndustry = prevRaw.industry_system
    ? { industry_system: prevRaw.industry_system, industry_level: prevRaw.industry_level, industry_path: prevRaw.industry_path || [] }
    : null;
  const prevController = prevRaw.actual_controller && prevRaw.actual_controller.name ? prevRaw.actual_controller : null;
  const [industryInfo, actualController] = await Promise.all([
    gate('stock_industry', () => fetchIndustry(tsCode), prevIndustry),
    gate('stock_controller', () => fetchActualController(tsCode), prevController),
  ]);
  meta = Object.assign({}, meta, { tushare_industry: meta.industry }, industryInfo || { industry_system: 'Tushare基础行业', industry_level: '未标注级别', industry_path: [meta.industry].filter(Boolean) }, { actual_controller: actualController || { name: '', type: '', source: '东方财富F10' } });
  const financialFields = {
    income: statementApiFields('income'),
    balancesheet: statementApiFields('balance'),
    cashflow: statementApiFields('cashflow')
  };
  const existing = { rows: [await stockAnalysisRepository.readCoverageFlags({ tsCode })] };
  const hasDaily = Boolean(existing.rows[0] && existing.rows[0].has_daily);
  const hasIndicator = Boolean(existing.rows[0] && existing.rows[0].has_indicator);
  const hasReports = Boolean(existing.rows[0] && existing.rows[0].has_reports);
  const firstDaily = existing.rows[0] && dateText(existing.rows[0].first_daily);
  const financialStart = hasReports ? yearsAgo(120) : (meta.list_date || '19900101');
  const [income, balance, cashflow] = await Promise.all(Object.entries(financialFields)
    .map(([api, fields]) => fetchPartitioned(api, tsCode, financialStart, today, fields)));
  if (!income.length || !balance.length || !cashflow.length) throw new Error('三表数据不完整，保留上一份结果');
  const indicatorStart = hasIndicator ? yearsAgo(120) : (meta.list_date || '19900101');
  const dividendStart = await latestDividendEndDate(tsCode);
  const forecastStart = await latestForecastAnnDate(tsCode);
  const [indicators, dividends, forecasts] = await Promise.all([
    fetchPartitioned('fina_indicator', tsCode, indicatorStart, today, 'ts_code,ann_date,end_date,roe,roa,ebit,ebit_to_interest,interestdebt,profit_dedt,dt_netprofit_yoy'),
    // dividend 官方仅支持 ts_code（无 start_date/end_date 范围）：传 ts_code 拉该只全量，内存过滤只保留本地最新分红报告期往前一年的重叠窗口，
    // 由 persistCollectedData 落原文并按唯一键幂等 upsert 到 fundamental.corporate_actions（首次无水位则保留全量）。
    // 重叠窗口仅在此计算一次（latestDividendEndDate 只提供原始水位）。
    gate('stock_dividend', async () => {
      const all = await fetchRequired('dividend', { ts_code: tsCode }, 'ts_code,end_date,ann_date,div_proc,stk_div,stk_bo_rate,stk_co_rate,cash_div,cash_div_tax,record_date,ex_date,pay_date,imp_ann_date,base_date,base_share');
      if (!dividendStart) return all;
      const dt = new Date(Date.UTC(+dividendStart.slice(0, 4), +dividendStart.slice(4, 6) - 1, +dividendStart.slice(6, 8)));
      dt.setUTCDate(dt.getUTCDate() - 365);
      const floor = tsDateStr(dt);
      return (all || []).filter(r => (String(r.end_date || r.ann_date || '').replace(/-/g, '')) >= floor);
    }, []),
    gate('stock_forecast', () => fetchRequired('forecast', Object.assign({ ts_code: tsCode }, forecastStart ? { start_date: forecastStart } : {}), 'ts_code,ann_date,end_date,type,p_change_min,p_change_max,net_profit_min,net_profit_max,last_parent_net,summary,change_reason'), [])
  ]);
  const lastTenYears = yearsAgo(3653), listDate = meta.list_date || lastTenYears;
  const incrementalStart = yearsAgo(14);
  const hasListingHistory = firstDaily && firstDaily <= tsDateStr(new Date(new Date(`${isoDate(listDate)}T00:00:00+08:00`).getTime() + 31 * DAY));
  const priceStart = hasDaily && hasListingHistory ? incrementalStart : listDate;
  const basicStart = hasDaily ? incrementalStart : listDate;
  const basicFields='ts_code,trade_date,close,pe,pe_ttm,pb,dv_ttm,total_share,float_share,free_share,total_mv,circ_mv';
  const [daily, factors, fetchedBasics] = await Promise.all([
    fetchPartitioned('daily', tsCode, priceStart, today, 'ts_code,trade_date,close'),
    fetchPartitioned('adj_factor', tsCode, priceStart, today, 'ts_code,trade_date,adj_factor'),
    fetchPartitioned('daily_basic', tsCode, basicStart, today, basicFields)
  ]);
  const repairedBasics=await repairZeroValuations(tsCode,fetchedBasics,basicFields),basics=repairedBasics.rows;
  if (!basics.length) throw new Error('历史估值数据为空，保留上一份结果');
  await persistCollectedData(meta,{income,balance,cashflow,indicators,dividends,forecasts,daily,basics,factors,valuationIssues:repairedBasics.issues});
  // 本轮真正拉过的低频数据组推进游标，下一轮才能按 TTL 跳过
  const fetchedDatasets = GATED_STOCK_DATASETS.filter(code => !skippedDatasets.includes(code));
  for (const dataset of fetchedDatasets) {
    await markDatasetSuccess(stockScope, dataset, { lastSuccessDate: isoDate(new Date()) });
  }
  await refreshEvents(tsCode, today);
  const analysis = await buildAnalysis(tsCode);
  await saveAnalysisResults(tsCode,Object.assign({},analysis,{diagnostics:{reason,skipped_datasets:skippedDatasets}}));
  return analysis;
}

async function getSnapshot(rawCode) {
  const tsCode = normalizeStockCode(rawCode);
  if (!tsCode) return null;
  const r = await stockAnalysisRepository.readLatestSnapshot({ tsCode });
  if (!r) return null;
  const latestRow = await stockAnalysisRepository.readSnapshotFreshnessInputs({ instrumentId: r.instrument_id });
  const freshness = evaluateStockFreshness({
    watermark: r.source_watermark,
    formula_bundle_version: r.formula_bundle_version,
    expected_formula_version: FORMULA_VERSION,
    latestTradeDate: latestRow.trade_date,
    current: {
      financialEnd: latestRow.financial_end,
      financialAnn: latestRow.financial_ann,
      dividendAnn: latestRow.dividend_ann,
      dividendEx: latestRow.dividend_ex,
      guidanceAnn: latestRow.guidance_ann,
      guidanceEnd: latestRow.guidance_end,
      industryName: latestRow.industry_name,
      controllerName: latestRow.controller_name,
      eventDate: latestRow.event_date,
    },
  });
  return Object.assign({}, r.payload, {
    refreshed_at: r.created_at,
    source_updated_at: r.created_at,
    diagnostics: { source: 'analytics.analysis_snapshots' },
    needs_refresh: freshness.needs_refresh,
    freshness,
  });
}

async function listUserStocks(username) {
  const rows = await stockAnalysisRepository.listUserStockRows({ username });
  return rows.filter(row => isOrdinaryAStock(row.ts_code));
}

module.exports = { finite, normalizeStockCode, isOrdinaryAStock, stockExchange, growthMetric, threeYearAverageGrowth, percentile, quantile, selectDividendPlans, selectLatestByPeriod, eventRefreshStart, mergeOfficialEventSources, refreshEvents, refreshDividends, ranges,
  refreshStockAnalysis, buildAnalysis, getSnapshot, listUserStocks, fetchCninfoEvents, fetchSseLatestReport, fetchSseEvents,
  fetchCninfoEventsByYear, fetchSzseEvents, fetchSzseLatestReport, fetchSseEventsBatch, fetchSzseEventsBatch,
  fetchCninfoEventsBatch, fetchTushareAnnouncementBatch, sourceForUrl };

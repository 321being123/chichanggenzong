const https = require('https');
const crypto = require('crypto');
const stockAnalysisRepository = require('../repositories/stockAnalysisRepository');
const { tushareQuery, tsRows, toTsCode, tsDateStr } = require('./market');
const { withExternalCallGuard } = require('./externalCallGuard');
const marketDataGateway = require('../dataAccess/marketDataGateway');
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

function controllerType(name) {
  const text = String(name || '');
  if (!text) return '';
  if (/无实际控制人/.test(text)) return '无实际控制人';
  if (/国资委|财政部|人民政府|国有资产|国务院/.test(text)) return '国资';
  if (/^[\u4e00-\u9fa5·]{2,6}$/.test(text)) return '自然人';
  return '企业或机构';
}

async function fetchActualController(tsCode) {
  try {
    const f10Code = await resolveProviderCode({ canonicalCode: tsCode, sourceCode: 'eastmoney', identifierType: 'f10_code' });
    if (!f10Code) return null;
    const payload = await requestJson(`https://emweb.securities.eastmoney.com/PC_HSF10/ShareholderResearch/PageAjax?code=${encodeURIComponent(f10Code)}`);
    const raw = Array.isArray(payload.sjkzr) ? payload.sjkzr[0] : payload.sjkzr;
    if (!raw || !raw.HOLDER_NAME) return null;
    return { name: String(raw.HOLDER_NAME), type: controllerType(raw.HOLDER_NAME), hold_ratio: finite(raw.HOLD_RATIO), source: '东方财富F10' };
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

async function saveMetadata(row) {
  await stockAnalysisRepository.saveMetadata({ row });
}

async function saveReports(kind, tsCode, rows) {
  await stockAnalysisRepository.saveReports({ kind, tsCode, rows });
}

async function saveAux(table, tsCode, rows) {
  await stockAnalysisRepository.saveAux({ table, tsCode, rows });
}

async function saveValuations(tsCode, dailyRows, basicRows, factorRows) {
  await stockAnalysisRepository.saveValuations({ tsCode, dailyRows, basicRows, factorRows });
}

async function setSyncState(tsCode, dataset, successDate, error) {
  await stockAnalysisRepository.setSyncState({ tsCode, dataset, successDate, error });
}

function requestJson(url, options = {}) {
  const source = sourceForUrl(url);
  return withExternalCallGuard(source, `request:${url}:${options.body || ''}`, process.env.JOB_BUSINESS_DATE, () => new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: options.method || 'GET', timeout: options.timeout || 10000,
      headers: Object.assign({ 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, options.headers || {})
    }, resp => {
      let text = '';
      resp.on('data', c => { text += c; });
      resp.on('end', () => {
        if (resp.statusCode < 200 || resp.statusCode >= 300) {
          const error = new Error(`HTTP ${resp.statusCode}`);
          error.code = resp.statusCode === 429 ? 'RATE_LIMIT' : resp.statusCode >= 500 ? 'UPSTREAM_5XX' : 'UPSTREAM_ERROR';
          error.errorType = resp.statusCode === 429 ? 'rate_limit' : resp.statusCode >= 500 ? 'network' : 'upstream';
          error.source = source;
          return reject(error);
        }
        try { resolve(JSON.parse(text)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  }));
}

// 交易所字段用于公告接口的栏目选择，不作为外部供应商证券标识；供应商代码统一走 securityIdentity。
function stockExchange(tsCode) {
  if (String(tsCode || '').endsWith('.SH')) return 'SH';
  if (String(tsCode || '').endsWith('.BJ')) return 'BJ';
  return 'SZ';
}

function sourceForUrl(url) {
  const text = String(url || '');
  if (/cninfo\.com\.cn/i.test(text)) return 'cninfo';
  if (/sse\.com\.cn/i.test(text)) return 'sse';
  if (/szse\.cn/i.test(text)) return 'szse';
  if (/xueqiu\.com/i.test(text)) return 'xueqiu';
  if (/eastmoney\.com/i.test(text)) return 'guba';
  return 'stock-analysis';
}

function eventCategory(title) {
  const text = String(title || '');
  const groups = [
    ['业绩', /业绩|年报|季报|半年报|预告|快报/], ['分红', /分红|派息|利润分配/],
    ['回购增减持', /回购|增持|减持/], ['重大交易', /合同|并购|重组|收购|出售/],
    ['风险', /诉讼|处罚|立案|质押|停牌|复牌|退市|风险警示/]
  ];
  const found = groups.find(([, re]) => re.test(text));
  return found ? found[0] : '其他';
}

// 三家官方公告返回的编号字段不完全一致，统一保留原始公告来源编号；
// 没有编号时才退回附件路径，避免补发/更正公告因 URL 变化产生重复事实。
function officialAnnouncementNumber(row) {
  if (!row || typeof row !== 'object') return null;
  const fields = [
    'announcementId', 'announcement_id', 'annId', 'ann_id', 'id', 'docId', 'doc_id',
    'BULLETIN_ID', 'NOTICE_ID', 'INFO_CODE', 'infoCode', 'announcementNo', 'noticeNo',
    'adjunctUrl', 'attachPath', 'URL',
  ];
  const value = fields.map(field => row[field]).find(item => item !== null && item !== undefined && String(item).trim());
  return value == null ? null : String(value).trim();
}

function announcementStockCode(row, market = '') {
  if (!row || typeof row !== 'object') return '';
  const value = [
    row.stock_code, row.stockCode, row.stock_code_value, row.secCode, row.SECURITY_CODE,
    row.SECURITYCODE, row.PRODUCTID, row.productId, row.ts_code, row.tsCode,
  ].find(item => item !== null && item !== undefined && String(item).trim());
  const code = String(value || '').match(/\d{6}/);
  if (!code || !market) return code ? code[0] : '';
  return `${code[0]}.${market}`;
}

function announcementUrl(prefix, value) {
  const text = String(value || '');
  if (!text) return '';
  return /^https?:\/\//i.test(text) ? text : `${prefix}${text}`;
}

function dedupeAnnouncementEvents(events) {
  return [...new Map((events || []).map(event => [
    `${event.source}:${event.source_number || event.url || `${event.event_date}:${event.title}`}`,
    event,
  ])).values()];
}

function mapSseAnnouncement(row) {
  const title = String(row && (row.TITLE || row.title) || '');
  return {
    source: 'sse', source_number: officialAnnouncementNumber(row), stock_code: announcementStockCode(row, 'SH'),
    event_date: String(row && (row.SSEDATE || row.publishDate) || '').replace(/-/g, ''), title,
    url: announcementUrl('https://big5.sse.com.cn/site/cht/www.sse.com.cn', row && (row.URL || row.url)),
    category: eventCategory(title), is_official: true, raw: row,
  };
}

function mapSzseAnnouncement(row) {
  const title = String(row && (row.title || row.TITLE) || '');
  return {
    source: 'szse', source_number: officialAnnouncementNumber(row), stock_code: announcementStockCode(row, 'SZ'),
    event_date: String(row && (row.publishTime || row.publishDate) || '').slice(0, 10).replace(/-/g, ''), title,
    url: announcementUrl('https://disc.static.szse.cn/download', row && (row.attachPath || row.attach_path)),
    category: eventCategory(title), is_official: true, raw: row,
  };
}

async function fetchCninfoEvents(tsCode, startDate, endDate, searchKey = '', options = {}) {
  const code = tsCode.slice(0, 6);
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Referer: 'https://www.cninfo.com.cn/', 'X-Requested-With': 'XMLHttpRequest' };
  const searchBody = new URLSearchParams({ keyWord: code, maxNum: '10' }).toString();
  const matches = await requestJson('https://www.cninfo.com.cn/new/information/topSearch/query', { method: 'POST', headers, body: searchBody });
  const stock = (Array.isArray(matches) ? matches : [matches]).find(item => item && String(item.code) === code);
  if (!stock || !stock.orgId) return options.structured
    ? { events: [], complete: true, fetched: 0, diagnostics: { reason: 'org_id_not_found' } } : [];
  const events = [];
  const pageSize = 100;
  const seenPageSignatures = new Set();
  let complete = true;
  let pageCount = 0;
  let totalCount = null;
  let page = 1;
  while (true) {
    const body = new URLSearchParams({ pageNum: String(page), pageSize: String(pageSize), stock: `${code},${stock.orgId}`, searchkey: searchKey,
      tabName: 'fulltext', column: 'szse', plate: stockExchange(tsCode).toLowerCase(),
      seDate: `${isoDate(startDate)}~${isoDate(endDate)}` }).toString();
    const payload = await requestJson('https://www.cninfo.com.cn/new/hisAnnouncement/query', { method: 'POST', headers, body });
    pageCount += 1;
    const rows = payload.announcements || [];
    for (const row of rows) {
      const eventDate = row.announcementTime ? tsDateStr(new Date(Number(row.announcementTime))) : dateText(row.announcementDate);
      const title = String(row.announcementTitle || '').replace(/<[^>]+>/g, '');
      const url = row.adjunctUrl ? `https://static.cninfo.com.cn/${String(row.adjunctUrl).replace(/^\//, '')}` : '';
      events.push({ source: 'cninfo', source_number: officialAnnouncementNumber(row), stock_code: announcementStockCode(row, stockExchange(tsCode)), event_date: eventDate, title, url, category: eventCategory(title), is_official: true, raw: row });
    }
    const signature = rows.map(row => String(row.announcementId || row.adjunctUrl || row.announcementTitle || '')).join('|');
    if (signature && seenPageSignatures.has(signature)) { complete = false; break; }
    if (signature) seenPageSignatures.add(signature);
    const total = Number(payload.totalAnnouncement || payload.totalRecordNum);
    totalCount = Number.isFinite(total) ? total : totalCount;
    if (!rows.length || payload.hasMore === false || (payload.hasMore == null && rows.length < pageSize)
      || (Number.isFinite(total) && total > 0 && events.length >= total)) {
      if (payload.hasMore === true || (Number.isFinite(total) && total > events.length)) complete = false;
      break;
    }
    page += 1;
  }
  if (searchKey && !events.length && options.allowBroadFallback !== false) {
    const allEvents = await fetchCninfoEvents(tsCode, startDate, endDate, '', { ...options, allowBroadFallback: false });
    const all = options.structured ? allEvents.events : allEvents;
    const filtered = all.filter(event => String(event.title || '').includes(searchKey));
    return options.structured
      ? { events: filtered, complete: allEvents.complete, fetched: allEvents.fetched, diagnostics: { ...allEvents.diagnostics, broad_fallback: true } }
      : filtered;
  }
  const unique = [...new Map(events.map(event => [`${event.source}:${event.source_number || event.url || `${event.event_date}:${event.title}`}`, event])).values()];
  return options.structured
    ? { events: unique, complete, fetched: events.length, diagnostics: { pages: pageCount, total: totalCount } }
    : unique;
}

async function fetchCninfoEventsByYear(tsCode, startDate, endDate, searchKey, options = {}) {
  const startYear = Number(String(startDate || '').slice(0, 4));
  const endYear = Number(String(endDate || '').slice(0, 4));
  if (!startYear || !endYear) return fetchCninfoEvents(tsCode, startDate, endDate, searchKey, options);
  const groups = [];
  // 每个年度查询都会先请求一次同一只股票的 orgId；并发执行会互相抢同一数据集锁。
  // 顺序查询也能避免在巨潮一分钟预算下瞬时打满请求数。
  for (let index = 0; index <= endYear - startYear; index += 1) {
    const year = startYear + index;
    try {
      groups.push(await fetchCninfoEvents(tsCode, year === startYear ? startDate : `${year}0101`,
        year === endYear ? endDate : `${year}1231`, searchKey, options));
    } catch (error) {
      if (options.propagateErrors) throw error;
      groups.push([]);
    }
  }
  return groups.flat();
}

async function fetchSseLatestReport(tsCode) {
  if (!String(tsCode || '').endsWith('.SH')) return null;
  const params = new URLSearchParams({ isPagination: 'true', productId: tsCode.slice(0, 6), keyWord: '',
    securityType: '0101,120100,020100,020200,120200', reportType2: 'DQBG', reportType: 'ALL',
    'pageHelp.pageSize': '25', 'pageHelp.pageNo': '1', 'pageHelp.beginPage': '1', 'pageHelp.endPage': '1' });
  const payload = await requestJson(`https://query.sse.com.cn/security/stock/queryCompanyBulletin.do?${params.toString()}`,
    { headers: { Referer: 'https://www.sse.com.cn/' } });
  const rows = payload && payload.pageHelp && Array.isArray(payload.pageHelp.data) ? payload.pageHelp.data : [];
  const report = rows.filter(row => /(?:年报|半年报)$/.test(String(row.BULLETIN_TYPE || '')) && !/摘要/.test(String(row.TITLE || '')) && row.URL)
    .sort((a,b) => String(b.SSEDATE || '').localeCompare(String(a.SSEDATE || '')))[0];
  if (!report) return null;
  return { source: 'sse', source_number: officialAnnouncementNumber(report), event_date: String(report.SSEDATE || '').replace(/-/g, ''), title: report.TITLE,
    url: `https://big5.sse.com.cn/site/cht/www.sse.com.cn${report.URL}`, category: '定期报告', is_official: true, raw: report };
}

async function fetchSseEvents(tsCode, startDate, endDate, keyword = '', options = {}) {
  if (!String(tsCode || '').endsWith('.SH')) return options.structured ? { events: [], complete: true, fetched: 0, diagnostics: {} } : [];
  const pageSize = 100, rows = [], seenPageSignatures = new Set();
  let complete = true;
  let pageCount = 0;
  let pageNo = 1;
  while (true) {
    const params = new URLSearchParams({ isPagination: 'true', productId: tsCode.slice(0, 6), keyWord: keyword,
      securityType: '0101,120100,020100,020200,120200', beginDate: isoDate(startDate), endDate: isoDate(endDate),
      'pageHelp.pageSize': String(pageSize), 'pageHelp.pageNo': String(pageNo),
      'pageHelp.beginPage': String(pageNo), 'pageHelp.endPage': String(pageNo) });
    const payload = await requestJson(`https://query.sse.com.cn/security/stock/queryCompanyBulletin.do?${params.toString()}`,
      { headers: { Referer: 'https://www.sse.com.cn/' } });
    pageCount += 1;
    if (!payload || !payload.pageHelp || !Array.isArray(payload.pageHelp.data)) throw new Error('上交所公告响应格式异常');
    const pageRows = payload && payload.pageHelp && Array.isArray(payload.pageHelp.data) ? payload.pageHelp.data : [];
    rows.push(...pageRows);
    const signature = pageRows.map(row => String(row.INFO_CODE || row.URL || row.TITLE || '')).join('|');
    if (signature && seenPageSignatures.has(signature)) { complete = false; break; }
    if (signature) seenPageSignatures.add(signature);
    const total = Number(payload && payload.pageHelp && (payload.pageHelp.total || payload.pageHelp.totalRecordNum));
    if (!pageRows.length || pageRows.length < pageSize || (Number.isFinite(total) && total > 0 && rows.length >= total)) {
      if (Number.isFinite(total) && total > rows.length) complete = false;
      break;
    }
    pageNo += 1;
  }
  const start = isoDate(startDate), end = isoDate(endDate);
  const events = rows.filter(row => row.URL && (!start || row.SSEDATE >= start) && (!end || row.SSEDATE <= end)).map(mapSseAnnouncement);
  return options.structured ? { events: dedupeAnnouncementEvents(events), complete, fetched: rows.length, diagnostics: { pages: pageCount } } : events;
}

async function fetchSzseEvents(tsCode, startDate, endDate, keyword = '', options = {}) {
  if (!String(tsCode || '').endsWith('.SZ')) return options.structured ? { events: [], complete: true, fetched: 0, diagnostics: {} } : [];
  const pageSize = 100;
  const rows = [];
  const seenPageSignatures = new Set();
  let complete = true;
  let pageCount = 0;
  let pageNum = 1;
  while (true) {
    const body = JSON.stringify({ seDate: [isoDate(startDate), isoDate(endDate)], stock: [tsCode.slice(0, 6)],
      channelCode: ['listedNotice_disc'], pageSize, pageNum });
    const payload = await requestJson('https://www.szse.cn/api/disc/announcement/annList?random=0.1', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Referer: 'https://www.szse.cn/disclosure/listed/notice/index.html',
        'X-Requested-With': 'XMLHttpRequest' }, body });
    pageCount += 1;
    const pageRows = Array.isArray(payload.data) ? payload.data : [];
    rows.push(...pageRows);
    const signature = pageRows.map(row => String(row.announcementId || row.id || row.attachPath || row.title || '')).join('|');
    if (signature && seenPageSignatures.has(signature)) { complete = false; break; }
    if (signature) seenPageSignatures.add(signature);
    const announceCount = Number(payload.announceCount);
    if (!pageRows.length || (Number.isFinite(announceCount) && announceCount > 0 && rows.length >= announceCount)
      || (!Number.isFinite(announceCount) && pageRows.length < pageSize)) {
      if (Number.isFinite(announceCount) && announceCount > rows.length) complete = false;
      break;
    }
    pageNum += 1;
  }
  const events = rows.filter(row => row.attachPath && (!keyword || String(row.title || '').includes(keyword))).map(mapSzseAnnouncement);
  return options.structured ? { events: dedupeAnnouncementEvents(events), complete, fetched: rows.length, diagnostics: { pages: pageCount } } : events;
}

// 交易所公告支持按市场/日期批量查询。分页由接口总数、短页或重复页结束；
// 真正的任务止损交给统一 Runner/Guard，不能在业务函数内写死页数。
async function fetchSseEventsBatch(startDate, endDate, keyword = '') {
  const pageSize = 100, rows = [], seenPageSignatures = new Set();
  let complete = true;
  let pageNo = 1;
  let observedPageSize = null;
  while (true) {
    const params = new URLSearchParams({ isPagination: 'true', productId: '', keyWord: keyword,
      securityType: '0101,120100,020100,020200,120200', beginDate: isoDate(startDate), endDate: isoDate(endDate),
      'pageHelp.pageSize': String(pageSize), 'pageHelp.pageNo': String(pageNo),
      'pageHelp.beginPage': String(pageNo), 'pageHelp.endPage': String(pageNo) });
    const payload = await requestJson(`https://query.sse.com.cn/security/stock/queryCompanyBulletin.do?${params.toString()}`,
      { headers: { Referer: 'https://www.sse.com.cn/' } });
    const pageRows = payload && payload.pageHelp && Array.isArray(payload.pageHelp.data) ? payload.pageHelp.data : [];
    rows.push(...pageRows);
    if (pageRows.length && observedPageSize === null) observedPageSize = pageRows.length;
    const signature = pageRows.map(row => String(row.INFO_CODE || row.URL || row.TITLE || '')).join('|');
    if (signature && seenPageSignatures.has(signature)) { complete = false; break; }
    if (signature) seenPageSignatures.add(signature);
    const total = Number(payload && payload.pageHelp && (payload.pageHelp.total || payload.pageHelp.totalRecordNum));
    if (Number.isFinite(total) && total > 0 && rows.length >= total) break;
    if (!pageRows.length) {
      if (Number.isFinite(total) && total > rows.length) complete = false;
      break;
    }
    if (observedPageSize !== null && pageRows.length < observedPageSize) {
      // 不同交易所可能忽略请求的 pageSize（深交所实测每页固定50条）；
      // 只有相对接口实际页面容量变短、且 total 仍表示还有数据时才判为不完整。
      if (Number.isFinite(total) && total > rows.length) complete = false;
      break;
    }
    pageNo += 1;
  }
  return { events: dedupeAnnouncementEvents(rows.filter(row => row.URL).map(mapSseAnnouncement)), complete, fetched: rows.length };
}

async function fetchSzseEventsBatch(startDate, endDate, keyword = '') {
  // 交易所主链必须把分页取完；重复页等异常返回 complete=false，
  // 由统一 Runner 保留游标并重试，不能用固定页数截断业务结果。
  const pageSize = 100, rows = [], seenPageSignatures = new Set();
  let complete = true;
  let pageNum = 1;
  let observedPageSize = null;
  while (true) {
    const body = JSON.stringify({ seDate: [isoDate(startDate), isoDate(endDate)], stock: [],
      channelCode: ['listedNotice_disc'], pageSize, pageNum });
    const payload = await requestJson('https://www.szse.cn/api/disc/announcement/annList?random=0.1', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Referer: 'https://www.szse.cn/disclosure/listed/notice/index.html',
        'X-Requested-With': 'XMLHttpRequest' }, body });
    const pageRows = Array.isArray(payload.data) ? payload.data : [];
    rows.push(...pageRows);
    if (pageRows.length && observedPageSize === null) observedPageSize = pageRows.length;
    const announceCount = Number(payload.announceCount);
    const signature = pageRows.map(row => String(row.announcementId || row.id || row.attachPath || row.title || '')).join('|');
    if (signature && seenPageSignatures.has(signature)) { complete = false; break; }
    if (signature) seenPageSignatures.add(signature);
    if (!pageRows.length) {
      if (Number.isFinite(announceCount) && announceCount > rows.length) complete = false;
      break;
    }
    if (Number.isFinite(announceCount) && announceCount > 0 && rows.length >= announceCount) break;
    if (Number.isFinite(announceCount) && announceCount > rows.length
      && observedPageSize !== null && pageRows.length < observedPageSize) {
      complete = false;
      break;
    }
    if (!Number.isFinite(announceCount) && pageRows.length < pageSize) break;
    pageNum += 1;
  }
  const events = rows.filter(row => row.attachPath && (!keyword || String(row.title || '').includes(keyword))).map(mapSzseAnnouncement);
  return { events: dedupeAnnouncementEvents(events), complete, fetched: rows.length };
}

async function fetchCninfoEventsBatch(startDate, endDate, market, searchKey = '') {
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Referer: 'https://www.cninfo.com.cn/', 'X-Requested-With': 'XMLHttpRequest' };
  const pageSize = 100, rows = [], seenPageSignatures = new Set();
  let complete = true;
  let pageNum = 1;
  let observedPageSize = null;
  while (true) {
    const body = new URLSearchParams({ pageNum: String(pageNum), pageSize: String(pageSize), stock: '', searchkey: searchKey,
      tabName: 'fulltext', column: market === 'SH' ? 'sse' : 'szse', plate: market === 'SH' ? 'sh' : 'sz',
      seDate: `${isoDate(startDate)}~${isoDate(endDate)}` }).toString();
    const payload = await requestJson('https://www.cninfo.com.cn/new/hisAnnouncement/query', { method: 'POST', headers, body });
    const pageRows = Array.isArray(payload.announcements) ? payload.announcements : [];
    rows.push(...pageRows);
    if (pageRows.length && observedPageSize === null) observedPageSize = pageRows.length;
    const signature = pageRows.map(row => String(row.announcementId || row.adjunctUrl || row.announcementTitle || '')).join('|');
    if (signature && seenPageSignatures.has(signature)) { complete = false; break; }
    if (signature) seenPageSignatures.add(signature);
    const total = Number(payload.totalAnnouncement || payload.totalRecordNum);
    if (payload.hasMore === false || (Number.isFinite(total) && total > 0 && rows.length >= total)) break;
    if (!pageRows.length) {
      if (payload.hasMore === true || (Number.isFinite(total) && total > rows.length)) complete = false;
      break;
    }
    if (observedPageSize !== null && pageRows.length < observedPageSize) {
      if (payload.hasMore === true || (Number.isFinite(total) && total > rows.length)) complete = false;
      break;
    }
    pageNum += 1;
  }
  const events = rows.map(row => {
    const eventDate = row.announcementTime ? tsDateStr(new Date(Number(row.announcementTime))) : dateText(row.announcementDate);
    const title = String(row.announcementTitle || '').replace(/<[^>]+>/g, '');
    const url = row.adjunctUrl ? announcementUrl('https://static.cninfo.com.cn/', row.adjunctUrl) : '';
    return { source: 'cninfo', source_number: officialAnnouncementNumber(row), stock_code: announcementStockCode(row, market), event_date: eventDate,
      title, url, category: eventCategory(title), is_official: true, raw: row };
  }).filter(event => event.url && (!searchKey || event.title.includes(searchKey)));
  return { events: dedupeAnnouncementEvents(events), complete, fetched: rows.length };
}

async function fetchTushareAnnouncementBatch(startDate, endDate) {
  const data = await tushareQuery('anns_d', { start_date: dateText(startDate), end_date: dateText(endDate) }, 'ts_code,ann_date,title,url', { allowEmpty: true });
  const rows = tsRows(data);
  const events = rows.map(row => ({ source: 'tushare', source_number: `${row.ts_code || ''}:${row.ann_date || ''}:${row.title || ''}`,
    stock_code: announcementStockCode(row, String(row.ts_code || '').endsWith('.SH') ? 'SH' : 'SZ'), event_date: dateText(row.ann_date),
    title: String(row.title || ''), url: String(row.url || ''), category: eventCategory(row.title || ''), is_official: false, raw: row }))
    .filter(event => event.event_date && event.title && event.url);
  return { events: dedupeAnnouncementEvents(events), complete: true, fetched: rows.length };
}

async function fetchSzseLatestReport(tsCode, startDate, endDate) {
  const reports = await fetchSzseEvents(tsCode, startDate, endDate, '年度报告');
  return reports.filter(row => !/摘要/.test(row.title)).sort((a,b) => String(b.event_date).localeCompare(String(a.event_date)))[0] || null;
}

async function fetchXueqiuEvents(tsCode, startDate, endDate) {
  try {
    const symbol = await resolveProviderCode({ canonicalCode: tsCode, sourceCode: 'xueqiu', identifierType: 'symbol' });
    if (!symbol) return [];
    const url = `https://xueqiu.com/statuses/search.json?count=20&comment=0&symbol=${symbol}&hl=0&source=all&sort=time&page=1&q=`;
    const payload = await requestJson(url, { headers: { Referer: `https://xueqiu.com/S/${symbol}` } });
    return (payload.list || payload.statuses || []).map(row => ({
      source: 'xueqiu', event_date: tsDateStr(new Date(row.created_at || row.createdAt || Date.now())),
      title: String(row.title || row.text || '').replace(/<[^>]+>/g, '').slice(0, 160),
      url: row.id ? `https://xueqiu.com/${row.user_id || row.user?.id || ''}/${row.id}` : '',
      category: '市场讨论', is_official: false, raw: row
    })).filter(row => row.event_date >= startDate && row.event_date <= endDate && row.title);
  } catch (_) { return []; }
}

async function fetchGubaEvents(tsCode, startDate, endDate) {
  try {
    const code = await resolveProviderCode({ canonicalCode: tsCode, sourceCode: 'eastmoney', identifierType: 'guba_code' });
    if (!code) return [];
    const url = `https://gbapi.eastmoney.com/webarticlelist/api/Article/Articlelist?code=${code}&sorttype=1&ps=20&from=CommonBaPost`;
    const payload = await requestJson(url, { headers: { Referer: `https://guba.eastmoney.com/list,${code}.html` } });
    const rows = payload.re || payload.data?.re || payload.data || [];
    return (Array.isArray(rows) ? rows : []).map(row => ({
      source: 'guba', event_date: dateText(row.post_publish_time || row.publish_time || row.create_time),
      title: String(row.post_title || row.title || '').slice(0, 160),
      url: row.post_id ? `https://guba.eastmoney.com/news,${code},${row.post_id}.html` : '',
      category: '市场讨论', is_official: false, raw: row
    })).filter(row => row.event_date >= startDate && row.event_date <= endDate && row.title);
  } catch (_) { return []; }
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
    // 由 saveAux 按唯一键幂等 upsert，只写新增/修订行（首次无水位则保留全量）。重叠窗口仅在此计算一次（latestDividendEndDate 只提供原始水位）。
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

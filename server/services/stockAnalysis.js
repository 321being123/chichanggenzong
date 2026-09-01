const https = require('https');
const crypto = require('crypto');
const { pool } = require('../db/connection');
const { tushareQuery, tsRows, toTsCode, tsDateStr } = require('./market');
const { withExternalCallGuard } = require('./externalCallGuard');
const { fetchTencentQuotes, normalizeCode } = require('./tencentQuote');
const { persistCollectedData, saveCollectedEvents, saveAnalysisResults } = require('./financialDataArchitecture');
const { statementApiFields } = require('./stockStatements');
const { evaluateStockFreshness, isoDateSafe } = require('./analysisFreshness');
const { datasetScope, getDatasetCursors, isDatasetFresh, markDatasetSuccess } = require('./datasetCursors');
const { resolveProviderCode } = require('./securityIdentity');

const FORMULA_VERSION = '1';
const DAY = 86400000;
// 允许按 TTL 跳过上游的低频数据组。行情、三表、财务指标不在此列：
// 行情已有 14 天重叠增量，财务有 120 天更正窗口，跳过会改变分析结论。
const GATED_STOCK_DATASETS = ['stock_basic', 'stock_dividend', 'stock_forecast', 'stock_industry', 'stock_controller'];
const REPORT_TABLES = {
  income: 'stock_income_statements',
  balancesheet: 'stock_balance_sheets',
  cashflow: 'stock_cashflow_statements',
};

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

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

function dateText(value) {
  return String(value || '').replace(/-/g, '').slice(0, 8);
}

function isoDate(value) {
  const text = dateText(value);
  return /^\d{8}$/.test(text) ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}` : '';
}

function yearsAgo(days) {
  return tsDateStr(new Date(Date.now() - days * DAY));
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
    return row ? { industry: row.l3_name || row.l2_name || row.l1_name || '', industry_system: '申万2021', industry_level: row.l3_name ? '三级' : (row.l2_name ? '二级' : '一级'), industry_path: [row.l1_name,row.l2_name,row.l3_name].filter(Boolean) } : null;
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
  await pool.query(
    `INSERT INTO stock_analysis_stocks (ts_code,symbol,name,industry,market,list_date,data)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
     ON CONFLICT (ts_code) DO UPDATE SET symbol=EXCLUDED.symbol,name=EXCLUDED.name,
       industry=EXCLUDED.industry,market=EXCLUDED.market,list_date=EXCLUDED.list_date,
       data=EXCLUDED.data,fetched_at=now()`,
    [row.ts_code, row.symbol || row.ts_code.slice(0, 6), row.name || '', row.industry || '', row.market || '', row.list_date || null, JSON.stringify(row)]
  );
}

async function saveReports(kind, tsCode, rows) {
  const table = REPORT_TABLES[kind];
  if (!table) throw new Error('未知财报类型');
  for (const row of rows) {
    if (!row.end_date) continue;
    await pool.query(
      `INSERT INTO ${table}
       (ts_code,version_key,end_date,ann_date,f_ann_date,report_type,comp_type,update_flag,data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
       ON CONFLICT (ts_code,version_key) DO UPDATE SET data=EXCLUDED.data,fetched_at=now()`,
      [tsCode, versionKey(row), row.end_date, row.ann_date || null, row.f_ann_date || null,
        row.report_type || null, row.comp_type || null, row.update_flag || null, JSON.stringify(row)]
    );
  }
}

async function saveAux(table, tsCode, rows) {
  const allowed = new Set(['stock_financial_indicators', 'stock_dividends', 'stock_forecasts']);
  if (!allowed.has(table)) throw new Error('未知辅助数据表');
  for (const row of rows) {
    if (table === 'stock_financial_indicators' && !row.end_date) continue;
    const common = [tsCode, versionKey(row), row.end_date || null, row.ann_date || null];
    if (table === 'stock_dividends') {
      await pool.query(
        `INSERT INTO stock_dividends (ts_code,version_key,end_date,ann_date,ex_date,pay_date,div_proc,data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
         ON CONFLICT (ts_code,version_key) DO UPDATE SET data=EXCLUDED.data,fetched_at=now()`,
        [...common, row.ex_date || null, row.pay_date || null, row.div_proc || null, JSON.stringify(row)]
      );
    } else {
      await pool.query(
        `INSERT INTO ${table} (ts_code,version_key,end_date,ann_date,data)
         VALUES ($1,$2,$3,$4,$5::jsonb)
         ON CONFLICT (ts_code,version_key) DO UPDATE SET data=EXCLUDED.data,fetched_at=now()`,
        [...common, JSON.stringify(row)]
      );
    }
  }
}

async function saveValuations(tsCode, dailyRows, basicRows, factorRows) {
  const daily = new Map(dailyRows.map(r => [r.trade_date, r]));
  const basic = new Map(basicRows.map(r => [r.trade_date, r]));
  const factors = new Map(factorRows.map(r => [r.trade_date, r]));
  const dates = new Set([...daily.keys(), ...basic.keys(), ...factors.keys()]);
  for (const tradeDate of dates) {
    const d = daily.get(tradeDate) || {}, b = basic.get(tradeDate) || {}, a = factors.get(tradeDate) || {};
    await pool.query(
      `INSERT INTO stock_daily_valuations
       (ts_code,trade_date,close,adj_factor,pe,pe_ttm,pb,dv_ttm,total_share,total_mv,float_share,free_share,circ_mv)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (ts_code,trade_date) DO UPDATE SET
       close=COALESCE(EXCLUDED.close,stock_daily_valuations.close),
       adj_factor=COALESCE(EXCLUDED.adj_factor,stock_daily_valuations.adj_factor),
       pe=EXCLUDED.pe,pe_ttm=EXCLUDED.pe_ttm,pb=EXCLUDED.pb,dv_ttm=EXCLUDED.dv_ttm,
       total_share=COALESCE(EXCLUDED.total_share,stock_daily_valuations.total_share),
       total_mv=COALESCE(EXCLUDED.total_mv,stock_daily_valuations.total_mv),
       float_share=COALESCE(EXCLUDED.float_share,stock_daily_valuations.float_share),
       free_share=COALESCE(EXCLUDED.free_share,stock_daily_valuations.free_share),
       circ_mv=COALESCE(EXCLUDED.circ_mv,stock_daily_valuations.circ_mv),fetched_at=now()`,
      [tsCode, tradeDate, finite(d.close), finite(a.adj_factor), finite(b.pe), finite(b.pe_ttm), finite(b.pb),
        finite(b.dv_ttm), finite(b.total_share), finite(b.total_mv), finite(b.float_share), finite(b.free_share), finite(b.circ_mv)]
    );
  }
}

async function setSyncState(tsCode, dataset, successDate, error) {
  await pool.query(
    `INSERT INTO stock_data_sync_state (ts_code,dataset,last_success_date,last_attempt_at,last_error)
     VALUES ($1,$2,$3,now(),$4)
     ON CONFLICT (ts_code,dataset) DO UPDATE SET
       last_success_date=COALESCE(EXCLUDED.last_success_date,stock_data_sync_state.last_success_date),
       last_attempt_at=now(),last_error=EXCLUDED.last_error,updated_at=now()`,
    [tsCode, dataset, successDate || null, error || '']
  );
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
  if (!stock || !stock.orgId) return [];
  const events = [];
  for (let page = 1; page <= 5; page++) {
    const body = new URLSearchParams({ pageNum: String(page), pageSize: '100', stock: `${code},${stock.orgId}`, searchkey: searchKey,
      tabName: 'fulltext', column: 'szse', plate: stockExchange(tsCode).toLowerCase(),
      seDate: `${isoDate(startDate)}~${isoDate(endDate)}` }).toString();
    const payload = await requestJson('https://www.cninfo.com.cn/new/hisAnnouncement/query', { method: 'POST', headers, body });
    const rows = payload.announcements || [];
    for (const row of rows) {
      const eventDate = row.announcementTime ? tsDateStr(new Date(Number(row.announcementTime))) : dateText(row.announcementDate);
      const title = String(row.announcementTitle || '').replace(/<[^>]+>/g, '');
      const url = row.adjunctUrl ? `https://static.cninfo.com.cn/${String(row.adjunctUrl).replace(/^\//, '')}` : '';
      events.push({ source: 'cninfo', source_number: officialAnnouncementNumber(row), stock_code: announcementStockCode(row, stockExchange(tsCode)), event_date: eventDate, title, url, category: eventCategory(title), is_official: true, raw: row });
    }
    if (!payload.hasMore || rows.length === 0) break;
  }
  if (searchKey && !events.length && options.allowBroadFallback !== false) {
    const allEvents = await fetchCninfoEvents(tsCode, startDate, endDate, '', options);
    return allEvents.filter(event => String(event.title || '').includes(searchKey));
  }
  return [...new Map(events.map(event => [`${event.source}:${event.source_number || event.url || `${event.event_date}:${event.title}`}`, event])).values()];
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

async function fetchSseEvents(tsCode, startDate, endDate, keyword = '') {
  if (!String(tsCode || '').endsWith('.SH')) return [];
  const params = new URLSearchParams({ isPagination: 'true', productId: tsCode.slice(0, 6), keyWord: keyword,
    securityType: '0101,120100,020100,020200,120200', beginDate: isoDate(startDate), endDate: isoDate(endDate),
    'pageHelp.pageSize': '100', 'pageHelp.pageNo': '1', 'pageHelp.beginPage': '1', 'pageHelp.endPage': '1' });
  const payload = await requestJson(`https://query.sse.com.cn/security/stock/queryCompanyBulletin.do?${params.toString()}`,
    { headers: { Referer: 'https://www.sse.com.cn/' } });
  const rows = payload && payload.pageHelp && Array.isArray(payload.pageHelp.data) ? payload.pageHelp.data : [];
  const start = isoDate(startDate), end = isoDate(endDate);
  return rows.filter(row => row.URL && (!start || row.SSEDATE >= start) && (!end || row.SSEDATE <= end)).map(mapSseAnnouncement);
}

async function fetchSzseEvents(tsCode, startDate, endDate, keyword = '') {
  if (!String(tsCode || '').endsWith('.SZ')) return [];
  const pageSize = 100;
  const rows = [];
  for (let pageNum = 1; pageNum <= 20; pageNum += 1) {
    const body = JSON.stringify({ seDate: [isoDate(startDate), isoDate(endDate)], stock: [tsCode.slice(0, 6)],
      channelCode: ['listedNotice_disc'], pageSize, pageNum });
    const payload = await requestJson('https://www.szse.cn/api/disc/announcement/annList?random=0.1', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Referer: 'https://www.szse.cn/disclosure/listed/notice/index.html',
        'X-Requested-With': 'XMLHttpRequest' }, body });
    const pageRows = Array.isArray(payload.data) ? payload.data : [];
    rows.push(...pageRows);
    if (pageNum * pageSize >= Number(payload.announceCount || pageRows.length) || !pageRows.length) break;
  }
  return rows.filter(row => row.attachPath && (!keyword || String(row.title || '').includes(keyword))).map(mapSzseAnnouncement);
}

// 交易所公告支持按市场/日期批量查询。返回 complete=false 时说明到达页数上限，调用方必须走备源，不能把部分结果当成完整成功。
async function fetchSseEventsBatch(startDate, endDate, keyword = '') {
  const pageSize = 100, maxPages = 20, rows = [];
  let complete = true;
  for (let pageNo = 1; pageNo <= maxPages; pageNo += 1) {
    const params = new URLSearchParams({ isPagination: 'true', productId: '', keyWord: keyword,
      securityType: '0101,120100,020100,020200,120200', beginDate: isoDate(startDate), endDate: isoDate(endDate),
      'pageHelp.pageSize': String(pageSize), 'pageHelp.pageNo': String(pageNo),
      'pageHelp.beginPage': String(pageNo), 'pageHelp.endPage': String(pageNo) });
    const payload = await requestJson(`https://query.sse.com.cn/security/stock/queryCompanyBulletin.do?${params.toString()}`,
      { headers: { Referer: 'https://www.sse.com.cn/' } });
    const pageRows = payload && payload.pageHelp && Array.isArray(payload.pageHelp.data) ? payload.pageHelp.data : [];
    rows.push(...pageRows);
    if (!pageRows.length || pageRows.length < pageSize) break;
    if (pageNo === maxPages) complete = false;
  }
  return { events: dedupeAnnouncementEvents(rows.filter(row => row.URL).map(mapSseAnnouncement)), complete, fetched: rows.length };
}

async function fetchSzseEventsBatch(startDate, endDate, keyword = '') {
  const pageSize = 100, maxPages = 20, rows = [];
  let complete = true;
  for (let pageNum = 1; pageNum <= maxPages; pageNum += 1) {
    const body = JSON.stringify({ seDate: [isoDate(startDate), isoDate(endDate)], stock: [],
      channelCode: ['listedNotice_disc'], pageSize, pageNum });
    const payload = await requestJson('https://www.szse.cn/api/disc/announcement/annList?random=0.1', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Referer: 'https://www.szse.cn/disclosure/listed/notice/index.html',
        'X-Requested-With': 'XMLHttpRequest' }, body });
    const pageRows = Array.isArray(payload.data) ? payload.data : [];
    rows.push(...pageRows);
    const announceCount = Number(payload.announceCount);
    if (!pageRows.length || pageRows.length < pageSize
      || (Number.isFinite(announceCount) && announceCount > 0 && pageNum * pageSize >= announceCount)) break;
    if (pageNum === maxPages) complete = false;
  }
  const events = rows.filter(row => row.attachPath && (!keyword || String(row.title || '').includes(keyword))).map(mapSzseAnnouncement);
  return { events: dedupeAnnouncementEvents(events), complete, fetched: rows.length };
}

async function fetchCninfoEventsBatch(startDate, endDate, market, searchKey = '') {
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Referer: 'https://www.cninfo.com.cn/', 'X-Requested-With': 'XMLHttpRequest' };
  const pageSize = 100, maxPages = 5, rows = [];
  let complete = true;
  for (let pageNum = 1; pageNum <= maxPages; pageNum += 1) {
    const body = new URLSearchParams({ pageNum: String(pageNum), pageSize: String(pageSize), stock: '', searchkey: searchKey,
      tabName: 'fulltext', column: market === 'SH' ? 'sse' : 'szse', plate: market === 'SH' ? 'sh' : 'sz',
      seDate: `${isoDate(startDate)}~${isoDate(endDate)}` }).toString();
    const payload = await requestJson('https://www.cninfo.com.cn/new/hisAnnouncement/query', { method: 'POST', headers, body });
    const pageRows = Array.isArray(payload.announcements) ? payload.announcements : [];
    rows.push(...pageRows);
    if (!payload.hasMore || !pageRows.length || pageRows.length < pageSize) break;
    if (pageNum === maxPages) complete = false;
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
  const state = await pool.query(`SELECT c.last_success_date FROM ops.sync_cursors c JOIN core.instruments i ON i.instrument_id=c.instrument_id WHERE i.canonical_code=$1 AND c.dataset_code='events'`, [tsCode]);
  const last = state.rows[0] && dateText(state.rows[0].last_success_date);
  const start = eventRefreshStart(last, today);
  try {
    const sources = await Promise.allSettled([
      fetchCninfoEvents(tsCode, start, today),
      tsCode.endsWith('.SH') ? fetchSseEvents(tsCode, start, today)
        : tsCode.endsWith('.SZ') ? fetchSzseEvents(tsCode, start, today) : Promise.resolve([])
    ]);
    const unique = mergeOfficialEventSources(sources);
    await saveEvents(tsCode, unique);
    await pool.query(`INSERT INTO ops.sync_cursors(instrument_id,company_id,scope_key,dataset_code,last_success_date,last_attempt_at,last_error)
      SELECT i.instrument_id,ci.company_id,i.instrument_id||':'||ci.company_id,'events',$2,now(),'' FROM core.instruments i JOIN core.company_instruments ci ON ci.instrument_id=i.instrument_id WHERE i.canonical_code=$1
      ON CONFLICT(scope_key,dataset_code) DO UPDATE SET last_success_date=EXCLUDED.last_success_date,last_attempt_at=now(),last_error='',updated_at=now()`,[tsCode,isoDate(today)]);
  } catch (error) {
    console.warn(`[stock-analysis] 公司事件刷新失败 ${tsCode}:`,error.message);
    throw new Error(`公司公告刷新失败：${error.message}`);
  }
}

function selectLatestByPeriod(rows, today) {
  const map = new Map();
  rows.filter(row => row.end_date && dateText(row.f_ann_date || row.ann_date) <= today)
    .sort((a, b) => {
      const consolidated = (String(b.report_type) === '1' ? 1 : 0) - (String(a.report_type) === '1' ? 1 : 0);
      return consolidated || String(b.f_ann_date || b.ann_date || '').localeCompare(String(a.f_ann_date || a.ann_date || ''));
    }).forEach(row => { if (!map.has(row.end_date)) map.set(row.end_date, row); });
  return map;
}

function signedRatio(numerator, denominator) {
  const a = finite(numerator), b = finite(denominator);
  return a == null || b == null || b === 0 ? null : a / b;
}

function growthMetric(start, end, years) {
  const a = finite(start), b = finite(end);
  if (a == null || b == null || a === 0) return { value: null, method: a === 0 ? '起点为0，无法计算' : '数据不足' };
  if (a > 0 && b > 0) return { value: Math.pow(b / a, 1 / years) - 1, method: 'CAGR' };
  return { value: (b - a) / Math.abs(a), method: '带符号变化率，非CAGR' };
}

function threeYearAverageGrowth(start, end) {
  const a = finite(start), b = finite(end);
  if (a == null || b == null || a === 0) return { value: null, method: a === 0 ? '早期三年均值为0，无法计算' : '数据不足' };
  return { value: (b - a) / a, method: '（近期三年均值－十年前三年均值）÷十年前三年均值' };
}

function valuationComparator(mode) {
  if (mode !== 'pe') return (a, b) => a - b;
  return (a, b) => {
    const aNegative = a < 0, bNegative = b < 0;
    if (aNegative !== bNegative) return aNegative ? 1 : -1;
    return a - b;
  };
}

function valuationSamples(values, mode) {
  return values.map(finite).filter(v => v != null && (mode === 'pe' ? v !== 0 : v > 0)).sort(valuationComparator(mode));
}

function percentile(current, values, mode) {
  const valid = valuationSamples(values, mode);
  const c = finite(current);
  const currentValid = c != null && (mode === 'pe' ? c !== 0 : c > 0);
  if (!currentValid) return { value: null, samples: valid.length, reason: '当前值无效，不参与估值分位点计算' };
  if (!valid.length) return { value: null, samples: 0, reason: '没有有效样本' };
  if (valid.length === 1) return { value: 0, samples: 1, reason: '' };
  const compare = valuationComparator(mode);
  const rank = valid.filter(v => compare(v, c) < 0).length;
  return { value: Math.max(0, Math.min(1, rank / (valid.length - 1))), samples: valid.length, reason: '' };
}

function selectDividendPlans(rows) {
  const valid=(rows||[]).filter(row=>Math.max(finite(row.cash_div_tax)||0,finite(row.cash_div)||0)>0);
  const stage=row=>/实施/.test(String(row.div_proc||''))?3:/股东大会通过/.test(String(row.div_proc||''))?2:/预案/.test(String(row.div_proc||''))?1:0,map=new Map();
  valid.forEach(row=>{const key=String(row.end_date||'');if(!key)return;const current=map.get(key);if(!current||stage(row)>stage(current)||(stage(row)===stage(current)&&String(row.ann_date||'')>String(current.ann_date||'')))map.set(key,row);});
  return [...map.values()];
}

function quantile(values, ratio, mode) {
  const valid=valuationSamples(values,mode);
  if(!valid.length)return null;
  const index=Math.max(0,Math.min(valid.length-1,Math.floor((valid.length-1)*ratio)));
  return valid[index];
}

function average(values) {
  const rows = values.map(finite).filter(v => v != null);
  return rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : null;
}

function latestAnnualRows(map) {
  return [...map.values()].filter(row => String(row.end_date).endsWith('1231')).sort((a, b) => b.end_date.localeCompare(a.end_date));
}

function ttmValue(map, field) {
  const rows = [...map.values()].sort((a, b) => b.end_date.localeCompare(a.end_date));
  const latest = rows[0];
  if (!latest) return null;
  if (latest.end_date.endsWith('1231')) return finite(latest[field]);
  const year = Number(latest.end_date.slice(0, 4));
  const annual = map.get(`${year - 1}1231`), prior = map.get(`${year - 1}${latest.end_date.slice(4)}`);
  const values = [latest, annual, prior].map(row => row && finite(row[field]));
  return values.every(v => v != null) ? values[0] + values[1] - values[2] : null;
}

function financialAverage(rows, field, count) {
  return average(rows.slice(0, count).map(row => row[field]));
}

async function loadData(tsCode) {
  const [meta, income, balance, cashflow, indicators, dividends, forecasts, valuations, events] = await Promise.all([
    pool.query(`SELECT i.canonical_code ts_code,i.name,i.market,to_char(i.list_date,'YYYYMMDD') list_date,
      COALESCE(n.industry_name,'') industry,i.raw_data data FROM core.instruments i
      JOIN core.company_instruments ci ON ci.instrument_id=i.instrument_id
      LEFT JOIN core.company_industry_memberships m ON m.company_id=ci.company_id AND m.is_current
      LEFT JOIN core.industry_nodes n ON n.industry_node_id=m.industry_node_id WHERE i.canonical_code=$1 LIMIT 1`,[tsCode]),
    pool.query(`SELECT r.raw_payload data FROM fundamental.financial_reports r JOIN core.company_instruments ci ON ci.company_id=r.company_id JOIN core.instruments i ON i.instrument_id=ci.instrument_id WHERE i.canonical_code=$1 AND r.report_kind='income'`,[tsCode]),
    pool.query(`SELECT r.raw_payload data FROM fundamental.financial_reports r JOIN core.company_instruments ci ON ci.company_id=r.company_id JOIN core.instruments i ON i.instrument_id=ci.instrument_id WHERE i.canonical_code=$1 AND r.report_kind='balance'`,[tsCode]),
    pool.query(`SELECT r.raw_payload data FROM fundamental.financial_reports r JOIN core.company_instruments ci ON ci.company_id=r.company_id JOIN core.instruments i ON i.instrument_id=ci.instrument_id WHERE i.canonical_code=$1 AND r.report_kind='cashflow'`,[tsCode]),
    pool.query(`SELECT r.raw_payload data FROM fundamental.financial_reports r JOIN core.company_instruments ci ON ci.company_id=r.company_id JOIN core.instruments i ON i.instrument_id=ci.instrument_id WHERE i.canonical_code=$1 AND r.report_kind='indicator'`,[tsCode]),
    pool.query(`SELECT a.raw_payload data FROM fundamental.corporate_actions a JOIN core.instruments i ON i.instrument_id=a.instrument_id WHERE i.canonical_code=$1 AND a.action_type='dividend'`,[tsCode]),
    pool.query(`SELECT g.raw_payload data FROM fundamental.earnings_guidance g JOIN core.company_instruments ci ON ci.company_id=g.company_id JOIN core.instruments i ON i.instrument_id=ci.instrument_id WHERE i.canonical_code=$1`,[tsCode]),
    pool.query(`SELECT to_char(v.trade_date,'YYYYMMDD') trade_date,b.close,a.adj_factor,v.pe_static pe,v.pe_ttm,v.pb,v.dividend_yield_ttm*100 dv_ttm,
      s.total_shares/10000 total_share,v.total_market_cap/10000 total_mv,s.circulating_shares/10000 float_share,s.free_float_shares/10000 free_share,v.circulating_market_cap/10000 circ_mv
      FROM market.daily_valuations v JOIN core.instruments i ON i.instrument_id=v.instrument_id
      LEFT JOIN market.daily_bars b ON b.instrument_id=v.instrument_id AND b.trade_date=v.trade_date AND b.source_id=v.source_id
      LEFT JOIN market.adjustment_factors a ON a.instrument_id=v.instrument_id AND a.trade_date=v.trade_date AND a.source_id=v.source_id
      LEFT JOIN LATERAL (SELECT * FROM market.share_capital_history s WHERE s.instrument_id=v.instrument_id AND s.effective_date<=v.trade_date ORDER BY s.effective_date DESC LIMIT 1) s ON true
      WHERE i.canonical_code=$1 ORDER BY v.trade_date`,[tsCode]),
    pool.query(`SELECT ds.source_code source,to_char(e.event_date,'YYYYMMDD') event_date,e.title,d.url,e.event_type category,e.is_official
      FROM event.company_events e JOIN ops.data_sources ds ON ds.source_id=e.source_id LEFT JOIN event.documents d ON d.document_id=e.document_id
      JOIN core.company_instruments ci ON ci.company_id=e.company_id JOIN core.instruments i ON i.instrument_id=ci.instrument_id
      WHERE i.canonical_code=$1 AND e.is_official=true AND e.event_date>=CURRENT_DATE-interval '1 year' ORDER BY e.event_date DESC LIMIT 200`,[tsCode])
  ]);
  return { meta: meta.rows[0], income: income.rows.map(r => r.data), balance: balance.rows.map(r => r.data),
    cashflow: cashflow.rows.map(r => r.data), indicators: indicators.rows.map(r => r.data),
    dividends: dividends.rows.map(r => r.data), forecasts: forecasts.rows.map(r => r.data), valuations: valuations.rows, events: events.rows };
}

async function buildAnalysis(tsCode, options = {}) {
  const data = await loadData(tsCode);
  if (!data.meta || !data.income.length) throw new Error('股票尚未完成财务建档');
  const today = tsDateStr(new Date());
  const incomeMap = selectLatestByPeriod(data.income, today);
  const balanceMap = selectLatestByPeriod(data.balance, today);
  const indicatorMap = selectLatestByPeriod(data.indicators, today);
  const cashMap = selectLatestByPeriod(data.cashflow, today);
  const annualIncome = latestAnnualRows(incomeMap), annualCash = latestAnnualRows(cashMap);
  const annualBalance = latestAnnualRows(balanceMap);
  const latestIncome = [...incomeMap.values()].sort((a, b) => b.end_date.localeCompare(a.end_date))[0];
  const latestBalance = balanceMap.get(latestIncome && latestIncome.end_date) || [...balanceMap.values()].sort((a, b) => b.end_date.localeCompare(a.end_date))[0] || {};
  const latestIndicator = indicatorMap.get(latestBalance.end_date) || [...indicatorMap.values()].sort((a, b) => b.end_date.localeCompare(a.end_date))[0] || {};
  const latestValuation = data.valuations[data.valuations.length - 1] || {};
  const quoteMap = options.readOnly ? new Map() : await fetchTencentQuotes([tsCode]);
  const rawQuote = quoteMap.get(normalizeCode(tsCode));
  // 腾讯旧缓存（上游失败保留）不能当实时行情：只有报价时间是当天，才算有效实时报价
  const liveQuote = rawQuote && isoDateSafe(rawQuote.quote_time) === isoDate(today) ? rawQuote : null;
  const quote = liveQuote;
  const currentPrice = finite(liveQuote && liveQuote.price) || finite(latestValuation.close);
  const totalShare = finite(latestValuation.total_share);
  const marketCap = currentPrice != null && totalShare != null ? currentPrice * totalShare * 10000 : finite(latestValuation.total_mv) == null ? null : finite(latestValuation.total_mv) * 10000;
  const floatShare = finite(latestValuation.float_share), freeShare = finite(latestValuation.free_share);
  const circulatingMarketCap = currentPrice != null && floatShare != null ? currentPrice * floatShare * 10000 : finite(latestValuation.circ_mv) == null ? null : finite(latestValuation.circ_mv) * 10000;
  const freeFloatMarketCap = currentPrice != null && freeShare != null ? currentPrice * freeShare * 10000 : null;
  const ttmProfit = ttmValue(incomeMap, 'n_income_attr_p');
  const staticProfit = annualIncome[0] && finite(annualIncome[0].n_income_attr_p);
  const avg3Profit = average(annualIncome.slice(0, 3).map(row => row.n_income_attr_p));
  const forecast = data.forecasts.filter(row => dateText(row.ann_date) <= today).sort((a, b) => String(b.ann_date).localeCompare(String(a.ann_date)))[0];
  let forecastProfit = forecast ? average([forecast.net_profit_min, forecast.net_profit_max]) : null;
  if (forecastProfit == null && forecast && finite(forecast.last_parent_net) != null) {
    const pct = average([forecast.p_change_min, forecast.p_change_max]);
    if (pct != null) forecastProfit = finite(forecast.last_parent_net) * (1 + pct / 100);
  }
  // Tushare forecast 的利润金额单位为万元；三张财报金额单位为元，计算前统一为元。
  if (forecastProfit != null) forecastProfit *= 10000;
  const equity = finite(latestBalance.total_hldr_eqy_exc_min_int), goodwill = finite(latestBalance.goodwill) || 0;
  const officialRoa = finite(indicatorMap.get(annualIncome[0]?.end_date)?.roa);
  const averageAnnualAssets = average([annualBalance[0]?.total_assets, annualBalance[1]?.total_assets]);
  const calculatedRoa = officialRoa == null && staticProfit != null && averageAnnualAssets ? staticProfit / averageAnnualAssets * 100 : officialRoa;
  const chartValuations = data.valuations.filter(row => row.trade_date >= yearsAgo(10958));
  const positiveValuations = chartValuations.filter(row => row.trade_date >= yearsAgo(3653));
  const latestFactor = finite(latestValuation.adj_factor);
  const qfqPrices = positiveValuations.map(row => {
    const close = finite(row.close), factor = finite(row.adj_factor);
    return close != null && factor != null && latestFactor ? close * factor / latestFactor : close;
  });
  const chartQfqPrices=chartValuations.map(row=>{const close=finite(row.close),factor=finite(row.adj_factor);return close!=null&&factor!=null&&latestFactor?close*factor/latestFactor:close;});
  const valuationHistory=chartValuations.map((row,index)=>({date:isoDate(row.trade_date),price:finite(chartQfqPrices[index]),pe:finite(row.pe_ttm),pb:finite(row.pb)})).filter((row,index)=>index%5===0||index===chartValuations.length-1);
  const percentileBands={price:[.2,.5,.8].map(x=>quantile(qfqPrices,x)),pe:[.2,.5,.8].map(x=>quantile(positiveValuations.map(row=>row.pe_ttm),x,'pe')),pb:[.2,.5,.8].map(x=>quantile(positiveValuations.map(row=>row.pb),x))};
  const earliestValuation = data.valuations.find(row => finite(row.close) != null && finite(row.adj_factor) != null);
  const earliestAdjustedPrice = earliestValuation && latestFactor ? finite(earliestValuation.close) * finite(earliestValuation.adj_factor) / latestFactor : null;
  const listedDays = earliestValuation ? Math.max(1, (Date.now() - new Date(`${isoDate(earliestValuation.trade_date)}T00:00:00+08:00`).getTime()) / DAY) : null;
  const annualizedSinceListing = earliestAdjustedPrice > 0 && currentPrice > 0 && listedDays > 0 ? Math.pow(currentPrice / earliestAdjustedPrice, 365.25 / listedDays) - 1 : null;
  const peTtm = signedRatio(marketCap, ttmProfit), peStatic = signedRatio(marketCap, staticProfit), peAvg3 = signedRatio(marketCap, avg3Profit);
  const pb = signedRatio(marketCap, equity), pbExGoodwill = signedRatio(marketCap, equity == null ? null : equity - goodwill);
  const displayDividends=selectDividendPlans(data.dividends);
  function sharesAt(date) {
    const target = dateText(date);
    for (let i = data.valuations.length - 1; i >= 0; i--) if (data.valuations[i].trade_date <= target && finite(data.valuations[i].total_share) != null) return finite(data.valuations[i].total_share);
    return null;
  }
  const dividendItem = row => ({ row, cashPerShare: finite(row.cash_div_tax) != null ? finite(row.cash_div_tax) : finite(row.cash_div), amount: (() => { const shares = sharesAt(row.ex_date || row.pay_date || row.ann_date) || finite(row.base_share); const cash = finite(row.cash_div_tax) != null ? finite(row.cash_div_tax) : finite(row.cash_div); return shares == null || cash == null ? null : cash * shares * 10000; })() });
  const actualDividendRows = displayDividends.filter(row => /实施/.test(String(row.div_proc||''))).map(dividendItem);
  const dividendRows = displayDividends.map(dividendItem);
  const oneYearAgo = yearsAgo(365);
  const dividend12m = actualDividendRows.filter(item => dateText(item.row.ex_date || item.row.pay_date) >= oneYearAgo).reduce((sum, item) => sum + (item.amount || 0), 0);
  const latestAnnualYear = annualIncome[0] ? annualIncome[0].end_date.slice(0, 4) : '';
  const annualDividend = dividendRows.filter(item => String(item.row.end_date || '').startsWith(latestAnnualYear)).reduce((sum, item) => sum + (item.amount || 0), 0);
  const cumulativeDividend = actualDividendRows.reduce((sum, item) => sum + (item.amount || 0), 0);
  const cumulativeProfit = annualIncome.reduce((sum, row) => sum + (finite(row.n_income_attr_p) || 0), 0);
  const cumulativePayoutRatio = signedRatio(cumulativeDividend, cumulativeProfit);
  const ttmEarningsYield = signedRatio(ttmProfit, marketCap);
  const averageDividendYield = cumulativePayoutRatio == null || ttmEarningsYield == null ? null : cumulativePayoutRatio * ttmEarningsYield;
  const dividendByYear = new Map();
  dividendRows.forEach(item => {
    const year = String(item.row.end_date || '').slice(0, 4);
    if (year && item.amount != null) dividendByYear.set(year, (dividendByYear.get(year) || 0) + item.amount);
  });
  const years = annualIncome.map(row => {
    const year = row.end_date.slice(0, 4), profit = finite(row.n_income_attr_p);
    const dividend = dividendByYear.has(year) ? dividendByYear.get(year) : 0;
    const dividend_details = dividendRows.filter(item => String(item.row.end_date || '').slice(0, 4) === year).map(item => ({
      ann_date: dateText(item.row.ann_date || item.row.imp_ann_date), ex_date: dateText(item.row.ex_date), pay_date: dateText(item.row.pay_date),
      cash_div: item.cashPerShare, amount: item.amount, div_proc:item.row.div_proc||''
    })).sort((a, b) => String(a.ex_date || a.pay_date || a.ann_date).localeCompare(String(b.ex_date || b.pay_date || b.ann_date)));
    return { year, report_ann_date: dateText(row.f_ann_date || row.ann_date), profit, dividend, dividend_details, payout_ratio: signedRatio(dividend, profit) };
  });
  const dividendYears = new Set(displayDividends.filter(row=>(finite(row.cash_div_tax)||finite(row.cash_div)||0)>0).map(row => String(row.end_date || '').slice(0, 4)));
  const stabilityYears = years.slice(0, 10);
  const noProfitYears = stabilityYears.filter(row => row.profit == null || row.profit <= 0).map(row => row.year);
  const noDividendYears = stabilityYears.filter(row => !dividendYears.has(row.year)).map(row => row.year);
  const reasonYear = noProfitYears.length === 1 ? noProfitYears[0] : (noDividendYears.length === 1 ? noDividendYears[0] : '');
  const reasonEvent = reasonYear ? data.events.find(row => row.is_official &&
    (String(row.title || '').includes(`${reasonYear}年`) || String(row.title || '').includes('年度报告') || String(row.title || '').includes('利润分配'))) : null;
  const growths = {};
  [3, 5, 10].forEach(n => {
    const end = annualIncome[0], start = annualIncome[n];
    growths[n] = {
      parent: growthMetric(start && start.n_income_attr_p, end && end.n_income_attr_p, n),
      deducted: growthMetric(start && indicatorMap.get(start.end_date)?.profit_dedt, end && indicatorMap.get(end.end_date)?.profit_dedt, n)
    };
  });
  const lateAvg = average(annualIncome.slice(0, 3).map(row => row.n_income_attr_p));
  const earlyAvg = average(annualIncome.slice(10, 13).map(row => row.n_income_attr_p));
  const interim = latestIncome && !latestIncome.end_date.endsWith('1231') ? latestIncome : null;
  const priorInterim = interim ? incomeMap.get(`${Number(interim.end_date.slice(0, 4)) - 1}${interim.end_date.slice(4)}`) : null;
  const latestCash = annualCash[0] || {};
  const freeCash = row => {
    const operating = finite(row.n_cashflow_act), capex = finite(row.c_pay_acq_const_fiolta);
    return operating == null || capex == null ? null : operating - capex;
  };
  const interestDebt = finite(latestIndicator.interestdebt) != null ? finite(latestIndicator.interestdebt) :
    ['st_borr', 'lt_borr', 'bond_payable', 'non_cur_liab_due_1y'].reduce((sum, key) => sum + (finite(latestBalance[key]) || 0), 0);
  const interestExpense = finite(latestIncome.fin_exp_int_exp) != null ? finite(latestIncome.fin_exp_int_exp) : finite(latestIncome.int_exp);
  const interestCoverage = finite(latestIndicator.ebit_to_interest) != null ? finite(latestIndicator.ebit_to_interest) : signedRatio(finite(latestIncome.ebit), interestExpense);
  const financialIndustry = /银行|保险|证券|多元金融/.test(String(data.meta.industry || ''));
  return {
    ts_code: tsCode, name: data.meta.name, industry: data.meta.industry, list_date: data.meta.list_date,
    industry_info: { name: data.meta.industry, system: data.meta.data?.industry_system || 'Tushare基础行业', level: data.meta.data?.industry_level || '未标注级别', path: data.meta.data?.industry_path || [] },
    actual_controller: data.meta.data?.actual_controller || { name: '', type: '', source: '' },
    latest_report: { end_date: latestIncome?.end_date || '', ann_date: dateText(latestIncome?.f_ann_date || latestIncome?.ann_date), type: latestIncome?.end_date?.endsWith('1231') ? '年报' : (latestIncome?.end_date?.endsWith('0630') ? '半年报' : '季报') },
    performance_forecast: forecast ? { ann_date: dateText(forecast.ann_date), end_date: dateText(forecast.end_date), type: forecast.type || '', profit_min: finite(forecast.net_profit_min) == null ? null : finite(forecast.net_profit_min) * 10000, profit_max: finite(forecast.net_profit_max) == null ? null : finite(forecast.net_profit_max) * 10000, change_min: finite(forecast.p_change_min), change_max: finite(forecast.p_change_max), summary: forecast.summary || '' } : null,
    as_of: isoDate(today), latest_market_trade_date: isoDate(latestValuation && latestValuation.trade_date) || isoDate(today), quote: { price: currentPrice, currency: 'CNY', currency_name: '人民币', unit: '元', quote_time: quote && quote.quote_time, source: quote ? 'tencent' : 'tushare_close' },
    valuation: {
      market_cap: marketCap, a_share_market_cap: marketCap, circulating_market_cap: circulatingMarketCap, free_float_market_cap: freeFloatMarketCap,
      annualized_return_since_listing: annualizedSinceListing, return_start_date: earliestValuation?.trade_date || '',
      pe_ttm: peTtm, pe_static: peStatic, pe_forecast: signedRatio(marketCap, forecastProfit), pe_three_year_avg: peAvg3,
      pb, pb_ex_goodwill: pbExGoodwill, dividend_yield: signedRatio(dividend12m, marketCap), payout_ratio: signedRatio(annualDividend, staticProfit),
      cumulative_payout_ratio: cumulativePayoutRatio, average_dividend_yield: averageDividendYield,
      cumulative_dividend: cumulativeDividend, cumulative_profit: cumulativeProfit,
      roe: finite(indicatorMap.get(annualIncome[0]?.end_date)?.roe), roa: calculatedRoa,
      roa_source: officialRoa == null && calculatedRoa != null ? '归母净利润 ÷ 平均总资产（补算）' : 'Tushare财务指标'
    },
    stability: { years, dividend_history: dividendRows.map(item => {
      const year = String(item.row.end_date || '').slice(0, 4);
      const profitRow = annualIncome.find(row => row.end_date.slice(0, 4) === year);
      const profit = profitRow ? finite(profitRow.n_income_attr_p) : null;
      const yearDividend = dividendByYear.get(year) || 0;
      return { year, end_date: dateText(item.row.end_date), ann_date: dateText(item.row.ann_date || item.row.imp_ann_date), record_date: dateText(item.row.record_date),
        ex_date: dateText(item.row.ex_date), div_proc: item.row.div_proc, stk_bo_rate: finite(item.row.stk_bo_rate),
        stk_co_rate: finite(item.row.stk_co_rate), stk_div: finite(item.row.stk_div), cash_div: item.cashPerShare,
        amount: item.amount, profit, payout_ratio: signedRatio(item.amount, profit), annual_payout_ratio: signedRatio(yearDividend, profit) };
    }).sort((a, b) => String(b.ann_date || b.ex_date).localeCompare(String(a.ann_date || a.ex_date))), profitable_each_year: noProfitYears.length === 0, no_profit_years: noProfitYears,
      dividend_each_year: noDividendYears.length === 0, no_dividend_years: noDividendYears,
      reason: reasonYear ? '待人工核实，请查看对应年度公告' : '', reason_url: reasonEvent ? reasonEvent.url : '' },
    percentiles: {
      price: percentile(currentPrice, qfqPrices), pe: percentile(peTtm, positiveValuations.map(row => row.pe_ttm), 'pe'), pb: percentile(pb, positiveValuations.map(row => row.pb)),
      history: valuationHistory,bands:percentileBands,current:{price:currentPrice,pe:peTtm,pb},
      note: '分位点曲线从所选起始日开始累计计算，每个日期只使用该日及之前的有效样本。当前分位＝（当前排名－1）÷（有效样本数－1），最低为0%，最高为100%。股价使用前复权价格；PE正数从小到大排在前，负数按-100、-80……-5的顺序排在后。'
    },
    growth: { ten_year_average: Object.assign(threeYearAverageGrowth(earlyAvg, lateAvg), { early_average: earlyAvg, late_average: lateAvg }), periods: growths,
      latest_interim_yoy: interim && priorInterim ? { end_date: interim.end_date,
        parent: signedRatio(finite(interim.n_income_attr_p) - finite(priorInterim.n_income_attr_p), Math.abs(finite(priorInterim.n_income_attr_p))),
        deducted: signedRatio(finite(indicatorMap.get(interim.end_date)?.profit_dedt) - finite(indicatorMap.get(priorInterim.end_date)?.profit_dedt), Math.abs(finite(indicatorMap.get(priorInterim.end_date)?.profit_dedt)))} : null },
    safety: { net_cash: (finite(latestBalance.money_cap) || 0) + (finite(latestBalance.trad_asset) || 0) - interestDebt,
      interest_coverage: interestCoverage, market_cap_to_liability: signedRatio(marketCap, finite(latestBalance.total_liab)),
      report_end_date: latestBalance.end_date, industry_note: financialIndustry ? '金融企业负债结构与普通企业不可直接比较' : '' },
    cashflow: { latest_year: { end_date: latestCash.end_date, operating: finite(latestCash.n_cashflow_act), free: freeCash(latestCash) },
      average_3y: { operating: financialAverage(annualCash, 'n_cashflow_act', 3), free: average(annualCash.slice(0, 3).map(freeCash)) },
      average_5y: { operating: financialAverage(annualCash, 'n_cashflow_act', 5), free: average(annualCash.slice(0, 5).map(freeCash)) } },
    events: data.events.map(row => Object.assign({}, row, { event_date: isoDate(row.event_date) })),
    data_quality: { income_rows: data.income.length, balance_rows: data.balance.length, cashflow_rows: data.cashflow.length,
      valuation_rows: data.valuations.length, research_notice: '金融数据仅供研究，交易决策前请独立核验。' }
  };
}

// 本地已存分红的最新报告期（end_date）：作为增量水位原样返回（YYYYMMDD）；
// 重叠窗口（往前约一年）由下方过滤器统一计算，避免两处各减一年导致窗口翻倍。
// 首发（无本地数据）返回 null → 保留全量。
async function latestDividendEndDate(tsCode) {
  try {
    const { rows } = await pool.query('SELECT MAX(end_date) AS d FROM stock_dividends WHERE ts_code=$1', [tsCode]);
    const d = rows[0] && rows[0].d ? String(rows[0].d).replace(/-/g, '') : '';
    if (!/^\d{8}$/.test(d)) return null;
    return d;
  } catch (_) { return null; }
}

// 本地已存业绩预告的最新公告日：作为增量水位，请求时只取该日往前 30 天重叠窗口。
async function latestForecastAnnDate(tsCode) {
  try {
    const { rows } = await pool.query('SELECT MAX(ann_date) AS d FROM stock_forecasts WHERE ts_code=$1', [tsCode]);
    const d = rows[0] && rows[0].d ? String(rows[0].d).replace(/-/g, '') : '';
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
      const cached = await pool.query('SELECT stock_name AS name, industry FROM public.stock_unified WHERE stock_code=$1', [tsCode]);
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
    const prev = await pool.query('SELECT raw_data FROM core.instruments WHERE canonical_code=$1', [tsCode]);
    prevRaw = (prev.rows[0] && prev.rows[0].raw_data) || {};
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
  const existing = await pool.query(`SELECT
    EXISTS(SELECT 1 FROM market.daily_valuations v JOIN core.instruments i ON i.instrument_id=v.instrument_id WHERE i.canonical_code=$1) has_daily,
    (SELECT min(to_char(v.trade_date,'YYYYMMDD')) FROM market.daily_valuations v JOIN core.instruments i ON i.instrument_id=v.instrument_id WHERE i.canonical_code=$1) first_daily,
    EXISTS(SELECT 1 FROM fundamental.financial_reports r JOIN core.company_instruments ci ON ci.company_id=r.company_id JOIN core.instruments i ON i.instrument_id=ci.instrument_id WHERE i.canonical_code=$1 AND r.report_kind='indicator') has_indicator,
    EXISTS(SELECT 1 FROM fundamental.financial_reports r JOIN core.company_instruments ci ON ci.company_id=r.company_id JOIN core.instruments i ON i.instrument_id=ci.instrument_id WHERE i.canonical_code=$1 AND r.report_kind='income') has_reports`,[tsCode]);
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
  const current = await pool.query(`SELECT s.payload,s.created_at,s.formula_bundle_version,s.source_watermark,i.instrument_id FROM core.instruments i
    JOIN analytics.analysis_snapshots s ON s.instrument_id=i.instrument_id
    WHERE i.canonical_code=$1 AND s.snapshot_type='stock_analysis'
    ORDER BY s.as_of_date DESC,s.created_at DESC LIMIT 1`, [tsCode]);
  if (!current.rows[0]) return null;
  const r = current.rows[0];
  const latest = await pool.query(
    `SELECT
        (SELECT max(trade_date) FROM market.daily_valuations WHERE instrument_id=$1) AS trade_date,
        (SELECT max(period_end) FROM fundamental.financial_reports r JOIN core.company_instruments ci ON ci.company_id=r.company_id WHERE ci.instrument_id=$1) AS financial_end,
        (SELECT max(announced_at) FROM fundamental.financial_reports r JOIN core.company_instruments ci ON ci.company_id=r.company_id WHERE ci.instrument_id=$1) AS financial_ann,
        (SELECT max(announced_at) FROM fundamental.corporate_actions WHERE instrument_id=$1 AND action_type='dividend') AS dividend_ann,
        (SELECT max(ex_date) FROM fundamental.corporate_actions WHERE instrument_id=$1 AND action_type='dividend') AS dividend_ex,
        (SELECT max(announced_at) FROM fundamental.earnings_guidance g JOIN core.company_instruments ci ON ci.company_id=g.company_id WHERE ci.instrument_id=$1) AS guidance_ann,
        (SELECT max(period_end) FROM fundamental.earnings_guidance g JOIN core.company_instruments ci ON ci.company_id=g.company_id WHERE ci.instrument_id=$1) AS guidance_end,
        (SELECT n.industry_name FROM core.industry_nodes n JOIN core.company_industry_memberships m ON m.industry_node_id=n.industry_node_id JOIN core.company_instruments ci ON ci.company_id=m.company_id WHERE ci.instrument_id=$1 AND m.is_current LIMIT 1) AS industry_name,
        (SELECT c.controller_name FROM core.company_controllers c WHERE c.company_id=(SELECT ci.company_id FROM core.company_instruments ci WHERE ci.instrument_id=$1 LIMIT 1) AND c.is_current=true ORDER BY c.announced_at DESC LIMIT 1) AS controller_name,
        (SELECT max(event_date) FROM event.company_events e JOIN core.company_instruments ci ON ci.company_id=e.company_id WHERE ci.instrument_id=$1 AND e.is_official=true) AS event_date`,
    [r.instrument_id]
  );
  const latestRow = latest.rows[0] || {};
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
  const { rows } = await pool.query(
    `SELECT ts_code,MAX(name) AS name,BOOL_OR(source='watchlist') AS watchlisted,BOOL_OR(source='position') AS held FROM (
       SELECT w.ts_code,w.name,'watchlist'::text AS source FROM stock_watchlist w WHERE w.username=$1
       UNION ALL
       SELECT CASE WHEN p.code ~ '^6' THEN p.code||'.SH' WHEN p.code ~ '^(4|8|92)' THEN p.code||'.BJ' ELSE p.code||'.SZ' END,
              MAX(p.name),'position'::text FROM positions p
        WHERE p.username=$1 AND p.code ~ '^[0-9]{6}$' AND p.code !~ '^(110|111|113|118|123|127|128)'
        GROUP BY p.code
     ) u GROUP BY ts_code ORDER BY held DESC,name,ts_code`, [username]
  );
  return rows.filter(row => isOrdinaryAStock(row.ts_code));
}

module.exports = { finite, normalizeStockCode, isOrdinaryAStock, stockExchange, growthMetric, threeYearAverageGrowth, percentile, quantile, selectDividendPlans, selectLatestByPeriod, eventRefreshStart, mergeOfficialEventSources,
  refreshStockAnalysis, buildAnalysis, getSnapshot, listUserStocks, fetchCninfoEvents, fetchSseLatestReport, fetchSseEvents,
  fetchCninfoEventsByYear, fetchSzseEvents, fetchSzseLatestReport, fetchSseEventsBatch, fetchSzseEventsBatch,
  fetchCninfoEventsBatch, fetchTushareAnnouncementBatch, sourceForUrl };

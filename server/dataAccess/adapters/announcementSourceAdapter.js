// 公告与社区贴采集适配器（批次4，从 services/stockAnalysis.js 整段迁入）。
// 角色：data_access 的外采落点之一，负责 巨潮／上交所／深交所／东财 F10／雪球／股吧 的取数与来源字段映射。
// 边界：只依赖 https、统一外采守卫、证券标识与纯计算域；不引用路由、任务或旧服务，避免分层倒挂。
// 什么时候采、采多久、失败怎么退仍留在 service 层；本文件只管「怎么问、怎么把回包认出来」。
const https = require('https');
const { withExternalCallGuard } = require('../../services/externalCallGuard');
const { resolveProviderCode } = require('../../services/securityIdentity');
const { dateText, finite, isoDate, tsDateStr } = require('../../domain/stockValuation');
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

// 传输缝：默认直接用 https 发请求。仅测试用它替换传输层，以便分别验证「怎么判来源完成/降级」
// 与「怎么取数」；生产代码不得调用 setRequestTransportForTest。
let requestTransport = null;

function rawRequestJson(url, options = {}) {
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

function requestJson(url, options = {}) {
  return requestTransport ? requestTransport(url, options) : rawRequestJson(url, options);
}

function setRequestTransportForTest(fn) { requestTransport = fn || null; }

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

module.exports = {
  setRequestTransportForTest,
  controllerType,
  fetchActualController,
  requestJson,
  stockExchange,
  sourceForUrl,
  eventCategory,
  officialAnnouncementNumber,
  announcementStockCode,
  announcementUrl,
  dedupeAnnouncementEvents,
  mapSseAnnouncement,
  mapSzseAnnouncement,
  fetchCninfoEvents,
  fetchCninfoEventsByYear,
  fetchSseLatestReport,
  fetchSseEvents,
  fetchSzseEvents,
  fetchSseEventsBatch,
  fetchSzseEventsBatch,
  fetchCninfoEventsBatch,
  fetchSzseLatestReport,
  fetchXueqiuEvents,
  fetchGubaEvents,
};

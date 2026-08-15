// ========== 港交所披露易公告检索适配器 ==========
// 数据源：https://www1.hkexnews.hk/search/titleSearchServlet.do
// 用途：检索私有化、协议安排、供股等公告，标准化后交由同步编排入库
const https = require('https');
const { firstSecurityCode, firstSecurityName, cleanSecurityText } = require('./arbitrageRules');
const { withExternalCallGuard } = require('./externalCallGuard');

const BASE_URL = 'https://www1.hkexnews.hk';
const SEARCH_PATH = '/search/titleSearchServlet.do';
const ALLOWED_DOMAIN = 'www1.hkexnews.hk';

// 方案 4.2 检索分类：港交所「披露易」的二级分类代码（t2code）
// 顶层类目固定为 t1code=10000（Announcements and Notices），category=0，实际分类放入 t2code。
const HKEX_CATEGORIES = [
  '17100', // 受要约公司公告
  '17150', // 要约公司公告
  '17450', // 集团重组或协议安排
  '17600', // 私有化、撤销或取消证券上市
  '18500', // 供股公告
  '25100', '25200', '25400', // 收购、私有化相关通函
  '26800', '31100', // 供股文件及相关公告
];

const TIMEOUT_MS = 15000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5MB

function rawHttpRequest(urlStr, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    if (u.hostname !== ALLOWED_DOMAIN) {
      return reject(new Error('Domain not in whitelist: ' + u.hostname));
    }
    const options = {
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': 'application/json, text/html',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
      timeout: TIMEOUT_MS,
    };
    if (body) {
      options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      options.headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = https.request(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // 跟随重定向，但校验目标域名
        const redirectUrl = new URL(res.headers.location, urlStr).href;
        const redirectHost = new URL(redirectUrl).hostname;
        if (redirectHost !== ALLOWED_DOMAIN) {
          return reject(new Error('Redirect to non-whitelisted domain: ' + redirectHost));
        }
          return resolve(rawHttpRequest(redirectUrl, { method, body }));
      }
      if (res.statusCode !== 200) {
        const error = new Error('HKEX HTTP ' + res.statusCode);
        error.code = res.statusCode === 429 ? 'RATE_LIMIT' : res.statusCode >= 500 ? 'UPSTREAM_5XX' : 'UPSTREAM_ERROR';
        error.errorType = res.statusCode === 429 ? 'rate_limit' : res.statusCode >= 500 ? 'network' : 'upstream';
        error.source = 'hkex';
        return reject(error);
      }
      const chunks = [];
      let totalLen = 0;
      res.on('data', (chunk) => {
        totalLen += chunk.length;
        if (totalLen > MAX_RESPONSE_BYTES) {
          req.destroy();
          reject(new Error('Response exceeds size limit'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('HKEX request timeout')); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function httpRequest(urlStr, options = {}) {
  return withExternalCallGuard('hkex', `announcement:${urlStr}`, process.env.JOB_BUSINESS_DATE,
    () => rawHttpRequest(urlStr, options));
}

// 日期格式转换：YYYY-MM-DD -> YYYYMMDD（港交所接口要求）
function toHKEXDate(isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) throw new Error('Invalid date: ' + isoDate);
  return m[1] + m[2] + m[3]; // YYYYMMDD
}

// 规范化文件链接
function normalizeFileLink(link) {
  if (!link) return '';
  const full = link.startsWith('http') ? link : (BASE_URL + link);
  try {
    const u = new URL(full);
    if (u.hostname !== ALLOWED_DOMAIN) return '';
    return full;
  } catch { return ''; }
}

// 解析搜索响应
// 港交所 titleSearchServlet 返回的 result 是「JSON 字符串」（如 "[{...}]"），必须先 JSON.parse；
// 顶层还带 hasNextRow / recordCnt 用于分页。
function parseSearchResponse(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try { json = JSON.parse(match[0]); } catch { return { items: [], hasNextRow: false, recordCnt: 0 }; }
    } else {
      return { items: [], hasNextRow: false, recordCnt: 0 };
    }
  }

  let results = json.result || json.results || json.Result;
  if (typeof results === 'string') {
    try { results = JSON.parse(results); } catch { results = []; }
  }
  if (!Array.isArray(results)) results = [];

  const items = results.map((r) => {
    const newsId = String(r['NEWS_ID'] || r['newsId'] || r['id'] || '').trim();
    const fileLink = normalizeFileLink(r['FILE_LINK'] || r['fileLink'] || r['href'] || '');
    const title = cleanSecurityText(r['TITLE'] || r['title'] || r['SHORT_TEXT'] || '');
    const dateStr = String(r['DATE_TIME'] || r['dateTime'] || r['LDT'] || r['RELEASE_TIME'] || '').trim();
    const stockCode = firstSecurityCode(r['STOCK_CODE'] || r['stockCode'] || '', 'HK');
    const stockName = firstSecurityName(r['STOCK_NAME'] || r['stockName'] || '');
    const category = String(r['CATEGORY'] || r['category'] || r['CAT_CODE'] || '').trim();

    return {
      sourceKey: newsId || fileLink,
      fileLink,
      title,
      announcedAt: parseHKEXDate(dateStr),
      stockCode,
      stockName,
      category,
      rawPayload: r,
    };
  }).filter(a => a.sourceKey);

  return {
    items,
    hasNextRow: !!json.hasNextRow,
    recordCnt: json.recordCnt || 0,
  };
}

// 港交所日期解析
function parseHKEXDate(dateStr) {
  if (!dateStr) return null;
  // 格式可能是 "DD/MM/YYYY HH:MM" 或 ISO
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(dateStr);
  if (m) {
    return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(dateStr);
  if (iso) return iso[1];
  return null;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const HKEX_PAGE_SIZE = 100;
const HKEX_MAX_PAGES = 50;

// 构造官方披露易 titleSearchServlet.do 检索 URL（严格对齐官方请求契约）
//   lang=zh；searchType=1；sortDir=0；t2Gcode 为空；category=0；t1code=10000（公告及通函顶层类目）；
//   实际二级分类放入 t2code；fromDate/toDate 使用 YYYYMMDD；documentType=-1。
function buildSearchUrl(category, fromDate, toDate, rowRange) {
  const params = new URLSearchParams({
    lang: 'zh',
    searchType: '1',
    category: '0',
    market: 'SEHK',
    fromDate: toHKEXDate(fromDate),
    toDate: toHKEXDate(toDate),
    t1code: '10000',
    t2code: category,
    t3code: '-2',
    t2Gcode: '',
    documentType: '-1',
    sortByOptions: 'DateTime',
    sortDir: '0',
    title: '',
    rowRange: String(rowRange),
  });
  return BASE_URL + SEARCH_PATH + '?' + params.toString();
}

// 搜索港交所公告（自动翻页：按 hasNextRow + rowRange 遍历全部结果）
async function searchAnnouncements({ fromDate, toDate, categories, _httpRequest } = {}) {
  const fetch = _httpRequest || httpRequest;
  const cats = categories && categories.length ? categories : HKEX_CATEGORIES;
  const results = [];
  for (const cat of cats) {
    // 首批请求从 HKEX_PAGE_SIZE(100) 开始：港交所 rowRange=0 返回 0 条，rowRange=100 才返回数据
    let rowRange = HKEX_PAGE_SIZE;
    for (let page = 0; page < HKEX_MAX_PAGES; page++) {
      const url = buildSearchUrl(cat, fromDate, toDate, rowRange);
      const text = await fetch(url);
      const { items, hasNextRow } = parseSearchResponse(text);
      results.push(...items);
      if (!hasNextRow) break;
      rowRange += HKEX_PAGE_SIZE;
      await sleep(500);
    }
    await sleep(500);
  }
  return results;
}

module.exports = {
  searchAnnouncements,
  parseSearchResponse,
  buildSearchUrl,
  HKEX_CATEGORIES,
  httpRequest,
  ALLOWED_DOMAIN,
};

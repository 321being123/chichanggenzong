// ========== 巨潮资讯公告检索适配器 ==========
// 数据源：https://www.cninfo.com.cn/new/hisAnnouncement/query
// 用途：检索 A 股要约收购、现金选择权、换股吸收合并等公告
const https = require('https');
const { withExternalCallGuard } = require('./externalCallGuard');

const BASE_URL = 'https://www.cninfo.com.cn';
const SEARCH_PATH = '/new/hisAnnouncement/query';
const ALLOWED_DOMAIN = 'www.cninfo.com.cn';

const TIMEOUT_MS = 15000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

// 方案 4.3 A 股公告关键词
const DISCOVERY_KEYWORDS = [
  '要约收购报告书',
  '要约收购报告书摘要',
  '现金选择权',
  '异议股东收购请求权',
  '换股吸收合并',
  '境内上市外资股转换上市地',
  'B股转H股',
  '立案告知书',
  '立案调查',
  '调查通知书',
  '行政处罚',
  '监管措施',
];
const UPDATE_KEYWORDS = [
  '换股实施',
  '收购请求权',
  '终止',
  '完成',
];

function rawHttpRequest(urlStr, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    if (u.hostname !== ALLOWED_DOMAIN) {
      return reject(new Error('Domain not in whitelist: ' + u.hostname));
    }
    const options = {
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Referer': 'https://www.cninfo.com.cn/new/commonUrl?url=disclosure/list/notice',
        'X-Requested-With': 'XMLHttpRequest',
      },
      timeout: TIMEOUT_MS,
    };
    if (body) {
      options.headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      options.headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = https.request(options, (res) => {
      if (res.statusCode !== 200) {
        const error = new Error('CNINFO HTTP ' + res.statusCode);
        error.code = res.statusCode === 429 ? 'RATE_LIMIT' : res.statusCode >= 500 ? 'UPSTREAM_5XX' : 'UPSTREAM_ERROR';
        error.errorType = res.statusCode === 429 ? 'rate_limit' : res.statusCode >= 500 ? 'network' : 'upstream';
        error.source = 'cninfo';
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
    req.on('timeout', () => { req.destroy(); reject(new Error('CNINFO request timeout')); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function httpRequest(urlStr, options = {}) {
  return withExternalCallGuard('cninfo', `announcement:${urlStr}`, process.env.JOB_BUSINESS_DATE,
    () => rawHttpRequest(urlStr, options));
}

// 规范化附件链接
// 巨潮附件常见两种情况：
//   1) 已是完整 URL（可能落在 www.cninfo.com.cn 或 static.cninfo.com.cn）—— 直接使用
//   2) 相对路径 finalpage/YYYY-MM-DD/xxx.PDF（无域名、常无前导斜杠）—— 真实文件在 static.cninfo.com.cn
function normalizeAdjunctUrl(url) {
  if (!url) return '';
  let full;
  if (url.startsWith('http')) {
    full = url;
  } else {
    const path = url.startsWith('/') ? url : '/' + url;
    full = 'https://static.cninfo.com.cn' + path;
  }
  try {
    const u = new URL(full);
    // 仅允许 cninfo 官方域名（www / static 均可）
    if (!/cninfo\.com\.cn$/.test(u.hostname)) return '';
    return full;
  } catch { return ''; }
}

// 清洗标题：巨潮返回的标题含 <em> 高亮标签与 HTML 实体，需去除后再做分类
function cleanText(s) {
  if (!s) return '';
  return String(s)
    .replace(/<[^>]+>/g, '')              // 去除所有 HTML 标签（含 <em>）
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

// 巨潮 pageColumn 形如 SHZB/SZZB/SZCY/BJ...：SH*→上交所，SZ*→深交所，BJ*→北交所
function mapCninfoExchange(pageColumn) {
  const p = String(pageColumn || '').toUpperCase();
  if (p.startsWith('SH')) return 'SSE';
  if (p.startsWith('SZ')) return 'SZSE';
  if (p.startsWith('BJ')) return 'BSE';
  return 'CN';
}

// 解析搜索响应（巨潮 hisAnnouncement/query 返回 totalAnnouncement 总数 + announcements 数组）
function parseSearchResponse(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { items: [], total: 0, hasMore: false };
  }
  const announcements = json.announcements || json.data || [];
  if (!Array.isArray(announcements)) return { items: [], total: 0, hasMore: false };

  const items = announcements.map((a) => {
    const annId = String(a.announcementId || a.id || '').trim();
    const adjunctUrl = normalizeAdjunctUrl(a.adjunctUrl || a.attachmentUrl || '');
    const title = cleanText(a.announcementTitle || a.title || '');
    const secCode = String(a.secCode || a.code || '').trim();
    const secName = cleanText(a.secName || a.companyName || '');
    const exchange = mapCninfoExchange(a.pageColumn || a.columnId || a.exchange || a.secCodeType);
    const annTime = a.announcementTime || a.publishDate;

    return {
      sourceKey: annId || adjunctUrl,
      fileLink: adjunctUrl,
      title,
      announcedAt: parseCNINFODate(annTime),
      stockCode: secCode,
      stockName: secName,
      exchange,
      rawPayload: a,
    };
  }).filter(a => a.sourceKey);

  const total = json.totalAnnouncement || json.totalRecordNum || 0;
  const hasMore = json.hasMore === true || (total > 0 && items.length < total);
  return { items, total, hasMore };
}

function parseCNINFODate(time) {
  if (!time) return null;
  // announcementTime 是毫秒时间戳
  if (typeof time === 'number') {
    return new Date(time).toISOString().slice(0, 10);
  }
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(time));
  if (m) return m[1];
  return null;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const CNINFO_PAGE_SIZE = 30;
const CNINFO_MAX_PAGES = 100;

// 搜索巨潮公告（自动翻页：按 totalAnnouncement / hasMore 遍历全部结果）
// 默认关键词 = 发现关键词 + 后续进程关键词（终止/完成/换股实施等），确保事件状态可被更新
async function searchAnnouncements({ fromDate, toDate, keywords, exchanges } = {}) {
  const kws = keywords && keywords.length ? keywords : [...DISCOVERY_KEYWORDS, ...UPDATE_KEYWORDS];
  const exs = exchanges && exchanges.length ? exchanges : ['sse', 'szse'];
  const results = [];

  for (const ex of exs) {
    for (const kw of kws) {
      let pageNum = 1;
      for (let page = 0; page < CNINFO_MAX_PAGES; page++) {
        const body = new URLSearchParams({
          pageNum: String(pageNum),
          pageSize: String(CNINFO_PAGE_SIZE),
          column: ex,
          tabName: 'fulltext',
          plate: '',
          stock: '',
          searchkey: kw,
          secid: '',
          category: '',
          trade: '',
          seDate: fromDate + '~' + toDate,
          sortName: '',
          sortType: '',
          isHLtitle: 'true',
        }).toString();

        const text = await httpRequest(BASE_URL + SEARCH_PATH, { method: 'POST', body });
        const { items, hasMore } = parseSearchResponse(text);
        results.push(...items);
        if (!hasMore || items.length === 0) break;
        pageNum++;
        await sleep(500);
      }
      await sleep(500);
    }
  }
  return results;
}

module.exports = {
  searchAnnouncements,
  parseSearchResponse,
  normalizeAdjunctUrl,
  DISCOVERY_KEYWORDS,
  UPDATE_KEYWORDS,
  httpRequest,
  ALLOWED_DOMAIN,
};

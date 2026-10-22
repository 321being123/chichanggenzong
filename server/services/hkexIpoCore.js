// 官方页面/表格/PDF 解析工具与常量
// R-10 拆分自 ./hkexIpo.js（2026-10-21）：本文件只放官方页面/表格/PDF 解析工具与常量；对外入口仍是 ./hkexIpo.js。
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ExcelJS = require('exceljs');
const { httpRequest, ALLOWED_DOMAINS, searchAnnouncements } = require('./hkexAnnouncement');
const { readCachedPdf, writeCachedPdf } = require('./documentPdfCache');

const HKEX_NEW_LISTING_TARGETS = Object.freeze([
  {
    key: 'main_board_new_listings',
    board: '主板',
    url: process.env.HKEX_MAIN_BOARD_NEW_LISTINGS_URL || 'https://www2.hkexnews.hk/new-listings/new-listing-information/main-board?sc_lang=en',
  },
  {
    key: 'main_board_new_listings_zh',
    board: '主板',
    nameLanguage: 'zh',
    url: process.env.HKEX_MAIN_BOARD_NEW_LISTINGS_ZH_URL || 'https://www2.hkexnews.hk/New-Listings/New-Listing-Information/Main-Board?sc_lang=zh-cn',
  },
  {
    key: 'gem_new_listings',
    board: 'GEM',
    url: process.env.HKEX_GEM_NEW_LISTINGS_URL || 'https://www2.hkexnews.hk/New-Listings/New-Listing-Information/GEM?sc_lang=en',
  },
  {
    key: 'gem_new_listings_zh',
    board: 'GEM',
    nameLanguage: 'zh',
    url: process.env.HKEX_GEM_NEW_LISTINGS_ZH_URL || 'https://www2.hkexnews.hk/New-Listings/New-Listing-Information/GEM?sc_lang=zh-cn',
  },
]);

const HKEX_PREDEFINED_DOCUMENT_TARGETS = Object.freeze([
  { key: 'prospectus', documentType: 'prospectus', url: process.env.HKEX_PROSPECTUS_URL || 'https://www1.hkexnews.hk/search/predefineddoc.xhtml?predefineddocuments=6' },
  { key: 'allotment_result', documentType: 'allotment_result', url: process.env.HKEX_ALLOTMENT_RESULT_URL || 'https://www1.hkexnews.hk/search/predefineddoc.xhtml?predefineddocuments=4' },
]);

const HKEX_NEW_LISTING_REPORT_TARGETS = Object.freeze([
  { key: 'main_new_listing_report_2025', board: '主板', year: 2025, url: 'https://www2.hkexnews.hk/-/media/HKEXnews/Homepage/New-Listings/New-Listing-Information/New-Listing-Report/Main/NLR2025_Eng.xlsx' },
  { key: 'main_new_listing_report_2026', board: '主板', year: 2026, url: 'https://www2.hkexnews.hk/-/media/HKEXnews/Homepage/New-Listings/New-Listing-Information/New-Listing-Report/Main/NLR2026_Eng.xlsx' },
  { key: 'gem_new_listing_report_2025', board: 'GEM', year: 2025, url: 'https://www2.hkexnews.hk/-/media/HKEXnews/Homepage/New-Listings/New-Listing-Information/New-Listing-Report/GEM/e_newlistings2025.xlsx' },
  { key: 'gem_new_listing_report_2026', board: 'GEM', year: 2026, url: 'https://www2.hkexnews.hk/-/media/HKEXnews/Homepage/New-Listings/New-Listing-Information/New-Listing-Report/GEM/e_newlistings2026.xlsx' },
]);

const HKEX_ALLOTMENT_DATASET = 'hkex_ipo_allotment_result';

const HKEX_ALLOTMENT_PARSER_VERSION = 'hk-ipo-allotment-v2';

const HKEX_ALLOTMENT_FACTS_PARSER_VERSION = 'hk-ipo-allotment-facts-v7';

const HKEX_ALLOTMENT_PARSER = path.join(__dirname, '..', 'scripts', 'extractHkIpoAllotment.py');

const HKEX_PROSPECTUS_DATASET = 'hkex_ipo_prospectus';

const HKEX_PROSPECTUS_PARSER = path.join(__dirname, '..', 'scripts', 'extractHkIpoProspectus.py');

const HKEX_PROSPECTUS_NOT_APPLICABLE = new Set(['01355.HK', '01792.HK', '01822.HK']);

const HKEX_NON_PUBLIC_DATASET = 'hkex_ipo_non_public_classification';

const HKEX_LISTING_STATUS_DATASET = 'hkex_ipo_listing_status_notice';

const HKEX_NON_PUBLIC_LISTINGS = Object.freeze([
  {
    securityCode: '06887.HK', ipoStatus: 'introduction', listingMethod: 'introduction',
    sourceUrl: 'https://www1.hkexnews.hk/listedco/listconews/sehk/2024/0510/2024051001146.pdf',
    title: 'Privatization of ChangJiang Pharmaceutical & Listing of the H Shares of Sunshine Lake Pharma by way of Introduction',
    evidence: 'Listing of the H Shares of Sunshine Lake Pharma by way of introduction',
  },
  {
    securityCode: '09876.HK', ipoStatus: 'gem_transfer', listingMethod: 'gem_transfer',
    sourceUrl: 'https://www1.hkexnews.hk/listedco/listconews/sehk/2025/1023/2025102301052.pdf',
    title: 'Transfer of Listing from GEM to the Main Board of the Stock Exchange of Hong Kong Limited',
    evidence: 'Transfer of Listing from GEM to the Main Board',
  },
  {
    securityCode: '02665.HK', ipoStatus: 'de_spac', listingMethod: 'de_spac',
    sourceUrl: 'https://www1.hkexnews.hk/listedco/listconews/sehk/2025/1210/2025082600101.htm',
    title: 'Seyond Holdings Ltd. by way of a De-SPAC transaction involving TechStar Acquisition Corporation',
    evidence: 'Seyond Holdings Ltd. (by way of a De-SPAC transaction involving TechStar Acquisition Corporation)',
  },
  {
    securityCode: '07489.HK', ipoStatus: 'introduction', listingMethod: 'introduction',
    sourceUrl: 'https://www1.hkexnews.hk/listedco/listconews/sehk/2026/0212/2026021201496.pdf',
    title: 'Listing by way of Introduction of H Shares of VOYAH Automotive Technology Co., Ltd.',
    evidence: 'LISTING BY WAY OF INTRODUCTION OF H SHARES',
  },
  {
    securityCode: '06051.HK', ipoStatus: 'gem_transfer', listingMethod: 'gem_transfer',
    sourceUrl: 'https://www1.hkexnews.hk/listedco/listconews/sehk/2026/0409/2026040901808.pdf',
    title: 'Transfer of Listing from GEM to the Main Board of the Stock Exchange of Hong Kong Limited',
    evidence: 'TRANSFER OF LISTING FROM GEM TO THE MAIN BOARD',
  },
  {
    securityCode: '03774.HK', ipoStatus: 'gem_transfer', listingMethod: 'gem_transfer',
    sourceUrl: 'https://www1.hkexnews.hk/listedco/listconews/sehk/2026/0623/2026062300323.pdf',
    title: 'Transfer of Listing from GEM to the Main Board of the Stock Exchange of Hong Kong Limited',
    evidence: 'Shares on the Main Board by way of the Transfer of Listing',
  },
]);

const NON_PUBLIC_IPO_STATUSES = new Set(['introduction', 'gem_transfer', 'de_spac']);

function assertOfficialUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !ALLOWED_DOMAINS.has(parsed.hostname)) {
    throw new Error(`HKEX URL 不在官方白名单：${parsed.hostname}`);
  }
  return parsed.href;
}

// 招股书、配发结果、取消上市和可转债上市资料共用同一份官方 PDF 缓存。
// 命中缓存时不进入 Guard/外部请求；下载成功后先落盘再解析，解析失败也保留原文供后续重试。
async function fetchOfficialPdfWithCache(url, fetchImpl, options = {}) {
  const officialUrl = assertOfficialUrl(url);
  let cached = null;
  try { cached = readCachedPdf(officialUrl); } catch (_) {}
  if (cached && cached.subarray(0, 5).toString('ascii') === '%PDF-') {
    return { buffer: cached, cacheHit: true, url: officialUrl };
  }
  const body = await fetchImpl(officialUrl, options);
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body || '');
  if (!buffer.length) throw new Error('官方 PDF 为空');
  if (buffer.subarray(0, 5).toString('ascii') === '%PDF-') {
    try { writeCachedPdf(officialUrl, buffer); } catch (_) {}
  }
  return { buffer, cacheHit: false, url: officialUrl };
}

function textOfHtml(value) {
  return String(value || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeDate(value) {
  const text = String(value || '').trim();
  let m = text.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = text.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

function canonicalHkCode(value) {
  const text = String(value || '').trim();
  if (!text || normalizeDate(text) || /https?:\/\//i.test(text)) return null;
  const match = text.match(/^(?:stock\s*code\s*[:：]?\s*)?(\d{1,5})(?:\.HK)?$/i);
  return match ? `${match[1].padStart(5, '0')}.HK` : null;
}

function extractCells(row) {
  return [...String(row || '').matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m => textOfHtml(m[1]));
}

function extractLinks(row, baseUrl) {
  return [...String(row || '').matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].map(m => ({
    href: new URL(m[1], baseUrl).href,
    text: textOfHtml(m[2]),
  }));
}

function codeFromCells(cells) {
  for (const cell of cells) {
    const exact = canonicalHkCode(cell);
    if (exact) return exact;
  }
  for (const cell of cells) {
    const text = String(cell || '').trim();
    if (!text || normalizeDate(text) || /https?:\/\//i.test(text)) continue;
    const match = text.match(/(?:stock\s*code|code|证券代号)\s*[:：]?\s*(\d{1,5})(?:\.HK)?\b/i);
    if (match) return canonicalHkCode(match[1]);
  }
  return null;
}

function codeFromDocument(title, href) {
  const fileName = String(href || '').split(/[/?#]/).pop() || '';
  const text = `${title || ''} ${fileName}`.replace(/\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/g, ' ');
  const matches = text.match(/(?:^|[^\d])((?:\d{1,5})(?:\.HK)?)(?=$|[^\d])/gi) || [];
  for (const candidate of matches) {
    const code = canonicalHkCode(candidate);
    if (code) return code;
  }
  return null;
}

function workbookCellText(value) {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if (value.result != null) return workbookCellText(value.result);
    if (Array.isArray(value.richText)) return value.richText.map(item => item.text || '').join('');
    if (value.text != null) return String(value.text);
  }
  return String(value).trim();
}

function workbookDate(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(Date.UTC(1899, 11, 30) + value * 86400000).toISOString().slice(0, 10);
  }
  return normalizeDate(workbookCellText(value));
}

function workbookNumber(value) {
  const text = workbookCellText(value).replace(/,/g, '');
  if (!text || /^(?:n\/a|not applicable|by introduction)/i.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

async function parseNewListingReportWorkbook(buffer, { board = '', sourceUrl = '' } = {}) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];
  let headerRow = null;
  let isGem = String(board).toUpperCase() === 'GEM';
  sheet.eachRow(row => {
    const first = workbookCellText(row.getCell(1).value).toLowerCase();
    const second = workbookCellText(row.getCell(2).value).toLowerCase();
    if ((!isGem && second === 'stock code') || (isGem && first === 'listing date')) headerRow = row.number;
  });
  if (!headerRow) return [];
  const rows = [];
  for (let rowNumber = headerRow + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const rawCode = workbookCellText(row.getCell(isGem ? 2 : 2).value);
    const code = canonicalHkCode(rawCode);
    if (!code) continue;
    const listingDate = workbookDate(row.getCell(isGem ? 1 : 5).value);
    if (!listingDate) continue;
    const securityName = workbookCellText(row.getCell(3).value).replace(/\s+/g, ' ').trim();
    const price = workbookNumber(row.getCell(isGem ? 6 : 10).value);
    rows.push({
      securityCode: code, securityName, board: board || null, listingDate,
      issuePriceFinal: price, issuePriceLow: price, issuePriceHigh: price,
      sourceUrl, sourceDocuments: [{ type: 'new_listing_report', url: sourceUrl, title: `${board || 'HKEX'} ${listingDate}` }],
      rawPayload: { sourceUrl, board, listingDate, securityCode: code, issuePriceFinal: price },
    });
  }
  const seen = new Set();
  return rows.filter(row => !seen.has(row.securityCode) && seen.add(row.securityCode));
}

async function fetchHkexNewListingReports({ years = [2025, 2026], fetchImpl = httpRequest } = {}) {
  const selected = HKEX_NEW_LISTING_REPORT_TARGETS.filter(target => years.includes(target.year));
  const results = [];
  for (const target of selected) {
    try {
      const body = await fetchImpl(target.url, { responseType: 'buffer' });
      const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
      const items = await parseNewListingReportWorkbook(buffer, { board: target.board, sourceUrl: target.url });
      results.push({ ...target, ok: true, responseBytes: buffer.length, responseSha256: crypto.createHash('sha256').update(buffer).digest('hex'), parserStatus: items.length ? 'parsed' : 'empty_unconfirmed', rowCount: items.length, items });
    } catch (error) {
      results.push({ ...target, ok: false, responseBytes: 0, responseSha256: null, parserStatus: 'not_run', rowCount: 0, items: [], error: error.message || String(error) });
    }
  }
  return results;
}

function resolvePython() {
  const root = path.join(__dirname, '..', '..');
  if (process.env.PYTHON) return process.env.PYTHON;
  const candidates = process.platform === 'win32'
    ? [
        path.join(root, 'venv', 'Scripts', 'python.exe'),
        path.join(root, 'ipo-report', 'venv', 'Scripts', 'python.exe'),
      ]
    : [
        path.join(root, 'venv', 'bin', 'python'),
        path.join(root, 'ipo-report', 'venv', 'bin', 'python'),
      ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return process.platform === 'win32' ? 'python.exe' : 'python3';
}

function resolveHkexEnglishPdfUrl(url) {
  const value = String(url || '');
  const marker = '_c.pdf';
  if (!value.toLowerCase().endsWith(marker)) return null;
  const slash = value.lastIndexOf('/');
  const prefix = value.slice(0, slash + 1);
  const file = value.slice(slash + 1);
  const digits = file.slice(0, -marker.length);
  if (!/^\d+$/.test(digits) || BigInt(digits) <= 0n) return null;
  return `${prefix}${(BigInt(digits) - 1n).toString().padStart(digits.length, '0')}.pdf`;
}

function parseHkexAllotmentPdf(buffer, { lotSizeShares = null, pricingOnly = false, stockCode = null } = {}) {
  return new Promise((resolve, reject) => {
    if (!Buffer.isBuffer(buffer) || !buffer.length) return reject(new Error('港交所配发结果 PDF 为空'));
    const args = [HKEX_ALLOTMENT_PARSER];
    if(pricingOnly)args.push('--pricing-only','--stock-code',String(stockCode));
    if (lotSizeShares !== null && lotSizeShares !== undefined && Number.isFinite(Number(lotSizeShares))) {
      args.push('--lot-size', String(lotSizeShares));
    }
    const child = spawn(resolvePython(), args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`港交所配发结果 PDF 解析失败（退出码 ${code}）：${stderr.slice(0, 500)}`));
      try {
        const result = JSON.parse(stdout);
        resolve(result);
      } catch (error) {
        reject(new Error(`港交所配发结果 PDF 解析输出无效：${error.message}`));
      }
    });
    child.stdin.end(buffer);
  });
}

function parseHkexProspectusPdf(buffer) {
  return new Promise((resolve, reject) => {
    if (!Buffer.isBuffer(buffer) || !buffer.length) return reject(new Error('港交所招股书 PDF 为空'));
    const child = spawn(resolvePython(), [HKEX_PROSPECTUS_PARSER], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`港交所招股书 PDF 解析失败（退出码 ${code}）：${stderr.slice(0, 500)}`));
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`港交所招股书 PDF 解析输出无效：${error.message}`));
      }
    });
    child.stdin.end(buffer);
  });
}

function monthWindows(fromDate, toDate) {
  const result = [];
  let cursor = new Date(`${fromDate}T00:00:00Z`);
  const end = new Date(`${toDate}T00:00:00Z`);
  while (cursor <= end) {
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth();
    const first = new Date(Date.UTC(year, month, 1));
    const last = new Date(Date.UTC(year, month + 1, 0));
    const start = first < new Date(`${fromDate}T00:00:00Z`) ? fromDate : first.toISOString().slice(0, 10);
    const finish = last > end ? toDate : last.toISOString().slice(0, 10);
    result.push([start, finish]);
    cursor = new Date(Date.UTC(year, month + 1, 1));
  }
  return result;
}

function prospectusSearchWindows(fromDate, toDate) {
  const result = [];
  let cursor = new Date(`${fromDate}T00:00:00Z`);
  const end = new Date(`${toDate}T00:00:00Z`);
  while (cursor <= end) {
    const start = cursor.toISOString().slice(0, 10);
    const next = new Date(cursor);
    next.setUTCMonth(next.getUTCMonth() + 12);
    next.setUTCDate(next.getUTCDate() - 1);
    const finish = next < end ? next.toISOString().slice(0, 10) : toDate;
    result.push([start, finish]);
    cursor = new Date(`${shiftIsoDate(finish, 1)}T00:00:00Z`);
  }
  return result;
}

function shiftIsoDate(value, days) {
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date.toISOString().slice(0, 10);
}

function allotmentTitleLooksLikeIpo(title, rawPayload = null) {
  const payloadText = rawPayload && typeof rawPayload === 'object'
    ? [rawPayload.SHORT_TEXT, rawPayload.LONG_TEXT, rawPayload.shortText, rawPayload.longText, rawPayload.category]
      .filter(Boolean).join(' ')
    : '';
  const text = `${String(title || '')} ${payloadText}`.toLowerCase();
  if (!text || /供股|配售|rights issue|placing|share option|special purpose|供股股份/.test(text)) return false;
  // 港交所会在正式配发结果后再发澄清/更正公告；这些文件没有完整的发售结构，
  // 不能覆盖真正的配发结果 PDF。
  if (/clarification announcement|correction announcement|supplementary announcement|澄清公告|更正公告|補充公告/.test(text)) return false;
  return /配發結果|分配結果|發售價及配發|分配公告|allotment results|offer price/.test(text);
}

function mergeSourceDocuments(existing, document) {
  const list = Array.isArray(existing) ? existing : [];
  const key = `${document.type || ''}|${document.url || ''}`;
  const merged = new Map(list.map(item => [`${item.type || ''}|${item.url || ''}`, item]));
  merged.set(key, document);
  return [...merged.values()];
}

function shouldPersistAllotmentFacts(parsed, lotteryParserStatus, feeParserStatus, factsParserStatus) {
  return parsed && (
    (parsed.actualPricingDate && parsed.evidence?.actualPricingDate)
    || parsed.finalOfferPrice > 0
    ||
    parsed.parserStatus === 'parsed'
    || lotteryParserStatus === 'parsed'
    || (
      feeParserStatus === 'parsed'
      && parsed.lotAmountHkd != null
      && parsed.applicationFeeHkd != null
    )
    || factsParserStatus === 'parsed'
  );
}

// 只有带当前解析器证据的配发 PDF 才能阻止下一轮重新检索。
// 旧数据里曾把同一份文件同时标成 prospectus/allotment_result，
// 仅凭“有 URL”会长期复用错误文件，导致 03231 等记录一直待补全。
function isVerifiedAllotmentDocument(document) {
  const title = String(document && document.title || '').toLowerCase();
  if (/(clarification announcement|correction announcement|supplementary announcement|澄清公告|更正公告|補充公告)/.test(title)) return false;
  const evidence = document && document.parserEvidence;
  if (!evidence || evidence.factsParserVersion !== HKEX_ALLOTMENT_FACTS_PARSER_VERSION) return false;
  return ['parsed', 'missing'].includes(evidence.oversubscriptionParserStatus)
    && ['parsed', 'missing'].includes(evidence.lotteryParserStatus)
    && ['parsed', 'missing'].includes(evidence.feeParserStatus);
}

// 已由上一事实解析器验证的官方 PDF 可以升级重解析，不重新发现同一公告。
function isReparsableAllotmentDocument(document) {
  if (isVerifiedAllotmentDocument(document)) return true;
  if (!document || document.type !== 'allotment_result' || !document.contentSha256
    || document.parserEvidence?.factsParserVersion !== 'hk-ipo-allotment-facts-v6') return false;
  try { assertOfficialUrl(document.url); } catch (_) { return false; }
  return isVerifiedAllotmentDocument({ ...document,
    parserEvidence: { ...document.parserEvidence, factsParserVersion: HKEX_ALLOTMENT_FACTS_PARSER_VERSION } });
}

function isUsableProspectusDocument(document) {
  if (!document || document.type !== 'prospectus' || !document.url) return false;
  try { assertOfficialUrl(document.url); } catch (_) { return false; }
  // 已发现的官方招股书先下载/重解析，不因尚无解析状态重复检索公告窗口。
  if (/^(?:global offering|全球發售|全球发售)$/i.test(String(document.title || '').trim())) return true;
  if (document.parserStatus === 'parsed') return true;
  const evidence = document.parserEvidence || {};
  return Boolean(evidence.offerCloseAt && evidence.lotSizeShares);
}

// 解析主板/GEM 新上市页面的表格。页面字段顺序会调整，因此按代码、日期和链接推断。
function parseNewListingsHtml(html, { board = '', sourceUrl = '', nameLanguage = 'en' } = {}) {
  const rows = [];
  const rowMatches = String(html || '').match(/<tr\b[\s\S]*?<\/tr>/gi) || [];
  for (const rowHtml of rowMatches) {
    const cells = extractCells(rowHtml);
    const joined = cells.join(' | ');
    const code = codeFromCells(cells);
    if (!code) continue;
    const date = normalizeDate(joined);
    const links = extractLinks(rowHtml, sourceUrl || 'https://www.hkex.com.hk');
    const nameCell = cells.find(cell => cell && !/^\d{1,5}(?:\.HK)?$/.test(cell) && !normalizeDate(cell) && cell.length >= 2) || '';
    const sourceKey = `${code}|${date || ''}|${links[0] ? links[0].href : ''}`;
    const row = {
      securityCode: code,
      board: board || null,
      listingDate: date,
      sourceKey,
      sourceUrl: sourceUrl || null,
      documentUrl: links[0] ? links[0].href : null,
      rawPayload: { cells, links },
    };
    if (nameLanguage === 'zh') {
      if (/[\u3400-\u9fff]/.test(nameCell)) row.securityNameCn = nameCell;
    } else {
      row.securityName = nameCell;
    }
    rows.push(row);
  }
  const seen = new Set();
  return rows.filter(row => !seen.has(row.sourceKey) && seen.add(row.sourceKey));
}

function parsePredefinedDocumentHtml(html, { documentType = '', sourceUrl = '' } = {}) {
  const docs = [];
  const add = (title, href, securityCode = null) => {
    if (!title && !href) return;
    if (documentType === 'allotment_result' && /rights issue|rights shares|供股|配售|placing|share option/i.test(title || '')) return;
    docs.push({
      documentType: documentType || 'official_document',
      title,
      url: href,
      securityCode: securityCode || codeFromDocument(title, href),
      announcedDate: normalizeDate(title) || normalizeDate(href),
      sourceKey: crypto.createHash('sha256').update(`${documentType}|${href}|${securityCode || ''}`).digest('hex'),
    });
  };
  // 新版 www2 页面把证券代码放在表格首列，必须按行关联文件链接，不能仅从 PDF 文件名猜代码。
  const rowMatches = String(html || '').match(/<tr\b[\s\S]*?<\/tr>/gi) || [];
  for (const rowHtml of rowMatches) {
    const code = codeFromCells(extractCells(rowHtml));
    if (!code) continue;
    for (const link of extractLinks(rowHtml, sourceUrl || 'https://www2.hkexnews.hk')) add(link.text, link.href, code);
  }
  // 兼容旧版目录/标题检索页；只有表格无法提供代码时才使用文件名兜底。
  if (!docs.length) {
    for (const match of String(html || '').matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const title = textOfHtml(match[2]);
      const href = new URL(match[1], sourceUrl || 'https://www1.hkexnews.hk').href;
      add(title, href);
    }
  }
  const seen = new Set();
  return docs.filter(doc => !seen.has(doc.sourceKey) && seen.add(doc.sourceKey));
}

module.exports = {
  HKEX_NEW_LISTING_TARGETS,
  HKEX_PREDEFINED_DOCUMENT_TARGETS,
  HKEX_NEW_LISTING_REPORT_TARGETS,
  HKEX_ALLOTMENT_DATASET,
  HKEX_ALLOTMENT_PARSER_VERSION,
  HKEX_ALLOTMENT_FACTS_PARSER_VERSION,
  HKEX_ALLOTMENT_PARSER,
  HKEX_PROSPECTUS_DATASET,
  HKEX_PROSPECTUS_PARSER,
  HKEX_PROSPECTUS_NOT_APPLICABLE,
  HKEX_NON_PUBLIC_DATASET,
  HKEX_LISTING_STATUS_DATASET,
  HKEX_NON_PUBLIC_LISTINGS,
  NON_PUBLIC_IPO_STATUSES,
  assertOfficialUrl,
  fetchOfficialPdfWithCache,
  textOfHtml,
  normalizeDate,
  canonicalHkCode,
  extractCells,
  extractLinks,
  codeFromCells,
  codeFromDocument,
  workbookCellText,
  workbookDate,
  workbookNumber,
  parseNewListingReportWorkbook,
  fetchHkexNewListingReports,
  resolvePython,
  resolveHkexEnglishPdfUrl,
  parseHkexAllotmentPdf,
  parseHkexProspectusPdf,
  monthWindows,
  prospectusSearchWindows,
  shiftIsoDate,
  allotmentTitleLooksLikeIpo,
  mergeSourceDocuments,
  shouldPersistAllotmentFacts,
  isVerifiedAllotmentDocument,
  isReparsableAllotmentDocument,
  isUsableProspectusDocument,
  parseNewListingsHtml,
  parsePredefinedDocumentHtml,
};

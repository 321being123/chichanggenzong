// ========== 港股 IPO 官方事实适配器 ==========
// 这里只负责官方页面探针、表格解析和事实入库；不在没有完整事实时计算正式建议。
// 页面地址允许通过环境变量覆盖，默认地址仅用于人工/定时探针，不在模块加载时联网。
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ExcelJS = require('exceljs');
const { pool } = require('../db/connection');
const { ensureInstrumentIdentity } = require('./securityIdentity');
const { httpRequest, ALLOWED_DOMAINS, searchAnnouncements } = require('./hkexAnnouncement');

const HKEX_NEW_LISTING_TARGETS = Object.freeze([
  {
    key: 'main_board_new_listings',
    board: '主板',
    url: process.env.HKEX_MAIN_BOARD_NEW_LISTINGS_URL || 'https://www2.hkexnews.hk/new-listings/new-listing-information/main-board?sc_lang=en',
  },
  {
    key: 'gem_new_listings',
    board: 'GEM',
    url: process.env.HKEX_GEM_NEW_LISTINGS_URL || 'https://www2.hkexnews.hk/New-Listings/New-Listing-Information/GEM?sc_lang=en',
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
const HKEX_ALLOTMENT_FACTS_PARSER_VERSION = 'hk-ipo-allotment-facts-v5';
const HKEX_ALLOTMENT_PARSER = path.join(__dirname, '..', 'scripts', 'extractHkIpoAllotment.py');
const HKEX_PROSPECTUS_DATASET = 'hkex_ipo_prospectus';
const HKEX_PROSPECTUS_PARSER = path.join(__dirname, '..', 'scripts', 'extractHkIpoProspectus.py');
const HKEX_NON_PUBLIC_DATASET = 'hkex_ipo_non_public_classification';
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
  const localPython = path.join(root, 'venv', 'Scripts', 'python.exe');
  if (process.env.PYTHON) return process.env.PYTHON;
  if (process.platform === 'win32' && fs.existsSync(localPython)) return localPython;
  if (process.platform !== 'win32') {
    const unixPython = path.join(root, 'venv', 'bin', 'python');
    if (fs.existsSync(unixPython)) return unixPython;
  }
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

function parseHkexAllotmentPdf(buffer, { lotSizeShares = null } = {}) {
  return new Promise((resolve, reject) => {
    if (!Buffer.isBuffer(buffer) || !buffer.length) return reject(new Error('港交所配发结果 PDF 为空'));
    const args = [HKEX_ALLOTMENT_PARSER];
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

async function syncHkexAllotmentFacts({
  fromDate = '2025-08-04',
  toDate = todayShanghai(),
  limit = 20,
  refreshLottery = false,
  executor = pool.query.bind(pool),
  fetchImpl = httpRequest,
  searchImpl = searchAnnouncements,
} = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fromDate)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(toDate)) || fromDate > toDate) {
    throw new Error('港股配发结果补全日期范围无效');
  }
  const source = await executor("SELECT source_id FROM ops.data_sources WHERE source_code='hkex_announcements' LIMIT 1");
  if (!source.rows[0]) throw new Error('港交所数据源未登记');
  const candidatesResult = await executor(`
    SELECT security_code,listing_at::date::text AS listing_date,to_char(allotment_at,'YYYY-MM-DD') AS allotment_date,
           lot_size_shares,online_lottery_rate,lot_amount_hkd,application_fee_hkd,brokerage_fee_hkd,
           oversubscribe_multiple,greenshoe_details,source_documents,data_completeness
      FROM public.ipo_history
     WHERE market_code='HK'
       AND COALESCE(ipo_status,'active') NOT IN ('introduction','gem_transfer','de_spac')
       AND (
         (ipo_status='listed' AND listing_at::date BETWEEN $1::date AND $2::date)
         OR (ipo_status IN ('active','priced','allotted') AND allotment_at IS NULL)
       )
       AND (
         $4::boolean
         OR (
           (public_offer_ratio IS NULL OR international_offer_ratio IS NULL)
           AND NOT EXISTS (
             SELECT 1
              FROM jsonb_array_elements(COALESCE(source_documents,'[]'::jsonb)) document
             WHERE document->>'type'='allotment_result'
                AND document->'parserEvidence'->>'lotteryParserStatus'='parsed'
                AND (
                  document->'parserEvidence'->>'parserStatus'='incomplete'
                  OR (
                    document->'parserEvidence'->>'parserStatus' IS NULL
                    AND document->'parserEvidence'->>'oneLotSuccessRate' IS NOT NULL
                  )
                )
           )
         )
         OR (
         online_lottery_rate IS NULL
           AND NOT EXISTS (
             SELECT 1
               FROM jsonb_array_elements(COALESCE(source_documents,'[]'::jsonb)) document
              WHERE document->>'type'='allotment_result'
                AND document->'parserEvidence'->>'lotteryParserStatus'='missing'
           )
         )
         OR (
         (lot_amount_hkd IS NULL OR application_fee_hkd IS NULL OR brokerage_fee_hkd IS NULL)
           AND NOT EXISTS (
             SELECT 1
               FROM jsonb_array_elements(COALESCE(source_documents,'[]'::jsonb)) document
              WHERE document->>'type'='allotment_result'
                AND document->'parserEvidence'->>'feeParserVersion'=$5
                AND document->'parserEvidence'->>'feeParserStatus' IN ('parsed','missing')
           )
         )
         OR (
           oversubscribe_multiple IS NULL
           AND NOT EXISTS (
             SELECT 1
               FROM jsonb_array_elements(COALESCE(source_documents,'[]'::jsonb)) document
              WHERE document->>'type'='allotment_result'
                AND document->'parserEvidence'->>'factsParserVersion'=$6
                AND document->'parserEvidence'->>'oversubscriptionParserStatus' IN ('parsed','missing')
           )
         )
         OR (
           (greenshoe_details IS NULL OR greenshoe_details='{}'::jsonb)
           AND NOT EXISTS (
             SELECT 1
               FROM jsonb_array_elements(COALESCE(source_documents,'[]'::jsonb)) document
              WHERE document->>'type'='allotment_result'
                AND document->'parserEvidence'->>'factsParserVersion'=$6
                AND document->'parserEvidence'->>'greenshoeParserStatus' IN ('parsed','missing')
           )
         )
         OR (
           greenshoe_details->>'overAllocatedShares' IS NOT NULL
           AND COALESCE(greenshoe_details->>'publicOfferSharesBasis','initial_public_offer') = 'initial_public_offer'
         )
       )
     ORDER BY CASE WHEN listing_at IS NULL THEN 0 ELSE 1 END,
              COALESCE(listing_at,NULLIF(updated_at,'')::timestamptz) DESC,security_code
     LIMIT $3`, [fromDate, toDate, Math.max(0, Number(limit) || 0), Boolean(refreshLottery), HKEX_ALLOTMENT_PARSER_VERSION, HKEX_ALLOTMENT_FACTS_PARSER_VERSION]);
  const candidates = candidatesResult.rows;
  const run = await executor(
    `INSERT INTO ops.ingestion_runs(source_id,dataset_code,request_range,status)
     VALUES($1,$2,$3::jsonb,'running') RETURNING run_id`,
    [source.rows[0].source_id, HKEX_ALLOTMENT_DATASET, JSON.stringify({ fromDate, toDate, limit, refreshLottery: Boolean(refreshLottery), candidateCount: candidates.length })]
  );
  const runId = run.rows[0].run_id;
  const byCode = new Map(candidates.map(row => [String(row.security_code).split('.')[0].padStart(5, '0'), row]));
  // 配发结果通常在上市日前 1—3 个工作日公告，首个候选可能跨月，
  // 因此检索窗口至少向前覆盖一个月，避免漏掉月初上市的公告。
  const candidateDates = candidates.map(row => row.listing_date || row.allotment_date)
    .filter(value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))).sort();
  const firstCandidateDate = candidateDates[0] || fromDate;
  const lastCandidateDate = candidateDates[candidateDates.length - 1] || toDate;
  const searchStart = shiftIsoDate(firstCandidateDate, -31) < fromDate ? fromDate : shiftIsoDate(firstCandidateDate, -31);
  const searchEnd = shiftIsoDate(lastCandidateDate, 5) > toDate ? toDate : shiftIsoDate(lastCandidateDate, 5);
  const announcements = [];
  const failures = [];
  let matched = 0;
  let enriched = 0;
  try {
    const candidatesNeedingSearch = candidates.filter(row => {
      const document = (Array.isArray(row.source_documents) ? row.source_documents : [])
        .find(item => item && item.type === 'allotment_result' && item.url);
      return !document;
    });
    if (candidatesNeedingSearch.length) {
      for (const [windowStart, windowEnd] of monthWindows(searchStart, searchEnd)) {
        try {
          const rows = await searchImpl({
            fromDate: windowStart,
            toDate: windowEnd,
            categories: ['15100'],
            _httpRequest: fetchImpl,
          });
          announcements.push(...rows.filter(row => allotmentTitleLooksLikeIpo(row.title, row.rawPayload)));
        } catch (error) {
          failures.push({ stage: 'search', fromDate: windowStart, toDate: windowEnd, error: error.message || String(error) });
        }
      }
    }
    const selected = new Map();
    // 已经落库的官方配发 PDF 直接复用 URL，避免重复检索标题接口；只有缺少
    // 官方文件的证券才回退到 15100 标题检索。
    for (const row of candidates) {
      const document = (Array.isArray(row.source_documents) ? row.source_documents : [])
        .find(item => item && item.type === 'allotment_result' && item.url);
      if (!document) continue;
      const code = String(row.security_code || '').split('.')[0].padStart(5, '0');
      selected.set(code, {
        fileLink: document.sourceUrl || null,
        englishUrl: document.url,
        announcedAt: document.announcedAt || row.allotment_date || null,
        title: document.title || 'HKEX allotment result',
      });
    }
    for (const item of announcements) {
      const code = String(item.stockCode || '').padStart(5, '0');
      if (!byCode.has(code) || selected.has(code)) continue;
      selected.set(code, item);
    }
    matched = selected.size;
    for (const [code, item] of selected) {
      const sourceUrl = item.fileLink || item.sourceUrl || null;
      const englishUrl = item.englishUrl || resolveHkexEnglishPdfUrl(sourceUrl);
      if (!englishUrl) {
        failures.push({ code, stage: 'resolve_document', error: '无法解析英文配发结果 URL' });
        continue;
      }
      try {
        const body = await fetchImpl(englishUrl, { responseType: 'buffer' });
        const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
        const responseSha256 = crypto.createHash('sha256').update(buffer).digest('hex');
        const current = byCode.get(code);
        const parsed = await parseHkexAllotmentPdf(buffer, { lotSizeShares: current && current.lot_size_shares });
        await executor(
          `INSERT INTO ops.raw_records(run_id,source_id,dataset_code,source_key,source_updated_at,payload,payload_hash)
           VALUES($1,$2,$3,$4,now(),$5::jsonb,$6)
           ON CONFLICT(source_id,dataset_code,source_key,payload_hash) DO UPDATE SET run_id=EXCLUDED.run_id,ingested_at=now(),payload=EXCLUDED.payload`,
          [runId, source.rows[0].source_id, HKEX_ALLOTMENT_DATASET, `${code}|${englishUrl}`, JSON.stringify({
            securityCode: `${code}.HK`, sourceUrl, englishUrl,
            announcedAt: item.announcedAt || (current && current.allotment_date) || null,
            responseBytes: buffer.length, responseSha256, parser: parsed,
          }), responseSha256]
        );
        const lotteryRate = Number.isFinite(Number(parsed.oneLotSuccessRate))
          && Number(parsed.oneLotSuccessRate) > 0 && Number(parsed.oneLotSuccessRate) <= 100
          ? Number(parsed.oneLotSuccessRate) : null;
        const lotteryParserStatus = parsed.lotteryParserStatus || (lotteryRate !== null ? 'parsed' : 'missing');
        const feeParserStatus = parsed.feeParserStatus || 'missing';
        const oversubscriptionParserStatus = parsed.oversubscriptionParserStatus || (parsed.publicOversubscription != null ? 'parsed' : 'missing');
        const greenshoeParserStatus = parsed.greenshoeParserStatus || (parsed.greenshoeDetails && parsed.greenshoeDetails.parserStatus) || (parsed.greenshoeDetails && Object.keys(parsed.greenshoeDetails).length ? 'parsed' : 'missing');
        const factsParserStatus = oversubscriptionParserStatus === 'parsed' || greenshoeParserStatus === 'parsed' ? 'parsed' : 'missing';
        const parsedGreenshoeDetails = parsed.greenshoeDetails && typeof parsed.greenshoeDetails === 'object'
          ? parsed.greenshoeDetails : {};
        const greenshoeDetailsForPersist = {
          ...(current.greenshoe_details && typeof current.greenshoe_details === 'object' ? current.greenshoe_details : {}),
          ...parsedGreenshoeDetails,
        };
        // 旧版本曾用初始公开发售股数计算比例。若本次公告没有解析到最终回拨股数，
        // 清除旧口径的分母和比例，避免继续展示不符合当前口径的结果。
        if (parsedGreenshoeDetails.publicOfferSharesBasis === 'final_public_offer_missing'
          && greenshoeDetailsForPersist.publicOfferSharesBasis !== 'final_public_offer_after_reallocation') {
          if (greenshoeDetailsForPersist.initialPublicOfferShares == null
            && greenshoeDetailsForPersist.publicOfferShares != null
            && greenshoeDetailsForPersist.publicOfferSharesBasis === 'initial_public_offer') {
            greenshoeDetailsForPersist.initialPublicOfferShares = greenshoeDetailsForPersist.publicOfferShares;
          }
          delete greenshoeDetailsForPersist.publicOfferShares;
          delete greenshoeDetailsForPersist.finalPublicOfferShares;
          delete greenshoeDetailsForPersist.protectionRatioPct;
          greenshoeDetailsForPersist.publicOfferSharesBasis = 'final_public_offer_missing';
        }
        // 公开发售比例和一手中签率是两组独立事实。部分官方配发 PDF
        // 缺少完整的初始发售股数，但仍有可审计的一手配发表；不能因为
        // 比例结构不完整而丢弃已经解析成功的一手中签率。
        if (!shouldPersistAllotmentFacts(parsed, lotteryParserStatus, feeParserStatus, factsParserStatus)) {
          failures.push({ code, stage: 'parse', error: '配发结果未得到完整初始发售结构或一手中签率', parser: parsed });
          continue;
        }
        const sourceDocuments = mergeSourceDocuments(current.source_documents, {
          type: 'allotment_result',
          url: englishUrl,
          sourceUrl,
          title: item.title || 'HKEX allotment result',
          announcedAt: item.announcedAt || current.allotment_date || null,
          language: 'en',
          ratioBasis: 'final_public_offer_after_reallocation',
          contentSha256: responseSha256,
          parserEvidence: {
            ...parsed.evidence,
            parserStatus: parsed.parserStatus || null,
            oneLotAppliedShares: parsed.oneLotAppliedShares || null,
            oneLotValidApplications: parsed.oneLotValidApplications || null,
            oneLotSuccessfulApplications: parsed.oneLotSuccessfulApplications || null,
            oneLotSuccessRate: parsed.oneLotSuccessRate || null,
            lotteryParserStatus,
            finalOfferPrice: parsed.finalOfferPrice || null,
            brokerageRatePct: parsed.brokerageRatePct || null,
            sfcTransactionLevyRatePct: parsed.sfcTransactionLevyRatePct || null,
            afrcTransactionLevyRatePct: parsed.afrcTransactionLevyRatePct || null,
            stockExchangeTradingFeeRatePct: parsed.stockExchangeTradingFeeRatePct || null,
            lotAmountHkd: parsed.lotAmountHkd || null,
            applicationFeeHkd: parsed.applicationFeeHkd || null,
            brokerageFeeHkd: parsed.brokerageFeeHkd || null,
            feeParserStatus,
            feeParserVersion: parsed.parserVersion || HKEX_ALLOTMENT_PARSER_VERSION,
            publicOversubscription: parsed.publicOversubscription ?? null,
            publicOversubscriptionQualifier: parsed.publicOversubscriptionQualifier || null,
            oversubscriptionParserStatus,
            initialPublicOfferShares: parsed.initialPublicOfferShares ?? null,
            finalPublicOfferShares: parsed.finalPublicOfferShares ?? null,
            finalPublicOfferSharesParserStatus: parsed.finalPublicOfferSharesParserStatus || 'missing',
            initialInternationalOfferShares: parsed.initialInternationalOfferShares ?? null,
            initialOfferSharesTotal: parsed.initialOfferSharesTotal ?? null,
            greenshoeDetails: greenshoeDetailsForPersist,
            greenshoeParserStatus,
            factsParserVersion: HKEX_ALLOTMENT_FACTS_PARSER_VERSION,
          },
        });
        const completeness = {
          ...(current.data_completeness && typeof current.data_completeness === 'object' ? current.data_completeness : {}),
        };
        if (parsed.initialPublicOfferRatio != null) completeness.public_offer_ratio = 'value';
        if (parsed.initialInternationalOfferRatio != null) completeness.international_offer_ratio = 'value';
        if (lotteryRate !== null) completeness.onlineLotteryRate = 'value';
        if (item.announcedAt || current.allotment_date) completeness.allotmentDate = 'value';
        if (parsed.lotAmountHkd != null) completeness.lotAmountHkd = 'value';
        if (parsed.applicationFeeHkd != null) completeness.applicationFeeHkd = 'value';
        if (parsed.brokerageFeeHkd != null) completeness.brokerageFeeHkd = 'value';
        if (parsed.publicOversubscription != null) completeness.publicOversubscription = 'value';
        if (parsed.finalPublicOfferShares != null) completeness.finalPublicOfferShares = 'value';
        if (parsed.greenshoeDetails && parsed.greenshoeDetails.protectionRatioPct != null) completeness.greenshoeProtectionRatio = 'value';
        completeness.greenshoe = greenshoeParserStatus === 'parsed' ? 'value' : 'missing';
        await executor(`
          UPDATE public.ipo_history
             SET public_offer_ratio=COALESCE(public_offer_ratio,$2),
                 international_offer_ratio=COALESCE(international_offer_ratio,$3),
                 online_lottery_rate=COALESCE(online_lottery_rate,$4),
                 allotment_at=COALESCE(allotment_at,$5::timestamptz),
                 lot_amount_hkd=COALESCE(lot_amount_hkd,$6),
                 application_fee_hkd=COALESCE(application_fee_hkd,$7),
                 brokerage_fee_hkd=COALESCE(brokerage_fee_hkd,$8),
                 oversubscribe_multiple=COALESCE(oversubscribe_multiple,$9),
                 greenshoe_details=CASE WHEN $10::jsonb <> '{}'::jsonb THEN COALESCE(greenshoe_details,'{}'::jsonb) || $10::jsonb ELSE greenshoe_details END,
                 source_documents=$11::jsonb,
                 data_completeness=$12::jsonb,
                 facts_published_at=now(),
                 updated_at=to_char(now(),'YYYY-MM-DD HH24:MI:SS')
           WHERE market_code='HK' AND security_code=$1`, [
          `${code}.HK`, parsed.initialPublicOfferRatio, parsed.initialInternationalOfferRatio, lotteryRate,
          item.announcedAt || current.allotment_date || null,
          parsed.lotAmountHkd, parsed.applicationFeeHkd, parsed.brokerageFeeHkd,
          parsed.publicOversubscription, JSON.stringify(greenshoeDetailsForPersist),
          JSON.stringify(sourceDocuments), JSON.stringify(completeness),
        ]);
        enriched += 1;
      } catch (error) {
        failures.push({ code, stage: 'fetch_or_persist', error: error.message || String(error) });
      }
    }
    const status = failures.length ? (enriched ? 'degraded' : 'failed') : 'succeeded';
    await executor(
      `UPDATE ops.ingestion_runs SET status=$2,row_count=$3,error_message=$4,finished_at=now() WHERE run_id=$1`,
      [runId, status, enriched, failures.map(item => `${item.code || item.stage}:${item.error}`).join('; ').slice(0, 2000)]
    );
    return { ok: status !== 'failed', status, runId, candidates: candidates.length, matched, enriched, failures, fromDate, toDate };
  } catch (error) {
    await executor(`UPDATE ops.ingestion_runs SET status='failed',error_message=$2,finished_at=now() WHERE run_id=$1`, [runId, String(error.message || error).slice(0, 2000)]).catch(() => {});
    throw error;
  }
}

// 港交所新上市报表会把介绍上市、GEM 转主板和 De-SPAC 也列入“新上市”。
// 这些项目没有普通公众发售，不得因缺少招股价/每手股数被误判为公众招股数据缺失。
// 分类证据只接受港交所官方文件，并将响应哈希和原文摘要写入审计层。
async function syncHkexNonPublicListings({
  fromDate = '2025-08-04',
  toDate = todayShanghai(),
  limit = 20,
  executor = pool.query.bind(pool),
  fetchImpl = httpRequest,
} = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fromDate)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(toDate)) || fromDate > toDate) {
    throw new Error('港股非公众上市分类日期范围无效');
  }
  const source = await executor("SELECT source_id FROM ops.data_sources WHERE source_code='hkex_announcements' LIMIT 1");
  if (!source.rows[0]) throw new Error('港交所数据源未登记');
  const known = HKEX_NON_PUBLIC_LISTINGS.slice(0, Math.max(0, Number(limit) || 0));
  const candidateResult = await executor(`
    SELECT security_code,listing_at::date::text AS listing_date,source_documents,data_completeness,instrument_id
      FROM public.ipo_history
     WHERE market_code='HK' AND ipo_status='listed'
       AND listing_at::date BETWEEN $1::date AND $2::date
       AND security_code=ANY($3::text[])
     ORDER BY listing_at,security_code`, [fromDate, toDate, known.map(item => item.securityCode)]);
  const candidates = new Map(candidateResult.rows.map(row => [String(row.security_code), row]));
  const selected = known.filter(item => candidates.has(item.securityCode));
  const run = await executor(
    `INSERT INTO ops.ingestion_runs(source_id,dataset_code,request_range,status)
     VALUES($1,$2,$3::jsonb,'running') RETURNING run_id`,
    [source.rows[0].source_id, HKEX_NON_PUBLIC_DATASET, JSON.stringify({ fromDate, toDate, limit, candidateCount: selected.length })]
  );
  const runId = run.rows[0].run_id;
  let enriched = 0;
  const failures = [];
  try {
    for (const item of selected) {
      const current = candidates.get(item.securityCode);
      try {
        const url = assertOfficialUrl(item.sourceUrl);
        const body = await fetchImpl(url, { responseType: 'buffer', maxResponseBytes: 40 * 1024 * 1024 });
        const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
        const responseSha256 = crypto.createHash('sha256').update(buffer).digest('hex');
        const payload = {
          securityCode: item.securityCode,
          sourceUrl: url,
          title: item.title,
          classification: item.ipoStatus,
          listingMethod: item.listingMethod,
          evidence: item.evidence,
          responseBytes: buffer.length,
          responseSha256,
          parserStatus: 'official_evidence_pinned_v1',
        };
        await executor(
          `INSERT INTO ops.raw_records(run_id,source_id,dataset_code,source_key,source_updated_at,payload,payload_hash)
           VALUES($1,$2,$3,$4,now(),$5::jsonb,$6)
           ON CONFLICT(source_id,dataset_code,source_key,payload_hash) DO UPDATE SET run_id=EXCLUDED.run_id,ingested_at=now()`,
          [runId, source.rows[0].source_id, HKEX_NON_PUBLIC_DATASET, `${item.securityCode}|${url}`, JSON.stringify(payload), responseSha256]
        );
        const sourceDocuments = mergeSourceDocuments(current.source_documents, {
          type: 'listing_classification', url, title: item.title, language: 'en',
          classification: item.ipoStatus, listingMethod: item.listingMethod,
          contentSha256: responseSha256, parserStatus: 'official_evidence_pinned_v1', evidence: item.evidence,
        });
        const completeness = {
          ...(current.data_completeness && typeof current.data_completeness === 'object' ? current.data_completeness : {}),
          publicOfferEligibility: 'excluded',
          exclusionReason: item.ipoStatus,
        };
        await executor(`
          UPDATE public.ipo_history
             SET ipo_status=$2,ipo_status_at=now(),source_documents=$3::jsonb,
                 data_completeness=$4::jsonb,facts_published_at=now(),updated_at=to_char(now(),'YYYY-MM-DD HH24:MI:SS')
           WHERE market_code='HK' AND security_code=$1`,
          [item.securityCode, item.ipoStatus, JSON.stringify(sourceDocuments), JSON.stringify(completeness)]
        );
        if (current.instrument_id) {
          await executor(`
            UPDATE core.instruments
               SET status=$2,raw_data=raw_data || $3::jsonb,updated_at=now()
             WHERE instrument_id=$1`,
            [current.instrument_id, item.ipoStatus, JSON.stringify({ source: 'hkex_announcements', listingMethod: item.listingMethod, evidenceUrl: url })]
          );
        }
        enriched += 1;
      } catch (error) {
        failures.push({ code: item.securityCode, stage: 'fetch_or_persist', error: error.message || String(error) });
      }
    }
    const status = failures.length ? (enriched ? 'degraded' : 'failed') : 'succeeded';
    await executor(`UPDATE ops.ingestion_runs SET status=$2,row_count=$3,error_message=$4,finished_at=now() WHERE run_id=$1`,
      [runId, status, enriched, failures.map(item => `${item.code}:${item.error}`).join('; ').slice(0, 2000)]);
    return { ok: status !== 'failed', status, runId, candidates: selected.length, enriched, failures, fromDate, toDate };
  } catch (error) {
    await executor(`UPDATE ops.ingestion_runs SET status='failed',error_message=$2,finished_at=now() WHERE run_id=$1`, [runId, String(error.message || error).slice(0, 2000)]).catch(() => {});
    throw error;
  }
}

async function syncHkexProspectusFacts({
  fromDate = '2025-08-04',
  toDate = todayShanghai(),
  limit = 18,
  refreshSponsor = false,
  executor = pool.query.bind(pool),
  fetchImpl = httpRequest,
  searchImpl = searchAnnouncements,
} = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fromDate)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(toDate)) || fromDate > toDate) {
    throw new Error('港股招股书补全日期范围无效');
  }
  const source = await executor("SELECT source_id FROM ops.data_sources WHERE source_code='hkex_announcements' LIMIT 1");
  if (!source.rows[0]) throw new Error('港交所数据源未登记');
  const candidateLimit = Math.max(0, Number(limit) || 0);
  const candidatesResult = await executor(`
    SELECT security_code,listing_at::date::text AS listing_date,source_documents,data_completeness,
           issue_price_low,issue_price_high,issue_price_final,lot_size_shares,offer_open_at,offer_close_at
     FROM public.ipo_history
     WHERE market_code='HK'
       AND COALESCE(ipo_status,'active') NOT IN ('introduction','gem_transfer','de_spac')
       AND (
         listing_at::date BETWEEN $1::date AND $2::date
         OR (listing_at IS NULL AND ipo_status IN ('active','priced','allotted'))
       )
       AND (
         issue_price_low IS NULL OR issue_price_high IS NULL OR lot_size_shares IS NULL OR offer_open_at IS NULL OR offer_close_at IS NULL
         OR ($4::boolean AND NOT EXISTS (
           SELECT 1
             FROM jsonb_array_elements(COALESCE(source_documents,'[]'::jsonb)) document
            WHERE document->>'type'='prospectus'
              AND document->'parserEvidence'->>'sponsorGroup' IS NOT NULL
         ))
       )
     -- 先重试已有招股书证据但字段不完整的记录，避免每轮都被无公开招股书的项目占满额度。
     ORDER BY CASE WHEN EXISTS (
                SELECT 1 FROM jsonb_array_elements(COALESCE(source_documents,'[]'::jsonb)) document
                 WHERE document->>'type'='prospectus'
              ) THEN 0 ELSE 1 END,
              listing_at,security_code
     LIMIT $3`, [fromDate, toDate, candidateLimit, Boolean(refreshSponsor)]);
  const candidates = candidatesResult.rows;
  const run = await executor(
    `INSERT INTO ops.ingestion_runs(source_id,dataset_code,request_range,status)
     VALUES($1,$2,$3::jsonb,'running') RETURNING run_id`,
    [source.rows[0].source_id, HKEX_PROSPECTUS_DATASET, JSON.stringify({ fromDate, toDate, limit: candidateLimit, refreshSponsor: Boolean(refreshSponsor), candidateCount: candidates.length })]
  );
  const runId = run.rows[0].run_id;
  if (!candidates.length) {
    await executor(`UPDATE ops.ingestion_runs SET status='succeeded',row_count=0,finished_at=now() WHERE run_id=$1`, [runId]);
    return { ok: true, status: 'succeeded', runId, candidates: 0, searched: 0, attempted: 0, enriched: 0, failures: [], fromDate, toDate };
  }

  // 候选查询会优先重试已有招股书证据，顺序不再保证按上市日排列；
  // 检索窗口必须使用全部候选的日期边界，不能取数组首尾。
  const listingDates = candidates.map(candidate => candidate.listing_date)
    .filter(value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))).sort();
  const firstListing = listingDates[0] || fromDate;
  const lastListing = listingDates[listingDates.length - 1] || toDate;
  const searchStart = shiftIsoDate(firstListing, -45) < fromDate ? shiftIsoDate(firstListing, -45) : fromDate;
  const searchEnd = lastListing > toDate ? toDate : lastListing;
  const byCode = new Map(candidates.map(row => [String(row.security_code), row]));
  const announcements = [];
  const failures = [];
  let searched = 0;
  let attempted = 0;
  let enriched = 0;
  try {
    const documentsByCode = new Map();
    const candidatesNeedingSearch = candidates.filter(candidate => {
      const existing = (Array.isArray(candidate.source_documents) ? candidate.source_documents : [])
        .filter(document => document && document.type === 'prospectus' && document.url);
      if (existing.length) {
        documentsByCode.set(String(candidate.security_code), existing.map(document => ({
          fileLink: document.url,
          announcedAt: document.announcedAt || null,
          title: document.title || 'HKEX prospectus',
        })));
        return false;
      }
      return true;
    });
    if (candidatesNeedingSearch.length) {
      for (const [windowStart, windowEnd] of prospectusSearchWindows(searchStart, searchEnd)) {
        try {
          const rows = await searchImpl({
            fromDate: windowStart,
            toDate: windowEnd,
            categories: ['30700'],
            t1code: '30000',
            t2Gcode: '-1',
            _httpRequest: fetchImpl,
          });
          searched += 1;
          announcements.push(...rows.filter(row => row.fileLink && /\.pdf(?:[?#].*)?$/i.test(row.fileLink)));
        } catch (error) {
          failures.push({ stage: 'search', fromDate: windowStart, toDate: windowEnd, error: error.message || String(error) });
        }
      }
    }
    for (const item of announcements) {
      const code = canonicalHkCode(item.stockCode);
      if (!code || !byCode.has(code)) continue;
      const list = documentsByCode.get(code) || [];
      if (!list.some(doc => doc.fileLink === item.fileLink)) list.push(item);
      documentsByCode.set(code, list);
    }
    for (const candidate of candidates) {
      const code = String(candidate.security_code);
      const documents = (documentsByCode.get(code) || []).sort((a, b) => String(a.announcedAt || '').localeCompare(String(b.announcedAt || '')));
      if (!documents.length) {
        failures.push({ code, stage: 'search_match', error: '未找到官方发售以供认购 PDF' });
        continue;
      }
      const aggregate = {};
      for (const [key, value] of Object.entries({
        issuePriceLow: candidate.issue_price_low,
        issuePriceHigh: candidate.issue_price_high,
        issuePriceFinal: candidate.issue_price_final,
        lotSizeShares: candidate.lot_size_shares,
        offerOpenAt: candidate.offer_open_at,
        offerCloseAt: candidate.offer_close_at,
      })) if (value != null) aggregate[key] = value;
      const evidenceDocuments = [];
      const parseDocuments = [];
      for (const document of documents.slice(0, 3)) {
        // 保荐人字段优先复用同一份官方招股书的英文版；英文版附录通常有
        // “3. Joint Sponsors”结构化名单，中文 PDF 的多栏抽取容易丢失公司名。
        if (refreshSponsor) {
          const englishUrl = resolveHkexEnglishPdfUrl(document.fileLink);
          if (englishUrl && englishUrl !== document.fileLink) {
            parseDocuments.push({ ...document, fileLink: englishUrl, originalFileLink: document.fileLink, language: 'en' });
          }
        }
        parseDocuments.push(document);
      }
      const uniqueParseDocuments = parseDocuments.filter((document, index, list) => (
        list.findIndex(item => item.fileLink === document.fileLink) === index
      ));
      const documentLimit = refreshSponsor ? candidateLimit * 2 : candidateLimit;
      for (const document of uniqueParseDocuments.slice(0, 6)) {
        if (attempted >= documentLimit) break;
        attempted += 1;
        try {
          const body = await fetchImpl(document.fileLink, { responseType: 'buffer', maxResponseBytes: 40 * 1024 * 1024 });
          const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
          const responseSha256 = crypto.createHash('sha256').update(buffer).digest('hex');
          const parsed = await parseHkexProspectusPdf(buffer);
          await executor(
            `INSERT INTO ops.raw_records(run_id,source_id,dataset_code,source_key,source_updated_at,payload,payload_hash)
             VALUES($1,$2,$3,$4,now(),$5::jsonb,$6)
             ON CONFLICT(source_id,dataset_code,source_key,payload_hash) DO UPDATE SET run_id=EXCLUDED.run_id,ingested_at=now(),payload=EXCLUDED.payload`,
            [runId, source.rows[0].source_id, HKEX_PROSPECTUS_DATASET, `${code}|${document.fileLink}`, JSON.stringify({
              securityCode: code, sourceUrl: document.fileLink, originalSourceUrl: document.originalFileLink || document.fileLink,
              language: document.language || null, announcedAt: document.announcedAt || null,
              responseBytes: buffer.length, responseSha256, parser: parsed,
            }), responseSha256]
          );
          evidenceDocuments.push({
            type: 'prospectus', url: document.fileLink, sourceUrl: document.originalFileLink || null,
            language: document.language || null, title: document.title || 'HKEX prospectus',
            announcedAt: document.announcedAt || null, contentSha256: responseSha256,
            parserStatus: parsed.parserStatus, parserVersion: parsed.parserVersion || null,
            parserEvidence: {
              ...(parsed.evidence || {}),
              ...(parsed.sponsorGroup ? { sponsorGroup: parsed.sponsorGroup, sponsorGroupEvidence: parsed.evidence?.sponsorGroup || null } : {}),
            },
          });
          for (const [key, value] of Object.entries({
            issuePriceLow: parsed.issuePriceLow,
            issuePriceHigh: parsed.issuePriceHigh,
            lotSizeShares: parsed.lotSizeShares,
            offerOpenAt: parsed.offerOpenAt,
            offerCloseAt: parsed.offerCloseAt,
            sponsorGroup: parsed.sponsorGroup,
          })) {
            if (aggregate[key] == null && value != null) aggregate[key] = value;
          }
          const coreComplete = aggregate.issuePriceLow != null && aggregate.issuePriceHigh != null
            && aggregate.lotSizeShares != null && aggregate.offerCloseAt != null;
          if (coreComplete && (!refreshSponsor || aggregate.sponsorGroup != null)) break;
        } catch (error) {
          failures.push({ code, stage: 'fetch_or_parse', url: document.fileLink, error: error.message || String(error) });
        }
      }
      if (!Object.keys(aggregate).length) continue;
      const currentDocuments = Array.isArray(candidate.source_documents) ? candidate.source_documents : [];
      const sourceDocuments = currentDocuments.slice();
      for (const document of evidenceDocuments) {
        const key = `${document.type}|${document.url}`;
        const index = sourceDocuments.findIndex(item => `${item.type || ''}|${item.url || ''}` === key);
        if (index >= 0) sourceDocuments[index] = { ...sourceDocuments[index], ...document };
        else sourceDocuments.push(document);
      }
      const completeness = {
        ...(candidate.data_completeness && typeof candidate.data_completeness === 'object' ? candidate.data_completeness : {}),
      };
      for (const [key, value] of Object.entries({
        issuePriceLow: aggregate.issuePriceLow, issuePriceHigh: aggregate.issuePriceHigh,
        lotSizeShares: aggregate.lotSizeShares, offerOpenDate: aggregate.offerOpenAt, offerCloseDate: aggregate.offerCloseAt,
        sponsorGroup: aggregate.sponsorGroup,
      })) if (value != null) completeness[key] = 'value';
      await executor(`
        UPDATE public.ipo_history
           SET issue_price_low=COALESCE(issue_price_low,$2),
               issue_price_high=COALESCE(issue_price_high,$3),
               issue_price_final=COALESCE(issue_price_final,CASE WHEN $2 IS NOT NULL AND $3 IS NOT NULL AND $2=$3 THEN $2 END),
               lot_size_shares=COALESCE(lot_size_shares,$4),
               offer_open_at=COALESCE(offer_open_at,$5::timestamptz),
               offer_close_at=COALESCE(offer_close_at,$6::timestamptz),
               source_documents=$7::jsonb,
               data_completeness=$8::jsonb,
               facts_published_at=now(),updated_at=to_char(now(),'YYYY-MM-DD HH24:MI:SS')
         WHERE market_code='HK' AND security_code=$1`, [
        code, aggregate.issuePriceLow || null, aggregate.issuePriceHigh || null, aggregate.lotSizeShares || null,
        aggregate.offerOpenAt || null, aggregate.offerCloseAt || null, JSON.stringify(sourceDocuments), JSON.stringify(completeness),
      ]);
      enriched += 1;
    }
    const status = failures.length ? (enriched ? 'degraded' : 'failed') : 'succeeded';
    await executor(`UPDATE ops.ingestion_runs SET status=$2,row_count=$3,error_message=$4,finished_at=now() WHERE run_id=$1`,
      [runId, status, enriched, failures.map(item => `${item.code || item.stage}:${item.error}`).join('; ').slice(0, 2000)]);
    return { ok: status !== 'failed', status, runId, candidates: candidates.length, searched, attempted, enriched, failures, fromDate, toDate };
  } catch (error) {
    await executor(`UPDATE ops.ingestion_runs SET status='failed',error_message=$2,finished_at=now() WHERE run_id=$1`, [runId, String(error.message || error).slice(0, 2000)]).catch(() => {});
    throw error;
  }
}

async function syncHkexHistoricalReports({
  fromDate = '2025-08-04',
  toDate = todayShanghai(),
  years = [2025, 2026],
  fetchImpl = httpRequest,
} = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fromDate)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(toDate)) || fromDate > toDate) {
    throw new Error('港股 IPO 历史报表日期范围无效');
  }
  const reports = await fetchHkexNewListingReports({ years, fetchImpl });
  const rows = reports.flatMap(report => (report.items || [])
    .filter(item => item.listingDate && item.listingDate >= fromDate && item.listingDate <= toDate)
    .map(item => ({
      ...item,
      sourceDocuments: [{ type: 'new_listing_report', url: report.url, title: `${report.board} ${report.year} 官方新上市报表` }],
    })));
  const source = await pool.query("SELECT source_id FROM ops.data_sources WHERE source_code='hkex_announcements' LIMIT 1");
  if (!source.rows[0]) throw new Error('港交所数据源未登记');
  const range = { fromDate, toDate, years, targetCount: reports.length, reportKeys: reports.map(report => report.key) };
  const run = await pool.query(
    `INSERT INTO ops.ingestion_runs(source_id,dataset_code,request_range,status)
     VALUES($1,'hkex_ipo_history_report',$2::jsonb,'running') RETURNING run_id`,
    [source.rows[0].source_id, JSON.stringify(range)]
  );
  const runId = run.rows[0].run_id;
  try {
    for (const report of reports) {
      const payload = {
        key: report.key,
        board: report.board,
        year: report.year,
        url: report.url,
        ok: report.ok,
        responseBytes: report.responseBytes || 0,
        responseSha256: report.responseSha256 || null,
        parserStatus: report.parserStatus || 'not_run',
        rowCount: report.rowCount || 0,
        error: report.error || null,
        items: report.items || [],
      };
      const payloadText = JSON.stringify(payload);
      await pool.query(
        `INSERT INTO ops.raw_records(run_id,source_id,dataset_code,source_key,source_updated_at,payload,payload_hash)
         VALUES($1,$2,'hkex_ipo_history_report',$3,now(),$4::jsonb,$5)
         ON CONFLICT(source_id,dataset_code,source_key,payload_hash) DO UPDATE SET run_id=EXCLUDED.run_id,ingested_at=now()`,
        [runId, source.rows[0].source_id, report.key, payloadText, report.responseSha256 || crypto.createHash('sha256').update(payloadText).digest('hex')]
      );
    }
    const upserted = await upsertHkIpoFacts(rows, { sourceCode: 'hkex_announcements' });
    const failures = reports.filter(report => !report.ok);
    const status = reports.length && !failures.length ? 'succeeded' : rows.length ? 'degraded' : 'failed';
    const errorMessage = failures.map(report => `${report.key}:${report.error || 'failed'}`).join('; ').slice(0, 2000);
    await pool.query(
      `UPDATE ops.ingestion_runs SET status=$2,row_count=$3,error_message=$4,finished_at=now() WHERE run_id=$1`,
      [runId, status, rows.length, errorMessage]
    );
    return { ok: status !== 'failed', status, runId, reports: reports.length, rows: rows.length, upserted, failures: failures.length, fromDate, toDate };
  } catch (error) {
    await pool.query(`UPDATE ops.ingestion_runs SET status='failed',error_message=$2,finished_at=now() WHERE run_id=$1`, [runId, String(error.message || error).slice(0, 2000)]).catch(() => {});
    throw error;
  }
}

// 解析主板/GEM 新上市页面的表格。页面字段顺序会调整，因此按代码、日期和链接推断。
function parseNewListingsHtml(html, { board = '', sourceUrl = '' } = {}) {
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
    rows.push({
      securityCode: code,
      securityName: nameCell,
      board: board || null,
      listingDate: date,
      sourceKey,
      sourceUrl: sourceUrl || null,
      documentUrl: links[0] ? links[0].href : null,
      rawPayload: { cells, links },
    });
  }
  const seen = new Set();
  return rows.filter(row => !seen.has(row.sourceKey) && seen.add(row.sourceKey));
}

function parsePredefinedDocumentHtml(html, { documentType = '', sourceUrl = '' } = {}) {
  const docs = [];
  const add = (title, href, securityCode = null) => {
    if (!title && !href) return;
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

async function persistHkexProbe(result, { environment = 'local', executor = pool.query.bind(pool) } = {}) {
  if (!['local', 'server'].includes(environment)) throw new Error(`未知探针环境：${environment}`);
  const source = await executor("SELECT source_id FROM ops.data_sources WHERE source_code='hkex_announcements' LIMIT 1");
  if (!source.rows[0]) throw new Error('港交所数据源未登记');
  const targets = Array.isArray(result?.targets) ? result.targets : [];
  const invalidEvidence = targets.filter(target => target.ok && (!/^2\d\d$/.test(String(target.httpStatus || ''))
    || !/^[0-9a-f]{64}$/i.test(String(target.responseSha256 || ''))
    || !target.parserStatus || target.parserStatus === 'not_run' || target.parserStatus === 'http_ok_remote_parser_not_run'));
  const status = targets.length && !invalidEvidence.length && targets.every(target => target.ok)
    ? 'succeeded' : targets.some(target => target.ok) ? 'degraded' : 'failed';
  if (invalidEvidence.length) throw new Error(`探针证据不完整：${invalidEvidence.map(target => target.key).join('、')}`);
  const run = await executor(
    `INSERT INTO ops.ingestion_runs(source_id,dataset_code,request_range,status,row_count,error_message,finished_at)
     VALUES($1,'hkex_ipo_probe',$2::jsonb,$3,$4,$5,now()) RETURNING run_id`,
    [source.rows[0].source_id, JSON.stringify({ environment, generatedAt: result?.generatedAt || null, targetCount: targets.length }), status,
      targets.reduce((sum, target) => sum + Number(target.rowCount || 0), 0), targets.filter(target => !target.ok).map(target => `${target.key}:${target.error || 'failed'}`).join('; ').slice(0, 2000)]
  );
  if (targets.length) {
    await executor(
      `INSERT INTO ops.raw_records(run_id,source_id,dataset_code,source_key,source_updated_at,payload,payload_hash)
       SELECT $1,$2,'hkex_ipo_probe',x.source_key,now(),x.payload,md5(x.payload::text)
         FROM jsonb_to_recordset($3::jsonb) AS x(source_key text,payload jsonb)
       ON CONFLICT(source_id,dataset_code,source_key,payload_hash) DO NOTHING`,
      [run.rows[0].run_id, source.rows[0].source_id, JSON.stringify(targets.map(target => ({
        source_key: `${environment}|${target.key}|${target.responseSha256 || target.requestedAt || ''}`,
        payload: { environment, key: target.key, url: target.url, ok: target.ok, httpStatus: target.httpStatus || null,
          parserStatus: target.parserStatus, rowCount: target.rowCount || 0, responseBytes: target.responseBytes || 0,
          responseSha256: target.responseSha256 || null, dns: target.dns || null, cookieRequired: target.cookieRequired || null,
          wafSignals: target.wafSignals || [], error: target.error || null },
      })))]
    );
  }
  return { runId: run.rows[0].run_id, environment, status, targets: targets.length };
}

function buildProbePlan() {
  return [
    ...HKEX_NEW_LISTING_TARGETS.map(item => ({ ...item, source: 'www2.hkexnews.hk', probeType: 'new_listing_table' })),
    ...HKEX_PREDEFINED_DOCUMENT_TARGETS.map(item => ({ ...item, source: 'www1.hkexnews.hk', probeType: 'predefined_document' })),
    { key: 'title_search', source: 'www1.hkexnews.hk', probeType: 'title_search', url: 'https://www1.hkexnews.hk/search/titleSearchServlet.do' },
  ].map(item => ({ ...item, url: assertOfficialUrl(item.url) }));
}

async function runHkexIpoProbe({ fetchImpl = httpRequest, targets = buildProbePlan() } = {}) {
  const results = [];
  for (const target of targets) {
    const requestedAt = new Date().toISOString();
    try {
      const body = await fetchImpl(target.url);
      const text = String(body || '');
      const items = target.probeType === 'new_listing_table'
        ? parseNewListingsHtml(text, { board: target.board, sourceUrl: target.url })
        : target.probeType === 'predefined_document'
          ? parsePredefinedDocumentHtml(text, { documentType: target.documentType, sourceUrl: target.url })
          : [];
      results.push({
        ...target,
        ok: true,
        requestedAt,
        httpStatus: 200,
        dns: 'node:https（解析结果由运行环境提供）',
        cookieRequired: 'unknown',
        wafSignals: [],
        guardPolicy: 'hkex/anonymous（由 withExternalCallGuard 执行）',
        parserStatus: items.length ? 'parsed' : 'empty_unconfirmed',
        fallback: '保留旧分区；不得将空响应解释为无新股',
        responseBytes: Buffer.byteLength(text),
        responseSha256: crypto.createHash('sha256').update(text).digest('hex'),
        rowCount: items.length,
        items,
      });
    } catch (error) {
      const message = error.message || String(error);
      results.push({ ...target, ok: false, requestedAt, httpStatus: error.code && /^\d+$/.test(String(error.code)) ? Number(error.code) : null,
        dns: 'unknown', cookieRequired: 'unknown', wafSignals: /waf|captcha|forbidden|403|429/i.test(message) ? [message] : [],
        guardPolicy: 'hkex/anonymous（由 withExternalCallGuard 执行）', parserStatus: 'not_run', fallback: '保留旧分区；等待下一次探针', error: message, rowCount: 0, items: [] });
    }
  }
  return { generatedAt: new Date().toISOString(), targets: results };
}

function todayShanghai() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
}

function dateIsOnOrBefore(value, asOfDate) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) && String(value) <= asOfDate;
}

function stageForRow(row, asOfDate = todayShanghai()) {
  if (dateIsOnOrBefore(row.listingDate, asOfDate)) return 'listed';
  if (dateIsOnOrBefore(row.allotmentDate, asOfDate)) return 'allotted';
  if (dateIsOnOrBefore(row.pricingDate, asOfDate)) return 'priced';
  if (dateIsOnOrBefore(row.offerOpenDate, asOfDate)) return 'active';
  return 'active';
}

function completenessForRow(row) {
  const fields = ['offerOpenDate', 'offerCloseDate', 'pricingDate', 'allotmentDate', 'listingDate', 'issuePriceFinal', 'lotSizeShares'];
  const result = {};
  for (const field of fields) result[field] = row[field] == null || row[field] === '' ? 'missing' : 'value';
  return result;
}

async function upsertHkIpoFacts(rows, { sourceCode = 'hkex_announcements' } = {}) {
  const input = Array.isArray(rows) ? rows.filter(row => canonicalHkCode(row.securityCode)) : [];
  if (!input.length) return { ok: true, rows: 0, events: 0 };
  const client = await pool.connect();
  let events = 0;
  try {
    await client.query('BEGIN');
    const sourceResult = await client.query('SELECT source_id FROM ops.data_sources WHERE source_code=$1 LIMIT 1', [sourceCode]);
    if (!sourceResult.rows[0]) throw new Error(`未登记数据源：${sourceCode}`);
    const sourceId = sourceResult.rows[0].source_id;
    for (const row of input) {
      const canonicalCode = canonicalHkCode(row.securityCode);
      const status = stageForRow(row);
      const identity = await ensureInstrumentIdentity({
        canonicalCode,
        name: row.securityName || canonicalCode,
        assetClass: 'stock',
        market: 'HK',
        exchangeCode: 'HKEX',
        currencyCode: 'HKD',
        listDate: row.listingDate || null,
        status: stageForRow(row) === 'listed' ? 'listed' : 'pre_listing',
        rawData: { source: sourceCode, board: row.board || null },
        identifiers: [[sourceCode, 'security_code', canonicalCode]],
      }, client.query.bind(client));
      const sourceDocuments = Array.isArray(row.sourceDocuments) ? row.sourceDocuments : [];
      await client.query(`
        INSERT INTO public.ipo_history(
          security_code,security_name,market_type,listing_date,ipo_date,market_code,instrument_id,ipo_status,
          offer_open_at,offer_close_at,pricing_at,allotment_at,listing_at,issue_price_low,issue_price_high,
          issue_price_final,lot_size_shares,lot_amount_hkd,application_fee_hkd,brokerage_fee_hkd,
          public_offer_ratio,international_offer_ratio,cornerstone_details,greenshoe_details,source_documents,
          data_completeness,facts_published_at,updated_at
        ) VALUES($1,$2,$3,$4,$5,'HK',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb,$23::jsonb,$24::jsonb,$25::jsonb,
          CASE WHEN $4 IS NOT NULL OR $8 IS NOT NULL OR $9 IS NOT NULL OR $10 IS NOT NULL OR $11 IS NOT NULL OR $12 IS NOT NULL OR $15 IS NOT NULL OR $16 IS NOT NULL THEN now() END,
          to_char(now(),'YYYY-MM-DD HH24:MI:SS'))
        ON CONFLICT(security_code) DO UPDATE SET
          security_name=COALESCE(NULLIF(EXCLUDED.security_name,''),ipo_history.security_name),
          market_type=COALESCE(EXCLUDED.market_type,ipo_history.market_type),listing_date=COALESCE(EXCLUDED.listing_date,ipo_history.listing_date),
          ipo_date=COALESCE(EXCLUDED.ipo_date,ipo_history.ipo_date),market_code='HK',instrument_id=EXCLUDED.instrument_id,
          ipo_status=CASE
            WHEN ipo_history.ipo_status IN ('introduction','gem_transfer','de_spac') THEN ipo_history.ipo_status
            WHEN EXCLUDED.ipo_status='active' AND ipo_history.ipo_status IN ('priced','allotted','listed') THEN ipo_history.ipo_status
            ELSE EXCLUDED.ipo_status
          END,
          offer_open_at=COALESCE(EXCLUDED.offer_open_at,ipo_history.offer_open_at),
          offer_close_at=COALESCE(EXCLUDED.offer_close_at,ipo_history.offer_close_at),pricing_at=COALESCE(EXCLUDED.pricing_at,ipo_history.pricing_at),
          allotment_at=COALESCE(EXCLUDED.allotment_at,ipo_history.allotment_at),listing_at=COALESCE(EXCLUDED.listing_at,ipo_history.listing_at),
          issue_price_low=COALESCE(EXCLUDED.issue_price_low,ipo_history.issue_price_low),issue_price_high=COALESCE(EXCLUDED.issue_price_high,ipo_history.issue_price_high),
          issue_price_final=COALESCE(EXCLUDED.issue_price_final,ipo_history.issue_price_final),lot_size_shares=COALESCE(EXCLUDED.lot_size_shares,ipo_history.lot_size_shares),
          lot_amount_hkd=COALESCE(EXCLUDED.lot_amount_hkd,ipo_history.lot_amount_hkd),application_fee_hkd=COALESCE(EXCLUDED.application_fee_hkd,ipo_history.application_fee_hkd),
          brokerage_fee_hkd=COALESCE(EXCLUDED.brokerage_fee_hkd,ipo_history.brokerage_fee_hkd),public_offer_ratio=COALESCE(EXCLUDED.public_offer_ratio,ipo_history.public_offer_ratio),
          international_offer_ratio=COALESCE(EXCLUDED.international_offer_ratio,ipo_history.international_offer_ratio),cornerstone_details=ipo_history.cornerstone_details || EXCLUDED.cornerstone_details,
          greenshoe_details=ipo_history.greenshoe_details || EXCLUDED.greenshoe_details,
          source_documents=(
            SELECT COALESCE(jsonb_agg(DISTINCT document), '[]'::jsonb)
              FROM jsonb_array_elements(COALESCE(ipo_history.source_documents,'[]'::jsonb) || COALESCE(EXCLUDED.source_documents,'[]'::jsonb)) AS document
          ),
          data_completeness=COALESCE(ipo_history.data_completeness,'{}'::jsonb) || COALESCE(EXCLUDED.data_completeness,'{}'::jsonb),
          facts_published_at=CASE
            WHEN EXCLUDED.listing_date IS NOT NULL OR EXCLUDED.offer_open_at IS NOT NULL
              OR EXCLUDED.offer_close_at IS NOT NULL OR EXCLUDED.pricing_at IS NOT NULL
              OR EXCLUDED.allotment_at IS NOT NULL OR EXCLUDED.issue_price_final IS NOT NULL
              OR EXCLUDED.lot_size_shares IS NOT NULL THEN now()
            ELSE ipo_history.facts_published_at
          END,
          updated_at=to_char(now(),'YYYY-MM-DD HH24:MI:SS')`,
        [canonicalCode, row.securityName || '', row.board || null, row.listingDate || null, row.offerOpenDate || null,
          identity.instrumentId, status, row.offerOpenDate || null, row.offerCloseDate || null, row.pricingDate || null,
          row.allotmentDate || null, row.listingDate || null, row.issuePriceLow || null, row.issuePriceHigh || null,
          row.issuePriceFinal || null, row.lotSizeShares || null, row.lotAmountHkd || null, row.applicationFeeHkd || null,
          row.brokerageFeeHkd || null, row.publicOfferRatio || null, row.internationalOfferRatio || null,
          JSON.stringify(row.cornerstoneDetails || {}), JSON.stringify(row.greenshoeDetails || {}), JSON.stringify(sourceDocuments),
          JSON.stringify(row.dataCompleteness || completenessForRow(row))]
      );
      const eventRows = [
        ['offer_open', row.offerOpenDate], ['offer_close', row.offerCloseDate], ['pricing', row.pricingDate],
        ['allotment_result', row.allotmentDate], ['hk_listing', row.listingDate],
      ];
      for (const [eventType, eventDate] of eventRows) {
        if (!eventDate || !/^\d{4}-\d{2}-\d{2}$/.test(String(eventDate).slice(0, 10))) continue;
        await client.query(`INSERT INTO event.instrument_events(instrument_id,event_type,event_date,event_at,source_id,source_key,details,source_updated_at)
          VALUES($1,$2,$3::date,$3::date,$4,$5,$6::jsonb,now())
          ON CONFLICT(source_id,source_key) DO UPDATE SET event_date=EXCLUDED.event_date,event_at=EXCLUDED.event_at,details=EXCLUDED.details,updated_at=now()`,
          [identity.instrumentId, eventType, String(eventDate).slice(0, 10), sourceId, `${canonicalCode}|${eventType}|${String(eventDate).slice(0, 10)}`,
            JSON.stringify({ market: 'HK', board: row.board || null, sourceUrl: row.sourceUrl || null })]);
        events += 1;
      }
    }
    await client.query('COMMIT');
    return { ok: true, rows: input.length, events };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  HKEX_NEW_LISTING_TARGETS,
  HKEX_NEW_LISTING_REPORT_TARGETS,
  HKEX_PREDEFINED_DOCUMENT_TARGETS,
  buildProbePlan,
  runHkexIpoProbe,
  persistHkexProbe,
  parseNewListingsHtml,
  parseNewListingReportWorkbook,
  fetchHkexNewListingReports,
  HKEX_NON_PUBLIC_LISTINGS,
  syncHkexNonPublicListings,
  resolveHkexEnglishPdfUrl,
  parseHkexAllotmentPdf,
  allotmentTitleLooksLikeIpo,
  shouldPersistAllotmentFacts,
  parseHkexProspectusPdf,
  syncHkexAllotmentFacts,
  syncHkexProspectusFacts,
  syncHkexHistoricalReports,
  parsePredefinedDocumentHtml,
  upsertHkIpoFacts,
  canonicalHkCode,
  normalizeDate,
  stageForRow,
};

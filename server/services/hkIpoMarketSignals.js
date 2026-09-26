// 港股 IPO 非官方市场信号适配器。
// 这里只保存带来源和时间的申购期认购倍数、暗盘价格/涨幅；失败时保留历史快照。
const https = require('https');
const crypto = require('crypto');
const { pool } = require('../db');
const { withExternalCallGuard } = require('./externalCallGuard');

const LIVERMORE_CURRENT_URL = 'https://trade-info-api.jesselivermore.com/api/info/get-h5-ipo-setting';
const LIVERMORE_HISTORY_URL = 'https://h5stockserver.huanshoulv.com/aimapp/hkstock/hotNewStock';
const VBKR_IPO_CURRENT_URL = 'https://web-api.vbkr.com/ipo/hk-stock/query-applying?needPending=true&needApplyInfo=true';
const FUTU_IPO_URL = 'https://www.futunn.com/quote/hk/ipo';
const HKIPOX_URL = 'https://hkipox.com/';
const ALLOWED_HOSTS = new Set([
  'trade-info-api.jesselivermore.com',
  'h5stockserver.huanshoulv.com',
  'web-api.vbkr.com',
  'www.futunn.com',
  'hkipox.com',
]);

function todayShanghai() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
}

function normalizeCode(value) {
  const text = String(value || '').trim().replace(/\.HK$/i, '');
  const match = text.match(/\d{1,5}/);
  return match ? `${match[0].padStart(5, '0')}.HK` : null;
}

function normalizeDate(value) {
  const text = String(value || '').trim();
  const match = text.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  return match ? `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}` : null;
}

function normalizeObservedAt(value, date) {
  const text = String(value || '').trim();
  if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}[ T]\d{2}:\d{2}(:\d{2})?/.test(text)) {
    const d = normalizeDate(text);
    const time = text.replace(/^.*?[ T]/, '').slice(0, 8);
    return d ? `${d}T${time}+08:00` : null;
  }
  if (/^\d{2}:\d{2}(:\d{2})?$/.test(text) && date) return `${date}T${text.length === 5 ? `${text}:00` : text}+08:00`;
  return null;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/[%+,，]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function hasChinese(value) {
  return /[\u3400-\u9fff]/.test(String(value || ''));
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x2F;/gi, '/')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function requestExternal(url, { format = 'json', timeoutMs = 15000 } = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.has(parsed.hostname)) {
    return Promise.reject(new Error(`港股 IPO 市场信号地址不在白名单：${parsed.hostname}`));
  }
  return new Promise((resolve, reject) => {
    const req = https.get(parsed, {
      headers: {
        'User-Agent': 'portfolio-server/1.0',
        Referer: parsed.hostname === 'hkipox.com' ? 'https://hkipox.com/'
          : parsed.hostname === 'www.futunn.com' ? 'https://www.futunn.com/quote/hk/ipo'
          : parsed.hostname === 'web-api.vbkr.com' ? 'https://www.vbkr.com/ipo/hk/v2/ipo-hk-index'
            : 'https://1877.jesselivermore.com/',
        Accept: format === 'json' ? 'application/json,text/plain,*/*' : 'text/html,application/xhtml+xml,*/*',
      },
    }, response => {
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes <= 6 * 1024 * 1024) chunks.push(chunk);
      });
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode >= 400) {
          const error = new Error(`港股 IPO 市场信号 HTTP ${response.statusCode}`);
          error.code = response.statusCode === 429 ? 'RATE_LIMIT' : response.statusCode >= 500 ? 'UPSTREAM_5XX' : response.statusCode === 401 || response.statusCode === 403 ? 'AUTH_ERROR' : 'UPSTREAM_HTTP';
          error.errorType = response.statusCode === 429 ? 'rate_limit' : response.statusCode >= 500 ? 'network' : 'upstream';
          reject(error);
          return;
        }
        try {
          resolve(format === 'json' ? JSON.parse(body) : body);
        } catch (error) {
          error.code = 'UPSTREAM_FORMAT';
          reject(error);
        }
      });
    });
    req.setTimeout(timeoutMs, () => {
      const error = new Error('港股 IPO 市场信号请求超时');
      error.code = 'UPSTREAM_TIMEOUT';
      error.errorType = 'network';
      req.destroy(error);
    });
    req.on('error', reject);
  });
}

function validateFutuIpoHtmlResponse(html) {
  const text = String(html || '').trim();
  if (!text) {
    const error = new Error('富途 IPO 页面返回空响应');
    error.code = 'UPSTREAM_EMPTY';
    error.errorType = 'empty_data';
    throw error;
  }
  const hasListItem = /class=["'][^"']*\blist-item\b/i.test(text);
  if (!hasListItem && /(login|sign\s*in|登入|登录)/i.test(text)) {
    const error = new Error('富途 IPO 页面疑似登录失效');
    error.code = 'AUTH_ERROR';
    error.errorType = 'permission';
    throw error;
  }
  // 页面可以合法返回无 IPO 项，但必须仍然是 IPO 页面；不识别的 HTML 不能当作空数据。
  if (!hasListItem && !/(\bipo\b|新股)/i.test(text)) {
    const error = new Error('富途 IPO 页面结构无法识别');
    error.code = 'UPSTREAM_FORMAT';
    error.errorType = 'upstream';
    throw error;
  }
  return text;
}

function extractLivermoreRecords(payload) {
  const data = payload && payload.data;
  if (Array.isArray(data)) return data.filter(item => item && typeof item === 'object');
  if (Array.isArray(payload)) return payload.filter(item => item && typeof item === 'object');
  if (!data || typeof data !== 'object') return [];
  if (Array.isArray(data.list)) {
    const fields = Array.isArray(data.fields) ? data.fields : [];
    return data.list.map(item => {
      if (item && typeof item === 'object' && !Array.isArray(item)) return item;
      if (!Array.isArray(item) || !fields.length) return null;
      return Object.fromEntries(fields.map((field, index) => [field, item[index]]));
    }).filter(Boolean);
  }
  for (const key of ['rows', 'items', 'result', 'data']) {
    if (Array.isArray(data[key])) return data[key].filter(item => item && typeof item === 'object');
  }
  return [];
}

function parseLivermoreHistory(payload) {
  return extractLivermoreRecords(payload).map(item => ({
    securityCode: normalizeCode(item.stock_code || item.code || item.stockCode),
    securityName: String(item.stock_name || item.stock_name_cn || item.name || '').trim(),
    issueDate: normalizeDate(item.issue_date || item.listing_date || item.listDate),
    offerCloseDate: normalizeDate(item.expiration_date || item.offer_close_date || item.internet_cutofftime),
    subscriptionMultiple: finiteNumber(item.over_subscribed_multiple || item.subscription_multiple),
    greyMarketPrice: finiteNumber(item.actualquotation_price || item.dark_price || item.open_px),
    greyMarketChangePct: finiteNumber(item.actualquotation_change_rate || item.dark_change_rate || item.px_close_rate_dark),
    raw: item,
  })).filter(item => item.securityCode);
}

function parseLivermoreCurrent(payload) {
  return parseLivermoreHistory(payload).filter(item => item.subscriptionMultiple !== null && item.subscriptionMultiple > 0);
}

function parseMultiple(value) {
  if (value === null || value === undefined || value === '') return null;
  const match = String(value).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return match ? finiteNumber(match[0]) : null;
}

function firstNonEmpty(...values) {
  return values.find(value => value !== null && value !== undefined && value !== '') ?? null;
}

function extractVbkrApplyingRecords(payload) {
  const data = payload && payload.data;
  const list = data && Array.isArray(data.applying) ? data.applying
    : data && Array.isArray(data.stockList) ? data.stockList
      : Array.isArray(payload && payload.applying) ? payload.applying : [];
  return list.filter(item => item && typeof item === 'object');
}

function parseVbkrCurrent(payload) {
  return extractVbkrApplyingRecords(payload).map(item => {
    const info = item.ipoInfo && typeof item.ipoInfo === 'object' ? item.ipoInfo : item;
    return {
      securityCode: normalizeCode(info.securityCode || info.security_code || info.code),
      securityName: String(info.securityNameTc || info.securityName || info.security_name || info.name || '').trim(),
      issueDate: normalizeDate(info.applyStartDate || info.apply_start_date || info.issueDate),
      offerCloseDate: normalizeDate(info.applyEndTime || info.apply_end_time || info.offerCloseDate || info.offer_close_date),
      subscriptionMultiple: parseMultiple(firstNonEmpty(info.applyRate, info.apply_rate, info.bookingRatio, info.booking_ratio)),
      raw: item,
    };
  }).filter(item => item.securityCode && item.subscriptionMultiple !== null && item.subscriptionMultiple > 0);
}

function spanValue(html, className) {
  const match = String(html || '').match(new RegExp(`<span\\b[^>]*class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/span>`, 'i'));
  if (!match) return '';
  const title = match[0].match(/\btitle=["']([^"']*)["']/i);
  return decodeHtml(title ? title[1] : match[1]);
}

function parseFutuIpoHtml(html) {
  const rows = [];
  const matches = String(html || '').match(/<a\b[^>]*class=["'][^"']*\blist-item\b[^"']*["'][^>]*>[\s\S]*?<\/a>/gi) || [];
  for (const row of matches) {
    const securityCode = normalizeCode(spanValue(row, 'code'));
    if (!securityCode) continue;
    const darkText = spanValue(row, 'value-darkChangeRatio');
    const listingDate = normalizeDate(spanValue(row, 'value-listingDate'));
    rows.push({
      securityCode,
      securityName: spanValue(row, 'name'),
      listingDate,
      greyMarketChangePct: finiteNumber(darkText),
      raw: { code: securityCode, name: spanValue(row, 'name'), darkChangeRatio: darkText, listingDate },
    });
  }
  return rows;
}

function parseHkIpoXHtml(html) {
  const text = String(html || '');
  const heading = text.match(/<h2\b[^>]*>\s*今日申购[\s\S]*?<\/h2>/i);
  if (!heading) {
    const error = new Error('HKIPOx 页面未找到“今日申购”区块');
    error.code = 'UPSTREAM_FORMAT';
    error.errorType = 'upstream';
    throw error;
  }
  const sectionStart = text.indexOf(heading[0]);
  const sectionEnd = text.indexOf('</section>', sectionStart);
  const section = text.slice(sectionStart, sectionEnd < 0 ? undefined : sectionEnd);
  if (!/<table\b/i.test(section) || !/data-label=["']代码["']/i.test(section) || !/data-label=["']认购倍数["']/i.test(section)) {
    const error = new Error('HKIPOx 今日申购区块缺少预期数据列');
    error.code = 'UPSTREAM_FORMAT';
    error.errorType = 'upstream';
    throw error;
  }
  const rows = section.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || [];
  const labelValue = (row, label) => {
    const cell = row.match(new RegExp(`<td\\b[^>]*data-label=["']${label}["'][^>]*>([\\s\\S]*?)<\\/td>`, 'i'));
    return cell ? decodeHtml(cell[1]) : '';
  };
  return rows.map(row => {
    const securityCode = normalizeCode(labelValue(row, '代码'));
    const multipleText = labelValue(row, '认购倍数');
    const subscriptionMultiple = parseMultiple(multipleText);
    return {
      securityCode,
      securityName: labelValue(row, '名称'),
      offerCloseDate: normalizeDate(labelValue(row, '招股结束日')),
      subscriptionMultiple,
      raw: { securityCode, securityName: labelValue(row, '名称'), multipleText },
    };
  }).filter(item => item.securityCode && item.subscriptionMultiple !== null && item.subscriptionMultiple > 0);
}

async function loadIpoMap(executor = pool) {
  const { rows } = await executor.query(`
    SELECT security_code,instrument_id,ipo_status,offer_open_at,offer_close_at,listing_at,listing_date
      FROM public.ipo_history
     WHERE market_code='HK'
  `);
  const map = new Map();
  for (const row of rows) {
    const code = normalizeCode(row.security_code);
    if (code) map.set(code, row);
  }
  return map;
}

function isOfferOpen(row, now = new Date(), sourceCloseDate = null) {
  if (!row || !row.offer_open_at) return false;
  const open = new Date(row.offer_open_at);
  const closeValue = row.offer_close_at || sourceCloseDate || '';
  const closeText = String(closeValue).trim();
  const close = /^\d{4}-\d{2}-\d{2}$/.test(closeText)
    ? new Date(`${closeText}T23:59:59+08:00`)
    : new Date(closeValue);
  return Number.isFinite(open.getTime()) && Number.isFinite(close.getTime()) && open <= now && now <= close;
}

function sourceObservedAt(item, fallbackDate = null) {
  return normalizeObservedAt(
    item && item.raw && (item.raw.last_update_time || item.raw.lastUpdateTime || item.raw.updated_at || item.raw.updatedAt || item.raw.update_at || item.raw.create_at),
    fallbackDate || item && item.issueDate
  );
}

function isCurrentSubscriptionRecord(item, ipo, businessDate, now = new Date()) {
  if (!item || item.subscriptionMultiple === null || item.subscriptionMultiple <= 0) return false;
  // 历史接口同时返回 expiration_date；只有明确未过申购截止日才可作为“申购中”信号，
  // 防止把上市后的最终倍数倒灌回申购期。
  const closeDate = item.offerCloseDate;
  const targetDate = normalizeDate(businessDate);
  if (!closeDate || !targetDate || closeDate < targetDate) return false;
  return isOfferOpen(ipo, now, closeDate);
}

function isQuotaOrCircuitError(error) {
  const code = String(error && error.code || '').toUpperCase();
  const type = String(error && error.errorType || '').toLowerCase();
  const message = String(error && error.message || error || '').toLowerCase();
  return ['RATE_LIMIT', 'QUOTA_EXHAUSTED', 'BUDGET_WAIT', 'CIRCUIT_OPEN'].includes(code)
    || type === 'rate_limit' || type === 'circuit_open'
    || /(daily|quota|rate.?limit|额度|限流|熔断|每日上限)/i.test(message);
}

function normalizeSnapshotNumber(value, scale) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(String(value).replace(/[,，%+]/g, ''));
  if (!Number.isFinite(number)) return null;
  return number.toFixed(scale);
}

function normalizeSnapshotTimestamp(value) {
  if (value === null || value === undefined || value === '') return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function buildSourceRecordHash({
  code,
  sourceCode,
  signalType,
  signalKind = null,
  dataDate,
  sourceObservedAt = null,
  subscriptionMultiple = null,
  marginAmountHkd = null,
  marginMultiple = null,
  greyMarketPrice = null,
  greyMarketChangePct = null,
} = {}) {
  const normalized = [
    normalizeCode(code) || String(code || '').trim().toUpperCase(),
    String(sourceCode || '').trim().toLowerCase(),
    String(signalType || '').trim().toLowerCase(),
    String(signalKind || '').trim().toLowerCase(),
    String(dataDate || '').trim().slice(0, 10),
    normalizeSnapshotNumber(marginAmountHkd, 0) || '',
    normalizeSnapshotNumber(subscriptionMultiple, 4) || '',
    normalizeSnapshotNumber(marginMultiple, 4) || '',
    normalizeSnapshotNumber(greyMarketPrice, 4) || '',
    normalizeSnapshotNumber(greyMarketChangePct, 4) || '',
    normalizeSnapshotTimestamp(sourceObservedAt),
  ].join('|');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

async function persistRaw(sourceCode, datasetCode, sourceKey, payload, executor = pool) {
  const source = await executor.query('SELECT source_id FROM ops.data_sources WHERE source_code=$1 LIMIT 1', [sourceCode]);
  if (!source.rows[0]) return;
  const text = JSON.stringify(payload || {});
  await executor.query(`
    INSERT INTO ops.raw_records(source_id,dataset_code,source_key,source_updated_at,payload,payload_hash)
    VALUES($1,$2,$3,now(),$4::jsonb,$5)
    ON CONFLICT(source_id,dataset_code,source_key,payload_hash) DO UPDATE SET ingested_at=now()
  `, [source.rows[0].source_id, datasetCode, sourceKey, text, crypto.createHash('sha256').update(text).digest('hex')]);
}

async function persistName(code, name, executor = pool) {
  if (!code || !hasChinese(name)) return false;
  const result = await executor.query(`
    UPDATE public.ipo_history
       SET security_name_cn=$2
     WHERE market_code='HK' AND regexp_replace(security_code,'\\D','','g')=regexp_replace($1,'\\D','','g')
       AND security_name_cn IS DISTINCT FROM $2
  `, [code, String(name).trim()]);
  return result.rowCount > 0;
}

async function persistSnapshot({
  code,
  instrumentId,
  sourceCode,
  signalType,
  signalKind = null,
  dataDate,
  observedAt,
  sourceObservedAt = null,
  subscriptionMultiple = null,
  marginAmountHkd = null,
  marginMultiple = null,
  greyMarketPrice = null,
  greyMarketChangePct = null,
  qualityStatus = 'valid',
  rawPayload = {},
}, executor = pool) {
  if (!code || !signalType || !dataDate) return false;
  if (subscriptionMultiple === null && marginAmountHkd === null && marginMultiple === null
    && greyMarketPrice === null && greyMarketChangePct === null) return false;
  if (!['valid', 'empty', 'rejected'].includes(qualityStatus)) throw new Error(`港股 IPO 快照质量状态非法：${qualityStatus}`);
  const normalizedSignalKind = signalKind || rawPayload.signal_kind || null;
  const normalizedMarginMultiple = marginMultiple === null && normalizedSignalKind === 'margin_estimate'
    ? subscriptionMultiple : marginMultiple;
  const sourceRecordHash = buildSourceRecordHash({
    code, sourceCode, signalType, signalKind: normalizedSignalKind, dataDate, sourceObservedAt,
    subscriptionMultiple, marginAmountHkd, marginMultiple: normalizedMarginMultiple,
    greyMarketPrice, greyMarketChangePct,
  });
  await executor.query(`
    INSERT INTO analytics.hk_ipo_market_snapshots(
      security_code,instrument_id,source_code,signal_type,data_date,observed_at,
      source_observed_at,last_seen_at,subscription_multiple,margin_amount_hkd,margin_multiple,
      grey_market_price_hkd,grey_market_change_pct,signal_kind,source_record_hash,quality_status,raw_payload
    ) VALUES($1,$2,$3,$4,$5::date,COALESCE($6::timestamptz,now()),$7::timestamptz,now(),$8,$9,$10,
      $11,$12,$13,$14,$15,$16::jsonb)
    ON CONFLICT(security_code,source_code,signal_type,data_date,source_record_hash)
      WHERE source_record_hash IS NOT NULL DO UPDATE SET
      instrument_id=COALESCE(EXCLUDED.instrument_id,analytics.hk_ipo_market_snapshots.instrument_id),
      last_seen_at=now(),
      subscription_multiple=COALESCE(EXCLUDED.subscription_multiple,analytics.hk_ipo_market_snapshots.subscription_multiple),
      margin_amount_hkd=COALESCE(EXCLUDED.margin_amount_hkd,analytics.hk_ipo_market_snapshots.margin_amount_hkd),
      margin_multiple=COALESCE(EXCLUDED.margin_multiple,analytics.hk_ipo_market_snapshots.margin_multiple),
      grey_market_price_hkd=COALESCE(EXCLUDED.grey_market_price_hkd,analytics.hk_ipo_market_snapshots.grey_market_price_hkd),
      grey_market_change_pct=COALESCE(EXCLUDED.grey_market_change_pct,analytics.hk_ipo_market_snapshots.grey_market_change_pct),
      source_observed_at=COALESCE(EXCLUDED.source_observed_at,analytics.hk_ipo_market_snapshots.source_observed_at),
      quality_status=EXCLUDED.quality_status,
      raw_payload=EXCLUDED.raw_payload,
      updated_at=now()
  `, [code, instrumentId || null, sourceCode, signalType, dataDate, observedAt || null, sourceObservedAt || null,
    subscriptionMultiple, marginAmountHkd, normalizedMarginMultiple, greyMarketPrice, greyMarketChangePct,
    normalizedSignalKind, sourceRecordHash, qualityStatus, JSON.stringify(rawPayload || {})]);
  return true;
}

async function guardedFetch(sourceCode, apiName, dataset, url, format, fetchImpl, guardImpl, businessDate) {
  return guardImpl(sourceCode, dataset, businessDate, () => fetchImpl(url, { format }), { apiName });
}

async function syncHkIpoXSubscription({ map, businessDate, fetchImpl, guardImpl, result }) {
  try {
    const payload = await guardedFetch('hkipox-public', 'hk_ipo_public_page', 'hk_ipo_subscription_signals', HKIPOX_URL, 'text', fetchImpl, guardImpl, businessDate);
    const fetchedAt = new Date().toISOString();
    await persistRaw('hkipox-public', 'hk_ipo_subscription_signals', businessDate, {
      fetchedAt, pageUrl: HKIPOX_URL, parserVersion: 'hkipox-ipo-home-v1', html: String(payload || '').slice(0, 500000),
    });
    const rows = parseHkIpoXHtml(payload);
    const activeCodes = [...map.entries()]
      .filter(([, ipo]) => isOfferOpen(ipo, new Date(fetchedAt)))
      .map(([code]) => code);
    result.subscription.activeCodes = activeCodes;
    result.hkipoxSubscription.activeCodes = activeCodes;
    result.hkipoxSubscription.fetched = true;
    result.hkipoxSubscription.rows = rows.length;
    result.hkipoxSubscription.ok = true;
    result.subscription.fetched = true;
    result.subscription.rows = Math.max(Number(result.subscription.rows || 0), rows.length);
    result.subscription.ok = true;
    for (const item of rows) {
      const ipo = map.get(item.securityCode);
      if (!ipo || !isOfferOpen(ipo, new Date(fetchedAt), item.offerCloseDate)) continue;
      if (await persistSnapshot({
        code: item.securityCode,
        instrumentId: ipo.instrument_id,
        sourceCode: 'hkipox-public',
        signalType: 'subscription',
        signalKind: 'subscription_estimate',
        dataDate: businessDate,
        observedAt: fetchedAt,
        sourceObservedAt: null,
        subscriptionMultiple: item.subscriptionMultiple,
        rawPayload: { ...item.raw, source_name: 'HKIPOx', source_url: HKIPOX_URL, parser_version: 'hkipox-ipo-home-v1' },
      })) {
        result.hkipoxSubscription.saved += 1;
        result.subscription.saved += 1;
        result.subscription.coveredCodes.push(item.securityCode);
        result.hkipoxSubscription.coveredCodes.push(item.securityCode);
      }
    }
  } catch (error) {
    result.ok = false;
    result.status = 'degraded';
    result.errors.push({ source: 'hkipox-public', apiName: 'hk_ipo_public_page', dataset: 'subscription', error: error.message || String(error) });
  }
}

async function syncHkIpoMarketSignals({
  mode = 'enrichment',
  businessDate = process.env.JOB_BUSINESS_DATE || todayShanghai(),
  fetchImpl = requestExternal,
  guardImpl = withExternalCallGuard,
  sourcesAdmitted = false,
  hkipoxAdmitted = false,
} = {}) {
  if (sourcesAdmitted !== true && hkipoxAdmitted !== true) {
    return {
      ok: true, status: 'not_admitted', mode,
      subscription: { fetched: false, rows: 0, saved: 0, ok: false },
      errors: [], sourceAdmissionRequired: true,
    };
  }
  const map = await loadIpoMap();
  const result = { ok: true, status: 'succeeded', mode, subscription: { fetched: false, rows: 0, saved: 0, ok: false, activeCodes: [], coveredCodes: [] }, hkipoxSubscription: { fetched: false, rows: 0, saved: 0, ok: false, activeCodes: [], coveredCodes: [] }, vbkrSubscription: { fetched: false, rows: 0, saved: 0 }, livermoreGrey: { fetched: false, rows: 0, saved: 0 }, futuGrey: { fetched: false, rows: 0, saved: 0 }, errors: [], fallbackUsed: false };
  if (sourcesAdmitted !== true) {
    await syncHkIpoXSubscription({ map, businessDate, fetchImpl, guardImpl, result });
    return result;
  }
  const blockedSources = new Set();
  const markSourceBlocked = (source, error) => {
    if (isQuotaOrCircuitError(error)) blockedSources.add(source);
  };

  const syncVbkrCurrent = async () => {
    try {
      const payload = await guardedFetch('vbkr-public', 'hk_ipo_current', 'hk_ipo_subscription_signals', VBKR_IPO_CURRENT_URL, 'json', fetchImpl, guardImpl, businessDate);
      await persistRaw('vbkr-public', 'hk_ipo_subscription_signals', businessDate, payload);
      if (!payload || (payload.success !== true && String(payload.code) !== '00000' && Number(payload.code) !== 0)) {
        throw new Error(`华盛公开新股接口返回 ${payload && (payload.msg || payload.message || payload.code) || '未知响应'}`);
      }
      const rows = parseVbkrCurrent(payload);
      result.vbkrSubscription.fetched = true;
      result.vbkrSubscription.rows = rows.length;
      result.subscription.fetched = true;
      result.subscription.rows = Math.max(Number(result.subscription.rows || 0), rows.length);
      result.subscription.ok = rows.length > 0;
      result.fallbackUsed = true;
      for (const item of rows) {
        const ipo = map.get(item.securityCode);
        if (!ipo || !isOfferOpen(ipo, new Date(), item.offerCloseDate)) continue;
        await persistName(item.securityCode, item.securityName);
        if (await persistSnapshot({
          code: item.securityCode,
          instrumentId: ipo.instrument_id,
          sourceCode: 'vbkr-public',
          signalType: 'subscription',
          signalKind: 'margin_estimate',
          dataDate: businessDate,
          observedAt: sourceObservedAt(item, businessDate) || null,
          sourceObservedAt: sourceObservedAt(item, businessDate) || null,
          subscriptionMultiple: item.subscriptionMultiple,
          rawPayload: { ...item.raw, signal_kind: 'margin_estimate', signal_origin: 'vbkr_public_fallback', source_name: '华盛公开新股页' },
        })) {
          result.vbkrSubscription.saved += 1;
          result.subscription.saved += 1;
        }
      }
      if (result.vbkrSubscription.saved > 0) {
        // 主源不可用但备源已形成有效快照：任务视为成功，同时保留 fallbackUsed 供审计。
        result.subscription.ok = true;
        result.ok = true;
        result.status = 'succeeded';
      } else if (!rows.length) {
        result.ok = false;
        result.status = 'degraded';
        result.errors.push({ source: 'vbkr-public', apiName: 'hk_ipo_current', dataset: 'subscription', error: '公开新股接口返回空数据，未生成预计孖展' });
      }
    } catch (error) {
      markSourceBlocked('vbkr-public', error);
      result.ok = false;
      result.status = 'degraded';
      result.errors.push({ source: 'vbkr-public', apiName: 'hk_ipo_current', dataset: 'subscription', error: error.message || String(error) });
    }
  };

  const syncCurrent = async () => {
    let fallbackRequired = false;
    try {
      const payload = await guardedFetch('livermore', 'hk_ipo_current', 'hk_ipo_subscription_signals', LIVERMORE_CURRENT_URL, 'json', fetchImpl, guardImpl, businessDate);
      await persistRaw('livermore', 'hk_ipo_subscription_signals', businessDate, payload);
      if (payload && payload.code !== undefined && Number(payload.code) !== 0) {
        throw new Error(`利弗莫尔申购接口返回 ${payload.msg_cn || payload.msg || `code=${payload.code}`}`);
      }
      const rows = parseLivermoreCurrent(payload);
      result.subscription.fetched = true;
      result.subscription.rows = rows.length;
      result.subscription.ok = rows.length > 0;
      if (!rows.length) {
        result.ok = false;
        result.status = 'degraded';
        result.errors.push({ source: 'livermore', apiName: 'hk_ipo_current', dataset: 'subscription', error: '申购接口返回空数据，未生成实时倍数' });
        fallbackRequired = true;
      }
      for (const item of rows) {
        const ipo = map.get(item.securityCode);
        if (!ipo || !isOfferOpen(ipo, new Date(), item.offerCloseDate)) continue;
        await persistName(item.securityCode, item.securityName);
        if (await persistSnapshot({
          code: item.securityCode,
          instrumentId: ipo.instrument_id,
          sourceCode: 'livermore',
          signalType: 'subscription',
          signalKind: 'margin_estimate',
          dataDate: businessDate,
          observedAt: sourceObservedAt(item, businessDate) || null,
          sourceObservedAt: sourceObservedAt(item, businessDate) || null,
          subscriptionMultiple: item.subscriptionMultiple,
          rawPayload: { ...item.raw, signal_kind: 'margin_estimate', signal_origin: 'current_endpoint' },
        })) {
          result.subscription.saved += 1;
          result.subscription.ok = true;
        }
      }
    } catch (error) {
      markSourceBlocked('livermore', error);
      result.ok = false;
      result.status = 'degraded';
      result.errors.push({ source: 'livermore', apiName: 'hk_ipo_current', dataset: 'subscription', error: error.message || String(error) });
      fallbackRequired = true;
    }
    if (fallbackRequired) await syncVbkrCurrent();
  };

  await syncCurrent();

  if (blockedSources.has('livermore')) {
    // 当前接口已确认额度/熔断时，同一轮不重复请求历史接口，避免继续消耗额度。
    result.errors.push({ source: 'livermore', apiName: 'hk_ipo_history', dataset: 'grey_market', error: '本轮已因来源额度或熔断跳过重复请求' });
  } else try {
    const year = Number(String(businessDate).slice(0, 4)) || new Date().getFullYear();
    // 盘中接口经常返回“请升级”，申购期任务也要查历史接口兜底；
    // 暗盘历史只在晚间 enrichment 任务中抓取，避免增加开盘前调用量。
    const targetYears = mode === 'enrichment' ? [year - 1, year] : [year];
    for (const targetYear of [...new Set(targetYears)]) {
      const url = `${LIVERMORE_HISTORY_URL}?page=1&page_count=200&stock_type=3&year=${targetYear}&sort_field_name=issue_date&sort_type=-1`;
      const payload = await guardedFetch('livermore', 'hk_ipo_history', `hk_ipo_grey_market:${targetYear}`, url, 'json', fetchImpl, guardImpl, businessDate);
      await persistRaw('livermore', 'hk_ipo_grey_market', String(targetYear), payload);
      const rows = parseLivermoreHistory(payload);
      result.livermoreGrey.fetched = true;
      result.livermoreGrey.rows += rows.length;
      for (const item of rows) {
        const ipo = map.get(item.securityCode);
        if (!ipo) continue;
        await persistName(item.securityCode, item.securityName);
        if (mode === 'enrichment' && (item.greyMarketPrice !== null || item.greyMarketChangePct !== null)) {
          if (await persistSnapshot({ code: item.securityCode, instrumentId: ipo.instrument_id, sourceCode: 'livermore', signalType: 'grey_market', signalKind: 'grey_market_quote', dataDate: item.issueDate || businessDate, observedAt: sourceObservedAt(item) || null, sourceObservedAt: sourceObservedAt(item) || null, greyMarketPrice: item.greyMarketPrice, greyMarketChangePct: item.greyMarketChangePct, rawPayload: item.raw })) result.livermoreGrey.saved += 1;
        }
        if (isCurrentSubscriptionRecord(item, ipo, businessDate)) {
          if (await persistSnapshot({
            code: item.securityCode,
            instrumentId: ipo.instrument_id,
            sourceCode: 'livermore',
            signalType: 'subscription',
            signalKind: 'margin_estimate',
            dataDate: businessDate,
            observedAt: sourceObservedAt(item, businessDate) || null,
            sourceObservedAt: sourceObservedAt(item, businessDate) || null,
            subscriptionMultiple: item.subscriptionMultiple,
            rawPayload: { ...item.raw, signal_kind: 'margin_estimate', signal_origin: 'history_window_fallback' },
          })) {
            result.subscription.saved += 1;
            result.subscription.ok = true;
          }
        }
      }
    }
  } catch (error) {
    markSourceBlocked('livermore', error);
    result.ok = false;
    result.status = 'degraded';
    result.errors.push({ source: 'livermore', apiName: 'hk_ipo_history', dataset: 'grey_market', error: error.message || String(error) });
  }

  if (hkipoxAdmitted === true) {
    await syncHkIpoXSubscription({ map, businessDate, fetchImpl, guardImpl, result });
  }

  if (mode !== 'enrichment') return result;

  try {
    const payload = await guardedFetch('futu-public', 'hk_ipo_public_page', 'hk_ipo_grey_market:futu', FUTU_IPO_URL, 'text', fetchImpl, guardImpl, businessDate);
    await persistRaw('futu-public', 'hk_ipo_grey_market', businessDate, { fetchedAt: new Date().toISOString(), html: String(payload || '').slice(0, 500000) });
    const rows = parseFutuIpoHtml(validateFutuIpoHtmlResponse(payload));
    result.futuGrey.fetched = true;
    result.futuGrey.rows = rows.length;
    for (const item of rows) {
      const ipo = map.get(item.securityCode);
      if (!ipo || item.greyMarketChangePct === null) continue;
      await persistName(item.securityCode, item.securityName);
      if (await persistSnapshot({ code: item.securityCode, instrumentId: ipo.instrument_id, sourceCode: 'futu-public', signalType: 'grey_market', signalKind: 'grey_market_quote', dataDate: item.listingDate || businessDate, greyMarketChangePct: item.greyMarketChangePct, rawPayload: item.raw })) result.futuGrey.saved += 1;
    }
  } catch (error) {
    result.ok = false;
    result.status = 'degraded';
    result.errors.push({ source: 'futu-public', apiName: 'hk_ipo_public_page', dataset: 'grey_market', error: error.message || String(error) });
  }
  return result;
}

module.exports = {
  LIVERMORE_CURRENT_URL,
  LIVERMORE_HISTORY_URL,
  VBKR_IPO_CURRENT_URL,
  FUTU_IPO_URL,
  HKIPOX_URL,
  requestExternal,
  validateFutuIpoHtmlResponse,
  normalizeCode,
  parseLivermoreHistory,
  parseLivermoreCurrent,
  parseVbkrCurrent,
  parseFutuIpoHtml,
  parseHkIpoXHtml,
  isOfferOpen,
  isCurrentSubscriptionRecord,
  buildSourceRecordHash,
  normalizeSnapshotNumber,
  persistSnapshot,
  syncHkIpoMarketSignals,
};

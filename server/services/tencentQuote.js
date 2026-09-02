const https = require('https');
const { pool } = require('../db/connection');
const { withExternalCallGuard } = require('./externalCallGuard');
const classifyCode = require('../../public/js/code-classify');
const {
  resolveCanonicalCode,
  resolveInstrument,
  resolveProviderCode,
  ensureInstrumentIdentity,
} = require('./securityIdentity');

const SOURCE = 'tencent';
const DEFAULT_TTL_MS = 60 * 1000;
const MAX_BATCH_SIZE = 80;

function normalizeCode(rawCode) {
  return String(rawCode || '').trim().toUpperCase()
    .replace(/\.(SH|SZ|BJ|HK)$/i, '')
    .replace(/^(SH|SZ|BJ|HK)/i, '');
}

function describeTencentCode(rawCode) {
  const original = String(rawCode || '').trim().toUpperCase();
  const code = normalizeCode(original);
  if (!code) return null;
  const explicit = ((original.match(/^(SH|SZ|BJ|HK)/i) || original.match(/\.(SH|SZ|BJ|HK)$/i)) || [])[1];
  let market = explicit ? explicit.toLowerCase() : '';
  if (!market && /^\d{5}$/.test(code)) market = 'hk';
  if (!market && /^\d{6}$/.test(code)) {
    const info = classifyCode(code);
    market = info && info.market === 'kcb' ? 'sh' : (info && info.market) || '';
  }
  if (!['sh', 'sz', 'bj', 'hk'].includes(market)) return null;
  const normalized = market === 'hk' ? code.padStart(5, '0') : code.padStart(6, '0');
  return { code: normalized, market, symbol: market + normalized };
}

function isConvertibleBondCode(rawCode) {
  const code = normalizeCode(rawCode);
  return /^\d{6}$/.test(code) && /^(110|111|113|118|123|127|128)/.test(code);
}

function isFundEtfCode(rawCode) {
  return classifyCode.isFundEtfCode(normalizeCode(rawCode));
}

function quoteLookupKeys(item) {
  if (!item || !item.code || !item.market) return [];
  return [item.code, `${item.code}.${item.market.toUpperCase()}`];
}

function parseQuoteTime(value) {
  const text = String(value || '');
  if (/^\d{14}$/.test(text)) {
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}T${text.slice(8, 10)}:${text.slice(10, 12)}:${text.slice(12, 14)}+08:00`;
  }
  const hk = text.match(/^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  return hk ? `${hk[1]}-${hk[2]}-${hk[3]}T${hk[4]}:${hk[5]}:${hk[6]}+08:00` : null;
}

function parseTencentQuoteText(text) {
  const quotes = new Map();
  const regex = /v_([^=]+)="([^"]*)"/g;
  let match;
  while ((match = regex.exec(String(text || '')))) {
    const symbol = match[1].toLowerCase();
    const parts = match[2].split('~');
    const price = Number(parts[3]);
    if (!Number.isFinite(price) || price <= 0) continue;
    const change = parts[32] === '' || parts[32] == null ? null : Number(parts[32]);
    const described = describeTencentCode(symbol);
    quotes.set(symbol, {
      symbol,
      code: described ? described.code : (parts[2] || symbol.replace(/^[a-z]+/, '')),
      market: described ? described.market : symbol.slice(0, 2),
      name: parts[1] || '',
      price,
      change: Number.isFinite(change) ? change : null,
      quote_time: parseQuoteTime(parts[30]),
      source: SOURCE,
    });
  }
  return quotes;
}

function requestText(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout: 6000,
      headers: { Referer: 'https://gu.qq.com/', 'User-Agent': 'Mozilla/5.0' },
    }, (resp) => {
      const chunks = [];
      resp.on('data', chunk => chunks.push(chunk));
      resp.on('end', () => {
        if (resp.statusCode === 429 || resp.statusCode >= 500) {
          const error = new Error(`Tencent HTTP ${resp.statusCode}`);
          error.code = resp.statusCode === 429 ? 'RATE_LIMIT' : 'UPSTREAM_5XX';
          error.errorType = resp.statusCode === 429 ? 'rate_limit' : 'network';
          error.source = SOURCE;
          return reject(error);
        }
        const buffer = Buffer.concat(chunks);
        try { resolve(new TextDecoder('gbk').decode(buffer)); }
        catch (_) { resolve(buffer.toString('utf8')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('Tencent quote timeout')); });
  });
}

async function loadCache(symbols) {
  if (!symbols.length) return new Map();
  try {
    const { rows } = await pool.query(
      `SELECT symbol, code, market, name, price, change_pct, quote_time, fetched_at
         FROM market_quote_cache WHERE source = $1 AND symbol = ANY($2::text[])`,
      [SOURCE, symbols]
    );
    return new Map(rows.map(row => [row.symbol, {
      symbol: row.symbol,
      code: row.code,
      market: row.market,
      name: row.name,
      price: row.price == null ? null : Number(row.price),
      change: row.change_pct == null ? null : Number(row.change_pct),
      quote_time: row.quote_time,
      fetched_at: row.fetched_at,
      source: SOURCE,
      cached: true,
    }]));
  } catch (_) {
    // 兼容迁移尚未执行或数据库临时不可用；行情仍可直连上游。
    return new Map();
  }
}

async function saveCache(quotes) {
  const rows = Array.from(quotes.values());
  if (!rows.length) return;
  const chunkSize = 100;
  try {
    for (let start = 0; start < rows.length; start += chunkSize) {
      const chunk = rows.slice(start, start + chunkSize);
      const values = [];
      const params = [];
      chunk.forEach((row, index) => {
        const base = index * 8;
        values.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8})`);
        params.push(row.symbol, SOURCE, row.code, row.market, row.name || '', row.price, row.change, row.quote_time);
      });
      await pool.query(
        `INSERT INTO market_quote_cache
           (symbol, source, code, market, name, price, change_pct, quote_time)
         VALUES ${values.join(',')}
         ON CONFLICT (symbol, source) DO UPDATE SET
           code=EXCLUDED.code, market=EXCLUDED.market, name=EXCLUDED.name,
           price=EXCLUDED.price, change_pct=EXCLUDED.change_pct,
           quote_time=EXCLUDED.quote_time, fetched_at=now()`,
        params
      );
    }
  } catch (_) {
    // 缓存写入失败不能让行情请求失败。
  }
}

async function resolveTencentDescriptor(rawCode) {
  const original = String(rawCode || '').trim().toUpperCase();
  if (!original) return null;
  // 恒生指数是统一主档中的特殊指数标识，不按股票代码猜测交易所。
  if (original === 'HKHSI') return { code: 'HSI', market: 'hk', symbol: 'hkHSI' };

  try {
    let symbol = null;
    const sourceInstrument = /^(SH|SZ|BJ|HK)\d{5,6}$/i.test(original)
      ? await resolveInstrument({ sourceCode: SOURCE, identifierType: 'quote_symbol', identifierValue: original })
      : null;
    if (sourceInstrument) {
      symbol = await resolveProviderCode({ instrumentId: sourceInstrument.instrument_id, sourceCode: SOURCE, identifierType: 'quote_symbol' });
    } else {
      const assetClass = isConvertibleBondCode(original) ? 'convertible_bond' : 'stock';
      const canonical = await resolveCanonicalCode(original, assetClass);
      if (canonical) symbol = await resolveProviderCode({ canonicalCode: canonical, sourceCode: SOURCE, identifierType: 'quote_symbol' });
    }
    // 历史持仓可能早于统一证券主档迁移，基金/ETF 因不在 stock_basic 中尤其常见。
    // 先由统一身份写入口补齐最小主档和腾讯映射，再继续走同一映射读取链路。
    if (!symbol && isFundEtfCode(original)) {
      const canonical = await resolveCanonicalCode(original, 'stock');
      if (canonical) {
        try {
          const fallbackDescriptor = describeTencentCode(canonical);
          await ensureInstrumentIdentity({
            canonicalCode: canonical,
            assetClass: 'stock',
            market: 'CN',
            exchangeCode: canonical.endsWith('.SH') ? 'SSE' : 'SZSE',
            currencyCode: 'CNY',
            rawData: { identity_backfill: 'tencent_quote_fund_etf' },
            companyName: '',
            // 基金不在 Tushare stock_basic 中，补主档时只写已验证的腾讯映射，
            // 避免把基金代码伪装成 Tushare 股票代码供其他链路误用。
            identifiers: fallbackDescriptor ? [[SOURCE, 'quote_symbol', fallbackDescriptor.symbol]] : [],
          });
          symbol = await resolveProviderCode({ canonicalCode: canonical, sourceCode: SOURCE, identifierType: 'quote_symbol' });
        } catch (_) {}
        // 数据库暂不可用时仍允许本次行情直连腾讯；成功值会按正常路径进入缓存。
        if (!symbol) symbol = describeTencentCode(canonical)?.symbol || null;
      }
    }
    if (!symbol) return null;
    if (String(symbol).toLowerCase() === 'hkHSI'.toLowerCase()) return { code: 'HSI', market: 'hk', symbol: 'hkHSI' };
    return describeTencentCode(symbol);
  } catch (_) {
    return null;
  }
}

async function fetchTencentQuotes(rawCodes, options = {}) {
  const resolved = await Promise.all((rawCodes || []).map(resolveTencentDescriptor));
  const descriptors = Array.from(new Map(resolved.filter(Boolean).map(item => [item.symbol, item])).values());
  if (!descriptors.length) return new Map();
  const symbols = descriptors.map(item => item.symbol);
  const cached = await loadCache(symbols);
  const ttlMs = Math.max(1000, Number(options.ttlMs || process.env.TENCENT_QUOTE_TTL_MS) || DEFAULT_TTL_MS);
  const force = options.force === true;
  const now = Date.now();
  const staleSymbols = force ? symbols : symbols.filter(symbol => {
    const row = cached.get(symbol);
    return !row || !row.fetched_at || now - new Date(row.fetched_at).getTime() >= ttlMs;
  });
  const fresh = new Map(cached);

  for (let start = 0; start < staleSymbols.length; start += MAX_BATCH_SIZE) {
    const batch = staleSymbols.slice(start, start + MAX_BATCH_SIZE);
    try {
      const text = await withExternalCallGuard(
        SOURCE,
        `quote:${batch.join(',')}`,
        options.businessDate || process.env.JOB_BUSINESS_DATE,
        () => requestText('https://qt.gtimg.cn/q=' + batch.join(','))
      );
      const received = parseTencentQuoteText(text);
      received.forEach((quote, symbol) => fresh.set(symbol, quote));
      await saveCache(received);
    } catch (error) {
      if (error && ['RATE_LIMIT', 'QUOTA_EXHAUSTED', 'CIRCUIT_OPEN', 'DATASET_LOCKED'].includes(error.code)) throw error;
      // 使用数据库中的最后成功值；没有缓存的代码由调用方判定为失败。
    }
  }

  const result = new Map();
  descriptors.forEach(item => {
    const quote = fresh.get(item.symbol);
    if (quote && quote.price > 0) {
      quoteLookupKeys(item).forEach(key => result.set(key, quote));
    }
  });
  return result;
}

module.exports = {
  normalizeCode,
  describeTencentCode,
  isConvertibleBondCode,
  isFundEtfCode,
  parseQuoteTime,
  parseTencentQuoteText,
  quoteLookupKeys,
  fetchTencentQuotes,
};

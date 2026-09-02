// ========== 导入证券身份解析 ==========
// 大模型/Excel 可能把港股五位代码（如 00358）补成六位数字（000358）。
// 六位数字单靠前缀无法和 A 股区分，因此只在 core.instruments 主档能核对时修正。
const classifyCode = require('../../public/js/code-classify');
const { pool } = require('../db/connection');

// 运行时供应商代码解析缓存：映射表是事实来源，进程缓存只承担降压，不能成为第二份主档。
const IDENTIFIER_CACHE_TTL_MS = 10 * 60 * 1000;
const IDENTIFIER_CACHE_MAX = 5000;
const identifierCache = new Map();

function cacheKey(parts) { return parts.map(value => String(value == null ? '' : value).trim().toUpperCase()).join('|'); }

function readIdentifierCache(key) {
  const entry = identifierCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) { identifierCache.delete(key); return undefined; }
  // Map 作为一个轻量 LRU，命中后移到队尾。
  identifierCache.delete(key);
  identifierCache.set(key, entry);
  return entry.value;
}

function writeIdentifierCache(key, value) {
  identifierCache.delete(key);
  identifierCache.set(key, { value, expiresAt: Date.now() + IDENTIFIER_CACHE_TTL_MS });
  while (identifierCache.size > IDENTIFIER_CACHE_MAX) identifierCache.delete(identifierCache.keys().next().value);
  return value;
}

function cleanCode(rawCode) {
  return String(rawCode == null ? '' : rawCode).trim().toUpperCase()
    .replace(/\.(SH|SZ|BJ|HK|US)$/i, '')
    .replace(/^(SH|SZ|BJ|HK|US)/i, '');
}

function plainCode(value) {
  return String(value == null ? '' : value).replace(/\D/g, '');
}

function nameKey(value) {
  return String(value == null ? '' : value).trim().replace(/\s+/g, '');
}

function uniqueRows(rows) {
  const seen = new Map();
  for (const row of rows || []) {
    if (row && row.canonical_code) seen.set(String(row.canonical_code), row);
  }
  return [...seen.values()];
}

function isHongKong(row) {
  return String(row && row.market || '').toUpperCase() === 'HK'
    || String(row && row.exchange_code || '').toUpperCase() === 'HKEX'
    || String(row && row.currency_code || '').toUpperCase() === 'HKD';
}

function identityFromRow(row) {
  const code = classifyCode.normalizeCode(row.canonical_code, row.name);
  const info = classifyCode(code, row.name);
  if (!info) return null;
  return {
    code,
    name: row.name || code,
    type: info.type,
    subtype: info.subtype,
    market: info.market,
    quote_currency: row.currency_code || (info.isHK ? 'HKD' : 'CNY')
  };
}

function chooseHongKongRow(rawCode, rawName, rows) {
  const code = cleanCode(rawCode);
  if (!/^\d{6}$/.test(code) || code[0] !== '0') return null;

  const hkCode = code.slice(1);
  const key = nameKey(rawName);
  const candidates = uniqueRows(rows);
  const hkByCode = candidates.filter(row => isHongKong(row) && plainCode(row.canonical_code) === hkCode);
  const hkByName = key ? candidates.filter(row => isHongKong(row) && nameKey(row.name) === key) : [];
  const rawCodeRows = candidates.filter(row => !isHongKong(row) && plainCode(row.canonical_code) === code);
  const rawNameRows = key ? candidates.filter(row => !isHongKong(row) && nameKey(row.name) === key) : [];

  // 名称和去掉一位补零后的港股代码同时命中时，优先级最高。
  const namedCodeMatch = hkByName.filter(row => plainCode(row.canonical_code) === hkCode);
  if (namedCodeMatch.length === 1) return namedCodeMatch[0];
  // 名称为空时才允许仅凭唯一港股代码修正；有名称必须先命中港股名称，避免老 A 股主档缺失时误改。
  if (hkByCode.length === 1 && rawCodeRows.length === 0 && !key) return hkByCode[0];
  return null;
}

// executor 仅用于测试或账本事务复用；默认读取统一证券主档。
async function resolveAmbiguousSecurity(rawCode, rawName, executor) {
  const code = cleanCode(rawCode);
  if (!/^\d{6}$/.test(code) || code[0] !== '0') return null;

  const query = executor || pool.query.bind(pool);
  try {
    const hkCode = code.slice(1);
    const key = nameKey(rawName);
    const result = await query(
      `SELECT canonical_code, name, market, exchange_code, currency_code
         FROM core.instruments
        WHERE regexp_replace(canonical_code, '\\D', '', 'g') = ANY($1::text[])
           OR regexp_replace(name, '[[:space:]]+', '', 'g') = ANY($2::text[])`,
      [[code, hkCode], key ? [key] : []]
    );
    const row = chooseHongKongRow(rawCode, rawName, result.rows);
    return row ? identityFromRow(row) : null;
  } catch (_) {
    // 主档不可用时保持旧规则，不阻断导入或交易入账。
    return null;
  }
}

async function normalizeImportedItems(items, executor) {
  const list = Array.isArray(items) ? items : [];
  const query = executor || pool.query.bind(pool);
  const resolved = new Map();
  for (const item of list) {
    if (!item || !item.code) continue;
    const rawCode = String(item.code).trim();
    const rawName = String(item.name == null ? '' : item.name).trim();
    const key = cleanCode(rawCode) + '\u0000' + nameKey(rawName);
    if (!resolved.has(key)) resolved.set(key, await resolveAmbiguousSecurity(rawCode, rawName, query));
  }

  return list.map(item => {
    if (!item || !item.code) return item;
    const rawCode = String(item.code).trim();
    const rawName = String(item.name == null ? '' : item.name).trim();
    const key = cleanCode(rawCode) + '\u0000' + nameKey(rawName);
    const identity = resolved.get(key);
    if (!identity) return { ...item, code: classifyCode.normalizeCode(rawCode, rawName) };
    return {
      ...item,
      code: identity.code,
      name: rawName || identity.name,
      type: identity.type,
      subtype: identity.subtype,
      market: identity.market,
      quote_currency: identity.quote_currency
    };
  });
}

function normalizedCanonicalCode(value) {
  const text = String(value == null ? '' : value).trim().toUpperCase();
  return text || null;
}

// 按统一主档规则校验并生成标准代码。即使输入带了交易所后缀，也不能盲目信任；
// 例如 920002.SH 必须纠正为 920002.BJ，600519.BJ 必须纠正为 600519.SH。
function canonicalizeSecurityCode(rawCode, assetClass = 'stock') {
  const text = normalizedCanonicalCode(rawCode);
  if (!text) return null;
  const digits = text.replace(/\D/g, '');
  if (!/^\d{5,6}$/.test(digits)) return text;
  if (digits.length === 5 && assetClass === 'stock') return `${digits.padStart(5, '0')}.HK`;
  const code = digits.padStart(6, '0');
  if (assetClass === 'convertible_bond') return `${code}${/^11/.test(code) ? '.SH' : '.SZ'}`;
  if (assetClass === 'stock') {
    // 市场后缀统一读取前后端共用的代码分类规则，基金/ETF/REITs、B股和北交所不再各写一套前缀。
    const info = classifyCode(code);
    const suffix = info && (info.market === 'sh' || info.market === 'kcb') ? 'SH'
      : info && info.market === 'bj' ? 'BJ' : 'SZ';
    return `${code}.${suffix}`;
  }
  return text;
}

async function resolveCanonicalCode(rawCode, assetClass = 'stock', executor) {
  return canonicalizeSecurityCode(rawCode, assetClass);
}

async function resolveInstrument({ instrumentId = null, canonicalCode = null, sourceCode = null, identifierType = null, identifierValue = null } = {}, executor) {
  const id = Number.isSafeInteger(Number(instrumentId)) && Number(instrumentId) > 0 ? Number(instrumentId) : null;
  const canonical = normalizedCanonicalCode(canonicalCode);
  const source = sourceCode ? String(sourceCode).trim().toLowerCase() : null;
  const type = identifierType ? String(identifierType).trim() : null;
  const value = identifierValue == null ? null : String(identifierValue).trim();
  if (!id && !canonical && !(source && type && value)) return null;
  const key = cacheKey(['instrument', id || '', canonical || '', source || '', type || '', value || '']);
  const cached = readIdentifierCache(key);
  if (cached !== undefined) return cached;
  const query = executor || pool.query.bind(pool);
  let result;
  if (id) {
    result = await query(
      `SELECT instrument_id,canonical_code,name,asset_class,market,exchange_code,currency_code
         FROM core.instruments WHERE instrument_id=$1 LIMIT 1`, [id]
    );
  } else if (canonical) {
    result = await query(
      `SELECT instrument_id,canonical_code,name,asset_class,market,exchange_code,currency_code
         FROM core.instruments WHERE upper(canonical_code)=upper($1) LIMIT 1`, [canonical]
    );
  } else {
    result = await query(
      `SELECT i.instrument_id,i.canonical_code,i.name,i.asset_class,i.market,i.exchange_code,i.currency_code
         FROM core.instrument_identifiers x
         JOIN core.instruments i ON i.instrument_id=x.instrument_id
         JOIN ops.data_sources d ON d.source_id=x.source_id
        WHERE lower(d.source_code)=lower($1) AND x.identifier_type=$2
          AND upper(x.identifier_value)=upper($3)
          AND (x.valid_from IS NULL OR x.valid_from<=CURRENT_DATE)
          AND (x.valid_to IS NULL OR x.valid_to>=CURRENT_DATE)
        ORDER BY x.valid_from DESC NULLS LAST,x.identifier_id DESC LIMIT 2`, [source, type, value]
    );
    if (result.rows.length > 1) throw new Error(`供应商代码映射存在歧义：${source}/${type}/${value}`);
  }
  return writeIdentifierCache(key, result.rows[0] || null);
}

function deriveProviderIdentifier(canonicalCode, sourceCode, identifierType) {
  const canonical = normalizedCanonicalCode(canonicalCode);
  const source = String(sourceCode || '').trim().toLowerCase();
  const type = String(identifierType || '').trim();
  if (!canonical) return null;
  if (source === 'tushare' && type === 'ts_code') return canonical;
  const match = canonical.match(/^(\d{5,6})\.(SH|SZ|BJ|HK)$/i);
  if (!match) return null;
  const bare = match[1];
  const exchange = match[2].toUpperCase();
  if (source === 'tencent' && type === 'quote_symbol') {
    const { describeTencentCode } = require('./tencentQuote');
    return describeTencentCode(canonical)?.symbol || null;
  }
  if (source === 'eastmoney' && type === 'f10_code') return `${exchange}${bare}`;
  if (source === 'eastmoney' && type === 'guba_code') return bare;
  if (source === 'sina' && type === 'symbol') return `${exchange.toLowerCase()}${bare}`;
  if (source === 'xueqiu' && type === 'symbol') return `${exchange}${bare}`;
  return null;
}

async function resolveProviderIdentifier({ instrumentId = null, canonicalCode = null, sourceCode, identifierType, identifierValue = null } = {}, executor) {
  const source = String(sourceCode || '').trim().toLowerCase();
  const type = String(identifierType || '').trim();
  if (!source || !type) return null;
  const inputValue = identifierValue == null ? null : String(identifierValue).trim();
  const key = cacheKey(['provider', instrumentId || '', canonicalCode || '', source, type, inputValue || '']);
  const cached = readIdentifierCache(key);
  if (cached !== undefined) return cached;
  const query = executor || pool.query.bind(pool);
  let instrument = await resolveInstrument({ instrumentId, canonicalCode, sourceCode: inputValue ? source : null, identifierType: inputValue ? type : null, identifierValue: inputValue }, query);
  if (!instrument && inputValue) return writeIdentifierCache(key, null);
  if (!instrument) return writeIdentifierCache(key, null);
  const existing = await query(
    `SELECT x.identifier_value,x.valid_from,x.valid_to,d.source_code
       FROM core.instrument_identifiers x JOIN ops.data_sources d ON d.source_id=x.source_id
      WHERE x.instrument_id=$1 AND lower(d.source_code)=lower($2) AND x.identifier_type=$3
        AND (x.valid_from IS NULL OR x.valid_from<=CURRENT_DATE)
        AND (x.valid_to IS NULL OR x.valid_to>=CURRENT_DATE)
      ORDER BY x.valid_from DESC NULLS LAST,x.identifier_id DESC LIMIT 1`,
    [instrument.instrument_id, source, type]
  );
  let value = existing.rows[0]?.identifier_value || null;
  if (!value) {
    value = deriveProviderIdentifier(instrument.canonical_code, source, type);
    if (value) {
      const sourceRows = await query('SELECT source_id FROM ops.data_sources WHERE lower(source_code)=lower($1) LIMIT 1', [source]);
      const sourceId = sourceRows.rows[0]?.source_id;
      if (!sourceId) return writeIdentifierCache(key, null);
      await query(
        `INSERT INTO core.instrument_identifiers(instrument_id,source_id,identifier_type,identifier_value,valid_from)
         VALUES($1,$2,$3,$4,CURRENT_DATE)
         ON CONFLICT(source_id,identifier_type,identifier_value,valid_from) DO NOTHING`,
        [instrument.instrument_id, sourceId, type, value]
      );
      const verify = await query(
        `SELECT i.instrument_id,i.canonical_code,x.identifier_value
           FROM core.instrument_identifiers x JOIN core.instruments i ON i.instrument_id=x.instrument_id
          WHERE x.source_id=$1 AND x.identifier_type=$2 AND x.identifier_value=$3
            AND (x.valid_to IS NULL OR x.valid_to>=CURRENT_DATE)
          LIMIT 2`, [sourceId, type, value]
      );
      if (verify.rows.length !== 1 || Number(verify.rows[0].instrument_id) !== Number(instrument.instrument_id)) return writeIdentifierCache(key, null);
    }
  }
  if (!value) return writeIdentifierCache(key, null);
  const result = { instrument_id: instrument.instrument_id, canonical_code: instrument.canonical_code, identifier_value: value, source_code: source, identifier_type: type };
  writeIdentifierCache(key, result);
  writeIdentifierCache(cacheKey(['provider', instrument.instrument_id, '', source, type, '']), result);
  return result;
}

async function resolveProviderCode(input = {}, executor) {
  const args = typeof input === 'string' ? { canonicalCode: input } : input;
  const result = await resolveProviderIdentifier(args, executor);
  return result ? result.identifier_value : null;
}

// 统一主档写入口：所有新增证券先写 core.instruments，再写供应商映射及公司-证券关系。
// executor 可传事务 client.query，保证主档、公司和映射同一事务提交。
async function ensureInstrumentIdentity({ canonicalCode, name = '', assetClass = 'stock', market = 'CN', exchangeCode = '', currencyCode = 'CNY', listDate = null, status = 'listed', rawData = {}, companyName = null, relationType = 'issued_by', identifiers = [] } = {}, executor) {
  const canonical = canonicalizeSecurityCode(canonicalCode, assetClass);
  if (!canonical) throw new Error('证券主档缺少 canonicalCode');
  const query = executor || pool.query.bind(pool);
  const instrumentResult = await query(
    `INSERT INTO core.instruments(canonical_code,name,asset_class,market,exchange_code,currency_code,list_date,status,raw_data)
     VALUES($1,$2,$3,$4,$5,$6,$7::date,$8,$9::jsonb)
     ON CONFLICT(canonical_code) DO UPDATE SET
       name=CASE WHEN EXCLUDED.name<>'' THEN EXCLUDED.name ELSE core.instruments.name END,
       asset_class=EXCLUDED.asset_class,market=EXCLUDED.market,exchange_code=EXCLUDED.exchange_code,
       currency_code=EXCLUDED.currency_code,list_date=COALESCE(core.instruments.list_date,EXCLUDED.list_date),
       status=EXCLUDED.status,raw_data=core.instruments.raw_data || EXCLUDED.raw_data,updated_at=now()
     RETURNING instrument_id,canonical_code,name`,
    [canonical, String(name || ''), assetClass, market, exchangeCode, currencyCode, listDate || null, status, JSON.stringify(rawData || {})]
  );
  const instrument = instrumentResult.rows[0];
  if (!instrument) throw new Error(`证券主档写入失败：${canonical}`);
  let companyId = null;
  const company = String(companyName == null ? (assetClass === 'stock' ? name : '') : companyName).trim();
  if (company) {
    // 公司名称会随 ST/XD 等简称变化；证券已经有关联公司时必须复用，避免名称变化制造第二套公司主档。
    const existingCompany = await query(
      `SELECT c.company_id
         FROM core.company_instruments ci
         JOIN core.companies c ON c.company_id=ci.company_id
        WHERE ci.instrument_id=$1 AND ci.relation_type=$2
        ORDER BY CASE WHEN c.raw_data->>'ts_code'=$3 THEN 0
                      WHEN c.raw_data->>'backfill'='migration122' THEN 2 ELSE 1 END,
                 ci.valid_from DESC NULLS LAST,c.company_id
        LIMIT 1`, [instrument.instrument_id, relationType, canonical]
    );
    companyId = existingCompany.rows[0]?.company_id || null;
    if (companyId) {
      await query(
        `UPDATE core.companies SET short_name=$2,raw_data=raw_data || $3::jsonb,updated_at=now()
          WHERE company_id=$1`,
        [companyId, String(name || company), JSON.stringify(rawData || {})]
      );
    } else {
      const companyResult = await query(
        `INSERT INTO core.companies(legal_name,short_name,country_code,raw_data)
         VALUES($1,$2,$3,$4::jsonb)
         ON CONFLICT(country_code,legal_name) DO UPDATE SET short_name=EXCLUDED.short_name,raw_data=core.companies.raw_data || EXCLUDED.raw_data,updated_at=now()
         RETURNING company_id`,
        [company, String(name || company), market === 'HK' ? 'HK' : 'CN', JSON.stringify(rawData || {})]
      );
      companyId = companyResult.rows[0]?.company_id || null;
      if (companyId) await query(
        `INSERT INTO core.company_instruments(company_id,instrument_id,relation_type,valid_from)
         VALUES($1,$2,$3,$4::date) ON CONFLICT(company_id,instrument_id,relation_type) DO UPDATE SET valid_from=COALESCE(core.company_instruments.valid_from,EXCLUDED.valid_from)`,
        [companyId, instrument.instrument_id, relationType, listDate || null]
      );
    }
  }
  const sourceRows = await query(`SELECT source_id,source_code FROM ops.data_sources WHERE source_code=ANY($1::text[])`, [['tushare', 'tencent', 'eastmoney', 'sina', 'xueqiu']]);
  const sourceMap = Object.fromEntries(sourceRows.rows.map(row => [row.source_code, row.source_id]));
  const wanted = identifiers.length ? identifiers : [
    ['tushare', 'ts_code', deriveProviderIdentifier(canonical, 'tushare', 'ts_code')],
    ['tencent', 'quote_symbol', deriveProviderIdentifier(canonical, 'tencent', 'quote_symbol')],
    ['eastmoney', 'f10_code', deriveProviderIdentifier(canonical, 'eastmoney', 'f10_code')],
    ['eastmoney', 'guba_code', deriveProviderIdentifier(canonical, 'eastmoney', 'guba_code')],
    ['sina', 'symbol', deriveProviderIdentifier(canonical, 'sina', 'symbol')],
    ['xueqiu', 'symbol', deriveProviderIdentifier(canonical, 'xueqiu', 'symbol')],
  ];
  for (const item of wanted) {
    const [sourceCode, identifierType, identifierValue] = item;
    const sourceId = sourceMap[String(sourceCode || '').toLowerCase()];
    if (!sourceId || !identifierValue) continue;
    await query(
      `INSERT INTO core.instrument_identifiers(instrument_id,source_id,identifier_type,identifier_value,valid_from)
       VALUES($1,$2,$3,$4,$5::date) ON CONFLICT(source_id,identifier_type,identifier_value,valid_from) DO NOTHING`,
      [instrument.instrument_id, sourceId, identifierType, identifierValue, listDate || '0001-01-01']
    );
  }
  return { instrumentId: instrument.instrument_id, canonicalCode: instrument.canonical_code, companyId };
}

function clearIdentifierCache() { identifierCache.clear(); }

module.exports = { resolveAmbiguousSecurity, normalizeImportedItems, canonicalizeSecurityCode, resolveCanonicalCode, resolveInstrument, resolveProviderIdentifier, resolveProviderCode, ensureInstrumentIdentity, clearIdentifierCache };

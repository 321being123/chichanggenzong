// ========== 导入证券身份解析 ==========
// 大模型/Excel 可能把港股五位代码（如 00358）补成六位数字（000358）。
// 六位数字单靠前缀无法和 A 股区分，因此只在 core.instruments 主档能核对时修正。
const classifyCode = require('../../public/js/code-classify');
const { pool } = require('../db/connection');

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

module.exports = { resolveAmbiguousSecurity, normalizeImportedItems };

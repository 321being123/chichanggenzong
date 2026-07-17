// 数据源适配器：支持一个聚合接口，或“公司财务 + 债券行情”两个接口。
// 上游的字段差异只应在这里适配，核心算法只接收内部标准字段。

const DEFAULT_TIMEOUT_MS = 15000;

function isConfigured(env = process.env) {
  return Boolean(env.TUSHARE_TOKEN || env.BOND_SAFETY_API_URL ||
    (env.BOND_SAFETY_COMPANY_API_URL && env.BOND_SAFETY_QUOTE_API_URL));
}

function authHeaders(env = process.env) {
  const headers = { Accept: 'application/json' };
  const token = env.BOND_SAFETY_API_TOKEN;
  if (!token) return headers;
  const header = env.BOND_SAFETY_API_AUTH_HEADER || 'Authorization';
  const scheme = env.BOND_SAFETY_API_AUTH_SCHEME === undefined ? 'Bearer' : env.BOND_SAFETY_API_AUTH_SCHEME;
  headers[header] = scheme ? `${scheme} ${token}` : token;
  return headers;
}

async function fetchJson(url, label, env = process.env) {
  const timeout = Math.max(1000, Number(env.BOND_SAFETY_API_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { method: 'GET', headers: authHeaders(env), signal: controller.signal });
    if (!response.ok) throw new Error(`${label}接口返回 HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error(`${label}接口请求超时`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function pickArray(payload, keys, label) {
  if (Array.isArray(payload)) return payload;
  for (const key of keys) {
    if (payload && Array.isArray(payload[key])) return payload[key];
  }
  if (payload && payload.data && !Array.isArray(payload.data)) {
    for (const key of keys) {
      if (Array.isArray(payload.data[key])) return payload.data[key];
    }
  }
  throw new Error(`${label}接口未返回数组，请在 bondSafetyFetcher.js 中补充字段适配`);
}

async function fetchBondSafetySource(env = process.env) {
  if (!isConfigured(env)) {
    const error = new Error('可转债安全性数据源尚未配置');
    error.code = 'BOND_SAFETY_NOT_CONFIGURED';
    throw error;
  }

  if (!env.BOND_SAFETY_API_URL && !(env.BOND_SAFETY_COMPANY_API_URL && env.BOND_SAFETY_QUOTE_API_URL) && env.TUSHARE_TOKEN) {
    const { fetchTushareBondSafetySource } = require('./bondSafetyTushare');
    return fetchTushareBondSafetySource(env);
  }

  if (env.BOND_SAFETY_API_URL) {
    const payload = await fetchJson(env.BOND_SAFETY_API_URL, '可转债安全性', env);
    return {
      companyRows: pickArray(payload, ['company_financial', 'companyFinancial', 'companies'], '公司财务'),
      bondRows: pickArray(payload, ['bond_quote', 'bondQuote', 'bonds', 'quotes'], '债券行情'),
      sourceUpdatedAt: payload.updated_at || payload.updatedAt || null,
    };
  }

  const [companyPayload, bondPayload] = await Promise.all([
    fetchJson(env.BOND_SAFETY_COMPANY_API_URL, '公司财务', env),
    fetchJson(env.BOND_SAFETY_QUOTE_API_URL, '债券行情', env),
  ]);
  return {
    companyRows: pickArray(companyPayload, ['company_financial', 'companyFinancial', 'companies', 'rows'], '公司财务'),
    bondRows: pickArray(bondPayload, ['bond_quote', 'bondQuote', 'bonds', 'quotes', 'rows'], '债券行情'),
    sourceUpdatedAt: companyPayload.updated_at || bondPayload.updated_at || null,
  };
}

module.exports = { isConfigured, authHeaders, pickArray, fetchBondSafetySource };

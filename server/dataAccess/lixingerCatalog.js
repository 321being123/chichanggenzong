// 理杏仁官方接口目录（白名单）与请求体约束。
//
// 事实来源：官方文档索引 https://www.lixinger.com/api/open-api/url-doc
// 与逐接口说明 https://www.lixinger.com/api/open-api/html-doc<path>；
// 目录内容由 `docs/理杏仁官方API接入与数据层整体切换研发方案_20261030.md`
// 第 4 节规定的盘点流程生成，保存在 catalog/lixingerEndpoints.json。
//
// 约束：
//   - 只允许调用目录里 status='admitted' 的精确路径；不允许拼接任意 URL、相对路径或
//     未登记的接口，未准入一律拒绝，不按名称猜路径。
//   - 请求体只允许文档声明的参数名；凭据类字段（token/secret/api_key 等）任何层级都禁止传入，
//     token 由服务层在发请求时注入，不进入目录、日志和原始记录。
//   - 本模块是纯读取与校验，不发网络请求、不访问数据库。
const fs = require('fs');
const path = require('path');

const CATALOG_FILE = path.join(__dirname, 'catalog', 'lixingerEndpoints.json');
const BASE_URL = 'https://open.lixinger.com';
// 官方文档 url 形如 https://open.lixinger.com/api/cn/company，目录键是去掉 /api 前缀后的 apiKey。
const API_PREFIX = '/api';
const CREDENTIAL_KEY_PATTERN = /token|secret|password|authorization|api[-_]?key|cookie/i;

let catalogCache = null;

function loadCatalog() {
  if (catalogCache) return catalogCache;
  if (!fs.existsSync(CATALOG_FILE)) {
    throw catalogError('CATALOG_MISSING', '理杏仁接口目录文件不存在，禁止在无目录状态下调用官方接口');
  }
  const parsed = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
  const index = new Map();
  for (const endpoint of parsed.endpoints || []) {
    index.set(endpoint.key, endpoint);
  }
  catalogCache = { ...parsed, index };
  return catalogCache;
}

function catalogError(code, message) {
  return Object.assign(new Error(message), { code, source: 'lixinger_official' });
}

function normalizeKey(value) {
  return String(value == null ? '' : value).trim().replace(/^\/+/, '');
}

function listEndpoints({ domain, status } = {}) {
  const catalog = loadCatalog();
  return catalog.endpoints.filter(endpoint =>
    (!domain || endpoint.key === domain || endpoint.key.startsWith(`${domain}/`))
    && (!status || endpoint.status === status));
}

function getEndpoint(key) {
  const normalized = normalizeKey(key);
  if (!normalized || normalized.includes('://') || normalized.includes('..')) {
    throw catalogError('ENDPOINT_NOT_ADMITTED', `理杏仁接口未准入：${key}`);
  }
  const endpoint = loadCatalog().index.get(normalized);
  if (!endpoint) throw catalogError('ENDPOINT_NOT_ADMITTED', `理杏仁接口未准入：${key}`);
  if (endpoint.status !== 'admitted') {
    throw catalogError('ENDPOINT_NOT_ADMITTED', `理杏仁接口未准入（${endpoint.status}）：${key}`);
  }
  if (endpoint.path !== `${API_PREFIX}/${normalized}` || endpoint.method !== 'POST') {
    throw catalogError('CATALOG_INVALID', `理杏仁接口目录登记异常：${key}`);
  }
  return endpoint;
}

function isAdmitted(key) {
  try {
    getEndpoint(key);
    return true;
  } catch (_) {
    return false;
  }
}

// 接口名用于策略表、熔断作用域和权限证据：cn/company -> cn.company。
function apiNameOf(endpoint) {
  return String(endpoint.key).replace(/\//g, '.').slice(0, 64);
}

function endpointUrl(endpoint) {
  return `${BASE_URL}${endpoint.path}`;
}

function assertNoCredentialFields(value, pathPrefix = '') {
  if (value == null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (CREDENTIAL_KEY_PATTERN.test(key)) {
      throw catalogError('INVALID_REQUEST', `理杏仁请求体禁止携带凭据字段：${pathPrefix}${key}`);
    }
    assertNoCredentialFields(child, `${pathPrefix}${key}.`);
  }
}

// 按目录声明的参数名做白名单校验；未声明的参数直接拒绝，避免把猜测字段送到上游。
function buildRequestBody(endpoint, params = {}) {
  if (params == null || typeof params !== 'object' || Array.isArray(params)) {
    throw catalogError('INVALID_REQUEST', '理杏仁请求参数必须为对象');
  }
  assertNoCredentialFields(params);
  const allowed = new Set((endpoint.params || []).map(item => item.name).filter(name => name !== 'token'));
  const unknown = Object.keys(params).filter(key => !allowed.has(key));
  if (unknown.length) {
    throw catalogError('INVALID_REQUEST', `理杏仁接口 ${endpoint.key} 不接受参数：${unknown.join(',')}`);
  }
  // 不在这里校验"必选"：官方文档把 pageIndex 这类带默认值的参数也标成必选，
  // 本地无法可靠区分"必须由调用方给"和"上游有默认值"，缺参交给上游 400 + 文档修正。
  return { ...params };
}

module.exports = {
  BASE_URL,
  CATALOG_FILE,
  apiNameOf,
  buildRequestBody,
  endpointUrl,
  getEndpoint,
  isAdmitted,
  listEndpoints,
  loadCatalog,
};

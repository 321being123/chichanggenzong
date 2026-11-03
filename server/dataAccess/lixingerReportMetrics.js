// 理杏仁官方财报三表指标字典（读取层）。
//
// 单一事实源是 catalog/lixingerReportMetrics.txt（官方文档抓取，随 Git 版本化），
// 代码里不再手写指标白名单，避免"请求清单"和"落库列"两处漂移。
//
// 铁律：A股（CAS）与港股（HKFRS/IFRS）科目体系不同，禁止跨准则复用。
//   例：港股现金流官方只给 7 个汇总项；A股有上百项含附注明细。
//   例：港股有"物业、厂房及设备""非国际准则净利润"，A股有"交易性金融资产""开发支出"。
//
// 本模块是纯读取：不发网络请求、不访问数据库。
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'catalog', 'lixingerReportMetrics.txt');

// 市场 → 会计准则体系（落库时用于隔离两套科目）
const MARKET_STANDARD = Object.freeze({ CN: 'CAS', HK: 'HKFRS' });
// 指标代码前缀 → 三表归属
const PREFIX_STATEMENT = Object.freeze({ bs: 'balance', ps: 'income', cfs: 'cashflow' });
const STATEMENTS = Object.freeze(['balance', 'income', 'cashflow']);
const STATEMENT_LABEL = Object.freeze({ balance: '资产负债表', income: '利润表', cashflow: '现金流量表' });
// 官方限制：stockCodes 只有一只时，metricsList 最多 128 个指标。
const MAX_METRICS_PER_REQUEST = 128;

let cache = null;

function load() {
  if (cache) return cache;
  const text = fs.readFileSync(FILE, 'utf8');
  const rows = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [market, statement, code, name] = line.split('|');
    if (!MARKET_STANDARD[market]) continue;
    const prefixStatement = PREFIX_STATEMENT[String(code || '').split('.')[0]];
    // 只收三表科目（bs/ps/cfs），且归属必须与代码前缀一致，拒绝错行。
    if (!prefixStatement || prefixStatement !== statement) continue;
    if (!/^(bs|ps|cfs)\.[a-z0-9_]+$/.test(code)) continue;
    rows.push(Object.freeze({ market, standard: MARKET_STANDARD[market], statement, code, name: name || code }));
  }
  const byMarket = {};
  for (const market of Object.keys(MARKET_STANDARD)) {
    byMarket[market] = rows.filter(row => row.market === market);
  }
  cache = { rows, byMarket };
  return cache;
}

function standardOf(market) {
  const key = String(market || '').toUpperCase();
  const standard = MARKET_STANDARD[key];
  if (!standard) throw new Error(`不支持的市场：${market}`);
  return standard;
}

function metricsOf(market) {
  const key = String(market || '').toUpperCase();
  if (!MARKET_STANDARD[key]) throw new Error(`不支持的市场：${market}`);
  return load().byMarket[key];
}

function metricsByStatement(market, statement) {
  if (!STATEMENTS.includes(statement)) throw new Error(`不支持的报表：${statement}`);
  return metricsOf(market).filter(item => item.statement === statement);
}

// 官方要求 "q.<表>.<字段>.t"：q = 季度粒度，t = 报告期累计值（与既有落库口径一致）。
function requestCodeOf(metricCode) {
  return `q.${metricCode}.t`;
}

// 单只股票一次最多 128 个指标，超出必须分批；返回每批的官方请求串。
function requestBatchesOf(market, size = MAX_METRICS_PER_REQUEST) {
  const codes = metricsOf(market).map(item => requestCodeOf(item.code));
  const limit = Math.max(Number(size) || MAX_METRICS_PER_REQUEST, 1);
  const batches = [];
  for (let index = 0; index < codes.length; index += limit) {
    batches.push(codes.slice(index, index + limit));
  }
  return batches;
}

// 指标代码 → 宽表列名（bs.ta → bs_ta）。
function columnOf(metricCode) {
  const name = String(metricCode || '').replace(/\./g, '_');
  if (!/^(bs|ps|cfs)_[a-z0-9_]+$/.test(name)) throw new Error(`非法指标代码：${metricCode}`);
  return name;
}

// 宽表名：fundamental.statement_<报表>_<准则小写>
// A股与港股各自一张表，列集合不同，物理隔离两套准则。
function tableNameOf(market, statement) {
  if (!STATEMENTS.includes(statement)) throw new Error(`不支持的报表：${statement}`);
  return `fundamental.statement_${statement}_${standardOf(market).toLowerCase()}`;
}

// 供调用方判断某字段是否属于三表科目，并按前缀归类。
function statementOfMetricKey(key) {
  return PREFIX_STATEMENT[String(key || '').split('.')[0]] || null;
}

function statsOf(market) {
  const rows = metricsOf(market);
  const stats = {};
  for (const statement of STATEMENTS) {
    stats[statement] = rows.filter(item => item.statement === statement).length;
  }
  stats.total = rows.length;
  return stats;
}

module.exports = {
  FILE,
  MARKET_STANDARD,
  STATEMENTS,
  STATEMENT_LABEL,
  MAX_METRICS_PER_REQUEST,
  columnOf,
  metricsByStatement,
  metricsOf,
  requestBatchesOf,
  requestCodeOf,
  standardOf,
  statementOfMetricKey,
  statsOf,
  tableNameOf,
};

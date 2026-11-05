// 数据层：业务数据集的「取数需求」入口（应用分层方案 4. 数据层合同与主备选择）。
//
// 上层（服务、任务、路由）只表达「要哪个业务数据集、哪个范围」，不表达「从哪个供应商取」；
// 供应商选择、口径换算、主备回退与失败隔离全部收口在这里。
// 返回的每一行都自带 source_code，调用方按来源分组落库，不需要知道来源是谁。
//
// 现有来源事实（2026-10-31）：
//   - 理杏仁官方：行业分类、指数收盘、指数估值（市值加权）、正股日线、估值、财报、分红、M2、10 年国债
//   - 备源：Tushare（指数日线/估值、估值、财报、分红、M2）、腾讯（恒指与港股日线）、
//           恒指官网文件（恒指 PE）、中债（10 年国债）
// 直连底层：查询走 services/tushare，格式化与日期归一走 services/tushareFormat。
const { tushareQuery } = require('../services/tushare');
const { tsRows, normDate } = require('../services/tushareFormat');
const marketSource = require('../services/marketVolatilitySource');
const official = require('./adapters/lixingerDatasetAdapter');

// 中止类错误码与适配层保持单一来源（验收 V-01）：原来这里只有三种控制码，
// 适配层新增的 CANCELLED / DEADLINE_EXCEEDED / 权限类被当成"可回退故障"吞掉，
// 结果数组包装成 []，上层会把"取数被取消/超时"读成"本来没有数据"。
const ABORT_CODES = new Set([
  ...(official.CONTROL_ERROR_CODES || []),
  'JOB_BUDGET_EXCEEDED', 'POLICY_NOT_CONFIGURED', 'DATASET_LOCKED',
]);
const YUAN_TO_100M = 1e8;

function isAbort(error) {
  return Boolean(error && ABORT_CODES.has(error.code));
}

// 取数缺口的可查询留证（验收 V-01，复验 RV-01 修正）：只在失败时按「失败单元」写，
// 成功时只关闭被本次成功完整覆盖的单元（证券 + 区间 / 交易日 + 代码集合）。
// 之前按读取请求整片关闭，导致「只补一个月」或「换一只股票成功」都能把长期缺口误标恢复。
// 懒加载，避免数据层在正常路径就绑定数据库连接。
// 2026-11-02：改为同层 require（原先是反向依赖 services 层，触发 CROSS_LAYER_IMPORT）。
function valuationQuality() {
  return require('./valuationQualityIssues');
}

async function recordValuationGaps({ kind, stage, detail }) {
  try {
    await valuationQuality().recordGaps({ kind, stage, detail });
  } catch (error) {
    console.warn(`[数据层] 估值取数缺口留证失败：${String(error && error.message).slice(0, 160)}`);
  }
}

async function resolveValuationGaps(params) {
  try {
    return await valuationQuality().resolveGaps(params);
  } catch (error) {
    console.warn(`[数据层] 估值取数缺口恢复留证失败：${String(error && error.message).slice(0, 160)}`);
    return { resolved: 0 };
  }
}

// 失败批次涉及的证券（快照按批，序列按单只）。
function failedCodesOf(detail) {
  const failed = new Set();
  for (const failure of (detail && detail.failures) || []) {
    if (failure.tsCode) failed.add(String(failure.tsCode));
    // 快照失败按批：tsCodes 是站内代码（恢复判定用），stockCodes 是供应商代码（一起排除更稳）。
    for (const code of failure.tsCodes || []) failed.add(String(code));
    for (const code of failure.stockCodes || []) failed.add(String(code));
  }
  return failed;
}

// 快照：成功批次覆盖的代码 = 请求代码 − 失败批次代码（空批次也算成功，不能只取返回行）。
function succeededCodes(codes, detail) {
  const failed = failedCodesOf(detail);
  return (codes || []).map(String).filter(code => !failed.has(code));
}

// 序列：只有「这只证券这次一段都没失败」才把整个请求区间算作它的成功覆盖。
// 同一请求里别的段失败时，这只证券就不能声称覆盖了原失败单元（否则又会假恢复）。
function seriesCoverage(list, detail) {
  const startDate = (detail && detail.scope && detail.scope.startDate) || null;
  const endDate = (detail && detail.scope && detail.scope.endDate) || null;
  if (!startDate || !endDate) return [];
  const failed = failedCodesOf(detail);
  return (list || []).map(String).filter(code => !failed.has(code))
    .map(code => ({ tsCode: code, from: startDate, to: endDate }));
}

// 主来源失败时的统一痕迹：数据层自己记原因，上层只看到「本次用了备源」。
function logFallback(dataset, error) {
  console.warn(`[数据层] ${dataset} 主来源不可用，改用备源：${String(error && error.message).slice(0, 160)}`);
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// 供应商代码 → 业务代码的换算失败不应把整个数据集打断。
async function safeOfficial(fn, dataset) {
  try {
    return { value: await fn(), fallback: false };
  } catch (error) {
    if (isAbort(error)) throw error;
    logFallback(dataset, error);
    return { value: null, fallback: true };
  }
}

// ---------- 证券主档 ----------

// 证券主档（上下市清单）：当前来源是 Tushare stock_basic，官方 `cn/company` 只含在市公司、
// 没有退市日期与行业分类，无法承担"保留退市证券做历史归属"的合同，所以要换源必须先补这两项，
// 在补上之前这里保持单一来源，但上层只调本函数，不再自己拼 tushareQuery。
async function readSecurityMaster({ tsCode = '', exchange = '', listStatuses = ['L'], fields } = {}) {
  const columns = fields || 'ts_code,symbol,name,area,industry,market,list_date,delist_date,is_hs,list_status';
  // 单只查询：按代码取档案（业绩预告、财务同步等按证券跑的链路用），不遍历上市状态。
  if (tsCode) {
    const data = await tushareQuery('stock_basic', { ts_code: tsCode }, columns, { allowEmpty: true });
    return tsRows(data).map(row => ({ ...row, source_code: 'tushare' }));
  }
  const statuses = Array.isArray(listStatuses) ? listStatuses : [listStatuses];
  const rows = [];
  for (const status of statuses) {
    const data = await tushareQuery('stock_basic', { exchange, list_status: status }, columns, { allowEmpty: true });
    rows.push(...tsRows(data).map(row => ({ ...row, source_code: 'tushare' })));
  }
  return rows;
}

// ---------- 全市场日行情 / 复权因子 / 分钟线 ----------

// 按交易日取全市场收盘行情（历史回补与行情缓存用）：官方无「按交易日列全市场」接口，
// 因此仍是单一来源，但调用方只表达"要哪一天的行情"。
async function readStockDailyByDate({ tradeDate, fields = 'ts_code,trade_date,open,high,low,close,vol,amount', allowEmpty = true } = {}) {
  const data = await tushareQuery('daily', { trade_date: String(tradeDate).replace(/-/g, '') }, fields, { allowEmpty });
  return tsRows(data).map(row => ({ ...row, source_code: 'tushare' }));
}

// 复权因子：官方无因子接口（只有不复权/前复权序列），复权仍以本来源计算。
async function readAdjustmentFactors({ tradeDate, fields = 'ts_code,trade_date,adj_factor', allowEmpty = true } = {}) {
  const data = await tushareQuery('adj_factor', { trade_date: String(tradeDate).replace(/-/g, '') }, fields, { allowEmpty });
  return tsRows(data).map(row => ({ ...row, source_code: 'tushare' }));
}

// 分钟级实时价（A 股，按 ts_code 批量）：只给需要分钟数据的专项任务/页面兜底用，
// 普通页面行情走 readRealtimeQuotes，避免触发该接口频率限制。
async function readMinuteQuotes({ codes = [], freq = '1MIN', fields = 'ts_code,close' } = {}) {
  const list = [...new Set((codes || []).filter(Boolean))];
  if (!list.length) return new Map();
  const data = await tushareQuery('rt_min', { ts_code: list.join(','), freq }, fields);
  const map = new Map();
  tsRows(data).forEach(row => {
    if (row.ts_code && row.close != null) map.set(row.ts_code, parseFloat(row.close));
  });
  return map;
}

// ---------- 可转债行情与实时报价 ----------

// 可转债日行情：官方目录没有可转债个券接口，这里固定使用 Tushare cb_daily（单一来源，口径不变）。
// 上层只表达"要哪天的转债行情/哪几只"，不表达来源。
async function readConvertibleBondQuotes({ tradeDate, codes = null, fields } = {}) {
  const columns = fields || 'ts_code,trade_date,open,high,low,close,pre_close,vol,amount,cb_value,cb_over_rate';
  const trade = tradeDate ? String(tradeDate).replace(/-/g, '') : null;
  if (!trade) return [];
  if (!codes || !codes.length) {
    const data = await tushareQuery('cb_daily', { trade_date: trade }, columns, { allowEmpty: true });
    return tsRows(data).map(row => ({ ...row, source_code: 'tushare' }));
  }
  const rows = [];
  const list = [...new Set(codes.filter(Boolean))];
  for (const group of chunk(list, 200)) {
    const data = await tushareQuery('cb_daily', { ts_code: group.join(','), trade_date: trade }, columns, { allowEmpty: true });
    rows.push(...tsRows(data).map(row => ({ ...row, source_code: 'tushare' })));
  }
  return rows;
}

// 实时/t+0 报价（收盘时点、盘中兜底、港股 IPO 定价共用）：腾讯行情，返回 Map<code, quote>。
// 官方 candlestick 是日终数据，无法保证收盘瞬间已有当日行，因此这里保留实时来源，
// 但"用谁"的判断不再散落在各服务/任务里。
async function readRealtimeQuotes({ codes = [], businessDate = null, force = false, ttlMs = null, options = {} } = {}) {
  const list = [...new Set((codes || []).map(code => String(code || '').trim()).filter(Boolean))];
  if (!list.length) return new Map();
  const merged = { ...options };
  if (businessDate) merged.businessDate = businessDate;
  if (force) merged.force = true;
  if (ttlMs) merged.ttlMs = ttlMs;
  const quotes = await require('../services/tencentQuote').fetchTencentQuotes(list, merged);
  // 统一给每个报价打来源标记：上层按来源落库时用它查来源 id，不再自己写死来源名。
  for (const [key, value] of quotes) {
    if (value && !value.source_code) quotes.set(key, { ...value, source_code: value.source || 'tencent' });
  }
  return quotes;
}

// 港股日线（腾讯备源）：官方 hk_daily 需要高积分时的历史日 K，同样只表达"要哪只标的哪段收盘"。
async function readHkDailyByTencent({ canonicalCode, startDate, endDate } = {}) {
  return require('../services/tencentQuote').requestTencentHkKline(canonicalCode, startDate, endDate);
}

// ---------- 股票行业分类 ----------

// 行业分类：A 股用官方申万 2021（Tushare 申万成分表备源），港股用官方恒生行业分类（hsi）；
// 都取不到返回 null（调用方保留上一轮结论，不猜）。
async function readIndustryClassification({ tsCode, cacheMs } = {}) {
  const { selectIndustryPath } = require('../domain/lixingerIndustry');
  const isHk = /\.HK$/i.test(String(tsCode || '').trim());
  const primary = await safeOfficial(async () => {
    const rows = await official.resolveIndustryRows({ tsCode, cacheMs });
    if (!rows || !rows.length) return null;
    // 港股要求路径从一级起连续：选股按一级行业控上限，缺一级等于没有分类。
    return isHk
      ? selectIndustryPath(rows, { system: 'hsi', areaCode: 'hk', requireRoot: true })
      : selectIndustryPath(rows, { system: 'sw_2021', areaCode: 'cn' });
  }, 'stock_industry');
  if (primary.value) {
    const levelText = String(primary.value.industry_level || '')
      .replace(/^1级$/, '一级').replace(/^2级$/, '二级').replace(/^3级$/, '三级');
    return { ...primary.value, industry_level: levelText || primary.value.industry_level, sourceCode: official.SOURCE };
  }
  // Tushare 申万成分表只有 A 股，不能拿来给港股兜底。
  if (isHk) return null;

  try {
    const rows = tsRows(await tushareQuery('index_member_all', { ts_code: tsCode, is_new: 'Y' },
      'ts_code,l1_code,l1_name,l2_code,l2_name,l3_code,l3_name,is_new'));
    const row = rows.find(item => item.l3_name) || rows[0];
    if (!row) return null;
    return {
      industry: row.l3_name || row.l2_name || row.l1_name || '',
      industry_system: '申万2021',
      industry_level: row.l3_name ? '三级' : (row.l2_name ? '二级' : '一级'),
      industry_path: [row.l1_name, row.l2_name, row.l3_name].filter(Boolean),
      sourceCode: 'tushare',
    };
  } catch (error) {
    if (isAbort(error)) throw error;
    return null;
  }
}

// ---------- 指数：收盘序列与估值 ----------

// 指数收盘序列（页面 K 线与净值基准共用同一形状：{ date, close, source_code }）。
async function readIndexCloseSeries({ tsCode, startDate, endDate, market = 'cn' } = {}) {
  const primary = await safeOfficial(() => official.resolveIndexDaily({ tsCode, startDate, endDate, market }), 'index_close');
  if (primary.value && primary.value.length) return primary.value.map(point => ({ ...point, source_code: official.SOURCE }));

  if (market === 'hk') {
    // 港股指数（恒指）备源：腾讯历史日 K。
    const from = String(startDate).slice(0, 10), to = String(endDate).slice(0, 10);
    const url = `https://web.ifzq.gtimg.cn/appstock/app/hkfqkline/get?param=hkHSI,day,${from},${to},4000,qfq`;
    try {
      const txt = await require('../services/marketHttpSource').getText('tencent', url, { timeout: 10000 });
      const json = JSON.parse(txt);
      const dayArr = json && json.data && json.data.hkHSI && json.data.hkHSI.day;
      if (!Array.isArray(dayArr)) return [];
      return dayArr.map(it => ({ date: normDate(it[0]), close: parseFloat(it[2]), source_code: 'tencent' }))
        .filter(item => item.date && !isNaN(item.close) && item.close > 0);
    } catch (error) {
      if (error && error.code) throw error;
      return [];
    }
  }
  const rows = tsRows(await tushareQuery('index_daily',
    { ts_code: tsCode, start_date: String(startDate).replace(/-/g, ''), end_date: String(endDate).replace(/-/g, '') },
    'trade_date,close'));
  const series = rows.map(row => ({ date: normDate(row.trade_date), close: parseFloat(row.close), source_code: 'tushare' }))
    .filter(item => item.date && !isNaN(item.close) && item.close > 0);
  if (series.length) return series;
  // 最后一层备源（仅 A 股指数）：新浪历史 K 线，避免页面指数线整段空白。
  const match = String(tsCode || '').match(/^(\d{6})\.(SH|SZ)$/i);
  if (!match) return [];
  const symbol = `${match[2].toLowerCase()}${match[1]}`;
  const datalen = Math.min(500, 2500);
  const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${encodeURIComponent(symbol)}&scale=240&ma=no&datalen=${datalen}`;
  try {
    const txt = await require('../services/marketHttpSource').getText('sina', url, { timeout: 10000 });
    const arr = JSON.parse(txt);
    if (!Array.isArray(arr)) return [];
    return arr.map(item => ({ date: normDate(item.day), close: parseFloat(item.close), source_code: 'sina' }))
      .filter(item => item.date && !isNaN(item.close) && item.close > 0);
  } catch (error) {
    if (error && error.code) throw error;
    return [];
  }
}

// 恒指官网文件（备源）解析：返回 [{ day, pe, raw }]。
async function parseHsiWorkbook(buffer) {
  const XLSX = require('xlsx');
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false });
}

// 指数估值序列：官方总市值加权口径优先；A股备源 Tushare index_dailybasic，恒指备源官网文件。
// 返回 [{ day, pe, pb, marketCap, raw, source_code }]。
// allowFallback=false 时**不换源**：只回官方数据，官方没有就返回空。给「只认官方口径」的调用方用——
// 不同来源的算法可能不同（如全市场 PE：理杏仁总市值加权 vs Tushare/中证整体法），
// 换源后的值若被调用方按官方名义落库，就成了来源误标，所以由调用方显式关掉回退。
/**
 * 港股通标的清单（2026-11-05 新增）：官方 `hk/company` 的 `isMutualMarketAhFlag` 筛选。
 * 与指数成分一样无等价备源；取不到返回空数组并留证，不拿旧名单冒充当期标的
 * （港股通名单按日调整，过期名单会把已调出的证券当成可买对象）。
 */
/**
 * 港股公司档案（批量）：主要取 fsTableType 决定财报端点与指标口径；无等价备源，取不到返回空数组。
 */
async function readCompanyProfiles({ codes = [] } = {}) {
  const primary = await safeOfficial(() => official.resolveCompanyProfiles({ codes }), 'hk_company_profile');
  if (Array.isArray(primary.value) && primary.value.length) {
    return primary.value.map(row => ({ ...row, source_code: official.SOURCE }));
  }
  return [];
}

async function readMutualMarketCompanies(options = {}) {
  const primary = await safeOfficial(() => official.resolveMutualMarketCompanies(options), 'mutual_market_universe');
  if (Array.isArray(primary.value) && primary.value.length) {
    return primary.value.map(row => ({ ...row, source_code: official.SOURCE }));
  }
  return [];
}

/**
 * 指数成分股（港股恒生成分，2026-11-05 新增）：官方 `hk/index/constituents`，无等价备源。
 * 取不到时返回空数组并留证，**不用旧名单冒充当期成分**——成分是按日调整的事实，
 * 拿过期名单去补数据会把已剔除的证券当成选股对象。
 */
async function readIndexConstituents({ indexCode, date } = {}) {
  const primary = await safeOfficial(() => official.resolveIndexConstituents({ indexCode, date }), 'index_constituents');
  if (Array.isArray(primary.value) && primary.value.length) {
    return primary.value.map(row => ({ ...row, source_code: official.SOURCE }));
  }
  return [];
}

async function readIndexValuationSeries({ indexCode, startDate, endDate, market = 'cn', allowFallback = true } = {}) {
  const primary = await safeOfficial(() => official.resolveIndexValuation({ indexCode, startDate, endDate, market }), 'index_valuation');
  if (primary.value && primary.value.length) {
    return primary.value.map(row => ({ ...row, source_code: official.SOURCE }));
  }
  if (!allowFallback) return [];
  if (market === 'hk') {
    const buffer = await marketSource.fetchHsiPe();
    const data = await parseHsiWorkbook(buffer);
    const rows = [];
    for (const r of data.slice(3)) {
      const d = new Date(String(r[0]));
      const pe = Number(r[1]);
      if (Number.isNaN(d.getTime()) || !(pe > 0)) continue;
      rows.push({ day: d.toISOString().slice(0, 10), pe, pb: null, marketCap: null, raw: r, source_code: 'hsi_official' });
    }
    return rows;
  }
  const tsCode = /\./.test(String(indexCode)) ? indexCode : `${indexCode}.SH`;
  const data = await tushareQuery('index_dailybasic',
    { ts_code: tsCode, start_date: String(startDate).replace(/-/g, ''), end_date: String(endDate).replace(/-/g, '') },
    'ts_code,trade_date,total_mv,pe_ttm,pb');
  if (!data) return [];
  return tsRows(data).map(row => {
    const day = normDate(row.trade_date), pe = Number(row.pe_ttm), pb = Number(row.pb);
    if (!day || !((pe > 0) || (pb > 0))) return null;
    return { day, pe, pb, marketCap: Number(row.total_mv) || null, raw: row, source_code: 'tushare_index_dailybasic' };
  }).filter(Boolean);
}

// ---------- 宏观 ----------

// 10 年期国债收益率：官方优先，中债备源。返回 [{ workTime, tenYear, source_code }]。
async function readSovereignYieldSeries({ startDate, endDate } = {}) {
  const primary = await safeOfficial(() => official.resolveSovereignYield10y({ startDate, endDate }), 'cn_yield');
  if (primary.value && primary.value.length) {
    return primary.value.map(row => ({ ...row, source_code: official.SOURCE }));
  }
  const rows = [];
  let cursor = new Date(`${String(startDate).slice(0, 10)}T00:00:00Z`);
  const last = new Date(`${String(endDate).slice(0, 10)}T00:00:00Z`);
  while (cursor <= last) {
    const rangeEnd = new Date(Date.UTC(cursor.getUTCFullYear() + 1, cursor.getUTCMonth(), cursor.getUTCDate() - 1));
    const to = rangeEnd < last ? rangeEnd : last;
    const got = await marketSource.fetchChinaYield(cursor.toISOString().slice(0, 10), to.toISOString().slice(0, 10));
    for (const row of got) {
      if (Number(row.tenYear) > 0) rows.push({ workTime: row.workTime, tenYear: Number(row.tenYear), source_code: 'chinabond' });
    }
    cursor = new Date(to.getTime() + 86400000);
  }
  return rows;
}

// 货币供应 M2（亿元）：官方优先，Tushare 备源。返回 [{ month, m2, source_code }]。
async function readMoneySupplySeries({ startDate, endDate } = {}) {
  const primary = await safeOfficial(() => official.resolveMoneySupply({ startDate, endDate }), 'money_supply');
  if (primary.value && primary.value.length) {
    return primary.value.map(row => ({ ...row, source_code: official.SOURCE }));
  }
  const data = await tushareQuery('cn_m', {}, 'month,m2,m2_yoy');
  if (!data) return [];
  return tsRows(data).map(row => {
    const month = String(row.month || '').replace(/^(\d{4})(\d{2})$/, '$1-$2');
    const m2 = Number(row.m2);
    if (!/^\d{4}-\d{2}$/.test(month) || !(m2 > 0)) return null;
    return { month, m2, source_code: 'nbs_via_tushare' };
  }).filter(Boolean);
}

// A 股总市值（亿元）：统一估值分区聚合 → 官方中证全指 A 股市值 → Tushare daily_basic 汇总。
// 返回 { totalYi, securityCount, fromUnified, sourceCode, raw } 或 null。
async function readTotalAShareMarketCap({ day, minUnifiedCount = 1000 } = {}) {
  const date = normDate(day);
  if (!date) return null;
  let totalYi = 0, securityCount = 0, fromUnified = false, sourceCode = null, raw = null;
  try {
    const { getTotalMarketCap } = require('../services/stockDataService');
    const cap = await getTotalMarketCap(date);
    if (cap && cap.total_cap > 0 && cap.stock_count >= minUnifiedCount) {
      totalYi = Number(cap.total_cap) / YUAN_TO_100M;
      securityCount = cap.stock_count;
      fromUnified = true;
      sourceCode = null;
    }
  } catch (_) { /* 统一层异常则继续走下一层 */ }

  if (!(totalYi > 0)) {
    const primary = await safeOfficial(async () => {
      const rows = await official.resolveIndexValuation({ indexCode: '000985', startDate: date, endDate: date });
      const row = (rows || [])[0];
      return row && Number(row.raw && row.raw.mc_om) > 0 ? row : null;
    }, 'a_share_market_cap');
    if (primary.value) {
      const capYi = Number(primary.value.raw.mc_om) / YUAN_TO_100M;
      // 官方只给 A 股市值、不给证券只数：用当日估值分区的实际行数补，写 0 会被误读成"没有证券"。
      const { rows } = await require('../db/connection').pool
        .query('SELECT count(*)::int AS n FROM market.daily_valuations WHERE trade_date = $1::date', [date]);
      const valuationRows = Number(rows[0] && rows[0].n) || 0;
      // 分区不完整时（当天估值还没采、或只采了一部分）不能拿这个小数字当证券只数：
      // ① 写库会撞 chk_a_share_security_count（security_count >= 1000）；
      // ② 市场总量数据集不能建立在残缺分区上。此时继续走下一层（Tushare 当日全量快照），
      //    口径与历史每日数据保持一致，而不是把残缺值当有效值落库（2026-11-02 生产实测：
      //    11-02 估值分区 0 行，官方 mc_om 有值，security_count 写 0 触发约束失败两次）。
      if (capYi > 0 && valuationRows >= minUnifiedCount) {
        totalYi = capYi;
        securityCount = valuationRows;
        sourceCode = official.SOURCE;
        raw = primary.value.raw;
      }
    }
  }

  if (!(totalYi > 0)) {
    const data = await tushareQuery('daily_basic', { trade_date: date.replace(/-/g, '') }, 'ts_code,trade_date,total_mv', { failoverOnEmpty: true });
    const rows = tsRows(data);
    if (rows.length < 1000) return null;
    const valid = rows.filter(row => Number.isFinite(Number(row.total_mv)) && Number(row.total_mv) > 0);
    if (valid.length / rows.length < 0.8) return null;
    securityCount = rows.length;
    totalYi = valid.reduce((sum, row) => sum + Number(row.total_mv), 0) / 10000;
    sourceCode = null;
  }
  if (!(totalYi > 0)) return null;
  return { totalYi, securityCount, fromUnified, sourceCode, raw };
}

// ---------- 正股行情与估值 ----------

// 单只日线序列：官方不复权优先，备源 A股 Tushare、港股腾讯日 K。
// 返回 Tushare 形状的行（含 source_code），可直接落 market.daily_bars。
async function readStockDailySeries({ tsCode, startDate, endDate, market = 'cn' } = {}) {
  const primary = await safeOfficial(() => official.resolveStockDaily({ tsCode, startDate, endDate, market }), 'stock_daily');
  if (primary.value && primary.value.length) return primary.value;

  if (market === 'hk') {
    const bare = String(tsCode || '').replace(/\.HK$/i, '').padStart(5, '0');
    const payload = await require('../services/tencentQuote').requestTencentHkKline(bare, startDate, endDate);
    const node = payload && payload.data && payload.data[('hk' + bare).toLowerCase()];
    const dayRows = node && (node.qfqday || node.day);
    if (!Array.isArray(dayRows)) return [];
    return dayRows.map(item => ({
      ts_code: tsCode,
      trade_date: String(normDate(item && item[0]) || '').replace(/-/g, ''),
      close: parseFloat(item && item[2]),
      source_code: 'tencent',
    })).filter(row => row.trade_date && row.close > 0);
  }
  const data = await tushareQuery('daily', {
    ts_code: tsCode, start_date: String(startDate).replace(/-/g, ''), end_date: String(endDate).replace(/-/g, ''),
  }, 'ts_code,trade_date,open,high,low,close,vol,amount', { allowEmpty: true });
  return tsRows(data).map(row => ({ ...row, source_code: 'tushare' }));
}

// 批量日线（按需求集合）：官方逐只优先，官方没覆盖的代码由 Tushare 按代码补。
async function readStockDailyBatch({ tsCodes, tradeDate } = {}) {
  const list = Array.from(new Set((tsCodes || []).filter(Boolean)));
  if (!list.length || !tradeDate) return [];
  const primary = await safeOfficial(() => official.resolveStockDailyBatch({ tsCodes: list, tradeDate }), 'stock_daily_batch');
  const rows = (primary.value && primary.value.rows) || [];
  const missing = primary.value ? primary.value.missing : list;
  if (!missing.length) return rows;
  const trade = String(tradeDate).replace(/-/g, '');
  const fallback = [];
  for (const group of chunk(missing, 40)) {
    const data = await tushareQuery('daily', { ts_code: group.join(','), trade_date: trade },
      'ts_code,trade_date,open,high,low,close,vol,amount', { allowEmpty: true });
    fallback.push(...tsRows(data).map(row => ({ ...row, source_code: 'tushare' })));
  }
  return [...rows, ...fallback];
}

// 全市场估值（某交易日）：官方逐批（一次 100 只）优先，官方没覆盖的代码由 Tushare daily_basic 补。
// 宇宙由 Tushare daily_basic 的当日代码清单确定（官方没有"按交易日列全市场"的清单接口）。
// 业务覆盖裁决（R2-001）：官方批次部分失败时，保留已经取到的官方行，缺的代码按同口径备源补齐并标来源；
// 官方失败证据写入日志，不能因此声称"官方采集完整"。
async function readStockValuationRows({ tradeDate } = {}) {
  if (!tradeDate) return [];
  const universeData = await tushareQuery('daily_basic', { trade_date: String(tradeDate).replace(/-/g, '') },
    'ts_code,trade_date,pe,pe_ttm,pb,dv_ttm,total_mv,circ_mv', { failoverOnEmpty: true });
  const universeRows = tsRows(universeData);
  const codes = universeRows.map(row => row.ts_code);
  let officialRows = [];
  if (codes.length) {
    try {
      const detail = await official.resolveValuationRowsDetailed({ codes, tradeDate });
      officialRows = (detail && detail.rows) || [];
      if (detail && !detail.complete) {
        console.warn(`[数据层] stock_valuation 官方快照未取全（计划 ${detail.planned} 批，失败 ${detail.failed} 批，空 ${detail.emptyBatches} 批），缺失代码按备源补齐`);
        await recordValuationGaps({ kind: 'snapshot', stage: 'snapshot', detail });
      }
      if (detail) {
        // 成功批次覆盖的代码逐批确认：只有同一交易日、同一批代码这次都成功，才算该单元恢复。
        await resolveValuationGaps({
          kind: 'snapshot', stage: 'snapshot', tradeDate: String(tradeDate),
          securities: succeededCodes(codes, detail),
        });
      }
    } catch (error) {
      if (isAbort(error)) throw error;
      logFallback('stock_valuation', error);
      officialRows = [];
    }
  }
  const covered = new Set(officialRows.map(row => row.ts_code));
  const fallbackRows = universeRows.filter(row => !covered.has(row.ts_code)).map(row => ({ ...row, source_code: 'tushare' }));
  return [...officialRows, ...fallbackRows];
}

// 逐只估值区间批量（历史回填专用）：按「代码批 × 日期区间」取官方估值，只回官方不回落备源。
// 与 readStockValuationRows（单日快照）互补——后者按日调用，回填十年历史要 9000+ 次请求；
// 本入口一次取一批代码的整段，适配层内部按官方 ≤10 年跨度限制自动分段。
// 返回 Tushare 形状（total_mv 万元、dv_ttm 百分数点），source_code 固定官方；
// 官方无数据时返回空数组，由调用方决定是否重试，不得在此回退 Tushare（会把 77 写成官方）。
// 完整性（R2-001）：官方计划段有失败时不再返回"看起来完整"的数组——
// 抛 PARTIAL_RESULT，错误对象带 partialRows（已取到的官方行）与 failures（逐段诊断），
// 调用方可以保留成功部分，但必须自己决定是否续跑，不能把非空结果当成整段成功。
async function readStockValuationSeriesBatch({ codes = [], startDate, endDate } = {}) {
  const detail = await readStockValuationSeriesDetailed({ codes, startDate, endDate });
  if (!detail) return [];
  if (!detail.complete) {
    const error = new Error(`官方估值历史未取全：计划 ${detail.planned} 段，成功 ${detail.succeeded} 段，失败 ${detail.failed} 段`);
    error.code = 'PARTIAL_RESULT';
    error.partialRows = detail.rows;
    error.failures = detail.failures;
    throw error;
  }
  return detail.rows;
}

// 逐只估值区间批量的详细结果（R2-001）：回填脚本用它同时拿到成功行与失败区间，
// 成功行照常幂等写入，失败区间不删旧行、不推进完整水位。
async function readStockValuationSeriesDetailed({ codes = [], startDate, endDate } = {}) {
  const list = (codes || []).filter(Boolean);
  if (!list.length || !startDate || !endDate) return null;
  const primary = await safeOfficial(
    () => official.resolveValuationSeriesDetailed({ codes: list, startDate, endDate }),
    'stock_valuation_series',
  );
  if (!primary.value) return null;
  const detail = primary.value;
  if (!detail.complete) {
    await recordValuationGaps({ kind: 'series', stage: 'series_backfill', detail });
  }
  // 恢复按「证券 × 被覆盖区间」判定：其他证券成功、或只补了其中一段，都不能关掉本单元的缺口。
  await resolveValuationGaps({
    kind: 'series', stage: 'series_backfill',
    coverage: seriesCoverage(list, detail),
  });
  return { ...detail, rows: detail.rows.map(row => ({ ...row, source_code: official.SOURCE })) };
}

// 复权因子（按代码区间）：官方无因子接口，复权仍以本来源计算。
async function readAdjustmentFactorSeries({ tsCode, startDate, endDate, fields = 'ts_code,trade_date,adj_factor' } = {}) {
  const data = await tushareQuery('adj_factor', {
    ts_code: tsCode,
    start_date: String(startDate).replace(/-/g, ''),
    end_date: String(endDate).replace(/-/g, ''),
  }, fields, { allowEmpty: true });
  return tsRows(data).map(row => ({ ...row, source_code: 'tushare' }));
}

// 估值历史（按代码区间）：单只证券的每日估值，用于分析页与异常修复。// 官方按 (证券, 日期区间) 整段取数；官方覆盖到的日期，六项估值一律取官方数值（不是只换标签），
// 官方没有的日期才沿用备源数值并标回备源来源。静态市盈率由官方市值 ÷ 官方年报归母净利派生。
// 备源仍要取：官方估值接口不提供收盘价与股本（total_share/float_share/free_share），
// 这份区间骨架同时兜住官方没覆盖的日期；股本单独标 share_source_code，不与估值来源混为一谈。
const VALUATION_VALUE_FIELDS = ['pe', 'pe_ttm', 'pb', 'dv_ttm', 'total_mv', 'circ_mv'];

async function readStockValuationHistory({ tsCode, startDate, endDate, fields = 'ts_code,trade_date,pe,pe_ttm,pb,dv_ttm,total_mv,circ_mv' } = {}) {
  const from = String(startDate).replace(/-/g, '');
  const to = String(endDate).replace(/-/g, '');
  const primary = await safeOfficial(async () => {
    // R2-001：用详细结果，部分日期段失败时保留已取到的官方行（不整段丢掉），
    // 并把失败区间记进日志；缺的日期仍由下面的备源骨架兜住，不会被当成"官方没有数据"。
    const detail = await official.resolveValuationSeriesDetailed({ codes: [tsCode], startDate: from, endDate: to });
    if (!detail) return [];
    if (!detail.complete) {
      console.warn(`[数据层] stock_valuation 官方历史未取全 ${tsCode}：计划 ${detail.planned} 段，成功 ${detail.succeeded} 段，失败 ${detail.failed} 段；已取到的官方日期照常使用，其余日期沿用备源`);
      await recordValuationGaps({ kind: 'series', stage: 'history', detail });
    }
    // 只有本次成功读取的区间覆盖了原失败段、且是同一证券，才关闭该段缺口。
    await resolveValuationGaps({
      kind: 'series', stage: 'history',
      coverage: seriesCoverage([tsCode], detail),
    });
    const rows = detail.rows;
    if (!rows.length) return rows;
    // 区间起点前两年的年报也要拿到，否则区间第一天没有「最近一期年报」可算静态市盈率。
    const annualStart = `${Number(from.slice(0, 4)) - 2}${from.slice(4)}`;
    const annuals = await official.resolveAnnualNetProfits({ tsCode, startDate: annualStart, endDate: to });
    return official.fillStaticPe(rows, annuals);
  }, 'stock_valuation');
  const officialByDate = new Map(((primary.value || [])).map(row => [String(row.trade_date), row]));
  // 备源只负责收盘价与股本骨架：它失败（凭据失效/接口异常）不能把已经拿到的官方估值一起丢掉。
  // 中止类错误（预算/策略/锁）仍然上抛，其余一律降级为「备源不可用」，缺的字段按缺失标出来。
  let skeleton = [];
  let backupUnavailable = false;
  try {
    const data = await tushareQuery('daily_basic', { ts_code: tsCode, start_date: from, end_date: to }, fields, { allowEmpty: true });
    skeleton = tsRows(data);
  } catch (error) {
    if (isAbort(error)) throw error;
    backupUnavailable = true;
    console.warn(`[数据层] stock_valuation 收盘价/股本备源不可用，本次只返回官方估值（相关字段标缺失）：${String(error && error.message).slice(0, 160)}`);
  }
  const rows = [];
  for (const row of skeleton) {
    const day = String(row.trade_date);
    const officialRow = officialByDate.get(day);
    if (!officialRow) {
      rows.push({ ...row, source_code: 'tushare', share_source_code: 'tushare' });
      continue;
    }
    officialByDate.delete(day);
    const merged = { ...row };
    const carried = [];
    for (const field of VALUATION_VALUE_FIELDS) {
      const value = officialRow[field];
      if (value === null || value === undefined) {
        // 官方这一天该项为空（如未披露年报算不出静态市盈率）：保留备源数值，
        // 但把字段记进 carried_fields，页面上不会出现「数值来自备源、标签写着官方」而无人知情。
        if (Number.isFinite(Number(row[field])) && row[field] !== null && row[field] !== '') carried.push(field);
        continue;
      }
      merged[field] = value;
    }
    merged.source_code = official.SOURCE;
    merged.share_source_code = 'tushare';
    if (carried.length) merged.carried_fields = carried;
    rows.push(merged);
  }
  // 官方有、备源骨架没有的交易日直接给官方行：备源缺行或备源整体不可用时，官方数据照常返回，
  // 由备源负责的字段（收盘价/股本）明确标成缺失，而不是让整次读取失败或悄悄补 0。
  const backupFields = ['close', 'total_share', 'float_share', 'free_share'];
  for (const [day, officialRow] of officialByDate) {
    const row = { ...officialRow, close: null, total_share: null, float_share: null, free_share: null, share_source_code: null, missing_fields: backupFields.slice() };
    if (backupUnavailable) row.backup_unavailable = true;
    rows.push(row);
  }
  rows.sort((a, b) => (String(a.trade_date) < String(b.trade_date) ? -1 : String(a.trade_date) > String(b.trade_date) ? 1 : 0));
  return rows;
}

// 业绩预告：官方目录无业绩预告接口，单一来源，但调用方只表达需求。
async function readForecast({ tsCode, startDate = null, fields = 'ts_code,ann_date,end_date,type,p_change_min,p_change_max,net_profit_min,net_profit_max,last_parent_net,summary,change_reason' } = {}) {
  const params = { ts_code: tsCode };
  if (startDate) params.start_date = String(startDate).replace(/-/g, '');
  const data = await tushareQuery('forecast', params, fields, { allowEmpty: true });
  return tsRows(data).map(row => ({ ...row, source_code: 'tushare' }));
}

// 历史收盘序列（按标的类型）：晚录入净值回补用，只返回日期与收盘价（统一 YYYYMMDD）。
// kind 是业务类型（stock/index/bond/fund），到底调哪个供应商接口由这一层决定。
// 正股与指数走各自数据集的主备链路（官方优先），债券与基金官方目录未准入，仍为单一来源。
const HISTORICAL_CLOSE_APIS = Object.freeze({
  bond: 'cb_daily',
  fund: 'fund_daily',
});

async function readHistoricalCloseSeries({ tsCode, kind = 'stock', startDate, endDate } = {}) {
  const from = String(startDate).replace(/-/g, '');
  const to = String(endDate).replace(/-/g, '');
  // 正股：与行情数据集同一入口（官方不复权优先，官方没覆盖的区间由备源补并标回来源）。
  if (kind === 'stock') {
    const rows = await readStockDailySeries({ tsCode, startDate: from, endDate: to });
    return rows
      .map(row => ({ trade_date: String(row.trade_date || '').replace(/-/g, ''), close: row.close, source_code: row.source_code || 'tushare' }))
      .filter(row => row.trade_date && Number(row.close) > 0);
  }
  // 指数：与页面指数线同一入口（官方优先 → 备源）。
  if (kind === 'index') {
    const series = await readIndexCloseSeries({ tsCode, startDate: from, endDate: to });
    return series
      .map(point => ({ trade_date: String(point.date || '').replace(/-/g, ''), close: point.close, source_code: point.source_code || 'tushare' }))
      .filter(row => row.trade_date && Number(row.close) > 0);
  }
  // 债券（可转债个券）与基金：官方目录里没有可用的个券 K 线接口，
  // 可转债个券官方无接口；基金 K 线在目录中是 excluded（见 catalog 的 statusReason），故仍为单一来源。
  const apiName = HISTORICAL_CLOSE_APIS[kind];
  if (!apiName) throw new Error(`未登记的历史收盘类型：${kind}`);
  const data = await tushareQuery(apiName, {
    ts_code: tsCode,
    start_date: from,
    end_date: to,
  }, 'trade_date,close', { allowEmpty: true });
  return tsRows(data).map(row => ({ ...row, source_code: 'tushare' }));
}

// 财务报表全字段序列（分析页用）：官方指标字典目前只映射到收入 7 项、资产 6 项、现金流 2 项、指标 4 项，
// 而分析页要的是三表完整字段（收入 53、资产 89、现金流 51），缺口会导致大量指标无法回填，
// 因此这一条仍是单一来源，但调用方只表达"要哪张表、哪段时间"，接口与参数在数据层内决定。
const STATEMENT_APIS = Object.freeze({
  income: 'income',
  balancesheet: 'balancesheet',
  balance: 'balancesheet',
  cashflow: 'cashflow',
  fina_indicator: 'fina_indicator',
});

async function readFinancialStatementSeries({ tsCode, kind, startDate, endDate, fields } = {}) {
  const apiName = STATEMENT_APIS[kind];
  if (!apiName) throw new Error(`未登记的三表类型：${kind}`);
  const data = await tushareQuery(apiName, {
    ts_code: tsCode,
    start_date: String(startDate).replace(/-/g, ''),
    end_date: String(endDate).replace(/-/g, ''),
  }, fields);
  if (!data || !Array.isArray(data.items)) throw new Error(`${kind} 数据获取失败`);
  return tsRows(data).map(row => ({ ...row, source_code: 'tushare' }));
}

// ---------- 财报与分红 ----------

// 财报（按报表类型）：官方优先；官方无数据时返回 null，由调用方沿用既有批量取数链路。
async function readFinancialReportRows({ tsCode, kinds, startDate, endDate, fsTableType } = {}) {
  // 港股财报端点按公司财报类型分流（bank/insurance/security/reit/other_financial/non_financial），
  // 类型由调用方按 hk/company 档案给出；缺省回落 non_financial，不猜。
  const primary = await safeOfficial(() => official.resolveFinancialReports({ tsCode, startDate, endDate, kinds, options: { fsTableType } }), 'financial_reports');
  if (!primary.value) return null;
  const hasAny = Object.values(primary.value).some(rows => Array.isArray(rows) && rows.length);
  if (!hasAny) return null;
  return primary.value;
}

// 分红：官方优先，原来源备源。返回行带 source_code，并用 is_default_source 标出「默认来源」的行——
// 默认来源的行由调用方走原有落库路径，非默认来源的行另写一份标准事实；
// 上层只看这个标记，不需要知道默认来源具体是谁。
const DEFAULT_DIVIDEND_SOURCE = 'tushare';

async function readDividendRows({ tsCode, startDate, endDate } = {}) {
  const primary = await safeOfficial(() => official.resolveDividendRows({ tsCode, startDate, endDate }), 'stock_dividend');
  const tag = rows => rows.map(row => ({
    ...row,
    source_code: row.source_code,
    is_default_source: row.source_code === DEFAULT_DIVIDEND_SOURCE,
  }));
  if (primary.value && primary.value.length) {
    return tag(primary.value.map(row => ({ ...row, source_code: official.SOURCE })));
  }
  const rows = tsRows(await tushareQuery('dividend', { ts_code: tsCode },
    'ts_code,end_date,ann_date,div_proc,stk_div,stk_bo_rate,stk_co_rate,cash_div,cash_div_tax,record_date,ex_date,pay_date,imp_ann_date,base_date,base_share', { allowEmpty: true }));
  return tag(rows.map(row => ({ ...row, source_code: DEFAULT_DIVIDEND_SOURCE })));
}

// 债券安全性用财报：官方能给三表与大部分指标，但**没有利息保障倍数**（ebit_to_interest），
// 而该项是安全性的核心判据；混用会让分子分母来自不同口径，因此官方缺该项时整份沿用原来源。
// 返回结构与原来 selectFinancialReport 的输入一致（三份原始行 + 实际来源标记）。
async function readBondSafetyFinancials({ tsCode, startDate = null } = {}) {
  const from = startDate ? String(startDate).replace(/-/g, '') : '';
  // 官方指标字典对「利息保障倍数」没有对应指标（REPORT_METRICS.indicator 无 ebit_to_interest），
  // 而该项是债券安全性的核心判据；明知道会缺就不要先花掉一次外采额度，整份直接沿用原来源。
  // 若日后官方补齐该指标，只需在适配层加映射，这里会自动切到官方。
  const officialCanCoverInterest = Boolean(official.REPORT_METRICS
    && official.REPORT_METRICS.indicator
    && official.REPORT_METRICS.indicator.ebit_to_interest);
  const officialRows = officialCanCoverInterest ? await safeOfficial(
    () => official.resolveFinancialReports({
      tsCode, startDate: from ? `${from.slice(0, 4)}-${from.slice(4, 6)}-${from.slice(6, 8)}` : null, endDate: null,
      kinds: ['balance', 'income', 'indicator'],
    }),
    'bond_safety_financials'
  ) : { value: null };
  const payload = officialRows.value || {};
  const indicatorRows = payload.indicator || [];
  const hasInterestCoverage = indicatorRows.some(row => Number.isFinite(Number(row.ebit_to_interest)));
  if (hasInterestCoverage) {
    return {
      sourceCode: official.SOURCE,
      indicator: indicatorRows,
      balance: payload.balance || [],
      income: payload.income || [],
    };
  }
  const dateParams = from ? { start_date: from } : {};
  const [fiData, bsData, incomeData] = await Promise.all([
    tushareQuery('fina_indicator', Object.assign({ ts_code: tsCode }, dateParams),
      'ts_code,ann_date,end_date,report_type,ebit,ebit_to_interest,interestdebt'),
    tushareQuery('balancesheet', Object.assign({ ts_code: tsCode }, dateParams),
      'ts_code,f_ann_date,end_date,report_type,money_cap,trad_asset,total_assets,total_cur_liab,total_liab,total_hldr_eqy_exc_min_int'),
    tushareQuery('income', Object.assign({ ts_code: tsCode }, dateParams),
      'ts_code,ann_date,f_ann_date,end_date,report_type,fin_exp_int_exp,int_exp'),
  ]);
  return {
    sourceCode: 'tushare',
    indicator: tsRows(fiData),
    balance: tsRows(bsData),
    income: tsRows(incomeData),
  };
}

// 补权益用的单表读取（只取归母权益）：按代码整段取，避免调用方自己拼参数。
async function readEquitySeries({ tsCode, fields = 'ts_code,f_ann_date,end_date,report_type,total_hldr_eqy_exc_min_int' } = {}) {
  const data = await tushareQuery('balancesheet', { ts_code: tsCode }, fields, { allowEmpty: true });
  return tsRows(data).map(row => ({ ...row, source_code: 'tushare' }));
}

module.exports = {
  readAdjustmentFactors,  readAdjustmentFactorSeries,
  readBondSafetyFinancials,
  readEquitySeries,
  readForecast,
  readHistoricalCloseSeries,
  readConvertibleBondQuotes,
  readDividendRows,
  readFinancialReportRows,
  readFinancialStatementSeries,
  readIndexCloseSeries,
  readIndexConstituents,
  readMutualMarketCompanies,
  readCompanyProfiles,
  readIndexValuationSeries,
  readHkDailyByTencent,
  readIndustryClassification,
  readMinuteQuotes,
  readMoneySupplySeries,
  readRealtimeQuotes,
  readSecurityMaster,
  readSovereignYieldSeries,
  readStockDailyBatch,
  readStockDailyByDate,
  readStockDailySeries,
  readStockValuationHistory,
  readStockValuationRows,
  readStockValuationSeriesBatch,
  readStockValuationSeriesDetailed,
  readTotalAShareMarketCap,
};

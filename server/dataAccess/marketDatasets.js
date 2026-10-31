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
const { tushareQuery, tsRows, normDate } = require('../services/market');
const marketSource = require('../services/marketVolatilitySource');
const official = require('./adapters/lixingerDatasetAdapter');

const ABORT_CODES = new Set(['JOB_BUDGET_EXCEEDED', 'POLICY_NOT_CONFIGURED', 'DATASET_LOCKED']);
const YUAN_TO_100M = 1e8;

function isAbort(error) {
  return Boolean(error && ABORT_CODES.has(error.code));
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
  return require('../services/tencentQuote').fetchTencentQuotes(list, merged);
}

// 港股日线（腾讯备源）：官方 hk_daily 需要高积分时的历史日 K，同样只表达"要哪只标的哪段收盘"。
async function readHkDailyByTencent({ canonicalCode, startDate, endDate } = {}) {
  return require('../services/tencentQuote').requestTencentHkKline(canonicalCode, startDate, endDate);
}

// ---------- 股票行业分类 ----------

// 行业分类：官方申万 2021 优先，Tushare 申万成分表备源；都取不到返回 null（调用方保留上一轮结论）。
async function readIndustryClassification({ tsCode, cacheMs } = {}) {
  const { selectIndustryPath } = require('../domain/lixingerIndustry');
  const primary = await safeOfficial(async () => {
    const rows = await official.resolveIndustryRows({ tsCode, cacheMs });
    if (!rows || !rows.length) return null;
    return selectIndustryPath(rows, { system: 'sw_2021', areaCode: 'cn' });
  }, 'stock_industry');
  if (primary.value) {
    const levelText = String(primary.value.industry_level || '')
      .replace(/^1级$/, '一级').replace(/^2级$/, '二级').replace(/^3级$/, '三级');
    return { ...primary.value, industry_level: levelText || primary.value.industry_level, sourceCode: official.SOURCE };
  }

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

// 指数收盘序列（页面 K 线与净值基准共用同一形状：{ date, close }）。
async function readIndexCloseSeries({ tsCode, startDate, endDate, market = 'cn' } = {}) {
  const primary = await safeOfficial(() => official.resolveIndexDaily({ tsCode, startDate, endDate, market }), 'index_close');
  if (primary.value && primary.value.length) return primary.value;

  if (market === 'hk') {
    // 港股指数（恒指）备源：腾讯历史日 K。
    const from = String(startDate).slice(0, 10), to = String(endDate).slice(0, 10);
    const url = `https://web.ifzq.gtimg.cn/appstock/app/hkfqkline/get?param=hkHSI,day,${from},${to},4000,qfq`;
    try {
      const txt = await require('../services/marketHttpSource').getText('tencent', url, { timeout: 10000 });
      const json = JSON.parse(txt);
      const dayArr = json && json.data && json.data.hkHSI && json.data.hkHSI.day;
      if (!Array.isArray(dayArr)) return [];
      return dayArr.map(it => ({ date: normDate(it[0]), close: parseFloat(it[2]) }))
        .filter(item => item.date && !isNaN(item.close) && item.close > 0);
    } catch (error) {
      if (error && error.code) throw error;
      return [];
    }
  }
  const rows = tsRows(await tushareQuery('index_daily',
    { ts_code: tsCode, start_date: String(startDate).replace(/-/g, ''), end_date: String(endDate).replace(/-/g, '') },
    'trade_date,close'));
  const series = rows.map(row => ({ date: normDate(row.trade_date), close: parseFloat(row.close) }))
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
    return arr.map(item => ({ date: normDate(item.day), close: parseFloat(item.close) }))
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
async function readIndexValuationSeries({ indexCode, startDate, endDate, market = 'cn' } = {}) {
  const primary = await safeOfficial(() => official.resolveIndexValuation({ indexCode, startDate, endDate, market }), 'index_valuation');
  if (primary.value && primary.value.length) {
    return primary.value.map(row => ({ ...row, source_code: official.SOURCE }));
  }
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
      totalYi = Number(primary.value.raw.mc_om) / YUAN_TO_100M;
      sourceCode = official.SOURCE;
      raw = primary.value.raw;
      // 官方只给 A 股市值、不给证券只数：用当日估值分区的实际行数补，写 0 会被误读成"没有证券"。
      const { rows } = await require('../db/connection').pool
        .query('SELECT count(*)::int AS n FROM market.daily_valuations WHERE trade_date = $1::date', [date]);
      securityCount = Number(rows[0] && rows[0].n) || 0;
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
async function readStockValuationRows({ tradeDate } = {}) {
  if (!tradeDate) return [];
  const universeData = await tushareQuery('daily_basic', { trade_date: String(tradeDate).replace(/-/g, '') },
    'ts_code,trade_date,pe,pe_ttm,pb,dv_ttm,total_mv,circ_mv', { failoverOnEmpty: true });
  const universeRows = tsRows(universeData);
  const codes = universeRows.map(row => row.ts_code);
  let officialRows = [];
  if (codes.length) {
    const primary = await safeOfficial(() => official.resolveValuationRows({ codes, tradeDate }), 'stock_valuation');
    officialRows = primary.value || [];
  }
  const covered = new Set(officialRows.map(row => row.ts_code));
  const fallbackRows = universeRows.filter(row => !covered.has(row.ts_code)).map(row => ({ ...row, source_code: 'tushare' }));
  return [...officialRows, ...fallbackRows];
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

// 估值历史（按代码区间）：单只证券的每日估值，用于分析页与异常修复。
// 官方按 (证券, 日期区间) 可取，覆盖到的行标官方来源，其余由原来源补齐。
async function readStockValuationHistory({ tsCode, startDate, endDate, fields = 'ts_code,trade_date,pe,pe_ttm,pb,dv_ttm,total_mv,circ_mv' } = {}) {
  const from = String(startDate).replace(/-/g, '');
  const to = String(endDate).replace(/-/g, '');
  const data = await tushareQuery('daily_basic', { ts_code: tsCode, start_date: from, end_date: to }, fields, { allowEmpty: true });
  const rows = tsRows(data);
  if (!rows.length) return [];
  const primary = await safeOfficial(
    () => official.resolveValuationRows({ codes: [tsCode], tradeDate: to }),
    'stock_valuation'
  );
  const officialByDate = new Map(((primary.value || [])).map(row => [String(row.trade_date), row]));
  return rows.map(row => {
    const officialRow = officialByDate.get(String(row.trade_date));
    return { ...row, source_code: officialRow ? official.SOURCE : 'tushare' };
  });
}

// 业绩预告：官方目录无业绩预告接口，单一来源，但调用方只表达需求。
async function readForecast({ tsCode, startDate = null, fields = 'ts_code,ann_date,end_date,type,p_change_min,p_change_max,net_profit_min,net_profit_max,last_parent_net,summary,change_reason' } = {}) {
  const params = { ts_code: tsCode };
  if (startDate) params.start_date = String(startDate).replace(/-/g, '');
  const data = await tushareQuery('forecast', params, fields, { allowEmpty: true });
  return tsRows(data).map(row => ({ ...row, source_code: 'tushare' }));
}

// 历史收盘序列（按标的类型）：晚录入净值回补用，只返回日期与收盘价。
// kind 是业务类型（stock/bond/fund/index），到底调哪个供应商接口由这一层决定。
const HISTORICAL_CLOSE_APIS = Object.freeze({
  stock: 'daily',
  bond: 'cb_daily',
  fund: 'fund_daily',
  index: 'index_daily',
});

async function readHistoricalCloseSeries({ tsCode, kind = 'stock', startDate, endDate } = {}) {
  const apiName = HISTORICAL_CLOSE_APIS[kind];
  if (!apiName) throw new Error(`未登记的历史收盘类型：${kind}`);
  const data = await tushareQuery(apiName, {
    ts_code: tsCode,
    start_date: String(startDate).replace(/-/g, ''),
    end_date: String(endDate).replace(/-/g, ''),
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
async function readFinancialReportRows({ tsCode, kinds, startDate, endDate } = {}) {
  const primary = await safeOfficial(() => official.resolveFinancialReports({ tsCode, startDate, endDate, kinds }), 'financial_reports');
  if (!primary.value) return null;
  const hasAny = Object.values(primary.value).some(rows => Array.isArray(rows) && rows.length);
  if (!hasAny) return null;
  return primary.value;
}

// 分红：官方优先，Tushare 备源；返回 Tushare 形状的行（含 source_code）。
async function readDividendRows({ tsCode, startDate, endDate } = {}) {
  const primary = await safeOfficial(() => official.resolveDividendRows({ tsCode, startDate, endDate }), 'stock_dividend');
  if (primary.value && primary.value.length) {
    return primary.value.map(row => ({ ...row, source_code: official.SOURCE }));
  }
  const rows = tsRows(await tushareQuery('dividend', { ts_code: tsCode },
    'ts_code,end_date,ann_date,div_proc,stk_div,stk_bo_rate,stk_co_rate,cash_div,cash_div_tax,record_date,ex_date,pay_date,imp_ann_date,base_date,base_share', { allowEmpty: true }));
  return rows.map(row => ({ ...row, source_code: 'tushare' }));
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
  readAdjustmentFactors,
  readAdjustmentFactorSeries,
  readBondSafetyFinancials,
  readEquitySeries,
  readForecast,
  readHistoricalCloseSeries,
  readConvertibleBondQuotes,
  readDividendRows,
  readFinancialReportRows,
  readFinancialStatementSeries,
  readIndexCloseSeries,
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
  readTotalAShareMarketCap,
};

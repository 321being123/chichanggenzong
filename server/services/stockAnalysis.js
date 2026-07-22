const https = require('https');
const crypto = require('crypto');
const { pool } = require('../db/connection');
const { tushareQuery, tsRows, toTsCode, tsDateStr } = require('./market');
const { fetchTencentQuotes, normalizeCode } = require('./tencentQuote');
const { persistCollectedData, saveCollectedEvents, saveAnalysisResults } = require('./financialDataArchitecture');
const { statementApiFields } = require('./stockStatements');

const FORMULA_VERSION = '1';
const DAY = 86400000;
const REPORT_TABLES = {
  income: 'stock_income_statements',
  balancesheet: 'stock_balance_sheets',
  cashflow: 'stock_cashflow_statements',
};

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeStockCode(value) {
  const tsCode = toTsCode(String(value || '').trim());
  return /^\d{6}\.(SH|SZ|BJ)$/.test(tsCode) ? tsCode : null;
}

function isOrdinaryAStock(tsCode) {
  if (!normalizeStockCode(tsCode)) return false;
  const code = tsCode.slice(0, 6);
  return /^(60|68|00|30|43|83|87|92)/.test(code) && !/^(110|111|113|118|123|127|128)/.test(code);
}

function versionKey(row) {
  return [row.end_date || '', row.report_type || '', row.f_ann_date || row.ann_date || '', row.update_flag || '', row.div_proc || '', row.ex_date || row.pay_date || ''].join('|');
}

function dateText(value) {
  return String(value || '').replace(/-/g, '').slice(0, 8);
}

function isoDate(value) {
  const text = dateText(value);
  return /^\d{8}$/.test(text) ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}` : '';
}

function yearsAgo(days) {
  return tsDateStr(new Date(Date.now() - days * DAY));
}

async function fetchRequired(apiName, params, fields) {
  const data = await tushareQuery(apiName, params, fields);
  if (!data || !Array.isArray(data.items)) throw new Error(`${apiName} 数据获取失败`);
  return tsRows(data);
}

async function fetchIndustry(tsCode) {
  try {
    const rows = await fetchRequired('index_member_all', { ts_code: tsCode, is_new: 'Y' }, 'ts_code,l1_code,l1_name,l2_code,l2_name,l3_code,l3_name,is_new');
    const row = rows.find(item => item.l3_name) || rows[0];
    return row ? { industry: row.l3_name || row.l2_name || row.l1_name || '', industry_system: '申万2021', industry_level: row.l3_name ? '三级' : (row.l2_name ? '二级' : '一级'), industry_path: [row.l1_name,row.l2_name,row.l3_name].filter(Boolean) } : null;
  } catch (_) { return null; }
}

function controllerType(name) {
  const text = String(name || '');
  if (!text) return '';
  if (/无实际控制人/.test(text)) return '无实际控制人';
  if (/国资委|财政部|人民政府|国有资产|国务院/.test(text)) return '国资';
  if (/^[\u4e00-\u9fa5·]{2,6}$/.test(text)) return '自然人';
  return '企业或机构';
}

async function fetchActualController(tsCode) {
  try {
    const prefix = tsCode.endsWith('.SH') ? 'SH' : 'SZ';
    const payload = await requestJson(`https://emweb.securities.eastmoney.com/PC_HSF10/ShareholderResearch/PageAjax?code=${prefix}${tsCode.slice(0, 6)}`);
    const raw = Array.isArray(payload.sjkzr) ? payload.sjkzr[0] : payload.sjkzr;
    if (!raw || !raw.HOLDER_NAME) return null;
    return { name: String(raw.HOLDER_NAME), type: controllerType(raw.HOLDER_NAME), hold_ratio: finite(raw.HOLD_RATIO), source: '东方财富F10' };
  } catch (_) { return null; }
}

function ranges(startDate, endDate, years = 8) {
  let year = Number(String(startDate).slice(0, 4));
  const endYear = Number(String(endDate).slice(0, 4));
  const result = [];
  while (year <= endYear) {
    const last = Math.min(endYear, year + years - 1);
    result.push([`${year}0101`, `${last}1231` > endDate ? endDate : `${last}1231`]);
    year = last + 1;
  }
  return result;
}

async function fetchPartitioned(apiName, tsCode, startDate, endDate, fields) {
  const result = [];
  for (const [start, end] of ranges(startDate, endDate)) {
    const rows = await fetchRequired(apiName, { ts_code: tsCode, start_date: start, end_date: end }, fields);
    result.push(...rows);
  }
  return result;
}

async function repairZeroValuations(tsCode, rows, fields) {
  const affected=rows.filter(row=>['pe','pe_ttm','pb'].some(field=>finite(row[field])===0));
  if(!affected.length)return {rows,issues:[]};
  const dates=affected.map(row=>row.trade_date).sort(),retry=await fetchRequired('daily_basic',{ts_code:tsCode,start_date:dates[0],end_date:dates[dates.length-1]},fields),retryMap=new Map(retry.map(row=>[row.trade_date,row])),issues=[];
  const repaired=rows.map(row=>{const next=Object.assign({},row),again=retryMap.get(row.trade_date)||{};['pe','pe_ttm','pb'].forEach(field=>{if(finite(row[field])!==0)return;const value=finite(again[field]);if(value!==null&&value!==0)next[field]=value;else{next[field]=null;issues.push({trade_date:row.trade_date,field:field,reason:'接口重拉后仍为0，按缺失值处理'});}});return next;});
  return {rows:repaired,issues};
}

async function saveMetadata(row) {
  await pool.query(
    `INSERT INTO stock_analysis_stocks (ts_code,symbol,name,industry,market,list_date,data)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
     ON CONFLICT (ts_code) DO UPDATE SET symbol=EXCLUDED.symbol,name=EXCLUDED.name,
       industry=EXCLUDED.industry,market=EXCLUDED.market,list_date=EXCLUDED.list_date,
       data=EXCLUDED.data,fetched_at=now()`,
    [row.ts_code, row.symbol || row.ts_code.slice(0, 6), row.name || '', row.industry || '', row.market || '', row.list_date || null, JSON.stringify(row)]
  );
}

async function saveReports(kind, tsCode, rows) {
  const table = REPORT_TABLES[kind];
  if (!table) throw new Error('未知财报类型');
  for (const row of rows) {
    if (!row.end_date) continue;
    await pool.query(
      `INSERT INTO ${table}
       (ts_code,version_key,end_date,ann_date,f_ann_date,report_type,comp_type,update_flag,data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
       ON CONFLICT (ts_code,version_key) DO UPDATE SET data=EXCLUDED.data,fetched_at=now()`,
      [tsCode, versionKey(row), row.end_date, row.ann_date || null, row.f_ann_date || null,
        row.report_type || null, row.comp_type || null, row.update_flag || null, JSON.stringify(row)]
    );
  }
}

async function saveAux(table, tsCode, rows) {
  const allowed = new Set(['stock_financial_indicators', 'stock_dividends', 'stock_forecasts']);
  if (!allowed.has(table)) throw new Error('未知辅助数据表');
  for (const row of rows) {
    if (table === 'stock_financial_indicators' && !row.end_date) continue;
    const common = [tsCode, versionKey(row), row.end_date || null, row.ann_date || null];
    if (table === 'stock_dividends') {
      await pool.query(
        `INSERT INTO stock_dividends (ts_code,version_key,end_date,ann_date,ex_date,pay_date,div_proc,data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
         ON CONFLICT (ts_code,version_key) DO UPDATE SET data=EXCLUDED.data,fetched_at=now()`,
        [...common, row.ex_date || null, row.pay_date || null, row.div_proc || null, JSON.stringify(row)]
      );
    } else {
      await pool.query(
        `INSERT INTO ${table} (ts_code,version_key,end_date,ann_date,data)
         VALUES ($1,$2,$3,$4,$5::jsonb)
         ON CONFLICT (ts_code,version_key) DO UPDATE SET data=EXCLUDED.data,fetched_at=now()`,
        [...common, JSON.stringify(row)]
      );
    }
  }
}

async function saveValuations(tsCode, dailyRows, basicRows, factorRows) {
  const daily = new Map(dailyRows.map(r => [r.trade_date, r]));
  const basic = new Map(basicRows.map(r => [r.trade_date, r]));
  const factors = new Map(factorRows.map(r => [r.trade_date, r]));
  const dates = new Set([...daily.keys(), ...basic.keys(), ...factors.keys()]);
  for (const tradeDate of dates) {
    const d = daily.get(tradeDate) || {}, b = basic.get(tradeDate) || {}, a = factors.get(tradeDate) || {};
    await pool.query(
      `INSERT INTO stock_daily_valuations
       (ts_code,trade_date,close,adj_factor,pe,pe_ttm,pb,dv_ttm,total_share,total_mv,float_share,free_share,circ_mv)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (ts_code,trade_date) DO UPDATE SET
       close=COALESCE(EXCLUDED.close,stock_daily_valuations.close),
       adj_factor=COALESCE(EXCLUDED.adj_factor,stock_daily_valuations.adj_factor),
       pe=EXCLUDED.pe,pe_ttm=EXCLUDED.pe_ttm,pb=EXCLUDED.pb,dv_ttm=EXCLUDED.dv_ttm,
       total_share=COALESCE(EXCLUDED.total_share,stock_daily_valuations.total_share),
       total_mv=COALESCE(EXCLUDED.total_mv,stock_daily_valuations.total_mv),
       float_share=COALESCE(EXCLUDED.float_share,stock_daily_valuations.float_share),
       free_share=COALESCE(EXCLUDED.free_share,stock_daily_valuations.free_share),
       circ_mv=COALESCE(EXCLUDED.circ_mv,stock_daily_valuations.circ_mv),fetched_at=now()`,
      [tsCode, tradeDate, finite(d.close), finite(a.adj_factor), finite(b.pe), finite(b.pe_ttm), finite(b.pb),
        finite(b.dv_ttm), finite(b.total_share), finite(b.total_mv), finite(b.float_share), finite(b.free_share), finite(b.circ_mv)]
    );
  }
}

async function setSyncState(tsCode, dataset, successDate, error) {
  await pool.query(
    `INSERT INTO stock_data_sync_state (ts_code,dataset,last_success_date,last_attempt_at,last_error)
     VALUES ($1,$2,$3,now(),$4)
     ON CONFLICT (ts_code,dataset) DO UPDATE SET
       last_success_date=COALESCE(EXCLUDED.last_success_date,stock_data_sync_state.last_success_date),
       last_attempt_at=now(),last_error=EXCLUDED.last_error,updated_at=now()`,
    [tsCode, dataset, successDate || null, error || '']
  );
}

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: options.method || 'GET', timeout: options.timeout || 10000,
      headers: Object.assign({ 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, options.headers || {})
    }, resp => {
      let text = '';
      resp.on('data', c => { text += c; });
      resp.on('end', () => {
        if (resp.statusCode < 200 || resp.statusCode >= 300) return reject(new Error(`HTTP ${resp.statusCode}`));
        try { resolve(JSON.parse(text)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function eventCategory(title) {
  const text = String(title || '');
  const groups = [
    ['业绩', /业绩|年报|季报|半年报|预告|快报/], ['分红', /分红|派息|利润分配/],
    ['回购增减持', /回购|增持|减持/], ['重大交易', /合同|并购|重组|收购|出售/],
    ['风险', /诉讼|处罚|立案|质押|停牌|复牌|退市|风险警示/]
  ];
  const found = groups.find(([, re]) => re.test(text));
  return found ? found[0] : '其他';
}

async function fetchCninfoEvents(tsCode, startDate, endDate, searchKey = '') {
  const code = tsCode.slice(0, 6);
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Referer: 'https://www.cninfo.com.cn/', 'X-Requested-With': 'XMLHttpRequest' };
  const searchBody = new URLSearchParams({ keyWord: code, maxNum: '10' }).toString();
  const matches = await requestJson('https://www.cninfo.com.cn/new/information/topSearch/query', { method: 'POST', headers, body: searchBody });
  const stock = (Array.isArray(matches) ? matches : [matches]).find(item => item && String(item.code) === code);
  if (!stock || !stock.orgId) return [];
  const events = [];
  for (let page = 1; page <= 5; page++) {
    const body = new URLSearchParams({ pageNum: String(page), pageSize: '100', stock: `${code},${stock.orgId}`, searchkey: searchKey,
      tabName: 'fulltext', column: 'szse', plate: tsCode.endsWith('.SH') ? 'sh' : 'sz',
      seDate: `${isoDate(startDate)}~${isoDate(endDate)}` }).toString();
    const payload = await requestJson('https://www.cninfo.com.cn/new/hisAnnouncement/query', { method: 'POST', headers, body });
    const rows = payload.announcements || [];
    for (const row of rows) {
      const eventDate = row.announcementTime ? tsDateStr(new Date(Number(row.announcementTime))) : dateText(row.announcementDate);
      const title = String(row.announcementTitle || '').replace(/<[^>]+>/g, '');
      const url = row.adjunctUrl ? `https://static.cninfo.com.cn/${String(row.adjunctUrl).replace(/^\//, '')}` : '';
      events.push({ source: 'cninfo', event_date: eventDate, title, url, category: eventCategory(title), is_official: true, raw: row });
    }
    if (!payload.hasMore || rows.length === 0) break;
  }
  if (searchKey && !events.length) {
    const allEvents = await fetchCninfoEvents(tsCode, startDate, endDate, '');
    return allEvents.filter(event => String(event.title || '').includes(searchKey));
  }
  return [...new Map(events.map(event => [event.url || `${event.event_date}:${event.title}`, event])).values()];
}

async function fetchCninfoEventsByYear(tsCode, startDate, endDate, searchKey) {
  const startYear = Number(String(startDate || '').slice(0, 4));
  const endYear = Number(String(endDate || '').slice(0, 4));
  if (!startYear || !endYear) return fetchCninfoEvents(tsCode, startDate, endDate, searchKey);
  const groups = await Promise.all(Array.from({ length: endYear - startYear + 1 }, (_, index) => {
    const year = startYear + index;
    return fetchCninfoEvents(tsCode, year === startYear ? startDate : `${year}0101`,
      year === endYear ? endDate : `${year}1231`, searchKey).catch(() => []);
  }));
  return groups.flat();
}

async function fetchSseLatestReport(tsCode) {
  if (!String(tsCode || '').endsWith('.SH')) return null;
  const params = new URLSearchParams({ isPagination: 'true', productId: tsCode.slice(0, 6), keyWord: '',
    securityType: '0101,120100,020100,020200,120200', reportType2: 'DQBG', reportType: 'ALL',
    'pageHelp.pageSize': '25', 'pageHelp.pageNo': '1', 'pageHelp.beginPage': '1', 'pageHelp.endPage': '1' });
  const payload = await requestJson(`https://query.sse.com.cn/security/stock/queryCompanyBulletin.do?${params.toString()}`,
    { headers: { Referer: 'https://www.sse.com.cn/' } });
  const rows = payload && payload.pageHelp && Array.isArray(payload.pageHelp.data) ? payload.pageHelp.data : [];
  const report = rows.filter(row => /(?:年报|半年报)$/.test(String(row.BULLETIN_TYPE || '')) && !/摘要/.test(String(row.TITLE || '')) && row.URL)
    .sort((a,b) => String(b.SSEDATE || '').localeCompare(String(a.SSEDATE || '')))[0];
  if (!report) return null;
  return { source: 'sse', event_date: String(report.SSEDATE || '').replace(/-/g, ''), title: report.TITLE,
    url: `https://big5.sse.com.cn/site/cht/www.sse.com.cn${report.URL}`, category: '定期报告', is_official: true, raw: report };
}

async function fetchSseEvents(tsCode, startDate, endDate, keyword = '') {
  if (!String(tsCode || '').endsWith('.SH')) return [];
  const params = new URLSearchParams({ isPagination: 'true', productId: tsCode.slice(0, 6), keyWord: keyword,
    securityType: '0101,120100,020100,020200,120200', beginDate: isoDate(startDate), endDate: isoDate(endDate),
    'pageHelp.pageSize': '100', 'pageHelp.pageNo': '1', 'pageHelp.beginPage': '1', 'pageHelp.endPage': '1' });
  const payload = await requestJson(`https://query.sse.com.cn/security/stock/queryCompanyBulletin.do?${params.toString()}`,
    { headers: { Referer: 'https://www.sse.com.cn/' } });
  const rows = payload && payload.pageHelp && Array.isArray(payload.pageHelp.data) ? payload.pageHelp.data : [];
  const start = isoDate(startDate), end = isoDate(endDate);
  return rows.filter(row => row.URL && (!start || row.SSEDATE >= start) && (!end || row.SSEDATE <= end)).map(row => ({
    source: 'sse', event_date: String(row.SSEDATE || '').replace(/-/g, ''), title: row.TITLE || '',
    url: `https://big5.sse.com.cn/site/cht/www.sse.com.cn${row.URL}`, category: eventCategory(row.TITLE || ''), is_official: true, raw: row,
  }));
}

async function fetchSzseEvents(tsCode, startDate, endDate, keyword = '') {
  if (!String(tsCode || '').endsWith('.SZ')) return [];
  const body = JSON.stringify({ seDate: [isoDate(startDate), isoDate(endDate)], stock: [tsCode.slice(0, 6)],
    channelCode: ['fixed_disc'], pageSize: 100, pageNum: 1 });
  const payload = await requestJson('https://www.szse.cn/api/disc/announcement/annList?random=0.1', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Referer: 'https://www.szse.cn/disclosure/listed/fixed/index.html',
      'X-Requested-With': 'XMLHttpRequest' }, body });
  return (payload.data || []).filter(row => row.attachPath && (!keyword || String(row.title || '').includes(keyword))).map(row => ({
    source: 'szse', event_date: String(row.publishTime || '').slice(0, 10).replace(/-/g, ''), title: row.title || '',
    url: `https://disc.static.szse.cn/download${row.attachPath}`, category: eventCategory(row.title || ''), is_official: true, raw: row,
  }));
}

async function fetchSzseLatestReport(tsCode, startDate, endDate) {
  const reports = await fetchSzseEvents(tsCode, startDate, endDate, '年度报告');
  return reports.filter(row => !/摘要/.test(row.title)).sort((a,b) => String(b.event_date).localeCompare(String(a.event_date)))[0] || null;
}

async function fetchXueqiuEvents(tsCode, startDate, endDate) {
  try {
    const symbol = tsCode.endsWith('.SH') ? `SH${tsCode.slice(0, 6)}` : `SZ${tsCode.slice(0, 6)}`;
    const url = `https://xueqiu.com/statuses/search.json?count=20&comment=0&symbol=${symbol}&hl=0&source=all&sort=time&page=1&q=`;
    const payload = await requestJson(url, { headers: { Referer: `https://xueqiu.com/S/${symbol}` } });
    return (payload.list || payload.statuses || []).map(row => ({
      source: 'xueqiu', event_date: tsDateStr(new Date(row.created_at || row.createdAt || Date.now())),
      title: String(row.title || row.text || '').replace(/<[^>]+>/g, '').slice(0, 160),
      url: row.id ? `https://xueqiu.com/${row.user_id || row.user?.id || ''}/${row.id}` : '',
      category: '市场讨论', is_official: false, raw: row
    })).filter(row => row.event_date >= startDate && row.event_date <= endDate && row.title);
  } catch (_) { return []; }
}

async function fetchGubaEvents(tsCode, startDate, endDate) {
  try {
    const code = tsCode.slice(0, 6);
    const url = `https://gbapi.eastmoney.com/webarticlelist/api/Article/Articlelist?code=${code}&sorttype=1&ps=20&from=CommonBaPost`;
    const payload = await requestJson(url, { headers: { Referer: `https://guba.eastmoney.com/list,${code}.html` } });
    const rows = payload.re || payload.data?.re || payload.data || [];
    return (Array.isArray(rows) ? rows : []).map(row => ({
      source: 'guba', event_date: dateText(row.post_publish_time || row.publish_time || row.create_time),
      title: String(row.post_title || row.title || '').slice(0, 160),
      url: row.post_id ? `https://guba.eastmoney.com/news,${code},${row.post_id}.html` : '',
      category: '市场讨论', is_official: false, raw: row
    })).filter(row => row.event_date >= startDate && row.event_date <= endDate && row.title);
  } catch (_) { return []; }
}

async function saveEvents(tsCode, events) {
  await saveCollectedEvents(tsCode, events.filter(row => /^\d{8}$/.test(row.event_date || '')));
}

async function refreshEvents(tsCode, today) {
  const state = await pool.query(`SELECT c.last_success_date FROM ops.sync_cursors c JOIN core.instruments i ON i.instrument_id=c.instrument_id WHERE i.canonical_code=$1 AND c.dataset_code='events'`, [tsCode]);
  const last = state.rows[0] && dateText(state.rows[0].last_success_date);
  const start = last ? tsDateStr(new Date(Date.UTC(Number(last.slice(0, 4)), Number(last.slice(4, 6)) - 1, Number(last.slice(6, 8)) + 1))) : yearsAgo(365);
  if (start > today) return;
  try {
    const [official, xueqiu, guba] = await Promise.all([
      fetchCninfoEvents(tsCode, start, today), fetchXueqiuEvents(tsCode, start, today), fetchGubaEvents(tsCode, start, today)
    ]);
    await saveEvents(tsCode, [...official, ...xueqiu, ...guba]);
    await pool.query(`INSERT INTO ops.sync_cursors(instrument_id,company_id,scope_key,dataset_code,last_success_date,last_attempt_at,last_error)
      SELECT i.instrument_id,ci.company_id,i.instrument_id||':'||ci.company_id,'events',$2,now(),'' FROM core.instruments i JOIN core.company_instruments ci ON ci.instrument_id=i.instrument_id WHERE i.canonical_code=$1
      ON CONFLICT(scope_key,dataset_code) DO UPDATE SET last_success_date=EXCLUDED.last_success_date,last_attempt_at=now(),last_error='',updated_at=now()`,[tsCode,isoDate(today)]);
  } catch (error) {
    console.warn(`[stock-analysis] 公司事件刷新失败 ${tsCode}:`,error.message);
  }
}

function selectLatestByPeriod(rows, today) {
  const map = new Map();
  rows.filter(row => row.end_date && dateText(row.f_ann_date || row.ann_date) <= today)
    .sort((a, b) => {
      const consolidated = (String(b.report_type) === '1' ? 1 : 0) - (String(a.report_type) === '1' ? 1 : 0);
      return consolidated || String(b.f_ann_date || b.ann_date || '').localeCompare(String(a.f_ann_date || a.ann_date || ''));
    }).forEach(row => { if (!map.has(row.end_date)) map.set(row.end_date, row); });
  return map;
}

function signedRatio(numerator, denominator) {
  const a = finite(numerator), b = finite(denominator);
  return a == null || b == null || b === 0 ? null : a / b;
}

function growthMetric(start, end, years) {
  const a = finite(start), b = finite(end);
  if (a == null || b == null || a === 0) return { value: null, method: a === 0 ? '起点为0，无法计算' : '数据不足' };
  if (a > 0 && b > 0) return { value: Math.pow(b / a, 1 / years) - 1, method: 'CAGR' };
  return { value: (b - a) / Math.abs(a), method: '带符号变化率，非CAGR' };
}

function percentile(current, values) {
  const valid = values.map(finite).filter(v => v != null && v > 0).sort((a, b) => a - b);
  const c = finite(current);
  if (c == null || c <= 0) return { value: null, samples: valid.length, reason: '当前值小于等于零，不参与估值分位点计算' };
  return { value: valid.length ? valid.filter(v => v <= c).length / valid.length : null, samples: valid.length, reason: valid.length ? '' : '没有有效正数样本' };
}

function selectDividendPlans(rows) {
  const valid=(rows||[]).filter(row=>Math.max(finite(row.cash_div_tax)||0,finite(row.cash_div)||0)>0);
  const stage=row=>/实施/.test(String(row.div_proc||''))?3:/股东大会通过/.test(String(row.div_proc||''))?2:/预案/.test(String(row.div_proc||''))?1:0,map=new Map();
  valid.forEach(row=>{const key=String(row.end_date||'');if(!key)return;const current=map.get(key);if(!current||stage(row)>stage(current)||(stage(row)===stage(current)&&String(row.ann_date||'')>String(current.ann_date||'')))map.set(key,row);});
  return [...map.values()];
}

function quantile(values, ratio) {
  const valid=values.map(finite).filter(v=>v!=null&&v>0).sort((a,b)=>a-b);
  if(!valid.length)return null;
  const position=(valid.length-1)*ratio,lower=Math.floor(position),upper=Math.ceil(position);
  return lower===upper?valid[lower]:valid[lower]+(valid[upper]-valid[lower])*(position-lower);
}

function average(values) {
  const rows = values.map(finite).filter(v => v != null);
  return rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : null;
}

function latestAnnualRows(map) {
  return [...map.values()].filter(row => String(row.end_date).endsWith('1231')).sort((a, b) => b.end_date.localeCompare(a.end_date));
}

function ttmValue(map, field) {
  const rows = [...map.values()].sort((a, b) => b.end_date.localeCompare(a.end_date));
  const latest = rows[0];
  if (!latest) return null;
  if (latest.end_date.endsWith('1231')) return finite(latest[field]);
  const year = Number(latest.end_date.slice(0, 4));
  const annual = map.get(`${year - 1}1231`), prior = map.get(`${year - 1}${latest.end_date.slice(4)}`);
  const values = [latest, annual, prior].map(row => row && finite(row[field]));
  return values.every(v => v != null) ? values[0] + values[1] - values[2] : null;
}

function financialAverage(rows, field, count) {
  return average(rows.slice(0, count).map(row => row[field]));
}

async function loadData(tsCode) {
  const [meta, income, balance, cashflow, indicators, dividends, forecasts, valuations, events] = await Promise.all([
    pool.query(`SELECT i.canonical_code ts_code,i.name,i.market,to_char(i.list_date,'YYYYMMDD') list_date,
      COALESCE(n.industry_name,'') industry,i.raw_data data FROM core.instruments i
      JOIN core.company_instruments ci ON ci.instrument_id=i.instrument_id
      LEFT JOIN core.company_industry_memberships m ON m.company_id=ci.company_id AND m.is_current
      LEFT JOIN core.industry_nodes n ON n.industry_node_id=m.industry_node_id WHERE i.canonical_code=$1 LIMIT 1`,[tsCode]),
    pool.query(`SELECT r.raw_payload data FROM fundamental.financial_reports r JOIN core.company_instruments ci ON ci.company_id=r.company_id JOIN core.instruments i ON i.instrument_id=ci.instrument_id WHERE i.canonical_code=$1 AND r.report_kind='income'`,[tsCode]),
    pool.query(`SELECT r.raw_payload data FROM fundamental.financial_reports r JOIN core.company_instruments ci ON ci.company_id=r.company_id JOIN core.instruments i ON i.instrument_id=ci.instrument_id WHERE i.canonical_code=$1 AND r.report_kind='balance'`,[tsCode]),
    pool.query(`SELECT r.raw_payload data FROM fundamental.financial_reports r JOIN core.company_instruments ci ON ci.company_id=r.company_id JOIN core.instruments i ON i.instrument_id=ci.instrument_id WHERE i.canonical_code=$1 AND r.report_kind='cashflow'`,[tsCode]),
    pool.query(`SELECT r.raw_payload data FROM fundamental.financial_reports r JOIN core.company_instruments ci ON ci.company_id=r.company_id JOIN core.instruments i ON i.instrument_id=ci.instrument_id WHERE i.canonical_code=$1 AND r.report_kind='indicator'`,[tsCode]),
    pool.query(`SELECT a.raw_payload data FROM fundamental.corporate_actions a JOIN core.instruments i ON i.instrument_id=a.instrument_id WHERE i.canonical_code=$1 AND a.action_type='dividend'`,[tsCode]),
    pool.query(`SELECT g.raw_payload data FROM fundamental.earnings_guidance g JOIN core.company_instruments ci ON ci.company_id=g.company_id JOIN core.instruments i ON i.instrument_id=ci.instrument_id WHERE i.canonical_code=$1`,[tsCode]),
    pool.query(`SELECT to_char(v.trade_date,'YYYYMMDD') trade_date,b.close,a.adj_factor,v.pe_static pe,v.pe_ttm,v.pb,v.dividend_yield_ttm*100 dv_ttm,
      s.total_shares/10000 total_share,v.total_market_cap/10000 total_mv,s.circulating_shares/10000 float_share,s.free_float_shares/10000 free_share,v.circulating_market_cap/10000 circ_mv
      FROM market.daily_valuations v JOIN core.instruments i ON i.instrument_id=v.instrument_id
      LEFT JOIN market.daily_bars b ON b.instrument_id=v.instrument_id AND b.trade_date=v.trade_date AND b.source_id=v.source_id
      LEFT JOIN market.adjustment_factors a ON a.instrument_id=v.instrument_id AND a.trade_date=v.trade_date AND a.source_id=v.source_id
      LEFT JOIN LATERAL (SELECT * FROM market.share_capital_history s WHERE s.instrument_id=v.instrument_id AND s.effective_date<=v.trade_date ORDER BY s.effective_date DESC LIMIT 1) s ON true
      WHERE i.canonical_code=$1 ORDER BY v.trade_date`,[tsCode]),
    pool.query(`SELECT ds.source_code source,to_char(e.event_date,'YYYYMMDD') event_date,e.title,d.url,e.event_type category,e.is_official
      FROM event.company_events e JOIN ops.data_sources ds ON ds.source_id=e.source_id LEFT JOIN event.documents d ON d.document_id=e.document_id
      JOIN core.company_instruments ci ON ci.company_id=e.company_id JOIN core.instruments i ON i.instrument_id=ci.instrument_id
      WHERE i.canonical_code=$1 AND e.event_date>=CURRENT_DATE-interval '1 year' ORDER BY e.event_date DESC,e.is_official DESC LIMIT 200`,[tsCode])
  ]);
  return { meta: meta.rows[0], income: income.rows.map(r => r.data), balance: balance.rows.map(r => r.data),
    cashflow: cashflow.rows.map(r => r.data), indicators: indicators.rows.map(r => r.data),
    dividends: dividends.rows.map(r => r.data), forecasts: forecasts.rows.map(r => r.data), valuations: valuations.rows, events: events.rows };
}

async function buildAnalysis(tsCode) {
  const data = await loadData(tsCode);
  if (!data.meta || !data.income.length) throw new Error('股票尚未完成财务建档');
  const today = tsDateStr(new Date());
  const incomeMap = selectLatestByPeriod(data.income, today);
  const balanceMap = selectLatestByPeriod(data.balance, today);
  const indicatorMap = selectLatestByPeriod(data.indicators, today);
  const cashMap = selectLatestByPeriod(data.cashflow, today);
  const annualIncome = latestAnnualRows(incomeMap), annualCash = latestAnnualRows(cashMap);
  const annualBalance = latestAnnualRows(balanceMap);
  const latestIncome = [...incomeMap.values()].sort((a, b) => b.end_date.localeCompare(a.end_date))[0];
  const latestBalance = balanceMap.get(latestIncome && latestIncome.end_date) || [...balanceMap.values()].sort((a, b) => b.end_date.localeCompare(a.end_date))[0] || {};
  const latestIndicator = indicatorMap.get(latestBalance.end_date) || [...indicatorMap.values()].sort((a, b) => b.end_date.localeCompare(a.end_date))[0] || {};
  const latestValuation = data.valuations[data.valuations.length - 1] || {};
  const quoteMap = await fetchTencentQuotes([tsCode]);
  const quote = quoteMap.get(normalizeCode(tsCode));
  const currentPrice = finite(quote && quote.price) || finite(latestValuation.close);
  const totalShare = finite(latestValuation.total_share);
  const marketCap = currentPrice != null && totalShare != null ? currentPrice * totalShare * 10000 : finite(latestValuation.total_mv) == null ? null : finite(latestValuation.total_mv) * 10000;
  const floatShare = finite(latestValuation.float_share), freeShare = finite(latestValuation.free_share);
  const circulatingMarketCap = currentPrice != null && floatShare != null ? currentPrice * floatShare * 10000 : finite(latestValuation.circ_mv) == null ? null : finite(latestValuation.circ_mv) * 10000;
  const freeFloatMarketCap = currentPrice != null && freeShare != null ? currentPrice * freeShare * 10000 : null;
  const ttmProfit = ttmValue(incomeMap, 'n_income_attr_p');
  const staticProfit = annualIncome[0] && finite(annualIncome[0].n_income_attr_p);
  const avg3Profit = average(annualIncome.slice(0, 3).map(row => row.n_income_attr_p));
  const forecast = data.forecasts.filter(row => dateText(row.ann_date) <= today).sort((a, b) => String(b.ann_date).localeCompare(String(a.ann_date)))[0];
  let forecastProfit = forecast ? average([forecast.net_profit_min, forecast.net_profit_max]) : null;
  if (forecastProfit == null && forecast && finite(forecast.last_parent_net) != null) {
    const pct = average([forecast.p_change_min, forecast.p_change_max]);
    if (pct != null) forecastProfit = finite(forecast.last_parent_net) * (1 + pct / 100);
  }
  // Tushare forecast 的利润金额单位为万元；三张财报金额单位为元，计算前统一为元。
  if (forecastProfit != null) forecastProfit *= 10000;
  const equity = finite(latestBalance.total_hldr_eqy_exc_min_int), goodwill = finite(latestBalance.goodwill) || 0;
  const officialRoa = finite(indicatorMap.get(annualIncome[0]?.end_date)?.roa);
  const averageAnnualAssets = average([annualBalance[0]?.total_assets, annualBalance[1]?.total_assets]);
  const calculatedRoa = officialRoa == null && staticProfit != null && averageAnnualAssets ? staticProfit / averageAnnualAssets * 100 : officialRoa;
  const chartValuations = data.valuations.filter(row => row.trade_date >= yearsAgo(10958));
  const positiveValuations = chartValuations.filter(row => row.trade_date >= yearsAgo(3653));
  const latestFactor = finite(latestValuation.adj_factor);
  const qfqPrices = positiveValuations.map(row => {
    const close = finite(row.close), factor = finite(row.adj_factor);
    return close != null && factor != null && latestFactor ? close * factor / latestFactor : close;
  });
  const chartQfqPrices=chartValuations.map(row=>{const close=finite(row.close),factor=finite(row.adj_factor);return close!=null&&factor!=null&&latestFactor?close*factor/latestFactor:close;});
  const valuationHistory=chartValuations.map((row,index)=>({date:isoDate(row.trade_date),price:finite(chartQfqPrices[index]),pe:finite(row.pe_ttm),pb:finite(row.pb)})).filter((row,index)=>index%5===0||index===chartValuations.length-1);
  const percentileBands={price:[.2,.5,.8].map(x=>quantile(qfqPrices,x)),pe:[.2,.5,.8].map(x=>quantile(positiveValuations.map(row=>row.pe_ttm),x)),pb:[.2,.5,.8].map(x=>quantile(positiveValuations.map(row=>row.pb),x))};
  const earliestValuation = data.valuations.find(row => finite(row.close) != null && finite(row.adj_factor) != null);
  const earliestAdjustedPrice = earliestValuation && latestFactor ? finite(earliestValuation.close) * finite(earliestValuation.adj_factor) / latestFactor : null;
  const listedDays = earliestValuation ? Math.max(1, (Date.now() - new Date(`${isoDate(earliestValuation.trade_date)}T00:00:00+08:00`).getTime()) / DAY) : null;
  const annualizedSinceListing = earliestAdjustedPrice > 0 && currentPrice > 0 && listedDays > 0 ? Math.pow(currentPrice / earliestAdjustedPrice, 365.25 / listedDays) - 1 : null;
  const peTtm = signedRatio(marketCap, ttmProfit), peStatic = signedRatio(marketCap, staticProfit), peAvg3 = signedRatio(marketCap, avg3Profit);
  const pb = signedRatio(marketCap, equity), pbExGoodwill = signedRatio(marketCap, equity == null ? null : equity - goodwill);
  const displayDividends=selectDividendPlans(data.dividends);
  function sharesAt(date) {
    const target = dateText(date);
    for (let i = data.valuations.length - 1; i >= 0; i--) if (data.valuations[i].trade_date <= target && finite(data.valuations[i].total_share) != null) return finite(data.valuations[i].total_share);
    return null;
  }
  const dividendItem = row => ({ row, cashPerShare: finite(row.cash_div_tax) != null ? finite(row.cash_div_tax) : finite(row.cash_div), amount: (() => { const shares = sharesAt(row.ex_date || row.pay_date || row.ann_date) || finite(row.base_share); const cash = finite(row.cash_div_tax) != null ? finite(row.cash_div_tax) : finite(row.cash_div); return shares == null || cash == null ? null : cash * shares * 10000; })() });
  const actualDividendRows = displayDividends.filter(row => /实施/.test(String(row.div_proc||''))).map(dividendItem);
  const dividendRows = displayDividends.map(dividendItem);
  const oneYearAgo = yearsAgo(365);
  const dividend12m = actualDividendRows.filter(item => dateText(item.row.ex_date || item.row.pay_date) >= oneYearAgo).reduce((sum, item) => sum + (item.amount || 0), 0);
  const latestAnnualYear = annualIncome[0] ? annualIncome[0].end_date.slice(0, 4) : '';
  const annualDividend = dividendRows.filter(item => String(item.row.end_date || '').startsWith(latestAnnualYear)).reduce((sum, item) => sum + (item.amount || 0), 0);
  const cumulativeDividend = actualDividendRows.reduce((sum, item) => sum + (item.amount || 0), 0);
  const cumulativeProfit = annualIncome.reduce((sum, row) => sum + (finite(row.n_income_attr_p) || 0), 0);
  const cumulativePayoutRatio = signedRatio(cumulativeDividend, cumulativeProfit);
  const ttmEarningsYield = signedRatio(ttmProfit, marketCap);
  const averageDividendYield = cumulativePayoutRatio == null || ttmEarningsYield == null ? null : cumulativePayoutRatio * ttmEarningsYield;
  const dividendByYear = new Map();
  dividendRows.forEach(item => {
    const year = String(item.row.end_date || '').slice(0, 4);
    if (year && item.amount != null) dividendByYear.set(year, (dividendByYear.get(year) || 0) + item.amount);
  });
  const years = annualIncome.map(row => {
    const year = row.end_date.slice(0, 4), profit = finite(row.n_income_attr_p);
    const dividend = dividendByYear.has(year) ? dividendByYear.get(year) : 0;
    const dividend_details = dividendRows.filter(item => String(item.row.end_date || '').slice(0, 4) === year).map(item => ({
      ann_date: dateText(item.row.ann_date || item.row.imp_ann_date), ex_date: dateText(item.row.ex_date), pay_date: dateText(item.row.pay_date),
      cash_div: item.cashPerShare, amount: item.amount, div_proc:item.row.div_proc||''
    })).sort((a, b) => String(a.ex_date || a.pay_date || a.ann_date).localeCompare(String(b.ex_date || b.pay_date || b.ann_date)));
    return { year, report_ann_date: dateText(row.f_ann_date || row.ann_date), profit, dividend, dividend_details, payout_ratio: signedRatio(dividend, profit) };
  });
  const dividendYears = new Set(displayDividends.filter(row=>(finite(row.cash_div_tax)||finite(row.cash_div)||0)>0).map(row => String(row.end_date || '').slice(0, 4)));
  const stabilityYears = years.slice(0, 10);
  const noProfitYears = stabilityYears.filter(row => row.profit == null || row.profit <= 0).map(row => row.year);
  const noDividendYears = stabilityYears.filter(row => !dividendYears.has(row.year)).map(row => row.year);
  const reasonYear = noProfitYears.length === 1 ? noProfitYears[0] : (noDividendYears.length === 1 ? noDividendYears[0] : '');
  const reasonEvent = reasonYear ? data.events.find(row => row.is_official &&
    (String(row.title || '').includes(`${reasonYear}年`) || String(row.title || '').includes('年度报告') || String(row.title || '').includes('利润分配'))) : null;
  const growths = {};
  [3, 5, 10].forEach(n => {
    const end = annualIncome[0], start = annualIncome[n];
    growths[n] = {
      parent: growthMetric(start && start.n_income_attr_p, end && end.n_income_attr_p, n),
      deducted: growthMetric(start && indicatorMap.get(start.end_date)?.profit_dedt, end && indicatorMap.get(end.end_date)?.profit_dedt, n)
    };
  });
  const lateAvg = average(annualIncome.slice(0, 3).map(row => row.n_income_attr_p));
  const earlyAvg = average(annualIncome.slice(10, 13).map(row => row.n_income_attr_p));
  const interim = latestIncome && !latestIncome.end_date.endsWith('1231') ? latestIncome : null;
  const priorInterim = interim ? incomeMap.get(`${Number(interim.end_date.slice(0, 4)) - 1}${interim.end_date.slice(4)}`) : null;
  const latestCash = annualCash[0] || {};
  const freeCash = row => {
    const operating = finite(row.n_cashflow_act), capex = finite(row.c_pay_acq_const_fiolta);
    return operating == null || capex == null ? null : operating - capex;
  };
  const interestDebt = finite(latestIndicator.interestdebt) != null ? finite(latestIndicator.interestdebt) :
    ['st_borr', 'lt_borr', 'bond_payable', 'non_cur_liab_due_1y'].reduce((sum, key) => sum + (finite(latestBalance[key]) || 0), 0);
  const interestExpense = finite(latestIncome.fin_exp_int_exp) != null ? finite(latestIncome.fin_exp_int_exp) : finite(latestIncome.int_exp);
  const interestCoverage = finite(latestIndicator.ebit_to_interest) != null ? finite(latestIndicator.ebit_to_interest) : signedRatio(finite(latestIncome.ebit), interestExpense);
  const financialIndustry = /银行|保险|证券|多元金融/.test(String(data.meta.industry || ''));
  return {
    ts_code: tsCode, name: data.meta.name, industry: data.meta.industry, list_date: data.meta.list_date,
    industry_info: { name: data.meta.industry, system: data.meta.data?.industry_system || 'Tushare基础行业', level: data.meta.data?.industry_level || '未标注级别', path: data.meta.data?.industry_path || [] },
    actual_controller: data.meta.data?.actual_controller || { name: '', type: '', source: '' },
    latest_report: { end_date: latestIncome?.end_date || '', ann_date: dateText(latestIncome?.f_ann_date || latestIncome?.ann_date), type: latestIncome?.end_date?.endsWith('1231') ? '年报' : (latestIncome?.end_date?.endsWith('0630') ? '半年报' : '季报') },
    performance_forecast: forecast ? { ann_date: dateText(forecast.ann_date), end_date: dateText(forecast.end_date), type: forecast.type || '', profit_min: finite(forecast.net_profit_min) == null ? null : finite(forecast.net_profit_min) * 10000, profit_max: finite(forecast.net_profit_max) == null ? null : finite(forecast.net_profit_max) * 10000, change_min: finite(forecast.p_change_min), change_max: finite(forecast.p_change_max), summary: forecast.summary || '' } : null,
    as_of: isoDate(today), quote: { price: currentPrice, currency: 'CNY', currency_name: '人民币', unit: '元', quote_time: quote && quote.quote_time, source: quote ? 'tencent' : 'tushare_close' },
    valuation: {
      market_cap: marketCap, a_share_market_cap: marketCap, circulating_market_cap: circulatingMarketCap, free_float_market_cap: freeFloatMarketCap,
      annualized_return_since_listing: annualizedSinceListing, return_start_date: earliestValuation?.trade_date || '',
      pe_ttm: peTtm, pe_static: peStatic, pe_forecast: signedRatio(marketCap, forecastProfit), pe_three_year_avg: peAvg3,
      pb, pb_ex_goodwill: pbExGoodwill, dividend_yield: signedRatio(dividend12m, marketCap), payout_ratio: signedRatio(annualDividend, staticProfit),
      cumulative_payout_ratio: cumulativePayoutRatio, average_dividend_yield: averageDividendYield,
      cumulative_dividend: cumulativeDividend, cumulative_profit: cumulativeProfit,
      roe: finite(indicatorMap.get(annualIncome[0]?.end_date)?.roe), roa: calculatedRoa,
      roa_source: officialRoa == null && calculatedRoa != null ? '归母净利润 ÷ 平均总资产（补算）' : 'Tushare财务指标'
    },
    stability: { years, dividend_history: dividendRows.map(item => {
      const year = String(item.row.end_date || '').slice(0, 4);
      const profitRow = annualIncome.find(row => row.end_date.slice(0, 4) === year);
      const profit = profitRow ? finite(profitRow.n_income_attr_p) : null;
      const yearDividend = dividendByYear.get(year) || 0;
      return { year, end_date: dateText(item.row.end_date), ann_date: dateText(item.row.ann_date || item.row.imp_ann_date), record_date: dateText(item.row.record_date),
        ex_date: dateText(item.row.ex_date), div_proc: item.row.div_proc, stk_bo_rate: finite(item.row.stk_bo_rate),
        stk_co_rate: finite(item.row.stk_co_rate), stk_div: finite(item.row.stk_div), cash_div: item.cashPerShare,
        amount: item.amount, profit, payout_ratio: signedRatio(item.amount, profit), annual_payout_ratio: signedRatio(yearDividend, profit) };
    }).sort((a, b) => String(b.ann_date || b.ex_date).localeCompare(String(a.ann_date || a.ex_date))), profitable_each_year: noProfitYears.length === 0, no_profit_years: noProfitYears,
      dividend_each_year: noDividendYears.length === 0, no_dividend_years: noDividendYears,
      reason: reasonYear ? '待人工核实，请查看对应年度公告' : '', reason_url: reasonEvent ? reasonEvent.url : '' },
    percentiles: {
      price: percentile(currentPrice, qfqPrices), pe: percentile(peTtm, positiveValuations.map(row => row.pe_ttm)), pb: percentile(pb, positiveValuations.map(row => row.pb)),
      history: valuationHistory,bands:percentileBands,current:{price:currentPrice,pe:peTtm,pb},
      note: '分位点按所选时间内有效交易日计算：当前分位＝小于等于当前值的有效样本数÷有效样本总数；股价使用前复权价格，PE、PB只使用正数样本。负值和异常极值保留显示但不拉伸坐标轴，并用不同颜色标识。'
    },
    growth: { ten_year_average: Object.assign(growthMetric(earlyAvg, lateAvg, 10), { early_average: earlyAvg, late_average: lateAvg }), periods: growths,
      latest_interim_yoy: interim && priorInterim ? { end_date: interim.end_date,
        parent: signedRatio(finite(interim.n_income_attr_p) - finite(priorInterim.n_income_attr_p), Math.abs(finite(priorInterim.n_income_attr_p))),
        deducted: signedRatio(finite(indicatorMap.get(interim.end_date)?.profit_dedt) - finite(indicatorMap.get(priorInterim.end_date)?.profit_dedt), Math.abs(finite(indicatorMap.get(priorInterim.end_date)?.profit_dedt)))} : null },
    safety: { net_cash: (finite(latestBalance.money_cap) || 0) + (finite(latestBalance.trad_asset) || 0) - interestDebt,
      interest_coverage: interestCoverage, market_cap_to_liability: signedRatio(marketCap, finite(latestBalance.total_liab)),
      report_end_date: latestBalance.end_date, industry_note: financialIndustry ? '金融企业负债结构与普通企业不可直接比较' : '' },
    cashflow: { latest_year: { end_date: latestCash.end_date, operating: finite(latestCash.n_cashflow_act), free: freeCash(latestCash) },
      average_3y: { operating: financialAverage(annualCash, 'n_cashflow_act', 3), free: average(annualCash.slice(0, 3).map(freeCash)) },
      average_5y: { operating: financialAverage(annualCash, 'n_cashflow_act', 5), free: average(annualCash.slice(0, 5).map(freeCash)) } },
    events: data.events.map(row => Object.assign({}, row, { event_date: isoDate(row.event_date) })),
    data_quality: { income_rows: data.income.length, balance_rows: data.balance.length, cashflow_rows: data.cashflow.length,
      valuation_rows: data.valuations.length, research_notice: '金融数据仅供研究，交易决策前请独立核验。' }
  };
}

async function refreshStockAnalysis(rawCode, reason = 'manual') {
  const tsCode = normalizeStockCode(rawCode);
  if (!tsCode || !isOrdinaryAStock(tsCode)) throw new Error('仅支持A股普通股票');
  const today = tsDateStr(new Date());
  const metadataRows = await fetchRequired('stock_basic', { ts_code: tsCode }, 'ts_code,symbol,name,area,industry,market,exchange,list_status,list_date');
  let meta = metadataRows[0];
  if (!meta) throw new Error('未找到股票基础信息');
  const [industryInfo, actualController] = await Promise.all([fetchIndustry(tsCode), fetchActualController(tsCode)]);
  meta = Object.assign({}, meta, { tushare_industry: meta.industry }, industryInfo || { industry_system: 'Tushare基础行业', industry_level: '未标注级别', industry_path: [meta.industry].filter(Boolean) }, { actual_controller: actualController || { name: '', type: '', source: '东方财富F10' } });
  const financialFields = {
    income: statementApiFields('income'),
    balancesheet: statementApiFields('balance'),
    cashflow: statementApiFields('cashflow')
  };
  const existing = await pool.query(`SELECT
    EXISTS(SELECT 1 FROM market.daily_valuations v JOIN core.instruments i ON i.instrument_id=v.instrument_id WHERE i.canonical_code=$1) has_daily,
    (SELECT min(to_char(v.trade_date,'YYYYMMDD')) FROM market.daily_valuations v JOIN core.instruments i ON i.instrument_id=v.instrument_id WHERE i.canonical_code=$1) first_daily,
    EXISTS(SELECT 1 FROM fundamental.financial_reports r JOIN core.company_instruments ci ON ci.company_id=r.company_id JOIN core.instruments i ON i.instrument_id=ci.instrument_id WHERE i.canonical_code=$1 AND r.report_kind='indicator') has_indicator,
    EXISTS(SELECT 1 FROM fundamental.financial_reports r JOIN core.company_instruments ci ON ci.company_id=r.company_id JOIN core.instruments i ON i.instrument_id=ci.instrument_id WHERE i.canonical_code=$1 AND r.report_kind='income') has_reports`,[tsCode]);
  const hasDaily = Boolean(existing.rows[0] && existing.rows[0].has_daily);
  const hasIndicator = Boolean(existing.rows[0] && existing.rows[0].has_indicator);
  const hasReports = Boolean(existing.rows[0] && existing.rows[0].has_reports);
  const firstDaily = existing.rows[0] && dateText(existing.rows[0].first_daily);
  const financialStart = hasReports ? yearsAgo(120) : (meta.list_date || '19900101');
  const [income, balance, cashflow] = await Promise.all(Object.entries(financialFields)
    .map(([api, fields]) => fetchPartitioned(api, tsCode, financialStart, today, fields)));
  if (!income.length || !balance.length || !cashflow.length) throw new Error('三表数据不完整，保留上一份结果');
  const indicatorStart = hasIndicator ? yearsAgo(120) : (meta.list_date || '19900101');
  const [indicators, dividends, forecasts] = await Promise.all([
    fetchPartitioned('fina_indicator', tsCode, indicatorStart, today, 'ts_code,ann_date,end_date,roe,roa,ebit,ebit_to_interest,interestdebt,profit_dedt,dt_netprofit_yoy'),
    fetchRequired('dividend', { ts_code: tsCode }, 'ts_code,end_date,ann_date,div_proc,stk_div,stk_bo_rate,stk_co_rate,cash_div,cash_div_tax,record_date,ex_date,pay_date,imp_ann_date,base_date,base_share'),
    fetchRequired('forecast', { ts_code: tsCode }, 'ts_code,ann_date,end_date,type,p_change_min,p_change_max,net_profit_min,net_profit_max,last_parent_net,summary,change_reason')
  ]);
  const lastTenYears = yearsAgo(3653), listDate = meta.list_date || lastTenYears;
  const incrementalStart = yearsAgo(14);
  const hasListingHistory = firstDaily && firstDaily <= tsDateStr(new Date(new Date(`${isoDate(listDate)}T00:00:00+08:00`).getTime() + 31 * DAY));
  const priceStart = hasDaily && hasListingHistory ? incrementalStart : listDate;
  const basicStart = hasDaily ? incrementalStart : listDate;
  const basicFields='ts_code,trade_date,close,pe,pe_ttm,pb,dv_ttm,total_share,float_share,free_share,total_mv,circ_mv';
  const [daily, factors, fetchedBasics] = await Promise.all([
    fetchPartitioned('daily', tsCode, priceStart, today, 'ts_code,trade_date,close'),
    fetchPartitioned('adj_factor', tsCode, priceStart, today, 'ts_code,trade_date,adj_factor'),
    fetchPartitioned('daily_basic', tsCode, basicStart, today, basicFields)
  ]);
  const repairedBasics=await repairZeroValuations(tsCode,fetchedBasics,basicFields),basics=repairedBasics.rows;
  if (!basics.length) throw new Error('历史估值数据为空，保留上一份结果');
  await persistCollectedData(meta,{income,balance,cashflow,indicators,dividends,forecasts,daily,basics,factors,valuationIssues:repairedBasics.issues});
  await refreshEvents(tsCode, today);
  const analysis = await buildAnalysis(tsCode);
  await saveAnalysisResults(tsCode,Object.assign({},analysis,{diagnostics:{reason}}));
  return analysis;
}

async function getSnapshot(rawCode) {
  const tsCode = normalizeStockCode(rawCode);
  if (!tsCode) return null;
  const current = await pool.query(`SELECT s.payload,s.created_at FROM core.instruments i
    JOIN analytics.analysis_snapshots s ON s.instrument_id=i.instrument_id
    WHERE i.canonical_code=$1 AND s.snapshot_type='stock_analysis'
    ORDER BY s.as_of_date DESC,s.created_at DESC LIMIT 1`, [tsCode]);
  if (current.rows[0]) return Object.assign({}, current.rows[0].payload, { refreshed_at: current.rows[0].created_at,
    source_updated_at: current.rows[0].created_at, diagnostics: { source: 'analytics.analysis_snapshots' } });
  return null;
}

async function listUserStocks(username) {
  const { rows } = await pool.query(
    `SELECT ts_code,MAX(name) AS name,BOOL_OR(source='watchlist') AS watchlisted,BOOL_OR(source='position') AS held FROM (
       SELECT w.ts_code,w.name,'watchlist'::text AS source FROM stock_watchlist w WHERE w.username=$1
       UNION ALL
       SELECT CASE WHEN p.code ~ '^6' THEN p.code||'.SH' WHEN p.code ~ '^(4|8|92)' THEN p.code||'.BJ' ELSE p.code||'.SZ' END,
              MAX(p.name),'position'::text FROM positions p
        WHERE p.username=$1 AND p.code ~ '^[0-9]{6}$' AND p.code !~ '^(110|111|113|118|123|127|128)'
        GROUP BY p.code
     ) u GROUP BY ts_code ORDER BY held DESC,name,ts_code`, [username]
  );
  return rows.filter(row => isOrdinaryAStock(row.ts_code));
}

module.exports = { finite, normalizeStockCode, isOrdinaryAStock, growthMetric, percentile, selectDividendPlans, selectLatestByPeriod,
  refreshStockAnalysis, buildAnalysis, getSnapshot, listUserStocks, fetchCninfoEvents, fetchSseLatestReport, fetchSseEvents,
  fetchCninfoEventsByYear, fetchSzseEvents, fetchSzseLatestReport };

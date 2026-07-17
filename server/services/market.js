// ===================== 行情服务层（原 server.js 中的行情代理逻辑集中于此） =====================
const https = require('https');
const { pool } = require('../db/connection');
const {
  fetchTencentQuotes,
  isConvertibleBondCode,
  normalizeCode,
} = require('./tencentQuote');

// 通用 HTTPS GET（支持 gbk 解码）
function httpsGet(url, encoding) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 6000 }, (resp) => {
      const chunks = [];
      resp.on('data', chunk => chunks.push(chunk));
      resp.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (encoding === 'gbk') {
          try { resolve(new TextDecoder('gbk').decode(buf)); }
          catch (e) { resolve(buf.toString('utf8')); }
        } else {
          resolve(buf.toString('utf8'));
        }
      });
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
  });
}

// ===================== Tushare 数据层（A股优先数据源） =====================
// 港股实时 / 恒生指数 / 汇率：Tushare 2000积分无权限，仍走腾讯
const TUSHARE_TOKEN = process.env.TUSHARE_TOKEN || '';
const TS_API = 'https://api.tushare.pro';

// 调 Tushare HTTP API（POST JSON），返回 {fields,items} 或 null
function tushareQuery(apiName, params, fields) {
  return new Promise((resolve) => {
    if (!TUSHARE_TOKEN) return resolve(null);
    const payload = JSON.stringify({ api_name: apiName, token: TUSHARE_TOKEN, params: params || {}, fields: fields || '' });
    const body = Buffer.from(payload, 'utf8');
    const req = https.request(TS_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length }
    }, (resp) => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => {
        try { const j = JSON.parse(data); resolve(j && j.code === 0 && j.data ? j.data : null); }
        catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(10000, () => { req.destroy(); resolve(null); });
    req.write(body); req.end();
  });
}

// Tushare items 二维数组 → 行对象数组
function tsRows(data) {
  if (!data || !Array.isArray(data.items)) return [];
  const fields = data.fields || [];
  return data.items.map((it) => { const o = {}; fields.forEach((f, i) => o[f] = it[i]); return o; });
}

async function loadInstrumentCache() {
  try {
    const { rows } = await pool.query(
      `SELECT ts_code, name, fetched_at FROM market_instruments WHERE source = 'tushare'`
    );
    const map = new Map(rows.map(row => [row.ts_code, row.name]));
    const newest = rows.reduce((value, row) => Math.max(value, new Date(row.fetched_at).getTime() || 0), 0);
    return { map, newest };
  } catch (_) {
    return { map: new Map(), newest: 0 };
  }
}

async function saveInstrumentCache(rows) {
  try {
    for (let start = 0; start < rows.length; start += 500) {
      const chunk = rows.slice(start, start + 500);
      const params = [];
      const values = chunk.map((row, index) => {
        params.push(row.ts_code, row.name || '');
        return `($${index * 2 + 1},$${index * 2 + 2},'tushare')`;
      });
      await pool.query(
        `INSERT INTO market_instruments (ts_code, name, source) VALUES ${values.join(',')}
         ON CONFLICT (ts_code) DO UPDATE SET
           name=EXCLUDED.name, source=EXCLUDED.source, fetched_at=now()`,
        params
      );
    }
  } catch (_) {}
}

async function loadDailyCache() {
  try {
    const { rows } = await pool.query(
      `SELECT symbol AS ts_code, price, change_pct, quote_time, fetched_at
         FROM market_quote_cache WHERE source = 'tushare_daily'`
    );
    const map = new Map(rows.map(row => [row.ts_code, {
      close: row.price == null ? null : Number(row.price),
      pre_close: row.price != null && row.change_pct != null && Number(row.change_pct) !== -100
        ? Number(row.price) / (1 + Number(row.change_pct) / 100) : null,
      pct_chg: row.change_pct == null ? null : Number(row.change_pct),
    }]));
    const newest = rows.reduce((value, row) => Math.max(value, new Date(row.fetched_at).getTime() || 0), 0);
    return { map, newest };
  } catch (_) {
    return { map: new Map(), newest: 0 };
  }
}

function tushareTradeTime(tradeDate) {
  const value = String(tradeDate || '');
  if (!/^\d{8}$/.test(value)) return null;
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T15:00:00+08:00`;
}

async function saveDailyCache(rows) {
  try {
    for (let start = 0; start < rows.length; start += 300) {
      const chunk = rows.slice(start, start + 300);
      const params = [];
      const values = chunk.map((row, index) => {
        const base = index * 8;
        params.push(row.ts_code, 'tushare_daily', row.ts_code, String(row.ts_code).split('.')[1].toLowerCase(), '', row.close, row.pct_chg, tushareTradeTime(row.trade_date));
        return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8})`;
      });
      await pool.query(
        `INSERT INTO market_quote_cache
           (symbol, source, code, market, name, price, change_pct, quote_time)
         VALUES ${values.join(',')}
         ON CONFLICT (symbol, source) DO UPDATE SET
           price=EXCLUDED.price, change_pct=EXCLUDED.change_pct,
           quote_time=EXCLUDED.quote_time, fetched_at=now()`,
        params
      );
    }
  } catch (_) {}
}

// 任意代码 → Tushare ts_code（A股/港股/可转债/ETF/REITs）
function toTsCode(code) {
  const c = (code || '').trim().toUpperCase().replace(/\s/g, '');
  if (c.endsWith('.HK')) return c;
  if (c.endsWith('.SH') || c.endsWith('.SZ') || c.endsWith('.BJ')) return c;
  if (/^\d{6}$/.test(c)) {
    if (c.startsWith('12')) return c + '.SZ';
    if (c[0] === '6' || c[0] === '5' || c.startsWith('11')) return c + '.SH';
    if (c[0] === '8' || c[0] === '4' || c.startsWith('20') || c.startsWith('92')) return c + '.BJ';
    return c + '.SZ';
  }
  if (/^\d{5}$/.test(c)) return c + '.HK';
  return c;
}

// ============ 行情缓存 single-flight（P1-4）============
// 冷缓存并发时，多个请求会各自打穿上游 Tushare（刷新期间 map 仍为空）。
// 用 single-flight：同一刷新期间所有调用复用同一个 Promise；上游失败设短时负缓存，
// 避免失败风暴反复打穿。state 结构：{ map, ts, inflight, failedAt }
const NEG_TTL_MS = 60 * 1000; // 失败负缓存：1 分钟内不再重试
function withSingleFlight(state, ttlMs, loader) {
  const now = Date.now();
  // 命中有效缓存
  if (state.map && state.map.size && now - state.ts < ttlMs) return Promise.resolve(state.map);
  // 短时负缓存：上次刷新失败未久，直接复用空结果，避免重复打穿上游
  if (state.failedAt && now - state.failedAt < NEG_TTL_MS) return Promise.resolve(state.map || new Map());
  // 已有在途刷新：复用同一 Promise（single-flight 核心）
  if (state.inflight) return state.inflight;
  state.inflight = (async () => {
    try {
      const map = await loader();
      state.map = map;
      state.ts = Date.now();
      state.failedAt = 0;
      return map;
    } catch (e) {
      state.failedAt = Date.now();
      return state.map || new Map();
    } finally {
      state.inflight = null;
    }
  })();
  return state.inflight;
}

// 缓存：全市场名称 ts_code→name（加载一次后长期有效）
let TS_NAMES = { map: null, ts: 0, inflight: null, failedAt: 0 };
function ensureTsNames() {
  return withSingleFlight(TS_NAMES, 30 * 24 * 3600 * 1000, async () => {
    const cached = await loadInstrumentCache();
    if (cached.map.size && Date.now() - cached.newest < 30 * 24 * 3600 * 1000) return cached.map;
    const d = await tushareQuery('stock_basic', { exchange: '', list_status: 'L' }, 'ts_code,name');
    const rows = tsRows(d);
    if (!rows.length) return cached.map;
    const m = new Map();
    rows.forEach(r => { if (r.ts_code) m.set(r.ts_code, r.name); });
    await saveInstrumentCache(rows);
    return m;
  });
}

// 缓存：日线（每日批量一次）ts_code→{close,pre_close,pct_chg}
let TS_DAILY = { map: null, ts: 0, inflight: null, failedAt: 0 };
function ensureTsDaily() {
  return withSingleFlight(TS_DAILY, 12 * 3600 * 1000, async () => {
    const cached = await loadDailyCache();
    if (cached.map.size && Date.now() - cached.newest < 12 * 3600 * 1000) return cached.map;
    const td = tsDateStr(new Date());
    const d = await tushareQuery('daily', { trade_date: td }, 'ts_code,trade_date,close,pre_close,pct_chg');
    const rows = tsRows(d);
    if (!rows.length) return cached.map;
    const map = new Map();
    rows.forEach(r => { if (r.ts_code) map.set(r.ts_code, { close: parseFloat(r.close), pre_close: parseFloat(r.pre_close), pct_chg: parseFloat(r.pct_chg) }); });
    await saveDailyCache(rows);
    return map;
  });
}

// 缓存：实时价（60秒）ts_code→close（rt_min 批量；可转债无实时，回落日线）
let TS_RT = { map: null, ts: 0, inflight: null, failedAt: 0 };
function ensureTsRealtime(codes) {
  return withSingleFlight(TS_RT, 60000, async () => {
    const aShare = [...new Set((codes || []).map(toTsCode))]
      .filter(c => c.endsWith('.SH') || c.endsWith('.SZ') || c.endsWith('.BJ')).slice(0, 1000);
    if (!aShare.length) return TS_RT.map || new Map();
    const d = await tushareQuery('rt_min', { ts_code: aShare.join(','), freq: '1MIN' }, 'ts_code,close');
    const map = new Map();
    tsRows(d).forEach(r => { if (r.ts_code && r.close != null) map.set(r.ts_code, parseFloat(r.close)); });
    return map;
  });
}

// 可复用的行情查询函数（单只：A股走Tushare日线，港股走腾讯实时）
async function fetchQuoteByCode(code) {
  const c = code.trim().toUpperCase().replace(/\s/g, '');
  if (!c) return null;
  if (c === '404002') return { price: null, name: '搜特退债', code: c, change: null };

  const tsCode = toTsCode(c);
  if (tsCode.endsWith('.HK') || isConvertibleBondCode(c)) {
    const quotes = await fetchTencentQuotes([c]);
    const quote = quotes.get(normalizeCode(c));
    return quote ? { price: quote.price, name: quote.name || normalizeCode(c), code: normalizeCode(c), change: quote.change, quote_time: quote.quote_time, source: quote.source } : null;
  }

  // A股：Tushare 日线（close=最新价/盘中=昨收，pct_chg=涨跌幅）+ 名称缓存
  try {
    const [names, daily] = await Promise.all([ensureTsNames(), ensureTsDaily()]);
    const d = daily.get(tsCode);
    const name = names.get(tsCode) || '';
    if (d && d.close != null && !isNaN(d.close)) {
      return { price: d.close, name, code: c, change: (d.pct_chg != null && !isNaN(d.pct_chg)) ? d.pct_chg : null };
    }
    // 有名称但无价格（停牌/数据延迟）：尝试腾讯 fallback
    if (name) {
      const quotes = await fetchTencentQuotes([c]);
      const quote = quotes.get(normalizeCode(c));
      if (quote) return { price: quote.price, name: name || quote.name || c, code: normalizeCode(c), change: quote.change, quote_time: quote.quote_time, source: quote.source };
      // fallback 也拿不到价格：仅返回名称（供前端自动填充）
      return { price: null, name, code: c, change: null };
    }
    // 无数据（如新股）：fallback 腾讯实时
    const quotes = await fetchTencentQuotes([c]);
    const quote = quotes.get(normalizeCode(c));
    if (quote) return { price: quote.price, name: quote.name || c, code: normalizeCode(c), change: quote.change, quote_time: quote.quote_time, source: quote.source };
  } catch (e) {}
  return null;
}

// 东八区日期 YYYYMMDD（Tushare 参数专用，避免服务器非东八区时差一天）
function tsDateStr(d) {
  const cn = new Date(d.getTime() + (d.getTimezoneOffset() + 480) * 60000);
  const p = n => String(n).padStart(2, '0');
  return '' + cn.getUTCFullYear() + p(cn.getUTCMonth() + 1) + p(cn.getUTCDate());
}

// 统一日期格式为 YYYY-MM-DD：Tushare 的 trade_date 为 20230101(8位无横线)，
// 新浪/腾讯已是横线格式。净值日期为 YYYY-MM-DD，必须统一否则索引线整条匹配失败。
function normDate(s) {
  s = String(s == null ? '' : s);
  if (/^\d{8}$/.test(s)) return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
  return s;
}

// 东八区（北京时间）日期 YYYY-MM-DD
// 避免服务器时区非东八区时，净值日期 / 交易日期差一天（尤其凌晨）
// 与原前端 public/js/utils.js 的 todayCN 保持一致（修复原 server.js 调用未定义 todayCN 的缺陷）
function todayCN() {
  const now = new Date();
  const cn = new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60000);
  const p = n => String(n).padStart(2, '0');
  return cn.getUTCFullYear() + '-' + p(cn.getUTCMonth() + 1) + '-' + p(cn.getUTCDate());
}

module.exports = {
  httpsGet, tushareQuery, tsRows, toTsCode,
  ensureTsNames, ensureTsDaily, ensureTsRealtime,
  withSingleFlight, NEG_TTL_MS,
  fetchQuoteByCode, tsDateStr, normDate, todayCN
};

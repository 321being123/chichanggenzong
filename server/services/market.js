// ===================== 行情服务层（原 server.js 中的行情代理逻辑集中于此） =====================
const https = require('https');

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

// 任意代码 → Tushare ts_code（A股/港股/可转债/ETF/REITs）
function toTsCode(code) {
  const c = (code || '').trim().toUpperCase().replace(/\s/g, '');
  if (c.endsWith('.HK')) return c;
  if (c.endsWith('.SH') || c.endsWith('.SZ') || c.endsWith('.BJ')) return c;
  if (/^\d{6}$/.test(c)) {
    if (c[0] === '6' || c[0] === '5' || c.startsWith('11') || c.startsWith('12')) return c + '.SH';
    if (c[0] === '8' || c[0] === '4' || c.startsWith('20') || c.startsWith('92')) return c + '.BJ';
    return c + '.SZ';
  }
  if (/^\d{5}$/.test(c)) return c + '.HK';
  return c;
}

// 缓存：全市场名称 ts_code→name（首次拉取）
let TS_NAMES = null;
function ensureTsNames() {
  return new Promise(async (resolve) => {
    if (TS_NAMES) return resolve(TS_NAMES);
    TS_NAMES = new Map();
    const d = await tushareQuery('stock_basic', { exchange: '', list_status: 'L' }, 'ts_code,name');
    tsRows(d).forEach(r => { if (r.ts_code) TS_NAMES.set(r.ts_code, r.name); });
    resolve(TS_NAMES);
  });
}

// 缓存：日线（每日批量一次）ts_code→{close,pre_close,pct_chg}
let TS_DAILY = { ts: 0, map: new Map() };
function ensureTsDaily() {
  return new Promise(async (resolve) => {
    const now = Date.now();
    if (TS_DAILY.map.size && now - TS_DAILY.ts < 12 * 3600 * 1000) return resolve(TS_DAILY.map);
    const td = tsDateStr(new Date());
    const d = await tushareQuery('daily', { trade_date: td }, 'ts_code,close,pre_close,pct_chg');
    const map = new Map();
    tsRows(d).forEach(r => { if (r.ts_code) map.set(r.ts_code, { close: parseFloat(r.close), pre_close: parseFloat(r.pre_close), pct_chg: parseFloat(r.pct_chg) }); });
    TS_DAILY = { ts: now, map };
    resolve(map);
  });
}

// 缓存：实时价（60秒）ts_code→close（rt_min 批量；可转债无实时，回落日线）
let TS_RT = { ts: 0, map: new Map() };
function ensureTsRealtime(codes) {
  return new Promise(async (resolve) => {
    const now = Date.now();
    if (TS_RT.map.size && now - TS_RT.ts < 60000) return resolve(TS_RT.map);
    const aShare = [...new Set((codes || []).map(toTsCode))]
      .filter(c => c.endsWith('.SH') || c.endsWith('.SZ') || c.endsWith('.BJ')).slice(0, 1000);
    if (aShare.length) {
      const d = await tushareQuery('rt_min', { ts_code: aShare.join(','), freq: '1MIN' }, 'ts_code,close');
      const map = new Map();
      tsRows(d).forEach(r => { if (r.ts_code && r.close != null) map.set(r.ts_code, parseFloat(r.close)); });
      TS_RT = { ts: now, map };
    }
    resolve(TS_RT.map);
  });
}

// 可复用的行情查询函数（单只：A股走Tushare日线，港股走腾讯实时）
async function fetchQuoteByCode(code) {
  const c = code.trim().toUpperCase().replace(/\s/g, '');
  if (!c) return null;
  if (c === '404002') return { price: null, name: '搜特退债', code: c, change: null };

  const tsCode = toTsCode(c);
  if (tsCode.endsWith('.HK')) {
    // 港股实时：腾讯 qt.gtimg（Tushare 无港股实时）
    try {
      const text = await httpsGet('https://qt.gtimg.cn/q=hk' + c.padStart(5, '0'), 'gbk');
      const match = text.match(/"(.*)"/);
      if (match) {
        const parts = match[1].split('~');
        const price = parseFloat(parts[3]);
        if (!isNaN(price) && price > 0) return { price, name: parts[1] || c, code: c, change: parts[32] !== undefined && parts[32] !== '' ? parseFloat(parts[32]) : null };
      }
    } catch (e) {}
    return null;
  }

  // A股：Tushare 日线（close=最新价/盘中=昨收，pct_chg=涨跌幅）+ 名称缓存
  try {
    const [names, daily] = await Promise.all([ensureTsNames(), ensureTsDaily()]);
    const d = daily.get(tsCode);
    const name = names.get(tsCode) || '';
    if (d && d.close != null && !isNaN(d.close)) {
      return { price: d.close, name, code: c, change: (d.pct_chg != null && !isNaN(d.pct_chg)) ? d.pct_chg : null };
    }
    // daily 无（如新股）：fallback 腾讯实时
    const prefix = (c[0] === '6' || c[0] === '5' || c.startsWith('11')) ? 'sh' : 'sz';
    try {
      const text = await httpsGet('https://qt.gtimg.cn/q=' + prefix + c, 'gbk');
      const match = text.match(/"(.*)"/);
      if (match) {
        const parts = match[1].split('~');
        const price = parseFloat(parts[3]);
        if (!isNaN(price) && price > 0) return { price, name: name || parts[1] || c, code: c, change: parts[32] !== undefined && parts[32] !== '' ? parseFloat(parts[32]) : null };
      }
    } catch (e) {}
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
  fetchQuoteByCode, tsDateStr, normDate, todayCN
};

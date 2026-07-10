const express = require('express');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const session = require('express-session');
const XLSX = require('xlsx');
const QRCode = require('qrcode');

const { pool, initSchema, migrateFromJson, migrateToStructured, loadUsers, saveUsers, hashPwd, verifyPwd, loadAccountData, saveAccountData, saveDailyPrices, loadDailyPrices, upsertIndexPoints, loadIndexPoints, DATA_DIR } = require('./server/db');
// 代码→品种 单一分类函数（与前端共用，见 public/js/code-classify.js）
const classifyCode = require('./public/js/code-classify.js');
const normalizeCode = classifyCode.normalizeCode;  // 补齐证券代码前导零

const app = express();
// 部署在 Nginx 反代后，信任一层代理（用于正确的客户端IP与 X-Forwarded-Proto）
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const SECRET = process.env.SECRET || (function() {
  const sf = path.join(DATA_DIR, '.secret');
  try { return require('fs').readFileSync(sf, 'utf-8').trim(); } catch(e) {
    const s = 'pts-' + crypto.randomBytes(16).toString('hex');
    require('fs').writeFileSync(sf, s, 'utf-8');
    return s;
  }
})();

app.use(express.json({ limit: '10mb' }));
app.use(session({
  secret: SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax', secure: 'auto' }
}));

// 未登录跳转
app.use((req, res, next) => {
  if ((req.path === '/' || req.path === '/index.html') && !req.session.user) return res.redirect('/login.html');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// CSRF 防护：仅允许指定来源（部署到公网时通过 ALLOWED_ORIGIN 配置，多个用逗号分隔，只写域名如 myapp.com）
const ALLOWED_ORIGIN = (process.env.ALLOWED_ORIGIN || 'localhost,127.0.0.1')
  .split(',').map(s => s.trim()).filter(Boolean);
app.use((req, res, next) => {
  if (req.method === 'PUT' || req.method === 'POST' || req.method === 'DELETE') {
    const origin = req.headers['origin'] || '';
    const referer = req.headers['referer'] || '';
    if (!origin && !referer) return next(); // 允许无来源请求
    const ok = ALLOWED_ORIGIN.some(a => origin.includes('://' + a) || referer.includes('://' + a));
    if (!ok) return res.status(403).json({ error: '请求来源被拒绝' });
  }
  next();
});

// ========== 防暴力破解 ==========
const failMap = {};
function checkLocked(key) {
  const f = failMap[key];
  if (!f) return false;
  if (f.lockedUntil && Date.now() < f.lockedUntil) return true;
  if (f.lockedUntil && Date.now() >= f.lockedUntil) delete failMap[key];
  return false;
}
function recordFail(key) {
  if (!failMap[key]) failMap[key] = { count: 0 };
  if (++failMap[key].count >= 5) { failMap[key].lockedUntil = Date.now() + 15 * 60 * 1000; failMap[key].count = 0; }
}
function clearFail(key) { delete failMap[key]; }
const regIpMap = {};
function checkRegLimit(ip) {
  const now = Date.now();
  if (regIpMap[ip] && now - regIpMap[ip] < 60000) return true;
  regIpMap[ip] = now; return false;
}
const REGISTER_CODE = process.env.REGISTER_CODE;

// 邮箱验证码（nodemailer）
let mailer = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  const nodemailer = require('nodemailer');
  mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

// 包装异步路由，避免未捕获异常导致请求挂起
function asyncHandler(fn) { return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next); }

// ========== 中间件 ==========
function requireLogin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: '未登录' });
  next();
}

// ========== 用户认证 ==========
app.post('/api/register', asyncHandler(async (req, res) => {
  const { username, password, code, email, emailCode } = req.body;
  if (!username || !password) return res.status(400).json({ error: '请填写账号和密码' });
  if (username.length < 2) return res.status(400).json({ error: '账号至少2位' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少6位' });
  if (REGISTER_CODE && code !== REGISTER_CODE) return res.status(400).json({ error: '注册已关闭或邀请码错误' });
  // 邮箱验证码校验
  if (mailer) {
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: '请输入正确的邮箱' });
    if (!emailCode) return res.status(400).json({ error: '请输入邮箱验证码' });
    const sess = req.session;
    if (!sess.emailCode || sess.emailCode.email !== email || sess.emailCode.code !== emailCode) {
      return res.status(400).json({ error: '验证码错误' });
    }
    if (Date.now() > sess.emailCode.expires) return res.status(400).json({ error: '验证码已过期，请重新获取' });
    delete sess.emailCode;
  }
  const ip = req.ip || req.connection.remoteAddress;
  if (checkRegLimit(ip)) return res.status(429).json({ error: '注册过于频繁，请稍后再试' });
  const users = await loadUsers();
  if (users[username]) return res.status(400).json({ error: '该账号已注册，请直接登录' });
  users[username] = { password: hashPwd(password), email, accounts: ['默认账户'] };
  await saveUsers(users);
  req.session.user = username;
  res.json({ ok: true, username });
}));

app.post('/api/login', asyncHandler(async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '请填写账号和密码' });
  const ip = req.ip || req.connection.remoteAddress;
  const lockKey = 'login_' + (username || '') + '_' + ip;
  if (checkLocked(lockKey)) return res.status(429).json({ error: '登录尝试过多，已锁定15分钟' });
  const users = await loadUsers();
  const user = users[username];
  if (!user) { recordFail(lockKey); return res.status(401).json({ error: '账号不存在，请先注册' }); }
  if (!verifyPwd(password, user.password)) { recordFail(lockKey); return res.status(401).json({ error: '密码错误' }); }
  clearFail(lockKey);
  req.session.user = username;
  res.json({ ok: true, username });
}));

app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ ok: true }); });
app.get('/api/me', (req, res) => { res.json({ username: req.session.user || null }); });
app.get('/api/config', (req, res) => { res.json({ needRegisterCode: !!REGISTER_CODE }); });

// 发送邮箱验证码
app.post('/api/send-code', asyncHandler(async (req, res) => {
  if (!mailer) return res.status(500).json({ error: '邮件服务未配置' });
  const { email } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: '邮箱格式不正确' });
  // 60秒内限制同一邮箱重复发送
  const sess = req.session;
  if (sess.emailCode && sess.emailCode.lastSend && Date.now() - sess.emailCode.lastSend < 60000) {
    return res.status(429).json({ error: '发送太频繁，请60秒后再试' });
  }
  const code = String(Math.floor(100000 + Math.random() * 900000));
  sess.emailCode = { code, email, expires: Date.now() + 300000, lastSend: Date.now() };
  await mailer.sendMail({
    from: process.env.SMTP_USER,
    to: email,
    subject: '持仓管理系统 - 注册验证码',
    text: `您的验证码是：${code}，5分钟内有效。请勿泄露给他人。`
  });
  res.json({ ok: true });
}));

// ========== 数据API ==========
app.get('/api/accounts', requireLogin, asyncHandler(async (req, res) => {
  const users = await loadUsers();
  res.json((users[req.session.user] || {}).accounts || ['默认账户']);
}));

app.put('/api/accounts', requireLogin, asyncHandler(async (req, res) => {
  const users = await loadUsers();
  if (!users[req.session.user]) users[req.session.user] = { password: '', accounts: [] };
  users[req.session.user].accounts = req.body;
  await saveUsers(users);
  res.json({ ok: true });
}));

app.get('/api/data/:name', requireLogin, asyncHandler(async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const result = await loadAccountData(req.session.user, name);
  // 附加当前行情涨跌幅（异步，不阻塞返回）
  if (result.positions && result.positions.length > 0) {
    result.changes = {};
    const codes = result.positions.map(p => p.code).filter(Boolean);
    // 并发拉取行情，超时3秒
    await Promise.all(codes.map(async (code) => {
      try {
        const q = await fetchQuoteByCode(code);
        if (q && q.change != null) result.changes[code] = q.change;
        // 搜特退债已退市，涨跌幅默认0
        if (!q && code === '404002') result.changes['404002'] = 0;
      } catch(e) {}
    }));
  }
  res.json(result);
}));

app.put('/api/data/:name', requireLogin, asyncHandler(async (req, res) => {
  await saveAccountData(req.session.user, decodeURIComponent(req.params.name), req.body);
  res.json({ ok: true });
}));

// ========== 行情代理 ==========
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
    }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('timeout')); });
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

app.get('/api/quote/:code', requireLogin, asyncHandler(async (req, res) => {
  const code = req.params.code.trim().toUpperCase().replace(/\s/g, '');
  if (!code) return res.json({ price: null });
  res.json(await fetchQuoteByCode(code) || { price: null, code });
}));

// 批量行情（刷新用）：A股走Tushare(rt_min实时+daily涨跌)，港股走腾讯实时
app.get('/api/quotes', requireLogin, asyncHandler(async (req, res) => {
  const codes = (req.query.codes || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  const result = {};
  if (!codes.length) return res.json(result);

  const aCodes = [], hkCodes = [];
  codes.forEach(c => { (toTsCode(c).endsWith('.HK') ? hkCodes : aCodes).push(c); });

  // A股：批量 rt_min(实时价) + daily(涨跌/昨收) + 名称缓存
  const [names, daily, rt] = await Promise.all([ensureTsNames(), ensureTsDaily(), ensureTsRealtime(aCodes)]);
  aCodes.forEach(c => {
    const ts = toTsCode(c);
    const d = daily.get(ts);
    const r = rt.get(ts);
    const price = (r != null) ? r : (d ? d.close : null);
    let change = null;
    if (d) change = (r != null && d.pre_close) ? (r - d.pre_close) / d.pre_close * 100 : d.pct_chg;
    result[c] = {
      price: (price != null && !isNaN(price)) ? price : null,
      name: names.get(ts) || '',
      code: c,
      change: (change != null && !isNaN(change)) ? change : null
    };
  });

  // 港股：腾讯 qt.gtimg 批量
  if (hkCodes.length) {
    try {
      const q = hkCodes.map(c => 'hk' + c.padStart(5, '0')).join(',');
      const text = await httpsGet('https://qt.gtimg.cn/q=' + q, 'gbk');
      text.split(';').forEach(seg => {
        const m = seg.match(/"(.*)"/);
        if (!m) return;
        const parts = m[1].split('~');
        const hk = (parts[2] || '').trim();
        const price = parseFloat(parts[3]);
        if (hk && price && !isNaN(price)) {
          const orig = hkCodes.find(x => x.padStart(5, '0') === hk);
          if (orig) result[orig] = { price, name: parts[1] || orig, code: orig, change: parts[32] !== undefined && parts[32] !== '' ? parseFloat(parts[32]) : null };
        }
      });
    } catch (e) {}
  }

  res.json(result);
}));

// 港币→人民币汇率代理
app.get('/api/hkrate', requireLogin, asyncHandler(async (req, res) => {
  try {
    const text = await httpsGet('https://qt.gtimg.cn/q=szhkdcny');
    const match = text.match(/"(.*)"/);
    if (match) {
      const parts = match[1].split('~');
      const rate = parseFloat(parts[3]);
      if (!isNaN(rate) && rate > 0) return res.json({ rate });
    }
  } catch(e) {}
  res.json({ rate: 0.868 });
}));

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

// 指数K线数据代理（多源：A股三指数走新浪，恒生走腾讯 web.ifzq 历史日K）
// 注：东方财富(push2his)对腾讯云IP封禁，故改用新浪/腾讯源
app.get('/api/kline', requireLogin, asyncHandler(async (req, res) => {
  const { secid, days } = req.query;
  if (!secid) return res.json([]);
  try {
    if (secid === 'hkHSI') {
      // 恒生指数：腾讯 web.ifzq hkfqkline 历史日K（服务器实测可用，替代原 qt.gtimg 实时单点）
      // 返回 data.hkHSI.day：每条 [日期,开,收,高,低,...]，收盘价在 index 2
      const lim = Math.min(Math.max(parseInt(days) || 365, 250), 1500);
      const hkText = await new Promise((resolve, reject) => {
        https.get('https://web.ifzq.gtimg.cn/appstock/app/hkfqkline/get?param=hkHSI,day,,,' + lim + ',qfq', {
          timeout: 10000,
          headers: { 'User-Agent': 'Mozilla/5.0' }
        }, (resp) => {
          let data = '';
          resp.on('data', chunk => data += chunk);
          resp.on('end', () => resolve(data));
        }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('timeout')); });
      });
      const json = JSON.parse(hkText);
      const dayArr = json && json.data && json.data.hkHSI && json.data.hkHSI.day;
      if (Array.isArray(dayArr)) {
        const result = dayArr.map(function (it) {
          return { date: normDate(it[0]), close: parseFloat(it[2]) };
        }).filter(function (it) { return it.date && !isNaN(it.close) && it.close > 0; });
        return res.json(result);
      }
      return res.json([]);
    }
    // A股指数：Tushare index_daily（优先）
    if (/^s[hz]\d{6}$/i.test(secid)) {
      const tsCode = secid.slice(2) + (secid.slice(0, 2).toLowerCase() === 'sh' ? '.SH' : '.SZ');
      const daysN = Math.min(parseInt(days) || 365, 2500);
      const end = tsDateStr(new Date());
      const dt = new Date(); dt.setDate(dt.getDate() - daysN);
      const start = tsDateStr(dt);
      const data = await tushareQuery('index_daily', { ts_code: tsCode, start_date: start, end_date: end }, 'trade_date,close');
      const rows = tsRows(data).map(r => ({ date: normDate(r.trade_date), close: parseFloat(r.close) }))
        .filter(r => r.date && !isNaN(r.close) && r.close > 0);
      if (rows.length > 0) return res.json(rows);
      // Tushare 无数据（如 token 失效/无权限）→ 落到下方新浪兜底，避免指数线空白
    }
    // A股三指数兜底：新浪历史K线
    const datalen = Math.min(parseInt(days) || 365, 500);
    const sinaText = await new Promise((resolve, reject) => {
      https.get('https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=' + secid + '&scale=240&ma=no&datalen=' + datalen, {
        timeout: 10000,
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.sina.com.cn' }
      }, (resp) => {
        let data = '';
        resp.on('data', chunk => data += chunk);
        resp.on('end', () => resolve(data));
      }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('timeout')); });
    });
    const arr = JSON.parse(sinaText);
    if (Array.isArray(arr)) {
      const result = arr.map(function (it) {
        return { date: it.day, close: parseFloat(it.close) };
      }).filter(function (it) { return it.date && !isNaN(it.close) && it.close > 0; });
      return res.json(result);
    }
  } catch (e) {}
  res.json([]);
}));

// 导出持仓为 Excel
app.get('/api/export/:name', requireLogin, asyncHandler(async (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    const result = await loadAccountData(req.session.user, name);
    const positions = result.positions || [];
    const hkRate = result.hkRate || 0.868;

    const rows = [['代码', '代码', '正股/转债名称', '现价', '持有数量', '人民币市值', '持仓比例', '类型', '细类']];
    var totalRmb = 0;

    positions.forEach(function (p) {
      var code = p.code || '';
      var suffix = '';
      if (p.subtype === '港股') { suffix = '.HK'; }
      else if (code.startsWith('6') || code.startsWith('5')) { suffix = '.SH'; }
      else { suffix = '.SZ'; }

      var price = Number(p.price) || 0;
      var qty = Number(p.quantity) || 0;
      var mv = price * qty;
      if (p.subtype === '港股') { mv = mv * hkRate; }

      var priceDisplay = p.subtype === '港股' ? 'HK$' + price.toFixed(2) : price.toFixed(2);
      totalRmb += mv;

      rows.push([code, code + suffix, p.name || '', priceDisplay, qty, Math.round(mv * 100) / 100, 0, p.type || '', p.subtype || '']);
    });

    // 计算比例
    var totalAsset = result.totalAsset > 0 ? result.totalAsset : totalRmb;
    for (var i = 1; i < rows.length; i++) {
      rows[i][6] = totalAsset > 0 ? Math.round(rows[i][5] / totalAsset * 10000) / 10000 : 0;
    }

    // 尾部加入现金行
    var cash = Number(result.cash) || 0;
    var totalWithCash = totalAsset;
    var cashPct = totalWithCash > 0 ? Math.round(cash / totalWithCash * 10000) / 10000 : 0;
    rows.push([null, null, null, null, null, Math.round(cash * 100) / 100, cashPct, '债权', '现金']);

    var ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{wch:10},{wch:14},{wch:20},{wch:12},{wch:12},{wch:14},{wch:10},{wch:8},{wch:10}];
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');

    var buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="export.xlsx"');
    res.send(buf);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}));

// ========== 每日收盘价记录 ==========
app.post('/api/daily-prices/:name', requireLogin, asyncHandler(async (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    const { prices, date } = req.body;
    if (!prices || !prices.length) return res.json({ ok: true });
    await saveDailyPrices(req.session.user, name, date || todayCN(), prices);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}));

// ========== 手机扫码上传（in-memory token store）==========
const visionUploadTokens = new Map(); // token → { image, timestamp }
const TOKEN_TTL = 5 * 60 * 1000; // 5分钟过期

// 定期清理过期token
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of visionUploadTokens) {
    if (now - v.timestamp > TOKEN_TTL) visionUploadTokens.delete(k);
  }
}, 60 * 1000);

// 手机上传页面HTML
function mobileUploadHtml(token) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0,user-scalable=no">
<title>上传交易截图</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#f5f5f5;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px}
.card{background:#fff;border-radius:16px;padding:32px 24px;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,.08);max-width:340px;width:100%}
.icon{font-size:48px;margin-bottom:16px}
h2{font-size:18px;color:#1a1a2e;margin-bottom:8px}
p{font-size:13px;color:#888;margin-bottom:24px}
.upload-btn{display:inline-block;background:#1a73e8;color:#fff;border:none;padding:14px 40px;border-radius:10px;font-size:16px;cursor:pointer;width:100%}
.upload-btn:active{background:#1557b0}
#status{margin-top:16px;font-size:14px;color:#137333;display:none}
input[type=file]{display:none}
</style>
</head>
<body>
<div class="card">
  <div class="icon">📷</div>
  <h2>上传交易截图</h2>
  <p>拍照或从相册选择交易记录截图</p>
  <input type="file" id="fileInput" accept="image/*">
  <button class="upload-btn" onclick="document.getElementById('fileInput').click()">📸 拍照 / 选图</button>
  <div id="status"></div>
</div>
<script>
var input = document.getElementById('fileInput');
var status = document.getElementById('status');
input.addEventListener('change', async function() {
  var file = input.files[0];
  if (!file) return;
  status.style.display = 'block';
  status.textContent = '上传中...';
  var reader = new FileReader();
  reader.onload = async function() {
    try {
      var r = await fetch('/api/vision-upload/${token}', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({image: reader.result})
      });
      var d = await r.json();
      if (d.ok) {
        status.textContent = '✅ 上传成功！请返回电脑端查看识别结果';
        status.style.color = '#137333';
      } else {
        status.textContent = '❌ 上传失败: ' + (d.error || '未知错误');
        status.style.color = '#d93025';
      }
    } catch(e) {
      status.textContent = '❌ 网络错误，请重试';
      status.style.color = '#d93025';
    }
  };
  reader.readAsDataURL(file);
});
</script>
</body>
</html>`;
}

// 生成上传token
app.post('/api/vision-token', requireLogin, async (req, res) => {
  try {
    const token = crypto.randomBytes(16).toString('hex');
    visionUploadTokens.set(token, { image: null, timestamp: Date.now() });
    const url = `${req.protocol}://${req.get('host')}/m/upload/${token}`;
    const qr = await QRCode.toDataURL(url, { width: 160, margin: 1 });
    res.json({ token, qr });
  } catch (e) {
    res.status(500).json({ error: '生成二维码失败: ' + e.message });
  }
});

// 手机上传页面
app.get('/m/upload/:token', (req, res) => {
  const { token } = req.params;
  if (!visionUploadTokens.has(token)) {
    return res.status(404).send('<h2 style="text-align:center;padding:40px;color:#d93025;">二维码已过期，请刷新电脑端页面重新生成</h2>');
  }
  res.set('Content-Type', 'text/html; charset=utf-8').send(mobileUploadHtml(token));
});

// 手机端上传图片
app.post('/api/vision-upload/:token', (req, res) => {
  const { token } = req.params;
  const { image } = req.body;
  const entry = visionUploadTokens.get(token);
  if (!entry) return res.status(404).json({ ok: false, error: 'token已过期' });
  if (!image) return res.status(400).json({ ok: false, error: '缺少图片' });
  entry.image = image;
  entry.timestamp = Date.now();
  res.json({ ok: true });
});

// 电脑端轮询检测
app.get('/api/vision-check/:token', requireLogin, (req, res) => {
  const { token } = req.params;
  const entry = visionUploadTokens.get(token);
  if (!entry) return res.json({ image: null, expired: true });
  if (Date.now() - entry.timestamp > TOKEN_TTL) {
    visionUploadTokens.delete(token);
    return res.json({ image: null, expired: true });
  }
  res.json({ image: entry.image, expired: false });
});

// ========== AI视觉识别截图（交易/持仓自动识别） ==========
app.post('/api/vision-parse', requireLogin, asyncHandler(async (req, res) => {
  try {
    const { image, apiUrl, apiKey, model } = req.body;
    if (!image) return res.status(400).json({ error: '请上传图片' });

    const endpoint = apiUrl || process.env.VISION_API_URL || 'https://apihub.agnes-ai.com/v1/chat/completions';
    const visionModel = model || process.env.VISION_MODEL || 'agnes-1.5-flash';
    const key = apiKey || process.env.VISION_API_KEY;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key
      },
      body: JSON.stringify({
        model: visionModel,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: '请分析这张图片。如果是交易截图，提取所有交易记录；如果是持仓截图，提取所有持仓记录。请判断每一行是交易还是持仓，返回统一JSON数组。每个元素必须包含 kind 字段：交易为 "trade"，持仓为 "position"。交易字段：code(证券代码，字符串保留前导零)、name(证券名称)、price(成交价格数字)、quantity(成交数量整数)、direction(buy或sell)、date(交易日期YYYY-MM-DD，没有则留空)。持仓字段：code(证券代码，字符串保留前导零)、name(证券名称)、price(成本价或当前价数字)、quantity(持仓数量整数)。格式示例：[{"kind":"trade","code":"000001","name":"平安银行","price":12.34,"quantity":100,"direction":"buy","date":"2026-07-09"},{"kind":"position","code":"000001","name":"平安银行","price":12.34,"quantity":100}]。如果无法识别返回空数组[]。只返回JSON数组，不要任何其他文字。' },
            { type: 'image_url', image_url: { url: image } }
          ]
        }],
        max_tokens: 2000,
        temperature: 0
      }),
      signal: AbortSignal.timeout(60000)
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.json({ error: 'AI服务返回错误: ' + (response.status + ' ' + errText).substring(0, 200) });
    }

    const result = await response.json();
    const content = result.choices?.[0]?.message?.content || '[]';

    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return res.json({ items: [] });

    const items = JSON.parse(jsonMatch[0]);
    items.forEach(it => { if (it && it.code) it.code = normalizeCode(it.code); });
    res.json({ items: items });
  } catch(e) {
    res.json({ error: '识别失败: ' + e.message });
  }
}));

// ========== Excel 导入解析（大模型，交易/持仓自动识别）==========
app.post('/api/excel-parse', requireLogin, asyncHandler(async (req, res) => {
  try {
    const { file, apiUrl, apiKey, model } = req.body;
    if (!file) return res.status(400).json({ error: '请上传Excel文件' });

    const base64Data = file.split(',')[1] || file;
    const buffer = Buffer.from(base64Data, 'base64');
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });

    if (!rows || rows.length === 0) {
      return res.json({ items: [] });
    }

    const endpoint = apiUrl || process.env.VISION_API_URL || 'https://apihub.agnes-ai.com/v1/chat/completions';
    const chatModel = model || process.env.VISION_MODEL || 'agnes-1.5-flash';
    const key = apiKey || process.env.VISION_API_KEY;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key
      },
      body: JSON.stringify({
        model: chatModel,
        messages: [{
          role: 'user',
          content: '以下是从Excel中提取的原始数据（第一行为表头）。请先判断这是交易明细表还是持仓表，然后逐行识别。对每一行，必须返回 kind 字段：交易为 "trade"，持仓为 "position"。交易字段：code(证券代码，必须作为字符串返回并保留前导零，如 000001)、name(证券名称)、price(成交价格数字)、quantity(成交数量整数)、direction(buy或sell)、date(交易日期YYYY-MM-DD，没有则留空)。持仓字段：code(证券代码，必须作为字符串返回并保留前导零)、name(证券名称)、quantity(持仓数量整数，优先取"股票余额/持仓数量/总余额")、price(成本价或买入均价数字；没有成本价则填市价，必须大于0)。格式示例：[{"kind":"trade","code":"000001","name":"平安银行","price":12.34,"quantity":100,"direction":"buy","date":"2026-07-09"},{"kind":"position","code":"000001","name":"平安银行","price":12.34,"quantity":100}]。如果无法识别返回空数组[]。只返回JSON数组，不要任何其他文字。\n\n' + JSON.stringify(rows)
        }],
        max_tokens: 4000,
        temperature: 0
      }),
      signal: AbortSignal.timeout(60000)
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.json({ error: 'AI服务返回错误: ' + (response.status + ' ' + errText).substring(0, 200) });
    }

    const result = await response.json();
    const content = result.choices?.[0]?.message?.content || '[]';

    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return res.json({ items: [] });

    const items = JSON.parse(jsonMatch[0]);
    items.forEach(it => { if (it && it.code) it.code = normalizeCode(it.code); });
    res.json({ items: items });
  } catch(e) {
    res.json({ error: '解析失败: ' + e.message });
  }
}));

// ========== 导入历史净值数据（大模型识别，允许缺字段） → 回填 navHistory 历史段 ==========
app.post('/api/excel-history-parse', requireLogin, asyncHandler(async (req, res) => {
  try {
    const { file } = req.body;
    if (!file) return res.status(400).json({ error: '请上传Excel文件' });
    const base64Data = file.split(',')[1] || file;
    const buffer = Buffer.from(base64Data, 'base64');
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames.find(n => n.includes('资金')) || workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
    if (!rows || rows.length < 2) return res.json({ headers: [], rows: [], total: 0 });
    // 返回原始表头与数据行，由前端做"精确匹配/手动匹配"，避免任何猜测导致数据错配或丢行
    const headerCells = (rows[0] || []).map(function (h) { return String(h == null ? '' : h).trim(); });
    const dataRows = rows.slice(1).filter(function (r) { return r && r.some(function (c) { return c !== '' && c != null; }); });
    res.json({ headers: headerCells, rows: dataRows, total: dataRows.length });
  } catch (e) {
    res.status(400).json({ error: '解析失败: ' + e.message });
  }
}));

// ========== 指数历史点增量写入（前端 syncIndexPoints 调用） ==========
app.post('/api/index-history', requireLogin, asyncHandler(async (req, res) => {
  try {
    const { account, points } = req.body;
    if (!account || !Array.isArray(points)) return res.status(400).json({ error: '无效数据' });
    await upsertIndexPoints(req.session.user, account, points);
    res.json({ ok: true });
  } catch (e) {
    res.json({ error: '保存指数历史失败: ' + e.message });
  }
}));

// ========== 版本更新日志 ==========
app.get('/api/changelog', requireLogin, (req, res) => {
  try {
    const content = require('fs').readFileSync(path.join(__dirname, 'CHANGELOG.md'), 'utf-8');
    res.json({ content: content });
  } catch(e) {
    res.status(500).json({ error: '无法加载更新日志' });
  }
});

// ========== 自动记录每日收盘价（按市场收盘时刻精准触发） ==========

// 各市场收盘时间：{ hour, minute, 适用的代码前缀匹配规则 }
const MARKET_CLOSE_TIMES = [
  { h: 15, m: 10, label: 'A股',     match: code => /^(00|30|60|68|[48])/.test(code) },
  { h: 16, m: 10, label: '港股',    match: code => code.length === 5 },
  { h: 15, m: 10, label: '可转债',   match: code => /^(11|12)/.test(code) },
  { h: 15, m: 10, label: 'LOF/ETF', match: code => /^(15|16|50|51)/.test(code) && code.length === 6 },
];

// 获取东八区日期
function cnDateStr() {
  var d = new Date();
  d.setHours(d.getHours() + 8);
  return d.toISOString().split('T')[0];
}

// 是否为交易日（周一至周五）
function isTradingDay(d) {
  var day = (d || new Date()).getDay();
  return day >= 1 && day <= 5;
}

// 距离指定时间的毫秒数
function msUntil(h, m) {
  var now = new Date();
  var target = new Date(now);
  target.setHours(h, m, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  return target - now;
}

// 为单个市场记录收盘价
async function recordMarketClose(label, matchFn) {
  var cnDate = cnDateStr();
  try {
    var { rows: users } = await pool.query('SELECT username, accounts FROM users');
    for (var user of users) {
      var accounts = typeof user.accounts === 'string' ? JSON.parse(user.accounts) : (user.accounts || []);
      for (var accountName of accounts) {
        // 今天已记录过就跳过
        var { rows: existing } = await pool.query(
          'SELECT 1 FROM daily_prices WHERE username=$1 AND account_name=$2 AND date=$3 LIMIT 1',
          [user.username, accountName, cnDate]
        );
        if (existing.length > 0) continue;

        var result = await loadAccountData(user.username, accountName);
        var positions = (result.positions || []).filter(p => matchFn(p.code));
        if (positions.length === 0) continue;

        var prices = [];
        for (var pos of positions) {
          if (!pos.code) continue;
          try {
            var quote = await fetchQuoteByCode(pos.code);
            if (quote && quote.price) {
              prices.push({ code: pos.code, name: pos.name || quote.name || '', price: quote.price });
            }
          } catch(e) {}
        }

        if (prices.length > 0) {
          await saveDailyPrices(user.username, accountName, cnDate, prices);
        }
      }
    }
  } catch(e) {
    // 静默失败
  }
}

// 为所有市场分别调度收盘任务
function scheduleAllMarketCloses() {
  for (var i = 0; i < MARKET_CLOSE_TIMES.length; i++) {
    (function(mkt) {
      function runAndReschedule() {
        if (isTradingDay()) {
          recordMarketClose(mkt.label, mkt.match).catch(() => {});
        }
        // 安排下一个交易日
        var delay = msUntil(mkt.h, mkt.m);
        // 跳过周末：如果下个工作日在周末之后，再加
        var nextDay = new Date(Date.now() + delay + 60000);
        while (!isTradingDay(nextDay)) {
          nextDay.setDate(nextDay.getDate() + 1);
        }
        // 重新计算延迟（从now到nextDay的收盘时间）
        var now = new Date();
        nextDay.setHours(mkt.h, mkt.m, 0, 0);
        var nextDelay = nextDay - now;
        if (nextDelay <= 0) nextDelay = 5000;
        setTimeout(runAndReschedule, nextDelay);
      }
      var initialDelay = msUntil(mkt.h, mkt.m);
      setTimeout(runAndReschedule, initialDelay);
    })(MARKET_CLOSE_TIMES[i]);
  }
}

// ========== 自动补齐指数基线（启动后自动拉取“基准日期”的数据） ==========
// 基准日期 = 该账户净值最早日期；确保四指数（A股走Tushare，恒生走腾讯）都覆盖到该日期。
// 幂等：已覆盖到基线的指数跳过，仅在缺失时联网补齐；可随 deploy 自动自愈指数缺口。
const INDEX_BACKFILL_DEFS = [
  { name: '沪深300', ts: '000300.SH', src: 'tushare' },
  { name: '上证指数', ts: '000001.SH', src: 'tushare' },
  { name: '中证500', ts: '000905.SH', src: 'tushare' },
  { name: '恒生指数', src: 'tencent' } // 恒生无 Tushare 权限，沿用腾讯策略
];

// 恒生历史日K：腾讯 web.ifzq hkfqkline（日期范围，结束日期须<=今天，否则返回空）
async function fetchHsiHistory(fromDate, toDate) {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/hkfqkline/get?param=hkHSI,day,${fromDate},${toDate},4000,qfq`;
  try {
    const txt = await httpsGet(url);
    const json = JSON.parse(txt);
    const dayArr = json && json.data && json.data.hkHSI && json.data.hkHSI.day;
    if (!Array.isArray(dayArr)) return [];
    return dayArr
      .map(function (it) { return { date: normDate(it[0]), close: parseFloat(it[2]) }; })
      .filter(function (p) { return p.date && !isNaN(p.close) && p.close > 0; });
  } catch (e) { return []; }
}

async function ensureIndexBaseline() {
  try {
    const accs = await pool.query('SELECT DISTINCT username, account_name FROM nav_history');
    for (const acc of accs.rows) {
      const base = await pool.query('SELECT MIN(date) AS d FROM nav_history WHERE username=$1 AND account_name=$2', [acc.username, acc.account_name]);
      const baseline = base.rows[0] && base.rows[0].d ? String(base.rows[0].d) : null;
      if (!baseline) continue; // 无净值记录则无需补齐
      const startTs = baseline.replace(/-/g, '');
      const endTs = tsDateStr(new Date());
      const endDash = normDate(endTs);
      const points = [];
      for (const def of INDEX_BACKFILL_DEFS) {
        // 已覆盖到基线（指数最早日期 <= 净值起点）则跳过，避免重复联网
        const minR = await pool.query('SELECT MIN(date) AS d FROM index_history WHERE username=$1 AND account_name=$2 AND name=$3', [acc.username, acc.account_name, def.name]);
        const minD = minR.rows[0] && minR.rows[0].d ? String(minR.rows[0].d) : null;
        if (minD && minD <= baseline) continue;
        let series = [];
        if (def.src === 'tushare') {
          const rows = await tushareQuery('index_daily', { ts_code: def.ts, start_date: startTs, end_date: endTs }, 'trade_date,close');
          if (rows) series = tsRows(rows).map(function (r) { return { date: normDate(r.trade_date), close: parseFloat(r.close) }; }).filter(function (p) { return p.date && !isNaN(p.close) && p.close > 0; });
        } else {
          series = await fetchHsiHistory(baseline, endDash);
        }
        series.forEach(function (p) { points.push({ date: p.date, name: def.name, close: p.close }); });
      }
      if (points.length) {
        await upsertIndexPoints(acc.username, acc.account_name, points);
        console.log(`指数基线补齐: ${acc.username}/${acc.account_name} 新增 ${points.length} 点 (基准 ${baseline})`);
      }
    }
    console.log('指数基线检查完成');
  } catch (e) {
    console.error('指数基线补齐失败:', e.message);
  }
}

// ========== 启动：先初始化数据库（建表+迁移），再监听端口 ==========
async function start() {
  try {
    await initSchema();
    await migrateFromJson();
    await migrateToStructured();
    console.log('数据库初始化完成');
  } catch (e) {
    console.error('数据库初始化失败:', e.message);
    process.exit(1);
  }
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`持仓管理系统已启动: http://0.0.0.0:${PORT}`);
    console.log(`数据目录: ${DATA_DIR}`);
    // 按各市场收盘时刻精准调度收盘价记录
    scheduleAllMarketCloses();
    // 启动后自动补齐指数基线（A股走Tushare，恒生走腾讯），缺失才联网，幂等自愈
    ensureIndexBaseline().catch(function (e) { console.error('指数基线补齐失败:', e.message); });
  });
}
start();

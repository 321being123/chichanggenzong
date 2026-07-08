const express = require('express');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const session = require('express-session');
const XLSX = require('xlsx');

const { pool, initSchema, migrateFromJson, migrateToStructured, loadUsers, saveUsers, hashPwd, verifyPwd, loadAccountData, saveAccountData, saveDailyPrices, loadDailyPrices, isMarketClosed, DATA_DIR } = require('./server/db');
// 代码→品种 单一分类函数（与前端共用，见 public/js/code-classify.js）
const classifyCode = require('./public/js/code-classify.js');

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

// 包装异步路由，避免未捕获异常导致请求挂起
function asyncHandler(fn) { return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next); }

// ========== 中间件 ==========
function requireLogin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: '未登录' });
  next();
}

// ========== 用户认证 ==========
app.post('/api/register', asyncHandler(async (req, res) => {
  const { username, password, code } = req.body;
  if (!username || !password) return res.status(400).json({ error: '请填写账号和密码' });
  if (username.length < 2) return res.status(400).json({ error: '账号至少2位' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少6位' });
  if (REGISTER_CODE && code !== REGISTER_CODE) return res.status(400).json({ error: '注册已关闭或邀请码错误' });
  const ip = req.ip || req.connection.remoteAddress;
  if (checkRegLimit(ip)) return res.status(429).json({ error: '注册过于频繁，请稍后再试' });
  const users = await loadUsers();
  if (users[username]) return res.status(400).json({ error: '该账号已注册，请直接登录' });
  users[username] = { password: hashPwd(password), accounts: ['默认账户'] };
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
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 6000 }, (resp) => {
      let data = '';
      resp.on('data', chunk => data += chunk);
      resp.on('end', () => resolve(data));
    }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('timeout')); });
  });
}

// 可复用的行情查询函数
async function fetchQuoteByCode(code) {
  const c = code.trim().toUpperCase().replace(/\s/g, '');
  if (!c) return null;
  if (c === '404002') return { price: null, name: '搜特退债', code: c, change: null };

  // 委托单一分类函数：isHK / secids / 市场前缀
  const cls = classifyCode(c);
  const isHK = cls.isHK;
  const secids = cls.secids;
  const prefix = isHK ? 'hk' : (c[0] === '6' || c[0] === '5' || c.startsWith('11') ? 'sh' : 'sz');

  let result = null;
  for (const secid of secids) {
    try {
      const text = await httpsGet('https://push2.eastmoney.com/api/qt/stock/get?secid=' + secid + '&fields=f43,f57,f58,f60');
      const d = JSON.parse(text);
      if (d && d.data && d.data.f43 != null && d.data.f60 != null) {
        const dd = d.data;
        var factor = 1000;
        var cc = dd.f57 || c;
        // 价格系数：东方财富API中A股股票用分(/100)，其他品种(基金/ETF/LOF/REITs/可转债)用厘(/1000)
        if (cc.length >= 6) { var p2 = cc.substring(0,2); if (p2 === '00' || p2 === '30' || p2 === '60' || p2 === '68' || cc[0] === '4' || cc[0] === '8') factor = 100; }
        result = { price: dd.f43 / factor, name: dd.f58 || '', code: cc, change: dd.f60 ? ((dd.f43 - dd.f60) / dd.f60 * 100) : null };
        break;
      }
    } catch(e) {}
  }

  if (!result || !result.price) {
    try {
      const text = await httpsGet('https://qt.gtimg.cn/q=' + prefix + (isHK ? c.padStart(5,'0') : c));
      const match = text.match(/"(.*)"/);
      if (match) {
        const parts = match[1].split('~');
        const price = parseFloat(parts[3]);
        if (!isNaN(price) && price > 0) result = { price, name: parts[1] || c, code: c, change: parts[32] !== undefined && parts[32] !== '' ? parseFloat(parts[32]) : null };
      }
    } catch(e) {}
  }
  return result || null;
}

app.get('/api/quote/:code', requireLogin, asyncHandler(async (req, res) => {
  const code = req.params.code.trim().toUpperCase().replace(/\s/g, '');
  if (!code) return res.json({ price: null });
  res.json(await fetchQuoteByCode(code) || { price: null, code });
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

// 东八区日期 YYYYMMDD（指数K线起止，避免服务器非东八区时差一天）
function cnDateStr(d) {
  const cn = new Date(d.getTime() + (d.getTimezoneOffset() + 480) * 60000);
  const p = n => String(n).padStart(2, '0');
  return '' + cn.getUTCFullYear() + p(cn.getUTCMonth() + 1) + p(cn.getUTCDate());
}

// 指数K线数据代理
app.get('/api/kline', requireLogin, asyncHandler(async (req, res) => {
  const { secid, days } = req.query;
  if (!secid) return res.json([]);
  const daysNum = parseInt(days) || 365;
  const begStr = cnDateStr(new Date(Date.now() - daysNum * 86400000));
  const endStr = cnDateStr(new Date());
  try {
    const url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=' +
      secid + '&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=1&beg=' +
      begStr + '&end=' + endStr;
    const text = await httpsGet(url);
    const d = JSON.parse(text);
    if (d && d.data && d.data.klines) {
      const result = d.data.klines.map(function(line) {
        const parts = line.split(',');
        return { date: parts[0], close: parseFloat(parts[2]) };
      }).filter(function(item) { return !isNaN(item.close) && item.close > 0; });
      return res.json(result);
    }
  } catch(e) {}
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

// ========== AI视觉识别交易截图 ==========
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
            { type: 'text', text: '请从这张交易截图中提取所有交易信息。对每笔交易返回：code(证券代码)、name(证券名称)、price(成交价格，数字)、quantity(成交数量，数字)、direction(buy或sell)。以JSON数组格式返回，格式：[{"code":"xxx","name":"xxx","price":12.34,"quantity":100,"direction":"buy"}]。如果无法识别返回空数组[]。只返回JSON，不要任何其他文字。' },
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
    if (!jsonMatch) return res.json({ trades: [] });

    const trades = JSON.parse(jsonMatch[0]);
    res.json({ trades: trades });
  } catch(e) {
    res.json({ error: '识别失败: ' + e.message });
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

// ========== 自动记录每日收盘价（遍历所有账户） ==========
async function autoRecordClosingPrices() {
  if (!isMarketClosed()) return;
  const today = require('./public/js/utils').todayCN ? 
    (new Date()).toISOString().split('T')[0] : 
    new Date().toISOString().split('T')[0];
  // 获取东八区日期
  const now = new Date();
  const cnDate = new Date(now.getTime() + 8 * 3600000).toISOString().split('T')[0];
  
  try {
    const { rows: users } = await pool.query('SELECT username, accounts FROM users');
    for (const user of users) {
      const accounts = typeof user.accounts === 'string' ? JSON.parse(user.accounts) : (user.accounts || []);
      for (const accountName of accounts) {
        // 今天已记录过就跳过
        const { rows: existing } = await pool.query(
          'SELECT 1 FROM daily_prices WHERE username=$1 AND account_name=$2 AND date=$3 LIMIT 1',
          [user.username, accountName, cnDate]
        );
        if (existing.length > 0) continue;

        // 加载该账户持仓
        const result = await loadAccountData(user.username, accountName);
        const positions = result.positions || [];
        if (positions.length === 0) continue;

        // 拉行情
        const prices = [];
        for (const pos of positions) {
          if (!pos.code) continue;
          try {
            const quote = await fetchQuoteByCode(pos.code);
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
    // 静默失败，不影响主流程
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
    // 每10分钟检查一次是否需要记录收盘价
    setInterval(autoRecordClosingPrices, 10 * 60 * 1000);
  });
}
start();

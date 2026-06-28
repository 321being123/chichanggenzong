const express = require('express');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const session = require('express-session');
const XLSX = require('xlsx');

const { db, migrateFromJson, migrateToStructured, loadUsers, saveUsers, hashPwd, verifyPwd, loadAccountData, saveAccountData, DATA_DIR } = require('./server/db');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.SECRET || (function() {
  const sf = path.join(DATA_DIR, '.secret');
  try { return require('fs').readFileSync(sf, 'utf-8').trim(); } catch(e) {
    const s = 'pts-' + crypto.randomBytes(16).toString('hex');
    require('fs').writeFileSync(sf, s, 'utf-8');
    return s;
  }
})();

// 执行迁移
migrateFromJson();
migrateToStructured();

app.use(express.json({ limit: '10mb' }));
app.use(session({
  secret: SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' }
}));

// 未登录跳转
app.use((req, res, next) => {
  if ((req.path === '/' || req.path === '/index.html') && !req.session.user) return res.redirect('/login.html');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// CSRF 防护
app.use((req, res, next) => {
  if (req.method === 'PUT' || req.method === 'POST' || req.method === 'DELETE') {
    const origin = req.headers['origin'] || '';
    const referer = req.headers['referer'] || '';
    if (!origin && !referer) return next(); // 允许无来源请求
    if (!origin.includes('://localhost:') && !referer.includes('://localhost:')
        && !origin.includes('://127.0.0.1:') && !referer.includes('://127.0.0.1:'))
      return res.status(403).json({ error: '请求来源被拒绝' });
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

// ========== 中间件 ==========
function requireLogin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: '未登录' });
  next();
}

// ========== 用户认证 ==========
app.post('/api/register', (req, res) => {
  const { username, password, code } = req.body;
  if (!username || !password) return res.status(400).json({ error: '请填写账号和密码' });
  if (username.length < 2) return res.status(400).json({ error: '账号至少2位' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少6位' });
  if (REGISTER_CODE && code !== REGISTER_CODE) return res.status(400).json({ error: '注册已关闭或邀请码错误' });
  const ip = req.ip || req.connection.remoteAddress;
  if (checkRegLimit(ip)) return res.status(429).json({ error: '注册过于频繁，请稍后再试' });
  const users = loadUsers();
  if (users[username]) return res.status(400).json({ error: '该账号已注册，请直接登录' });
  users[username] = { password: hashPwd(password), accounts: ['默认账户'] };
  saveUsers(users);
  req.session.user = username;
  res.json({ ok: true, username });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '请填写账号和密码' });
  const ip = req.ip || req.connection.remoteAddress;
  const lockKey = 'login_' + (username || '') + '_' + ip;
  if (checkLocked(lockKey)) return res.status(429).json({ error: '登录尝试过多，已锁定15分钟' });
  const users = loadUsers();
  const user = users[username];
  if (!user) { recordFail(lockKey); return res.status(401).json({ error: '账号不存在，请先注册' }); }
  if (!verifyPwd(password, user.password)) { recordFail(lockKey); return res.status(401).json({ error: '密码错误' }); }
  clearFail(lockKey);
  req.session.user = username;
  res.json({ ok: true, username });
});

app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ ok: true }); });
app.get('/api/me', (req, res) => { res.json({ username: req.session.user || null }); });
app.get('/api/config', (req, res) => { res.json({ needRegisterCode: !!REGISTER_CODE }); });

// ========== 数据API ==========
app.get('/api/accounts', requireLogin, (req, res) => {
  const users = loadUsers();
  res.json((users[req.session.user] || {}).accounts || ['默认账户']);
});

app.put('/api/accounts', requireLogin, (req, res) => {
  const users = loadUsers();
  if (!users[req.session.user]) users[req.session.user] = { password: '', accounts: [] };
  users[req.session.user].accounts = req.body;
  saveUsers(users);
  res.json({ ok: true });
});

app.get('/api/data/:name', requireLogin, async (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const result = loadAccountData(req.session.user, name);
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
});

app.put('/api/data/:name', requireLogin, (req, res) => {
  saveAccountData(req.session.user, decodeURIComponent(req.params.name), req.body);
  res.json({ ok: true });
});

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

  const isHK = c.length <= 5;
  let secids = [];
  if (isHK) { secids.push('0.' + c + '.hk'); }
  else { if (c[0] === '6' || c.startsWith('5') || c.startsWith('11')) secids.push('1.' + c); secids.push('0.' + c); }

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
    const prefix = isHK ? 'hk' : (c[0] === '6' || c[0] === '5' || c.startsWith('11') ? 'sh' : 'sz');
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

app.get('/api/quote/:code', requireLogin, async (req, res) => {
  const code = req.params.code.trim().toUpperCase().replace(/\s/g, '');
  if (!code) return res.json({ price: null });
  res.json(await fetchQuoteByCode(code) || { price: null, code });
});

// 港币→人民币汇率代理
app.get('/api/hkrate', requireLogin, async (req, res) => {
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
});

// 指数K线数据代理
app.get('/api/kline', requireLogin, async (req, res) => {
  const { secid, days } = req.query;
  if (!secid) return res.json([]);
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - (parseInt(days) || 365));
  const begStr = start.toISOString().slice(0, 10).replace(/-/g, '');
  const endStr = end.toISOString().slice(0, 10).replace(/-/g, '');
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
});

// 导出持仓为 Excel
app.get('/api/export/:name', requireLogin, async (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    const result = loadAccountData(req.session.user, name);
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
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`持仓管理系统已启动: http://0.0.0.0:${PORT}`);
  console.log(`数据目录: ${DATA_DIR}`);
});

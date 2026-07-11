// ========== 行情代理路由 ==========
const express = require('express');
const https = require('https');
const router = express.Router();
const asyncHandler = require('../middleware/async');
const { requireLogin } = require('../middleware/auth');
const {
  fetchQuoteByCode, tushareQuery, tsRows, toTsCode,
  tsDateStr, normDate, ensureTsNames, ensureTsDaily, ensureTsRealtime
} = require('../services/market');

router.get('/quote/:code', requireLogin, asyncHandler(async (req, res) => {
  const code = req.params.code.trim().toUpperCase().replace(/\s/g, '');
  if (!code) return res.json({ price: null });
  res.json(await fetchQuoteByCode(code) || { price: null, code });
}));

// 批量行情（刷新用）：A股走Tushare(rt_min实时+daily涨跌)，港股走腾讯实时
router.get('/quotes', requireLogin, asyncHandler(async (req, res) => {
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
      const text = await new Promise((resolve, reject) => {
        https.get('https://qt.gtimg.cn/q=' + q, { timeout: 6000 }, (resp) => {
          let data = ''; resp.on('data', c => data += c);
          resp.on('end', () => resolve(data));
        }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
      });
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
router.get('/hkrate', requireLogin, asyncHandler(async (req, res) => {
  try {
    const text = await new Promise((resolve, reject) => {
      https.get('https://qt.gtimg.cn/q=szhkdcny', { timeout: 6000 }, (resp) => {
        let data = ''; resp.on('data', c => data += c);
        resp.on('end', () => resolve(data));
      }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
    });
    const match = text.match(/"(.*)"/);
    if (match) {
      const parts = match[1].split('~');
      const rate = parseFloat(parts[3]);
      if (!isNaN(rate) && rate > 0) return res.json({ rate });
    }
  } catch (e) {}
  res.json({ rate: 0.868 });
}));

// 指数K线数据代理（多源：A股三指数走新浪，恒生走腾讯 web.ifzq 历史日K）
// 注：东方财富(push2his)对腾讯云IP封禁，故改用新浪/腾讯源
router.get('/kline', requireLogin, asyncHandler(async (req, res) => {
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
        }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
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
      }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
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

module.exports = router;

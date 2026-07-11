// ========== 账户与数据 API 路由 ==========
const express = require('express');
const router = express.Router();
const XLSX = require('xlsx');
const asyncHandler = require('../middleware/async');
const { requireLogin, assertOwnership } = require('../middleware/auth');
const rateLimit = require('../middleware/rateLimit');
const validateAccountData = require('../middleware/validate');
const { loadUsers, saveUsers, loadAccountData, saveAccountData, migrateToStructured, saveDailyPrices } = require('../db');
const { fetchQuoteByCode, todayCN } = require('../services/market');

router.get('/accounts', requireLogin, asyncHandler(async (req, res) => {
  const users = await loadUsers();
  res.json((users[req.session.user] || {}).accounts || ['默认账户']);
}));

router.put('/accounts', requireLogin, asyncHandler(async (req, res) => {
  const users = await loadUsers();
  if (!users[req.session.user]) users[req.session.user] = { password: '', accounts: [] };
  users[req.session.user].accounts = req.body;
  await saveUsers(users);
  res.json({ ok: true });
}));

router.get('/data/:name', requireLogin, asyncHandler(assertOwnership), asyncHandler(async (req, res) => {
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
      } catch (e) {}
    }));
  }
  res.json(result);
}));

router.put('/data/:name', requireLogin, asyncHandler(assertOwnership), rateLimit({ prefix: 'save', windowMs: 60000, max: 30, getKey: (r) => r.session.user || r.ip, message: '保存过于频繁，请稍后再试' }), asyncHandler(async (req, res) => {
  const v = validateAccountData(req.body);
  if (!v.ok) return res.status(400).json({ error: '数据校验失败：' + v.msg });
  await saveAccountData(req.session.user, decodeURIComponent(req.params.name), req.body);
  res.json({ ok: true });
}));

// 一次性手动触发：把 account_data JSON 里残留的净值/持仓/交易/现金流合并进结构化表（幂等，不覆盖已有）。平时不用，仅历史数据还在 JSON 里时才点一次。
router.post('/migrate-json', requireLogin, asyncHandler(async (req, res) => {
  await migrateToStructured();
  res.json({ ok: true });
}));

// 导出持仓为 Excel
router.get('/export/:name', requireLogin, asyncHandler(assertOwnership), asyncHandler(async (req, res) => {
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
    ws['!cols'] = [{ wch: 10 }, { wch: 14 }, { wch: 20 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 10 }, { wch: 8 }, { wch: 10 }];
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');

    var buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="export.xlsx"');
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}));

// ========== 每日收盘价记录 ==========
router.post('/daily-prices/:name', requireLogin, asyncHandler(async (req, res) => {
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

module.exports = router;
